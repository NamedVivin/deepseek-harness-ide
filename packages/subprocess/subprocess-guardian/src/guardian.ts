/** Guardian-side request dispatcher, stream relay, and kill-and-join lifecycle. */

import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import type {
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
  SubprocessStdinMode,
  SubprocessStdio,
} from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  FramedGuardianPeer,
  type GuardianByteSink,
  type GuardianByteWriter,
  type GuardianCallResult,
} from './channel.ts'
import {
  GuardianProcessId,
  GuardianProtocolError,
  GuardianStreamId,
  type GuardianOperation,
  type GuardianProcessId as GuardianProcessIdType,
  type GuardianStreamId as GuardianStreamIdType,
} from './protocol.ts'
import {
  guardianChildEnv,
  resolveGuardianExecutable,
  type GuardianNativeSpawnSpec,
  type GuardianOwnedProcess,
  type GuardianPreparedProcess,
  type GuardianProcessSupervisor,
} from './supervisor.ts'

/** Serializable spawn request; `null` is an explicit environment tombstone. */
export interface GuardianSpawnRequest extends Omit<SubprocessSpawnSpec, 'signal' | 'env'> {
  readonly env?: Readonly<Record<string, string | null>> | undefined
}

/** Streams allocated while a native target remains stopped. */
export interface GuardianPreparedSpawn {
  readonly processId: GuardianProcessIdType
  readonly pid: number
  readonly stdinStreamId?: GuardianStreamIdType | undefined
  readonly stdoutStreamId?: GuardianStreamIdType | undefined
  readonly stderrStreamId?: GuardianStreamIdType | undefined
}

interface PreparedEntry {
  readonly processId: GuardianProcessIdType
  readonly prepared: GuardianPreparedProcess
  readonly spec: GuardianSpawnRequest
  readonly stdinStreamId: GuardianStreamIdType | undefined
  readonly stdoutWriter: GuardianByteWriter | undefined
  readonly stderrWriter: GuardianByteWriter | undefined
  readonly inputComplete: Promise<void> | undefined
}

interface LiveEntry {
  readonly processId: GuardianProcessIdType
  readonly owned: GuardianOwnedProcess
  readonly pumps: Set<Promise<void>>
  readonly cancelIo: (error: Error) => void
  settlement: Promise<void> | undefined
  released: boolean
}

/**
 * Runtime guardian serving one sidecar peer. A peer disconnect immediately starts the same kill-and-join disposal
 * transaction as an explicit desktop shutdown.
 */
export class GuardianServer {
  private readonly prepared = new Map<GuardianProcessIdType, PreparedEntry>()
  private readonly live = new Map<GuardianProcessIdType, LiveEntry>()
  private readonly removeHandler: () => void
  private readonly removeClose: () => void
  private disposePromise: Promise<void> | undefined

  /** @param peer - bounded framed sidecar peer. @param supervisor - sole platform process authority. */
  constructor(
    private readonly peer: FramedGuardianPeer,
    private readonly supervisor: GuardianProcessSupervisor,
  ) {
    this.removeHandler = peer.handleCalls((operation, body, signal) => this.dispatch(operation, body, signal))
    this.removeClose = peer.onClosed(() => { void this.dispose() })
  }

