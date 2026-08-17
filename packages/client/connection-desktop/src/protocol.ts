/** Typed desktop Connection protocol shared by sidecar, Electron main, and preload adapters. */

import type {
  ClientRequest,
  ClientResponse,
  RpcReceipt,
  ServerRequest,
  ServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'

/** The two server-request streams available to a desktop renderer. */
export type DesktopConnectionStream = 'events.mux' | 'events.host'

/** Current desktop IPC protocol version. */
export const DESKTOP_CONNECTION_PROTOCOL_VERSION = 1

/** Correlation id minted by the side initiating an IPC operation. */
export type DesktopRequestId = Branded<'DesktopRequestId'>

/**
 * Brand an already validated non-empty correlation id.
 * @param value - validated wire id.
 * @returns branded request id.
 */
export const DesktopRequestId = (value: string): DesktopRequestId => value as DesktopRequestId

/** Correlation id for one independently framed UTF-8 JSON body. */
export type DesktopBodyId = Branded<'DesktopBodyId'>

/**
 * Brand an already validated non-empty body id.
 * @param value - validated wire id.
 * @returns branded body id.
 */
export const DesktopBodyId = (value: string): DesktopBodyId => value as DesktopBodyId

/** Renderer calls accepted by the sidecar transport before method policy. */
export type DesktopRendererInvocation =
  | {
    readonly kind: 'rpc'
    readonly channel: string
    readonly message: ClientRequest
  }
  | {
    readonly kind: 'respond'
    readonly message: ClientResponse
  }

/** Sidecar result corresponding to one renderer invocation. */
export type DesktopRendererInvocationResult =
  | {
    readonly kind: 'rpc'
    readonly message: ServerResponse
  }
  | {
    readonly kind: 'respond'
    readonly receipt: RpcReceipt
  }

/** Closed renderer-to-sidecar system method set, separate from ApiProxy RPC. */
export interface DesktopRendererSystemMethodMap {
  /** Read the immutable Client module graph used to bootstrap the packaged renderer. */
  'desktop.bootManifest': {
    readonly request: Record<string, never>
    readonly response: WebBootGraph
  }
}

/** Request payload for one renderer-to-sidecar system method. */
export type DesktopRendererSystemRequest<K extends keyof DesktopRendererSystemMethodMap> =
  DesktopRendererSystemMethodMap[K]['request']

/** Response payload for one renderer-to-sidecar system method. */
export type DesktopRendererSystemResponse<K extends keyof DesktopRendererSystemMethodMap> =
  DesktopRendererSystemMethodMap[K]['response']

/** Closed sidecar-to-Electron main capability set. */
export interface HostInitiatedMethodMap {
  /** Open the native directory chooser and return no path when it is cancelled. */
  'directory.pick': {
    readonly request: Record<string, never>
    readonly response: { readonly path: string | null }
  }
}

/** Request payload for one Host-initiated main-process capability. */
export type HostInitiatedRequest<K extends keyof HostInitiatedMethodMap> =
  HostInitiatedMethodMap[K]['request']

/** Response payload for one Host-initiated main-process capability. */
export type HostInitiatedResponse<K extends keyof HostInitiatedMethodMap> =
  HostInitiatedMethodMap[K]['response']

/** Closed Electron-main-to-renderer lifecycle method set owned by the desktop shell. */
export interface DesktopRendererLifecycleMethodMap {
  /** Ask the renderer to resolve dirty state before a window or application closes. */
  'desktop.prepareQuit': {
    readonly request: {
      readonly reason: 'window-close' | 'application-quit' | 'application-replace'
    }
    readonly response: {
      readonly ready: boolean
    }
  }
}

/** Plain downlink completion copied through Electron context isolation. */
export type DesktopPreloadStreamEnd =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

/**
 * Closed contextBridge-safe function table. AbortSignal and AsyncIterable are
 * reconstructed in the renderer main world instead of crossing isolation.
 */
export interface DesktopPreloadApi {
  /** Invoke one renderer RPC under a renderer-minted cancellation id. */
  invoke(id: string, invocation: DesktopRendererInvocation): Promise<DesktopRendererInvocationResult>
  /** Invoke the closed boot-manifest system method under a cancellation id. */
  system(
    id: string,
    method: 'desktop.bootManifest',
    payload: DesktopRendererSystemMethodMap['desktop.bootManifest']['request'],
  ): Promise<DesktopRendererSystemMethodMap['desktop.bootManifest']['response']>
  /** Cancel one pending invoke or system request. */
  cancel(id: string): void
  /** Pump one typed downlink through contextBridge-proxied callbacks. */
  subscribe(
    id: string,
    stream: DesktopConnectionStream,
    onEvent: (event: ServerRequest) => void,
    onEnd: (result: DesktopPreloadStreamEnd) => void,
  ): void
  /** Cancel one downlink pump. */
  unsubscribe(id: string): void
  /** Register the sole lifecycle callback pair used by the main-world adapter. */
  registerLifecycle(
    onRequest: (
      id: string,
      payload: DesktopRendererLifecycleMethodMap['desktop.prepareQuit']['request'],
    ) => void,
    onCancel: (id: string) => void,
  ): void
  /** Settle one main-initiated prepare-quit request. */
  settleLifecycle(
    id: string,
    response: DesktopRendererLifecycleMethodMap['desktop.prepareQuit']['response'],
  ): void
}

/** Exact metadata sent with the transferred preload MessagePort. */
export interface DesktopPortHandoff {
  readonly version: 1
  readonly limits: {
    readonly maxDesktopBodyBytes: number
    readonly maxDesktopChunkBytes: number
    readonly maxDesktopInflightBytes: number
  }
}

/** Stable failures delivered across the desktop IPC hop. */
export interface DesktopWireError {
  readonly code: 'aborted' | 'bad-request' | 'disconnected' | 'internal' | 'not-authorized' | 'too-large'
  readonly message: string
}

/** Success/error result used by correlated IPC responses. */
export type DesktopWireResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DesktopWireError }

