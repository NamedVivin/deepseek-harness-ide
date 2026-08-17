import { Context } from '@deepseek-ai/cordis'
import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceRegistrationGateway } from '../src/index.ts'

const workspace = {
  id: 'workspace-1',
  path: '/projects/one',
  title: 'one',
  sessionIds: [],
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:00:00.000Z',
}

class FakeNativePicker extends DirectoryPicker {
  constructor(ctx: Context, private readonly pickImpl: (signal: AbortSignal) => Promise<string | null>) {
    super(ctx)
  }

  capability() {
    return Object.freeze({ kind: 'native' as const, pick: this.pickImpl })
  }
}

class FakeBrowsePicker extends DirectoryPicker {
  capability() {
    return Object.freeze({
      kind: 'browse' as const,
      list: vi.fn(),
      createDirectory: vi.fn(),
    })
  }
}

describe('WorkspaceRegistrationGateway', () => {
  it('registers the native selection and returns the authoritative Workspace', async () => {
    const ctx = new Context()
    const create = vi.fn(async () => workspace)
    new FakeNativePicker(ctx, async () => '/projects/one')
    ctx.provide('workspaceRegistry', { create })
    const gateway = new WorkspaceRegistrationGateway(ctx)

    await expect(gateway.pickAndRegister()).resolves.toEqual({ ok: true, value: { workspace: {
      workspaceId: 'workspace-1',
      path: '/projects/one',
      title: 'one',
      sessionIds: [],
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    } } })
    expect(create).toHaveBeenCalledWith('/projects/one')
    await ctx.fiber.dispose()
  })

  it('does not register cancellation or a non-native backend', async () => {
    const cancelled = new Context()
    const cancelledCreate = vi.fn()
    new FakeNativePicker(cancelled, async () => null)
    cancelled.provide('workspaceRegistry', { create: cancelledCreate })
    await expect(new WorkspaceRegistrationGateway(cancelled).pickAndRegister()).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
    expect(cancelledCreate).not.toHaveBeenCalled()
    await cancelled.fiber.dispose()

    const browse = new Context()
    const browseCreate = vi.fn()
    new FakeBrowsePicker(browse)
    browse.provide('workspaceRegistry', { create: browseCreate })
    await expect(new WorkspaceRegistrationGateway(browse).pickAndRegister()).resolves.toMatchObject({
      ok: false,
      error: { code: 'picker-unavailable' },
    })
    expect(browseCreate).not.toHaveBeenCalled()
    await browse.fiber.dispose()
  })

  it('discards a selection when the caller aborts before registration', async () => {
    const ctx = new Context()
    const controller = new AbortController()
    const create = vi.fn()
    new FakeNativePicker(ctx, async () => {
      controller.abort(new Error('renderer destroyed'))
      return '/projects/late'
    })
    ctx.provide('workspaceRegistry', { create })

    await expect(new WorkspaceRegistrationGateway(ctx).pickAndRegister(controller.signal))
      .rejects.toThrow('renderer destroyed')
    expect(create).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it.each([
    [new Error('picker failed'), 'picker failed'],
    ['picker rejected', 'picker rejected'],
  ])('returns a stable failure when the native picker throws %#', async (failure, message) => {
    const ctx = new Context()
    const create = vi.fn()
    new FakeNativePicker(ctx, async () => { throw failure })
    ctx.provide('workspaceRegistry', { create })

    await expect(new WorkspaceRegistrationGateway(ctx).pickAndRegister()).resolves.toEqual({
      ok: false,
      error: { code: 'registration-failed', message },
    })
    expect(create).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it.each([
    [new Error('registry failed'), 'registry failed'],
    ['registry rejected', 'registry rejected'],
  ])('returns a stable failure when registration throws %#', async (failure, message) => {
    const ctx = new Context()
    new FakeNativePicker(ctx, async () => '/projects/one')
    ctx.provide('workspaceRegistry', { create: async () => { throw failure } })

    await expect(new WorkspaceRegistrationGateway(ctx).pickAndRegister()).resolves.toEqual({
      ok: false,
      error: { code: 'registration-failed', message },
    })
    await ctx.fiber.dispose()
  })

  it('propagates aborts that race picker rejection or registry completion', async () => {
    const pickerContext = new Context()
    const pickerAbort = new AbortController()
    new FakeNativePicker(pickerContext, async () => {
      pickerAbort.abort(new Error('picker caller gone'))
      throw new Error('picker failed')
    })
    pickerContext.provide('workspaceRegistry', { create: vi.fn() })
    await expect(new WorkspaceRegistrationGateway(pickerContext).pickAndRegister(pickerAbort.signal))
      .rejects.toThrow('picker caller gone')
    await pickerContext.fiber.dispose()

    const registryContext = new Context()
    const registryAbort = new AbortController()
    new FakeNativePicker(registryContext, async () => '/projects/one')
    registryContext.provide('workspaceRegistry', {
      create: async () => {
        registryAbort.abort(new Error('registry caller gone'))
        return workspace
      },
    })
    await expect(new WorkspaceRegistrationGateway(registryContext).pickAndRegister(registryAbort.signal))
      .rejects.toThrow('registry caller gone')
    await registryContext.fiber.dispose()
  })
})
