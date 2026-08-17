/** IDE Client plugin: shared-store overlay, footer action, and workspace-file Remote face. */

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
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IdeSurface, type IdeFilesInjected } from './IdeSurface.tsx'
import { IdeToggle } from './IdeToggle.tsx'
import { en, zh, type IdeLocaleKey } from './locales.ts'
import { createIdeStoreBridge } from './store.ts'

export { createIdeStore } from './store.ts'
export type { IdeFilesInjected, IdeSurfaceProps } from './IdeSurface.tsx'
export type { IdeToggleProps } from './IdeToggle.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workspace editor and conflict-recovery copy. */
    ide: IdeLocaleKey
  }
}

/** Dictionary namespace owned by the IDE Client plugin. */
const NS = 'ide'

/** Required slot, Remote, workspace, file-opener, and locale services. */
export const inject = ['slots', 'remote', 'remote.workspaceFiles', 'locale', 'workspaces', 'fileOpener']

function transportFailure(method: string, error: { code: string; message: string }): Error {
  return new Error(`workspaceFiles.${method} failed: ${error.code}: ${error.message}`)
}

/**
 * Register the frame overlay and sidebar action against one shared root store handle.
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
  const files = (): IdeFilesInjected => ({
    listFiles,
    readFile,
    saveFile,
    getIdeSnapshot: storeBridge.getSnapshot,
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
    return 'handled'
  })

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'ide',
    order: 10,
    locale: NS,
    store,
    inject: files,
  }, IdeSurface))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'ide',
    order: 10,
    locale: NS,
    store,
  }, IdeToggle))
}
