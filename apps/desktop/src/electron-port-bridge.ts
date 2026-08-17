/** Persistent Electron main/preload MessagePort transport for the desktop Connection bridge. */

import {
  DESKTOP_CONNECTION_PROTOCOL_VERSION,
  DesktopBodyId,
  DesktopRequestId,
  type DesktopBodyFrame,
  type DesktopBodyId as DesktopBodyIdType,
  type DesktopConnectionStream,
  type DesktopMainToRendererBridge,
  type DesktopRendererBridge,
  type DesktopRendererInvocation,
  type DesktopRendererInvocationResult,
  type DesktopRendererLifecycleHost,
  type DesktopRendererLifecycleMethodMap,
  type DesktopRendererSystemMethodMap,
  type DesktopRendererSystemRequest,
  type DesktopRendererSystemResponse,
  type DesktopRequestId as DesktopRequestIdType,
  type DesktopWireError,
  type DesktopWireResult,
} from '@deepseek-ai/dsh-client-connection-desktop/protocol'
import { parseDesktopServerRequest } from '@deepseek-ai/dsh-client-connection-desktop/codec'
import {
  DesktopBodyLimitError,
  DesktopBodyTransport,
  DesktopProtocolError,
  parseDesktopBodyFrame,
  resolveDesktopIpcLimits,
  type DesktopIpcLimitsInput,
} from '@deepseek-ai/dsh-client-connection-desktop/wire'

type DesktopDownlinkEvent = AsyncIterableValue<ReturnType<DesktopRendererBridge['subscribe']>>
type DesktopLifecycleMethod = keyof DesktopRendererLifecycleMethodMap
type DesktopLifecycleRequest = DesktopRendererLifecycleMethodMap['desktop.prepareQuit']['request']
type DesktopLifecycleResponse = DesktopRendererLifecycleMethodMap['desktop.prepareQuit']['response']

type AsyncIterableValue<T> = T extends AsyncIterable<infer V> ? V : never

/** Renderer-to-main controls; application payloads are referenced only by body id. */
export type DesktopRendererPortControlFrame =
  | {
    readonly version: 1
    readonly type: 'port-renderer-invoke'
    readonly requestId: DesktopRequestIdType
    readonly bodyId: DesktopBodyIdType
  }
  | {
    readonly version: 1
    readonly type: 'port-renderer-system'
    readonly requestId: DesktopRequestIdType
    readonly method: keyof DesktopRendererSystemMethodMap
    readonly bodyId: DesktopBodyIdType
  }
  | {
    readonly version: 1
    readonly type: 'port-renderer-cancel'
    readonly requestId: DesktopRequestIdType
  }
  | {
    readonly version: 1
    readonly type: 'port-renderer-subscribe'
    readonly subscriptionId: DesktopRequestIdType
    readonly stream: DesktopConnectionStream
  }
  | {
    readonly version: 1
    readonly type: 'port-renderer-unsubscribe'
    readonly subscriptionId: DesktopRequestIdType
  }
  | {
    readonly version: 1
    readonly type: 'port-lifecycle-result'
    readonly requestId: DesktopRequestIdType
    readonly bodyId: DesktopBodyIdType
  }
  | {
    readonly version: 1
    readonly type: 'port-disconnect'
  }

/** Main-to-renderer controls; application payloads are referenced only by body id. */
type DesktopMainPortControlFrame =
  | {
    readonly version: 1
    readonly type: 'port-renderer-result'
    readonly requestId: DesktopRequestIdType
    readonly bodyId: DesktopBodyIdType
  }
  | {
    readonly version: 1
    readonly type: 'port-renderer-event'
    readonly subscriptionId: DesktopRequestIdType
    readonly sequence: number
    readonly bodyId: DesktopBodyIdType
  }
  | {
    readonly version: 1
    readonly type: 'port-renderer-end'
    readonly subscriptionId: DesktopRequestIdType
    readonly bodyId: DesktopBodyIdType
  }
  | {
    readonly version: 1
    readonly type: 'port-lifecycle-request'
    readonly requestId: DesktopRequestIdType
    readonly method: DesktopLifecycleMethod
    readonly bodyId: DesktopBodyIdType
  }
  | {
    readonly version: 1
    readonly type: 'port-lifecycle-cancel'
    readonly requestId: DesktopRequestIdType
  }
  | {
    readonly version: 1
    readonly type: 'port-disconnect'
  }

/** Closed physical frame set for the persistent main/preload MessagePort. */
export type DesktopPortFrame =
  | DesktopBodyFrame
  | DesktopRendererPortControlFrame
  | DesktopMainPortControlFrame

/** Electron-neutral MessagePort endpoint consumed by both bridge peers. */
export interface DesktopPortEndpoint {
  /** Send one body or closed control frame. */
  send(frame: DesktopPortFrame): void
  /** Install a raw message listener before the port starts delivering queued frames. */
  onMessage(listener: (value: unknown) => void): () => void
  /** Install a physical disconnect listener. */
  onDisconnect(listener: () => void): () => void
  /** Start delivery after bridge listeners have been installed. */
  start(): void
  /** Close the owned persistent port. */
  close(): void
}

/** Structural subset of Electron's main-process `MessagePortMain`. */
export interface ElectronMainMessagePort {
  /** Send one structured-clone value. */
  postMessage(message: unknown): void
  /** Start queued message delivery. */
  start(): void
  /** Close the port. */
  close(): void
  /** Register a message listener. */
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): unknown
  /** Register a close listener. */
  on(event: 'close', listener: () => void): unknown
  /** Remove a message listener. */
  off(event: 'message', listener: (event: { readonly data: unknown }) => void): unknown
  /** Remove a close listener. */
  off(event: 'close', listener: () => void): unknown
}

