/** Guardian-process composition and transparent desktop IPC relay. */

import {
  createNodeGuardianEndpoint,
  FramedGuardianPeer,
  type GuardianMessageEndpoint,
  type NodeGuardianIpcProcess,
} from './channel.ts'
import { GuardianServer } from './guardian.ts'
import {
  GUARDIAN_PROTOCOL_NAMESPACE,
  validateGuardianProtocolLimits,
  type GuardianProtocolLimits,
} from './protocol.ts'
import type { GuardianProcessSupervisor } from './supervisor.ts'

/** Untyped physical IPC endpoint used to relay non-guardian desktop protocols unchanged. */
export interface GuardianHostIpcEndpoint {
  /** Queue one semantic value and settle when the physical transport accepts it. */
  send(value: unknown): Promise<void>
  /** Subscribe to untrusted physical messages. */
  onMessage(listener: (value: unknown) => void): () => void
  /** Subscribe to physical peer loss. */
  onDisconnect(listener: () => void): () => void
}

/** Sidecar process retained by the guardian until its direct process and ownership unit are joined. */
export interface GuardianOwnedSidecar {
  /** Positive sidecar operating-system pid. */
  readonly pid: number
  /** Private advanced-serialization IPC channel shared by desktop and guardian protocols. */
  readonly ipc: GuardianHostIpcEndpoint
  /** Idempotently terminate and join the complete sidecar ownership unit. */
  terminateAndJoin(reason: Error): Promise<void>
}

/** Inputs required by the app-owned guardian entrypoint after it launches the Node sidecar. */
export interface GuardianHostOptions {
  /** Electron-main child-IPC endpoint inherited by the guardian process. */
  readonly parent: GuardianHostIpcEndpoint
  /** Platform-owned pure Node.js sidecar and its private IPC endpoint. */
  readonly sidecar: GuardianOwnedSidecar
  /** Sole platform process-creation authority used by guardian subprocess calls. */
  readonly supervisor: GuardianProcessSupervisor
  /** Guardian request, chunk, and hop-wide credit limits. */
  readonly limits: GuardianProtocolLimits
  /** App-owned parent-control frames consumed beside the transparent relay. */
  readonly isParentControlMessage?: ((value: unknown) => boolean) | undefined
  /** App-owned guardian-control namespace that a sidecar must never originate. */
  readonly isSidecarReservedMessage?: ((value: unknown) => boolean) | undefined
}

/**
 * Guardian-process host. Guardian frames terminate locally; every other value is relayed unchanged and in order.
 * Parent or sidecar loss starts one quiescent kill-and-join transaction.
 */
export class GuardianHost {
  /** Positive pid of the launched pure Node.js sidecar. */
  readonly sidecarPid: number
  /** Settles after protocol work, managed subprocesses, and the sidecar ownership unit are quiescent. */
  readonly done: Promise<void>

  private readonly peer: FramedGuardianPeer
  private readonly server: GuardianServer
  private readonly doneState = Promise.withResolvers<void>()
  private readonly removePeerClose: () => void
  private readonly removeParentMessage: () => void
  private readonly removeParentDisconnect: () => void
  private readonly removeSidecarMessage: () => void
  private readonly removeSidecarDisconnect: () => void
  private parentToSidecar = Promise.resolve()
  private sidecarToParent = Promise.resolve()
  private disposePromise: Promise<void> | undefined

  /** @param options - already-launched sidecar, platform supervisor, parent channel, and negotiated limits. */
  constructor(private readonly options: GuardianHostOptions) {
    requirePositivePid(options.sidecar.pid)
    validateGuardianProtocolLimits(options.limits)
    this.sidecarPid = options.sidecar.pid
    this.done = this.doneState.promise
    void this.done.catch(() => undefined)

    const framedEndpoint = adaptGuardianEndpoint(options.sidecar.ipc)
    this.peer = new FramedGuardianPeer(framedEndpoint, options.limits)
    this.server = new GuardianServer(this.peer, options.supervisor)
    this.removePeerClose = this.peer.onClosed((error) => { void this.dispose(error) })
    this.removeParentMessage = options.parent.onMessage((value) => { this.forwardToSidecar(value) })
    this.removeParentDisconnect = options.parent.onDisconnect(() => {
      void this.dispose(new Error('subprocess-guardian: Electron main IPC disconnected'))
    })
    this.removeSidecarMessage = options.sidecar.ipc.onMessage((value) => { this.forwardToParent(value) })
    this.removeSidecarDisconnect = options.sidecar.ipc.onDisconnect(() => {
      void this.dispose(new Error('subprocess-guardian: sidecar IPC disconnected'))
    })
  }

