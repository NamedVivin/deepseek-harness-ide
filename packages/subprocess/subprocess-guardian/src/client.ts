/** Pure-Node sidecar client translating the subprocess seam to guardian RPC and framed stdio. */

import { PassThrough, Writable } from 'node:stream'
import type { Readable } from 'node:stream'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutputMode,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-collector'
import { FramedGuardianPeer, type GuardianByteSink, type GuardianByteWriter } from './channel.ts'
import type { GuardianPreparedSpawn, GuardianSpawnRequest } from './guardian.ts'
import {
  GuardianProcessId,
  GuardianStreamId,
  type GuardianProcessId as GuardianProcessIdType,
  type GuardianSettlement,
  type GuardianStreamId as GuardianStreamIdType,
} from './protocol.ts'

/** Transport client consumed by the Cordis provider and deterministic tests. */
export interface GuardianSubprocessClient {
  /** Resolve an executable in the guardian execution world. */
  resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>
  /** Publish a handle only after remote ownership, local stdio setup, and native resume are acknowledged. */
  spawn(spec: SubprocessSpawnSpec): Promise<SubprocessHandle>
  /** Reject pending operations and remove guardian-protocol listeners. */
  dispose(): Promise<void>
}

interface ClientProcess {
  readonly processId: GuardianProcessIdType
  readonly done: PromiseWithResolvers<GuardianSettlement>
  readonly outputComplete: readonly Promise<void>[]
  readonly collectors: readonly OutputCollector[]
  settled: boolean
}

/** Framed child-IPC implementation used by the packaged pure-Node Host sidecar. */
export class IpcGuardianSubprocessClient implements GuardianSubprocessClient {
  private readonly processes = new Map<GuardianProcessIdType, ClientProcess>()
  private readonly removeSettlement: () => void
  private readonly removeClose: () => void
  private closedError: Error | undefined

  /** @param peer - bounded guardian protocol peer over the sidecar's Node IPC channel. */
  constructor(private readonly peer: FramedGuardianPeer) {
    this.removeSettlement = peer.onProcessSettled((processId, settlement) => {
      const process = this.processes.get(processId)
      if (process !== undefined && !process.settled) {
        process.settled = true
        process.done.resolve(settlement)
      }
    })
    this.removeClose = peer.onClosed((error) => {
      this.closedError = error
      for (const process of this.processes.values()) {
        if (!process.settled) {
          process.settled = true
          process.done.resolve({ ok: false, error: { code: 'disconnected', message: error.message } })
        }
      }
    })
  }

