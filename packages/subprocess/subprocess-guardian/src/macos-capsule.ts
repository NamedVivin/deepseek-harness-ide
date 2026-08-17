/** Transport to the fixed native macOS process-capsule helper. */

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import type {
  GuardianNativeSpawnSpec,
  MacOsCapsuleNativeTransport,
  MacOsCapsulePreparation,
  MacOsCapsuleProcess,
} from './supervisor.ts'

const CAPSULE_MAGIC = 0x44534843
const CAPSULE_VERSION = 1
const SPEC_TYPE = 1
const COMMAND_CONFIRM = 2
const COMMAND_RESUME = 3
const COMMAND_TERMINATE = 4
const COMMAND_RELEASE = 5
const EVENT_PREPARED = 101
const EVENT_CONFIRMED = 102
const EVENT_RESUMED = 103
const EVENT_EXIT = 104
const EVENT_GROUP_ZERO = 105
const EVENT_RELEASED = 106
const EVENT_ERROR = 255
const SPEC_HEADER_BYTES = 32
const EVENT_BYTES = 32

interface CapsuleEvent {
  readonly type: number
  readonly status: number
  readonly pid: number
  readonly processGroupId: number
  readonly exitCode: number
  readonly signal: number
}

/** Native helper launch settings supplied by the signed desktop assembly. */
export interface MacOsProcessCapsuleOptions {
  /** Absolute signed helper path outside ASAR. */
  readonly helperPath: string
  /** Guardian-inherited read descriptor whose writer is owned only by Electron main. */
  readonly mainLivenessFd: number
  /** Maximum encoded target specification accepted by both transport and helper. */
  readonly maxSpecBytes: number
  /** Maximum delay for native liveness and process-group-empty checks. */
  readonly groupPollMs: number
}

/** Native macOS helper transport; no JavaScript process-group fallback exists. */
export class MacOsProcessCapsuleTransport implements MacOsCapsuleNativeTransport {
  private readonly connections = new Set<CapsuleConnection>()
  private disposing = false

  /** @param options - signed helper and inherited liveness descriptor. */
  constructor(private readonly options: MacOsProcessCapsuleOptions) {
    if (!Number.isSafeInteger(options.mainLivenessFd) || options.mainLivenessFd < 3) {
      throw new Error('subprocess-guardian: mainLivenessFd must be an inherited descriptor')
    }
    if (!Number.isSafeInteger(options.maxSpecBytes) || options.maxSpecBytes < SPEC_HEADER_BYTES) {
      throw new Error('subprocess-guardian: maxSpecBytes must fit the capsule header')
    }
    if (!Number.isSafeInteger(options.groupPollMs) || options.groupPollMs <= 0) {
      throw new Error('subprocess-guardian: groupPollMs must be a positive safe integer')
    }
  }

  /** Verify the fixed helper before the first process request. */
  async init(): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error(`subprocess-guardian: process capsule requires macOS, got ${process.platform}`)
    }
    if (!this.options.helperPath.startsWith('/')) {
      throw new Error('subprocess-guardian: process capsule helper path must be absolute')
    }
    await access(this.options.helperPath)
  }

  /** @inheritdoc */
  async prepare(spec: GuardianNativeSpawnSpec, signal: AbortSignal): Promise<MacOsCapsulePreparation> {
    if (this.disposing) throw new Error('subprocess-guardian: macOS capsule transport is disposing')
    signal.throwIfAborted()
    const connection = CapsuleConnection.launch(this.options, spec, () => { this.connections.delete(connection) })
    this.connections.add(connection)
    try {
      await connection.prepared(signal)
      return connection
    } catch (error) {
      await connection.rollback().catch(() => undefined)
      throw error
    }
  }

  /** @inheritdoc */
  async dispose(): Promise<void> {
    if (this.disposing) return
    this.disposing = true
    const results = await Promise.allSettled([...this.connections].map(connection => connection.rollback()))
    const failures: unknown[] = []
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason as unknown)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'subprocess-guardian: capsule cleanup failed')
  }
}

class CapsuleConnection implements MacOsCapsulePreparation, MacOsCapsuleProcess {
  readonly capsuleId: string
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly done: Promise<SubprocessOutcome>
  pid = 0
  processGroupId = 0

  private readonly outcome = Promise.withResolvers<SubprocessOutcome>()
  private readonly groupZero = Promise.withResolvers<void>()
  private readonly released = Promise.withResolvers<void>()
  private readonly pending = new Map<number, Set<PromiseWithResolvers<CapsuleEvent>>>()
  private readonly control: Writable
  private buffer = Buffer.alloc(0)
  private state: 'preparing' | 'prepared' | 'confirmed' | 'resumed' | 'terminating' | 'released' = 'preparing'
  private rollbackPromise: Promise<void> | undefined

