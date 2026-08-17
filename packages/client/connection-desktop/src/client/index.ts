/** Desktop Client provider over the sandboxed preload bridge. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  ClientConnectionRpc,
  ClientConnectionTransport,
  IApiClient,
} from '@deepseek-ai/dsh-client-connection/client'
import type { DesktopRendererBridge } from '../protocol.ts'
import { createDesktopConnectionRpc, DesktopApiClient } from './desktop-api-client.ts'

/** Global bridge slot written by the packaged preload. */
export interface DesktopBridgeGlobal {
  readonly __DSH_DESKTOP__?: DesktopRendererBridge
}

/** Desktop provider for the Client Connection Service Definition. */
export class DesktopClientConnectionTransport extends Service implements ClientConnectionTransport {
  readonly api: IApiClient
  readonly rpc: ClientConnectionRpc
  readonly isLoopback = true

  /**
   * @param ctx - provider-owning Client context.
   * @param bridge - explicit bridge for tests, otherwise the preload global.
   */
  constructor(ctx: Context, bridge = (globalThis as DesktopBridgeGlobal).__DSH_DESKTOP__) {
    super(ctx, 'connectionTransport')
    if (bridge === undefined) {
      throw new Error('connection-desktop: preload bridge is unavailable')
    }
    this.api = new DesktopApiClient(bridge)
    this.rpc = createDesktopConnectionRpc(bridge)
  }
}

/** Provider has no Client service dependencies. */
export const inject: string[] = []

/** @param ctx - Client context receiving the desktop carrier. */
export function apply(ctx: Context): void {
  new DesktopClientConnectionTransport(ctx)
}

export type { DesktopRendererBridge } from '../protocol.ts'
