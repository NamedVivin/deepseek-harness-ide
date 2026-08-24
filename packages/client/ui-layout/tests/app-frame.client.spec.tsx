// @vitest-environment jsdom
/**
 * AppFrame interaction spec under the four-share props form: real layout
 * store instance (createLayoutStore().create() — the test-sanctioned engine
 * path), a recording renderSlot stub, and a render-prop SessionProvider stub
 * (the real one is framework-wired to the renderer host; its own behavior is
 * ui-renderer's spec territory). Drag sequences (pointer capture + rAF flush),
 * concession response to viewport change, and details staying mounted at
 * zero width are the preserved behavior assertions. jsdom has no layout
 * engine, so the frame width comes from a mocked getBoundingClientRect and
 * resizes are driven through the ResizeObserver stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { AppFrame } from '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx'
import type { AppFrameProps } from '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx'
import {
  CENTER_EDITOR_HARD_MIN,
  EDITOR_DEFAULT, EDITOR_MAX, EDITOR_MIN,
  SIDEBAR_COLLAPSED,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import type {
  SessionId, SessionListState, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'

// Session selection controls for the SessionProvider and useSessions stubs.
const selectedSession = { current: 's-test' as SessionId | undefined }
const selectedSessionBlank = { current: false }
const baselinesReady = { current: true }

// Render-prop contract stub fed through the standard seat prop (the renderer
// injects the real one in production): session mode runs children(id), empty
// mode runs the empty branch — the frame must work against exactly this
// shape. Typed as the seat's own component type so the branded sessionId
// parameter stays contract-checked.
const SessionProviderStub: AppFrameProps['SessionProvider'] = ({ children, empty }) =>
  selectedSession.current === undefined ? <>{empty?.() ?? null}</> : <>{children(selectedSession.current)}</>


/** Observer stub: captures the callback so tests can fire resizes manually. */
let fireResize: (() => void) | null = null
class ResizeObserverStub {
  #cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) { this.#cb = cb }
  observe(): void { fireResize = () => { this.#cb([], this) } }
  unobserve(): void {}
  disconnect(): void { fireResize = null }
}

let frameWidth = 1920

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

function mountFrame() {
  window.innerWidth = frameWidth // first-render viewport source before the observer fires
  const instance = createLayoutStore().create()
  const slotCalls: { key: string; props: unknown }[] = []
  const renderSlot = ((key: string, owner: object) => {
    slotCalls.push({ key, props: owner })
    if (key === 'sidebar') return <div data-testid="sidebar-content" />
    if (key === 'conversation') return <div data-testid="center-content" />
    if (key === 'details') return <div data-testid="details-content" />
    if (key === 'shell.editor') return <div id="dsh-ide-title" data-testid="editor-content">Editor</div>
    if (key === 'conversation.empty') return <div data-testid="empty-content" />
    return <div data-testid="other-content" />
  }) as AppFrameProps['renderSlot']
  const useSessions = ((sel: (s: SessionListState) => unknown) => {
    const current = selectedSession.current
    const sessionState = {
      ids: current === undefined ? [] : [current],
      byId: current === undefined
        ? {}
        : { [current]: { id: current, displayTitle: 'Test', running: false, blank: selectedSessionBlank.current, updatedAt: 1 } },
      current,
      phase: 'ready',
    } as SessionListState
    return sel(sessionState)
  }) as never
  const workspaceState: WorkspaceListState = {
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: baselinesReady.current, recentWorkspaceId: undefined,
  }
  const element = () => (
    <AppFrame
      useStore={hookOf(instance)}
      actions={instance.actions}
      renderSlot={renderSlot}
      useSessions={useSessions}
      useWorkspaces={((sel: (s: WorkspaceListState) => unknown) => sel(workspaceState)) as never}
      SessionProvider={SessionProviderStub}
    />
  )
  const utils = render(element())
  const frame = utils.container.firstElementChild as HTMLElement
  return { instance, frame, slotCalls, rerenderFrame: () => { utils.rerender(element()) }, ...utils }
}

function tracks(frame: HTMLElement): [sidebar: number, details: number, editor: number] {
  const m = /^(\d+)px minmax\(0, 1fr\) (\d+)px (\d+)px$/.exec(frame.style.gridTemplateColumns)
  if (m === null) throw new Error(`unexpected template: ${frame.style.gridTemplateColumns}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function drag(handle: Element, fromX: number, toX: number): void {
  const down = pointer('pointerdown', fromX)
  const move = pointer('pointermove', toX)
  const up = pointer('pointerup', toX)
  act(() => { handle.dispatchEvent(down) })
  act(() => { handle.dispatchEvent(move); vi.advanceTimersByTime(20) })
  act(() => { handle.dispatchEvent(up) })
}

function pointer(
  type: string,
  clientX: number,
  options: { pointerId?: number; button?: number; isPrimary?: boolean } = {},
): PointerEvent {
  return new PointerEvent(type, {
    pointerId: options.pointerId ?? 1,
    button: options.button ?? 0,
    isPrimary: options.isPrimary ?? true,
    clientX,
    bubbles: true,
  })
}

beforeEach(() => {
  frameWidth = 1920
  selectedSession.current = 's-test' as SessionId
  selectedSessionBlank.current = false
  baselinesReady.current = true
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => { cb(0) }, 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (h: number) => { clearTimeout(h) })
  window.innerWidth = frameWidth
  Element.prototype.getBoundingClientRect = function () {
    return { width: frameWidth, height: 1080, top: 0, left: 0, right: frameWidth, bottom: 1080, x: 0, y: 0, toJSON: () => ({}) }
  }
  // jsdom lacks pointer capture: emulate per-element so hasPointerCapture gates pass.
  const captured = new WeakSet<Element>()
  Element.prototype.setPointerCapture = function () { captured.add(this) }
  Element.prototype.releasePointerCapture = function () { captured.delete(this) }
  Element.prototype.hasPointerCapture = function () { return captured.has(this) }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('AppFrame', () => {
  it('renders four tracks and stable shell markers from store state', () => {
    const { frame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0, 0])
    expect(frame.hasAttribute('data-shell-frame')).toBe(true)
    expect(frame.querySelectorAll('[data-shell-panel]')).toHaveLength(4)
    expect(frame.querySelector('[data-shell-panel="conversation"]')).not.toBeNull()
    expect(frame.querySelector('[data-shell-panel="details"]')).not.toBeNull()
    expect(frame.querySelector('[data-shell-panel="editor"]')).not.toBeNull()
  })

  it('renders session columns with empty owner shares and the root editor with rendered geometry', () => {
    const { slotCalls, getByTestId } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(getByTestId('details-content')).toBeTruthy()
    expect(getByTestId('editor-content')).toBeTruthy()
    const keys = slotCalls.map(c => c.key)
    expect(keys).toContain('conversation')
    expect(keys).toContain('details')
    expect(keys).toContain('shell.editor')
    expect(keys).not.toContain('conversation.empty')
    expect(slotCalls.find(c => c.key === 'conversation')!.props).toEqual({})
    expect(slotCalls.find(c => c.key === 'details')!.props).toEqual({})
    expect(slotCalls.find(c => c.key === 'shell.editor')!.props).toEqual({ collapsed: true, exclusive: false, width: 0 })
  })

  it('keeps the conversation slot mounted while no session is current', () => {
    // No current session: the session-maybe conversation shell owns the New
    // Session view itself — the center column renders it unconditionally.
    selectedSession.current = undefined
    const { slotCalls, getByTestId } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(getByTestId('editor-content')).toBeTruthy()
    expect(slotCalls.map(c => c.key)).toContain('conversation')
    expect(slotCalls.map(c => c.key)).toContain('shell.editor')
  })

  it('renders both column occupants before baselines settle (no loading gate)', () => {
    // No loading gate: a bare loading status reads worse than the shell's own
    // pending rendering — both occupants mount from first paint.
    baselinesReady.current = false
    const { slotCalls } = mountFrame()
    expect(slotCalls.map(c => c.key)).toContain('conversation')
    expect(slotCalls.map(c => c.key)).toContain('details')
  })

  it('ignores unselected states and closes only when the Session id changes', () => {
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0, 0])

    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 360, 0])

    selectedSession.current = 's-next' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0, 0])

    act(() => { instance.actions.openDetails() })
    selectedSession.current = 's-blank' as SessionId
    selectedSessionBlank.current = true
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0, 0])
    expect(instance.getSnapshot().details).toBe(360)

    selectedSession.current = 's-next' as SessionId
    selectedSessionBlank.current = false
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 360, 0])

    selectedSession.current = undefined
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0, 0])
    selectedSession.current = 's-test' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0, 0])
  })

  it('keeps details closed when the first Session materializes', () => {
    selectedSession.current = undefined
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0, 0])
    expect(instance.getSnapshot().details).toBe(0)

    selectedSession.current = 's-first' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0, 0])
  })

  it('sidebar slot receives live concession output as owner props', () => {
    const { slotCalls } = mountFrame()
    expect(slotCalls.find(c => c.key === 'sidebar')!.props).toEqual({ collapsed: false, width: 280 })
  })

  it('sidebar drag widens through rAF-batched pointer moves', () => {
    const { frame } = mountFrame()
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[0]!, 280, 350)
    expect(tracks(frame)[0]).toBe(350)
  })

  it('details drag widens leftward (negative dx grows the panel)', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 1560, 1500)
    expect(tracks(frame)[1]).toBe(420)
  })

  it('editor opens as a real fourth track and widens leftward from its rendered width', () => {
    const { frame, instance, slotCalls } = mountFrame()
    act(() => { instance.actions.openEditor() })
    expect(tracks(frame)).toEqual([280, 0, EDITOR_DEFAULT])
    const handle = frame.querySelector('[data-resize-handle="editor"]')!
    expect(handle.getAttribute('role')).toBe('separator')
    expect(handle.getAttribute('aria-labelledby')).toBe('dsh-ide-title')
    expect(handle.getAttribute('aria-controls')).toBe('dsh-ide-surface')
    expect(handle.getAttribute('aria-valuemin')).toBe(String(EDITOR_MIN))
    expect(handle.getAttribute('aria-valuemax')).toBe('1000')
    expect(handle.getAttribute('aria-valuenow')).toBe(String(EDITOR_DEFAULT))
    drag(handle, 1200, 1140)
    expect(instance.getSnapshot().editor).toBe(EDITOR_DEFAULT + 60)
    expect(tracks(frame)[2]).toBe(EDITOR_DEFAULT + 60)
    expect(slotCalls.filter(c => c.key === 'shell.editor').at(-1)!.props)
      .toEqual({ collapsed: false, exclusive: false, width: EDITOR_DEFAULT + 60 })
  })

  it('keeps details between the conversation and editor when all four tracks fit', () => {
    frameWidth = 2200
    const { frame, instance } = mountFrame()
    act(() => {
      instance.actions.openDetails()
      instance.actions.openEditor()
    })
    expect(tracks(frame)).toEqual([280, 360, EDITOR_DEFAULT])
    const detailsHandle = frame.querySelector<HTMLElement>('[data-resize-handle="details"]')!
    const editorHandle = frame.querySelector<HTMLElement>('[data-resize-handle="editor"]')!
    expect(Number.parseFloat(detailsHandle.style.left)).toBe(2200 - 360 - EDITOR_DEFAULT)
    expect(Number.parseFloat(editorHandle.style.left)).toBe(2200 - EDITOR_DEFAULT)
    const details = frame.querySelector('[data-shell-panel="details"]')!
    const editor = frame.querySelector('[data-shell-panel="editor"]')!
    expect(details.compareDocumentPosition(editorHandle) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(editorHandle.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('uses the solver-reachable editor maximum while details is open', () => {
    const { frame, instance } = mountFrame()
    act(() => {
      instance.actions.openDetails()
      instance.actions.openEditor()
    })
    expect(tracks(frame)).toEqual([280, 300, 700])
    const handle = frame.querySelector('[data-resize-handle="editor"]')!
    expect(handle.getAttribute('aria-valuemax')).toBe('700')
    expect(handle.getAttribute('aria-valuenow')).toBe('700')
    act(() => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    expect(instance.getSnapshot().editor).toBe(700)
    expect(tracks(frame)[2]).toBe(700)
  })

  it('keeps the editor adjustable at 1440px and clamps to its dynamic maximum', () => {
    frameWidth = 1440
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openEditor() })
    expect(tracks(frame)).toEqual([280, 0, EDITOR_DEFAULT])
    const handle = frame.querySelector('[data-resize-handle="editor"]')!
    expect(handle.getAttribute('aria-valuemax')).toBe('760')
    drag(handle, 720, 680)
    expect(instance.getSnapshot().editor).toBe(760)
    expect(tracks(frame)[2]).toBe(760)
    drag(handle, 680, 600)
    expect(instance.getSnapshot().editor).toBe(760)
  })

  it('restores the last editor width after close and reopen', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openEditor() })
    drag(frame.querySelector('[data-resize-handle="editor"]')!, 1200, 1140)
    act(() => { instance.actions.closeEditor() })
    expect(tracks(frame)[2]).toBe(0)
    act(() => { instance.actions.openEditor() })
    expect(tracks(frame)[2]).toBe(EDITOR_DEFAULT + 60)
  })

  it('resizes the editor separator by keyboard', () => {
    frameWidth = 2400
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openEditor() })
    const handle = frame.querySelector('[data-resize-handle="editor"]')!
    act(() => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(instance.getSnapshot().editor).toBe(EDITOR_DEFAULT + 16)
    act(() => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(instance.getSnapshot().editor).toBe(EDITOR_DEFAULT)
    act(() => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
    expect(instance.getSnapshot().editor).toBe(EDITOR_MIN)
    act(() => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    expect(instance.getSnapshot().editor).toBe(EDITOR_MAX)
  })

  it('drag base is the rendered (concession-clamped) width, not the preference', () => {
    frameWidth = 1250 // step-2 squeeze: details renders 330 while preference is 360
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 330, 0])
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 920, 930) // shrink by 10 from the rendered width
    expect(instance.getSnapshot().details).toBe(320)
  })

  it('details column stays mounted at zero width', () => {
    const { frame, getByTestId } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0, 0])
    expect(getByTestId('details-content')).toBeTruthy()
    expect(frame.hasAttribute('data-details-collapsed')).toBe(true)
    expect(frame.querySelector('[data-shell-panel="details"]')?.hasAttribute('inert')).toBe(true)
  })

  it('editor column stays mounted and inert at zero width', () => {
    const { frame, getByTestId } = mountFrame()
    expect(getByTestId('editor-content')).toBeTruthy()
    expect(frame.hasAttribute('data-editor-collapsed')).toBe(true)
    expect(frame.querySelector('[data-shell-panel="editor"]')?.hasAttribute('inert')).toBe(true)
  })

  it('closed sidebar keeps its compact rail with mounted slot content and collapsed owner props', () => {
    const { frame, instance, slotCalls, getByTestId } = mountFrame()
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0, 0])
    expect(getByTestId('sidebar-content')).toBeTruthy()
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    const lastSidebarCall = slotCalls.filter(c => c.key === 'sidebar').at(-1)!
    expect(lastSidebarCall.props).toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED })
  })

  it('viewport shrink triggers the concession chain via ResizeObserver', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    frameWidth = 1250
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 330, 0])
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 360, 0])
  })

  it('drag handles disappear for collapsed columns', () => {
    const { frame, instance } = mountFrame()
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.openDetails() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(2)
    act(() => { instance.actions.closeDetails() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.toggleSidebar() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })
})

describe('AppFrame — narrow-viewport auto-collapse', () => {
  it('collapses the navigation rail instead of making a viable split exclusive', () => {
    frameWidth = 1240
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openEditor() })
    expect(frame.hasAttribute('data-editor-exclusive')).toBe(false)
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0, EDITOR_DEFAULT])
    expect(frame.querySelector('[data-resize-handle="editor"]')?.getAttribute('aria-valuemax')).toBe('784')

    frameWidth = 1241
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(frame.hasAttribute('data-editor-exclusive')).toBe(false)
    expect(tracks(frame)).toEqual([280, 0, 561])
    expect(frame.querySelector('[data-resize-handle="editor"]')?.getAttribute('aria-valuemax')).toBe('561')
  })

  it('makes the forced-rail sidebar toggle visibly expand and collapse at 1240px', () => {
    frameWidth = 1240
    const { frame, instance, slotCalls } = mountFrame()
    act(() => {
      instance.actions.setSidebar(400)
      instance.actions.openEditor()
    })

    act(() => { instance.actions.toggleSidebar() })
    expect(frame.hasAttribute('data-editor-exclusive')).toBe(true)
    expect(tracks(frame)).toEqual([400, 0, 840])
    expect(instance.getSnapshot()).toMatchObject({ editor: EDITOR_DEFAULT, editorLast: EDITOR_DEFAULT })
    expect(slotCalls.filter(c => c.key === 'sidebar').at(-1)!.props).toEqual({ collapsed: false, width: 400 })

    act(() => { instance.actions.toggleSidebar() })
    expect(frame.hasAttribute('data-editor-exclusive')).toBe(false)
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0, EDITOR_DEFAULT])
    expect(instance.getSnapshot()).toMatchObject({ sidebar: 400, editor: EDITOR_DEFAULT, editorLast: EDITOR_DEFAULT })

    frameWidth = 1800
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([400, 0, EDITOR_DEFAULT])
    expect(instance.getSnapshot()).toMatchObject({ sidebar: 400, editor: EDITOR_DEFAULT, editorLast: EDITOR_DEFAULT })
  })

  it('keeps the split monotonic across the 1024px sidebar breakpoint', () => {
    frameWidth = 1023
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openEditor() })
    expect(frame.hasAttribute('data-editor-exclusive')).toBe(false)
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0, 567])

    frameWidth = 1024
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(frame.hasAttribute('data-editor-exclusive')).toBe(false)
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0, 568])
    expect(frame.querySelector('[data-resize-handle="editor"]')).not.toBeNull()
  })

  it('uses exclusive mode only through the rail split boundary', () => {
    frameWidth = SIDEBAR_COLLAPSED + CENTER_EDITOR_HARD_MIN + EDITOR_MIN
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openEditor() })
    expect(frame.hasAttribute('data-editor-exclusive')).toBe(true)
    expect(frame.querySelector('[data-resize-handle="editor"]')).toBeNull()

    frameWidth += 1
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(frame.hasAttribute('data-editor-exclusive')).toBe(false)
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0, EDITOR_MIN + 1])
    expect(frame.querySelector('[data-resize-handle="editor"]')).not.toBeNull()
  })

  it('gives an open editor the content region at 900px and restores the split preference when widened', () => {
    frameWidth = 900
    const { frame, instance, slotCalls } = mountFrame()
    act(() => { instance.actions.openEditor() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0, 900 - SIDEBAR_COLLAPSED])
    expect(frame.hasAttribute('data-editor-exclusive')).toBe(true)
    expect(frame.querySelector('[data-resize-handle="editor"]')).toBeNull()
    expect(frame.querySelector('[data-shell-panel="conversation"]')?.hasAttribute('inert')).toBe(true)
    expect(frame.querySelector('[data-shell-panel="details"]')?.hasAttribute('inert')).toBe(true)
    expect(frame.querySelector('[data-shell-panel="editor"]')?.hasAttribute('inert')).toBe(false)
    expect(slotCalls.filter(c => c.key === 'sidebar').at(-1)!.props)
      .toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED })
    expect(slotCalls.filter(c => c.key === 'shell.editor').at(-1)!.props)
      .toEqual({ collapsed: false, exclusive: true, width: 900 - SIDEBAR_COLLAPSED })

    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 0, EDITOR_DEFAULT])
    expect(frame.hasAttribute('data-editor-exclusive')).toBe(false)
    expect(frame.querySelector('[data-resize-handle="editor"]')).not.toBeNull()
    expect(instance.getSnapshot().editor).toBe(EDITOR_DEFAULT)
  })

  it('makes the exclusive editor rail toggle visible at 900px without changing preferences', () => {
    frameWidth = 900
    const { frame, instance, slotCalls } = mountFrame()
    act(() => {
      instance.actions.setSidebar(400)
      instance.actions.openEditor()
    })

    act(() => { instance.actions.toggleSidebar() })
    expect(frame.hasAttribute('data-editor-exclusive')).toBe(true)
    expect(tracks(frame)).toEqual([400, 0, 500])
    expect(slotCalls.filter(c => c.key === 'sidebar').at(-1)!.props).toEqual({ collapsed: false, width: 400 })
    expect(instance.getSnapshot()).toMatchObject({ sidebar: 400, editor: EDITOR_DEFAULT, editorLast: EDITOR_DEFAULT })

    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0, 900 - SIDEBAR_COLLAPSED])
    expect(instance.getSnapshot()).toMatchObject({ sidebar: 400, editor: EDITOR_DEFAULT, editorLast: EDITOR_DEFAULT })
  })

  it('closing the exclusive editor restores the conversation region', () => {
    frameWidth = 900
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openEditor() })
    act(() => { instance.actions.closeEditor() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0, 0])
    expect(frame.querySelector('[data-shell-panel="conversation"]')?.hasAttribute('inert')).toBe(false)
    expect(frame.querySelector('[data-shell-panel="editor"]')?.hasAttribute('inert')).toBe(true)
  })

  it('mounts collapsed below the breakpoint with no sidebar handle', () => {
    frameWidth = 980
    const { frame, slotCalls } = mountFrame()
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0, 0])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(slotCalls.filter(c => c.key === 'sidebar').at(-1)!.props).toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })

  it('narrow toggle re-expands over the squeezed center and back', () => {
    frameWidth = 980
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([280, 0, 0])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0, 0])
  })

  it('a wide-closed preference re-expands at the contract default while narrow', () => {
    frameWidth = 1920
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.toggleSidebar() }) // close while wide: preference 0
    frameWidth = 980
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([280, 0, 0])
    expect(instance.getSnapshot().sidebar).toBe(0) // preference untouched
  })

  it('shrinking across the breakpoint auto-collapses; re-widening restores the drag width', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.setSidebar(400) })
    frameWidth = 980
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0, 0])
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([400, 0, 0])
  })
})

describe('AppFrame — guard branches', () => {
  it('pointer moves without capture are ignored (no width write)', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    const before = instance.getSnapshot().sidebar
    // Move + up without a preceding pointerdown: hasPointerCapture is false.
    act(() => {
      handle.dispatchEvent(pointer('pointermove', 500, { pointerId: 9 }))
      vi.advanceTimersByTime(20)
      handle.dispatchEvent(pointer('pointerup', 500, { pointerId: 9 }))
    })
    expect(instance.getSnapshot().sidebar).toBe(before)
  })

  it('ignores secondary-button and non-primary pointer starts', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    const before = instance.getSnapshot().sidebar
    act(() => {
      handle.dispatchEvent(pointer('pointerdown', 280, { button: 2 }))
      handle.dispatchEvent(pointer('pointermove', 360))
      handle.dispatchEvent(pointer('pointerup', 360))
      handle.dispatchEvent(pointer('pointerdown', 280, { pointerId: 2, isPrimary: false }))
      handle.dispatchEvent(pointer('pointermove', 360, { pointerId: 2, isPrimary: false }))
      handle.dispatchEvent(pointer('pointerup', 360, { pointerId: 2, isPrimary: false }))
      vi.advanceTimersByTime(20)
    })
    expect(instance.getSnapshot().sidebar).toBe(before)
  })

  it('two moves inside one frame coalesce through the pending rAF', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(pointer('pointerdown', 280)) })
    act(() => {
      // Two moves before the frame flushes: the second must ride the pending
      // rAF (frame.current ??= guard), and the flush sees the latest x.
      handle.dispatchEvent(pointer('pointermove', 320))
      handle.dispatchEvent(pointer('pointermove', 340))
      vi.advanceTimersByTime(20)
    })
    act(() => { handle.dispatchEvent(pointer('pointerup', 340)) })
    expect(instance.getSnapshot().sidebar).toBe(340)
  })

  it('pointerup with a pending rAF cancels it and commits the final position', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(pointer('pointerdown', 280)) })
    act(() => {
      handle.dispatchEvent(pointer('pointermove', 360))
      // No timer advance: the rAF is still pending when pointerup arrives.
      handle.dispatchEvent(pointer('pointerup', 360))
    })
    expect(instance.getSnapshot().sidebar).toBe(360)
  })

  it('pointerup commits its own final coordinate without a preceding move', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => {
      handle.dispatchEvent(pointer('pointerdown', 280))
      handle.dispatchEvent(pointer('pointerup', 350))
    })
    expect(instance.getSnapshot().sidebar).toBe(350)
  })

  it('pointercancel cancels a pending frame and ends the gesture without committing', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => {
      handle.dispatchEvent(pointer('pointerdown', 280))
      handle.dispatchEvent(pointer('pointermove', 360))
      handle.dispatchEvent(pointer('pointercancel', 360))
      vi.advanceTimersByTime(20)
    })
    expect(instance.getSnapshot().sidebar).toBe(280)
    expect(frame.hasAttribute('data-dragging')).toBe(false)
    expect(handle.hasPointerCapture(1)).toBe(false)
  })

  it('lost pointer capture cancels the pending frame and ends the gesture', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => {
      handle.dispatchEvent(pointer('pointerdown', 280))
      handle.dispatchEvent(pointer('pointermove', 360))
      handle.releasePointerCapture(1)
      handle.dispatchEvent(pointer('lostpointercapture', 360))
      vi.advanceTimersByTime(20)
    })
    expect(instance.getSnapshot().sidebar).toBe(280)
    expect(frame.hasAttribute('data-dragging')).toBe(false)
  })

  it('zero-width resize reports are ignored (display:none window)', () => {
    const { frame } = mountFrame()
    frameWidth = 0
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    // Track template still reflects the last non-zero viewport.
    expect(tracks(frame)).toEqual([280, 0, 0])
  })
})

describe('AppFrame — unmount with an in-flight resize frame', () => {
  it('cancels an in-flight pointer frame and ends the drag on unmount', () => {
    const { frame, instance, unmount } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => {
      handle.dispatchEvent(pointer('pointerdown', 280))
      handle.dispatchEvent(pointer('pointermove', 360))
    })
    unmount()
    expect(() => { vi.advanceTimersByTime(20) }).not.toThrow()
    expect(instance.getSnapshot().sidebar).toBe(280)
  })

  it('cancels the pending rAF on unmount (no post-unmount setState)', () => {
    const { unmount } = mountFrame()
    frameWidth = 800
    act(() => { fireResize?.() }) // rAF scheduled, NOT flushed
    unmount()
    // Flushing after unmount must be a no-op (the frame was cancelled).
    expect(() => { vi.advanceTimersByTime(20) }).not.toThrow()
  })

  it('double resize inside one frame rides the pending rAF (??= guard)', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    frameWidth = 1250
    act(() => { fireResize?.(); fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 330, 0])
  })
})
