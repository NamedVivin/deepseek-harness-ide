/** HTTP/WebSocket provider for the carrier-neutral Connection registry. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import {
  clientRequestSchema,
  RpcId,
  type ClientRequest,
  type RpcError,
  type RpcErrorDetailsMap,
  type RpcId as RpcIdType,
  type RpcReceipt,
  type ServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { clientResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import {
  ConnectionRpcAccessError,
  ConnectionRpcHandlerError,
  ConnectionRpcUnavailableError,
  HostConnectionTransport,
  type ConnectionCallerAuthority,
  type ConnectionRpcTarget,
  type HostConnectionTransportHost,
} from '@deepseek-ai/dsh-client-connection'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'
import { assertTrustedAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES, type FetchHandler } from './http-bridge.ts'
import { rejectWebSocketUpgrade, WebSocketDownlinks } from './websocket-downlink.ts'

export { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection-web'
/** Web server required for HTTP routes and WebSocket upgrades. */
export const inject = ['webServer']

/** Web carrier configuration. */
export interface ConnectionWebConfig {
  /** Canonical non-loopback authorities accepted by the browser trust fence. */
  trustedHosts?: string[]
  /** Maximum buffered JSON body for one RPC request. */
  maxRequestBodyBytes?: number
}

/** Validated Web carrier configuration. */
export const Config: z<ConnectionWebConfig> = z.object({
  trustedHosts: z.array(String).default([]),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024
const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** ApiProxy methods confined to loopback because Web trust is not authentication. */
const LOOPBACK_API_METHODS = new Set([
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
])

/** Web Connection transport owning HTTP routes and two downlink upgrades. */
export class WebConnectionTransport extends HostConnectionTransport {
  private readonly trustedHosts: readonly string[]
  private readonly maxRequestBodyBytes: number

  /**
   * @param ctx - provider context carrying the Web server.
   * @param config - resolved trust and body limits.
   */
  constructor(ctx: Context, config: ConnectionWebConfig = {}) {
    super(ctx)
    this.trustedHosts = config.trustedHosts ?? []
    this.maxRequestBodyBytes = config.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
    for (const entry of this.trustedHosts) assertTrustedAuthority(entry)
    assertImageBodyCapacity(ctx, this.maxRequestBodyBytes)
    ctx.inject(['apiProxy'], (apiCtx) => {
      assertImageBodyCapacity(apiCtx, this.maxRequestBodyBytes)
    })
  }

  /** @inheritdoc */
  install(host: HostConnectionTransportHost): () => Promise<void> {
    const removals: Array<() => void | Promise<void>> = []
    const registerRoute = (channel: string): (() => void) => {
      const route: WebRoute = {
        kind: 'prefix',
        path: channel,
        handler: async (req, res) => {
          if (!isTrustedApiRequest(req, this.trustedHosts)) {
            res.writeHead(403)
            res.end('forbidden')
            return
          }
          await bridge(
            req,
            res,
            this.fetchHandler(host, channel),
            this.maxRequestBodyBytes,
          )
        },
      }
      return this.ctx.webServer.register(route)
    }

    removals.push(registerRoute(API_PATH))
    removals.push(host.onChannel(registerRoute))

    const downlinks = new WebSocketDownlinks(host)
    const registerDownlink = (
      path: string,
      handle: WebUpgradeRoute['handler'],
    ): void => {
      removals.push(this.ctx.webServer.registerUpgrade({
        path,
        handler: (req, socket, head) => {
          if (!isTrustedApiRequest(req, this.trustedHosts)) {
            rejectWebSocketUpgrade(socket)
            return
          }
          return handle(req, socket, head)
        },
      }))
    }
    registerDownlink(MUX_EVENTS_PATH, (req, socket, head) => { downlinks.handleMux(req, socket, head) })
    registerDownlink(HOST_EVENTS_PATH, (req, socket, head) => { downlinks.handleHost(req, socket, head) })

    return async () => {
      for (const remove of removals.reverse()) await remove()
      await downlinks.close()
    }
  }

  private fetchHandler(host: HostConnectionTransportHost, channel: string): FetchHandler {
    return {
      fetch: async (request) => {
        const pathname = new URL(request.url).pathname
        if (channel === API_PATH && request.method === 'GET'
          && (pathname === MUX_EVENTS_PATH || pathname === HOST_EVENTS_PATH)) {
          return new Response('upgrade required', {
            status: 426,
            headers: { connection: 'Upgrade', upgrade: 'websocket' },
          })
        }
        if (channel === API_PATH && pathname === `${API_PATH}/respond`) {
          return this.respond(host, request)
        }
        const endpoint = endpointFromPath(channel, pathname)
        const caller: ConnectionCallerAuthority = isTrustedApiRequest(request, [])
          ? 'loopback'
          : 'trusted-host'
        if (channel === API_PATH && endpoint !== undefined && caller !== 'loopback'
          && LOOPBACK_API_METHODS.has(endpoint)) {
          return new Response('forbidden', { status: 403 })
        }
        // ApiProxy read routes carry no ClientRequest envelope, so the logical
        // RPC router cannot represent them. Preserve their physical Fetch contract.
        if (channel === API_PATH && (request.method === 'GET' || request.method === 'HEAD')) {
          const apiProxy = this.ctx.get('apiProxy')
          if (apiProxy !== undefined) return toFetchHandler(apiProxy).fetch(request)
        }
        if (request.method !== 'POST' || endpoint === undefined) {
          return new Response('not found', { status: 404 })
        }
        const json = await readJsonRequest(request)
        if (!json.ok) return json.response
        const body = json.value
        const envelope = clientRequestSchema.safeParse(body)
        if (!envelope.success) return invalidEnvelopeResponse(body, envelope.error.issues)
        const message: ClientRequest = envelope.data
        if (message.method !== endpoint) {
          return errorResponse(message.rpcId, {
            code: 'bad-request',
            message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
            details: { issues: [] },
          })
        }
        try {
          const response = await host.invoke({
            channel,
            message,
            caller,
            signal: request.signal,
            authorize: target => this.authorize(target, caller),
          })
          return Response.json(response)
        } catch (error) {
          if (error instanceof ConnectionRpcAccessError) return new Response('forbidden', { status: 403 })
          if (error instanceof ConnectionRpcUnavailableError) return new Response('not found', { status: 404 })
          if (error instanceof ConnectionRpcHandlerError) {
            return new Response(`handler failure: ${String(error.cause)}`, { status: 500 })
          }
          throw error
        }
      },
    }
  }

  private authorize(target: ConnectionRpcTarget, caller: ConnectionCallerAuthority): boolean {
    return target.kind === 'registered'
      || caller === 'loopback'
      || !LOOPBACK_API_METHODS.has(target.endpoint)
  }

  private async respond(host: HostConnectionTransportHost, request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('not found', { status: 404 })
    const json = await readJsonRequest(request)
    if (!json.ok) return json.response
    const parsed = clientResponseSchema.safeParse(json.value)
    if (!parsed.success) {
      const receipt: RpcReceipt = { accepted: false, reason: 'bad-response' }
      return Response.json(receipt)
    }
    return Response.json(await host.respond(parsed.data, request.signal))
  }
}

async function readJsonRequest(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return { ok: false, response: new Response('content type must be application/json', { status: 415 }) }
  }
  try {
    return { ok: true, value: await request.json() }
  } catch {
    return { ok: false, response: new Response('body is not JSON', { status: 400 }) }
  }
}

/**
 * Provide the Web Connection carrier.
 * @param ctx - Host context carrying the Web server.
 * @param config - resolved carrier configuration.
 */
export function apply(ctx: Context, config?: ConnectionWebConfig): void {
  new WebConnectionTransport(ctx, config)
}

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection-web maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  return segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))
    ? undefined
    : endpoint
}

function invalidEnvelopeResponse(body: unknown, issues: RpcErrorDetailsMap['bad-request']['issues']): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  return errorResponse(typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID, {
    code: 'bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function errorResponse(rpcId: RpcIdType, error: RpcError): Response {
  const body: ServerResponse = {
    type: 'server-response',
    rpcId,
    result: { ok: false, error },
  }
  return Response.json(body)
}