  /** Kill, join, and release every process before closing the platform supervisor. */
  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce()
    return this.disposePromise
  }

  private async dispatch(
    operation: GuardianOperation,
    body: unknown,
    signal: AbortSignal,
  ): Promise<GuardianCallResult> {
    if (this.disposePromise !== undefined) throw new Error('subprocess-guardian: guardian runtime is disposing')
    switch (operation) {
      case 'resolve-executable':
        return { value: await this.resolveExecutable(body, signal) }
      case 'spawn-prepare':
        return { value: await this.prepareSpawn(body, signal) }
      case 'spawn-resume':
        return this.resumeSpawn(body)
      case 'process-terminate':
        await this.terminateProcess(body)
        return { value: {} }
      case 'process-wait':
        return { value: { exited: await this.waitForProcess(body, signal) } }
      case 'process-release':
        await this.releaseProcess(body)
        return { value: {} }
    }
  }

  private async resolveExecutable(body: unknown, signal: AbortSignal): Promise<{ executable: string }> {
    const value = requireRecord(body, 'resolve-executable body')
    requireExactKeys(value, ['command', 'env'])
    if (typeof value.command !== 'string') throw badRequest('resolve-executable command must be a string')
    const env = parseEnvironment(value.env)
    const executable = await resolveGuardianExecutable(value.command, guardianChildEnv(env), signal)
    return { executable }
  }

  private async prepareSpawn(body: unknown, signal: AbortSignal): Promise<GuardianPreparedSpawn> {
    const request = parseSpawnRequest(body)
    const env = guardianChildEnv(request.env)
    const executable = await resolveGuardianExecutable(request.argv[0] as string, env, signal)
    const nativeSpec: GuardianNativeSpawnSpec = {
      argv: [executable, ...request.argv.slice(1)],
      cwd: request.cwd,
      stdio: request.stdio,
      graceMs: request.graceMs,
      env,
    }
    const prepared = await this.supervisor.prepare(nativeSpec, signal)
    try {
      validatePreparedIo(prepared, request.stdio)
      const processId = GuardianProcessId(randomUUID())
      const stdinStreamId = request.stdio.stdin === 'pipe' ? GuardianStreamId(randomUUID()) : undefined
      const stdoutStreamId = request.stdio.stdout === 'inherit' ? undefined : GuardianStreamId(randomUUID())
      const stderrStreamId = request.stdio.stderr === 'inherit' ? undefined : GuardianStreamId(randomUUID())
      const inputComplete = stdinStreamId === undefined
        ? undefined
        : this.peer.acceptStream(stdinStreamId, writableSink(prepared.stdin as Writable))
      const entry: PreparedEntry = {
        processId,
        prepared,
        spec: request,
        stdinStreamId,
        stdoutWriter: stdoutStreamId === undefined ? undefined : this.peer.createWriter(stdoutStreamId),
        stderrWriter: stderrStreamId === undefined ? undefined : this.peer.createWriter(stderrStreamId),
        inputComplete,
      }
      this.prepared.set(processId, entry)
      return {
        processId,
        pid: prepared.pid,
        ...stdinStreamId === undefined ? {} : { stdinStreamId },
        ...stdoutStreamId === undefined ? {} : { stdoutStreamId },
        ...stderrStreamId === undefined ? {} : { stderrStreamId },
      }
    } catch (error) {
      await prepared.rollback()
      throw error
    }
  }

  private async resumeSpawn(body: unknown): Promise<GuardianCallResult> {
    const processId = parseProcessBody(body)
    const entry = this.prepared.get(processId)
    if (entry === undefined) throw badRequest('spawn-resume named no prepared process')
    let owned: GuardianOwnedProcess
    try {
      owned = await entry.prepared.resume()
    } catch (error) {
      this.prepared.delete(processId)
      throw error
    }
    this.prepared.delete(processId)
    const live: LiveEntry = {
      processId,
      owned,
      pumps: new Set(),
      cancelIo: (error) => {
        entry.prepared.stdin?.destroy()
        entry.prepared.stdout?.destroy()
        entry.prepared.stderr?.destroy()
        void entry.stdoutWriter?.cancel(error).catch(() => undefined)
        void entry.stderrWriter?.cancel(error).catch(() => undefined)
      },
      settlement: undefined,
      released: false,
    }
    this.live.set(processId, live)
    return {
      value: {},
      afterReply: () => { this.activate(entry, live) },
    }
  }

  private activate(prepared: PreparedEntry, live: LiveEntry): void {
    if (prepared.stdoutWriter !== undefined) {
      this.trackPump(live, pumpReadable(prepared.prepared.stdout as Readable, prepared.stdoutWriter))
    }
    if (prepared.stderrWriter !== undefined) {
      this.trackPump(live, pumpReadable(prepared.prepared.stderr as Readable, prepared.stderrWriter))
    }
    if (typeof prepared.spec.stdio.stdin === 'object') {
      const input = writeBatchInput(prepared.prepared.stdin as Writable, prepared.spec.stdio.stdin.data)
      void input.catch(() => undefined)
    } else if (prepared.spec.stdio.stdin === 'pipe' && prepared.inputComplete !== undefined) {
      void prepared.inputComplete.catch(() => undefined)
    }
    live.settlement = this.settle(live)
  }

  private trackPump(live: LiveEntry, promise: Promise<void>): void {
    live.pumps.add(promise)
    void promise.finally(() => { live.pumps.delete(promise) }).catch(() => undefined)
  }

  private async settle(entry: LiveEntry): Promise<void> {
    let failure: unknown
    let outcome: SubprocessOutcome | undefined
    try {
      outcome = await entry.owned.done
      const pumps = await Promise.allSettled([...entry.pumps])
      failure = pumps.find(value => value.status === 'rejected')?.reason
    } catch (error) {
      failure = error
    }
    if (failure !== undefined) {
      await entry.owned.terminate().catch(() => undefined)
      await entry.owned.waitForExit().catch(() => false)
      if (this.disposePromise === undefined) {
        await this.peer.sendProcessSettled(entry.processId, {
          ok: false,
          error: { code: 'internal', message: asError(failure).message.slice(0, 4096) || 'guardian stream failed' },
        }).catch(() => undefined)
      }
      return
    }
    if (outcome === undefined) throw new Error('subprocess-guardian: process settled without an outcome')
    if (this.disposePromise === undefined) {
      await this.peer.sendProcessSettled(entry.processId, { ok: true, outcome }).catch(() => undefined)
    }
  }

  private async terminateProcess(body: unknown): Promise<void> {
    const processId = parseProcessBody(body)
    const prepared = this.prepared.get(processId)
    if (prepared !== undefined) {
      this.prepared.delete(processId)
      await prepared.prepared.rollback()
      return
    }
    const live = this.live.get(processId)
    if (live === undefined) throw badRequest('process-terminate named no owned process')
    await live.owned.terminate()
  }

  private async waitForProcess(body: unknown, signal: AbortSignal): Promise<boolean> {
    const processId = parseProcessBody(body)
    const live = this.live.get(processId)
    if (live === undefined) throw badRequest('process-wait named no resumed process')
    return live.owned.waitForExit(signal)
  }

  private async releaseProcess(body: unknown): Promise<void> {
    const processId = parseProcessBody(body)
    const live = this.live.get(processId)
    if (live === undefined) return
    if (!await live.owned.waitForExit()) throw badRequest('process-release requires whole-tree exit')
    await live.settlement
    if (!live.released) {
      live.released = true
      await live.owned.release()
    }
    this.live.delete(processId)
  }

  private async disposeOnce(): Promise<void> {
    this.removeHandler()
    this.removeClose()
    const prepared = [...this.prepared.values()]
    const live = [...this.live.values()]
    this.prepared.clear()
    await Promise.allSettled(prepared.map(entry => entry.prepared.rollback()))
    await Promise.allSettled(live.map(entry => entry.owned.terminate()))
    await Promise.allSettled(live.map(entry => entry.owned.waitForExit()))
    for (const entry of live) entry.cancelIo(new Error('subprocess-guardian: guardian runtime disposed'))
    await Promise.allSettled(live.map(async (entry) => {
      await entry.settlement
      if (!entry.released) await entry.owned.release()
    }))
    this.live.clear()
    await this.supervisor.dispose()
    await this.peer.dispose()
  }
}

