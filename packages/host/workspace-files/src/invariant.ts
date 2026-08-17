/** Package-owned invariant companion. @module @deepseek-ai/dsh-host-workspace-files/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-workspace-files'

/** Cordis companion plugin name. */
export const name = 'host-workspace-files-invariant'
/** Services required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: every request resolves its workspace, filesystem root,
 * target containment, and current file version inside one gateway operation.
 */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['workspaceFiles'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

