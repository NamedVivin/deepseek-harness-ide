/** IDE registrations, shared store identity, Remote unwrapping, and unload safety. */

import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {
  SessionId,
  WorkspaceFileVersion,
  WorkspaceId,
} from '@deepseek-ai/dsh-api-remotes/client'
import { apply, inject } from '../src/client/index.ts'
import type { IdeFilesInjected } from '../src/client/IdeSurface.tsx'
import { createIdeStore } from '../src/client/store.ts'
import { apply as nodeApply } from '../src/index.ts'

const workspaceId = 'workspace-1' as WorkspaceId
const fileVersion = 'v1' as WorkspaceFileVersion
const sessionId = 'session-1' as SessionId

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'shell.editor': { kind: 'single', scope: 'root' },
      'conversation.header.utilities': { kind: 'list', scope: 'root' },
    },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))

  const list = vi.fn(() => Promise.resolve({
    ok: true,
    value: { ok: true, value: { directory: [], entries: [] } },
  }))
  const read = vi.fn(() => Promise.resolve({
    ok: true,
    value: { ok: true, value: { path: ['a.ts'], content: 'alpha', version: fileVersion } },
  }))
  const save = vi.fn(() => Promise.resolve({
    ok: true,
    value: { ok: true, value: { path: ['a.ts'], version: 'v2' as WorkspaceFileVersion } },
  }))
  const resolveLocation = vi.fn((request: { location: { line?: number } }) => Promise.resolve({
    ok: true,
    value: {
      ok: true,
      value: {
        segments: ['a.ts'],
        kind: 'file' as const,
        textSupported: true,
        ...(request.location.line === undefined ? {} : { line: request.location.line }),
      },
    },
  }))
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  let editorOpenValue = false
  const editorOpenListeners = new Set<() => void>()
  const openEditor = vi.fn(() => {
    editorOpenValue = true
    for (const listener of editorOpenListeners) listener()
  })
  const closeEditor = vi.fn(() => {
    editorOpenValue = false
    for (const listener of editorOpenListeners) listener()
  })
  ctx.provide('layout', {
    editorOpen: {
      getSnapshot: () => editorOpenValue,
      subscribe: (listener: () => void) => {
        editorOpenListeners.add(listener)
        return () => { editorOpenListeners.delete(listener) }
      },
    },
    toggleSidebar: vi.fn(),
    openDetails: vi.fn(),
    closeDetails: vi.fn(),
    openEditor,
    closeEditor,
  } as never)
  ctx.provide('remote.workspaceFiles', { list, read, save, resolveLocation } as never)
  ctx.provide('workspaces', {
    list: {
      getSnapshot: () => ({
        items: [{
          workspaceId,
          path: '/host/private/workspace',
          title: 'Project',
          sessionIds: [sessionId],
          createdAt: '2026-08-14T00:00:00.000Z',
          updatedAt: '2026-08-14T00:00:00.000Z',
        }],
      }),
      subscribe: () => () => {},
    },
  } as never)
  type Request = { sessionId: SessionId; location: { path: string; line?: number } }
  type Handler = (request: Request) => Promise<'handled' | 'unhandled'>
  class TestFileOpener extends Service {
    private readonly handlers: Handler[] = []

    constructor(serviceCtx: Context) {
      super(serviceCtx, 'fileOpener')
    }

    register(handler: Handler) {
      return this.ctx.effect(() => {
        this.handlers.push(handler)
        return () => {
          const index = this.handlers.indexOf(handler)
          if (index >= 0) this.handlers.splice(index, 1)
        }
      })
    }

    async tryOpen(request: Request) {
      for (const handler of [...this.handlers]) {
        if (await handler(request) === 'handled') return 'handled' as const
      }
      return 'unhandled' as const
    }
  }
  const fileOpener = new TestFileOpener(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return { ctx, fiber, list, read, save, resolveLocation, fileOpener, openEditor, closeEditor }
}

