// @vitest-environment jsdom
/**
 * createLayoutStore unit account: init shape, the action write set (clamp
 * inside actions), and the absence of browser persistence. Uses the
 * test-sanctioned path: factory self-call + .create() gives the
 * real engine instance (same create path as production).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLayoutStore, createLayoutStoreBridge } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import {
  DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  EDITOR_DEFAULT, EDITOR_MAX, EDITOR_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

const PERSIST_KEY = 'dsh.layout.panels'

beforeEach(() => { localStorage.clear() })

describe('createLayoutStore', () => {
  it('initializes the sidebar at its default width, right panels closed, wide viewport assumed', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      editor: 0,
      editorLast: EDITOR_DEFAULT,
      editorRailForced: false,
      editorRailExpanded: false,
      narrow: false,
      narrowExpanded: false,
    })
  })

  it('each create() is an independent instance (factory is not a singleton)', () => {
    const a = createLayoutStore().create()
    const b = createLayoutStore().create()
    a.actions.setSidebar(400)
    expect(b.store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('panel setters clamp into their declared ranges', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(1)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_MIN)
    actions.setSidebar(9999)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_MAX)
    actions.setDetails(1)
    expect(store.getSnapshot().details).toBe(DETAILS_MIN)
    actions.setDetails(9999)
    expect(store.getSnapshot().details).toBe(DETAILS_MAX)
    actions.setEditor(1)
    expect(store.getSnapshot().editor).toBe(EDITOR_MIN)
    expect(store.getSnapshot().editorLast).toBe(EDITOR_MIN)
    actions.setEditor(9999)
    expect(store.getSnapshot().editor).toBe(EDITOR_MAX)
    expect(store.getSnapshot().editorLast).toBe(EDITOR_MAX)
  })

  it('toggleSidebar flips closed <-> contract default (drag width forgotten)', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('narrow toggleSidebar flips only the re-expand override; the width preference survives', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toEqual({
      sidebar: 400,
      details: 0,
      editor: 0,
      editorLast: EDITOR_DEFAULT,
      editorRailForced: false,
      editorRailExpanded: false,
      narrow: true,
      narrowExpanded: true,
    })
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(false)
    expect(store.getSnapshot().sidebar).toBe(400)
  })

  it('crossing the breakpoint drops the override; a same-value setNarrow keeps it', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(false)
    expect(store.getSnapshot()).toMatchObject({ narrow: false, narrowExpanded: false })
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(false)
  })

  it('turns a forced editor rail into an explicit full-sidebar posture and back', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.openEditor()
    actions.setEditor(900)
    actions.setEditorRailForced(true)

    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({
      sidebar: 400,
      editor: 900,
      editorLast: 900,
      editorRailForced: true,
      editorRailExpanded: true,
    })

    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({
      sidebar: 400,
      editor: 900,
      editorLast: 900,
      editorRailForced: true,
      editorRailExpanded: false,
    })
    actions.setEditorRailForced(false)
    expect(store.getSnapshot()).toMatchObject({ editorRailForced: false, editorRailExpanded: false })
  })

  it('keeps a closed sidebar preference through forced editor expansion', () => {
    const { store, actions } = createLayoutStore().create()
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.openEditor()
    actions.setEditorRailForced(true)

    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ sidebar: 0, editorRailExpanded: true })
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ sidebar: 0, editorRailExpanded: false })
  })

  it('openDetails uses the contract default, preserves an open width, and closeDetails zeroes', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(DETAILS_DEFAULT)
    actions.setDetails(500)
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(500)
    actions.closeDetails()
    expect(store.getSnapshot().details).toBe(0)
  })

  it('openEditor uses the contract default, preserves an open width, and restores it after close', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openEditor()
    expect(store.getSnapshot().editor).toBe(EDITOR_DEFAULT)
    actions.setEditor(900)
    actions.openEditor()
    expect(store.getSnapshot().editor).toBe(900)
    actions.closeEditor()
    expect(store.getSnapshot().editor).toBe(0)
    expect(store.getSnapshot().editorLast).toBe(900)
    actions.openEditor()
    expect(store.getSnapshot().editor).toBe(900)
  })

  it('does not persist panel geometry', () => {
    const first = createLayoutStore().create()
    first.actions.setSidebar(400)
    first.actions.openDetails()
    first.actions.setDetails(500)
    first.actions.openEditor()
    first.actions.setEditor(900)
    expect(localStorage.getItem(PERSIST_KEY)).toBeNull()

    const second = createLayoutStore().create()
    expect(second.store.getSnapshot()).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      editor: 0,
      editorLast: EDITOR_DEFAULT,
      editorRailForced: false,
      editorRailExpanded: false,
      narrow: false,
      narrowExpanded: false,
    })
  })
})

describe('createLayoutStoreBridge', () => {
  it('projects editor open state from the renderer-created shared instance', () => {
    const bridge = createLayoutStoreBridge()
    const changed = vi.fn()
    const unsubscribe = bridge.editorOpen.subscribe(changed)
    expect(bridge.editorOpen.getSnapshot()).toBe(false)

    const first = bridge.handle.create()
    expect(bridge.handle.create()).toBe(first)
    first.actions.openEditor()
    expect(bridge.editorOpen.getSnapshot()).toBe(true)
    expect(changed).toHaveBeenCalledOnce()

    unsubscribe()
    first.actions.closeEditor()
    expect(bridge.editorOpen.getSnapshot()).toBe(false)
    expect(changed).toHaveBeenCalledOnce()
  })

  it('tracks duplicate pre-render subscriptions independently', () => {
    const bridge = createLayoutStoreBridge()
    const changed = vi.fn()
    const unsubscribeFirst = bridge.editorOpen.subscribe(changed)
    bridge.editorOpen.subscribe(changed)
    unsubscribeFirst()

    bridge.handle.create().actions.openEditor()
    expect(changed).toHaveBeenCalledOnce()
  })
})
