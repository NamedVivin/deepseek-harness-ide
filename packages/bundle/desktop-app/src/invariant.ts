/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-desktop-app`.
 * @module @deepseek-ai/dsh-desktop-app/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-desktop-app'

/** Cordis companion plugin name. */
export const name = 'desktop-app-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the package is a static patch-list carrier. The selected transport,
// directory picker, preset policy, and subprocess providers own their live
// relationships and fail independently when their required service is absent.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