describe('ui-ide Client plugin', () => {
  it('declares only the services its root registrations use', () => {
    expect(inject).toEqual([
      'slots', 'remote', 'remote.workspaceFiles', 'locale', 'workspaces', 'fileOpener',
      'layout',
    ])
  })

  it('registers a store-backed editor pane and a layout-backed header action', async () => {
    const b = await bench()
    await b.fiber.await()
    const editor = b.ctx.slots.entries('shell.editor')[0]
    const action = b.ctx.slots.entries('conversation.header.utilities')[0]
    expect(editor).toBeDefined()
    expect(action?.options).toMatchObject({ id: 'ide', order: 10 })
    expect(editor?.locale).toBe('ide')
    expect(action?.locale).toBe('ide')
    expect(editor?.store).toBeDefined()
    expect(action?.store).toBeUndefined()
  })

  it('unwraps transport results but preserves workspace-file business results', async () => {
    const b = await bench()
    await b.fiber.await()
    const entry = b.ctx.slots.entries('shell.editor')[0]!
    const files = (entry.inject as unknown as () => IdeFilesInjected)()
    await expect(files.listFiles({ workspaceId, directory: [] })).resolves.toEqual({
      ok: true, value: { directory: [], entries: [] },
    })
    await expect(files.readFile({ workspaceId, path: ['a.ts'] })).resolves.toEqual({
      ok: true, value: { path: ['a.ts'], content: 'alpha', version: fileVersion },
    })
    await expect(files.saveFile({
      workspaceId, path: ['a.ts'], content: 'beta', expectedVersion: fileVersion,
    })).resolves.toEqual({ ok: true, value: { path: ['a.ts'], version: 'v2' } })
    expect(b.list).toHaveBeenCalledWith({ workspaceId, directory: [] }, undefined)
    expect(b.read).toHaveBeenCalledWith({ workspaceId, path: ['a.ts'] }, undefined)
    expect(b.save).toHaveBeenCalledWith({
      workspaceId, path: ['a.ts'], content: 'beta', expectedVersion: fileVersion,
    }, undefined)
    expect(files.getIdeSnapshot()).toMatchObject({ tabs: [] })
  })

  it('throws each transport failure before it can be mistaken for a business rejection', async () => {
    const b = await bench()
    b.list.mockResolvedValueOnce({
      ok: false,
      error: { code: 'transport', message: 'list offline', details: {} },
    } as never)
    b.read.mockResolvedValueOnce({
      ok: false,
      error: { code: 'transport', message: 'read offline', details: {} },
    } as never)
    b.save.mockResolvedValueOnce({
      ok: false,
      error: { code: 'transport', message: 'save offline', details: {} },
    } as never)
    await b.fiber.await()
    const files = (b.ctx.slots.entries('shell.editor')[0]!.inject as unknown as () => IdeFilesInjected)()
    await expect(files.listFiles({ workspaceId, directory: [] })).rejects.toThrow(
      'workspaceFiles.list failed: transport: list offline',
    )
    await expect(files.readFile({ workspaceId, path: ['a.ts'] })).rejects.toThrow(
      'workspaceFiles.read failed: transport: read offline',
    )
    await expect(files.saveFile({
      workspaceId, path: ['a.ts'], content: 'beta', expectedVersion: fileVersion,
    })).rejects.toThrow(
      'workspaceFiles.save failed: transport: save offline',
    )
  })

  it('throws a location-resolution transport failure', async () => {
    const b = await bench()
    b.resolveLocation.mockResolvedValueOnce({
      ok: false,
      error: { code: 'transport', message: 'resolver offline', details: {} },
    } as never)
    await b.fiber.await()
    await expect(b.fileOpener.tryOpen({
      sessionId,
      location: { path: 'a.ts' },
    })).rejects.toThrow('workspaceFiles.resolveLocation failed: transport: resolver offline')
  })

  it('routes a complete session location through Host resolution and reuses its tab', async () => {
    const b = await bench()
    await b.fiber.await()
    const entry = b.ctx.slots.entries('shell.editor')[0]!
    const location = { path: '/host/private/workspace/a.ts', line: 17 }

    await expect(b.fileOpener.tryOpen({ sessionId, location })).resolves.toBe('handled')
    expect(b.resolveLocation).toHaveBeenCalledWith({ workspaceId, location })
    const store = (entry.store as ReturnType<typeof createIdeStore>).create()
    expect(store.getSnapshot()).toMatchObject({
      selectedWorkspaceId: workspaceId,
      activeTabId: JSON.stringify([workspaceId, 'a.ts']),
      tabs: [{ segments: ['a.ts'], focusLine: 17, focusRevision: 1 }],
    })
    expect(b.openEditor).toHaveBeenCalledOnce()

    await expect(b.fileOpener.tryOpen({ sessionId, location })).resolves.toBe('handled')
    expect(store.getSnapshot().tabs).toHaveLength(1)
    expect(store.getSnapshot().tabs[0]).toMatchObject({ focusLine: 17, focusRevision: 2 })

    await expect(b.fileOpener.tryOpen({
      sessionId,
      location: { path: '/host/private/workspace/a.ts' },
    })).resolves.toBe('handled')
    expect(store.getSnapshot().tabs[0]).toMatchObject({ focusLine: 17, focusRevision: 2 })
  })

  it('delegates unregistered sessions and unsupported resolved locations', async () => {
    const b = await bench()
    await b.fiber.await()
    await expect(b.fileOpener.tryOpen({
      sessionId: 'other-session' as SessionId,
      location: { path: 'a.ts', line: 4 },
    })).resolves.toBe('unhandled')
    expect(b.resolveLocation).not.toHaveBeenCalled()

    b.resolveLocation.mockResolvedValueOnce({
      ok: true,
      value: {
        ok: true,
        value: { segments: ['image.png'], kind: 'file', textSupported: false },
      },
    })
    await expect(b.fileOpener.tryOpen({
      sessionId,
      location: { path: 'image.png' },
    })).resolves.toBe('unhandled')
  })

  it('retracts its file-opener contribution on unload', async () => {
    const b = await bench()
    await b.fiber.await()
    await b.fiber.dispose()
    await expect(b.fileOpener.tryOpen({
      sessionId,
      location: { path: 'a.ts', line: 2 },
    })).resolves.toBe('unhandled')
  })

  it('removes both root entries and closes the layout column on plugin unload', async () => {
    const b = await bench()
    await b.fiber.await()
    await b.fiber.dispose()
    expect(b.ctx.slots.entries('shell.editor')).toHaveLength(0)
    expect(b.ctx.slots.entries('conversation.header.utilities')).toHaveLength(0)
    expect(b.closeEditor).toHaveBeenCalledOnce()
  })

  it('keeps an inert node-half loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