/** Structural subset of the DOM `MessagePort` exposed to an Electron preload. */
export interface ElectronPreloadMessagePort {
  /** Send one structured-clone value. */
  postMessage(message: unknown): void
  /** Start queued message delivery. */
  start(): void
  /** Close the port. */
  close(): void
  /** Register a port event listener. */
  addEventListener(
    event: 'message' | 'messageerror' | 'close',
    listener: (event: { readonly data?: unknown }) => void,
  ): void
  /** Remove a port event listener. */
  removeEventListener(
    event: 'message' | 'messageerror' | 'close',
    listener: (event: { readonly data?: unknown }) => void,
  ): void
}

/**
 * Adapt an Electron main-process `MessagePortMain` without importing Electron at runtime.
 * @param port - transferred persistent main-process port.
 * @returns endpoint started later by {@link DesktopMainRendererPortBridge}.
 */
export function createElectronMainPortEndpoint(port: ElectronMainMessagePort): DesktopPortEndpoint {
  return {
    send: (frame) => { port.postMessage(frame) },
    onMessage: (listener) => {
      const onMessage = (event: { readonly data: unknown }): void => { listener(event.data) }
      port.on('message', onMessage)
      return () => { port.off('message', onMessage) }
    },
    onDisconnect: (listener) => {
      port.on('close', listener)
      return () => { port.off('close', listener) }
    },
    start: () => { port.start() },
    close: () => { port.close() },
  }
}

/**
 * Adapt the DOM `MessagePort` received by an Electron preload.
 * @param port - transferred persistent preload port.
 * @returns endpoint started later by {@link DesktopPreloadPortBridge}.
 */
export function createElectronPreloadPortEndpoint(
  port: ElectronPreloadMessagePort,
): DesktopPortEndpoint {
  return {
    send: (frame) => { port.postMessage(frame) },
    onMessage: (listener) => {
      const onMessage = (event: { readonly data?: unknown }): void => { listener(event.data) }
      port.addEventListener('message', onMessage)
      return () => { port.removeEventListener('message', onMessage) }
    },
    onDisconnect: (listener) => {
      const onDisconnect = (): void => { listener() }
      port.addEventListener('close', onDisconnect)
      port.addEventListener('messageerror', onDisconnect)
      return () => {
        port.removeEventListener('close', onDisconnect)
        port.removeEventListener('messageerror', onDisconnect)
      }
    },
    start: () => { port.start() },
    close: () => { port.close() },
  }
}

interface PendingPortRequest {
  readonly kind: 'invoke' | 'system' | 'lifecycle'
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly removeAbort: () => void
}

interface MainPortSubscription {
  readonly abort: AbortController
}

interface PreloadPortSubscription {
  readonly queue: AsyncQueue<DesktopDownlinkEvent>
  readonly removeAbort: () => void
  nextSequence: number
}

interface PortTransportSetup {
  readonly bodies: DesktopBodyTransport
  readonly removeMessage: () => void
  readonly removeDisconnect: () => void
}

function setupPortTransport(
  endpoint: DesktopPortEndpoint,
  limits: DesktopIpcLimitsInput,
  onMessage: (value: unknown) => void,
  onDisconnect: () => void,
): PortTransportSetup {
  const resolved = resolveDesktopIpcLimits(limits)
  return {
    bodies: new DesktopBodyTransport((frame) => { endpoint.send(frame) }, resolved),
    removeMessage: endpoint.onMessage(onMessage),
    removeDisconnect: endpoint.onDisconnect(onDisconnect),
  }
}

/** Main-process MessagePort server delegating Connection work to `DesktopMainIpcPeer`. */
export class DesktopMainRendererPortBridge implements DesktopMainToRendererBridge {
  private readonly bodies: DesktopBodyTransport
  private readonly rendererCalls = new Map<DesktopRequestIdType, AbortController>()
  private readonly subscriptions = new Map<DesktopRequestIdType, MainPortSubscription>()
  private readonly lifecycleRequests = new Map<DesktopRequestIdType, PendingPortRequest>()
  private readonly operations = new Set<Promise<void>>()
  private readonly removeMessage: () => void
  private readonly removeDisconnect: () => void
  private connected = true

  /**
   * @param endpoint - endpoint for the transferred renderer port.
   * @param renderer - narrow main-to-sidecar peer, normally `DesktopMainIpcPeer`.
   * @param limits - body, chunk, and shared in-flight limits for this physical hop.
   */
  constructor(
    private readonly endpoint: DesktopPortEndpoint,
    private readonly renderer: DesktopRendererBridge,
    limits: DesktopIpcLimitsInput = {},
  ) {
    const setup = setupPortTransport(endpoint, limits, (value) => {
      try {
        this.handleMessage(value)
      } catch (error) {
        this.failProtocol(error)
      }
    }, () => { this.disconnect(disconnectedError()) })
    this.bodies = setup.bodies
    this.removeMessage = setup.removeMessage
    this.removeDisconnect = setup.removeDisconnect
    endpoint.start()
  }

  /** Current unacknowledged main-to-preload bytes shared by every body. */
  get inflightBytes(): number {
    return this.bodies.inflightBytes
  }

  /** @inheritdoc */
  request<K extends DesktopLifecycleMethod>(
    method: K,
    payload: DesktopRendererLifecycleMethodMap[K]['request'],
    signal?: AbortSignal,
  ): Promise<DesktopRendererLifecycleMethodMap[K]['response']> {
    validateLifecycleMethod(method)
    validateLifecycleRequest(payload)
    return this.startLifecycleRequest(payload, signal)
  }

