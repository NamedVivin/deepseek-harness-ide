/**
 * Four-column shell frame, registered into the built-in 'root' slot (the web
 * shell renders only 'root'). Owns the grid tracks (sidebar | center |
 * details | editor), drag handles, concession chain, and child-slot render
 * decisions. Session-aware occupants stay at fixed tree positions; strict
 * entries gate themselves on current-session availability while root and
 * session-maybe entries retain identity.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  CENTER_EDITOR_HARD_MIN,
  computeColumns,
  EDITOR_EXCLUSIVE_MAX,
  EDITOR_MAX,
  EDITOR_MIN,
  SIDEBAR_AUTO_COLLAPSE,
  SIDEBAR_COLLAPSED,
  SIDEBAR_DEFAULT,
} from './columns.ts'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'shell.editor' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>

/** Keep a mounted zero-width column outside focus and accessibility traversal. */
function useInertRef(inert: boolean) {
  return useCallback((node: HTMLDivElement | null): void => {
    node?.toggleAttribute('inert', inert)
  }, [inert])
}

/** Center column grid item (session-body building block). */
function CenterColumn(props: { hidden: boolean; children?: ReactNode }) {
  return (
    <div
      ref={useInertRef(props.hidden)}
      className={css.centerCol}
      data-shell-panel="conversation"
      aria-hidden={props.hidden || undefined}
    >
      {props.children}
    </div>
  )
}

/** Details column grid item; width 0 keeps the subtree mounted. */
function DetailsColumn(props: { hidden: boolean; children?: ReactNode }) {
  return (
    <div
      ref={useInertRef(props.hidden)}
      className={css.detailsCol}
      data-shell-panel="details"
      aria-hidden={props.hidden || undefined}
    >
      {props.children}
    </div>
  )
}

/** Root-scoped editor column; width 0 preserves the occupant's local state. */
function EditorColumn(props: { hidden: boolean; children?: ReactNode }) {
  return (
    <div
      ref={useInertRef(props.hidden)}
      className={css.editorCol}
      data-shell-panel="editor"
      aria-hidden={props.hidden || undefined}
    >
      {props.children}
    </div>
  )
}

const KEYBOARD_RESIZE_STEP = 16

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: {
  side: 'sidebar' | 'details' | 'editor'
  left: number
  onStart: () => void
  onDrag: (dx: number) => void
  onEnd: () => void
  onSet?: (px: number) => void
  value?: number
  min?: number
  max?: number
  labelledBy?: string
  controls?: string
}) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const activePointer = useRef<number | null>(null)
  const callbacks = useRef({
    onStart: props.onStart,
    onDrag: props.onDrag,
    onEnd: props.onEnd,
    onSet: props.onSet,
  })
  callbacks.current = {
    onStart: props.onStart,
    onDrag: props.onDrag,
    onEnd: props.onEnd,
    onSet: props.onSet,
  }

  const finishPointer = useCallback((pointerId: number, commit: boolean): void => {
    if (activePointer.current !== pointerId) return
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
    if (commit) callbacks.current.onDrag(latest.current - origin.current)
    activePointer.current = null
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !e.isPrimary || activePointer.current !== null) return
    e.preventDefault()
    origin.current = e.clientX
    latest.current = e.clientX
    activePointer.current = e.pointerId
    e.currentTarget.setPointerCapture(e.pointerId)
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== e.pointerId || !e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== e.pointerId) return
    latest.current = e.clientX
    const captured = e.currentTarget.hasPointerCapture(e.pointerId)
    finishPointer(e.pointerId, true)
    if (captured) e.currentTarget.releasePointerCapture(e.pointerId)
  }, [finishPointer])
  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== e.pointerId) return
    const captured = e.currentTarget.hasPointerCapture(e.pointerId)
    finishPointer(e.pointerId, false)
    if (captured) e.currentTarget.releasePointerCapture(e.pointerId)
  }, [finishPointer])
  const onLostPointerCapture = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    finishPointer(e.pointerId, false)
  }, [finishPointer])
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const set = callbacks.current.onSet
    if (set === undefined || props.value === undefined || props.min === undefined || props.max === undefined) return
    let next: number | undefined
    if (e.key === 'ArrowLeft') next = Math.min(props.max, props.value + KEYBOARD_RESIZE_STEP)
    else if (e.key === 'ArrowRight') next = Math.max(props.min, props.value - KEYBOARD_RESIZE_STEP)
    else if (e.key === 'Home') next = props.min
    else if (e.key === 'End') next = props.max
    if (next === undefined) return
    e.preventDefault()
    set(next)
  }, [props.max, props.min, props.value])

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    if (activePointer.current !== null) callbacks.current.onEnd()
    activePointer.current = null
    frame.current = null
  }, [])

  const editor = props.side === 'editor'

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-resize-handle={props.side}
      data-dragging={dragging || undefined}
      role={editor ? 'separator' : undefined}
      tabIndex={editor ? 0 : undefined}
      aria-orientation={editor ? 'vertical' : undefined}
      aria-labelledby={editor ? props.labelledBy : undefined}
      aria-controls={editor ? props.controls : undefined}
      aria-valuemin={editor ? props.min : undefined}
      aria-valuemax={editor ? props.max : undefined}
      aria-valuenow={editor ? props.value : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onKeyDown={onKeyDown}
    />
  )
}

