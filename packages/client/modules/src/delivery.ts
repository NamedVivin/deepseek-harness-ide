/** Carrier provider contract for Host-discovered Client bundles. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { WebBootGraph } from './client/manifest.ts'

/** Read-only module registry face used by delivery providers. */
export interface ClientModuleDeliveryHost {
  /** Current immutable boot graph. */
  graph(): WebBootGraph
  /** Resolve one graph id to its built Client bundle. */
  clientPath(id: string): string | undefined
  /** Subscribe to graph replacement. */
  onGraphChanged(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Exactly one carrier-specific Client bundle delivery provider. */
    clientModuleDelivery: ClientModuleDelivery
  }
}

/** Service Definition implemented by Web and desktop module-delivery providers. */
export abstract class ClientModuleDelivery extends Service {
  /** @param ctx - provider-owning Host context. */
  constructor(ctx: Context) {
    super(ctx, 'clientModuleDelivery')
  }

  /**
   * Produce the immutable URL advertised for one bundle revision.
   * @param id - Client package id.
   * @param revision - content revision.
   * @returns carrier URL placed in the shared boot manifest.
   */
  abstract bundleUrl(id: string, revision: string): string

  /**
   * Attach physical delivery to the composed registry.
   * @param host - read-only graph and bundle-path source.
   * @returns disposer for routes, protocol mapping, or retained state.
   */
  abstract install(host: ClientModuleDeliveryHost): () => void

  /**
   * Resolve an exact advertised URL to a bundle path.
   * @param url - untrusted physical asset URL.
   * @returns the matched bundle path, or undefined when it is not currently advertised.
   */
  abstract resolveBundleUrl(url: string): string | undefined
}
