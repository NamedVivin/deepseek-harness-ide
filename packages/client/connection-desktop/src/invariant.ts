/** Package-owned invariant companion. @module @deepseek-ai/dsh-client-connection-desktop/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-connection-desktop'
/** Cordis companion plugin name. */
export const name = 'client-connection-desktop-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']
/** No runtime invariant: required injection owns the carrier and Host-request bridge relationship. */
const install: InvariantInstaller = Object.assign(() => {}, {
  inject: ['connectionTransport', 'desktopHostBridge'],
})
/** @param ctx - invariant registry context. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