/** Frames for one bounded UTF-8 JSON body; payloads never appear in control frames. */
export type DesktopBodyFrame =
  | {
    readonly version: 1
    readonly type: 'body-start'
    readonly bodyId: DesktopBodyId
    readonly byteLength: number
  }
  | {
    readonly version: 1
    readonly type: 'body-chunk'
    readonly bodyId: DesktopBodyId
    readonly sequence: number
    readonly chunk: Uint8Array
  }
  | {
    readonly version: 1
    readonly type: 'body-ack'
    readonly bodyId: DesktopBodyId
    readonly sequence: number
    readonly byteLength: number
  }
  | {
    readonly version: 1
    readonly type: 'body-end'
    readonly bodyId: DesktopBodyId
  }
  | {
    readonly version: 1
    readonly type: 'body-cancel'
    readonly bodyId: DesktopBodyId
  }

/** Control frames accepted by the sidecar from Electron main. */
export type DesktopSidecarInboundControlFrame =
  | {
    readonly version: 1
    readonly type: 'renderer-invoke'
    readonly requestId: DesktopRequestId
    readonly bodyId: DesktopBodyId
  }
  | {
    readonly version: 1
    readonly type: 'renderer-system'
    readonly requestId: DesktopRequestId
    readonly method: keyof DesktopRendererSystemMethodMap
    readonly bodyId: DesktopBodyId
  }
  | {
    readonly version: 1
    readonly type: 'renderer-cancel'
    readonly requestId: DesktopRequestId
  }
  | {
    readonly version: 1
    readonly type: 'renderer-subscribe'
    readonly subscriptionId: DesktopRequestId
    readonly stream: DesktopConnectionStream
  }
  | {
    readonly version: 1
    readonly type: 'renderer-unsubscribe'
    readonly subscriptionId: DesktopRequestId
  }
  | {
    readonly version: 1
    readonly type: 'host-response'
    readonly requestId: DesktopRequestId
    readonly bodyId: DesktopBodyId
  }

/** Control frames emitted by the sidecar to Electron main. */
export type DesktopSidecarOutboundControlFrame =
  | {
    readonly version: 1
    readonly type: 'renderer-result'
    readonly requestId: DesktopRequestId
    readonly bodyId: DesktopBodyId
  }
  | {
    readonly version: 1
    readonly type: 'renderer-event'
    readonly subscriptionId: DesktopRequestId
    readonly sequence: number
    readonly bodyId: DesktopBodyId
  }
  | {
    readonly version: 1
    readonly type: 'renderer-end'
    readonly subscriptionId: DesktopRequestId
    readonly bodyId: DesktopBodyId
  }
  | {
    readonly version: 1
    readonly type: 'host-request'
    readonly requestId: DesktopRequestId
    readonly method: keyof HostInitiatedMethodMap
    readonly bodyId: DesktopBodyId
  }
  | {
    readonly version: 1
    readonly type: 'host-cancel'
    readonly requestId: DesktopRequestId
  }

/** Frames accepted by the sidecar from Electron main. */
export type DesktopSidecarInboundFrame = DesktopSidecarInboundControlFrame | DesktopBodyFrame

