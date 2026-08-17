import { once } from 'node:events'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import type {
  GuardianByteSink,
  GuardianByteWriter,
} from '../src/channel.ts'
import { FramedGuardianPeer } from '../src/channel.ts'
import { IpcGuardianSubprocessClient } from '../src/client.ts'
import {
  GuardianProcessId,
  GuardianStreamId,
  type GuardianProcessId as GuardianProcessIdType,
  type GuardianSettlement,
  type GuardianStreamId as GuardianStreamIdType,
} from '../src/protocol.ts'

interface CallRecord {
  readonly operation: string
  readonly body: unknown
  readonly signal: AbortSignal | undefined
}

class FakePeer {
  readonly calls: CallRecord[] = []
  readonly sinks = new Map<GuardianStreamIdType, GuardianByteSink>()
  readonly writers = new Map<GuardianStreamIdType, {
    readonly writer: GuardianByteWriter
    readonly write: ReturnType<typeof vi.fn>
    readonly end: ReturnType<typeof vi.fn>
    readonly cancel: ReturnType<typeof vi.fn>
  }>()
  callImpl: (operation: string, body: unknown, signal?: AbortSignal) => Promise<unknown> = async () => ({})
  settlement: ((processId: GuardianProcessIdType, value: GuardianSettlement) => void) | undefined
  close: ((error: Error) => void) | undefined
  disposed: Error | undefined

  onProcessSettled(listener: (processId: GuardianProcessIdType, value: GuardianSettlement) => void): () => void {
    this.settlement = listener
    return () => { if (this.settlement === listener) this.settlement = undefined }
  }

  onClosed(listener: (error: Error) => void): () => void {
    this.close = listener
    return () => { if (this.close === listener) this.close = undefined }
  }

  async call(operation: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    this.calls.push({ operation, body, signal })
    return this.callImpl(operation, body, signal)
  }

  createWriter(streamId: GuardianStreamIdType): GuardianByteWriter {
    const write = vi.fn(async () => undefined)
    const end = vi.fn(async () => undefined)
    const cancel = vi.fn(async () => undefined)
    const writer = { write, end, cancel }
    this.writers.set(streamId, { writer, write, end, cancel })
    return writer
  }

  acceptStream(streamId: GuardianStreamIdType, sink: GuardianByteSink): Promise<void> {
    this.sinks.set(streamId, sink)
    return new Promise<void>((resolve, reject) => {
      const originalEnd = sink.end.bind(sink)
      const originalFail = sink.fail.bind(sink)
      sink.end = async () => { await originalEnd(); resolve() }
      sink.fail = async (error) => { await originalFail(error); reject(error) }
    })
  }

  async dispose(reason: Error): Promise<void> { this.disposed = reason }

  emitSettlement(processId: string, value: GuardianSettlement): void {
    this.settlement?.(GuardianProcessId(processId), value)
  }
}

function asPeer(value: FakePeer): FramedGuardianPeer {
  return value as unknown as FramedGuardianPeer
}

function spec(overrides: Partial<SubprocessSpawnSpec> = {}): SubprocessSpawnSpec {
  return {
    argv: ['node', '-e', ''],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    graceMs: 100,
    ...overrides,
  }
}

function prepared(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { processId: 'process-1', pid: 41, ...overrides }
}

