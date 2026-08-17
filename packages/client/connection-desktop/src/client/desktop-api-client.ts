/** Desktop ApiProxy client over the preload invoke/subscribe capability. */

import {
  clientRequestSchema,
  RpcId,
  type ApiProxy,
  type HostFrame,
  type MuxFrame,
  type RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { clientResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {
  DesktopConnectionStream,
  DesktopRendererBridge,
} from '../protocol.ts'

type FrameParser<F> = { parse(value: unknown): F }

/** Domain API client whose physical operations stay on the preload bridge. */
export class DesktopApiClient extends AbstractApiClient {
  /** @param bridge - sandboxed preload capability. */
  constructor(private readonly bridge: DesktopRendererBridge) {
    super()
  }

  protected async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    if (init?.method !== 'POST' || typeof init.body !== 'string') {
      return new Response('not found', { status: 404 })
    }
    const path = input.pathname
    const signal = init.signal ?? undefined
    let body: unknown
    try {
      body = JSON.parse(init.body) as unknown
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }
    if (path === '/api/respond') {
      const message = clientResponseSchema.parse(body)
      const result = await this.bridge.invoke(
        { kind: 'respond', message },
        signal ?? undefined,
      )
      if (result.kind !== 'respond') throw new Error('connection-desktop: mismatched respond result')
      return Response.json(result.receipt)
    }
    if (!path.startsWith('/api/')) return new Response('not found', { status: 404 })
    const message = clientRequestSchema.parse(body)
    const result = await this.bridge.invoke(
      { kind: 'rpc', channel: '/api', message },
      signal ?? undefined,
    )
    if (result.kind !== 'rpc') throw new Error('connection-desktop: mismatched RPC result')
    return Response.json(result.message)
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readDownlink('events.mux', signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readDownlink('events.host', signal, hostFrameSchema, onOpen)
  }

  private async *readDownlink<F extends MuxFrame | HostFrame>(
    stream: DesktopConnectionStream,
    signal: AbortSignal,
    parser: FrameParser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const source = this.bridge.subscribe(stream, signal)
    onOpen?.()
    for await (const full of source) {
      const frame = parser.parse(full.payload)
      this.onEnvelope(full)
      yield { rpcId: full.rpcId, payload: frame }
    }
  }
}

/**
 * Create generic logical RPC carriage over the preload invoke method.
 * @param bridge - sandboxed preload capability.
 * @returns carrier that owns rpcId minting and correlation.
 */
export function createDesktopConnectionRpc(bridge: DesktopRendererBridge): ClientConnectionRpc {
  return {
    async call(channel, endpoint, payload, signal) {
      assertTarget(channel, endpoint)
      const rpcId = RpcId(randomUuid())
      const result = await bridge.invoke({
        kind: 'rpc',
        channel,
        message: { type: 'client-request', rpcId, method: endpoint, payload },
      }, signal)
      if (result.kind !== 'rpc') throw new Error('connection-desktop: mismatched generic RPC result')
      if (result.message.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${result.message.rpcId}`)
      }
      return result.message.result
    },
  }
}

function assertTarget(channel: string, endpoint: string): void {
  const channelPattern = /^\/[A-Za-z0-9._~-]+$/
  const segmentPattern = /^[A-Za-z0-9_$.-]+$/
  const segments = endpoint.split('/')
  if (!channelPattern.test(channel)
    || segments.some(segment =>
      segment === '' || segment === '.' || segment === '..' || !segmentPattern.test(segment))) {
    throw new Error(`connection-desktop: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
}

function randomUuid(): string {
  return globalThis.crypto.randomUUID()
}
