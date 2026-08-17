/** Carrier-neutral Host request routing and event-stream multiplexing. */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  RpcId,
  serverResponseSchema,
  type ClientResponse,
  type HostFrame,
  type MuxFrame,
  type RpcReceipt,
  type ServerRequest,
  type ServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type {
  ConnectionRpcEndpointMatcher,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'
import type {
  ConnectionInvokeRequest,
  ConnectionRpcTarget,
  ConnectionStream,
  HostConnectionTransportHost,
} from './transport.ts'

const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface ConnectionRpcRegistration {
  readonly handler: ConnectionRpcHandler
  readonly options: ConnectionRpcHandlerOptions
}

interface ConnectionRpcInterceptor extends ConnectionRpcRegistration {
  readonly matches: ConnectionRpcEndpointMatcher
}

/** Stable failure thrown when no live RPC implementation owns a request. */
export class ConnectionRpcUnavailableError extends Error {
  /** @param target - rejected logical channel and endpoint. */
  constructor(readonly target: string) {
    super(`connection: RPC target ${JSON.stringify(target)} is unavailable`)
    this.name = 'ConnectionRpcUnavailableError'
  }
}

/** Stable failure thrown before an unauthorized target reaches business code. */
export class ConnectionRpcAccessError extends Error {
  /** @param target - rejected logical channel and endpoint. */
  constructor(readonly target: string) {
    super(`connection: RPC target ${JSON.stringify(target)} is not authorized by this carrier`)
    this.name = 'ConnectionRpcAccessError'
  }
}

/** Stable failure for a business dispatcher that threw instead of returning an RpcResult. */
export class ConnectionRpcHandlerError extends Error {
  /**
   * @param target - logical target whose handler failed.
   * @param cause - contained implementation failure.
   */
  constructor(readonly target: string, cause: unknown) {
    super(`connection: RPC handler ${JSON.stringify(target)} failed`, { cause })
    this.name = 'ConnectionRpcHandlerError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection registry and carrier-neutral request router. */
    connection: HostConnectionHandle
  }
}

/** Host Connection service whose registrations and transport attachment follow Cordis fibers. */
export class HostConnectionService extends Service implements HostConnectionHandle, HostConnectionTransportHost {
  static inject = ['connectionTransport']

  private readonly channels = new Map<string, ConnectionRpcRegistration>()
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly channelListeners = new Set<(channel: string) => () => void | Promise<void>>()

  /** @param ctx - owning core Connection plugin context with exactly one transport provider. */
  constructor(ctx: Context) {
    super(ctx, 'connection')
    ctx.effect(
      () => ctx.connectionTransport.install(this),
      'client-connection: physical transport',
    )
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler, options) => this.register(owner, channel, handler, options),
      intercept: (channel, matches, handler, options) =>
        this.registerInterceptor(owner, channel, matches, handler, options),
    }
  }

  /** @inheritdoc */
  onChannel(listener: (channel: string) => () => void | Promise<void>): () => Promise<void> {
    const removals: Array<() => void | Promise<void>> = []
    for (const channel of this.channels.keys()) removals.push(listener(channel))
    this.channelListeners.add(listener)
    return async () => {
      this.channelListeners.delete(listener)
      for (const remove of removals.reverse()) await remove()
    }
  }

  /** @inheritdoc */
  async invoke(request: ConnectionInvokeRequest): Promise<ServerResponse> {
    const { channel, message } = request
    assertTarget(channel, message.method)
    const targetPath = `${channel}/${message.method}`
    let target: ConnectionRpcTarget
    let registration: ConnectionRpcRegistration | undefined

    if (channel === '/api') {
      const interceptor = this.interceptors.get(channel)
      if (interceptor !== undefined && interceptor.matches(message.method)) {
        target = {
          kind: 'registered',
          channel,
          endpoint: message.method,
          authority: interceptor.options.authority,
        }
        registration = interceptor
      } else {
        target = { kind: 'api-proxy', channel, endpoint: message.method }
      }
    } else {
      registration = this.channels.get(channel)
      if (registration === undefined) throw new ConnectionRpcUnavailableError(targetPath)
      target = {
        kind: 'registered',
        channel,
        endpoint: message.method,
        authority: registration.options.authority,
      }
    }

    if (!request.authorize(target)) throw new ConnectionRpcAccessError(targetPath)
    if (target.kind === 'registered') {
      if (target.authority === 'loopback' && request.caller !== 'loopback') {
        throw new ConnectionRpcAccessError(targetPath)
      }
      try {
        const result = await (registration as ConnectionRpcRegistration).handler(
          message.method,
          message.payload,
          request.signal,
        )
        return { type: 'server-response', rpcId: message.rpcId, result }
      } catch (error) {
        throw new ConnectionRpcHandlerError(targetPath, error)
      }
    }

    const apiProxy = this.ctx.get('apiProxy')
    if (apiProxy === undefined) throw new ConnectionRpcUnavailableError(targetPath)
    const response = await toFetchHandler(apiProxy).fetch(new Request(
      `http://dsh.internal/api/${message.method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
        signal: request.signal,
      },
    ))
    if (!response.ok) {
      if (response.status === 404) throw new ConnectionRpcUnavailableError(targetPath)
      throw new ConnectionRpcHandlerError(targetPath, await response.text())
    }
    return serverResponseSchema.parse(await response.json())
  }

  /** @inheritdoc */
  async respond(message: ClientResponse, signal: AbortSignal): Promise<RpcReceipt> {
    if (signal.aborted) throw abortReason(signal)
    const apiProxy = this.ctx.get('apiProxy')
    if (apiProxy === undefined) throw new ConnectionRpcUnavailableError('/api/respond')
    return apiProxy.respond(message)
  }

  /** @inheritdoc */
  subscribe(stream: ConnectionStream, signal: AbortSignal): AsyncIterable<ServerRequest> {
    const apiProxy = this.ctx.get('apiProxy')
    if (apiProxy === undefined) throw new ConnectionRpcUnavailableError(`/api/${stream}`)
    const source = stream === 'events.mux'
      ? apiProxy.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, signal)
      : apiProxy.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, signal)
    return completeFrames(source)
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    assertChannel(channel)
    return owner.effect(() => {
      if (this.channels.has(channel)) {
        throw new Error(`connection: RPC channel ${JSON.stringify(channel)} already has a handler`)
      }
      const registration = { handler, options }
      this.channels.set(channel, registration)
      const removals: Array<() => void | Promise<void>> = []
      try {
        for (const listener of this.channelListeners) removals.push(listener(channel))
      } catch (error) {
        this.channels.delete(channel)
        for (const remove of removals.reverse()) void remove()
        throw error
      }
      return async () => {
        if (this.channels.get(channel) === registration) this.channels.delete(channel)
        for (const remove of removals.reverse()) await remove()
      }
    }, `client-connection: ${channel} RPC channel`)
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    if (channel !== '/api') {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor = { matches, handler, options }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        if (this.interceptors.get(channel) === interceptor) this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} RPC interceptor`)
  }
}

async function* completeFrames(
  source: AsyncIterable<{ rpcId: ReturnType<typeof RpcId>; payload: MuxFrame | HostFrame }>,
): AsyncGenerator<ServerRequest> {
  for await (const frame of source) {
    yield {
      type: 'server-request',
      rpcId: frame.rpcId,
      method: frame.payload.type,
      payload: frame.payload,
    }
  }
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}

function assertTarget(channel: string, endpoint: string): void {
  const segments = endpoint.split('/')
  if ((channel !== '/api' && !CHANNEL_PATTERN.test(channel))
    || segments.some(segment =>
      segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    throw new ConnectionRpcUnavailableError(`${channel}/${endpoint}`)
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('connection request aborted')
}