  /**
   * Stop relaying, cancel guardian protocol work, kill and join managed trees, then join the sidecar.
   * @param reason - terminal lifecycle reason propagated to pending guardian operations.
   * @returns the shared disposal settlement.
   */
  dispose(reason = new Error('subprocess-guardian: guardian host disposed')): Promise<void> {
    this.disposePromise ??= this.disposeOnce(reason)
    return this.disposePromise
  }

  private forwardToSidecar(value: unknown): void {
    if (this.disposePromise !== undefined) return
    try {
      if (this.options.isParentControlMessage?.(value) === true) return
    } catch (error) {
      void this.dispose(asError(error))
      return
    }
    if (isGuardianEnvelope(value)) {
      void this.dispose(new Error('subprocess-guardian: Electron main sent a reserved guardian frame'))
      return
    }
    this.parentToSidecar = enqueueRelay(
      this.parentToSidecar,
      () => this.options.sidecar.ipc.send(value),
      (error) => { void this.dispose(error) },
    )
  }

  private forwardToParent(value: unknown): void {
    if (this.disposePromise !== undefined || isGuardianEnvelope(value)) return
    if (this.options.isSidecarReservedMessage?.(value) === true) {
      void this.dispose(new Error('subprocess-guardian: sidecar sent a reserved host-control frame'))
      return
    }
    this.sidecarToParent = enqueueRelay(
      this.sidecarToParent,
      () => this.options.parent.send(value),
      (error) => { void this.dispose(error) },
    )
  }

  private async disposeOnce(reason: Error): Promise<void> {
    this.removeParentMessage()
    this.removeParentDisconnect()
    this.removeSidecarMessage()
    this.removeSidecarDisconnect()
    this.removePeerClose()
    await this.peer.dispose(reason)
    const cleanup = await Promise.allSettled([
      this.server.dispose(),
      this.options.sidecar.terminateAndJoin(reason),
    ])
    await Promise.allSettled([this.parentToSidecar, this.sidecarToParent])
    const failures: unknown[] = []
    for (const result of cleanup) {
      if (result.status === 'rejected') failures.push(result.reason as unknown)
    }
    if (failures.length > 0) {
      const error = new AggregateError(failures, 'subprocess-guardian: guardian host cleanup failed')
      this.doneState.reject(error)
      throw error
    }
    this.doneState.resolve()
  }
}

/**
 * Compose a guardian host around an already-owned sidecar.
 * @param options - guardian process inputs.
 * @returns live host; the app entry should await `done` before exiting.
 */
export function startGuardianHost(options: GuardianHostOptions): GuardianHost {
  return new GuardianHost(options)
}

/**
 * Adapt a Node child IPC face for transparent host relaying without taking ownership of the channel.
 * @param target - guardian `process` or guardian-side sidecar `ChildProcess` face.
 * @returns raw Node child-IPC endpoint.
 */
export function createNodeGuardianHostEndpoint(target: NodeGuardianIpcProcess): GuardianHostIpcEndpoint {
  const guardian = createNodeGuardianEndpoint(target)
  return {
    send: value => sendNodeValue(target, value),
    onMessage: listener => guardian.onMessage(listener),
    onDisconnect: listener => guardian.onDisconnect(listener),
  }
}

function adaptGuardianEndpoint(endpoint: GuardianHostIpcEndpoint): GuardianMessageEndpoint {
  return {
    send: frame => endpoint.send(frame),
    onMessage: listener => endpoint.onMessage(listener),
    onDisconnect: listener => endpoint.onDisconnect(listener),
  }
}

function enqueueRelay(
  prior: Promise<void>,
  send: () => Promise<void>,
  failed: (error: Error) => void,
): Promise<void> {
  const next = prior.catch(() => undefined).then(send)
  void next.catch((error: unknown) => { failed(asError(error)) })
  return next
}

function isGuardianEnvelope(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).namespace === GUARDIAN_PROTOCOL_NAMESPACE
}

function sendNodeValue(target: NodeGuardianIpcProcess, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (target.connected === false || target.send === undefined) {
      reject(new Error('subprocess-guardian: Node child IPC disconnected'))
      return
    }
    target.send(value, (error) => {
      if (error === null) resolve()
      else reject(error)
    })
  })
}

function requirePositivePid(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('subprocess-guardian: sidecar must publish a positive pid')
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