  static launch(
    options: MacOsProcessCapsuleOptions,
    spec: GuardianNativeSpawnSpec,
    onReleased: () => void,
  ): CapsuleConnection {
    const stdio: StdioOptions = [
      'pipe',
      'pipe',
      'inherit',
      'pipe',
      spec.stdio.stdout === 'inherit' ? 'inherit' : 'pipe',
      spec.stdio.stderr === 'inherit' ? 'inherit' : 'pipe',
      options.mainLivenessFd,
    ]
    const child = spawn(options.helperPath, [
      '--main-liveness-fd=6',
      `--max-spec-bytes=${String(options.maxSpecBytes)}`,
      `--poll-ms=${String(options.groupPollMs)}`,
    ], {
      stdio,
      env: {},
      shell: false,
      windowsHide: true,
    })
    const connection = new CapsuleConnection(child, spec, options.maxSpecBytes, onReleased)
    return connection
  }

  private constructor(
    private readonly child: ChildProcess,
    spec: GuardianNativeSpawnSpec,
    maxSpecBytes: number,
    private readonly onReleased: () => void,
  ) {
    this.capsuleId = `capsule:${String(child.pid ?? 0)}`
    const stdio = child.stdio as Array<Readable | Writable | null | undefined>
    this.control = requireWritable(stdio[0], 'capsule control input')
    const events = requireReadable(stdio[1], 'capsule event output')
    const targetStdin = requireWritable(stdio[3], 'target stdin')
    this.stdin = spec.stdio.stdin === 'ignore' ? undefined : targetStdin
    if (spec.stdio.stdin === 'ignore') targetStdin.end()
    this.stdout = spec.stdio.stdout === 'inherit' ? undefined : requireReadable(stdio[4], 'target stdout')
    this.stderr = spec.stdio.stderr === 'inherit' ? undefined : requireReadable(stdio[5], 'target stderr')
    this.done = this.outcome.promise
    void this.done.catch(() => undefined)
    void this.groupZero.promise.catch(() => undefined)
    void this.released.promise.catch(() => undefined)
    events.on('data', (chunk: Buffer) => { this.receive(chunk) })
    child.once('error', (error) => { this.fail(error) })
    child.once('exit', (code, signal) => {
      if (this.state !== 'released') {
        this.fail(new Error(`subprocess-guardian: capsule exited unexpectedly (${String(code)}, ${String(signal)})`))
      }
      this.onReleased()
    })
    this.control.write(encodeSpec(spec, maxSpecBytes), (error) => {
      if (error !== null && error !== undefined) this.fail(error)
    })
  }

  async prepared(signal: AbortSignal): Promise<void> {
    const event = await waitWithSignal(this.waitEvent(EVENT_PREPARED), signal)
    requireSuccessfulEvent(event, 'prepare')
    if (event.pid <= 0 || event.processGroupId <= 0) {
      throw new Error('subprocess-guardian: capsule published invalid target ownership')
    }
    this.pid = event.pid
    this.processGroupId = event.processGroupId
    this.state = 'prepared'
  }

  /** @inheritdoc */
  async confirmOwnership(mainReceipt: string): Promise<void> {
    if (this.state !== 'prepared' || mainReceipt.length === 0) {
      throw new Error('subprocess-guardian: capsule ownership confirmation is not valid')
    }
    await this.command(COMMAND_CONFIRM, EVENT_CONFIRMED)
    this.state = 'confirmed'
  }

  /** @inheritdoc */
  async resume(): Promise<MacOsCapsuleProcess> {
    if (this.state !== 'confirmed') throw new Error('subprocess-guardian: capsule is not confirmed')
    await this.command(COMMAND_RESUME, EVENT_RESUMED)
    this.state = 'resumed'
    return this
  }

  /** @inheritdoc */
  rollback(): Promise<void> {
    this.rollbackPromise ??= this.terminateAndRelease()
    return this.rollbackPromise
  }

  /** @inheritdoc */
  async terminate(): Promise<void> {
    if (this.state === 'released' || this.state === 'terminating') return
    this.state = 'terminating'
    await this.sendCommand(COMMAND_TERMINATE)
  }

