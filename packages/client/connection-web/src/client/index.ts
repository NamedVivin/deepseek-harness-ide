/** Browser HTTP/WebSocket provider, including the explicit fixture URL mode. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  ClientConnectionRpc,
  ClientConnectionTransport,
  ClientTransportHooks,
  IApiClient,
} from '@deepseek-ai/dsh-client-connection/client'
import { FixtureApiClient } from './fixture.ts'
import { createWebConnectionRpc } from './rpc.ts'
import { WebApiClient } from './web-api-client.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'

/** Page global carrying the pre-boot carrier override. */
interface ClientTransportGlobal {
  __DSH_TRANSPORT__?: ClientTransportHooks
}

/** Browser provider for the Client Connection Service Definition. */
export class WebClientConnectionTransport extends Service implements ClientConnectionTransport {
  readonly api: IApiClient
  readonly rpc: ClientConnectionRpc
  readonly isLoopback: boolean

  /** @param ctx - provider-owning Client context. */
  constructor(ctx: Context) {
    super(ctx, 'connectionTransport')
    const pageLocation = typeof location === 'undefined' ? undefined : location
    const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
    const fixtureClient = fixture ? new FixtureApiClient() : undefined
    const transport = (globalThis as ClientTransportGlobal).__DSH_TRANSPORT__
    this.api = fixtureClient ?? transport?.createApiClient() ?? new WebApiClient()
    this.rpc = fixtureClient?.rpc ?? createWebConnectionRpc(transport?.fetch)
    this.isLoopback = pageLocation === undefined || isLoopbackHostname(pageLocation.hostname)
  }
}

/** Provider has no Client service dependencies. */
export const inject: string[] = []

/** @param ctx - Client context receiving the Web carrier. */
export function apply(ctx: Context): void {
  new WebClientConnectionTransport(ctx)
}
