/** Privileged lifecycle messages exchanged directly between Electron main and the guardian. */

import { randomUUID } from 'node:crypto'

/** Namespace reserved for guardian ownership control and never forwarded to the sidecar. */
export const DESKTOP_GUARDIAN_CONTROL_NAMESPACE = 'dsh.guardian.mirror'
/** Current guardian ownership-control protocol version. */
export const DESKTOP_GUARDIAN_CONTROL_VERSION = 1

/** Guardian-to-main ownership record, release, and sidecar-lifecycle messages. */
export type DesktopGuardianControlOutboundFrame =
  | {
    readonly namespace: typeof DESKTOP_GUARDIAN_CONTROL_NAMESPACE
    readonly version: typeof DESKTOP_GUARDIAN_CONTROL_VERSION
    readonly type: 'sidecar-started' | 'sidecar-joined'
    readonly sidecarPid: number
  }
  | {
    readonly namespace: typeof DESKTOP_GUARDIAN_CONTROL_NAMESPACE
    readonly version: typeof DESKTOP_GUARDIAN_CONTROL_VERSION
    readonly type: 'register'
    readonly requestId: string
    readonly capsuleId: string
    readonly pid: number
    readonly processGroupId: number
  }
  | {
    readonly namespace: typeof DESKTOP_GUARDIAN_CONTROL_NAMESPACE
    readonly version: typeof DESKTOP_GUARDIAN_CONTROL_VERSION
    readonly type: 'release'
    readonly requestId: string
    readonly capsuleId: string
  }
  | {
    readonly namespace: typeof DESKTOP_GUARDIAN_CONTROL_NAMESPACE
    readonly version: typeof DESKTOP_GUARDIAN_CONTROL_VERSION
    readonly type: 'recover'
    readonly requestId: string
    readonly capsuleId: string
    readonly reason: string
  }

/** Main-to-guardian acknowledgements for macOS ownership records. */
export type DesktopGuardianControlInboundFrame =
  | {
    readonly namespace: typeof DESKTOP_GUARDIAN_CONTROL_NAMESPACE
    readonly version: typeof DESKTOP_GUARDIAN_CONTROL_VERSION
    readonly type: 'registered'
    readonly requestId: string
    readonly receipt: string
  }
  | {
    readonly namespace: typeof DESKTOP_GUARDIAN_CONTROL_NAMESPACE
    readonly version: typeof DESKTOP_GUARDIAN_CONTROL_VERSION
    readonly type: 'released' | 'recovered'
    readonly requestId: string
  }
  | {
    readonly namespace: typeof DESKTOP_GUARDIAN_CONTROL_NAMESPACE
    readonly version: typeof DESKTOP_GUARDIAN_CONTROL_VERSION
    readonly type: 'failed'
    readonly requestId: string
    readonly message: string
  }

const IDENTIFIER_BYTES = 128
const RECEIPT_BYTES = 512
const FAILURE_BYTES = 4096

/**
 * Identify the reserved guardian-control namespace before protocol-specific parsing.
 * @param value - untrusted child-IPC value.
 * @returns whether the value claims the privileged guardian-control namespace.
 */
export function isDesktopGuardianControlEnvelope(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.namespace === DESKTOP_GUARDIAN_CONTROL_NAMESPACE
}

/**
 * Parse one guardian-to-main control frame and reject malformed matching-namespace input.
 * @param value - untrusted guardian child-IPC value.
 * @returns a validated control frame, or undefined for another namespace.
 */
export function parseDesktopGuardianControlOutboundFrame(
  value: unknown,
): DesktopGuardianControlOutboundFrame | undefined {
  if (!isDesktopGuardianControlEnvelope(value)) return undefined
  const frame = requireHeader(value)
  switch (frame.type) {
    case 'sidecar-started':
    case 'sidecar-joined':
      requireExactKeys(frame, ['namespace', 'version', 'type', 'sidecarPid'])
      requirePositivePid(frame.sidecarPid, 'sidecarPid')
      return frame as DesktopGuardianControlOutboundFrame
    case 'register':
      requireExactKeys(frame, [
        'namespace', 'version', 'type', 'requestId', 'capsuleId', 'pid', 'processGroupId',
      ])
      requireIdentifier(frame.requestId, 'requestId')
      requireIdentifier(frame.capsuleId, 'capsuleId')
      requirePositivePid(frame.pid, 'pid')
      requirePositivePid(frame.processGroupId, 'processGroupId')
      return frame as DesktopGuardianControlOutboundFrame
    case 'release':
      requireExactKeys(frame, ['namespace', 'version', 'type', 'requestId', 'capsuleId'])
      requireIdentifier(frame.requestId, 'requestId')
      requireIdentifier(frame.capsuleId, 'capsuleId')
      return frame as DesktopGuardianControlOutboundFrame
    case 'recover':
      requireExactKeys(frame, ['namespace', 'version', 'type', 'requestId', 'capsuleId', 'reason'])
      requireIdentifier(frame.requestId, 'requestId')
      requireIdentifier(frame.capsuleId, 'capsuleId')
      requireBoundedString(frame.reason, FAILURE_BYTES, 'reason')
      return frame as DesktopGuardianControlOutboundFrame
    default:
      throw new Error('desktop guardian control: unknown guardian frame type')
  }
}

