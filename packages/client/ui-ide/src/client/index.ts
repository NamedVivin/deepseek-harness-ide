/** IDE Client plugin: docked editor pane, header action, and workspace-file Remote face. */

import type {
  WorkspaceFilesListRequest,
  WorkspaceFilesListValue,
  WorkspaceFilesReadRequest,
  WorkspaceFilesReadValue,
  WorkspaceFilesResult,
  WorkspaceFilesSaveRequest,
  WorkspaceFilesSaveValue,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IdeSurface, type IdeFilesInjected, type IdeSurfaceInjected } from './IdeSurface.tsx'
import { IdeToggle, type IdeToggleInjected } from './IdeToggle.tsx'
import { en, zh, type IdeLocaleKey } from './locales.ts'
import { createIdeStoreBridge } from './store.ts'

export { createIdeStore } from './store.ts'
export type { IdeFilesInjected, IdeSurfaceInjected, IdeSurfaceProps } from './IdeSurface.tsx'
export type { IdeToggleInjected, IdeToggleProps } from './IdeToggle.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workspace editor and conflict-recovery copy. */
    ide: IdeLocaleKey
  }
}

/** Dictionary namespace owned by the IDE Client plugin. */
const NS = 'ide'

/** Required slot, Remote, workspace, file-opener, and locale services. */
export const inject = ['slots', 'remote', 'remote.workspaceFiles', 'locale', 'workspaces', 'fileOpener', 'layout']

function transportFailure(method: string, error: { code: string; message: string }): Error {
  return new Error(`workspaceFiles.${method} failed: ${error.code}: ${error.message}`)
}

/**
 * Register the docked editor pane, header action, and file-opening route.
 * @param ctx - Client root carrying the generated workspace-file Remote.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-ide: dictionaries')
  const storeBridge = createIdeStoreBridge()
  const store = storeBridge.handle

  const listFiles: IdeFilesInjected['listFiles'] = async (
    request: WorkspaceFilesListRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilesResult<WorkspaceFilesListValue>> => {
    const result = await ctx.remote.workspaceFiles.list(request, signal)
    if (!result.ok) throw transportFailure('list', result.error)
    return result.value
  }
  const readFile: IdeFilesInjected['readFile'] = async (
    request: WorkspaceFilesReadRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilesResult<WorkspaceFilesReadValue>> => {
    const result = await ctx.remote.workspaceFiles.read(request, signal)
    if (!result.ok) throw transportFailure('read', result.error)
    return result.value
  }
  const saveFile: IdeFilesInjected['saveFile'] = async (
    request: WorkspaceFilesSaveRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilesResult<WorkspaceFilesSaveValue>> => {
    const result = await ctx.remote.workspaceFiles.save(request, signal)
    if (!result.ok) throw transportFailure('save', result.error)
    return result.value
  }
  const surface = (): IdeSurfaceInjected => ({
    listFiles,
    readFile,
    saveFile,
    getIdeSnapshot: storeBridge.getSnapshot,
    openEditor: () => { ctx.layout.openEditor() },
    closeEditor: () => { ctx.layout.closeEditor() },
  })
  const toggle = (): IdeToggleInjected => ({
    hooks: { editorOpen: ctx.layout.editorOpen },
    openEditor: () => { ctx.layout.openEditor() },
  })

  ctx.fileOpener.register(async ({ sessionId, location }) => {
    const workspace = ctx.workspaces.list.getSnapshot().items
      .find(candidate => candidate.sessionIds.includes(sessionId))
    if (workspace === undefined) return 'unhandled'
    const transport = await ctx.remote.workspaceFiles.resolveLocation({
      workspaceId: workspace.workspaceId,
      location,
    })
    if (!transport.ok) throw transportFailure('resolveLocation', transport.error)
    const resolved = transport.value
    if (!resolved.ok || resolved.value.kind !== 'file' || !resolved.value.textSupported) return 'unhandled'
    storeBridge.dispatch({
      type: 'begin-open',
      workspaceId: workspace.workspaceId,
      segments: resolved.value.segments,
      ...(resolved.value.line === undefined ? {} : { line: resolved.value.line }),
    })
    ctx.layout.openEditor()
    return 'handled'
  })

  ctx.slots.inject('shell.editor', () => ctx.slots.register({
    name: 'shell.editor',
    locale: NS,
    store,
    inject: surface,
  }, IdeSurface))

  ctx.slots.inject('conversation.header.utilities', () => ctx.slots.register({
    name: 'conversation.header.utilities',
    id: 'ide',
    order: 10,
    locale: NS,
    inject: toggle,
  }, IdeToggle))

  ctx.effect(() => () => { ctx.layout.closeEditor() }, 'ui-ide: close editor column on unload')
}