/** The four-column frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
}: AppFrameProps) {
  const panels = useStore(s => s)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)

  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const width = el.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // Narrow viewports auto-collapse the sidebar; the store mirror keeps
  // toggleSidebar's semantics right (narrow toggles flip the manual
  // re-expand override, stores.ts). Collapsed is decided here, so the
  // solver stays breakpoint-free: a narrow re-expand passes the preference
  // (or the default when the wide preference is closed) and the center
  // absorbs the squeeze.
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])
  const navigationSidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const editorSplitFloor = CENTER_EDITOR_HARD_MIN + EDITOR_MIN
  const expandedSidebarPreference = panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar
  const editorNeedsRail = panels.editor > 0
    && viewport - expandedSidebarPreference <= editorSplitFloor
    && viewport - SIDEBAR_COLLAPSED > editorSplitFloor
  const editorCannotSplit = viewport - SIDEBAR_COLLAPSED <= editorSplitFloor
  const editorBaseExclusive = panels.editor > 0
    && (viewport <= EDITOR_EXCLUSIVE_MAX || editorCannotSplit)
  const editorForcesRail = editorNeedsRail || editorBaseExclusive
  useEffect(() => { actions.setEditorRailForced(editorForcesRail) }, [actions, editorForcesRail])
  const editorForcedFull = editorForcesRail && panels.editorRailExpanded
  const editorExclusive = editorBaseExclusive || editorForcedFull
  const sidebarCollapsed = editorForcedFull
    ? false
    : editorExclusive || editorNeedsRail || navigationSidebarCollapsed
  const sidebarPreference = sidebarCollapsed
    ? 0
    : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar
  const exclusiveSidebar = editorForcedFull ? expandedSidebarPreference : SIDEBAR_COLLAPSED
  const detailsPreference = detailsSession === undefined ? 0 : panels.details
  const cols = editorExclusive
    ? {
      sidebar: exclusiveSidebar,
      center: 0,
      details: 0,
      editor: Math.max(0, viewport - exclusiveSidebar),
    }
    : computeColumns(
      viewport,
      sidebarPreference,
      detailsPreference,
      panels.editor,
    )
  const colsRef = useRef(cols)
  colsRef.current = cols
  // Reuse the concession solver for the separator's reachable ceiling. This
  // accounts for an open details track and for the switch from the normal
  // conversation floor to its smaller editor-resize floor.
  const editorMax = computeColumns(
    viewport,
    sidebarPreference,
    detailsPreference,
    EDITOR_MAX,
  ).editor
  const editorMaxRef = useRef(editorMax)
  editorMaxRef.current = editorMax

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  const editorBase = useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onDetailsStart = useCallback(() => { detailsBase.current = colsRef.current.details; setDragging(true) }, [])
  const onEditorStart = useCallback(() => { editorBase.current = colsRef.current.editor; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onDetailsDrag = useCallback((dx: number) => {
    actions.setDetails(detailsBase.current - dx)
  }, [actions])
  const onEditorDrag = useCallback((dx: number) => {
    actions.setEditor(Math.min(editorMaxRef.current, Math.max(EDITOR_MIN, editorBase.current - dx)))
  }, [actions])
  const onEditorSet = useCallback((px: number) => {
    actions.setEditor(Math.min(editorMaxRef.current, Math.max(EDITOR_MIN, px)))
  }, [actions])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{ gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px ${cols.editor}px` }}
      data-shell-frame=""
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={cols.details === 0 || undefined}
      data-editor-collapsed={cols.editor === 0 || undefined}
      data-editor-exclusive={editorExclusive || undefined}
      data-dragging={dragging || undefined}
    >
      <div className={css.sidebarCol} data-shell-panel="sidebar">
        {/* Render-site slot call with live concession output: a closed
            sidebar keeps the mounted slot at the compact-rail width, and the
            component sees its rendered state as owner params decided here
            (collapsed follows the resolved rail, so a derived auto-collapse
            renders the rail UI too). */}
        {renderSlot('sidebar', {
          collapsed: sidebarCollapsed,
          width: cols.sidebar,
        })}
      </div>
      <>
        {/* Both column occupants stay at fixed tree positions from first
            paint — no loading gate: a bare status line reads worse than
            the shell's own pending rendering. The conversation
            is session-maybe; the strict details entry naturally renders
            empty while no session is current. */}
        <CenterColumn hidden={editorExclusive}>{renderSlot('conversation', {})}</CenterColumn>
        <DetailsColumn hidden={cols.details === 0}>{renderSlot('details', {})}</DetailsColumn>
        {cols.editor > 0 && !editorExclusive && (
          <DragHandle
            side="editor"
            left={cols.sidebar + cols.center + cols.details}
            onStart={onEditorStart}
            onDrag={onEditorDrag}
            onEnd={onDragEnd}
            onSet={onEditorSet}
            value={cols.editor}
            min={EDITOR_MIN}
            max={editorMax}
            labelledBy="dsh-ide-title"
            controls="dsh-ide-surface"
          />
        )}
        <EditorColumn hidden={cols.editor === 0}>
          {renderSlot('shell.editor', {
            collapsed: cols.editor === 0,
            exclusive: editorExclusive,
            width: cols.editor,
          })}
        </EditorColumn>
      </>
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {/* The collapsed rail is fixed-width: no resize handle while closed. */}
      {!sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {cols.details > 0 && <DragHandle side="details" left={cols.sidebar + cols.center} onStart={onDetailsStart} onDrag={onDetailsDrag} onEnd={onDragEnd} />}
    </div>
  )
}