  /** Close the renderer port and reject or cancel all outstanding operations. */
  async dispose(): Promise<void> {
    await disposePort(
      this.endpoint,
      this.connected,
      this.removeMessage,
      this.removeDisconnect,
      () => { this.disconnect(disconnectedError()) },
      this.operations,
    )
  }

  private startLifecycleRequest(
    payload: DesktopLifecycleRequest,
    signal?: AbortSignal,
  ): Promise<DesktopLifecycleResponse> {
    try {
      this.requireConnected()
    } catch (error) {
      return Promise.reject(normalizeError(error))
    }
    if (signal?.aborted === true) return Promise.reject(abortReason(signal))
    const requestId = DesktopRequestId(globalThis.crypto.randomUUID())
    return new Promise<DesktopLifecycleResponse>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.lifecycleRequests.delete(requestId)) return
        if (this.connected) {
          this.endpoint.send({
            version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
            type: 'port-lifecycle-cancel',
            requestId,
          })
        }
        reject(signal === undefined ? new Error('desktop lifecycle request aborted') : abortReason(signal))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.lifecycleRequests.set(requestId, {
        kind: 'lifecycle',
        resolve: (value) => { resolve(value as DesktopLifecycleResponse) },
        reject,
        removeAbort: () => { signal?.removeEventListener('abort', onAbort) },
      })
      this.track(this.bodies.send(payload, signal).then((bodyId) => {
        if (!this.connected || !this.lifecycleRequests.has(requestId)) return
        this.endpoint.send({
          version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
          type: 'port-lifecycle-request',
          requestId,
          method: 'desktop.prepareQuit',
          bodyId,
        })
      }).catch((error: unknown) => {
        this.rejectPending(this.lifecycleRequests, requestId, error)
      }))
    })
  }

  private handleMessage(value: unknown): void {
    const body = parseDesktopBodyFrame(value)
    if (body !== undefined) {
      this.bodies.accept(body)
      return
    }
    const frame = parseRendererPortControlFrame(value)
    switch (frame.type) {
      case 'port-renderer-invoke':
        this.startRendererInvoke(frame.requestId, this.bodies.take(frame.bodyId))
        return
      case 'port-renderer-system':
        this.startRendererSystem(frame.requestId, frame.method, this.bodies.take(frame.bodyId))
        return
      case 'port-renderer-cancel':
        this.rendererCalls.get(frame.requestId)?.abort(new Error('renderer request cancelled'))
        return
      case 'port-renderer-subscribe':
        this.startSubscription(frame.subscriptionId, frame.stream)
        return
      case 'port-renderer-unsubscribe':
        this.cancelSubscription(frame.subscriptionId)
        return
      case 'port-lifecycle-result':
        this.finishLifecycleRequest(frame.requestId, this.bodies.take(frame.bodyId))
        return
      case 'port-disconnect':
        this.disconnect(disconnectedError())
        return
    }
  }

  private startRendererInvoke(requestId: DesktopRequestIdType, rawInvocation: unknown): void {
    this.ensureNewRendererCall(requestId)
    const invocation = parseRendererInvocation(rawInvocation)
    const abort = new AbortController()
    this.rendererCalls.set(requestId, abort)
    const operation = raceWithAbort(this.renderer.invoke(invocation, abort.signal), abort.signal).then(
      result => this.sendRendererResult(requestId, { ok: true, value: result }, abort.signal),
      (error: unknown) => this.sendRendererFailure(requestId, error, abort),
    ).finally(() => { this.rendererCalls.delete(requestId) })
    this.track(operation)
  }

  private startRendererSystem(
    requestId: DesktopRequestIdType,
    method: keyof DesktopRendererSystemMethodMap,
    rawPayload: unknown,
  ): void {
    this.ensureNewRendererCall(requestId)
    validateRendererSystemRequest(method, rawPayload)
    const abort = new AbortController()
    this.rendererCalls.set(requestId, abort)
    const operation = raceWithAbort(this.renderer.system(method, {}, abort.signal), abort.signal).then(
      result => this.sendRendererResult(requestId, { ok: true, value: result }, abort.signal),
      (error: unknown) => this.sendRendererFailure(requestId, error, abort),
    ).finally(() => { this.rendererCalls.delete(requestId) })
    this.track(operation)
  }

  private ensureNewRendererCall(requestId: DesktopRequestIdType): void {
    if (this.rendererCalls.has(requestId)) {
      throw new DesktopProtocolError(`duplicate renderer request ${JSON.stringify(requestId)}`)
    }
  }

  private async sendRendererFailure(
    requestId: DesktopRequestIdType,
    error: unknown,
    abort: AbortController,
  ): Promise<void> {
    if (abort.signal.aborted) return
    await this.sendRendererResult(
      requestId,
      { ok: false, error: wireError(error, abort.signal) },
      abort.signal,
    )
  }

  private async sendRendererResult(
    requestId: DesktopRequestIdType,
    result: DesktopWireResult<unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    if (cannotSend(this.connected, signal)) return
    const bodyId = await this.bodies.send(result, signal)
    if (cannotSend(this.connected, signal)) return
    this.endpoint.send({
      version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
      type: 'port-renderer-result',
      requestId,
      bodyId,
    })
  }

  private startSubscription(
    subscriptionId: DesktopRequestIdType,
    stream: DesktopConnectionStream,
  ): void {
    if (this.subscriptions.has(subscriptionId)) {
      throw new DesktopProtocolError(`duplicate renderer subscription ${JSON.stringify(subscriptionId)}`)
    }
    const abort = new AbortController()
    this.subscriptions.set(subscriptionId, { abort })
    const operation = this.pumpSubscription(
      subscriptionId,
      this.renderer.subscribe(stream, abort.signal),
      abort,
    ).finally(() => { this.subscriptions.delete(subscriptionId) })
    this.track(operation)
  }

  private cancelSubscription(subscriptionId: DesktopRequestIdType): void {
    const subscription = this.subscriptions.get(subscriptionId)
    if (subscription === undefined) return
    this.subscriptions.delete(subscriptionId)
    subscription.abort.abort(new Error('renderer subscription cancelled'))
  }

  private async pumpSubscription(
    subscriptionId: DesktopRequestIdType,
    source: AsyncIterable<DesktopDownlinkEvent>,
    abort: AbortController,
  ): Promise<void> {
    const iterator = source[Symbol.asyncIterator]()
    let sequence = 0
    try {
      while (true) {
        const item = await raceWithAbort(iterator.next(), abort.signal)
        if (item.done === true) break
        const bodyId = await this.bodies.send(item.value, abort.signal)
        if (!this.connected || abort.signal.aborted) return
        this.endpoint.send({
          version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
          type: 'port-renderer-event',
          subscriptionId,
          sequence: sequence++,
          bodyId,
        })
      }
      await this.sendSubscriptionEnd(subscriptionId, { ok: true, value: {} }, abort.signal)
    } catch (error) {
      if (this.connected && !abort.signal.aborted) {
        await this.sendSubscriptionEnd(
          subscriptionId,
          { ok: false, error: wireError(error, abort.signal) },
          abort.signal,
        )
      }
    } finally {
      abort.abort()
      void iterator.return?.().catch(() => {
        // The source owns cancellation errors after its consumer has ended.
      })
    }
  }

  private async sendSubscriptionEnd(
    subscriptionId: DesktopRequestIdType,
    result: DesktopWireResult<Record<string, never>>,
    signal: AbortSignal,
  ): Promise<void> {
    const bodyId = await this.bodies.send(result, signal)
    if (cannotSend(this.connected, signal)) return
    this.endpoint.send({
      version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
      type: 'port-renderer-end',
      subscriptionId,
      bodyId,
    })
  }

  private finishLifecycleRequest(requestId: DesktopRequestIdType, rawResult: unknown): void {
    const pending = this.lifecycleRequests.get(requestId)
    if (pending === undefined) return
    this.lifecycleRequests.delete(requestId)
    pending.removeAbort()
    const result = parseWireResult(rawResult)
    if (!result.ok) {
      pending.reject(errorFromWire(result.error))
      return
    }
    try {
      pending.resolve(validateLifecycleResponse(result.value))
    } catch (error) {
      pending.reject(error)
    }
  }

  private track(operation: Promise<void>): void {
    trackPortOperation(this.operations, operation, (error) => {
      if (this.connected) this.failProtocol(error)
    })
  }

  private rejectPending(
    pending: Map<DesktopRequestIdType, PendingPortRequest>,
    requestId: DesktopRequestIdType,
    error: unknown,
  ): void {
    const request = pending.get(requestId)
    if (request === undefined) return
    pending.delete(requestId)
    request.removeAbort()
    request.reject(normalizeError(error))
  }

  private requireConnected(): void {
    if (!this.connected) throw disconnectedError()
  }

  private failProtocol(reason: unknown): void {
    this.disconnect(reason)
    this.endpoint.close()
  }

  private disconnect(reason: unknown): void {
    if (!this.connected) return
    this.connected = false
    const error = normalizeError(reason)
    this.bodies.close(error)
    for (const abort of this.rendererCalls.values()) abort.abort(error)
    this.rendererCalls.clear()
    for (const subscription of this.subscriptions.values()) subscription.abort.abort(error)
    this.subscriptions.clear()
    for (const pending of this.lifecycleRequests.values()) {
      pending.removeAbort()
      pending.reject(error)
    }
    this.lifecycleRequests.clear()
  }
}