function pumpReadable(source: Readable, writer: GuardianByteWriter): Promise<void> {
  return (async () => {
    try {
      for await (const chunk of source) await writer.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
      await writer.end()
    } catch (error) {
      source.destroy()
      await writer.cancel(asError(error))
      throw error
    }
  })()
}

function writableSink(target: Writable): GuardianByteSink {
  return {
    write: chunk => writeWritable(target, chunk),
    end: () => endWritable(target),
    fail: () => { target.destroy() },
  }
}

function writeBatchInput(target: Writable, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { reject(error) }
    target.once('error', onError)
    target.end(data, () => {
      target.off('error', onError)
      resolve()
    })
  })
}

function writeWritable(target: Writable, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { reject(error) }
    target.once('error', onError)
    target.write(data, () => {
      target.off('error', onError)
      resolve()
    })
  })
}

function endWritable(target: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { reject(error) }
    target.once('error', onError)
    target.end(() => {
      target.off('error', onError)
      resolve()
    })
  })
}

function validatePreparedIo(prepared: GuardianPreparedProcess, stdio: SubprocessStdio): void {
  if (stdio.stdin !== 'ignore' && prepared.stdin === undefined) throw new Error('subprocess-guardian: native supervisor omitted requested stdin')
  if (stdio.stdout !== 'inherit' && prepared.stdout === undefined) throw new Error('subprocess-guardian: native supervisor omitted requested stdout')
  if (stdio.stderr !== 'inherit' && prepared.stderr === undefined) throw new Error('subprocess-guardian: native supervisor omitted requested stderr')
}

