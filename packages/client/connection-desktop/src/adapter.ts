/** Node IPC adapters published through the package's `./adapter` subpath. */

import { randomUUID } from 'node:crypto'
import {
  clientRequestSchema,
  serverResponseSchema,
  type RpcReceipt,
  type ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { clientResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { parseBootManifest } from '@deepseek-ai/dsh-client-modules/manifest'
import { parseDesktopServerRequest } from './codec.ts'
import {
  DESKTOP_CONNECTION_PROTOCOL_VERSION,
  DesktopBodyId,
  DesktopRequestId,
  type DesktopBodyId as DesktopBodyIdType,
  type DesktopConnectionStream,
  type DesktopIpcAdapter,
  type DesktopIpcHost,
  type DesktopMainHandlers,
  type DesktopMainMessageEndpoint,
  type DesktopMessageEndpoint,
  type DesktopRendererBridge,
  type DesktopRendererInvocation,
  type DesktopRendererInvocationResult,
  type DesktopRendererSystemMethodMap,
  type DesktopRendererSystemRequest,
  type DesktopRendererSystemResponse,
  type DesktopRequestId as DesktopRequestIdType,
  type DesktopSidecarInboundControlFrame,
  type DesktopSidecarOutboundControlFrame,
  type DesktopWireError,
  type DesktopWireResult,
  type HostInitiatedMethodMap,
  type HostInitiatedRequest,
  type HostInitiatedResponse,
} from './protocol.ts'
import {
  DesktopBodyLimitError,
  DesktopBodyTransport,
  DesktopProtocolError,
  parseDesktopBodyFrame,
  resolveDesktopIpcLimits,
  type DesktopIpcLimits,
  type DesktopIpcLimitsInput,
} from './wire.ts'

interface PendingHostRequest {
  readonly method: keyof HostInitiatedMethodMap
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly removeAbort: () => void
}

interface PendingRendererRequest {
  readonly kind: 'invoke' | 'system'
  readonly method?: keyof DesktopRendererSystemMethodMap
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly removeAbort: () => void
}

interface MainSubscription {
  readonly queue: AsyncQueue<ServerRequest>
  readonly removeAbort: () => void
  nextSequence: number
}

/** Minimal Node IPC face shared by a sidecar `process` and Electron's `ChildProcess`. */
export interface NodeIpcPeer {
  readonly connected?: boolean | undefined
  send?: NonNullable<NodeJS.Process['send']> | undefined
  on(event: 'message', listener: (value: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
  off(event: 'message', listener: (value: unknown) => void): unknown
  off(event: 'disconnect', listener: () => void): unknown
}

/** Backward-compatible name for the sidecar-facing Node IPC process. */
export type NodeChildIpcProcess = NodeIpcPeer

/**
 * Adapt the sidecar's Node IPC channel to its typed message endpoint.
 * @param child - sidecar `process` or an equivalent connected IPC face.
 * @returns endpoint that rejects startup without a connected IPC parent.
 */
export function createNodeChildProcessEndpoint(child: NodeIpcPeer): DesktopMessageEndpoint {
  const endpoint = createNodeEndpoint(child)
  return endpoint
}

/**
 * Adapt a semantic Node child-IPC face to Electron main's typed peer endpoint.
 * @param child - connected child after any app-owned physical encoding is removed.
 * @returns Electron-main endpoint for {@link DesktopMainIpcPeer}.
 */
export function createNodeParentProcessEndpoint(child: NodeIpcPeer): DesktopMainMessageEndpoint {
  const endpoint = createNodeEndpoint(child)
  return endpoint
}

function createNodeEndpoint(child: NodeIpcPeer): {
  send(frame: never): void
  onMessage(listener: (value: unknown) => void): () => void
  onDisconnect(listener: () => void): () => void
} {
  if (typeof child.send !== 'function' || child.connected === false) {
    throw new Error('connection-desktop: peer requires a connected Node IPC channel')
  }
  return {
    send: (frame) => {
      if (child.connected === false || typeof child.send !== 'function') throw disconnectedError()
      child.send(frame)
    },
    onMessage: (listener) => {
      child.on('message', listener)
      return () => { child.off('message', listener) }
    },
    onDisconnect: (listener) => {
      child.on('disconnect', listener)
      return () => { child.off('disconnect', listener) }
    },
  }
}

/** Child-process sidecar adapter with bounded bodies, correlation, cancellation, and Host requests. */
export class ChildProcessDesktopIpcAdapter implements DesktopIpcAdapter {
  private host: DesktopIpcHost | undefined
  private removeMessage: (() => void) | undefined
  private removeDisconnect: (() => void) | undefined
  private readonly invokes = new Map<DesktopRequestIdType, AbortController>()
  private readonly subscriptions = new Map<DesktopRequestIdType, AbortController>()
  private readonly pumps = new Set<Promise<void>>()
  private readonly pendingHost = new Map<DesktopRequestIdType, PendingHostRequest>()
  private readonly bodies: DesktopBodyTransport
  private connected = true

  /**
   * @param endpoint - sidecar child-process message and disconnect endpoint.
   * @param limits - body, chunk, and shared in-flight limits.
   */
  constructor(endpoint: DesktopMessageEndpoint, limits: DesktopIpcLimitsInput = {}) {
    this.endpoint = endpoint
    this.bodies = new DesktopBodyTransport(
      (frame) => { endpoint.send(frame) },
      resolveDesktopIpcLimits(limits),
    )
  }

  private readonly endpoint: DesktopMessageEndpoint

  /** @inheritdoc */
  install(host: DesktopIpcHost): () => Promise<void> {
    if (this.host !== undefined) throw new Error('connection-desktop: IPC adapter already installed')
    if (!this.connected) throw disconnectedError()
    this.host = host
    this.removeMessage = this.endpoint.onMessage((value) => {
      try {
        this.handleMessage(value)
      } catch (error) {
        this.disconnect(error)
      }
    })
    this.removeDisconnect = this.endpoint.onDisconnect(() => { this.disconnect(disconnectedError()) })
    return async () => {
      this.removeMessage?.()
      this.removeDisconnect?.()
      this.removeMessage = undefined
      this.removeDisconnect = undefined
      this.disconnect(disconnectedError())
      await Promise.all([...this.pumps])
      this.host = undefined
    }
  }

  /** @inheritdoc */
  requestHost<K extends keyof HostInitiatedMethodMap>(
    method: K,
    payload: HostInitiatedRequest<K>,
    signal?: AbortSignal,
  ): Promise<HostInitiatedResponse<K>> {
    if (!this.connected || this.host === undefined) return Promise.reject(disconnectedError())
    if (signal?.aborted === true) return Promise.reject(abortReason(signal))
    const requestId = DesktopRequestId(randomUUID())
    return new Promise<HostInitiatedResponse<K>>((resolve, reject) => {
      let removeAbort = (): void => {}
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.pendingHost.delete(requestId)
          this.endpoint.send({
            version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
            type: 'host-cancel',
            requestId,
          })
          reject(abortReason(signal))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        removeAbort = () => { signal.removeEventListener('abort', onAbort) }
      }
      this.pendingHost.set(requestId, {
        method,
        resolve: (value) => { resolve(value as HostInitiatedResponse<K>) },
        reject,
        removeAbort,
      })
      this.track(this.sendHostRequest(requestId, method, payload, signal).catch((error: unknown) => {
        const pending = this.pendingHost.get(requestId)
        if (pending === undefined) return
        this.pendingHost.delete(requestId)
        pending.removeAbort()
        pending.reject(normalizeError(error))
      }))
    })
  }

  private handleMessage(value: unknown): void {
    const body = parseDesktopBodyFrame(value)
    if (body !== undefined) {
      this.bodies.accept(body)
      return
    }
    const frame = parseSidecarInboundControlFrame(value)
    switch (frame.type) {
      case 'renderer-invoke':
        this.startInvoke(frame.requestId, parseInvocation(this.bodies.take(frame.bodyId)))
        return
      case 'renderer-system':
        this.startSystem(frame.requestId, frame.method, this.bodies.take(frame.bodyId))
        return
      case 'renderer-cancel':
        this.invokes.get(frame.requestId)?.abort(new Error('renderer request cancelled'))
        return
      case 'renderer-subscribe':
        this.startSubscription(frame.subscriptionId, frame.stream)
        return
      case 'renderer-unsubscribe':
        this.subscriptions.get(frame.subscriptionId)?.abort(new Error('renderer subscription cancelled'))
        return
      case 'host-response':
        this.finishHostRequest(frame.requestId, parseWireResult(this.bodies.take(frame.bodyId)))
        return
    }
  }

  private startInvoke(requestId: DesktopRequestIdType, invocation: DesktopRendererInvocation): void {
    const host = this.host
    if (host === undefined || this.invokes.has(requestId)) {
      this.track(this.sendRendererResult(requestId, failure('bad-request', 'duplicate or unavailable invocation')))
      return
    }
    const abort = new AbortController()
    this.invokes.set(requestId, abort)
    const operation = raceWithAbort(host.invoke(invocation, abort.signal), abort.signal).then(
      result => this.sendRendererResult(requestId, { ok: true, value: result }),
      (error: unknown) => this.sendRendererResult(requestId, { ok: false, error: wireError(error, abort.signal) }),
    ).finally(() => { this.invokes.delete(requestId) })
    this.track(operation)
  }

  private startSystem(
    requestId: DesktopRequestIdType,
    method: keyof DesktopRendererSystemMethodMap,
    rawPayload: unknown,
  ): void {
    const host = this.host
    if (host === undefined || this.invokes.has(requestId)) {
      this.track(this.sendRendererResult(requestId, failure('bad-request', 'duplicate or unavailable system request')))
      return
    }
    const payload = parseRendererSystemRequest(method, rawPayload)
    const abort = new AbortController()
    this.invokes.set(requestId, abort)
    const operation = raceWithAbort(host.system(method, payload, abort.signal), abort.signal).then(
      result => this.sendRendererResult(requestId, { ok: true, value: result }),
      (error: unknown) => this.sendRendererResult(requestId, { ok: false, error: wireError(error, abort.signal) }),
    ).finally(() => { this.invokes.delete(requestId) })
    this.track(operation)
  }

  private startSubscription(subscriptionId: DesktopRequestIdType, stream: DesktopConnectionStream): void {
    const host = this.host
    if (host === undefined || this.subscriptions.has(subscriptionId)) {
      this.track(this.sendSubscriptionEnd(
        subscriptionId,
        failure('bad-request', 'duplicate or unavailable subscription'),
      ))
      return
    }
    const abort = new AbortController()
    this.subscriptions.set(subscriptionId, abort)
    const pump = this.pumpSubscription(subscriptionId, host.subscribe(stream, abort.signal), abort)
    this.track(pump, () => { this.subscriptions.delete(subscriptionId) })
  }

  private async pumpSubscription(
    subscriptionId: DesktopRequestIdType,
    source: AsyncIterable<ServerRequest>,
    abort: AbortController,
  ): Promise<void> {
    let sequence = 0
    const iterator = source[Symbol.asyncIterator]()
    try {
      while (true) {
        const item = await raceWithAbort(iterator.next(), abort.signal)
        if (item.done === true) break
        const event = item.value
        const bodyId = await this.bodies.send(event, abort.signal)
        this.endpoint.send({
          version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
          type: 'renderer-event',
          subscriptionId,
          sequence: sequence++,
          bodyId,
        })
      }
      await this.sendSubscriptionEnd(subscriptionId, { ok: true, value: {} })
    } catch (error) {
      if (this.connected) {
        await this.sendSubscriptionEnd(
          subscriptionId,
          { ok: false, error: wireError(error, abort.signal) },
        )
      }
    } finally {
      abort.abort()
      void iterator.return?.().catch(() => {
        // The source owns cancellation errors after its consumer has ended.
      })
    }
  }

  private async sendRendererResult(
    requestId: DesktopRequestIdType,
    result: DesktopWireResult<unknown>,
  ): Promise<void> {
    if (!this.isConnected()) return
    const bodyId = await this.bodies.send(result)
    if (!this.isConnected()) return
    this.endpoint.send({
      version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
      type: 'renderer-result',
      requestId,
      bodyId,
    })
  }

  private async sendSubscriptionEnd(
    subscriptionId: DesktopRequestIdType,
    result: DesktopWireResult<Record<string, never>>,
  ): Promise<void> {
    const bodyId = await this.bodies.send(result)
    if (!this.isConnected()) return
    this.endpoint.send({
      version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
      type: 'renderer-end',
      subscriptionId,
      bodyId,
    })
  }

  private async sendHostRequest<K extends keyof HostInitiatedMethodMap>(
    requestId: DesktopRequestIdType,
    method: K,
    payload: HostInitiatedRequest<K>,
    signal?: AbortSignal,
  ): Promise<void> {
    const bodyId = await this.bodies.send(payload, signal)
    if (!this.connected || !this.pendingHost.has(requestId)) return
    this.endpoint.send({
      version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
      type: 'host-request',
      requestId,
      method,
      bodyId,
    })
  }

  private finishHostRequest(requestId: DesktopRequestIdType, result: DesktopWireResult<unknown>): void {
    const pending = this.pendingHost.get(requestId)
    if (pending === undefined) return
    this.pendingHost.delete(requestId)
    pending.removeAbort()
    if (!result.ok) {
      pending.reject(errorFromWire(result.error))
      return
    }
    try {
      pending.resolve(validateHostResponse(pending.method, result.value))
    } catch (error) {
      pending.reject(error)
    }
  }

  private track(operation: Promise<void>, after?: () => void): void {
    this.pumps.add(operation)
    void operation.catch((error: unknown) => {
      if (this.connected) this.disconnect(error)
    }).finally(() => {
      this.pumps.delete(operation)
      after?.()
    })
  }

  private disconnect(reason: unknown): void {
    if (!this.connected) return
    this.connected = false
    const error = normalizeError(reason)
    this.bodies.close(error)
    for (const abort of this.invokes.values()) abort.abort(error)
    for (const abort of this.subscriptions.values()) abort.abort(error)
    this.invokes.clear()
    this.subscriptions.clear()
    for (const pending of this.pendingHost.values()) {
      pending.removeAbort()
      pending.reject(error)
    }
    this.pendingHost.clear()
  }

  private isConnected(): boolean {
    return this.connected
  }
}

/** Electron-main peer exposing the narrow preload bridge over a typed child-IPC endpoint. */
export class DesktopMainIpcPeer implements DesktopRendererBridge {
  private readonly limits: DesktopIpcLimits
  private readonly bodies: DesktopBodyTransport
  private readonly pending = new Map<DesktopRequestIdType, PendingRendererRequest>()
  private readonly subscriptions = new Map<DesktopRequestIdType, MainSubscription>()
  private readonly hostRequests = new Map<DesktopRequestIdType, AbortController>()
  private readonly operations = new Set<Promise<void>>()
  private readonly removeMessage: () => void
  private readonly removeDisconnect: () => void
  private connected = true

  /**
   * @param endpoint - Electron-main endpoint for the sidecar child.
   * @param main - closed sidecar-to-main capability handlers.
   * @param limits - limits identical to those configured in the sidecar provider.
   */
  constructor(
    private readonly endpoint: DesktopMainMessageEndpoint,
    private readonly main: DesktopMainHandlers,
    limits: DesktopIpcLimitsInput = {},
  ) {
    this.limits = resolveDesktopIpcLimits(limits)
    this.bodies = new DesktopBodyTransport((frame) => { endpoint.send(frame) }, this.limits)
    this.removeMessage = endpoint.onMessage((value) => {
      try {
        this.handleMessage(value)
      } catch (error) {
        this.disconnect(error)
      }
    })
    this.removeDisconnect = endpoint.onDisconnect(() => { this.disconnect(disconnectedError()) })
  }

  /** Current unacknowledged main-to-sidecar body bytes across all calls. */
  get inflightBytes(): number {
    return this.bodies.inflightBytes
  }

  /** @inheritdoc */
  invoke(
    invocation: DesktopRendererInvocation,
    signal?: AbortSignal,
  ): Promise<DesktopRendererInvocationResult> {
    return this.startRendererRequest<DesktopRendererInvocationResult>(
      'invoke',
      invocation,
      signal,
      (requestId, bodyId) => ({
        version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
        type: 'renderer-invoke',
        requestId,
        bodyId,
      }),
    )
  }

  /** @inheritdoc */
  system<K extends keyof DesktopRendererSystemMethodMap>(
    method: K,
    payload: DesktopRendererSystemRequest<K>,
    signal?: AbortSignal,
  ): Promise<DesktopRendererSystemResponse<K>> {
    return this.startRendererRequest<DesktopRendererSystemResponse<K>>(
      'system',
      payload,
      signal,
      (requestId, bodyId) => ({
        version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
        type: 'renderer-system',
        requestId,
        method,
        bodyId,
      }),
      method,
    )
  }

  /** @inheritdoc */
  async *subscribe(stream: DesktopConnectionStream, signal: AbortSignal): AsyncGenerator<ServerRequest> {
    this.requireConnected()
    if (signal.aborted) throw abortReason(signal)
    const subscriptionId = DesktopRequestId(randomUUID())
    const queue = new AsyncQueue<ServerRequest>()
    const onAbort = (): void => {
      this.subscriptions.delete(subscriptionId)
      this.endpoint.send({
        version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
        type: 'renderer-unsubscribe',
        subscriptionId,
      })
      queue.fail(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    this.subscriptions.set(subscriptionId, {
      queue,
      removeAbort: () => { signal.removeEventListener('abort', onAbort) },
      nextSequence: 0,
    })
    this.endpoint.send({
      version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
      type: 'renderer-subscribe',
      subscriptionId,
      stream,
    })
    try {
      for await (const event of queue) yield event
    } finally {
      const active = this.subscriptions.get(subscriptionId)
      if (active !== undefined) {
        this.subscriptions.delete(subscriptionId)
        active.removeAbort()
        this.endpoint.send({
          version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
          type: 'renderer-unsubscribe',
          subscriptionId,
        })
      }
    }
  }

  /** Stop accepting messages and reject all pending preload operations. */
  async dispose(): Promise<void> {
    this.removeMessage()
    this.removeDisconnect()
    this.disconnect(disconnectedError())
    await Promise.allSettled([...this.operations])
  }

  private startRendererRequest<T>(
    kind: PendingRendererRequest['kind'],
    payload: unknown,
    signal: AbortSignal | undefined,
    control: (
      requestId: DesktopRequestIdType,
      bodyId: DesktopBodyIdType,
    ) => DesktopSidecarInboundControlFrame,
    method?: keyof DesktopRendererSystemMethodMap,
  ): Promise<T> {
    try {
      this.requireConnected()
    } catch (error) {
      return Promise.reject(normalizeError(error))
    }
    if (signal?.aborted === true) return Promise.reject(abortReason(signal))
    const requestId = DesktopRequestId(randomUUID())
    return new Promise<T>((resolve, reject) => {
      let removeAbort = (): void => {}
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.pending.delete(requestId)
          this.endpoint.send({
            version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
            type: 'renderer-cancel',
            requestId,
          })
          reject(abortReason(signal))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        removeAbort = () => { signal.removeEventListener('abort', onAbort) }
      }
      this.pending.set(requestId, {
        kind,
        ...(method === undefined ? {} : { method }),
        resolve: (value) => { resolve(value as T) },
        reject,
        removeAbort,
      })
      this.track(this.bodies.send(payload, signal).then((bodyId) => {
        if (this.connected && this.pending.has(requestId)) this.endpoint.send(control(requestId, bodyId))
      }).catch((error: unknown) => {
        const pending = this.pending.get(requestId)
        if (pending === undefined) return
        this.pending.delete(requestId)
        pending.removeAbort()
        pending.reject(normalizeError(error))
      }))
    })
  }

  private handleMessage(value: unknown): void {
    const body = parseDesktopBodyFrame(value)
    if (body !== undefined) {
      this.bodies.accept(body)
      return
    }
    const frame = parseSidecarOutboundControlFrame(value)
    switch (frame.type) {
      case 'renderer-result':
        this.finishRendererRequest(frame.requestId, this.bodies.take(frame.bodyId))
        return
      case 'renderer-event':
        this.pushSubscriptionEvent(
          frame.subscriptionId,
          frame.sequence,
          parseDesktopServerRequest(this.bodies.take(frame.bodyId)),
        )
        return
      case 'renderer-end':
        this.finishSubscription(frame.subscriptionId, parseWireResult(this.bodies.take(frame.bodyId)))
        return
      case 'host-request':
        this.startHostRequest(frame.requestId, frame.method, this.bodies.take(frame.bodyId))
        return
      case 'host-cancel':
        this.hostRequests.get(frame.requestId)?.abort(new Error('sidecar Host request cancelled'))
        return
    }
  }

  private finishRendererRequest(requestId: DesktopRequestIdType, rawResult: unknown): void {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    const result = parseWireResult(rawResult)
    this.pending.delete(requestId)
    pending.removeAbort()
    if (!result.ok) {
      pending.reject(errorFromWire(result.error))
      return
    }
    try {
      const value = pending.kind === 'invoke'
        ? parseInvocationResult(result.value)
        : parseRendererSystemResponse(
          pending.method as keyof DesktopRendererSystemMethodMap,
          result.value,
        )
      pending.resolve(value)
    } catch (error) {
      pending.reject(error)
    }
  }

  private pushSubscriptionEvent(
    subscriptionId: DesktopRequestIdType,
    sequence: number,
    event: ServerRequest,
  ): void {
    const subscription = this.subscriptions.get(subscriptionId)
    if (subscription === undefined) return
    if (sequence !== subscription.nextSequence) {
      throw new DesktopProtocolError(
        `subscription ${JSON.stringify(subscriptionId)} expected sequence ${String(subscription.nextSequence)}, got ${String(sequence)}`,
      )
    }
    subscription.nextSequence += 1
    subscription.queue.push(event)
  }

  private finishSubscription(
    subscriptionId: DesktopRequestIdType,
    result: DesktopWireResult<unknown>,
  ): void {
    const subscription = this.subscriptions.get(subscriptionId)
    if (subscription === undefined) return
    this.subscriptions.delete(subscriptionId)
    subscription.removeAbort()
    if (!result.ok) subscription.queue.fail(errorFromWire(result.error))
    else {
      parseEmptyRecord(result.value, 'renderer-end')
      subscription.queue.end()
    }
  }

  private startHostRequest(
    requestId: DesktopRequestIdType,
    method: keyof HostInitiatedMethodMap,
    rawPayload: unknown,
  ): void {
    if (this.hostRequests.has(requestId)) {
      this.track(this.sendHostResponse(requestId, failure('bad-request', 'duplicate Host request')))
      return
    }
    const payload = validateHostRequest(method, rawPayload)
    const abort = new AbortController()
    this.hostRequests.set(requestId, abort)
    const operation = raceWithAbort(this.invokeMain(method, payload, abort.signal), abort.signal).then(
      result => this.sendHostResponse(requestId, { ok: true, value: result }),
      (error: unknown) => this.sendHostResponse(requestId, { ok: false, error: wireError(error, abort.signal) }),
    ).finally(() => { this.hostRequests.delete(requestId) })
    this.track(operation)
  }

  private invokeMain<K extends keyof HostInitiatedMethodMap>(
    _method: K,
    payload: HostInitiatedRequest<K>,
    signal: AbortSignal,
  ): Promise<HostInitiatedResponse<K>> {
    return this.main['directory.pick'](payload, signal)
  }

  private async sendHostResponse(
    requestId: DesktopRequestIdType,
    result: DesktopWireResult<unknown>,
  ): Promise<void> {
    if (!this.isConnected()) return
    const bodyId = await this.bodies.send(result)
    if (!this.isConnected()) return
    this.endpoint.send({
      version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
      type: 'host-response',
      requestId,
      bodyId,
    })
  }

  private track(operation: Promise<void>): void {
    this.operations.add(operation)
    void operation.catch((error: unknown) => {
      if (this.connected) this.disconnect(error)
    }).finally(() => { this.operations.delete(operation) })
  }

  private requireConnected(): void {
    if (!this.connected) throw disconnectedError()
  }

  private disconnect(reason: unknown): void {
    if (!this.connected) return
    this.connected = false
    const error = normalizeError(reason)
    this.bodies.close(error)
    for (const pending of this.pending.values()) {
      pending.removeAbort()
      pending.reject(error)
    }
    this.pending.clear()
    for (const subscription of this.subscriptions.values()) {
      subscription.removeAbort()
      subscription.queue.fail(error)
    }
    this.subscriptions.clear()
    for (const abort of this.hostRequests.values()) abort.abort(error)
    this.hostRequests.clear()
  }

  private isConnected(): boolean {
    return this.connected
  }
}

/** Backward-compatible deterministic main handler name. */
export type InMemoryDesktopMainHandlers = DesktopMainHandlers

/** Deterministic adapter implementing both sidecar and preload faces for focused tests. */
export class InMemoryDesktopIpcAdapter implements DesktopIpcAdapter, DesktopRendererBridge {
  private host: DesktopIpcHost | undefined
  private connected = true
  private readonly active = new Set<AbortController>()

  /** @param main - closed Electron-main capability handlers. */
  constructor(private readonly main: DesktopMainHandlers) {}

  /** @inheritdoc */
  install(host: DesktopIpcHost): () => void {
    if (this.host !== undefined) throw new Error('connection-desktop: in-memory adapter already installed')
    if (!this.connected) throw disconnectedError()
    this.host = host
    return () => {
      this.host = undefined
      this.disconnect()
    }
  }

  /** @inheritdoc */
  invoke(
    invocation: DesktopRendererInvocation,
    signal?: AbortSignal,
  ): Promise<DesktopRendererInvocationResult> {
    const host = this.requireHost()
    return this.run(signal, inner => host.invoke(invocation, inner))
  }

  /** @inheritdoc */
  system<K extends keyof DesktopRendererSystemMethodMap>(
    method: K,
    payload: DesktopRendererSystemRequest<K>,
    signal?: AbortSignal,
  ): Promise<DesktopRendererSystemResponse<K>> {
    const host = this.requireHost()
    return this.run(signal, inner => host.system(method, payload, inner))
  }

  /** @inheritdoc */
  async *subscribe(stream: DesktopConnectionStream, signal: AbortSignal): AsyncGenerator<ServerRequest> {
    const host = this.requireHost()
    const abort = linkedAbort(signal)
    this.active.add(abort)
    const iterator = host.subscribe(stream, abort.signal)[Symbol.asyncIterator]()
    try {
      while (true) {
        const item = await Promise.race([iterator.next(), rejectedOnAbort(abort.signal)])
        if (item.done === true) return
        yield item.value
      }
    } finally {
      abort.abort()
      await iterator.return?.()
      this.active.delete(abort)
    }
  }

  /** @inheritdoc */
  requestHost<K extends keyof HostInitiatedMethodMap>(
    _method: K,
    payload: HostInitiatedRequest<K>,
    signal?: AbortSignal,
  ): Promise<HostInitiatedResponse<K>> {
    return this.run(signal, inner => this.main['directory.pick'](
      payload,
      inner,
    ))
  }

  /** Simulate loss of the Electron/sidecar IPC peer. */
  disconnect(): void {
    if (!this.connected) return
    this.connected = false
    const reason = disconnectedError()
    for (const abort of this.active) abort.abort(reason)
    this.active.clear()
  }

  private requireHost(): DesktopIpcHost {
    if (!this.connected || this.host === undefined) throw disconnectedError()
    return this.host
  }

  private run<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.connected) return Promise.reject(disconnectedError())
    const abort = linkedAbort(signal)
    this.active.add(abort)
    return Promise.race([operation(abort.signal), rejectedOnAbort(abort.signal)])
      .finally(() => {
        abort.abort()
        this.active.delete(abort)
      })
  }
}

function parseSidecarInboundControlFrame(value: unknown): DesktopSidecarInboundControlFrame {
  if (!isControlBase(value)) throw new DesktopProtocolError('invalid sidecar inbound control frame')
  if (value.type === 'renderer-invoke' && hasOnlyKeys(value, ['version', 'type', 'requestId', 'bodyId'])
    && hasRequestAndBody(value)) {
    return { version: 1, type: value.type, requestId: DesktopRequestId(value.requestId), bodyId: DesktopBodyId(value.bodyId) }
  }
  if (value.type === 'renderer-system'
    && hasOnlyKeys(value, ['version', 'type', 'requestId', 'method', 'bodyId'])
    && hasRequestAndBody(value)
    && value.method === 'desktop.bootManifest') {
    return {
      version: 1,
      type: value.type,
      requestId: DesktopRequestId(value.requestId),
      method: value.method,
      bodyId: DesktopBodyId(value.bodyId),
    }
  }
  if (value.type === 'renderer-cancel' && hasOnlyKeys(value, ['version', 'type', 'requestId'])
    && isNonEmptyString(value.requestId)) {
    return { version: 1, type: value.type, requestId: DesktopRequestId(value.requestId) }
  }
  if (value.type === 'renderer-subscribe'
    && hasOnlyKeys(value, ['version', 'type', 'subscriptionId', 'stream'])
    && isNonEmptyString(value.subscriptionId)
    && (value.stream === 'events.mux' || value.stream === 'events.host')) {
    return {
      version: 1,
      type: value.type,
      subscriptionId: DesktopRequestId(value.subscriptionId),
      stream: value.stream,
    }
  }
  if (value.type === 'renderer-unsubscribe'
    && hasOnlyKeys(value, ['version', 'type', 'subscriptionId'])
    && isNonEmptyString(value.subscriptionId)) {
    return { version: 1, type: value.type, subscriptionId: DesktopRequestId(value.subscriptionId) }
  }
  if (value.type === 'host-response' && hasOnlyKeys(value, ['version', 'type', 'requestId', 'bodyId'])
    && hasRequestAndBody(value)) {
    return { version: 1, type: value.type, requestId: DesktopRequestId(value.requestId), bodyId: DesktopBodyId(value.bodyId) }
  }
  throw new DesktopProtocolError(`invalid sidecar inbound control ${JSON.stringify(value.type)}`)
}

function parseSidecarOutboundControlFrame(value: unknown): DesktopSidecarOutboundControlFrame {
  if (!isControlBase(value)) throw new DesktopProtocolError('invalid sidecar outbound control frame')
  if (value.type === 'renderer-result' && hasOnlyKeys(value, ['version', 'type', 'requestId', 'bodyId'])
    && hasRequestAndBody(value)) {
    return { version: 1, type: value.type, requestId: DesktopRequestId(value.requestId), bodyId: DesktopBodyId(value.bodyId) }
  }
  if (value.type === 'renderer-event'
    && hasOnlyKeys(value, ['version', 'type', 'subscriptionId', 'sequence', 'bodyId'])
    && isNonEmptyString(value.subscriptionId)
    && isNatural(value.sequence) && isNonEmptyString(value.bodyId)) {
    return {
      version: 1,
      type: value.type,
      subscriptionId: DesktopRequestId(value.subscriptionId),
      sequence: value.sequence,
      bodyId: DesktopBodyId(value.bodyId),
    }
  }
  if (value.type === 'renderer-end'
    && hasOnlyKeys(value, ['version', 'type', 'subscriptionId', 'bodyId'])
    && isNonEmptyString(value.subscriptionId) && isNonEmptyString(value.bodyId)) {
    return {
      version: 1,
      type: value.type,
      subscriptionId: DesktopRequestId(value.subscriptionId),
      bodyId: DesktopBodyId(value.bodyId),
    }
  }
  if (value.type === 'host-request'
    && hasOnlyKeys(value, ['version', 'type', 'requestId', 'method', 'bodyId'])
    && hasRequestAndBody(value) && value.method === 'directory.pick') {
    return {
      version: 1,
      type: value.type,
      requestId: DesktopRequestId(value.requestId),
      method: value.method,
      bodyId: DesktopBodyId(value.bodyId),
    }
  }
  if (value.type === 'host-cancel' && hasOnlyKeys(value, ['version', 'type', 'requestId'])
    && isNonEmptyString(value.requestId)) {
    return { version: 1, type: value.type, requestId: DesktopRequestId(value.requestId) }
  }
  throw new DesktopProtocolError(`invalid sidecar outbound control ${JSON.stringify(value.type)}`)
}

function parseInvocation(value: unknown): DesktopRendererInvocation {
  if (!isRecord(value)) throw new DesktopProtocolError('renderer invocation is not an object')
  if (value.kind === 'rpc' && typeof value.channel === 'string') {
    const message = clientRequestSchema.safeParse(value.message)
    if (message.success) return { kind: 'rpc', channel: value.channel, message: message.data }
  }
  if (value.kind === 'respond') {
    const message = clientResponseSchema.safeParse(value.message)
    if (message.success) return { kind: 'respond', message: message.data }
  }
  throw new DesktopProtocolError('renderer invocation is invalid')
}

function parseInvocationResult(value: unknown): DesktopRendererInvocationResult {
  if (!isRecord(value)) throw new DesktopProtocolError('renderer result is not an object')
  if (value.kind === 'rpc') {
    const message = serverResponseSchema.safeParse(value.message)
    if (message.success) return { kind: 'rpc', message: message.data }
  }
  if (value.kind === 'respond' && isRpcReceipt(value.receipt)) {
    return { kind: 'respond', receipt: value.receipt }
  }
  throw new DesktopProtocolError('renderer result is invalid')
}

function parseRendererSystemRequest<K extends keyof DesktopRendererSystemMethodMap>(
  _method: K,
  value: unknown,
): DesktopRendererSystemRequest<K> {
  parseEmptyRecord(value, 'desktop.bootManifest')
  return {}
}

function parseRendererSystemResponse(
  method: keyof DesktopRendererSystemMethodMap,
  value: unknown,
): unknown {
  try {
    parseBootManifest(value)
  } catch (error) {
    throw new DesktopProtocolError(`${method} response is invalid: ${String(error)}`)
  }
  return value
}

function parseWireResult(value: unknown): DesktopWireResult<unknown> {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new DesktopProtocolError('correlated result is invalid')
  }
  if (value.ok) return { ok: true, value: value.value }
  if (!isRecord(value.error) || !isWireErrorCode(value.error.code) || typeof value.error.message !== 'string') {
    throw new DesktopProtocolError('correlated error is invalid')
  }
  return { ok: false, error: { code: value.error.code, message: value.error.message } }
}

function isRpcReceipt(value: unknown): value is RpcReceipt {
  return isRecord(value) && typeof value.accepted === 'boolean'
    && (value.accepted || value.reason === 'unknown-rpc' || value.reason === 'bad-response')
}

function isWireErrorCode(value: unknown): value is DesktopWireError['code'] {
  return value === 'aborted' || value === 'bad-request' || value === 'disconnected'
    || value === 'internal' || value === 'not-authorized' || value === 'too-large'
}

function validateHostRequest<K extends keyof HostInitiatedMethodMap>(
  _method: K,
  value: unknown,
): HostInitiatedRequest<K> {
  parseEmptyRecord(value, 'directory.pick')
  return {}
}

function validateHostResponse(_method: keyof HostInitiatedMethodMap, value: unknown): unknown {
  if (!isRecord(value) || !(typeof value.path === 'string' || value.path === null)
    || Object.keys(value).some(key => key !== 'path')) {
    throw new DesktopProtocolError('directory.pick response is invalid')
  }
  return { path: value.path }
}

function wireError(error: unknown, signal: AbortSignal): DesktopWireError {
  if (signal.aborted) return { code: 'aborted', message: 'desktop operation aborted' }
  if (error instanceof DesktopBodyLimitError) return { code: 'too-large', message: error.message }
  if (error instanceof DesktopProtocolError) return { code: 'bad-request', message: error.message }
  if (error instanceof Error && error.name === 'ConnectionRpcAccessError') {
    return { code: 'not-authorized', message: error.message }
  }
  return { code: 'internal', message: normalizeError(error).message }
}

function failure(code: DesktopWireError['code'], message: string): DesktopWireResult<never> {
  return { ok: false, error: { code, message } }
}

function errorFromWire(error: DesktopWireError): Error {
  const result = new Error(error.message)
  result.name = `Desktop${error.code.split('-').map(capitalize).join('')}Error`
  return result
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}

function disconnectedError(): Error {
  const error = new Error('connection-desktop: IPC peer disconnected')
  error.name = 'DesktopDisconnectedError'
  return error
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('desktop operation aborted')
}

function linkedAbort(signal?: AbortSignal): AbortController {
  const abort = new AbortController()
  if (signal?.aborted === true) abort.abort(abortReason(signal))
  else signal?.addEventListener('abort', () => { abort.abort(abortReason(signal)) }, { once: true })
  return abort
}

function rejectedOnAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => { reject(abortReason(signal)) }, { once: true })
  })
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => { finish(() => { reject(abortReason(signal)) }) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => { finish(() => { resolve(value) }) },
      (error: unknown) => { finish(() => { reject(normalizeError(error)) }) },
    )
  })
}

