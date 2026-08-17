/** Package-owned invariant companion. @module @deepseek-ai/dsh-client-connection-web/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-connection-web'
/** Cordis companion plugin name. */
export const name = 'client-connection-web-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']
/** No runtime invariant: the core Connection package's required provider injection owns exact cardinality. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['connectionTransport'] })
/** @param ctx - invariant registry context. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
