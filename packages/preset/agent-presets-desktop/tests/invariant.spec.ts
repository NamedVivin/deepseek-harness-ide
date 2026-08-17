import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as DesktopPresetInvariant from '../src/invariant.ts'

/** Publish one synthetic Agent against a chosen composed-preset result. */
async function announce(composedPreset: string | undefined): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  ctx.provide('agentPresets', {
    composedPreset: () => composedPreset,
  } as never)
  await ctx.plugin(DesktopPresetInvariant)

  const agent = { id: 'desktop-invariant-agent', ctx: new Context() }
  ctx.emit('agent/created', { agent: agent as never })
}

describe('desktop preset invariant companion', () => {
  it('accepts publication after desktop-default composition', async () => {
    await expect(announce('desktop-default')).resolves.toBeUndefined()
  })

  it.each([
    ['another preset', 'standard'],
    ['no composed preset', undefined],
  ] as const)('rejects publication under %s', async (_label, composedPreset) => {
    await expect(announce(composedPreset)).rejects.toThrow(
      /every desktop agent must join "desktop-default" before publication/u,
    )
  })
})
