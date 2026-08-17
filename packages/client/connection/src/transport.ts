/** Host carrier provider contract for Connection requests and downlinks. */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  ClientRequest,
  ClientResponse,
  RpcReceipt,
  ServerRequest,
  ServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ConnectionRpcAuthority } from './rpc.ts'

/** The two server-initiated streams shared by every physical carrier. */
export type ConnectionStream = 'events.mux' | 'events.host'

/** Caller trust established by one physical transport before dispatch. */
export type ConnectionCallerAuthority = 'trusted-host' | 'loopback'

/** Resolved logical target passed to the carrier's closed authorization policy. */
export type ConnectionRpcTarget =
  | {
    readonly kind: 'registered'
    readonly channel: string
    readonly endpoint: string
    readonly authority: ConnectionRpcAuthority
  }
  | {
    readonly kind: 'api-proxy'
    readonly channel: '/api'
    readonly endpoint: string
  }

/** One decoded request entering the carrier-neutral Host router. */
export interface ConnectionInvokeRequest {
  readonly channel: string
  readonly message: ClientRequest
  readonly caller: ConnectionCallerAuthority
  readonly signal: AbortSignal
  /** Carrier policy evaluated after the exact live target is resolved. */
  readonly authorize: (target: ConnectionRpcTarget) => boolean
}

/** Host router consumed by exactly one physical transport provider. */
export interface HostConnectionTransportHost {
  /**
   * Subscribe to dedicated channel registrations.
   * @param listener - installs physical carriage and returns its disposer.
   * @returns asynchronous disposer for every installed channel route.
   */
  onChannel(listener: (channel: string) => () => void | Promise<void>): () => Promise<void>
  /** Dispatch one decoded client request through the current registry or API Proxy. */
  invoke(request: ConnectionInvokeRequest): Promise<ServerResponse>
  /** Deliver a client response to a pending server request. */
  respond(message: ClientResponse, signal: AbortSignal): Promise<RpcReceipt>
  /** Open one of the two shared server-request streams. */
  subscribe(stream: ConnectionStream, signal: AbortSignal): AsyncIterable<ServerRequest>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Exactly one carrier-specific Host Connection provider. */
    connectionTransport: HostConnectionTransport
  }
}

/** Service Definition implemented by the Web and desktop Connection providers. */
export abstract class HostConnectionTransport extends Service {
  /** @param ctx - provider-owning Host context. */
  constructor(ctx: Context) {
    super(ctx, 'connectionTransport')
  }

  /**
   * Attach physical routes or IPC handlers to the core router.
   * @param host - carrier-neutral request and event owner.
   * @returns disposer that reaches transport quiescence.
   */
  abstract install(host: HostConnectionTransportHost): () => void | Promise<void>
}
