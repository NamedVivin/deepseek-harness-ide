/** Package-owned invariant companion for the IDE Client plugin. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-ide'

/** Cordis companion plugin name. */
export const name = 'client-ui-ide-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/** No runtime invariant: SlotCore owns registration scope and store-identity validation. */
const install: InvariantInstaller = () => {}

/**
 * Register the package invariant companion.
 * @param ctx - Cordis root carrying the invariant registry.
 * @returns disposer for the package reservation.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
