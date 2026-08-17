/** Immutable `dsh-app://` delivery provider for packaged Client bundles. */

import type { Context } from '@deepseek-ai/cordis'
import {
  ClientModuleDelivery,
  type ClientModuleDeliveryHost,
} from '@deepseek-ai/dsh-client-modules'

/** Stable Cordis plugin name. */
export const name = 'client-modules-desktop'
/** Provider has no service dependencies. */
export const inject: string[] = []

/** Closed packaged-asset mapping used by Electron's read-only protocol. */
export class DesktopClientModuleDelivery extends ClientModuleDelivery {
  private host: ClientModuleDeliveryHost | undefined

  /** @inheritdoc */
  bundleUrl(id: string, revision: string): string {
    return `dsh-app://plugins/${id}/client.js?rev=${revision}`
  }

  /** @inheritdoc */
  install(host: ClientModuleDeliveryHost): () => void {
    if (this.host !== undefined) throw new Error('client-modules-desktop: delivery already installed')
    this.host = host
    return () => {
      if (this.host === host) this.host = undefined
    }
  }

  /** @inheritdoc */
  resolveBundleUrl(url: string): string | undefined {
    const host = this.host
    if (host === undefined) return undefined
    const row = host.graph().entries.find(candidate => candidate.url === url)
    return row === undefined ? undefined : host.clientPath(row.id)
  }
}

/** @param ctx - Host context that receives the desktop delivery service. */
export function apply(ctx: Context): void {
  new DesktopClientModuleDelivery(ctx)
}
