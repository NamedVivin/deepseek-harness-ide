import { describe, expect, it } from 'vitest'
import {
  CENTER_EDITOR_HARD_MIN, CENTER_MIN, clampWidth, computeColumns,
  DETAILS_DEFAULT, DETAILS_MIN,
  EDITOR_DEFAULT, EDITOR_MAX,
  SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

// Numeric preference form (0 = closed); helpers keep the scenario names readable.
const open = (width: number) => width
const closed = (_width: number) => 0

describe('clampWidth', () => {
  it('clamps into the range and rounds', () => {
    expect(clampWidth(250.4, 240, 420)).toBe(250)
    expect(clampWidth(100, 240, 420)).toBe(240)
    expect(clampWidth(9999, 240, 420)).toBe(420)
  })
})

describe('computeColumns', () => {
  it('step 1: everything fits at preferred widths', () => {
    const cols = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), closed(EDITOR_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: 1920 - 280 - 360, details: 360, editor: 0 })
  })

  it('closed sidebar keeps its compact rail while closed right panels contribute zero width', () => {
    expect(computeColumns(1920, closed(300), closed(360), closed(EDITOR_DEFAULT)))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 1920 - SIDEBAR_COLLAPSED, details: 0, editor: 0 })
  })

  it('preferences beyond the clamp range are clamped before solving', () => {
    const cols = computeColumns(3000, open(9999), open(1), open(9999))
    expect(cols.sidebar).toBe(420)
    expect(cols.details).toBe(300)
    expect(cols.editor).toBe(EDITOR_MAX)
    expect(computeColumns(1920, open(1), open(DETAILS_DEFAULT), closed(EDITOR_DEFAULT)).sidebar).toBe(SIDEBAR_MIN)
  })

  it('step 2: details shrinks first, center pinned at min', () => {
    // 280 + 360 + 640 = 1280 > 1250; details concedes to 1250-280-640 = 330.
    const cols = computeColumns(1250, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), closed(EDITOR_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: CENTER_MIN, details: 330, editor: 0 })
  })

  it('boundary: exactly at the step-1/step-2 seam', () => {
    const cols = computeColumns(300 + 360 + CENTER_MIN, open(300), open(360), closed(EDITOR_DEFAULT))
    expect(cols).toEqual({ sidebar: 300, center: CENTER_MIN, details: 360, editor: 0 })
    const one = computeColumns(300 + 360 + CENTER_MIN - 1, open(300), open(360), closed(EDITOR_DEFAULT))
    expect(one).toEqual({ sidebar: 300, center: CENTER_MIN, details: 359, editor: 0 })
  })

  it('step 3: details auto-closes when its min still starves center — sidebar holds its preference', () => {
    // 280 + 300 + 640 = 1220 > 1210 → details 0; sidebar untouched: center = 1210-280 = 930.
    const cols = computeColumns(1210, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), closed(EDITOR_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: 930, details: 0, editor: 0 })
  })

  it('the sidebar never concedes: center absorbs the deficit below CENTER_MIN', () => {
    // 700 < 280+640: sidebar keeps 280, center takes 420 < CENTER_MIN.
    const cols = computeColumns(700, open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT), closed(EDITOR_DEFAULT))
    expect(cols).toEqual({ sidebar: SIDEBAR_DEFAULT, center: 420, details: 0, editor: 0 })
  })

  it('sidebar-closed narrow window: details concedes then auto-closes', () => {
    const fits = computeColumns(SIDEBAR_COLLAPSED + DETAILS_MIN + CENTER_MIN, closed(300), open(DETAILS_DEFAULT), closed(EDITOR_DEFAULT))
    expect(fits).toEqual({ sidebar: SIDEBAR_COLLAPSED, center: CENTER_MIN, details: DETAILS_MIN, editor: 0 })
    const starved = computeColumns(
      SIDEBAR_COLLAPSED + DETAILS_MIN + CENTER_MIN - 1,
      closed(300), open(DETAILS_DEFAULT), closed(EDITOR_DEFAULT),
    )
    expect(starved).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: DETAILS_MIN + CENTER_MIN - 1,
      details: 0,
      editor: 0,
    })
  })

  it('tiny viewport: details closes, sidebar holds, center takes the remainder', () => {
    const cols = computeColumns(400, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), closed(EDITOR_DEFAULT))
    expect(cols.details).toBe(0)
    expect(cols.sidebar).toBe(SIDEBAR_DEFAULT)
    expect(cols.center).toBe(Math.max(0, 400 - SIDEBAR_DEFAULT))
  })

  it('recovery is pure: re-widening restores preferred widths untouched', () => {
    const squeezed = computeColumns(1100, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), closed(EDITOR_DEFAULT))
    expect(squeezed.details).toBe(0)
    const restored = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), closed(EDITOR_DEFAULT))
    expect(restored.details).toBe(DETAILS_DEFAULT)
    expect(restored.sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('shrinks details and then editor so both remain beside the center when possible', () => {
    expect(computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(EDITOR_DEFAULT)))
      .toEqual({ sidebar: 280, center: CENTER_MIN, details: DETAILS_MIN, editor: 700 })
  })

  it('derives details closed before the editor or center loses its floor', () => {
    expect(computeColumns(1600, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(EDITOR_DEFAULT)))
      .toEqual({ sidebar: 280, center: CENTER_MIN, details: 0, editor: 680 })
  })

  it('keeps the editor preference while the conversation uses its editor-resize floor', () => {
    expect(computeColumns(1440, open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT), open(EDITOR_DEFAULT)))
      .toEqual({ sidebar: 280, center: 440, details: 0, editor: EDITOR_DEFAULT })
  })

  it('keeps a real editor adjustment range at 1440px', () => {
    expect(computeColumns(1440, open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT), open(680)))
      .toEqual({ sidebar: 280, center: 480, details: 0, editor: 680 })
    expect(computeColumns(1440, open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT), open(760)))
      .toEqual({ sidebar: 280, center: CENTER_EDITOR_HARD_MIN, details: 0, editor: 760 })
  })

  it('shrinks an open editor below its floor only after preserving the conversation hard floor', () => {
    expect(computeColumns(500, closed(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT), open(EDITOR_DEFAULT)))
      .toEqual({
        sidebar: SIDEBAR_COLLAPSED,
        center: CENTER_EDITOR_HARD_MIN,
        details: 0,
        editor: 500 - SIDEBAR_COLLAPSED - CENTER_EDITOR_HARD_MIN,
      })
  })
})

describe('computeColumns — degenerate viewports', () => {
  it('sidebar closed and viewport below CENTER_MIN: details auto-closes, center takes the rest', () => {
    // Reaches step 3's auto-close with the compact rail sidebar.
    expect(computeColumns(500, closed(300), open(DETAILS_DEFAULT), closed(EDITOR_DEFAULT)))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 500 - SIDEBAR_COLLAPSED, details: 0, editor: 0 })
  })
})
