import { describe, expect, it } from 'vitest'
import type { WorkspaceFileVersion, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import {
  INITIAL_IDE_STATE,
  ideTabId,
  reduceIdeState,
  type IdeAction,
  type IdeState,
} from '../src/client/state.ts'
import { createIdeStoreBridge } from '../src/client/store.ts'

const workspace = (value: string): WorkspaceId => value as WorkspaceId
const version = (value: string): WorkspaceFileVersion => value as WorkspaceFileVersion

function reduce(state: IdeState, ...actions: IdeAction[]): IdeState {
  return actions.reduce(reduceIdeState, state)
}

function opened(content = 'base', path = ['src', 'a.ts']): { state: IdeState; id: string } {
  const id = ideTabId(workspace('w1'), path)
  const state = reduce(
    INITIAL_IDE_STATE,
    { type: 'request-workspace', workspaceId: workspace('w1') },
    { type: 'begin-open', workspaceId: workspace('w1'), segments: path },
    { type: 'open-succeeded', id, content, version: version('v1') },
  )
  return { state, id }
}

describe('IDE state reducer', () => {
  it('uses the full Workspace id and segment sequence as tab identity and reuses an open tab', () => {
    expect(ideTabId(workspace('a/b'), ['c'])).not.toBe(ideTabId(workspace('a'), ['b', 'c']))
    const first = opened()
    const state = reduce(first.state, {
      type: 'begin-open', workspaceId: workspace('w1'), segments: ['src', 'a.ts'], line: 8,
    })
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTabId).toBe(first.id)
    expect(state.tabs[0]).toMatchObject({ focusLine: 8, focusRevision: 1 })
    const repeated = reduce(state, {
      type: 'begin-open', workspaceId: workspace('w1'), segments: ['src', 'a.ts'], line: 8,
    })
    expect(repeated.tabs[0]).toMatchObject({ focusLine: 8, focusRevision: 2 })
  })

  it('tracks local revisions and derives dirty from the acknowledged base', () => {
    const first = opened()
    const edited = reduce(first.state, { type: 'edit-tab', id: first.id, content: 'next' })
    expect(edited.tabs[0]).toMatchObject({ content: 'next', revision: 1, dirty: true })
    const returned = reduce(edited, { type: 'edit-tab', id: first.id, content: 'base' })
    expect(returned.tabs[0]).toMatchObject({ content: 'base', revision: 2, dirty: false })
  })

  it('advances the base but keeps a newer edit dirty when save acknowledgement arrives', () => {
    const first = opened()
    const edited = reduce(first.state, { type: 'edit-tab', id: first.id, content: 'submitted' })
    const tab = edited.tabs[0]!
    const saving = reduce(edited, {
      type: 'save-started',
      id: first.id,
      attempt: { content: tab.content, revision: tab.revision, expectedVersion: version('v1'), closeAfterSave: false },
    })
    const typed = reduce(saving, { type: 'edit-tab', id: first.id, content: 'newer' })
    const saved = reduce(typed, { type: 'save-succeeded', id: first.id, version: version('v2') })
    expect(saved.tabs[0]).toMatchObject({
      baseContent: 'submitted', baseVersion: 'v2', content: 'newer', revision: 2, dirty: true, save: undefined,
    })
  })

  it('closes after a clean save but keeps the close prompt when the user types during it', () => {
    const first = opened()
    const edited = reduce(first.state, { type: 'edit-tab', id: first.id, content: 'submitted' })
    const tab = edited.tabs[0]!
    const prompt = reduce(edited, { type: 'request-close', id: first.id })
    const saving = reduce(prompt, {
      type: 'save-started', id: first.id,
      attempt: { content: tab.content, revision: tab.revision, expectedVersion: version('v1'), closeAfterSave: true },
    })
    expect(reduce(saving, { type: 'save-succeeded', id: first.id, version: version('v2') }).tabs).toHaveLength(0)

    const typed = reduce(saving, { type: 'edit-tab', id: first.id, content: 'later' })
    const saved = reduce(typed, { type: 'save-succeeded', id: first.id, version: version('v2') })
    expect(saved.tabs).toHaveLength(1)
    expect(saved.tabs[0]).toMatchObject({ content: 'later', dirty: true })
    expect(saved.pendingCloseTabId).toBe(first.id)
  })

  it('preserves the local buffer on save failure and retains both sides of a conflict', () => {
    const first = opened()
    const edited = reduce(first.state, { type: 'edit-tab', id: first.id, content: 'local' })
    const tab = edited.tabs[0]!
    const saving = reduce(edited, {
      type: 'save-started', id: first.id,
      attempt: { content: tab.content, revision: tab.revision, expectedVersion: version('v1'), closeAfterSave: false },
    })
    const failed = reduce(saving, { type: 'save-failed', id: first.id, error: 'offline' })
    expect(failed.tabs[0]).toMatchObject({ content: 'local', dirty: true, error: 'offline', save: undefined })

    const conflicted = reduce(saving, {
      type: 'save-conflicted', id: first.id, diskContent: 'disk', diskVersion: version('v9'),
    })
    expect(conflicted.tabs[0]).toMatchObject({
      content: 'local', baseContent: 'base', dirty: true,
      conflict: { diskContent: 'disk', diskVersion: 'v9' },
    })
    const continued = reduce(conflicted, { type: 'continue-conflict', id: first.id })
    expect(continued.tabs[0]).toMatchObject({ content: 'local', dirty: true, conflict: undefined })
  })

  it('reloads only after the explicit confirmation and advances the local revision', () => {
    const first = opened()
    const conflict = reduce(
      first.state,
      { type: 'edit-tab', id: first.id, content: 'local' },
      { type: 'save-conflicted', id: first.id, diskContent: 'disk', diskVersion: version('v9') },
      { type: 'request-reload', id: first.id },
    )
    expect(conflict.pendingReloadTabId).toBe(first.id)
    expect(reduce(conflict, { type: 'cancel-reload' }).tabs[0]?.content).toBe('local')
    const reloaded = reduce(conflict, { type: 'confirm-reload' })
    expect(reloaded.tabs[0]).toMatchObject({
      content: 'disk', baseContent: 'disk', baseVersion: 'v9', revision: 2, dirty: false, conflict: undefined,
    })
  })

  it('supports another compare-and-swap conflict after overwrite uses the displayed disk version', () => {
    const first = opened()
    const conflict = reduce(
      first.state,
      { type: 'edit-tab', id: first.id, content: 'local' },
      { type: 'save-conflicted', id: first.id, diskContent: 'disk-1', diskVersion: version('v2') },
    )
    const tab = conflict.tabs[0]!
    const overwriting = reduce(conflict, {
      type: 'save-started', id: first.id,
      attempt: { content: tab.content, revision: tab.revision, expectedVersion: tab.conflict!.diskVersion, closeAfterSave: false },
    })
    const again = reduce(overwriting, {
      type: 'save-conflicted', id: first.id, diskContent: 'disk-2', diskVersion: version('v3'),
    })
    expect(again.tabs[0]).toMatchObject({
      content: 'local', dirty: true, conflict: { diskContent: 'disk-2', diskVersion: 'v3' },
    })
  })

  it('requires an explicit dirty-close decision and closes clean tabs directly', () => {
    const first = opened()
    expect(reduce(first.state, { type: 'request-close', id: first.id }).tabs).toHaveLength(0)
    const dirty = reduce(first.state, { type: 'edit-tab', id: first.id, content: 'local' })
    const prompted = reduce(dirty, { type: 'request-close', id: first.id })
    expect(prompted.pendingCloseTabId).toBe(first.id)
    expect(reduce(prompted, { type: 'cancel-close' }).tabs).toHaveLength(1)
    expect(reduce(prompted, { type: 'discard-close' }).tabs).toHaveLength(0)
  })

  it('fences Workspace switching until dirty tabs are saved or explicitly discarded', () => {
    const first = opened()
    const dirty = reduce(first.state, { type: 'edit-tab', id: first.id, content: 'local' })
    const requested = reduce(dirty, { type: 'request-workspace', workspaceId: workspace('w2') })
    expect(requested).toMatchObject({ selectedWorkspaceId: 'w1', pendingWorkspaceId: 'w2' })
    expect(reduce(requested, { type: 'finish-workspace-if-clean' }).selectedWorkspaceId).toBe('w1')

    const clean = reduceIdeState(requested, { type: 'edit-tab', id: first.id, content: 'base' })
    const switched = reduce(clean, { type: 'finish-workspace-if-clean' })
    expect(switched).toMatchObject({ selectedWorkspaceId: 'w2', pendingWorkspaceId: undefined, tabs: [] })

    const discarded = reduce(requested, { type: 'discard-workspace' })
    expect(discarded).toMatchObject({ selectedWorkspaceId: 'w2', tabs: [] })
  })

  it('resumes a routed file after the dirty-workspace decision', () => {
    const first = opened()
    const dirty = reduce(first.state, { type: 'edit-tab', id: first.id, content: 'local' })
    const requested = reduce(dirty, {
      type: 'begin-open', workspaceId: workspace('w2'), segments: ['generated.ts'], line: 21,
    })
    expect(requested).toMatchObject({
      selectedWorkspaceId: 'w1',
      pendingWorkspaceId: 'w2',
      pendingOpen: { workspaceId: 'w2', segments: ['generated.ts'], line: 21 },
    })

    const cancelled = reduce(requested, { type: 'cancel-workspace' })
    expect(cancelled).toMatchObject({ selectedWorkspaceId: 'w1', pendingOpen: undefined })
    const resumed = reduce(requested, { type: 'discard-workspace' })
    expect(resumed).toMatchObject({
      selectedWorkspaceId: 'w2', pendingWorkspaceId: undefined, pendingOpen: undefined,
      tabs: [{ segments: ['generated.ts'], focusLine: 21, phase: 'loading' }],
    })
  })

  it('ignores stale acknowledgements and invalid tab actions', () => {
    const first = opened()
    const stale = reduce(first.state, { type: 'save-succeeded', id: first.id, version: version('v2') })
    expect(stale).toBe(first.state)
    const missing = reduce(first.state, { type: 'edit-tab', id: 'missing', content: 'x' })
    expect(missing).toBe(first.state)
    const loading = reduce(INITIAL_IDE_STATE, {
      type: 'begin-open', workspaceId: workspace('w1'), segments: ['a.ts'],
    })
    expect(reduce(loading, { type: 'edit-tab', id: loading.tabs[0]!.id, content: 'x' }).tabs[0]?.content).toBe('')
  })

  it('activates an adjacent tab after close and updates preview', () => {
    const first = opened('a', ['a.md'])
    const secondId = ideTabId(workspace('w1'), ['b.ts'])
    const two = reduce(
      first.state,
      { type: 'begin-open', workspaceId: workspace('w1'), segments: ['b.ts'] },
      { type: 'open-succeeded', id: secondId, content: 'b', version: version('b1') },
      { type: 'activate-tab', id: first.id },
      { type: 'toggle-preview', id: first.id },
      { type: 'request-close', id: first.id },
    )
    expect(two.activeTabId).toBe(secondId)
    expect(two.tabs).toHaveLength(1)
  })

  it('keeps no-op decisions referentially stable and reports a failed open', () => {
    const first = opened()
    expect(reduce(first.state, { type: 'request-workspace', workspaceId: workspace('w1') })).toBe(first.state)
    expect(reduce(first.state, { type: 'discard-workspace' })).toBe(first.state)
    expect(reduce(first.state, { type: 'finish-workspace-if-clean' })).toBe(first.state)
    expect(reduce(first.state, { type: 'activate-tab', id: 'missing' })).toBe(first.state)
    expect(reduce(first.state, { type: 'request-reload', id: first.id })).toBe(first.state)
    expect(reduce(first.state, { type: 'confirm-reload' })).toBe(first.state)
    expect(reduce(first.state, { type: 'request-close', id: 'missing' })).toBe(first.state)
    expect(reduce(first.state, { type: 'discard-close' })).toBe(first.state)

    const reused = reduce(first.state, {
      type: 'begin-open', workspaceId: workspace('w1'), segments: ['src', 'a.ts'],
    })
    expect(reused).toMatchObject({ activeTabId: first.id, tabs: [{ focusRevision: 0 }] })

    const loading = reduce(INITIAL_IDE_STATE, {
      type: 'begin-open', workspaceId: workspace('w1'), segments: [],
    })
    const failed = reduce(loading, {
      type: 'open-failed', id: loading.tabs[0]!.id, error: 'unreadable',
    })
    expect(failed.tabs[0]).toMatchObject({ title: '', phase: 'error', error: 'unreadable' })
  })

  it('preserves another active tab and clears pending decisions for the removed tab', () => {
    const first = opened('a', ['a.ts'])
    const secondId = ideTabId(workspace('w1'), ['b.ts'])
    const two = reduce(
      first.state,
      { type: 'begin-open', workspaceId: workspace('w1'), segments: ['b.ts'] },
      { type: 'open-succeeded', id: secondId, content: 'b', version: version('b1') },
      { type: 'request-close', id: first.id },
    )
    expect(two.activeTabId).toBe(secondId)

    const dirtySecond = reduce(two, { type: 'edit-tab', id: secondId, content: 'local' })
    const conflicted = reduce(dirtySecond, {
      type: 'save-conflicted', id: secondId, diskContent: 'disk', diskVersion: version('b2'),
    })
    const pending = reduce(
      conflicted,
      { type: 'request-reload', id: secondId },
      { type: 'request-close', id: secondId },
    )
    const removed = reduce(pending, { type: 'discard-close' })
    expect(removed).toMatchObject({ tabs: [], activeTabId: undefined, pendingReloadTabId: undefined })
  })

  it('blocks a workspace switch while a clean buffer save resolves to a conflict', () => {
    const first = opened()
    const tab = first.state.tabs[0]!
    const saving = reduce(first.state, {
      type: 'save-started', id: first.id,
      attempt: {
        content: tab.content,
        revision: tab.revision,
        expectedVersion: version('v1'),
        closeAfterSave: false,
      },
    })
    const requested = reduce(saving, { type: 'request-workspace', workspaceId: workspace('w2') })
    const routed = reduce(saving, {
      type: 'begin-open', workspaceId: workspace('w2'), segments: ['b.ts'],
    })
    expect(routed).toMatchObject({ pendingWorkspaceId: 'w2', pendingOpen: { segments: ['b.ts'] } })
    const conflicted = reduce(requested, {
      type: 'save-conflicted', id: first.id, diskContent: 'disk', diskVersion: version('v2'),
    })
    expect(reduce(conflicted, { type: 'finish-workspace-if-clean' })).toBe(conflicted)
    expect(reduce(saving, { type: 'request-close', id: first.id }).pendingCloseTabId).toBe(first.id)
  })

  it('keeps a routed path without a line and tolerates a vanished reload conflict', () => {
    const first = opened()
    const dirty = reduce(first.state, { type: 'edit-tab', id: first.id, content: 'local' })
    const routed = reduce(dirty, {
      type: 'begin-open', workspaceId: workspace('w2'), segments: ['b.ts'],
    })
    expect(routed.pendingOpen).toEqual({ workspaceId: workspace('w2'), segments: ['b.ts'] })

    const conflict = reduce(dirty, {
      type: 'save-conflicted', id: first.id, diskContent: 'disk', diskVersion: version('v2'),
    })
    const pending = reduce(conflict, { type: 'request-reload', id: first.id })
    const continued = reduce(pending, { type: 'continue-conflict', id: first.id })
    const confirmed = reduce(continued, { type: 'confirm-reload' })
    expect(confirmed).toMatchObject({ pendingReloadTabId: undefined, tabs: [{ content: 'local' }] })
  })

  it('rejects an action outside the closed reducer vocabulary', () => {
    expect(() => reduceIdeState(INITIAL_IDE_STATE, { type: 'unknown' } as never)).toThrow(
      'unreachable IDE action',
    )
  })
})

describe('IDE store bridge', () => {
  it('replays pre-mount commands once and then writes directly to the root instance', () => {
    const bridge = createIdeStoreBridge()
    bridge.dispatch({ type: 'request-workspace', workspaceId: workspace('w1') })
    expect(bridge.getSnapshot().selectedWorkspaceId).toBe('w1')

    const instance = bridge.handle.create('root')
    expect(instance.getSnapshot().selectedWorkspaceId).toBe('w1')
    expect(bridge.handle.create('another')).toBe(instance)

    bridge.dispatch({ type: 'begin-open', workspaceId: workspace('w1'), segments: ['a.ts'] })
    expect(bridge.getSnapshot().tabs).toHaveLength(1)
  })
})