/** Frames emitted by the sidecar to Electron main. */
export type DesktopSidecarOutboundFrame = DesktopSidecarOutboundControlFrame | DesktopBodyFrame

/** Preload capability consumed by the desktop Client provider. */
export interface DesktopRendererBridge {
  /** Invoke one versioned ApiProxy or registered-channel request. */
  invoke(
    invocation: DesktopRendererInvocation,
    signal?: AbortSignal,
  ): Promise<DesktopRendererInvocationResult>
  /** Invoke one closed renderer-to-sidecar system method. */
  system<K extends keyof DesktopRendererSystemMethodMap>(
    method: K,
    payload: DesktopRendererSystemRequest<K>,
    signal?: AbortSignal,
  ): Promise<DesktopRendererSystemResponse<K>>
  /** Subscribe to one typed downlink until cancellation or transport loss. */
  subscribe(stream: DesktopConnectionStream, signal: AbortSignal): AsyncIterable<ServerRequest>
}

/** Sidecar transport handlers installed by the desktop Connection provider. */
export interface DesktopIpcHost {
  /** Execute a renderer invocation with transport-owned cancellation. */
  invoke(
    invocation: DesktopRendererInvocation,
    signal: AbortSignal,
  ): Promise<DesktopRendererInvocationResult>
  /** Execute one closed system method without entering ApiProxy dispatch. */
  system<K extends keyof DesktopRendererSystemMethodMap>(
    method: K,
    payload: DesktopRendererSystemRequest<K>,
    signal: AbortSignal,
  ): Promise<DesktopRendererSystemResponse<K>>
  /** Open one typed downlink with transport-owned cancellation. */
  subscribe(stream: DesktopConnectionStream, signal: AbortSignal): AsyncIterable<ServerRequest>
}

/** Physical sidecar IPC adapter used by the desktop provider and Host bridge. */
export interface DesktopIpcAdapter {
  /** Install the renderer-call and subscription handlers. */
  install(host: DesktopIpcHost): () => void | Promise<void>
  /** Invoke one sidecar-to-main capability on the separate Host request table. */
  requestHost<K extends keyof HostInitiatedMethodMap>(
    method: K,
    payload: HostInitiatedRequest<K>,
    signal?: AbortSignal,
  ): Promise<HostInitiatedResponse<K>>
}

/** Sidecar endpoint implemented by its Node child `process` object. */
export interface DesktopMessageEndpoint {
  /** Send one validated sidecar-to-main frame. */
  send(frame: DesktopSidecarOutboundFrame): void
  /** Subscribe to raw main-to-sidecar messages; the adapter validates each value. */
  onMessage(listener: (value: unknown) => void): () => void
  /** Subscribe to peer loss. */
  onDisconnect(listener: () => void): () => void
}

/** Electron-main endpoint implemented by its Node `ChildProcess` object. */
export interface DesktopMainMessageEndpoint {
  /** Send one validated main-to-sidecar frame. */
  send(frame: DesktopSidecarInboundFrame): void
  /** Subscribe to raw sidecar-to-main messages; the peer validates each value. */
  onMessage(listener: (value: unknown) => void): () => void
  /** Subscribe to peer loss. */
  onDisconnect(listener: () => void): () => void
}

/** Electron-main capability handlers kept separate from renderer RPC policy. */
export interface DesktopMainHandlers {
  /** Native directory chooser implementation. */
  'directory.pick'(
    payload: HostInitiatedRequest<'directory.pick'>,
    signal: AbortSignal,
  ): Promise<HostInitiatedResponse<'directory.pick'>>
}

/** Electron-main lifecycle caller exposed by the app-owned preload bridge. */
export interface DesktopMainToRendererBridge {
  /** Invoke one closed renderer lifecycle method. */
  request<K extends keyof DesktopRendererLifecycleMethodMap>(
    method: K,
    payload: DesktopRendererLifecycleMethodMap[K]['request'],
    signal?: AbortSignal,
  ): Promise<DesktopRendererLifecycleMethodMap[K]['response']>
}

/** Renderer lifecycle handler registry implemented by the app-owned preload bridge. */
export interface DesktopRendererLifecycleHost {
  /** Register the sole handler for one closed renderer lifecycle method. */
  handle<K extends keyof DesktopRendererLifecycleMethodMap>(
    method: K,
    handler: (
      payload: DesktopRendererLifecycleMethodMap[K]['request'],
      signal: AbortSignal,
    ) => Promise<DesktopRendererLifecycleMethodMap[K]['response']>,
  ): () => void
}