function isControlBase(value: unknown): value is Record<string, unknown> & { version: 1; type: string } {
  return isRecord(value) && value.version === DESKTOP_CONNECTION_PROTOCOL_VERSION && typeof value.type === 'string'
}

function hasRequestAndBody(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { requestId: string; bodyId: string } {
  return isNonEmptyString(value.requestId) && isNonEmptyString(value.bodyId)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isNatural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseEmptyRecord(value: unknown, owner: string): void {
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new DesktopProtocolError(`${owner} payload must be an empty object`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const accepted = new Set(keys)
  return Object.keys(value).every(key => accepted.has(key))
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly readers: Array<{
    resolve: (value: IteratorResult<T>) => void
    reject: (error: unknown) => void
  }> = []
  private terminal: { readonly error?: unknown } | undefined

  push(value: T): void {
    const reader = this.readers.shift()
    if (reader === undefined) this.values.push(value)
    else reader.resolve({ done: false, value })
  }

  end(): void {
    this.terminal = {}
    for (const reader of this.readers.splice(0)) reader.resolve({ done: true, value: undefined })
  }

  fail(error: unknown): void {
    this.terminal = { error }
    for (const reader of this.readers.splice(0)) reader.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() }
  }

  private next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.terminal?.error !== undefined) return Promise.reject(normalizeError(this.terminal.error))
    if (this.terminal !== undefined) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => { this.readers.push({ resolve, reject }) })
  }
}

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