type LifecycleHandler = (
  payload: DesktopLifecycleRequest,
  signal: AbortSignal,
) => Promise<DesktopLifecycleResponse>

/** Preload MessagePort client exposing only Connection and lifecycle capabilities to the renderer. */
export class DesktopPreloadPortBridge implements DesktopRendererBridge, DesktopRendererLifecycleHost {
  private readonly bodies: DesktopBodyTransport
  private readonly pending = new Map<DesktopRequestIdType, PendingPortRequest>()
  private readonly subscriptions = new Map<DesktopRequestIdType, PreloadPortSubscription>()
  private readonly lifecycleCalls = new Map<DesktopRequestIdType, AbortController>()
  private readonly operations = new Set<Promise<void>>()
  private readonly removeMessage: () => void
  private readonly removeDisconnect: () => void
  private lifecycleHandler: LifecycleHandler | undefined
  private connected = true

  /**
   * @param endpoint - endpoint for the transferred persistent preload port.
   * @param limits - body, chunk, and shared in-flight limits for this physical hop.
   */
  constructor(
    private readonly endpoint: DesktopPortEndpoint,
    limits: DesktopIpcLimitsInput = {},
  ) {
    const resolvedLimits = resolveDesktopIpcLimits(limits)
    this.bodies = new DesktopBodyTransport((frame) => { endpoint.send(frame) }, resolvedLimits)
    this.removeMessage = endpoint.onMessage((value) => {
      try {
        this.handleMessage(value)
      } catch (error) {
        this.failProtocol(error)
      }
    })
    this.removeDisconnect = endpoint.onDisconnect(() => { this.disconnect(disconnectedError()) })
    endpoint.start()
  }