/**
 * Parse one main-to-guardian control frame and reject malformed matching-namespace input.
 * @param value - untrusted Electron-main child-IPC value.
 * @returns a validated control frame, or undefined for another namespace.
 */
export function parseDesktopGuardianControlInboundFrame(
  value: unknown,
): DesktopGuardianControlInboundFrame | undefined {
  if (!isDesktopGuardianControlEnvelope(value)) return undefined
  const frame = requireHeader(value)
  switch (frame.type) {
    case 'registered':
      requireExactKeys(frame, ['namespace', 'version', 'type', 'requestId', 'receipt'])
      requireIdentifier(frame.requestId, 'requestId')
      requireBoundedString(frame.receipt, RECEIPT_BYTES, 'receipt')
      return frame as DesktopGuardianControlInboundFrame
    case 'released':
    case 'recovered':
      requireExactKeys(frame, ['namespace', 'version', 'type', 'requestId'])
      requireIdentifier(frame.requestId, 'requestId')
      return frame as DesktopGuardianControlInboundFrame
    case 'failed':
      requireExactKeys(frame, ['namespace', 'version', 'type', 'requestId', 'message'])
      requireIdentifier(frame.requestId, 'requestId')
      requireBoundedString(frame.message, FAILURE_BYTES, 'message')
      return frame as DesktopGuardianControlInboundFrame
    default:
      throw new Error('desktop guardian control: unknown main frame type')
  }
}

function requireHeader(value: Record<string, unknown>): Record<string, unknown> & { type: string } {
  if (value.version !== DESKTOP_GUARDIAN_CONTROL_VERSION || typeof value.type !== 'string') {
    throw new Error('desktop guardian control: malformed protocol header')
  }
  return value as Record<string, unknown> & { type: string }
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed)
  if (Object.keys(value).some(key => !keys.has(key))) {
    throw new Error('desktop guardian control: frame contains an unknown field')
  }
}

function requireIdentifier(value: unknown, label: string): asserts value is string {
  requireBoundedString(value, IDENTIFIER_BYTES, label)
}

function requireBoundedString(value: unknown, maximumBytes: number, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximumBytes) {
    throw new Error(`desktop guardian control: ${label} must be a non-empty bounded string`)
  }
}

