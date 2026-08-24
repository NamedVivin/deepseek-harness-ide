/** Assembled IDE journey over the shipped Web carrier and IDE bundle. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const IDE_OVERLAY = fileURLToPath(new URL('../../../packages/bundle/ide-app/cordis.patch.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/ide-workspace', import.meta.url))
const CONFLICT_EXPECTED = fileURLToPath(new URL('./snapshots/ide-workspace/conflict.expected.md', import.meta.url))
const PLACEMENT_EXPECTED = fileURLToPath(new URL('./snapshots/ide-workspace/placement.expected.md', import.meta.url))
const LOCAL_CONTENT = '# Local draft\n\nThis preview comes from the unsaved editor buffer.\n'
const DISK_CONTENT = '# Disk revision\n\nAnother writer saved this version.\n'
const WIDE_VIEWPORT = { width: 1920, height: 960 }
const NARROW_VIEWPORT = { width: 900, height: 960 }
const DRAG_DISTANCE = 120
const EDGE_TOLERANCE = 1

type ShellPanel = 'sidebar' | 'conversation' | 'details' | 'editor'

interface LayoutBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface LayoutStop {
  readonly state: string
  readonly visiblePanels: string
  readonly overlappingPairs: number
  readonly sharedEdges: boolean
  readonly editorAtRight: boolean | null
  readonly editorInOverlay: boolean
  readonly separator: boolean
  readonly widthTransferConserved: boolean | null
}

function appFrame(page: Page): Locator {
  return page.locator('[data-shell-frame]')
}

function shellPanel(page: Page, panel: ShellPanel): Locator {
  return appFrame(page).locator(`[data-shell-panel="${panel}"]`)
}

function editorResizeHandle(page: Page): Locator {
  return appFrame(page).locator('[data-resize-handle="editor"]')
}

async function elementBox(locator: Locator): Promise<LayoutBox> {
  await locator.waitFor({ state: 'attached', timeout: 15_000 })
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  })
}

async function activeSurfaceContainsFocus(surface: Locator): Promise<boolean> {
  return surface.evaluate((element) => {
    const active = element.ownerDocument.activeElement
    return active instanceof HTMLElement && element.contains(active) && active.closest('[inert]') === null
  })
}

function right(box: LayoutBox): number {
  return box.x + box.width
}

function overlapWidth(a: LayoutBox, b: LayoutBox): number {
  return Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x))
}

function expectNear(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(EDGE_TOLERANCE)
}

async function settleShell(page: Page): Promise<void> {
  await Promise.all((['sidebar', 'conversation', 'details', 'editor'] as const)
    .map(panel => shellPanel(page, panel).waitFor({ state: 'attached', timeout: 15_000 })))
  await appFrame(page).evaluate(async (frame) => {
    const read = (): number[] => Array.from(frame.querySelectorAll<HTMLElement>('[data-shell-panel]'))
      .flatMap((panel) => {
        const box = panel.getBoundingClientRect()
        return [box.x, box.width]
      })
    const deadline = performance.now() + 5_000
    let previous = read()
    let stableFrames = 0
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
      const current = read()
      const stable = current.length === previous.length
        && current.every((value, index) => Math.abs(value - (previous[index] ?? Number.NaN)) < 0.01)
      stableFrames = stable ? stableFrames + 1 : 0
      if (stableFrames >= 3) return
      previous = current
    }
    throw new Error('shell panel widths did not settle')
  })
}

async function assertWideEditorSplit(page: Page, surface: Locator): Promise<{
  conversation: LayoutBox
  editor: LayoutBox
}> {
  await settleShell(page)
  const [frame, conversation, editor, surfaceBox, handle] = await Promise.all([
    elementBox(appFrame(page)),
    elementBox(shellPanel(page, 'conversation')),
    elementBox(shellPanel(page, 'editor')),
    elementBox(surface),
    elementBox(editorResizeHandle(page)),
  ])
  expect(conversation.width).toBeGreaterThan(300)
  expect(editor.width).toBeGreaterThan(300)
  expect(overlapWidth(conversation, editor)).toBeLessThanOrEqual(EDGE_TOLERANCE)
  expectNear(right(conversation), editor.x, 'conversation and editor share one edge')
  expectNear(editor.x, handle.x + handle.width / 2, 'editor divider follows the shared edge')
  expectNear(right(editor), right(frame), 'editor occupies the frame right edge')
  expectNear(surfaceBox.x, editor.x, 'editor surface starts at its shell column')
  expectNear(surfaceBox.width, editor.width, 'editor surface fills its shell column')
  expect(await page.locator('[data-shell-overlay] section[aria-label="Editor"]').count()).toBe(0)
  expect(await editorResizeHandle(page).getAttribute('role')).toBe('separator')
  expect(await editorResizeHandle(page).getAttribute('aria-orientation')).toBe('vertical')
  expect(await editorResizeHandle(page).evaluate(element => getComputedStyle(element).cursor)).toBe('col-resize')
  return { conversation, editor }
}

async function layoutStop(
  page: Page,
  state: string,
  widthTransferConserved: boolean | null = null,
): Promise<LayoutStop> {
  const panels = await Promise.all((['sidebar', 'conversation', 'details', 'editor'] as const)
    .map(async name => ({ name, box: await elementBox(shellPanel(page, name)) })))
  const visible = panels.filter(({ box }) => box.width > EDGE_TOLERANCE).sort((a, b) => a.box.x - b.box.x)
  let overlappingPairs = 0
  for (let left = 0; left < visible.length; left += 1) {
    for (let rightIndex = left + 1; rightIndex < visible.length; rightIndex += 1) {
      if (overlapWidth(visible[left]!.box, visible[rightIndex]!.box) > EDGE_TOLERANCE) overlappingPairs += 1
    }
  }
  const sharedEdges = visible.slice(1).every((panel, index) =>
    Math.abs(right(visible[index]!.box) - panel.box.x) <= EDGE_TOLERANCE)
  const editor = panels.find(panel => panel.name === 'editor')!.box
  const frame = await elementBox(appFrame(page))
  const separator = await editorResizeHandle(page).count() === 1 && await editorResizeHandle(page).isVisible()
  return {
    state,
    visiblePanels: visible.map(panel => panel.name).join(' → '),
    overlappingPairs,
    sharedEdges,
    editorAtRight: editor.width > EDGE_TOLERANCE
      ? Math.abs(right(editor) - right(frame)) <= EDGE_TOLERANCE
      : null,
    editorInOverlay: await page.locator('[data-shell-overlay] section[aria-label="Editor"]').count() > 0,
    separator,
    widthTransferConserved,
  }
}

function renderPlacementSnapshot(aria: string, stops: readonly LayoutStop[]): string {
  return [
    aria,
    '',
    '# Docked editor layout',
    '',
    '| state | visible panels | overlapping pairs | shared edges | editor at right | editor in overlay | separator | width transfer conserved |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...stops.map(stop => `| ${stop.state} | ${stop.visiblePanels} | ${String(stop.overlappingPairs)} `
      + `| ${String(stop.sharedEdges)} | ${stop.editorAtRight === null ? '—' : String(stop.editorAtRight)} `
      + `| ${String(stop.editorInOverlay)} | ${String(stop.separator)} `
      + `| ${stop.widthTransferConserved === null ? '—' : String(stop.widthTransferConserved)} |`),
  ].join('\n')
}

describe('web e2e: workspace IDE editing and conflict recovery', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let project: string
  let document: string
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: IDE_OVERLAY })
    project = join(scaffold.workspaceCwd, 'ide-snapshot')
    document = join(project, 'README.md')
    await mkdir(join(project, 'src'), { recursive: true })
    await Promise.all([
      writeFile(document, '# Initial document\n\nOpen this file in the IDE.\n'),
      writeFile(join(project, 'src', 'index.ts'), 'export const ready = true\n'),
    ])
    await scaffold.ctx.workspaceRegistry.create(project, 'IDE snapshot')

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.setViewportSize(WIDE_VIEWPORT)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await appFrame(page).waitFor({ timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('previews the live buffer, preserves both conflict versions, and overwrites only after confirmation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ide-workspace'))
    const stops: LayoutStop[] = []
    const editorAction = page.getByRole('button', { name: 'Editor', exact: true })
    await editorAction.click()
    const surface = page.locator('section[aria-label="Editor"]')
    await surface.waitFor({ timeout: 15_000 })
    const initial = await assertWideEditorSplit(page, surface)
    const placementAria = await captureStableAria(page, '[data-shell-frame]', scaffold.workspaceCwd)
    expect(placementAria).toContain('separator "Editor"')
    stops.push(await layoutStop(page, 'wide open'))

    const handle = editorResizeHandle(page)
    const beforeValue = Number(await handle.getAttribute('aria-valuenow'))
    const minValue = Number(await handle.getAttribute('aria-valuemin'))
    const maxValue = Number(await handle.getAttribute('aria-valuemax'))
    expect(Number.isFinite(beforeValue)).toBe(true)
    expect(Number.isFinite(minValue)).toBe(true)
    expect(Number.isFinite(maxValue)).toBe(true)
    expect(beforeValue).toBeGreaterThanOrEqual(minValue)
    expect(beforeValue).toBeLessThanOrEqual(maxValue)
    const handleBox = await elementBox(handle)
    const dragY = handleBox.y + handleBox.height / 2
    const dragX = handleBox.x + handleBox.width / 2
    await page.mouse.move(dragX, dragY)
    await page.mouse.down()
    await page.mouse.move(dragX - DRAG_DISTANCE, dragY, { steps: 6 })
    await page.mouse.up()
    const dragged = await assertWideEditorSplit(page, surface)
    const editorDelta = dragged.editor.width - initial.editor.width
    const conversationDelta = dragged.conversation.width - initial.conversation.width
    expect(editorDelta).toBeGreaterThan(DRAG_DISTANCE - 20)
    expect(conversationDelta).toBeLessThan(-DRAG_DISTANCE + 20)
    expect(Math.abs(editorDelta + conversationDelta)).toBeLessThanOrEqual(EDGE_TOLERANCE)
    expect(Number(await handle.getAttribute('aria-valuenow'))).toBeGreaterThan(beforeValue)
    stops.push(await layoutStop(page, 'wide after drag', true))

    const conversationFocusTarget = shellPanel(page, 'conversation').locator('button:not([disabled])').first()
    await conversationFocusTarget.focus()
    expect(await conversationFocusTarget.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
    await page.setViewportSize(NARROW_VIEWPORT)
    await settleShell(page)
    const [narrowFrame, narrowSidebar, narrowConversation, narrowDetails, narrowEditor] = await Promise.all([
      elementBox(appFrame(page)),
      elementBox(shellPanel(page, 'sidebar')),
      elementBox(shellPanel(page, 'conversation')),
      elementBox(shellPanel(page, 'details')),
      elementBox(shellPanel(page, 'editor')),
    ])
    expect(narrowSidebar.width).toBeGreaterThan(0)
    expect(narrowConversation.width).toBeLessThanOrEqual(EDGE_TOLERANCE)
    expect(narrowDetails.width).toBeLessThanOrEqual(EDGE_TOLERANCE)
    expect(narrowEditor.width).toBeGreaterThan(0)
    expectNear(narrowEditor.x, right(narrowSidebar), 'narrow editor starts after the sidebar rail')
    expectNear(right(narrowEditor), right(narrowFrame), 'narrow editor fills the content area')
    expect(await editorResizeHandle(page).count()).toBe(0)
    expect(await shellPanel(page, 'conversation').getAttribute('inert')).not.toBeNull()
    expect(await shellPanel(page, 'details').getAttribute('inert')).not.toBeNull()
    await expect.poll(() => activeSurfaceContainsFocus(surface)).toBe(true)
    stops.push(await layoutStop(page, 'narrow exclusive'))

    await page.setViewportSize(WIDE_VIEWPORT)
    const restored = await assertWideEditorSplit(page, surface)
    expectNear(restored.editor.width, dragged.editor.width, 'wide viewport restores the dragged editor preference')
    stops.push(await layoutStop(page, 'wide restored'))

    await surface.getByLabel('Workspace').selectOption({ label: 'IDE snapshot' })

    const tree = surface.getByRole('tree', { name: 'Files' })
    await tree.getByRole('treeitem', { name: 'README.md', exact: true }).click()
    const codeEditor = surface.locator('.cm-content[aria-label="README.md"]')
    await codeEditor.waitFor({ timeout: 15_000 })
    await codeEditor.fill(LOCAL_CONTENT)
    await surface.getByRole('button', { name: 'Preview', exact: true }).click()
    const preview = surface.getByRole('region', { name: 'Preview', exact: true })
    await expect.poll(() => preview.getByText('This preview comes from the unsaved editor buffer.', { exact: true }).count())
      .toBe(1)
    await surface.getByRole('button', { name: 'Source', exact: true }).click()

    await writeFile(document, DISK_CONTENT)
    await surface.getByRole('button', { name: 'Save', exact: true }).click()
    await surface.getByText('The file changed on disk', { exact: true }).waitFor({ timeout: 15_000 })
    expect(await readFile(document, 'utf8')).toBe(DISK_CONTENT)

    const snapshot = await captureStableAria(page, 'section[aria-label="Editor"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(CONFLICT_EXPECTED, snapshot, MODE)

    await surface.getByRole('button', { name: 'Overwrite with local content', exact: true }).click()
    await expect.poll(() => readFile(document, 'utf8')).toBe(LOCAL_CONTENT)
    await expect.poll(() => surface.getByText('The file changed on disk', { exact: true }).count()).toBe(0)
    expect(await surface.getByRole('status').innerText()).toBe('Saved')
    const beforeClose = await assertWideEditorSplit(page, surface)
    await page.getByRole('button', { name: 'Close editor', exact: true }).click()
    await expect.poll(() => surface.getAttribute('aria-hidden')).toBe('true')
    await settleShell(page)
    const [closedConversation, closedEditor] = await Promise.all([
      elementBox(shellPanel(page, 'conversation')),
      elementBox(shellPanel(page, 'editor')),
    ])
    expect(closedEditor.width).toBeLessThanOrEqual(EDGE_TOLERANCE)
    expectNear(
      closedConversation.width - beforeClose.conversation.width,
      beforeClose.editor.width,
      'closing the editor gives its width back to the conversation',
    )
    expect(await editorResizeHandle(page).count()).toBe(0)
    await expect.poll(() => editorAction.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
    expect(await page.getByRole('button', { name: 'Editor', exact: true }).count()).toBe(1)
    stops.push(await layoutStop(page, 'wide closed'))
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])

    await compareOrRefreshGolden(
      PLACEMENT_EXPECTED,
      renderPlacementSnapshot(placementAria, stops),
      MODE,
    )
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['conflict.expected.md', 'placement.expected.md'])
  }, 90_000)
})
