/** Carrier-neutral Host Connection registry and dispatch plugin. */

import type { Context } from '@deepseek-ai/cordis'
import {
  ConnectionRpcAccessError,
  ConnectionRpcHandlerError,
  ConnectionRpcUnavailableError,
  HostConnectionService,
} from './rpc-host.ts'

export type {
  ConnectionRpcAuthority,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'
export type {
  ConnectionCallerAuthority,
  ConnectionInvokeRequest,
  ConnectionRpcTarget,
  ConnectionStream,
  HostConnectionTransportHost,
} from './transport.ts'
export { HostConnectionTransport } from './transport.ts'
export {
  ConnectionRpcAccessError,
  ConnectionRpcHandlerError,
  ConnectionRpcUnavailableError,
  HostConnectionService,
}

/** Stable Cordis plugin name. */
export const name = 'client-connection'
/** Exactly one carrier provider is required before the core registry starts. */
export const inject = ['connectionTransport']

/**
 * Provide the carrier-neutral Host registry and attach the selected transport.
 * @param ctx - Host context carrying exactly one Connection provider.
 */
export function apply(ctx: Context): void {
  new HostConnectionService(ctx)
}

export default HostConnectionService