  /** Current unacknowledged preload-to-main bytes shared by every body. */
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
        type: 'port-renderer-invoke',
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
    validateRendererSystemRequest(method, payload)
    return this.startRendererRequest<DesktopRendererSystemResponse<K>>(
      'system',
      payload,
      signal,
      (requestId, bodyId) => ({
        version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
        type: 'port-renderer-system',
        requestId,
        method,
        bodyId,
      }),
    )
  }

  /** @inheritdoc */
  async *subscribe(
    stream: DesktopConnectionStream,
    signal: AbortSignal,
  ): AsyncGenerator<DesktopDownlinkEvent> {
    this.requireConnected()
    validateStream(stream)
    if (signal.aborted) throw abortReason(signal)
    const subscriptionId = DesktopRequestId(globalThis.crypto.randomUUID())
    const queue = new AsyncQueue<DesktopDownlinkEvent>()
    const onAbort = (): void => {
      if (!this.subscriptions.delete(subscriptionId)) return
      if (this.connected) {
        this.endpoint.send({
          version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
          type: 'port-renderer-unsubscribe',
          subscriptionId,
        })
      }
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
      type: 'port-renderer-subscribe',
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
        if (this.connected) {
          this.endpoint.send({
            version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
            type: 'port-renderer-unsubscribe',
            subscriptionId,
          })
        }
      }
    }
  }

  /** @inheritdoc */
  handle<K extends DesktopLifecycleMethod>(
    method: K,
    handler: (
      payload: DesktopRendererLifecycleMethodMap[K]['request'],
      signal: AbortSignal,
    ) => Promise<DesktopRendererLifecycleMethodMap[K]['response']>,
  ): () => void {
    validateLifecycleMethod(method)
    if (this.lifecycleHandler !== undefined) {
      throw new Error(`desktop preload: lifecycle handler already registered for ${method}`)
    }
    const registered = handler
    this.lifecycleHandler = registered
    return () => {
      if (this.lifecycleHandler === registered) this.lifecycleHandler = undefined
    }
  }

  /** Close the main port and reject or cancel all outstanding operations. */
  async dispose(): Promise<void> {
    if (this.connected) {
      this.endpoint.send({ version: DESKTOP_CONNECTION_PROTOCOL_VERSION, type: 'port-disconnect' })
    }
    this.removeMessage()
    this.removeDisconnect()
    this.disconnect(disconnectedError())
    this.endpoint.close()
    await Promise.allSettled([...this.operations])
  }

  private startRendererRequest<T>(
    kind: 'invoke' | 'system',
    payload: unknown,
    signal: AbortSignal | undefined,
    control: (
      requestId: DesktopRequestIdType,
      bodyId: DesktopBodyIdType,
    ) => DesktopRendererPortControlFrame,
  ): Promise<T> {
    try {
      this.requireConnected()
    } catch (error) {
      return Promise.reject(normalizeError(error))
    }
    if (signal?.aborted === true) return Promise.reject(abortReason(signal))
    const requestId = DesktopRequestId(globalThis.crypto.randomUUID())
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.pending.delete(requestId)) return
        if (this.connected) {
          this.endpoint.send({
            version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
            type: 'port-renderer-cancel',
            requestId,
          })
        }
        reject(signal === undefined ? new Error('desktop renderer request aborted') : abortReason(signal))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, {
        kind,
        resolve: (value) => { resolve(value as T) },
        reject,
        removeAbort: () => { signal?.removeEventListener('abort', onAbort) },
      })
      this.track(this.bodies.send(payload, signal).then((bodyId) => {
        if (this.connected && this.pending.has(requestId)) this.endpoint.send(control(requestId, bodyId))
      }).catch((error: unknown) => {
        this.rejectPending(requestId, error)
      }))
    })
  }

  private handleMessage(value: unknown): void {
    const body = parseDesktopBodyFrame(value)
    if (body !== undefined) {
      this.bodies.accept(body)
      return
    }
    const frame = parseMainPortControlFrame(value)
    switch (frame.type) {
      case 'port-renderer-result':
        this.finishRendererRequest(frame.requestId, this.bodies.take(frame.bodyId))
        return
      case 'port-renderer-event':
        this.pushSubscriptionEvent(
          frame.subscriptionId,
          frame.sequence,
          parseDesktopServerRequest(this.bodies.take(frame.bodyId)),
        )
        return
      case 'port-renderer-end':
        this.finishSubscription(frame.subscriptionId, this.bodies.take(frame.bodyId))
        return
      case 'port-lifecycle-request':
        this.startLifecycleCall(
          frame.requestId,
          frame.method,
          this.bodies.take(frame.bodyId),
        )
        return
      case 'port-lifecycle-cancel':
        this.lifecycleCalls.get(frame.requestId)?.abort(new Error('main lifecycle request cancelled'))
        return
      case 'port-disconnect':
        this.disconnect(disconnectedError())
        return
    }
  }

  private finishRendererRequest(requestId: DesktopRequestIdType, rawResult: unknown): void {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    this.pending.delete(requestId)
    pending.removeAbort()
    const result = parseWireResult(rawResult)
    if (!result.ok) {
      pending.reject(errorFromWire(result.error))
      return
    }
    try {
      pending.resolve(pending.kind === 'invoke'
        ? parseRendererInvocationResult(result.value)
        : result.value)
    } catch (error) {
      pending.reject(error)
    }
  }

  private pushSubscriptionEvent(
    subscriptionId: DesktopRequestIdType,
    sequence: number,
    event: DesktopDownlinkEvent,
  ): void {
    const subscription = this.subscriptions.get(subscriptionId)
    if (subscription === undefined) return
    if (sequence !== subscription.nextSequence) {
      throw new DesktopProtocolError(
        `port subscription ${JSON.stringify(subscriptionId)} expected sequence ${String(subscription.nextSequence)}, got ${String(sequence)}`,
      )
    }
    subscription.nextSequence += 1
    subscription.queue.push(event)
  }

  private finishSubscription(subscriptionId: DesktopRequestIdType, rawResult: unknown): void {
    const subscription = this.subscriptions.get(subscriptionId)
    if (subscription === undefined) return
    this.subscriptions.delete(subscriptionId)
    subscription.removeAbort()
    const result = parseWireResult(rawResult)
    if (!result.ok) subscription.queue.fail(errorFromWire(result.error))
    else {
      validateEmptyRecord(result.value, 'port-renderer-end')
      subscription.queue.end()
    }
  }

  private startLifecycleCall(
    requestId: DesktopRequestIdType,
    method: DesktopLifecycleMethod,
    rawPayload: unknown,
  ): void {
    if (this.lifecycleCalls.has(requestId)) {
      throw new DesktopProtocolError(`duplicate lifecycle request ${JSON.stringify(requestId)}`)
    }
    validateLifecycleMethod(method)
    const payload = validateLifecycleRequest(rawPayload)
    const abort = new AbortController()
    this.lifecycleCalls.set(requestId, abort)
    const handler = this.lifecycleHandler
    const operation = (handler === undefined
      ? Promise.reject(new Error(`desktop preload: no lifecycle handler registered for ${method}`))
      : raceWithAbort(handler(payload, abort.signal), abort.signal)).then(
      result => this.sendLifecycleResult(requestId, { ok: true, value: validateLifecycleResponse(result) }, abort.signal),
      (error: unknown) => this.sendLifecycleFailure(requestId, error, abort),
    ).finally(() => { this.lifecycleCalls.delete(requestId) })
    this.track(operation)
  }

  private async sendLifecycleFailure(
    requestId: DesktopRequestIdType,
    error: unknown,
    abort: AbortController,
  ): Promise<void> {
    if (abort.signal.aborted) return
    await this.sendLifecycleResult(
      requestId,
      { ok: false, error: wireError(error, abort.signal) },
      abort.signal,
    )
  }

  private async sendLifecycleResult(
    requestId: DesktopRequestIdType,
    result: DesktopWireResult<DesktopLifecycleResponse>,
    signal: AbortSignal,
  ): Promise<void> {
    if (cannotSend(this.connected, signal)) return
    const bodyId = await this.bodies.send(result, signal)
    if (cannotSend(this.connected, signal)) return
    this.endpoint.send({
      version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
      type: 'port-lifecycle-result',
      requestId,
      bodyId,
    })
  }

  private rejectPending(requestId: DesktopRequestIdType, error: unknown): void {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    this.pending.delete(requestId)
    pending.removeAbort()
    pending.reject(normalizeError(error))
  }

  private track(operation: Promise<void>): void {
    this.operations.add(operation)
    void operation.catch((error: unknown) => {
      if (this.connected) this.failProtocol(error)
    }).finally(() => { this.operations.delete(operation) })
  }

  private requireConnected(): void {
    if (!this.connected) throw disconnectedError()
  }

  private failProtocol(reason: unknown): void {
    this.disconnect(reason)
    this.endpoint.close()
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
    for (const abort of this.lifecycleCalls.values()) abort.abort(error)
    this.lifecycleCalls.clear()
  }
}

