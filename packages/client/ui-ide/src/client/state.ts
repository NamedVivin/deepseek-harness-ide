/** Pure IDE interaction state: tab identity, buffer revisions, save fencing, and recovery prompts. */

import type {
  WorkspaceFileSegments,
  WorkspaceFileVersion,
  WorkspaceId,
} from '@deepseek-ai/dsh-api-remotes/client'

/** Stable serialized identity for one workspace-relative editor tab. */
export type IdeTabId = string

/** One in-flight compare-and-swap submission captured before transport work begins. */
export interface IdeSaveAttempt {
  readonly content: string
  readonly expectedVersion: WorkspaceFileVersion
  readonly revision: number
  readonly closeAfterSave: boolean
}

/** Latest disk snapshot retained beside the user's local buffer after a conflict. */
export interface IdeConflict {
  readonly diskContent: string
  readonly diskVersion: WorkspaceFileVersion
}

/** One workspace-relative text tab. */
export interface IdeTab {
  readonly id: IdeTabId
  readonly workspaceId: WorkspaceId
  readonly segments: WorkspaceFileSegments
  readonly title: string
  readonly phase: 'loading' | 'ready' | 'error'
  readonly baseContent: string
  readonly baseVersion: WorkspaceFileVersion | undefined
  readonly content: string
  /** Monotonic local edit account used to fence save acknowledgements. */
  readonly revision: number
  readonly dirty: boolean
  readonly save: IdeSaveAttempt | undefined
  readonly conflict: IdeConflict | undefined
  readonly error: string | undefined
  readonly preview: boolean
  readonly focusLine: number | undefined
  /** Monotonic request account that repeats a reveal even for the same line. */
  readonly focusRevision: number
}

/** Root-scoped editor state shared by the docked surface and file opener. */
export interface IdeState {
  readonly selectedWorkspaceId: WorkspaceId | undefined
  readonly tabs: readonly IdeTab[]
  readonly activeTabId: IdeTabId | undefined
  readonly pendingCloseTabId: IdeTabId | undefined
  readonly pendingReloadTabId: IdeTabId | undefined
  readonly pendingWorkspaceId: WorkspaceId | undefined
  /** File-opener route resumed after an explicit dirty-workspace decision. */
  readonly pendingOpen: {
    readonly workspaceId: WorkspaceId
    readonly segments: WorkspaceFileSegments
    readonly line?: number
  } | undefined
}

/** Input vocabulary of the pure IDE reducer. */
export type IdeAction =
  | { readonly type: 'request-workspace'; readonly workspaceId: WorkspaceId }
  | { readonly type: 'cancel-workspace' }
  | { readonly type: 'discard-workspace' }
  | { readonly type: 'finish-workspace-if-clean' }
  | {
    readonly type: 'begin-open'
    readonly workspaceId: WorkspaceId
    readonly segments: WorkspaceFileSegments
    readonly line?: number
  }
  | {
    readonly type: 'open-succeeded'
    readonly id: IdeTabId
    readonly content: string
    readonly version: WorkspaceFileVersion
  }
  | { readonly type: 'open-failed'; readonly id: IdeTabId; readonly error: string }
  | { readonly type: 'activate-tab'; readonly id: IdeTabId }
  | { readonly type: 'edit-tab'; readonly id: IdeTabId; readonly content: string }
  | { readonly type: 'toggle-preview'; readonly id: IdeTabId }
  | { readonly type: 'save-started'; readonly id: IdeTabId; readonly attempt: IdeSaveAttempt }
  | { readonly type: 'save-succeeded'; readonly id: IdeTabId; readonly version: WorkspaceFileVersion }
  | { readonly type: 'save-failed'; readonly id: IdeTabId; readonly error: string }
  | {
    readonly type: 'save-conflicted'
    readonly id: IdeTabId
    readonly diskContent: string
    readonly diskVersion: WorkspaceFileVersion
  }
  | { readonly type: 'continue-conflict'; readonly id: IdeTabId }
  | { readonly type: 'request-reload'; readonly id: IdeTabId }
  | { readonly type: 'cancel-reload' }
  | { readonly type: 'confirm-reload' }
  | { readonly type: 'request-close'; readonly id: IdeTabId }
  | { readonly type: 'cancel-close' }
  | { readonly type: 'discard-close' }

/** Empty IDE state for one root store instance. */
export const INITIAL_IDE_STATE: IdeState = Object.freeze({
  selectedWorkspaceId: undefined,
  tabs: Object.freeze([]),
  activeTabId: undefined,
  pendingCloseTabId: undefined,
  pendingReloadTabId: undefined,
  pendingWorkspaceId: undefined,
  pendingOpen: undefined,
})