  /** @inheritdoc */
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    this.requireOpen()
    const result = requireRecord(await this.peer.call('resolve-executable', { command, ...env === undefined ? {} : { env } }, signal))
    if (Object.keys(result).length !== 1 || typeof result.executable !== 'string' || result.executable.length === 0) {
      throw new Error('subprocess-guardian: invalid resolve-executable result')
    }
    return result.executable
  }

  /** @inheritdoc */
  async spawn(spec: SubprocessSpawnSpec): Promise<SubprocessHandle> {
    this.requireOpen()
    spec.signal?.throwIfAborted()
    const request: GuardianSpawnRequest = {
      argv: [...spec.argv],
      cwd: spec.cwd,
      stdio: spec.stdio,
      graceMs: spec.graceMs,
      ...spec.env === undefined ? {} : { env: encodeEnvironment(spec.env) },
    }
    const prepared = parsePreparedSpawn(await this.peer.call('spawn-prepare', request, spec.signal))
    const output = this.installOutputs(prepared, spec)
    const stdin = spec.stdio.stdin === 'pipe'
      ? new GuardianInputWritable(this.peer.createWriter(prepared.stdinStreamId as GuardianStreamIdType))
      : undefined
    const settlement = Promise.withResolvers<GuardianSettlement>()
    const process: ClientProcess = {
      processId: prepared.processId,
      done: settlement,
      outputComplete: output.complete,
      collectors: output.collectors,
      settled: false,
    }
    this.processes.set(prepared.processId, process)
    try {
      await this.peer.call('spawn-resume', { processId: prepared.processId }, spec.signal)
    } catch (error) {
      this.processes.delete(prepared.processId)
      stdin?.destroy(asError(error))
      output.cancel(asError(error))
      await this.peer.call('process-terminate', { processId: prepared.processId }).catch(() => undefined)
      throw error
    }

    let terminated = false
    const onAbort = (): void => { terminate() }
    const terminate = (): void => {
      if (terminated) return
      terminated = true
      void this.peer.call('process-terminate', { processId: prepared.processId }).catch((error: unknown) => {
        if (!process.settled) {
          process.settled = true
          process.done.resolve({ ok: false, error: { code: 'disconnected', message: asError(error).message } })
        }
      })
    }
    spec.signal?.addEventListener('abort', onAbort, { once: true })

    const done = this.finishProcess(process).finally(() => {
      spec.signal?.removeEventListener('abort', onAbort)
    })
    const waitForExit = async (signal?: AbortSignal): Promise<boolean> => {
      if (signal?.aborted === true) return false
      try {
        const value = requireRecord(await this.peer.call('process-wait', { processId: prepared.processId }, signal))
        if (Object.keys(value).length !== 1 || typeof value.exited !== 'boolean') {
          throw new Error('subprocess-guardian: invalid process-wait result')
        }
        return value.exited
      } catch (error) {
        if (isAborted(signal)) return false
        throw error
      }
    }
    void done.then(() => undefined, () => undefined).then(async () => {
      if (await waitForExit().catch(() => false)) {
        await this.peer.call('process-release', { processId: prepared.processId }).catch(() => undefined)
        this.processes.delete(prepared.processId)
      }
    })

    return {
      pid: prepared.pid,
      stdin,
      stdout: output.stdout,
      stderr: output.stderr,
      collected: output.collected,
      done,
      terminate,
      waitForExit,
    }
  }

  /** @inheritdoc */
  async dispose(): Promise<void> {
    if (this.closedError === undefined) this.closedError = new Error('subprocess-guardian: client disposed')
    this.removeSettlement()
    this.removeClose()
    for (const process of this.processes.values()) {
      for (const collector of process.collectors) collector.fail()
      if (!process.settled) {
        process.settled = true
        process.done.resolve({ ok: false, error: { code: 'disconnected', message: this.closedError.message } })
      }
    }
    this.processes.clear()
    await this.peer.dispose(this.closedError)
  }

  private installOutputs(prepared: GuardianPreparedSpawn, spec: SubprocessSpawnSpec): {
    stdout: Readable | undefined
    stderr: Readable | undefined
    collected: { stdout?: SubprocessOutputReader; stderr?: SubprocessOutputReader }
    collectors: OutputCollector[]
    complete: Promise<void>[]
    cancel(error: Error): void
  } {
    const stdout = installOutput(this.peer, prepared.stdoutStreamId, spec.stdio.stdout, 'stdout')
    const stderr = installOutput(this.peer, prepared.stderrStreamId, spec.stdio.stderr, 'stderr')
    return {
      stdout: stdout.readable,
      stderr: stderr.readable,
      collected: {
        ...stdout.collector === undefined ? {} : { stdout: stdout.collector },
        ...stderr.collector === undefined ? {} : { stderr: stderr.collector },
      },
      collectors: [stdout.collector, stderr.collector].filter(value => value !== undefined),
      complete: [stdout.complete, stderr.complete].filter(value => value !== undefined),
      cancel: (error) => {
        stdout.cancel(error)
        stderr.cancel(error)
      },
    }
  }

  private async finishProcess(process: ClientProcess) {
    const settlement = await process.done.promise
    const output = await Promise.allSettled(process.outputComplete)
    const outputFailure = output.find(value => value.status === 'rejected')
    if (!settlement.ok || outputFailure !== undefined) {
      for (const collector of process.collectors) collector.fail()
      if (!settlement.ok) throw errorFromSettlement(settlement)
      throw asError(outputFailure?.reason)
    }
    return settlement.outcome
  }

  private requireOpen(): void {
    if (this.closedError !== undefined) throw this.closedError
  }
}