async function disposePort(
  endpoint: DesktopPortEndpoint,
  connected: boolean,
  removeMessage: () => void,
  removeDisconnect: () => void,
  disconnect: () => void,
  operations: ReadonlySet<Promise<void>>,
): Promise<void> {
  if (connected) {
    endpoint.send({ version: DESKTOP_CONNECTION_PROTOCOL_VERSION, type: 'port-disconnect' })
  }
  removeMessage()
  removeDisconnect()
  disconnect()
  endpoint.close()
  await Promise.allSettled([...operations])
}

function trackPortOperation(
  operations: Set<Promise<void>>,
  operation: Promise<void>,
  onFailure: (error: unknown) => void,
): void {
  operations.add(operation)
  void operation.catch(onFailure).finally(() => { operations.delete(operation) })
}

function parseRendererPortControlFrame(value: unknown): DesktopRendererPortControlFrame {
  if (!isControlBase(value)) throw new DesktopProtocolError('invalid renderer port control frame')
  if (value.type === 'port-renderer-invoke'
    && hasOnlyKeys(value, ['version', 'type', 'requestId', 'bodyId'])
    && hasRequestAndBody(value)) {
    return {
      version: 1,
      type: value.type,
      requestId: DesktopRequestId(value.requestId),
      bodyId: DesktopBodyId(value.bodyId),
    }
  }
  if (value.type === 'port-renderer-system'
    && hasOnlyKeys(value, ['version', 'type', 'requestId', 'method', 'bodyId'])
    && hasRequestAndBody(value) && value.method === 'desktop.bootManifest') {
    return {
      version: 1,
      type: value.type,
      requestId: DesktopRequestId(value.requestId),
      method: value.method,
      bodyId: DesktopBodyId(value.bodyId),
    }
  }
  if (value.type === 'port-renderer-cancel'
    && hasOnlyKeys(value, ['version', 'type', 'requestId'])
    && isNonEmptyString(value.requestId)) {
    return { version: 1, type: value.type, requestId: DesktopRequestId(value.requestId) }
  }
  if (value.type === 'port-renderer-subscribe'
    && hasOnlyKeys(value, ['version', 'type', 'subscriptionId', 'stream'])
    && isNonEmptyString(value.subscriptionId) && isStream(value.stream)) {
    return {
      version: 1,
      type: value.type,
      subscriptionId: DesktopRequestId(value.subscriptionId),
      stream: value.stream,
    }
  }
  if (value.type === 'port-renderer-unsubscribe'
    && hasOnlyKeys(value, ['version', 'type', 'subscriptionId'])
    && isNonEmptyString(value.subscriptionId)) {
    return { version: 1, type: value.type, subscriptionId: DesktopRequestId(value.subscriptionId) }
  }
  if (value.type === 'port-lifecycle-result'
    && hasOnlyKeys(value, ['version', 'type', 'requestId', 'bodyId'])
    && hasRequestAndBody(value)) {
    return {
      version: 1,
      type: value.type,
      requestId: DesktopRequestId(value.requestId),
      bodyId: DesktopBodyId(value.bodyId),
    }
  }
  if (value.type === 'port-disconnect' && hasOnlyKeys(value, ['version', 'type'])) {
    return { version: 1, type: value.type }
  }
  throw new DesktopProtocolError(`invalid renderer port control ${JSON.stringify(value.type)}`)
}

