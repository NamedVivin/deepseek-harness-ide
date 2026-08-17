/** Client carrier provider contract consumed by the Connection controller plugin. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { ClientConnectionRpc } from '../rpc.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Exactly one carrier-specific Client Connection provider. */
    connectionTransport: ClientConnectionTransport
  }
}

/** Service Definition implemented by Web and desktop Client carriers. */
export abstract class ClientConnectionTransport extends Service {
  /** @param ctx - provider-owning Client context. */
  constructor(ctx: Context) {
    super(ctx, 'connectionTransport')
  }

  /** Domain API client over this carrier. */
  abstract readonly api: IApiClient
  /** Generic logical RPC caller over this carrier. */
  abstract readonly rpc: ClientConnectionRpc
  /** Whether this carrier represents a loopback-local Host. */
  abstract readonly isLoopback: boolean
}