function parseSpawnRequest(value: unknown): GuardianSpawnRequest {
  const body = requireRecord(value, 'spawn-prepare body')
  requireExactKeys(body, ['argv', 'cwd', 'stdio', 'graceMs', 'env'])
  if (!Array.isArray(body.argv) || body.argv.length === 0 || body.argv.some(item => typeof item !== 'string')
    || (body.argv[0] as string).length === 0) throw badRequest('spawn argv must start with a non-empty program')
  if (typeof body.cwd !== 'string' || body.cwd.length === 0) throw badRequest('spawn cwd must be a non-empty string')
  if (!Number.isSafeInteger(body.graceMs) || (body.graceMs as number) <= 0 || (body.graceMs as number) > MAX_TIMER_DELAY_MS) {
    throw badRequest(`spawn graceMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const stdioBody = requireRecord(body.stdio, 'spawn stdio')
  requireExactKeys(stdioBody, ['stdin', 'stdout', 'stderr'])
  const stdin = parseStdin(stdioBody.stdin)
  const stdout = parseOutput(stdioBody.stdout)
  const stderr = parseOutput(stdioBody.stderr)
  const env = parseEnvironment(body.env)
  return {
    argv: body.argv as string[],
    cwd: body.cwd,
    stdio: { stdin, stdout, stderr },
    graceMs: body.graceMs as number,
    ...env === undefined ? {} : { env },
  }
}

function parseStdin(value: unknown): SubprocessStdinMode {
  if (value === 'ignore' || value === 'pipe') return value
  const object = requireRecord(value, 'stdin disposition')
  requireExactKeys(object, ['data'])
  if (typeof object.data !== 'string') throw badRequest('stdin data must be a string')
  return { data: object.data }
}

function parseOutput(value: unknown): SubprocessOutputMode {
  if (value === 'pipe' || value === 'inherit') return value
  const object = requireRecord(value, 'output disposition')
  requireExactKeys(object, ['maxBytes', 'spill'])
  if (!Number.isSafeInteger(object.maxBytes) || (object.maxBytes as number) <= 0) {
    throw badRequest('output maxBytes must be a positive safe integer')
  }
  if (object.spill === undefined) return { maxBytes: object.maxBytes as number }
  const spill = requireRecord(object.spill, 'output spill')
  requireExactKeys(spill, ['maxBytes'])
  if (!Number.isSafeInteger(spill.maxBytes) || (spill.maxBytes as number) <= 0) {
    throw badRequest('spill maxBytes must be a positive safe integer')
  }
  return { maxBytes: object.maxBytes as number, spill: { maxBytes: spill.maxBytes as number } }
}

function parseEnvironment(value: unknown): Record<string, string | null> | undefined {
  if (value === undefined) return undefined
  const object = requireRecord(value, 'environment')
  const result: Record<string, string | null> = {}
  for (const [key, entry] of Object.entries(object)) {
    if (key.length === 0 || !(typeof entry === 'string' || entry === null)) {
      throw badRequest('environment entries must have non-empty keys and string or null values')
    }
    result[key] = entry
  }
  return result
}

function parseProcessBody(value: unknown): GuardianProcessIdType {
  const body = requireRecord(value, 'process operation body')
  requireExactKeys(body, ['processId'])
  if (typeof body.processId !== 'string' || body.processId.length === 0 || body.processId.length > 128) {
    throw badRequest('processId must be a non-empty bounded string')
  }
  return GuardianProcessId(body.processId)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest(`${label} must be an object`)
  return value as Record<string, unknown>
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allow = new Set(allowed)
  if (Object.keys(value).some(key => !allow.has(key))) throw badRequest('guardian request contains an unknown field')
}

function badRequest(message: string): GuardianProtocolError {
  return new GuardianProtocolError(`subprocess-guardian: ${message}`)
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
