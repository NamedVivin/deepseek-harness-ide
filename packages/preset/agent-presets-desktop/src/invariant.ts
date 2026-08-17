/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-agent-presets-desktop`.
 * @module @deepseek-ai/dsh-agent-presets-desktop/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { DESKTOP_PRESET_ID } from '@deepseek-ai/dsh-agent-presets-desktop'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-presets-desktop'

/** Cordis companion plugin name. */
export const name = 'agent-presets-desktop-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Every published desktop Agent must have joined the sole admitted preset. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('agent/created', ({ agent }) => {
    const composed = ctx.get('agentPresets')?.composedPreset(agent.ctx)
    if (composed === DESKTOP_PRESET_ID) return
    fail(
      `desktop agent "${agent.id}" was published under preset "${composed ?? 'none'}"; `
      + `every desktop agent must join "${DESKTOP_PRESET_ID}" before publication`,
    )
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant and preset services.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