/**
 * Build the collision-free identity of a Host-issued workspace plus canonical segments.
 * @param workspaceId - Host-issued workspace authority.
 * @param segments - Canonical relative path segments.
 * @returns stable tab id.
 */
export function ideTabId(workspaceId: WorkspaceId, segments: WorkspaceFileSegments): IdeTabId {
  return JSON.stringify([workspaceId, ...segments])
}

function replaceTab(state: IdeState, id: IdeTabId, update: (tab: IdeTab) => IdeTab): IdeState {
  const index = state.tabs.findIndex(tab => tab.id === id)
  if (index < 0) return state
  const tabs = [...state.tabs]
  tabs[index] = update(state.tabs[index] as IdeTab)
  return { ...state, tabs }
}

function activateAfterRemoval(tabs: readonly IdeTab[], removedIndex: number): IdeTabId | undefined {
  return tabs[Math.min(removedIndex, tabs.length - 1)]?.id
}

function removeTab(state: IdeState, id: IdeTabId): IdeState {
  const index = state.tabs.findIndex(tab => tab.id === id)
  const tabs = state.tabs.filter(tab => tab.id !== id)
  return {
    ...state,
    tabs,
    activeTabId: state.activeTabId === id ? activateAfterRemoval(tabs, index) : state.activeTabId,
    pendingCloseTabId: state.pendingCloseTabId === id ? undefined : state.pendingCloseTabId,
    pendingReloadTabId: state.pendingReloadTabId === id ? undefined : state.pendingReloadTabId,
  }
}

function switchWorkspace(state: IdeState, workspaceId: WorkspaceId): IdeState {
  return {
    ...state,
    selectedWorkspaceId: workspaceId,
    tabs: [],
    activeTabId: undefined,
    pendingCloseTabId: undefined,
    pendingReloadTabId: undefined,
    pendingWorkspaceId: undefined,
    pendingOpen: undefined,
  }
}

function beginOpen(
  state: IdeState,
  workspaceId: WorkspaceId,
  segments: WorkspaceFileSegments,
  line?: number,
): IdeState {
  const id = ideTabId(workspaceId, segments)
  if (state.tabs.some(tab => tab.id === id)) {
    const active = { ...state, activeTabId: id }
    return line === undefined
      ? active
      : replaceTab(active, id, tab => ({
        ...tab,
        focusLine: line,
        focusRevision: tab.focusRevision + 1,
      }))
  }
  const title = segments.at(-1) ?? ''
  const tab: IdeTab = {
    id,
    workspaceId,
    segments: Object.freeze([...segments]),
    title,
    phase: 'loading',
    baseContent: '',
    baseVersion: undefined,
    content: '',
    revision: 0,
    dirty: false,
    save: undefined,
    conflict: undefined,
    error: undefined,
    preview: false,
    focusLine: line,
    focusRevision: line === undefined ? 0 : 1,
  }
  return { ...state, tabs: [...state.tabs, tab], activeTabId: id }
}

function finishWorkspaceChange(state: IdeState, workspaceId: WorkspaceId): IdeState {
  const pendingOpen = state.pendingOpen
  const switched = switchWorkspace(state, workspaceId)
  return pendingOpen?.workspaceId === workspaceId
    ? beginOpen(switched, workspaceId, pendingOpen.segments, pendingOpen.line)
    : switched
}

function assertNever(_action: never): never {
  throw new Error('unreachable IDE action')
}

/**
 * Apply one IDE interaction without I/O. Async callers dispatch the captured
 * submission and its later acknowledgement as separate actions.
 * @param state - current immutable interaction state.
 * @param action - one deterministic transition.
 * @returns next immutable state.
 */
