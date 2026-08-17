import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as WorkspaceFilesInvariant from '../src/invariant.ts'

describe('workspace-files invariant companion', () => {
  it('reserves package ownership around a live workspaceFiles service', async () => {
    const ctx = new Context()
    ctx.provide('workspaceFiles', {})
    await ctx.plugin(InvariantRegistry, { enabled: true })

    const fiber = ctx.plugin(WorkspaceFilesInvariant)
    await expect(fiber.await()).resolves.toBeDefined()
    await fiber.dispose()
    await expect(ctx.plugin(WorkspaceFilesInvariant).await()).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
