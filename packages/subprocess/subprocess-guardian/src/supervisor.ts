/** Native-supervisor contracts and ownership transactions for macOS process capsules and Windows Job Objects. */

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** Spawn request after guardian-world executable resolution and environment scrubbing. */
export interface GuardianNativeSpawnSpec extends Omit<SubprocessSpawnSpec, 'signal' | 'env'> {
  /** Guardian-world environment after the ambient scrub and explicit tombstones. */
  readonly env: Readonly<Record<string, string>>
}

/** Suspended process prepared by a native ownership backend. */
export interface GuardianPreparedProcess {
  /** Positive operating-system pid, not yet published to the sidecar. */
  readonly pid: number
  /** Writable child stdin when the requested disposition requires it. */
  readonly stdin: Writable | undefined
  /** Readable child stdout when the requested disposition requires relay or collection. */
  readonly stdout: Readable | undefined
  /** Readable child stderr when the requested disposition requires relay or collection. */
  readonly stderr: Readable | undefined
  /** Resume only after the sidecar has installed every stream endpoint. */
  resume(): Promise<GuardianOwnedProcess>
  /** Kill, join, and release a preparation that cannot be published. */
  rollback(): Promise<void>
}

/** One resumed native process tree retained by the guardian. */
export interface GuardianOwnedProcess {
  /** Positive tree-root pid. */
  readonly pid: number
  /** Direct-process outcome after requested output descriptors have drained. */
  readonly done: Promise<SubprocessOutcome>
  /** Idempotently begin tree-wide termination. */
  terminate(): Promise<void>
  /** Wait for the native ownership unit to contain zero active processes. */
  waitForExit(signal?: AbortSignal): Promise<boolean>
  /** Close native ownership handles only after active-process zero. */
  release(): Promise<void>
}

/** Guardian process-creation authority; the desktop composition supplies exactly one platform backend. */
export interface GuardianProcessSupervisor {
  /** Prepare one stopped child after its complete tree ownership is registered. */
  prepare(spec: GuardianNativeSpawnSpec, signal: AbortSignal): Promise<GuardianPreparedProcess>
  /** Kill and join every prepared or resumed process before resolving. */
  dispose(): Promise<void>
}

/**
 * Build the guardian-world child environment with explicit tombstones and Windows key semantics.
 * @param extra - explicit values and removals applied after the ambient scrub.
 * @param platform - key comparison semantics.
 * @returns child environment containing no tombstones.
 */
export function guardianChildEnv(
  extra?: Readonly<Record<string, string | null>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  let entries = Object.entries(scrubbedParentEnv())
  for (const [key, value] of Object.entries(extra ?? {})) {
    const normalized = platform === 'win32' ? key.toUpperCase() : key
    entries = entries.filter(([ambient]) => (platform === 'win32' ? ambient.toUpperCase() : ambient) !== normalized)
    if (value !== null) entries.push([key, value])
  }
  return Object.fromEntries(entries)
}

/**
 * Resolve an executable inside the guardian execution world.
 * @param command - absolute path or bare PATH name.
 * @param environment - already scrubbed guardian environment.
 * @param signal - lookup cancellation.
 * @param platform - host platform override for deterministic tests.
 * @returns verified absolute executable path.
 */