function requirePositivePid(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`desktop guardian control: ${label} must be a positive pid`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Child-process face retained by Electron main for guardian ownership control. */
export interface DesktopGuardianControlChild {
  /** Whether Node still considers the child IPC channel connected. */
  readonly connected?: boolean
  /** Send one ownership acknowledgement over JSON child IPC. */
  send(message: DesktopGuardianControlInboundFrame, callback: (error: Error | null) => void): boolean
  /** Subscribe to an untrusted guardian IPC message. */
  on(event: 'message', listener: (value: unknown) => void): unknown
  /** Subscribe to guardian process exit. */
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  /** Subscribe to guardian spawn or process errors. */
  on(event: 'error', listener: (error: Error) => void): unknown
  /** Subscribe to guardian IPC loss. */
  on(event: 'disconnect', listener: () => void): unknown
  /** Remove a guardian message listener. */
  off(event: 'message', listener: (value: unknown) => void): unknown
  /** Remove a guardian exit listener. */
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  /** Remove a guardian error listener. */
  off(event: 'error', listener: (error: Error) => void): unknown
  /** Remove a guardian disconnect listener. */
  off(event: 'disconnect', listener: () => void): unknown
}

/** Injectable operating-system process operations used by main-owned recovery. */
export interface DesktopGuardianProcessControl {
  /** Whether one recorded PID still names a process. */
  processExists(pid: number): boolean
  /** Whether one recorded POSIX process group still contains a process. */
  processGroupExists(processGroupId: number): boolean
  /** Deliver a termination signal to one recorded process. */
  signalProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
  /** Deliver a termination signal to one recorded POSIX process group. */
  signalProcessGroup(processGroupId: number, signal: 'SIGTERM' | 'SIGKILL'): void
  /** Wait without keeping an otherwise quiescent main process alive. */
  delay(milliseconds: number): Promise<void>
}

/** Signed lifecycle bounds and platform facts for Electron-main ownership. */
export interface DesktopGuardianMainOwnerOptions {
  /** Grace period after TERM before forced termination. */
  readonly gracefulShutdownMs: number
  /** Maximum disappearance wait after KILL. */
  readonly forceShutdownMs: number
  /** Maximum interval between PID or PGID liveness probes. */
  readonly nativeProcessPollMs: number
  /** Platform selecting whether process-group registration is admissible. */
  readonly platform?: NodeJS.Platform | undefined
  /** Test or platform adapter; production uses Node process signals and probes. */
  readonly processControl?: DesktopGuardianProcessControl | undefined
}

interface MainOwnershipRecord {
  readonly capsuleId: string
  readonly pid: number
  readonly processGroupId: number
  readonly receipt: string
}

/**
 * Electron-main second owner for sidecar and macOS process-group records.
 * Matching control frames are serialized, and guardian loss triggers bounded TERM/KILL disappearance checks.
 */
export class DesktopGuardianMainOwner {
  /** Resolves with the first unexpected guardian, runtime, protocol, or cleanup failure. */
  readonly failure: Promise<Error>

  private readonly failureState = Promise.withResolvers<Error>()
  private readonly failureListeners = new Set<(error: Error) => void>()
  private readonly records = new Map<string, MainOwnershipRecord>()
  private readonly platform: NodeJS.Platform
  private readonly processControl: DesktopGuardianProcessControl
  private controlWork = Promise.resolve()
  private terminationWork: Promise<void> | undefined
  private disposeWork: Promise<void> | undefined
  private sidecarPid: number | undefined
  private expectedShutdown = false
  private terminalError: Error | undefined
  private listenersRemoved = false

  /**
   * @param child - connected guardian child retained by Electron main.
   * @param options - signed shutdown and liveness-probe bounds.
   */
  constructor(
    private readonly child: DesktopGuardianControlChild,
    private readonly options: DesktopGuardianMainOwnerOptions,
  ) {
    requirePositiveBound(options.gracefulShutdownMs, 'gracefulShutdownMs')
    requirePositiveBound(options.forceShutdownMs, 'forceShutdownMs')
    requirePositiveBound(options.nativeProcessPollMs, 'nativeProcessPollMs')
    this.platform = options.platform ?? process.platform
    this.processControl = options.processControl ?? nodeProcessControl
    this.failure = this.failureState.promise
    child.on('message', this.onMessage)
    child.on('exit', this.onExit)
    child.on('error', this.onError)
    child.on('disconnect', this.onDisconnect)
  }

  /**
   * Register a listener for failures that should abort startup or a running desktop Host.
   * @param listener - callback invoked once with the terminal ownership failure.
   * @returns disposer removing the listener.
   */
  onFailure(listener: (error: Error) => void): () => void {
    if (this.terminalError !== undefined) {
      listener(this.terminalError)
      return () => {}
    }
    this.failureListeners.add(listener)
    return () => { this.failureListeners.delete(listener) }
  }

  /** Mark guardian exit/disconnect as expected while retaining every listener until it occurs. */
  prepareShutdown(): void {
    this.expectedShutdown = true
  }

  /**
   * Remove listeners and recover every ownership record still retained by main.
   * @returns after sidecar PID and process-group disappearance are confirmed.
   */
  dispose(): Promise<void> {
    this.prepareShutdown()
    this.disposeWork ??= this.disposeOnce()
    return this.disposeWork
  }

  private readonly onMessage = (value: unknown): void => {
    let frame: DesktopGuardianControlOutboundFrame | undefined
    try {
      frame = parseDesktopGuardianControlOutboundFrame(value)
    } catch (error) {
      this.noteFailure(asError(error))
      return
    }
    if (frame === undefined) {
      if (!this.expectedShutdown && isRuntimeFailure(value)) {
        this.noteFailure(new Error(`desktop runtime failed: ${value.message}`))
      }
      return
    }
    this.controlWork = this.controlWork.then(() => this.dispatch(frame)).catch((error: unknown) => {
      this.noteFailure(asError(error))
    })
  }

  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.guardianTerminated(new Error(
      `desktop guardian exited (code ${String(code)}, signal ${String(signal)})`,
    ))
  }

  private readonly onError = (error: Error): void => {
    this.guardianTerminated(new Error('desktop guardian process error', { cause: error }))
  }

  private readonly onDisconnect = (): void => {
    this.guardianTerminated(new Error('desktop guardian IPC disconnected'))
  }

  private async dispatch(frame: DesktopGuardianControlOutboundFrame): Promise<void> {
    switch (frame.type) {
      case 'sidecar-started':
        if (this.sidecarPid !== undefined) throw new Error('desktop guardian control: duplicate sidecar ownership')
        this.sidecarPid = frame.sidecarPid
        return
      case 'sidecar-joined':
        if (this.sidecarPid !== frame.sidecarPid) throw new Error('desktop guardian control: sidecar join did not match ownership')
        this.sidecarPid = undefined
        return
      case 'register':
        await this.register(frame)
        return
      case 'release':
        await this.release(frame)
        return
      case 'recover':
        await this.recover(frame)
        return
    }
  }

  private async register(frame: Extract<DesktopGuardianControlOutboundFrame, { type: 'register' }>): Promise<void> {
    if (this.platform !== 'darwin') {
      await this.sendFailure(frame.requestId, 'process-group ownership is available only on macOS')
      return
    }
    if (this.records.has(frame.capsuleId)
      || [...this.records.values()].some(value => value.processGroupId === frame.processGroupId)) {
      await this.sendFailure(frame.requestId, 'duplicate capsule or process-group ownership')
      return
    }
    const receipt = randomUUID()
    this.records.set(frame.capsuleId, {
      capsuleId: frame.capsuleId,
      pid: frame.pid,
      processGroupId: frame.processGroupId,
      receipt,
    })
    await this.send({
      namespace: DESKTOP_GUARDIAN_CONTROL_NAMESPACE,
      version: DESKTOP_GUARDIAN_CONTROL_VERSION,
      type: 'registered',
      requestId: frame.requestId,
      receipt,
    })
  }

  private async release(frame: Extract<DesktopGuardianControlOutboundFrame, { type: 'release' }>): Promise<void> {
    const record = this.records.get(frame.capsuleId)
    if (record !== undefined && this.processControl.processGroupExists(record.processGroupId)) {
      await this.sendFailure(frame.requestId, 'process group is still active')
      return
    }
    this.records.delete(frame.capsuleId)
    await this.send({
      namespace: DESKTOP_GUARDIAN_CONTROL_NAMESPACE,
      version: DESKTOP_GUARDIAN_CONTROL_VERSION,
      type: 'released',
      requestId: frame.requestId,
    })
  }

  private async recover(frame: Extract<DesktopGuardianControlOutboundFrame, { type: 'recover' }>): Promise<void> {
    const record = this.records.get(frame.capsuleId)
    try {
      if (record !== undefined) await this.terminateProcessGroup(record.processGroupId)
      this.records.delete(frame.capsuleId)
      await this.send({
        namespace: DESKTOP_GUARDIAN_CONTROL_NAMESPACE,
        version: DESKTOP_GUARDIAN_CONTROL_VERSION,
        type: 'recovered',
        requestId: frame.requestId,
      })
    } catch (error) {
      await this.sendFailure(frame.requestId, asError(error).message).catch(() => undefined)
      throw new Error(`desktop guardian control: process-group recovery failed: ${frame.reason}`, {
        cause: error,
      })
    }
  }

  private guardianTerminated(error: Error): void {
    if (this.terminationWork !== undefined) return
    this.removeListeners()
    if (!this.expectedShutdown) this.publishFailure(error)
    this.terminationWork = this.cleanupOwned().catch((cleanupError: unknown) => {
      this.publishFailure(new AggregateError(
        [error, cleanupError],
        'desktop guardian termination cleanup failed',
      ))
    })
  }

  private noteFailure(error: Error): void {
    this.publishFailure(error)
    this.removeListeners()
    if (this.terminationWork === undefined) {
      this.terminationWork = this.cleanupOwned().catch((cleanupError: unknown) => {
        this.publishFailure(new AggregateError([error, cleanupError], 'desktop guardian ownership cleanup failed'))
      })
    }
  }

  private publishFailure(error: Error): void {
    if (this.terminalError !== undefined) return
    this.terminalError = error
    this.failureState.resolve(error)
    for (const listener of this.failureListeners) {
      try {
        listener(error)
      } catch {
        // One application observer cannot prevent other owners from seeing terminal failure.
      }
    }
    this.failureListeners.clear()
  }

  private async disposeOnce(): Promise<void> {
    this.removeListeners()
    if (this.terminationWork !== undefined) await this.terminationWork
    else await this.cleanupOwned()
    await this.controlWork
  }

  private async cleanupOwned(): Promise<void> {
    await this.controlWork
    const sidecarPid = this.sidecarPid
    const records = [...this.records.values()]
    const cleanup = await Promise.allSettled([
      ...(sidecarPid === undefined ? [] : [this.terminateProcess(sidecarPid)]),
      ...records.map(record => this.terminateProcessGroup(record.processGroupId)),
    ])
    if (sidecarPid !== undefined && cleanup[0]?.status === 'fulfilled') this.sidecarPid = undefined
    const recordOffset = sidecarPid === undefined ? 0 : 1
    records.forEach((record, index) => {
      if (cleanup[recordOffset + index]?.status === 'fulfilled') this.records.delete(record.capsuleId)
    })
    const failures = cleanup.flatMap(value => value.status === 'rejected' ? [asError(value.reason)] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'desktop guardian control: owned process cleanup failed')
  }

  private async terminateProcess(pid: number): Promise<void> {
    if (!this.processControl.processExists(pid)) return
    this.processControl.signalProcess(pid, 'SIGTERM')
    if (await this.waitForGone(() => this.processControl.processExists(pid), this.options.gracefulShutdownMs)) return
    this.processControl.signalProcess(pid, 'SIGKILL')
    if (!await this.waitForGone(() => this.processControl.processExists(pid), this.options.forceShutdownMs)) {
      throw new Error(`desktop guardian control: sidecar pid ${String(pid)} survived SIGKILL`)
    }
  }

  private async terminateProcessGroup(processGroupId: number): Promise<void> {
    if (!this.processControl.processGroupExists(processGroupId)) return
    this.processControl.signalProcessGroup(processGroupId, 'SIGTERM')
    if (await this.waitForGone(
      () => this.processControl.processGroupExists(processGroupId),
      this.options.gracefulShutdownMs,
    )) return
    this.processControl.signalProcessGroup(processGroupId, 'SIGKILL')
    if (!await this.waitForGone(
      () => this.processControl.processGroupExists(processGroupId),
      this.options.forceShutdownMs,
    )) {
      throw new Error(`desktop guardian control: process group ${String(processGroupId)} survived SIGKILL`)
    }
  }

  private async waitForGone(exists: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (exists()) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      await this.processControl.delay(Math.min(remaining, this.options.nativeProcessPollMs))
    }
    return true
  }

  private sendFailure(requestId: string, message: string): Promise<void> {
    return this.send({
      namespace: DESKTOP_GUARDIAN_CONTROL_NAMESPACE,
      version: DESKTOP_GUARDIAN_CONTROL_VERSION,
      type: 'failed',
      requestId,
      message: message.slice(0, FAILURE_BYTES) || 'guardian ownership operation failed',
    })
  }

  private send(frame: DesktopGuardianControlInboundFrame): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.child.connected === false) {
        reject(new Error('desktop guardian control: guardian IPC disconnected'))
        return
      }
      try {
        this.child.send(frame, (error) => {
          if (error === null) resolve()
          else reject(error)
        })
      } catch (error) {
        reject(asError(error))
      }
    })
  }

  private removeListeners(): void {
    if (this.listenersRemoved) return
    this.listenersRemoved = true
    this.child.off('message', this.onMessage)
    this.child.off('exit', this.onExit)
    this.child.off('error', this.onError)
    this.child.off('disconnect', this.onDisconnect)
  }
}

const nodeProcessControl: DesktopGuardianProcessControl = {
  processExists: pid => signalTargetExists(pid),
  processGroupExists: processGroupId => signalTargetExists(-processGroupId),
  signalProcess: (pid, signal) => { signalTarget(pid, signal) },
  signalProcessGroup: (processGroupId, signal) => { signalTarget(-processGroupId, signal) },
  delay: milliseconds => new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref()
  }),
}

function signalTarget(target: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(target, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

function signalTargetExists(target: number): boolean {
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

function requirePositiveBound(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`desktop guardian control: ${label} must be a positive safe integer`)
  }
}

function isRuntimeFailure(value: unknown): value is { readonly message: string } {
  return isRecord(value)
    && value.version === 1
    && value.type === 'desktop-runtime-failed'
    && typeof value.message === 'string'
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