class GuardianInputWritable extends Writable {
  /** @param writer - framed stdin writer. */
  constructor(private readonly writer: GuardianByteWriter) { super() }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    void this.writer.write(data).then(() => { callback() }, (error: unknown) => { callback(asError(error)) })
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.writer.end().then(() => { callback() }, (error: unknown) => { callback(asError(error)) })
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    void this.writer.cancel(error ?? new Error('guardian stdin destroyed')).then(
      () => { callback(error) },
      (cancelError: unknown) => { callback(asError(cancelError)) },
    )
  }
}

function installOutput(
  peer: FramedGuardianPeer,
  streamId: GuardianStreamIdType | undefined,
  mode: SubprocessOutputMode,
  label: string,
): {
  readable: Readable | undefined
  collector: OutputCollector | undefined
  complete: Promise<void> | undefined
  cancel(error: Error): void
} {
  if (mode === 'inherit') {
    if (streamId !== undefined) throw new Error(`subprocess-guardian: unexpected ${label} stream for inherit mode`)
    return { readable: undefined, collector: undefined, complete: undefined, cancel: () => {} }
  }
  if (streamId === undefined) throw new Error(`subprocess-guardian: missing ${label} stream`)
  if (mode === 'pipe') {
    const readable = new PassThrough()
    const complete = peer.acceptStream(streamId, passThroughSink(readable))
    return {
      readable,
      collector: undefined,
      complete,
      cancel: (error) => { readable.destroy(error) },
    }
  }
  const collector = createCollector(mode, label)
  const complete = peer.acceptStream(streamId, {
    write: (chunk) => { collector.push(chunk) },
    end: () => { collector.finalize() },
    fail: () => { collector.fail() },
  })
  return {
    readable: undefined,
    collector,
    complete,
    cancel: () => { collector.fail() },
  }
}

function createCollector(mode: SubprocessCollect, label: string): OutputCollector {
  return new OutputCollector({
    maxBytes: mode.maxBytes,
    ...mode.spill === undefined ? {} : { maxSpillBytes: mode.spill.maxBytes },
    label,
  })
}

function passThroughSink(stream: PassThrough): GuardianByteSink {
  return {
    write: chunk => new Promise<void>((resolve, reject) => {
      const accepted = stream.write(chunk, (error) => {
        if (error !== undefined && error !== null) reject(error)
        else if (accepted) resolve()
      })
      if (!accepted) stream.once('drain', resolve)
    }),
    end: () => { stream.end() },
    fail: (error) => { stream.destroy(error) },
  }
}

function parsePreparedSpawn(value: unknown): GuardianPreparedSpawn {
  const body = requireRecord(value)
  const allowed = new Set(['processId', 'pid', 'stdinStreamId', 'stdoutStreamId', 'stderrStreamId'])
  if (Object.keys(body).some(key => !allowed.has(key))
    || typeof body.processId !== 'string' || body.processId.length === 0 || body.processId.length > 128
    || !Number.isSafeInteger(body.pid) || (body.pid as number) <= 0) {
    throw new Error('subprocess-guardian: invalid spawn-prepare result')
  }
  return {
    processId: GuardianProcessId(body.processId),
    pid: body.pid as number,
    ...optionalStreamId(body.stdinStreamId, 'stdinStreamId'),
    ...optionalStreamId(body.stdoutStreamId, 'stdoutStreamId'),
    ...optionalStreamId(body.stderrStreamId, 'stderrStreamId'),
  }
}

function optionalStreamId(value: unknown, key: 'stdinStreamId' | 'stdoutStreamId' | 'stderrStreamId') {
  if (value === undefined) return {}
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error(`subprocess-guardian: invalid ${key}`)
  }
  return { [key]: GuardianStreamId(value) }
}

function encodeEnvironment(env: NodeJS.ProcessEnv): Record<string, string | null> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value ?? null]))
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('subprocess-guardian: invalid guardian result body')
  }
  return value as Record<string, unknown>
}

function errorFromSettlement(value: Extract<GuardianSettlement, { ok: false }>): Error {
  const error = new Error(value.error.message)
  error.name = `Guardian${value.error.code.split('-').map(part => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join('')}Error`
  return error
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}
