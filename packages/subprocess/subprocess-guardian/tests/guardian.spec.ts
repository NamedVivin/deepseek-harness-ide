import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { FramedGuardianPeer } from '../src/channel.ts'
import { IpcGuardianSubprocessClient } from '../src/client.ts'
import { GuardianServer } from '../src/guardian.ts'
import type {
  GuardianNativeSpawnSpec,
  GuardianOwnedProcess,
  GuardianPreparedProcess,
  GuardianProcessSupervisor,
} from '../src/supervisor.ts'
import { memoryGuardianLink } from './link.ts'

const limits = { maxBodyBytes: 16_384, maxChunkBytes: 4, maxInflightBytes: 8 }

class FakeOwned implements GuardianOwnedProcess {
  readonly doneState = Promise.withResolvers<SubprocessOutcome>()
  readonly done = this.doneState.promise
  terminated = false
  released = false
  active = true
  constructor(readonly pid: number) {}
  async terminate(): Promise<void> {
    this.terminated = true
    this.active = false
    this.doneState.resolve({ exitCode: null, signal: 'SIGTERM' })
  }
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted === true) return false
    return !this.active
  }
  async release(): Promise<void> { this.released = true }
  exit(outcome: SubprocessOutcome): void {
    this.active = false
    this.doneState.resolve(outcome)
  }
}

class FakePrepared implements GuardianPreparedProcess {
  readonly pid = 4242
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly resumeEntered = Promise.withResolvers<undefined>()
  readonly resumeRelease = Promise.withResolvers<undefined>()
  readonly owned = new FakeOwned(this.pid)
  rolledBack = false

  async resume(): Promise<GuardianOwnedProcess> {
    this.resumeEntered.resolve(undefined)
    await this.resumeRelease.promise
    return this.owned
  }
  async rollback(): Promise<void> { this.rolledBack = true }
}

class FakeSupervisor implements GuardianProcessSupervisor {
  readonly prepared = new FakePrepared()
  readonly prepareEntered = Promise.withResolvers<GuardianNativeSpawnSpec>()
  disposed = false
  async prepare(spec: GuardianNativeSpawnSpec): Promise<GuardianPreparedProcess> {
    this.prepareEntered.resolve(spec)
    return this.prepared
  }
  async dispose(): Promise<void> { this.disposed = true }
}

function spawnSpec(): SubprocessSpawnSpec {
  return {
    argv: [process.execPath, '-e', ''],
    cwd: process.cwd(),
    stdio: {
      stdin: 'pipe',
      stdout: { maxBytes: 4 },
      stderr: 'pipe',
    },
    graceMs: 100,
  }
}

function setup(): {
  client: IpcGuardianSubprocessClient
  server: GuardianServer
  supervisor: FakeSupervisor
  disconnect(): void
} {
  const [clientEndpoint, serverEndpoint] = memoryGuardianLink()
  const clientPeer = new FramedGuardianPeer(clientEndpoint, limits)
  const serverPeer = new FramedGuardianPeer(serverEndpoint, limits)
  const supervisor = new FakeSupervisor()
  return {
    client: new IpcGuardianSubprocessClient(clientPeer),
    server: new GuardianServer(serverPeer, supervisor),
    supervisor,
    disconnect: () => { clientEndpoint.disconnect() },
  }
}

describe('GuardianServer and sidecar client', () => {
  it('resolves in the guardian world and publishes only after stream setup plus native resume acknowledgement', async () => {
    const { client, server, supervisor } = setup()
    await expect(client.resolveExecutable(process.execPath)).resolves.toBe(process.execPath)
    const spawning = client.spawn(spawnSpec())
    const nativeSpec = await supervisor.prepareEntered.promise
    expect(nativeSpec.argv[0]).toBe(process.execPath)
    expect(nativeSpec.env).not.toHaveProperty('DEEPSEEK_API_KEY')
    await supervisor.prepared.resumeEntered.promise
    let published = false
    void spawning.then(() => { published = true })
    await Promise.resolve()
    expect(published).toBe(false)
    supervisor.prepared.resumeRelease.resolve(undefined)
    const handle = await spawning
    expect(handle.pid).toBe(4242)
    expect(handle.stdin).toBeDefined()
    expect(handle.stderr).toBeDefined()

    const stdin = Promise.withResolvers<string>()
    let input = ''
    supervisor.prepared.stdin.on('data', (chunk) => { input += String(chunk) })
    supervisor.prepared.stdin.on('end', () => { stdin.resolve(input) })
    handle.stdin?.end('request')
    await expect(stdin.promise).resolves.toBe('request')

    const stderr = Promise.withResolvers<string>()
    let diagnostic = ''
    handle.stderr?.on('data', (chunk) => { diagnostic += String(chunk) })
    handle.stderr?.on('end', () => { stderr.resolve(diagnostic) })
    supervisor.prepared.stdout.end('abcdef')
    supervisor.prepared.stderr.end('warn')
    supervisor.prepared.owned.exit({ exitCode: 0, signal: null })
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(stderr.promise).resolves.toBe('warn')
    expect(handle.collected.stdout?.readFrom(0)).toEqual({ text: 'cdef', nextOffset: 6, lossy: true })
    await vi.waitFor(() => { expect(supervisor.prepared.owned.released).toBe(true) })
    await server.dispose()
    await client.dispose()
  })

  it('relays handle termination and maps an aborted wait to false', async () => {
    const { client, server, supervisor } = setup()
    const spawning = client.spawn(spawnSpec())
    await supervisor.prepared.resumeEntered.promise
    supervisor.prepared.resumeRelease.resolve(undefined)
    const handle = await spawning
    const abort = AbortSignal.abort(new Error('stop waiting'))
    await expect(handle.waitForExit(abort)).resolves.toBe(false)
    handle.terminate()
    await vi.waitFor(() => { expect(supervisor.prepared.owned.terminated).toBe(true) })
    supervisor.prepared.stdout.end()
    supervisor.prepared.stderr.end()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    await server.dispose()
    await client.dispose()
  })

  it('rejects hostile operation bodies before native preparation', async () => {
    const [callerEndpoint, serverEndpoint] = memoryGuardianLink()
    const caller = new FramedGuardianPeer(callerEndpoint, limits)
    const serverPeer = new FramedGuardianPeer(serverEndpoint, limits)
    const supervisor = new FakeSupervisor()
    const server = new GuardianServer(serverPeer, supervisor)
    await expect(caller.call('spawn-prepare', {
      ...spawnSpec(),
      unexpected: true,
    })).rejects.toThrow('unknown field')
    let prepared = false
    void supervisor.prepareEntered.promise.then(() => { prepared = true })
    await Promise.resolve()
    expect(prepared).toBe(false)
    await server.dispose()
    await caller.dispose()
  })

  it('kills, joins, and releases a live process when the sidecar parent disconnects', async () => {
    const fixture = setup()
    const { client, supervisor } = fixture
    const spawning = client.spawn(spawnSpec())
    await supervisor.prepared.resumeEntered.promise
    supervisor.prepared.resumeRelease.resolve(undefined)
    const handle = await spawning
    handle.stderr?.on('error', () => {})
    fixture.disconnect()
    await expect(handle.done).rejects.toThrow('disconnected')
    await vi.waitFor(() => {
      expect(supervisor.prepared.owned.terminated).toBe(true)
      expect(supervisor.prepared.owned.released).toBe(true)
      expect(supervisor.disposed).toBe(true)
    })
    await client.dispose()
  })
})