export async function resolveGuardianExecutable(
  command: string,
  environment: Readonly<Record<string, string>>,
  signal: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (command.length === 0) throw new Error('subprocess-guardian: executable name must be non-empty')
  signal.throwIfAborted()
  if (isAbsolute(command)) {
    await requireExecutable(command, signal, platform)
    return resolve(command)
  }
  if (command.includes('/') || command.includes('\\')) {
    throw new Error(`subprocess-guardian: command ${JSON.stringify(command)} is a relative path; use an absolute path or bare name`)
  }
  const path = environment.PATH ?? environment.Path ?? environment.path ?? ''
  const extensions = platform === 'win32'
    ? executableExtensions(command, environment.PATHEXT ?? environment.Pathext ?? '.COM;.EXE;.BAT;.CMD')
    : ['']
  for (const entry of path.split(delimiter)) {
    signal.throwIfAborted()
    const directory = resolve(entry.length === 0 ? process.cwd() : entry)
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`)
      try {
        await requireExecutable(candidate, signal, platform)
        return candidate
      } catch (error) {
        signal.throwIfAborted()
        if (!isLookupMiss(error)) throw error
      }
    }
  }
  throw new Error(`subprocess-guardian: executable ${JSON.stringify(command)} was not found in guardian PATH`)
}

/** Main-process ownership mirror required before a macOS capsule may resume. */
export interface MacOsOwnershipMirror {
  /**
   * Register a read-only process-group record in Electron main.
   * @returns opaque receipt the capsule verifies before resume.
   */
  register(
    capsuleId: string,
    pid: number,
    processGroupId: number,
    signal: AbortSignal,
  ): Promise<string>
  /** Remove the mirror only after the process group is joined or preparation rolls back. */
  release(capsuleId: string): Promise<void>
  /** Kill and join the mirrored process group after native capsule ownership is lost. */
  recover(capsuleId: string, reason: Error): Promise<void>
}

/** One stopped child owned by the signed macOS process-capsule helper. */
export interface MacOsCapsulePreparation {
  readonly capsuleId: string
  readonly pid: number
  readonly processGroupId: number
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  /** Confirm guardian and main receipts through the capsule liveness protocol. */
  confirmOwnership(mainReceipt: string): Promise<void>
  /** Resume the target only after both owners are confirmed. */
  resume(): Promise<MacOsCapsuleProcess>
  /** Kill and join the stopped group. */
  rollback(): Promise<void>
}

/** Resumed group retained by the signed macOS capsule. */
export interface MacOsCapsuleProcess {
  readonly done: Promise<SubprocessOutcome>
  /** Capsule-owned TERM → grace → KILL group termination. */
  terminate(): Promise<void>
  /** Wait for the complete process group to contain no live members. */
  waitForExit(signal?: AbortSignal): Promise<boolean>
  /** Release capsule resources after group exit. */
  release(): Promise<void>
}

/**
 * Replaceable transport to the fixed signed macOS capsule helper. The helper, not this TypeScript interface,
 * supplies `setsid`, stopped-child creation, guardian/main liveness pipes, group kill, and join guarantees.
 */
export interface MacOsCapsuleNativeTransport {
  prepare(spec: GuardianNativeSpawnSpec, signal: AbortSignal): Promise<MacOsCapsulePreparation>
  /** Close the guardian liveness end and join every capsule. */
  dispose(): Promise<void>
}

/** macOS supervisor that enforces dual ownership before publication and resume. */
export class MacOsCapsuleSupervisor implements GuardianProcessSupervisor {
  private readonly prepared = new Set<MacPrepared>()
  private readonly live = new Set<MacOwned>()
  private disposing = false

  /** @param transport - signed capsule helper transport. @param mirror - Electron-main PGID mirror. */
  constructor(
    private readonly transport: MacOsCapsuleNativeTransport,
    private readonly mirror: MacOsOwnershipMirror,
  ) {}

  /** @inheritdoc */
  async prepare(spec: GuardianNativeSpawnSpec, signal: AbortSignal): Promise<GuardianPreparedProcess> {
    if (this.disposing) throw new Error('subprocess-guardian: macOS supervisor is disposing')
    signal.throwIfAborted()
    const capsule = await this.transport.prepare(spec, signal)
    requirePositivePid(capsule.pid)
    if (!Number.isSafeInteger(capsule.processGroupId) || capsule.processGroupId <= 0) {
      await capsule.rollback()
      throw new Error('subprocess-guardian: capsule returned a non-positive process group id')
    }
    try {
      const receipt = await this.mirror.register(capsule.capsuleId, capsule.pid, capsule.processGroupId, signal)
      await capsule.confirmOwnership(receipt)
      signal.throwIfAborted()
    } catch (error) {
      await rollbackMacCapsule(capsule, this.mirror, asError(error))
      throw error
    }
    const prepared = new MacPrepared(capsule, this.mirror, (owned) => {
      this.prepared.delete(prepared)
      this.live.add(owned)
    }, () => { this.prepared.delete(prepared) }, (owned) => { this.live.delete(owned) })
    this.prepared.add(prepared)
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal can begin during awaited capsule setup.
    if (this.disposing) {
      await prepared.rollback()
      throw new Error('subprocess-guardian: macOS supervisor disposed during process setup')
    }
    return prepared
  }

  /** @inheritdoc */
  async dispose(): Promise<void> {
    if (this.disposing) return
    this.disposing = true
    const prepared = [...this.prepared]
    const live = [...this.live]
    await Promise.allSettled(prepared.map(value => value.rollback()))
    await Promise.allSettled(live.map(async (value) => {
      await value.terminate()
      await value.waitForExit()
      await value.release()
    }))
    await this.transport.dispose()
    this.prepared.clear()
    this.live.clear()
  }
}

class MacPrepared implements GuardianPreparedProcess {
  readonly pid: number
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  private state: 'prepared' | 'resumed' | 'rolled-back' = 'prepared'

  constructor(
    private readonly capsule: MacOsCapsulePreparation,
    private readonly mirror: MacOsOwnershipMirror,
    private readonly onResume: (owned: MacOwned) => void,
    private readonly onRollback: () => void,
    private readonly onRelease: (owned: MacOwned) => void,
  ) {
    this.pid = capsule.pid
    this.stdin = capsule.stdin
    this.stdout = capsule.stdout
    this.stderr = capsule.stderr
  }

  async resume(): Promise<GuardianOwnedProcess> {
    if (this.state !== 'prepared') throw new Error('subprocess-guardian: macOS preparation is not resumable')
    let process: MacOsCapsuleProcess
    try {
      process = await this.capsule.resume()
    } catch (error) {
      await this.rollback()
      throw error
    }
    this.state = 'resumed'
    const owned = new MacOwned(this.capsule.capsuleId, this.pid, process, this.mirror, () => { this.onRelease(owned) })
    this.onResume(owned)
    return owned
  }

  async rollback(): Promise<void> {
    if (this.state !== 'prepared') return
    this.state = 'rolled-back'
    try {
      await rollbackMacCapsule(this.capsule, this.mirror)
    } finally {
      this.onRollback()
    }
  }
}

class MacOwned implements GuardianOwnedProcess {
  readonly done: Promise<SubprocessOutcome>
  private finished = false
  private recovery: Promise<void> | undefined

  constructor(
    private readonly capsuleId: string,
    readonly pid: number,
    private readonly process: MacOsCapsuleProcess,
    private readonly mirror: MacOsOwnershipMirror,
    private readonly onRelease: () => void,
  ) {
    this.done = process.done.catch(async (error: unknown) => {
      try {
        await this.recover(asError(error))
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], 'subprocess-guardian: capsule outcome and main recovery failed')
      }
      throw error
    })
    void this.done.catch(() => undefined)
  }

  async terminate(): Promise<void> {
    if (this.finished) return
    try {
      await this.process.terminate()
    } catch (error) {
      await this.recover(asError(error))
    }
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.finished) return true
    try {
      return await this.process.waitForExit(signal)
    } catch (error) {
      await this.recover(asError(error))
      return true
    }
  }

  async release(): Promise<void> {
    if (this.finished) return
    try {
      if (!await this.process.waitForExit()) throw new Error('subprocess-guardian: capsule release requires process-group exit')
      await this.process.release()
      await this.mirror.release(this.capsuleId)
      this.finish()
    } catch (error) {
      await this.recover(asError(error))
    }
  }

  private async recover(reason: Error): Promise<void> {
    if (this.finished) return
    this.recovery ??= this.mirror.recover(this.capsuleId, reason).then(() => { this.finish() })
    try {
      await this.recovery
    } catch (error) {
      this.recovery = undefined
      throw error
    }
  }

  private finish(): void {
    if (this.finished) return
    this.finished = true
    this.onRelease()
  }
}

async function rollbackMacCapsule(
  capsule: MacOsCapsulePreparation,
  mirror: MacOsOwnershipMirror,
  reason = new Error('subprocess-guardian: native capsule rollback failed'),
): Promise<void> {
  try {
    await capsule.rollback()
  } catch (error) {
    await mirror.recover(capsule.capsuleId, asError(error))
    return
  }
  try {
    await mirror.release(capsule.capsuleId)
  } catch (error) {
    await mirror.recover(capsule.capsuleId, asError(error ?? reason))
  }
}

/** Opaque kill-on-close Job Object retained by the Windows native transport. */
export interface WindowsNativeJob {
  readonly id: string
}

/** Suspended Windows child plus parent-side stdio endpoints. */
export interface WindowsSuspendedProcess {
  readonly id: string
  readonly pid: number
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly done: Promise<SubprocessOutcome>
}

/**
 * Native Windows transport used by the pure-Node guardian. Implementations must create each Job Object with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, create the target suspended, and keep native handles in the guardian process.
 */
export interface WindowsJobNativeTransport {
  createKillOnCloseJob(signal: AbortSignal): Promise<WindowsNativeJob>
  createSuspendedProcess(spec: GuardianNativeSpawnSpec, signal: AbortSignal): Promise<WindowsSuspendedProcess>
  assignProcess(job: WindowsNativeJob, child: WindowsSuspendedProcess): Promise<void>
  resumeProcess(child: WindowsSuspendedProcess): Promise<void>
  terminateProcess(child: WindowsSuspendedProcess): Promise<void>
  terminateJob(job: WindowsNativeJob): Promise<void>
  waitForActiveProcessZero(job: WindowsNativeJob, signal?: AbortSignal): Promise<boolean>
  closeProcess(child: WindowsSuspendedProcess): Promise<void>
  closeJob(job: WindowsNativeJob): Promise<void>
  /** Closing all retained Job handles is the guardian-disconnect kill backstop. */
  dispose(): Promise<void>
}

/** Windows supervisor assigning every stopped child to an independent kill-on-close Job before resume. */
export class WindowsJobSupervisor implements GuardianProcessSupervisor {
  private readonly prepared = new Set<WindowsPrepared>()
  private readonly live = new Set<WindowsOwned>()
  private disposing = false

  /** @param native - native helper or FFI transport implementing the Job Object operations. */
  constructor(private readonly native: WindowsJobNativeTransport) {}

  /** @inheritdoc */
  async prepare(spec: GuardianNativeSpawnSpec, signal: AbortSignal): Promise<GuardianPreparedProcess> {
    if (this.disposing) throw new Error('subprocess-guardian: Windows supervisor is disposing')
    signal.throwIfAborted()
    let job: WindowsNativeJob | undefined
    let child: WindowsSuspendedProcess | undefined
    try {
      job = await this.native.createKillOnCloseJob(signal)
      child = await this.native.createSuspendedProcess(spec, signal)
      requirePositivePid(child.pid)
      await this.native.assignProcess(job, child)
      signal.throwIfAborted()
    } catch (error) {
      await rollbackWindows(this.native, job, child)
      throw error
    }
    const ownedJob = job
    const ownedChild = child
    const prepared = new WindowsPrepared(this.native, ownedJob, ownedChild, (owned) => {
      this.prepared.delete(prepared)
      this.live.add(owned)
    }, () => { this.prepared.delete(prepared) }, (owned) => { this.live.delete(owned) })
    this.prepared.add(prepared)
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal can begin during awaited process setup.
    if (this.disposing) {
      await prepared.rollback()
      throw new Error('subprocess-guardian: Windows supervisor disposed during process setup')
    }
    return prepared
  }

  /** @inheritdoc */
  async dispose(): Promise<void> {
    if (this.disposing) return
    this.disposing = true
    await Promise.allSettled([...this.prepared].map(value => value.rollback()))
    await Promise.allSettled([...this.live].map(async (value) => {
      await value.terminate()
      await value.waitForExit()
      await value.release()
    }))
    await this.native.dispose()
    this.prepared.clear()
    this.live.clear()
  }
}

class WindowsPrepared implements GuardianPreparedProcess {
  readonly pid: number
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  private state: 'prepared' | 'resumed' | 'rolled-back' = 'prepared'

  constructor(
    private readonly native: WindowsJobNativeTransport,
    private readonly job: WindowsNativeJob,
    private readonly child: WindowsSuspendedProcess,
    private readonly onResume: (owned: WindowsOwned) => void,
    private readonly onRollback: () => void,
    private readonly onRelease: (owned: WindowsOwned) => void,
  ) {
    this.pid = child.pid
    this.stdin = child.stdin
    this.stdout = child.stdout
    this.stderr = child.stderr
  }

  async resume(): Promise<GuardianOwnedProcess> {
    if (this.state !== 'prepared') throw new Error('subprocess-guardian: Windows preparation is not resumable')
    try {
      await this.native.resumeProcess(this.child)
    } catch (error) {
      await this.rollback()
      throw error
    }
    this.state = 'resumed'
    const owned = new WindowsOwned(this.native, this.job, this.child, () => { this.onRelease(owned) })
    this.onResume(owned)
    return owned
  }

  async rollback(): Promise<void> {
    if (this.state !== 'prepared') return
    this.state = 'rolled-back'
    await rollbackWindows(this.native, this.job, this.child)
    this.onRollback()
  }
}

class WindowsOwned implements GuardianOwnedProcess {
  readonly pid: number
  readonly done: Promise<SubprocessOutcome>
  private released = false

  constructor(
    private readonly native: WindowsJobNativeTransport,
    private readonly job: WindowsNativeJob,
    private readonly child: WindowsSuspendedProcess,
    private readonly onRelease: () => void,
  ) {
    this.pid = child.pid
    this.done = child.done
  }

  terminate(): Promise<void> { return this.native.terminateJob(this.job) }
  waitForExit(signal?: AbortSignal): Promise<boolean> { return this.native.waitForActiveProcessZero(this.job, signal) }

  async release(): Promise<void> {
    if (this.released) return
    if (!await this.native.waitForActiveProcessZero(this.job)) {
      throw new Error('subprocess-guardian: Windows Job release requires active-process zero')
    }
    this.released = true
    await this.native.closeProcess(this.child)
    await this.native.closeJob(this.job)
    this.onRelease()
  }
}

async function rollbackWindows(
  native: WindowsJobNativeTransport,
  job: WindowsNativeJob | undefined,
  child: WindowsSuspendedProcess | undefined,
): Promise<void> {
  if (child !== undefined) await native.terminateProcess(child).catch(() => undefined)
  if (job !== undefined) await native.terminateJob(job).catch(() => undefined)
  if (job !== undefined) await native.waitForActiveProcessZero(job).catch(() => false)
  if (child !== undefined) await native.closeProcess(child).catch(() => undefined)
  if (job !== undefined) await native.closeJob(job).catch(() => undefined)
}

async function requireExecutable(path: string, signal: AbortSignal, platform: NodeJS.Platform): Promise<void> {
  signal.throwIfAborted()
  const info = await stat(path)
  if (!info.isFile()) throw Object.assign(new Error(`subprocess-guardian: executable ${JSON.stringify(path)} is not a regular file`), { code: 'EACCES' })
  await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
  signal.throwIfAborted()
}

function executableExtensions(command: string, pathExt: string): readonly string[] {
  if (extname(command).length > 0) return ['']
  return pathExt.split(';').filter(Boolean).map(value => value.startsWith('.') ? value : `.${value}`)
}

function isLookupMiss(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES'
}

function requirePositivePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('subprocess-guardian: native supervisor returned a non-positive pid')
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