  /** @inheritdoc */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    try {
      await waitWithSignal(this.groupZero.promise, signal)
      return true
    } catch (error) {
      if (signal?.aborted === true) return false
      throw error
    }
  }

  /** @inheritdoc */
  async release(): Promise<void> {
    if (this.state === 'released') return
    if (!await this.waitForExit()) throw new Error('subprocess-guardian: capsule group is not empty')
    const event = await this.command(COMMAND_RELEASE, EVENT_RELEASED)
    requireSuccessfulEvent(event, 'release')
    this.state = 'released'
    this.control.end()
    await waitForChildExit(this.child)
    this.released.resolve()
    this.onReleased()
  }

  private async terminateAndRelease(): Promise<void> {
    await this.terminate().catch(() => undefined)
    await this.waitForExit().catch(() => false)
    if (this.state !== 'released') await this.release()
  }

  private async command(command: number, expected: number): Promise<CapsuleEvent> {
    const waiting = this.waitEvent(expected)
    await this.sendCommand(command)
    const event = await waiting
    requireSuccessfulEvent(event, `command ${String(command)}`)
    return event
  }

  private sendCommand(type: number): Promise<void> {
    const frame = Buffer.alloc(8)
    frame.writeUInt32LE(CAPSULE_MAGIC, 0)
    frame.writeUInt16LE(CAPSULE_VERSION, 4)
    frame.writeUInt16LE(type, 6)
    return new Promise((resolve, reject) => {
      this.control.write(frame, (error) => {
        if (error === null || error === undefined) resolve()
        else reject(error)
      })
    })
  }

  private waitEvent(type: number): Promise<CapsuleEvent> {
    const deferred = Promise.withResolvers<CapsuleEvent>()
    void deferred.promise.catch(() => undefined)
    const values = this.pending.get(type) ?? new Set()
    values.add(deferred)
    this.pending.set(type, values)
    return deferred.promise
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= EVENT_BYTES) {
      const bytes = this.buffer.subarray(0, EVENT_BYTES)
      this.buffer = this.buffer.subarray(EVENT_BYTES)
      const event = decodeEvent(bytes)
      if (event.type === EVENT_ERROR) {
        this.fail(new Error(`subprocess-guardian: capsule native error ${String(event.status)}`))
        continue
      }
      if (event.type === EVENT_EXIT) {
        this.outcome.resolve({
          exitCode: event.signal === 0 ? event.exitCode : null,
          signal: event.signal === 0 ? null : signalName(event.signal),
        })
      } else if (event.type === EVENT_GROUP_ZERO) {
        this.groupZero.resolve()
      }
      const waiting = this.pending.get(event.type)
      if (waiting === undefined) continue
      this.pending.delete(event.type)
      for (const deferred of waiting) deferred.resolve(event)
    }
  }

  private fail(error: Error): void {
    this.outcome.reject(error)
    this.groupZero.reject(error)
    this.released.reject(error)
    for (const values of this.pending.values()) for (const deferred of values) deferred.reject(error)
    this.pending.clear()
  }
}

function encodeSpec(spec: GuardianNativeSpawnSpec, maximum: number): Buffer {
  const strings = [spec.cwd, ...spec.argv, ...Object.entries(spec.env).flat()]
  const encoded = strings.map((value) => {
    if (value.includes('\0')) throw new Error('subprocess-guardian: capsule specification contains NUL')
    return Buffer.from(value)
  })
  const total = SPEC_HEADER_BYTES + encoded.reduce((sum, value) => sum + 4 + value.length, 0)
  if (total > maximum) throw new Error(`subprocess-guardian: capsule specification exceeds ${String(maximum)} bytes`)
  const frame = Buffer.allocUnsafe(total)
  frame.writeUInt32LE(CAPSULE_MAGIC, 0)
  frame.writeUInt16LE(CAPSULE_VERSION, 4)
  frame.writeUInt16LE(SPEC_TYPE, 6)
  frame.writeUInt32LE(total, 8)
  frame.writeUInt32LE(spec.argv.length, 12)
  frame.writeUInt32LE(Object.keys(spec.env).length, 16)
  frame.writeUInt32LE(spec.graceMs, 20)
  frame.writeInt32LE(-1, 24)
  frame.writeUInt32LE(0, 28)
  let offset = SPEC_HEADER_BYTES
  for (const value of encoded) {
    frame.writeUInt32LE(value.length, offset)
    value.copy(frame, offset + 4)
    offset += 4 + value.length
  }
  return frame
}

function decodeEvent(value: Buffer): CapsuleEvent {
  if (value.readUInt32LE(0) !== CAPSULE_MAGIC || value.readUInt16LE(4) !== CAPSULE_VERSION) {
    throw new Error('subprocess-guardian: malformed capsule event')
  }
  return {
    type: value.readUInt16LE(6),
    status: value.readInt32LE(8),
    pid: value.readInt32LE(12),
    processGroupId: value.readInt32LE(16),
    exitCode: value.readInt32LE(20),
    signal: value.readInt32LE(24),
  }
}

function requireSuccessfulEvent(event: CapsuleEvent, operation: string): void {
  if (event.status !== 0) throw new Error(`subprocess-guardian: capsule ${operation} failed with ${String(event.status)}`)
}

function requireWritable(value: unknown, label: string): Writable {
  if (typeof value !== 'object' || value === null || !('write' in value)) {
    throw new Error(`subprocess-guardian: helper omitted ${label}`)
  }
  return value as Writable
}

function requireReadable(value: unknown, label: string): Readable {
  if (typeof value !== 'object' || value === null || !('read' in value)) {
    throw new Error(`subprocess-guardian: helper omitted ${label}`)
  }
  return value as Readable
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- preserve the caller's AbortSignal reason.
      reject(signal.reason)
    }
    signal.addEventListener('abort', aborted, { once: true })
    void promise.then(
      (value) => { signal.removeEventListener('abort', aborted); resolve(value) },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted)
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- preserve the source promise's rejection.
        reject(error)
      },
    )
  })
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    child.once('exit', () => { resolve() })
    child.once('error', reject)
  })
}

function signalName(value: number): NodeJS.Signals {
  const entry = Object.entries(osConstants.signals)
    .find(([, number]) => number === value)
  if (entry === undefined) throw new Error(`subprocess-guardian: capsule returned unknown signal ${String(value)}`)
  return entry[0] as NodeJS.Signals
}
