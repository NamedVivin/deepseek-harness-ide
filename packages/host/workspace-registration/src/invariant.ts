/** Package-owned invariant companion. @module @deepseek-ai/dsh-host-workspace-registration/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-workspace-registration'

/** Cordis companion plugin name. */
export const name = 'host-workspace-registration-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the gateway resolves picker and registry ownership for every operation. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['workspaceRegistration'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