export function reduceIdeState(state: IdeState, action: IdeAction): IdeState {
  switch (action.type) {
    case 'request-workspace': {
      if (state.selectedWorkspaceId === action.workspaceId) return state
      if (state.tabs.some(tab => tab.dirty || tab.save !== undefined)) {
        return { ...state, pendingWorkspaceId: action.workspaceId, pendingOpen: undefined }
      }
      return switchWorkspace(state, action.workspaceId)
    }
    case 'cancel-workspace':
      return { ...state, pendingWorkspaceId: undefined, pendingOpen: undefined }
    case 'discard-workspace':
      return state.pendingWorkspaceId === undefined
        ? state
        : finishWorkspaceChange(state, state.pendingWorkspaceId)
    case 'finish-workspace-if-clean':
      return state.pendingWorkspaceId !== undefined
        && state.tabs.every(tab => !tab.dirty && tab.save === undefined && tab.conflict === undefined)
        ? finishWorkspaceChange(state, state.pendingWorkspaceId)
        : state
    case 'begin-open': {
      if (state.selectedWorkspaceId !== action.workspaceId) {
        if (state.tabs.some(tab => tab.dirty || tab.save !== undefined)) {
          return {
            ...state,
            pendingWorkspaceId: action.workspaceId,
            pendingOpen: {
              workspaceId: action.workspaceId,
              segments: Object.freeze([...action.segments]),
              ...(action.line === undefined ? {} : { line: action.line }),
            },
          }
        }
        return beginOpen(
          switchWorkspace(state, action.workspaceId),
          action.workspaceId,
          action.segments,
          action.line,
        )
      }
      return beginOpen(state, action.workspaceId, action.segments, action.line)
    }
    case 'open-succeeded':
      return replaceTab(state, action.id, tab => ({
        ...tab,
        phase: 'ready',
        baseContent: action.content,
        baseVersion: action.version,
        content: action.content,
        revision: 0,
        dirty: false,
        error: undefined,
      }))
    case 'open-failed':
      return replaceTab(state, action.id, tab => ({ ...tab, phase: 'error', error: action.error }))
    case 'activate-tab':
      return state.tabs.some(tab => tab.id === action.id) ? { ...state, activeTabId: action.id } : state
    case 'edit-tab':
      return replaceTab(state, action.id, (tab) => {
        if (tab.phase !== 'ready' || tab.content === action.content) return tab
        return {
          ...tab,
          content: action.content,
          revision: tab.revision + 1,
          dirty: action.content !== tab.baseContent,
          error: undefined,
        }
      })
    case 'toggle-preview':
      return replaceTab(state, action.id, tab => ({ ...tab, preview: !tab.preview }))
    case 'save-started':
      return replaceTab(state, action.id, tab => ({ ...tab, save: action.attempt, error: undefined }))
    case 'save-succeeded': {
      const tab = state.tabs.find(candidate => candidate.id === action.id)
      if (tab?.save === undefined) return state
      const attempt = tab.save
      const next = replaceTab(state, action.id, current => ({
        ...current,
        baseContent: attempt.content,
        baseVersion: action.version,
        dirty: current.content !== attempt.content || current.revision !== attempt.revision,
        save: undefined,
        conflict: undefined,
        error: undefined,
      }))
      const saved = next.tabs.find(candidate => candidate.id === action.id)
      return attempt.closeAfterSave && saved?.dirty === false ? removeTab(next, action.id) : next
    }
    case 'save-failed':
      return replaceTab(state, action.id, tab => ({ ...tab, save: undefined, error: action.error }))
    case 'save-conflicted':
      return replaceTab(state, action.id, tab => ({
        ...tab,
        save: undefined,
        conflict: { diskContent: action.diskContent, diskVersion: action.diskVersion },
        error: undefined,
      }))
    case 'continue-conflict':
      return replaceTab(state, action.id, tab => ({ ...tab, conflict: undefined }))
    case 'request-reload': {
      const tab = state.tabs.find(candidate => candidate.id === action.id)
      return tab?.conflict === undefined ? state : { ...state, pendingReloadTabId: action.id }
    }
    case 'cancel-reload':
      return { ...state, pendingReloadTabId: undefined }
    case 'confirm-reload': {
      const id = state.pendingReloadTabId
      if (id === undefined) return state
      return replaceTab({ ...state, pendingReloadTabId: undefined }, id, (tab) => {
        if (tab.conflict === undefined) return tab
        return {
          ...tab,
          baseContent: tab.conflict.diskContent,
          baseVersion: tab.conflict.diskVersion,
          content: tab.conflict.diskContent,
          revision: tab.revision + 1,
          dirty: false,
          conflict: undefined,
          error: undefined,
        }
      })
    }
    case 'request-close': {
      const tab = state.tabs.find(candidate => candidate.id === action.id)
      if (tab === undefined) return state
      return tab.dirty || tab.save !== undefined
        ? { ...state, pendingCloseTabId: action.id }
        : removeTab(state, action.id)
    }
    case 'cancel-close':
      return { ...state, pendingCloseTabId: undefined }
    case 'discard-close':
      return state.pendingCloseTabId === undefined
        ? state
        : removeTab(state, state.pendingCloseTabId)
    default:
      return assertNever(action)
  }
}
