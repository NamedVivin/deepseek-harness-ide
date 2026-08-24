/**
 * Pure concession-chain column solver for the four-column AppFrame. The
 * sidebar never concedes. Details shrinks first, the editor shrinks second,
 * and details then derives a zero rendered width before the conversation may
 * fall below its floor. Stored preferences remain unchanged, so widening the
 * frame restores every derived concession. AppFrame owns responsive
 * breakpoints; this solver remains breakpoint-free.
 */

/** Resolved widths for one frame; center may drop below CENTER_MIN only at the final fallback. */
export interface Columns { sidebar: number; center: number; details: number; editor: number }

// Contract-frozen geometry: the four-column concession chain's fixed points.
/** Center column floor; only the final fallback may go below it. */
export const CENTER_MIN = 640
/** Conversation floor retained while an open editor is manually resizable. */
export const CENTER_EDITOR_HARD_MIN = 400
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
 * LG breakpoint); a manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/** Details drag clamp floor. */
export const DETAILS_MIN = 300
/** Details drag clamp ceiling. */
export const DETAILS_MAX = 520
/** Details width before any user drag. */
export const DETAILS_DEFAULT = 360
/** Editor drag clamp floor. */
export const EDITOR_MIN = 560
/** Editor drag clamp ceiling. */
export const EDITOR_MAX = 1200
/** Editor width before any user drag. */
export const EDITOR_DEFAULT = 720
/** Frame width at or below which an open editor owns the content region. */
export const EDITOR_EXCLUSIVE_MAX = 900

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the four column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic. Preferences re-clamp here because they cross the
 * store boundary and callers may still supply stale ranges.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @param editor - editor width preference in px (0 = closed).
 * @returns resolved widths; zero-width right panels remain mounted, while a closed sidebar keeps its compact rail.
 */
export function computeColumns(viewport: number, sidebar: number, details: number, editor: number): Columns {
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX)
  const e0 = editor === 0 ? 0 : clampWidth(editor, EDITOR_MIN, EDITOR_MAX)

  const resolved = (d: number, e: number): Columns => ({
    sidebar: s,
    center: Math.max(0, viewport - s - d - e),
    details: d,
    editor: e,
  })
  const deficit = (d: number, e: number): number => s + CENTER_MIN + d + e - viewport

  if (deficit(d0, e0) <= 0) return resolved(d0, e0)

  const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, d0 - deficit(d0, e0))
  if (deficit(d1, e0) <= 0) return resolved(d1, e0)

  const e1 = e0 === 0 ? 0 : Math.max(EDITOR_MIN, e0 - deficit(d1, e0))
  if (deficit(d1, e1) <= 0) return resolved(d1, e1)

  // Details is the transient inspection column, so it closes before an open
  // editor or the conversation loses its minimum. Reconsider the editor from
  // its stored preference after releasing that track.
  if (d1 > 0) {
    const e2 = e0 === 0
      ? 0
      : Math.max(EDITOR_MIN, Math.min(e0, viewport - s - CENTER_MIN))
    if (deficit(0, e2) <= 0) return resolved(0, e2)
  }

  // Final fallback: an open editor keeps its preference while leaving the
  // conversation a smaller hard floor. AppFrame switches to its exclusive
  // posture before this floor and the editor floor become mutually
  // impossible, so a visible separator always has a real adjustment range.
  const available = Math.max(0, viewport - s)
  const editorMax = Math.min(EDITOR_MAX, Math.max(0, available - CENTER_EDITOR_HARD_MIN))
  const eFinal = e0 === 0 ? 0 : Math.min(e0, editorMax)
  return resolved(0, eFinal)
}
