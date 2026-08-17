/** Package-owned invariant companion. @module @deepseek-ai/dsh-client-ui-directory-picker-desktop/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-directory-picker-desktop'

/** Cordis companion plugin name. */
export const name = 'client-ui-directory-picker-desktop-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: slot cardinality and Remote injection own the contribution's relationships. */
const install: InvariantInstaller = () => {}

/**
 * Register the package companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
