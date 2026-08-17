import { EventEmitter, once } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'
import type { SubprocessOutcome, SubprocessStdio } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import type {
  GuardianByteSink,
  GuardianByteWriter,
  GuardianCallHandler,
  GuardianCallResult,
} from '../src/channel.ts'
import { FramedGuardianPeer } from '../src/channel.ts'
import { GuardianServer, type GuardianSpawnRequest } from '../src/guardian.ts'
import {
  GuardianProcessId,
  type GuardianOperation,
  type GuardianProcessId as GuardianProcessIdType,
  type GuardianSettlement,
  type GuardianStreamId,
} from '../src/protocol.ts'
import type {
  GuardianNativeSpawnSpec,
  GuardianOwnedProcess,
  GuardianPreparedProcess,
  GuardianProcessSupervisor,
} from '../src/supervisor.ts'

class FakeWriter implements GuardianByteWriter {
  readonly chunks: Buffer[] = []
  readonly write = vi.fn(async (data: Uint8Array) => { this.chunks.push(Buffer.from(data)) })
  readonly end = vi.fn(async () => undefined)
  readonly cancel = vi.fn(async () => undefined)
}

class FakePeer {
  readonly sinks = new Map<string, GuardianByteSink>()
  readonly writers: FakeWriter[] = []
  readonly settlements: Array<{ processId: GuardianProcessIdType; value: GuardianSettlement }> = []
  readonly inputCompletion = new Map<string, PromiseWithResolvers<undefined>>()
  handler: GuardianCallHandler | undefined
  close: ((error: Error) => void) | undefined
  settlementFailure: unknown = undefined
  disposed = false

  handleCalls(handler: GuardianCallHandler): () => void {
    this.handler = handler
    return () => { if (this.handler === handler) this.handler = undefined }
  }

  onClosed(listener: (error: Error) => void): () => void {
    this.close = listener
    return () => { if (this.close === listener) this.close = undefined }
  }

  acceptStream(streamId: GuardianStreamId, sink: GuardianByteSink): Promise<void> {
    const id = String(streamId)
    this.sinks.set(id, sink)
    const complete = Promise.withResolvers<undefined>()
    this.inputCompletion.set(id, complete)
    return complete.promise
  }

  createWriter(): GuardianByteWriter {
    const writer = new FakeWriter()
    this.writers.push(writer)
    return writer
  }

  async sendProcessSettled(processId: GuardianProcessIdType, value: GuardianSettlement): Promise<void> {
    this.settlements.push({ processId, value })
    if (this.settlementFailure !== undefined) throw this.settlementFailure
  }

  async dispose(): Promise<void> { this.disposed = true }
}

class FakeOwned implements GuardianOwnedProcess {
  readonly outcome = Promise.withResolvers<SubprocessOutcome>()
  readonly done: Promise<SubprocessOutcome> = this.outcome.promise
  terminated = 0
  waited = 0
  released = 0
  exited = true
  terminateFailure: unknown = undefined
  waitFailure: unknown = undefined
  releaseFailure: unknown = undefined
  readonly pid = 501

  async terminate(): Promise<void> {
    this.terminated += 1
    if (this.terminateFailure !== undefined) throw this.terminateFailure
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    this.waited += 1
    if (this.waitFailure !== undefined) throw this.waitFailure
    return this.exited
  }

  async release(): Promise<void> {
    this.released += 1
    if (this.releaseFailure !== undefined) throw this.releaseFailure
  }
}

class FakePrepared implements GuardianPreparedProcess {
  readonly pid = 501
  stdin: Writable | undefined = new PassThrough()
  stdout: Readable | undefined = new PassThrough()
  stderr: Readable | undefined = new PassThrough()
  readonly owned = new FakeOwned()
  resumed = 0
  rolledBack = 0
  resumeFailure: unknown = undefined

  async resume(): Promise<GuardianOwnedProcess> {
    this.resumed += 1
    if (this.resumeFailure !== undefined) throw this.resumeFailure
    return this.owned
  }

  async rollback(): Promise<void> { this.rolledBack += 1 }
}

class FakeSupervisor implements GuardianProcessSupervisor {
  prepared = new FakePrepared()
  preparations = 0
  disposed = 0