function parseMainPortControlFrame(value: unknown): DesktopMainPortControlFrame {
  if (!isControlBase(value)) throw new DesktopProtocolError('invalid main port control frame')
  if (value.type === 'port-renderer-result'
    && hasOnlyKeys(value, ['version', 'type', 'requestId', 'bodyId'])
    && hasRequestAndBody(value)) {
    return {
      version: 1,
      type: value.type,
      requestId: DesktopRequestId(value.requestId),
      bodyId: DesktopBodyId(value.bodyId),
    }
  }
  if (value.type === 'port-renderer-event'
    && hasOnlyKeys(value, ['version', 'type', 'subscriptionId', 'sequence', 'bodyId'])
    && isNonEmptyString(value.subscriptionId) && isNatural(value.sequence)
    && isNonEmptyString(value.bodyId)) {
    return {
      version: 1,
      type: value.type,
      subscriptionId: DesktopRequestId(value.subscriptionId),
      sequence: value.sequence,
      bodyId: DesktopBodyId(value.bodyId),
    }
  }
  if (value.type === 'port-renderer-end'
    && hasOnlyKeys(value, ['version', 'type', 'subscriptionId', 'bodyId'])
    && isNonEmptyString(value.subscriptionId) && isNonEmptyString(value.bodyId)) {
    return {
      version: 1,
      type: value.type,
      subscriptionId: DesktopRequestId(value.subscriptionId),
      bodyId: DesktopBodyId(value.bodyId),
    }
  }
  if (value.type === 'port-lifecycle-request'
    && hasOnlyKeys(value, ['version', 'type', 'requestId', 'method', 'bodyId'])
    && hasRequestAndBody(value) && value.method === 'desktop.prepareQuit') {
    return {
      version: 1,
      type: value.type,
      requestId: DesktopRequestId(value.requestId),
      method: value.method,
      bodyId: DesktopBodyId(value.bodyId),
    }
  }
  if (value.type === 'port-lifecycle-cancel'
    && hasOnlyKeys(value, ['version', 'type', 'requestId'])
    && isNonEmptyString(value.requestId)) {
    return { version: 1, type: value.type, requestId: DesktopRequestId(value.requestId) }
  }
  if (value.type === 'port-disconnect' && hasOnlyKeys(value, ['version', 'type'])) {
    return { version: 1, type: value.type }
  }
  throw new DesktopProtocolError(`invalid main port control ${JSON.stringify(value.type)}`)
}

function parseRendererInvocation(value: unknown): DesktopRendererInvocation {
  if (!isRecord(value)) throw new DesktopProtocolError('renderer invocation is not an object')
  if (value.kind === 'rpc'
    && hasOnlyKeys(value, ['kind', 'channel', 'message'])
    && typeof value.channel === 'string' && isClientRequest(value.message)) {
    return { kind: value.kind, channel: value.channel, message: value.message }
  }
  if (value.kind === 'respond'
    && hasOnlyKeys(value, ['kind', 'message'])
    && isClientResponse(value.message)) {
    return { kind: value.kind, message: value.message }
  }
  throw new DesktopProtocolError('renderer invocation is invalid')
}

function parseRendererInvocationResult(value: unknown): DesktopRendererInvocationResult {
  if (!isRecord(value)) throw new DesktopProtocolError('renderer invocation result is not an object')
  if (value.kind === 'rpc'
    && hasOnlyKeys(value, ['kind', 'message'])
    && isServerResponse(value.message)) {
    return { kind: value.kind, message: value.message }
  }
  if (value.kind === 'respond'
    && hasOnlyKeys(value, ['kind', 'receipt'])
    && isRpcReceipt(value.receipt)) {
    return { kind: value.kind, receipt: value.receipt }
  }
  throw new DesktopProtocolError('renderer invocation result is invalid')
}

function isClientRequest(value: unknown): value is Extract<DesktopRendererInvocation, { kind: 'rpc' }>['message'] {
  return isRecord(value) && value.type === 'client-request'
    && hasOnlyKeys(value, ['type', 'rpcId', 'method', 'payload'])
    && isNonEmptyString(value.rpcId) && typeof value.method === 'string'
    && Object.hasOwn(value, 'payload')
}

function isClientResponse(
  value: unknown,
): value is Extract<DesktopRendererInvocation, { kind: 'respond' }>['message'] {
  return isRecord(value) && value.type === 'client-response'
    && hasOnlyKeys(value, ['type', 'rpcId', 'result'])
    && isNonEmptyString(value.rpcId) && isRpcResult(value.result)
}

function isServerResponse(
  value: unknown,
): value is Extract<DesktopRendererInvocationResult, { kind: 'rpc' }>['message'] {
  return isRecord(value) && value.type === 'server-response'
    && hasOnlyKeys(value, ['type', 'rpcId', 'result'])
    && isNonEmptyString(value.rpcId) && isRpcResult(value.result)
}

