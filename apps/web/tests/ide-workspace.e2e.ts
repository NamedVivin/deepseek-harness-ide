/** Assembled IDE journey over the shipped Web carrier and IDE bundle. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
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
const LOCAL_CONTENT = '# Local draft\n\nThis preview comes from the unsaved editor buffer.\n'
const DISK_CONTENT = '# Disk revision\n\nAnother writer saved this version.\n'

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
    await page.setViewportSize({ width: 1440, height: 960 })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('previews the live buffer, preserves both conflict versions, and overwrites only after confirmation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ide-workspace'))
    await page.getByRole('button', { name: 'Editor', exact: true }).click()
    const surface = page.locator('section[aria-label="Editor"]')
    await surface.waitFor({ timeout: 15_000 })
    await surface.getByLabel('Workspace').selectOption({ label: 'IDE snapshot' })

    const tree = surface.getByRole('tree', { name: 'Files' })
    await tree.getByRole('treeitem', { name: 'README.md', exact: true }).click()
    const editor = surface.locator('.cm-content[aria-label="README.md"]')
    await editor.waitFor({ timeout: 15_000 })
    await editor.fill(LOCAL_CONTENT)
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
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['conflict.expected.md'])
  }, 60_000)
})