  async prepare(_spec: GuardianNativeSpawnSpec): Promise<GuardianPreparedProcess> {
    this.preparations += 1
    return this.prepared
  }

  async dispose(): Promise<void> { this.disposed += 1 }
}

interface ServerInternals {
  dispatch(operation: GuardianOperation, body: unknown, signal: AbortSignal): Promise<GuardianCallResult>
  prepared: Map<GuardianProcessIdType, unknown>
  live: Map<GuardianProcessIdType, {
    owned: FakeOwned
    pumps: Set<Promise<void>>
    cancelIo(error: Error): void
    settlement: Promise<void> | undefined
    released: boolean
  }>
  activate(prepared: unknown, live: unknown): void
  settle(live: unknown): Promise<void>
}

function setup(): {
  readonly peer: FakePeer
  readonly supervisor: FakeSupervisor
  readonly server: GuardianServer
  readonly internals: ServerInternals
} {
  const peer = new FakePeer()
  const supervisor = new FakeSupervisor()
  const server = new GuardianServer(peer as unknown as FramedGuardianPeer, supervisor)
  return { peer, supervisor, server, internals: server as unknown as ServerInternals }
}

function spawnRequest(stdio: SubprocessStdio = {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
}): GuardianSpawnRequest {
  return {
    argv: [process.execPath, '-e', ''],
    cwd: process.cwd(),
    stdio,
    graceMs: 100,
  }
}

async function dispatch(
  internals: ServerInternals,
  operation: GuardianOperation,
  body: unknown,
  signal = new AbortController().signal,
): Promise<GuardianCallResult> {
  return internals.dispatch(operation, body, signal)
}