function isRpcResult(value: unknown): boolean {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (value.ok) return hasOnlyKeys(value, ['ok', 'value'])
  return hasOnlyKeys(value, ['ok', 'error']) && isRecord(value.error)
}

function isRpcReceipt(
  value: unknown,
): value is Extract<DesktopRendererInvocationResult, { kind: 'respond' }>['receipt'] {
  if (!isRecord(value) || !hasOnlyKeys(value, ['accepted', 'reason'])) return false
  if (value.accepted === true) return value.reason === undefined
  return value.accepted === false && (value.reason === 'not-pending' || value.reason === 'bad-response')
}

function validateRendererSystemRequest(
  method: string,
  value: unknown,
): void {
  if (method !== 'desktop.bootManifest') {
    throw new DesktopProtocolError(`unknown renderer system method ${JSON.stringify(method)}`)
  }
  validateEmptyRecord(value, method)
}

function validateLifecycleMethod(method: string): void {
  if (method !== 'desktop.prepareQuit') {
    throw new DesktopProtocolError(`unknown renderer lifecycle method ${JSON.stringify(method)}`)
  }
}

function cannotSend(connected: boolean, signal: AbortSignal): boolean {
  return !connected || signal.aborted
}

function validateLifecycleRequest(value: unknown): DesktopLifecycleRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ['reason']) || !isLifecycleReason(value.reason)) {
    throw new DesktopProtocolError('desktop.prepareQuit request is invalid')
  }
  return { reason: value.reason }
}

function validateLifecycleResponse(value: unknown): DesktopLifecycleResponse {
  if (!isRecord(value) || !hasOnlyKeys(value, ['ready']) || typeof value.ready !== 'boolean') {
    throw new DesktopProtocolError('desktop.prepareQuit response is invalid')
  }
  return { ready: value.ready }
}

function isLifecycleReason(value: unknown): value is DesktopLifecycleRequest['reason'] {
  return value === 'window-close' || value === 'application-quit' || value === 'application-replace'
}

function parseWireResult(value: unknown): DesktopWireResult<unknown> {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new DesktopProtocolError('port correlated result is invalid')
  }
  if (value.ok) {
    if (!hasOnlyKeys(value, ['ok', 'value']) || !Object.hasOwn(value, 'value')) {
      throw new DesktopProtocolError('port correlated success is invalid')
    }
    return { ok: true, value: value.value }
  }
  if (!hasOnlyKeys(value, ['ok', 'error']) || !isRecord(value.error)
    || !hasOnlyKeys(value.error, ['code', 'message'])
    || !isWireErrorCode(value.error.code) || typeof value.error.message !== 'string') {
    throw new DesktopProtocolError('port correlated error is invalid')
  }
  return { ok: false, error: { code: value.error.code, message: value.error.message } }
}

function wireError(error: unknown, signal: AbortSignal): DesktopWireError {
  if (signal.aborted) return { code: 'aborted', message: 'desktop port operation aborted' }
  if (error instanceof DesktopBodyLimitError) return { code: 'too-large', message: error.message }
  if (error instanceof DesktopProtocolError) return { code: 'bad-request', message: error.message }
  if (error instanceof Error && error.name === 'ConnectionRpcAccessError') {
    return { code: 'not-authorized', message: error.message }
  }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}

function errorFromWire(error: DesktopWireError): Error {
  const result = new Error(error.message)
  result.name = `Desktop${error.code.split('-').map(capitalize).join('')}Error`
  return result
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`
}

function isWireErrorCode(value: unknown): value is DesktopWireError['code'] {
  return value === 'aborted' || value === 'bad-request' || value === 'disconnected'
    || value === 'internal' || value === 'not-authorized' || value === 'too-large'
}

function validateStream(value: DesktopConnectionStream): void {
  if (!isStream(value)) throw new DesktopProtocolError(`unknown renderer stream ${JSON.stringify(value)}`)
}

function isStream(value: unknown): value is DesktopConnectionStream {
  return value === 'events.mux' || value === 'events.host'
}

function validateEmptyRecord(value: unknown, owner: string): void {
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new DesktopProtocolError(`${owner} payload must be an empty object`)
  }
}

function isControlBase(value: unknown): value is Record<string, unknown> & { version: 1; type: string } {
  return isRecord(value) && value.version === DESKTOP_CONNECTION_PROTOCOL_VERSION
    && typeof value.type === 'string'
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const accepted = new Set(keys)
  return Object.keys(value).every(key => accepted.has(key))
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('desktop port operation aborted')
}

function disconnectedError(): Error {
  const error = new Error('desktop: renderer MessagePort disconnected')
  error.name = 'DesktopDisconnectedError'
  return error
}

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
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

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly readers: Array<{
    readonly resolve: (value: IteratorResult<T>) => void
    readonly reject: (error: unknown) => void
  }> = []
  private terminal: { readonly error?: unknown } | undefined

  push(value: T): void {
    if (this.terminal !== undefined) return
    const reader = this.readers.shift()
    if (reader === undefined) this.values.push(value)
    else reader.resolve({ done: false, value })
  }

  end(): void {
    if (this.terminal !== undefined) return
    this.terminal = {}
    for (const reader of this.readers.splice(0)) reader.resolve({ done: true, value: undefined })
  }

  fail(error: unknown): void {
    if (this.terminal !== undefined) return
    this.terminal = { error }
    for (const reader of this.readers.splice(0)) reader.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() }
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) return Promise.resolve({ done: false, value: this.values.shift() as T })
    if (this.terminal?.error !== undefined) return Promise.reject(normalizeError(this.terminal.error))
    if (this.terminal !== undefined) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => { this.readers.push({ resolve, reject }) })
  }
}
