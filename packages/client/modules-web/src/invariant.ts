/** Package-owned invariant companion. @module @deepseek-ai/dsh-client-modules-web/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-modules-web'
/** Cordis companion plugin name. */
export const name = 'client-modules-web-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']
/** No runtime invariant: the core registry's required provider injection owns exact cardinality. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['clientModuleDelivery'] })
/** @param ctx - invariant registry context. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