describe('GuardianServer request and lifecycle contracts', () => {
  it('dispatches executable lookup with absent, explicit, and tombstoned environments', async () => {
    const { server, internals } = setup()
    await expect(dispatch(internals, 'resolve-executable', { command: process.execPath })).resolves.toMatchObject({
      value: { executable: process.execPath },
    })
    await expect(dispatch(internals, 'resolve-executable', {
      command: process.execPath,
      env: { KEEP: 'yes', REMOVE: null },
    })).resolves.toMatchObject({ value: { executable: process.execPath } })
    await server.dispose()
  })

  it.each([
    ['resolve-executable', null],
    ['resolve-executable', { command: process.execPath, extra: true }],
    ['resolve-executable', { command: 1 }],
    ['resolve-executable', { command: process.execPath, env: [] }],
    ['resolve-executable', { command: process.execPath, env: { '': 'value' } }],
    ['resolve-executable', { command: process.execPath, env: { KEY: 1 } }],
    ['spawn-prepare', null],
    ['spawn-prepare', { ...spawnRequest(), extra: true }],
    ['spawn-prepare', { ...spawnRequest(), argv: null }],
    ['spawn-prepare', { ...spawnRequest(), argv: [] }],
    ['spawn-prepare', { ...spawnRequest(), argv: [1] }],
    ['spawn-prepare', { ...spawnRequest(), argv: [''] }],
    ['spawn-prepare', { ...spawnRequest(), cwd: '' }],
    ['spawn-prepare', { ...spawnRequest(), graceMs: 0 }],
    ['spawn-prepare', { ...spawnRequest(), graceMs: Number.NaN }],
    ['spawn-prepare', { ...spawnRequest(), graceMs: 2_147_483_648 }],
    ['spawn-prepare', { ...spawnRequest(), stdio: null }],
    ['spawn-prepare', { ...spawnRequest(), stdio: { ...spawnRequest().stdio, extra: true } }],
    ['spawn-prepare', { ...spawnRequest(), stdio: { stdin: null, stdout: 'pipe', stderr: 'pipe' } }],
    ['spawn-prepare', { ...spawnRequest(), stdio: { stdin: { data: 1 }, stdout: 'pipe', stderr: 'pipe' } }],
    ['spawn-prepare', { ...spawnRequest(), stdio: { stdin: { data: '', extra: true }, stdout: 'pipe', stderr: 'pipe' } }],
    ['spawn-prepare', { ...spawnRequest(), stdio: { stdin: 'ignore', stdout: null, stderr: 'pipe' } }],
    ['spawn-prepare', { ...spawnRequest(), stdio: { stdin: 'ignore', stdout: { maxBytes: 0 }, stderr: 'pipe' } }],
    ['spawn-prepare', { ...spawnRequest(), stdio: { stdin: 'ignore', stdout: { maxBytes: 1, extra: true }, stderr: 'pipe' } }],
    ['spawn-prepare', { ...spawnRequest(), stdio: { stdin: 'ignore', stdout: { maxBytes: 1, spill: null }, stderr: 'pipe' } }],
    ['spawn-prepare', { ...spawnRequest(), stdio: { stdin: 'ignore', stdout: { maxBytes: 1, spill: { maxBytes: 0 } }, stderr: 'pipe' } }],
    ['spawn-prepare', { ...spawnRequest(), stdio: { stdin: 'ignore', stdout: { maxBytes: 1, spill: { maxBytes: 1, extra: true } }, stderr: 'pipe' } }],
    ['spawn-prepare', { ...spawnRequest(), env: [] }],
    ['spawn-prepare', { ...spawnRequest(), env: { '': null } }],
    ['spawn-prepare', { ...spawnRequest(), env: { KEY: false } }],
    ['process-terminate', null],
    ['process-terminate', { processId: '', extra: true }],
    ['process-terminate', { processId: '' }],
    ['process-terminate', { processId: 'x'.repeat(129) }],
  ] as const)('rejects hostile %s body %#', async (operation, body) => {
    const { internals } = setup()
    await expect(dispatch(internals, operation, body)).rejects.toThrow('subprocess-guardian')
  })

  it('allocates only requested streams and accepts valid batch and spill dispositions', async () => {
    const none = setup()
    const noStreams = await dispatch(none.internals, 'spawn-prepare', spawnRequest({
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    }))
    expect(noStreams.value).toMatchObject({ pid: 501 })
    expect(noStreams.value).not.toHaveProperty('stdinStreamId')
    expect(none.peer.writers).toHaveLength(0)

    const batch = setup()
    const withStreams = await dispatch(batch.internals, 'spawn-prepare', {
      ...spawnRequest({
        stdin: { data: 'batch input' },
        stdout: { maxBytes: 4 },
        stderr: { maxBytes: 4, spill: { maxBytes: 8 } },
      }),
      env: { KEEP: 'yes' },
    })
    expect(withStreams.value).toMatchObject({ pid: 501 })
    expect(batch.peer.writers).toHaveLength(2)
  })

  it.each(['stdin', 'stdout', 'stderr'] as const)('rolls back when native preparation omits %s', async (missing) => {
    const { supervisor, internals } = setup()
    supervisor.prepared[missing] = undefined
    const stdio: SubprocessStdio = { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
    await expect(dispatch(internals, 'spawn-prepare', spawnRequest(stdio))).rejects.toThrow(`omitted requested ${missing}`)
    expect(supervisor.prepared.rolledBack).toBe(1)
  })

  it('removes failed resume preparation and rejects unknown process operations', async () => {
    const fixture = setup()
    const preparedResult = await dispatch(fixture.internals, 'spawn-prepare', spawnRequest())
    const processId = (preparedResult.value as { processId: string }).processId
    fixture.supervisor.prepared.resumeFailure = 'resume transport failed'
    await expect(dispatch(fixture.internals, 'spawn-resume', { processId })).rejects.toBe('resume transport failed')
    await expect(dispatch(fixture.internals, 'spawn-resume', { processId })).rejects.toThrow('no prepared process')
    await expect(dispatch(fixture.internals, 'process-terminate', { processId })).rejects.toThrow('no owned process')
    await expect(dispatch(fixture.internals, 'process-wait', { processId })).rejects.toThrow('no resumed process')
    await expect(dispatch(fixture.internals, 'process-release', { processId })).resolves.toMatchObject({ value: {} })
  })

  it('activates pipe IO after reply and settles, waits, terminates, and releases once', async () => {
    const fixture = setup()
    const preparedResult = await dispatch(fixture.internals, 'spawn-prepare', spawnRequest())
    const value = preparedResult.value as { processId: string; stdinStreamId: string }
    const resumed = await dispatch(fixture.internals, 'spawn-resume', { processId: value.processId })
    expect(fixture.supervisor.prepared.resumed).toBe(1)
    await resumed.afterReply?.()
    const input = fixture.peer.sinks.get(value.stdinStreamId)
    if (input === undefined) throw new Error('test fixture omitted stdin sink')
    await input.write(Buffer.from('request'))
    await input.end()
    fixture.peer.inputCompletion.get(value.stdinStreamId)?.resolve(undefined)
    ;(fixture.supervisor.prepared.stdout as PassThrough).end('stdout')
    ;(fixture.supervisor.prepared.stderr as PassThrough).end('stderr')
    fixture.supervisor.prepared.owned.outcome.resolve({ exitCode: 0, signal: null })
    await vi.waitFor(() => { expect(fixture.peer.settlements).toHaveLength(1) })
    await expect(dispatch(fixture.internals, 'process-wait', { processId: value.processId })).resolves.toEqual({ value: { exited: true } })
    await expect(dispatch(fixture.internals, 'process-terminate', { processId: value.processId })).resolves.toEqual({ value: {} })
    await expect(dispatch(fixture.internals, 'process-release', { processId: value.processId })).resolves.toEqual({ value: {} })
    await expect(dispatch(fixture.internals, 'process-release', { processId: value.processId })).resolves.toEqual({ value: {} })
    expect(fixture.supervisor.prepared.owned.released).toBe(1)
  })

  it('rolls back a prepared process through process-terminate', async () => {
    const fixture = setup()
    const result = await dispatch(fixture.internals, 'spawn-prepare', spawnRequest())
    const processId = (result.value as { processId: string }).processId
    await dispatch(fixture.internals, 'process-terminate', { processId })
    expect(fixture.supervisor.prepared.rolledBack).toBe(1)
  })

  it('rejects release before whole-tree exit', async () => {
    const fixture = setup()
    const result = await dispatch(fixture.internals, 'spawn-prepare', spawnRequest({
      stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
    }))
    const processId = (result.value as { processId: string }).processId
    const resumed = await dispatch(fixture.internals, 'spawn-resume', { processId })
    await resumed.afterReply?.()
    fixture.supervisor.prepared.owned.exited = false
    await expect(dispatch(fixture.internals, 'process-release', { processId })).rejects.toThrow('whole-tree exit')
    fixture.supervisor.prepared.owned.outcome.resolve({ exitCode: 0, signal: null })
  })

  it('turns output-pump and process-outcome failures into contained settlements', async () => {
    for (const failure of ['pump', 'outcome'] as const) {
      const fixture = setup()
      const result = await dispatch(fixture.internals, 'spawn-prepare', spawnRequest({
        stdin: 'ignore', stdout: 'pipe', stderr: 'inherit',
      }))
      const processId = (result.value as { processId: string }).processId
      if (failure === 'pump') fixture.peer.writers[0]?.write.mockRejectedValueOnce('writer rejected')
      const resumed = await dispatch(fixture.internals, 'spawn-resume', { processId })
      await resumed.afterReply?.()
      if (failure === 'pump') {
        ;(fixture.supervisor.prepared.stdout as PassThrough).end('output')
        fixture.supervisor.prepared.owned.outcome.resolve({ exitCode: 0, signal: null })
      } else {
        fixture.supervisor.prepared.owned.outcome.reject('native outcome failed')
      }
      fixture.supervisor.prepared.owned.terminateFailure = 'terminate cleanup failed'
      fixture.supervisor.prepared.owned.waitFailure = 'wait cleanup failed'
      fixture.peer.settlementFailure = 'settlement send failed'
      await vi.waitFor(() => { expect(fixture.peer.settlements).toHaveLength(1) })
      expect(fixture.peer.settlements[0]?.value).toMatchObject({ ok: false })
    }
  })

  it('uses the stable stream-failure fallback and contains a failed success settlement send', async () => {
    const failed = setup()
    const failedResult = await dispatch(failed.internals, 'spawn-prepare', spawnRequest({
      stdin: 'ignore', stdout: 'pipe', stderr: 'inherit',
    }))
    const failedId = (failedResult.value as { processId: string }).processId
    failed.peer.writers[0]?.write.mockRejectedValueOnce('')
    const failedResume = await dispatch(failed.internals, 'spawn-resume', { processId: failedId })
    await failedResume.afterReply?.()
    ;(failed.supervisor.prepared.stdout as PassThrough).end('output')
    failed.supervisor.prepared.owned.outcome.resolve({ exitCode: 0, signal: null })
    await vi.waitFor(() => {
      expect(failed.peer.settlements[0]?.value).toMatchObject({
        ok: false,
        error: { message: 'guardian stream failed' },
      })
    })

    const success = setup()
    success.peer.settlementFailure = new Error('sidecar disconnected')
    const successResult = await dispatch(success.internals, 'spawn-prepare', spawnRequest({
      stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
    }))
    const successId = (successResult.value as { processId: string }).processId
    const successResume = await dispatch(success.internals, 'spawn-resume', { processId: successId })
    await successResume.afterReply?.()
    success.supervisor.prepared.owned.outcome.resolve({ exitCode: 0, signal: null })
    await vi.waitFor(() => { expect(success.peer.settlements).toHaveLength(1) })
  })

  it('handles non-Buffer readable chunks and already-released ownership', async () => {
    const fixture = setup()
    fixture.supervisor.prepared.stdout = Readable.from([new Uint8Array([1, 2, 3])], { objectMode: true })
    const result = await dispatch(fixture.internals, 'spawn-prepare', spawnRequest({
      stdin: 'ignore', stdout: 'pipe', stderr: 'inherit',
    }))
    const processId = GuardianProcessId((result.value as { processId: string }).processId)
    const resumed = await dispatch(fixture.internals, 'spawn-resume', { processId })
    await resumed.afterReply?.()
    const live = fixture.internals.live.get(processId)
    if (live === undefined) throw new Error('test fixture omitted live process')
    live.released = true
    fixture.supervisor.prepared.owned.outcome.resolve({ exitCode: 0, signal: null })
    await dispatch(fixture.internals, 'process-release', { processId })
    expect(fixture.supervisor.prepared.owned.released).toBe(0)

    const disposed = setup()
    const disposedResult = await dispatch(disposed.internals, 'spawn-prepare', spawnRequest({
      stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
    }))
    const disposedId = GuardianProcessId((disposedResult.value as { processId: string }).processId)
    const disposedResume = await dispatch(disposed.internals, 'spawn-resume', { processId: disposedId })
    await disposedResume.afterReply?.()
    const disposedLive = disposed.internals.live.get(disposedId)
    if (disposedLive === undefined) throw new Error('test fixture omitted disposed live process')
    disposedLive.released = true
    disposed.supervisor.prepared.owned.outcome.resolve({ exitCode: 0, signal: null })
    await disposed.server.dispose()
    expect(disposed.supervisor.prepared.owned.released).toBe(0)
  })

  it('rejects impossible missing outcomes and suppresses settlement sends during disposal', async () => {
    const fixture = setup()
    const processId = GuardianProcessId('manual-live')
    const owned = new FakeOwned()
    const live = {
      processId,
      owned,
      pumps: new Set<Promise<void>>(),
      cancelIo: () => undefined,
      settlement: undefined,
      released: false,
    }
    owned.outcome.resolve(undefined as never)
    await expect(fixture.internals.settle(live)).rejects.toThrow('without an outcome')

    const disposed = setup()
    const disposedId = GuardianProcessId('disposed-live')
    const disposedOwned = new FakeOwned()
    const disposedLive = { ...live, processId: disposedId, owned: disposedOwned }
    const shuttingDown = disposed.server.dispose()
    disposedOwned.outcome.resolve({ exitCode: 0, signal: null })
    await disposed.internals.settle(disposedLive)
    await shuttingDown
    expect(disposed.peer.settlements).toEqual([])
  })

  it('handles batch-input and writable sink failures without leaking callbacks', async () => {
    const fixture = setup()
    const inputFace = new EventEmitter() as EventEmitter & {
      end(data: string, callback: () => void): void
      destroy(): void
    }
    inputFace.end = () => { inputFace.emit('error', new Error('batch input failed')) }
    inputFace.destroy = () => undefined
    const input = inputFace as unknown as Writable
    fixture.supervisor.prepared.stdin = input
    const batch = await dispatch(fixture.internals, 'spawn-prepare', spawnRequest({
      stdin: { data: 'batch' }, stdout: 'inherit', stderr: 'inherit',
    }))
    const batchId = (batch.value as { processId: string }).processId
    const resumed = await dispatch(fixture.internals, 'spawn-resume', { processId: batchId })
    await resumed.afterReply?.()

    const piped = setup()
    const targetFace = new EventEmitter() as EventEmitter & {
      write(data: Buffer, callback: () => void): boolean
      end(callback: () => void): void
      destroy(): void
    }
    targetFace.write = () => {
      targetFace.emit('error', new Error('stdin write failed'))
      return false
    }
    targetFace.end = () => { targetFace.emit('error', new Error('stdin end failed')) }
    targetFace.destroy = () => undefined
    const target = targetFace as unknown as Writable
    piped.supervisor.prepared.stdin = target
    const result = await dispatch(piped.internals, 'spawn-prepare', spawnRequest({
      stdin: 'pipe', stdout: 'inherit', stderr: 'inherit',
    }))
    const sink = piped.peer.sinks.get((result.value as { stdinStreamId: string }).stdinStreamId)
    await expect(sink?.write(Buffer.from('input'))).rejects.toThrow('stdin write failed')
    await expect(sink?.end()).rejects.toThrow('stdin end failed')
    await sink?.fail(new Error('cancel input'))
  })

  it('removes the batch-input error listener after a successful write', async () => {
    const fixture = setup()
    const input = new PassThrough()
    fixture.supervisor.prepared.stdin = input
    const result = await dispatch(fixture.internals, 'spawn-prepare', spawnRequest({
      stdin: { data: 'batch' }, stdout: 'inherit', stderr: 'inherit',
    }))
    const processId = (result.value as { processId: string }).processId
    const resumed = await dispatch(fixture.internals, 'spawn-resume', { processId })
    const finished = once(input, 'finish')
    await resumed.afterReply?.()
    await finished
    expect(input.listenerCount('error')).toBe(0)
    fixture.supervisor.prepared.owned.outcome.resolve({ exitCode: 0, signal: null })
  })

  it('contains close-triggered disposal and makes explicit disposal idempotent', async () => {
    const fixture = setup()
    await dispatch(fixture.internals, 'spawn-prepare', spawnRequest())
    fixture.peer.close?.(new Error('sidecar disconnected'))
    await vi.waitFor(() => { expect(fixture.supervisor.disposed).toBe(1) })
    const first = fixture.server.dispose()
    expect(fixture.server.dispose()).toBe(first)
    await first
    await expect(dispatch(fixture.internals, 'resolve-executable', { command: process.execPath })).rejects.toThrow('disposing')
    expect(fixture.peer.disposed).toBe(true)
  })

  it('disposes live IO, settlement, and ownership regardless of individual cleanup failure', async () => {
    const fixture = setup()
    const result = await dispatch(fixture.internals, 'spawn-prepare', spawnRequest())
    const processId = (result.value as { processId: string }).processId
    const resumed = await dispatch(fixture.internals, 'spawn-resume', { processId })
    await resumed.afterReply?.()
    fixture.supervisor.prepared.owned.terminateFailure = new Error('terminate failed')
    fixture.supervisor.prepared.owned.waitFailure = new Error('wait failed')
    fixture.supervisor.prepared.owned.releaseFailure = new Error('release failed')
    fixture.supervisor.prepared.owned.outcome.resolve({ exitCode: 0, signal: null })
    fixture.peer.writers[0]?.cancel.mockRejectedValueOnce(new Error('stdout cancel failed'))
    fixture.peer.writers[1]?.cancel.mockRejectedValueOnce(new Error('stderr cancel failed'))
    await fixture.server.dispose()
    expect(fixture.supervisor.disposed).toBe(1)
  })
})