describe('IpcGuardianSubprocessClient contracts', () => {
  it('validates executable results and preserves explicit environment requests', async () => {
    const peer = new FakePeer()
    const client = new IpcGuardianSubprocessClient(asPeer(peer))
    peer.callImpl = async (_operation, body) => ({ executable: (body as { command: string }).command })
    await expect(client.resolveExecutable('/bin/node')).resolves.toBe('/bin/node')
    await expect(client.resolveExecutable('/bin/node', { PATH: '/bin' })).resolves.toBe('/bin/node')
    expect(peer.calls.map(value => value.body)).toEqual([
      { command: '/bin/node' },
      { command: '/bin/node', env: { PATH: '/bin' } },
    ])

    for (const value of [null, [], {}, { executable: '' }, { executable: '/bin/node', extra: true }]) {
      peer.callImpl = async () => value
      await expect(client.resolveExecutable('node')).rejects.toThrow(/invalid .*result|invalid guardian result body/u)
    }
    await client.dispose()
    await expect(client.resolveExecutable('node')).rejects.toThrow('disposed')
  })

  it('relays pipe and collected output, stdin, settlement, wait, and release', async () => {
    const peer = new FakePeer()
    peer.callImpl = async (operation) => {
      if (operation === 'spawn-prepare') {
        return prepared({
          stdinStreamId: 'stdin-1',
          stdoutStreamId: 'stdout-1',
          stderrStreamId: 'stderr-1',
        })
      }
      if (operation === 'process-wait') return { exited: true }
      return {}
    }
    const client = new IpcGuardianSubprocessClient(asPeer(peer))
    const handle = await client.spawn(spec({
      env: { PRESENT: 'yes', REMOVED: undefined },
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: 8, spill: { maxBytes: 16 } },
      },
    }))
    const prepareCall = peer.calls.find(value => value.operation === 'spawn-prepare')
    expect(prepareCall?.body).toMatchObject({ env: { PRESENT: 'yes', REMOVED: null } })

    const stdout = peer.sinks.get(GuardianStreamId('stdout-1'))
    const stderr = peer.sinks.get(GuardianStreamId('stderr-1'))
    if (stdout === undefined || stderr === undefined || handle.stdout === undefined || handle.stdin === undefined) {
      throw new Error('test fixture omitted requested streams')
    }
    let output = ''
    handle.stdout.on('data', (chunk) => { output += String(chunk) })
    await stdout.write(Buffer.alloc(32 * 1024, 97))
    await stdout.write(Buffer.from('tail'))
    await stdout.end()
    await stderr.write(Buffer.from('diagnostic'))
    await stderr.end()

    handle.stdin.write('text')
    handle.stdin.end(Buffer.from('bytes'))
    await once(handle.stdin, 'finish')
    expect(peer.writers.get(GuardianStreamId('stdin-1'))?.write).toHaveBeenCalled()
    expect(output.endsWith('tail')).toBe(true)

    peer.emitSettlement('unknown', { ok: true, outcome: { exitCode: 99, signal: null } })
    peer.emitSettlement('process-1', { ok: true, outcome: { exitCode: 0, signal: null } })
    peer.emitSettlement('process-1', { ok: false, error: { code: 'internal', message: 'duplicate' } })
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(handle.waitForExit()).resolves.toBe(true)
    await vi.waitFor(() => {
      expect(peer.calls.some(value => value.operation === 'process-release')).toBe(true)
    })
    expect(handle.collected.stderr?.readFrom(0).text).toBe('agnostic')
    await client.dispose()
  })

  it('supports inherited output without allocating stream state', async () => {
    const peer = new FakePeer()
    peer.callImpl = async operation => operation === 'spawn-prepare' ? prepared() : operation === 'process-wait' ? { exited: false } : {}
    const client = new IpcGuardianSubprocessClient(asPeer(peer))
    const handle = await client.spawn(spec())
    expect(handle.stdout).toBeUndefined()
    expect(handle.stderr).toBeUndefined()
    expect(handle.collected).toEqual({})
    handle.terminate()
    handle.terminate()
    peer.emitSettlement('process-1', { ok: false, error: { code: 'not-supported', message: 'native failure' } })
    await expect(handle.done).rejects.toMatchObject({ name: 'GuardianNotSupportedError' })
    await vi.waitFor(() => {
      expect(peer.calls.filter(value => value.operation === 'process-terminate')).toHaveLength(1)
    })
    await client.dispose()
  })

  it('rolls back local streams and remote ownership when resume fails', async () => {
    const peer = new FakePeer()
    peer.callImpl = async (operation) => {
      if (operation === 'spawn-prepare') return prepared({ stdoutStreamId: 'stdout-1', stderrStreamId: 'stderr-1' })
      if (operation === 'spawn-resume') throw 'resume failed'
      if (operation === 'process-terminate') throw new Error('rollback transport disconnected')
      return {}
    }
    const client = new IpcGuardianSubprocessClient(asPeer(peer))
    await expect(client.spawn(spec({
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8 }, stderr: { maxBytes: 8 } },
    }))).rejects.toBe('resume failed')
    expect(peer.calls.some(value => value.operation === 'process-terminate')).toBe(true)
    await client.dispose()
  })

  it('maps terminate transport failure to settlement and handles abort-aware waits', async () => {
    const peer = new FakePeer()
    peer.callImpl = async (operation, _body, signal) => {
      if (operation === 'spawn-prepare') return prepared()
      if (operation === 'process-terminate') throw 'guardian vanished'
      if (operation === 'process-wait') {
        signal?.throwIfAborted()
        throw new Error('wait failed')
      }
      return {}
    }
    const client = new IpcGuardianSubprocessClient(asPeer(peer))
    const controller = new AbortController()
    const handle = await client.spawn(spec({ signal: controller.signal }))
    controller.abort(new Error('stop child'))
    await expect(handle.done).rejects.toThrow('guardian vanished')
    await expect(handle.waitForExit(AbortSignal.abort(new Error('already stopped')))).resolves.toBe(false)
    const later = new AbortController()
    const waiting = handle.waitForExit(later.signal)
    later.abort(new Error('wait cancelled'))
    await expect(waiting).resolves.toBe(false)
    await expect(handle.waitForExit()).rejects.toThrow('wait failed')
    await client.dispose()
  })

  it('rejects malformed prepared, output, and wait responses', async () => {
    const badPrepared = [
      null,
      { processId: '', pid: 1 },
      { processId: 'p', pid: 0 },
      { processId: 'p', pid: 1, extra: true },
      { processId: 'p', pid: 1, stdinStreamId: '' },
      { processId: 'p', pid: 1, stdoutStreamId: 1 },
      { processId: 'p', pid: 1, stderrStreamId: 'x'.repeat(129) },
    ]
    for (const value of badPrepared) {
      const peer = new FakePeer()
      peer.callImpl = async () => value
      const client = new IpcGuardianSubprocessClient(asPeer(peer))
      await expect(client.spawn(spec())).rejects.toThrow(/invalid/u)
      await client.dispose()
    }

    for (const value of [
      prepared({ stdoutStreamId: 'unexpected' }),
      prepared({ stderrStreamId: 'unexpected' }),
      prepared(),
    ]) {
      const peer = new FakePeer()
      peer.callImpl = async operation => operation === 'spawn-prepare' ? value : {}
      const client = new IpcGuardianSubprocessClient(asPeer(peer))
      const requested = Object.hasOwn(value, 'stdoutStreamId')
        ? spec()
        : spec({ stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' } })
      await expect(client.spawn(requested)).rejects.toThrow(/unexpected stdout|unexpected stderr|missing stdout/u)
      await client.dispose()
    }

    const peer = new FakePeer()
    peer.callImpl = async operation => operation === 'spawn-prepare' ? prepared() : operation === 'process-wait' ? { exited: 'yes' } : {}
    const client = new IpcGuardianSubprocessClient(asPeer(peer))
    const handle = await client.spawn(spec())
    await expect(handle.waitForExit()).rejects.toThrow('invalid process-wait result')
    peer.emitSettlement('process-1', { ok: true, outcome: { exitCode: 0, signal: null } })
    await handle.done
    await client.dispose()
  })

  it('surfaces output failure even when the process outcome succeeds', async () => {
    const peer = new FakePeer()
    peer.callImpl = async operation => operation === 'spawn-prepare'
      ? prepared({ stdoutStreamId: 'stdout-1' })
      : {}
    const client = new IpcGuardianSubprocessClient(asPeer(peer))
    const handle = await client.spawn(spec({ stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' } }))
    handle.stdout?.on('error', () => undefined)
    await peer.sinks.get(GuardianStreamId('stdout-1'))?.fail(new Error('output relay failed'))
    peer.emitSettlement('process-1', { ok: true, outcome: { exitCode: 0, signal: null } })
    await expect(handle.done).rejects.toThrow('output relay failed')
    await client.dispose()
  })

  it('settles live work when the peer closes and preserves that reason during disposal', async () => {
    const peer = new FakePeer()
    peer.callImpl = async operation => operation === 'spawn-prepare' ? prepared() : {}
    const client = new IpcGuardianSubprocessClient(asPeer(peer))
    const handle = await client.spawn(spec())
    peer.close?.(new Error('physical IPC lost'))
    await expect(handle.done).rejects.toThrow('physical IPC lost')
    await client.dispose()
    expect(peer.disposed?.message).toBe('physical IPC lost')
  })

  it('does not resettle an already terminal process when the peer closes', async () => {
    const peer = new FakePeer()
    peer.callImpl = async operation => operation === 'spawn-prepare' ? prepared() : {}
    const client = new IpcGuardianSubprocessClient(asPeer(peer))
    const handle = await client.spawn(spec())
    peer.emitSettlement('process-1', { ok: true, outcome: { exitCode: 0, signal: null } })
    peer.close?.(new Error('late peer close'))
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    await client.dispose()
  })

  it('settles an unowned live process when explicit client disposal begins', async () => {
    const peer = new FakePeer()
    peer.callImpl = async operation => operation === 'spawn-prepare' ? prepared() : {}
    const client = new IpcGuardianSubprocessClient(asPeer(peer))
    const handle = await client.spawn(spec())
    const disposing = client.dispose()
    await expect(handle.done).rejects.toThrow('client disposed')
    await disposing
  })

  it('contains late terminate and release transport failures after terminal settlement', async () => {
    const peer = new FakePeer()
    peer.callImpl = async (operation) => {
      if (operation === 'spawn-prepare') return prepared()
      if (operation === 'process-wait') return { exited: true }
      if (operation === 'process-terminate' || operation === 'process-release') throw new Error(`${operation} failed`)
      return {}
    }
    const client = new IpcGuardianSubprocessClient(asPeer(peer))
    const handle = await client.spawn(spec())
    peer.emitSettlement('process-1', { ok: true, outcome: { exitCode: 0, signal: null } })
    handle.terminate()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    await vi.waitFor(() => {
      expect(peer.calls.some(value => value.operation === 'process-release')).toBe(true)
    })
    await client.dispose()
  })

  it('propagates stdin writer failures and both pipe-output backpressure paths', async () => {
    const peer = new FakePeer()
    peer.callImpl = async operation => operation === 'spawn-prepare'
      ? prepared({ stdinStreamId: 'stdin-1' })
      : {}
    const client = new IpcGuardianSubprocessClient(asPeer(peer))
    const handle = await client.spawn(spec({ stdio: { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' } }))
    if (handle.stdin === undefined) throw new Error('test fixture omitted stdin')
    const writer = peer.writers.get(GuardianStreamId('stdin-1'))
    if (writer === undefined) throw new Error('test fixture omitted stdin writer')
    writer.write.mockRejectedValueOnce('write failed')
    await expect(new Promise<void>((resolve, reject) => {
      ;(handle.stdin as unknown as {
        _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void
      })._write('text', 'utf8', (error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    })).rejects.toThrow('write failed')
    writer.end.mockRejectedValueOnce('end failed')
    await expect(new Promise<void>((resolve, reject) => {
      ;(handle.stdin as unknown as {
        _final(callback: (error?: Error | null) => void): void
      })._final((error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    })).rejects.toThrow('end failed')
    writer.cancel.mockRejectedValueOnce('cancel failed')
    await expect(new Promise<void>((resolve, reject) => {
      ;(handle.stdin as unknown as {
        _destroy(error: Error | null, callback: (error?: Error | null) => void): void
      })._destroy(null, (error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    })).rejects.toThrow('cancel failed')

    const installed = (client as unknown as {
      installOutputs(value: unknown, requested: SubprocessSpawnSpec): {
        stdout: NodeJS.ReadableStream | undefined
        cancel(error: Error): void
      }
    }).installOutputs({
      processId: GuardianProcessId('local-output'),
      pid: 1,
      stdoutStreamId: GuardianStreamId('local-stdout'),
    }, spec({ stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' } }))
    const readable = installed.stdout
    if (readable === undefined) throw new Error('test fixture omitted local stdout')
    const sink = peer.sinks.get(GuardianStreamId('local-stdout'))
    if (sink === undefined) throw new Error('test fixture omitted local stdout sink')
    const blocked = sink.write(Buffer.alloc(128 * 1024))
    readable.on('data', () => undefined)
    await blocked
    readable.on('error', () => undefined)
    installed.cancel(new Error('local setup failed'))
    await expect(sink.write(Buffer.from('after destroy'))).rejects.toThrow('destroyed')
    await expect(sink.end()).resolves.toBeUndefined()

    peer.emitSettlement('process-1', { ok: true, outcome: { exitCode: 0, signal: null } })
    await handle.done
    await client.dispose()
  })

  it('keeps inherited-output cancellation inert during resume rollback', async () => {
    const peer = new FakePeer()
    peer.callImpl = async (operation) => {
      if (operation === 'spawn-prepare') return prepared()
      if (operation === 'spawn-resume') throw new Error('resume rejected')
      return {}
    }
    const client = new IpcGuardianSubprocessClient(asPeer(peer))
    await expect(client.spawn(spec())).rejects.toThrow('resume rejected')
    await client.dispose()
  })

  it('constructs a stable error name even for an empty malformed code segment', async () => {
    const peer = new FakePeer()
    peer.callImpl = async operation => operation === 'spawn-prepare' ? prepared() : {}
    const client = new IpcGuardianSubprocessClient(asPeer(peer))
    const handle = await client.spawn(spec())
    peer.emitSettlement('process-1', {
      ok: false,
      error: { code: '-' as never, message: 'malformed error code' },
    })
    await expect(handle.done).rejects.toMatchObject({ name: 'GuardianError' })
    await client.dispose()
  })
})
