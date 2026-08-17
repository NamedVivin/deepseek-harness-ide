/**
 * Package-owned invariant companion for the Electron directory picker.
 * @module @deepseek-ai/dsh-host-directory-picker-electron/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-directory-picker-electron'

/** Cordis companion plugin name. */
export const name = 'host-directory-picker-electron-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: required injection and the duplicate-service guard own its live relationship. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['directoryPicker', 'desktopHostBridge'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
