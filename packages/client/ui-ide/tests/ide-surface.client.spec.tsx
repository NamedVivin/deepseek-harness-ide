// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type {
  WorkspaceFileVersion,
  WorkspaceFilesReadValue,
  WorkspaceFilesResult,
  WorkspaceId,
  WorkspaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { IdeSurface } from '../src/client/IdeSurface.tsx'
import { zh, type IdeLocaleKey } from '../src/client/locales.ts'
import { createIdeStore } from '../src/client/store.ts'

vi.mock('../src/client/CodeEditor.tsx', () => ({
  CodeEditor: ({ value, label, focusLine, focusRevision, onChange }: {
    value: string
    label: string
    focusLine?: number
    focusRevision: number
    onChange: (value: string) => void
  }) => (
    <textarea
      aria-label={label}
      value={value}
      data-focus-line={focusLine}
      data-focus-revision={focusRevision}
      onChange={(event) => { onChange(event.target.value) }}
    />
  ),
}))

afterEach(() => {
  cleanup()
  delete (globalThis as unknown as { __DSH_DESKTOP_LIFECYCLE__?: unknown }).__DSH_DESKTOP_LIFECYCLE__
})

const workspaceId = 'workspace-1' as WorkspaceId
const version = (value: string): WorkspaceFileVersion => value as WorkspaceFileVersion
const workspace: WorkspaceView = {
  workspaceId,
  path: '/host/private/workspace',
  title: 'Project',
  sessionIds: [],
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:00:00.000Z',
}
const workspace2: WorkspaceView = {
  ...workspace,
  workspaceId: 'workspace-2' as WorkspaceId,
  path: '/host/private/workspace-2',
  title: 'Second project',
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function selectorHook<T>(source: {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}): SnapshotSelectorHook<T> {
  return function useSelector<S>(selector: (state: T) => S): S {
    return selector(useSyncExternalStore(
      listener => source.subscribe(listener),
      () => source.getSnapshot(),
    ))
  }
}

function successRead(content: string, currentVersion = 'v1'): WorkspaceFilesResult<WorkspaceFilesReadValue> {
  return { ok: true, value: { path: ['README.md'], content, version: version(currentVersion) } }
}

function mount(options: {
  listFiles?: ReturnType<typeof vi.fn>
  readFile?: ReturnType<typeof vi.fn>
  saveFile?: ReturnType<typeof vi.fn>
  workspaces?: readonly WorkspaceView[]
  collapsed?: boolean
  exclusive?: boolean
  initialize?: (store: ReturnType<ReturnType<typeof createIdeStore>['create']>) => void
} = {}) {
  const store = createIdeStore().create()
  if (options.initialize === undefined) {
    store.actions.dispatch({ type: 'request-workspace', workspaceId })
  } else {
    options.initialize(store)
  }
  const listFiles = options.listFiles ?? vi.fn((_request: unknown, _signal?: AbortSignal) => Promise.resolve({
    ok: true,
    value: {
      directory: [],
      entries: [{ name: 'README.md', segments: ['README.md'], kind: 'file', size: 16 }],
    },
  }))
  const readFile = options.readFile ?? vi.fn(() => Promise.resolve(successRead('# Disk')))
  const saveFile = options.saveFile ?? vi.fn(() => Promise.resolve({
    ok: true,
    value: { path: ['README.md'], version: version('v2') },
  }))
  const workspaces = {
    items: options.workspaces ?? [workspace], archivedSessionIds: [], state: 'idle' as const, phase: 'ready' as const,
    error: null, baselinesReady: true, recentWorkspaceId: workspaceId,
  }
  let collapsed = options.collapsed ?? false
  let exclusive = options.exclusive ?? false
  const openEditor = vi.fn()
  const closeEditor = vi.fn()
  const surface = () => (
    <IdeSurface
      collapsed={collapsed}
      exclusive={exclusive}
      width={collapsed ? 0 : 720}
      useStore={selectorHook(store)}
      actions={store.actions}
      useWorkspaces={selector => selector(workspaces)}
      useSessions={(() => undefined) as never}
      listFiles={listFiles as never}
      readFile={readFile as never}
      saveFile={saveFile as never}
      getIdeSnapshot={() => store.getSnapshot()}
      openEditor={openEditor}
      closeEditor={closeEditor}
      t={key => zh[key as IdeLocaleKey] ?? key}
    />
  )
  const view = render(surface())
  return {
    view,
    store,
    listFiles,
    readFile,
    saveFile,
    openEditor,
    closeEditor,
    setCollapsed(next: boolean) {
      collapsed = next
      view.rerender(surface())
    },
    setExclusive(next: boolean) {
      exclusive = next
      view.rerender(surface())
    },
  }
}

async function openMarkdown(): Promise<HTMLTextAreaElement> {
  fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }))
  return await screen.findByRole('textbox', { name: 'README.md' }) as HTMLTextAreaElement
}

describe('IDE surface', () => {
  it('reads a store-routed file and preserves its requested line', async () => {
    const b = mount()
    b.store.actions.dispatch({
      type: 'begin-open', workspaceId, segments: ['README.md'], line: 13,
    })
    const editor = await screen.findByRole('textbox', { name: 'README.md' }) as HTMLTextAreaElement
    expect(b.readFile).toHaveBeenCalledWith(
      { workspaceId, path: ['README.md'] },
      expect.any(AbortSignal),
    )
    expect(editor.dataset.focusLine).toBe('13')
    expect(editor.dataset.focusRevision).toBe('1')
  })

  it('moves selection and focus across tabs with standard arrow keys', async () => {
    const b = mount()
    b.store.actions.dispatch({ type: 'begin-open', workspaceId, segments: ['README.md'] })
    b.store.actions.dispatch({ type: 'begin-open', workspaceId, segments: ['other.ts'] })
    const first = await screen.findByRole('tab', { name: 'README.md' })
    const second = await screen.findByRole('tab', { name: 'other.ts' })
    fireEvent.click(first)
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    await waitFor(() => {
      expect(b.store.getSnapshot().activeTabId).toBe(JSON.stringify([workspaceId, 'other.ts']))
      expect(document.activeElement).toBe(second)
    })
    fireEvent.keyDown(second, { key: 'ArrowLeft' })
    expect(b.store.getSnapshot().activeTabId).toBe(JSON.stringify([workspaceId, 'README.md']))
    fireEvent.keyDown(first, { key: 'End' })
    expect(b.store.getSnapshot().activeTabId).toBe(JSON.stringify([workspaceId, 'other.ts']))
    fireEvent.keyDown(second, { key: 'Home' })
    expect(b.store.getSnapshot().activeTabId).toBe(JSON.stringify([workspaceId, 'README.md']))
    fireEvent.keyDown(first, { key: 'Enter' })
    expect(b.store.getSnapshot().activeTabId).toBe(JSON.stringify([workspaceId, 'README.md']))
  })

  it('lists by WorkspaceId and previews the unsaved Markdown buffer', async () => {
    const b = mount()
    const editor = await openMarkdown()
    expect(b.listFiles).toHaveBeenCalledWith({ workspaceId, directory: [] }, expect.any(AbortSignal))
    expect(b.readFile).toHaveBeenCalledWith({ workspaceId, path: ['README.md'] }, expect.any(AbortSignal))
    expect(b.listFiles.mock.calls[0]?.[0]).not.toHaveProperty('path')

    fireEvent.change(editor, { target: { value: '# Unsaved preview' } })
    expect(screen.getByText('有未保存的更改')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '预览' }))
    expect(await screen.findByRole('heading', { name: 'Unsaved preview' })).toBeTruthy()
  })

  it('captures Cmd/Ctrl+S content and remains dirty when editing continues during save', async () => {
    let settle: ((result: unknown) => void) | undefined
    const saveFile = vi.fn(() => new Promise((resolve) => { settle = resolve }))
    const b = mount({ saveFile })
    const editor = await openMarkdown()
    fireEvent.change(editor, { target: { value: 'submitted' } })
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(saveFile).toHaveBeenCalledWith({
      workspaceId,
      path: ['README.md'],
      content: 'submitted',
      expectedVersion: version('v1'),
    })
    fireEvent.change(editor, { target: { value: 'newer' } })
    settle?.({ ok: true, value: { path: ['README.md'], version: version('v2') } })
    await waitFor(() => {
      expect(b.store.getSnapshot().tabs[0]).toMatchObject({
        baseContent: 'submitted', content: 'newer', dirty: true, save: undefined,
      })
    })
  })

  it('retains local and disk content and exposes the three explicit conflict actions', async () => {
    const readFile = vi.fn()
      .mockResolvedValueOnce(successRead('disk base'))
      .mockResolvedValueOnce(successRead('disk latest', 'v9'))
    const saveFile = vi.fn().mockResolvedValue({ ok: false, error: { code: 'version-conflict' } })
    mount({ readFile, saveFile })
    const editor = await openMarkdown()
    fireEvent.change(editor, { target: { value: 'local buffer' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('文件已在磁盘上更改')).toBeTruthy()
    expect(screen.getByText('本地内容').parentElement?.querySelector('pre')?.textContent).toBe('local buffer')
    expect(screen.getByText('磁盘内容').parentElement?.querySelector('pre')?.textContent).toBe('disk latest')
    expect(screen.getByRole('button', { name: '继续编辑' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '从磁盘重新加载' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '用本地内容覆盖' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(screen.queryByText('磁盘内容')).toBeNull()
  })

  it('requires save, discard, or cancel before closing a dirty tab', async () => {
    mount()
    const editor = await openMarkdown()
    fireEvent.change(editor, { target: { value: 'dirty' } })
    fireEvent.click(screen.getByRole('button', { name: '关闭标签页: README.md' }))
    const dialog = await screen.findByRole('dialog', { name: '此文件尚未保存' })
    expect(within(dialog).getAllByRole('button', { name: '取消' })).toHaveLength(2)
    expect(within(dialog).getByRole('button', { name: '放弃' })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: '保存' })).toBeTruthy()
    fireEvent.click(within(dialog).getAllByRole('button', { name: '取消' }).at(0)!)
    expect(screen.queryByRole('dialog', { name: '此文件尚未保存' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'README.md' })).toHaveProperty('value', 'dirty')

    fireEvent.click(screen.getByRole('button', { name: '关闭标签页: README.md' }))
    const reopened = await screen.findByRole('dialog', { name: '此文件尚未保存' })
    fireEvent.click(within(reopened).getByRole('button', { name: '放弃' }))
    expect(screen.queryByRole('textbox', { name: 'README.md' })).toBeNull()
  })

  it('closes the layout column without removing the open tab or dirty buffer', async () => {
    const b = mount()
    const editor = await openMarkdown()
    fireEvent.change(editor, { target: { value: 'kept' } })
    const surface = screen.getByRole('region', { name: '编辑器' })
    const close = within(surface).getByRole('button', { name: '关闭编辑器' })
    fireEvent.click(close)
    expect(b.closeEditor).toHaveBeenCalledOnce()
    expect(b.store.getSnapshot().tabs[0]).toMatchObject({ content: 'kept', dirty: true })
    b.setCollapsed(true)
    expect(surface.hasAttribute('inert')).toBe(true)
    expect(b.view.container.querySelector('[aria-hidden="true"]')).toBeTruthy()
  })

  it('moves focus into the opened pane and returns it to the header action', async () => {
    const opener = render(<button id="dsh-ide-toggle" type="button">编辑器</button>)
      .getByRole('button', { name: '编辑器' })
    opener.focus()
    const b = mount({
      collapsed: true,
      initialize: (store) => { store.actions.dispatch({ type: 'request-workspace', workspaceId }) },
    })
    expect(document.activeElement).toBe(opener)

    act(() => { b.setCollapsed(false) })
    const close = await screen.findByRole('button', { name: '关闭编辑器' })
    await waitFor(() => { expect(document.activeElement).toBe(close) })
    fireEvent.click(close)
    act(() => { b.setCollapsed(true) })
    await waitFor(() => { expect(document.activeElement).toBe(opener) })
  })

  it('moves focus from hidden conversation chrome but preserves sidebar focus', async () => {
    const chrome = render(
      <>
        <div data-shell-panel="sidebar"><button type="button">Sidebar action</button></div>
        <div data-shell-panel="conversation"><button type="button">Conversation action</button></div>
      </>,
    )
    const conversationAction = chrome.getByRole('button', { name: 'Conversation action' })
    const sidebarAction = chrome.getByRole('button', { name: 'Sidebar action' })
    const b = mount()
    conversationAction.focus()
    expect(document.activeElement).toBe(conversationAction)

    act(() => { b.setExclusive(true) })
    const close = await screen.findByRole('button', { name: '关闭编辑器' })
    await waitFor(() => { expect(document.activeElement).toBe(close) })

    act(() => { b.setExclusive(false) })
    sidebarAction.focus()
    act(() => { b.setExclusive(true) })
    expect(document.activeElement).toBe(sidebarAction)

    act(() => { b.setExclusive(false) })
    const separator = document.createElement('div')
    separator.tabIndex = 0
    document.body.append(separator)
    separator.focus()
    separator.remove()
    expect(document.activeElement).toBe(document.body)
    act(() => { b.setExclusive(true) })
    await waitFor(() => { expect(document.activeElement).toBe(close) })
  })

  it('settles desktop quit only after an explicit dirty-buffer decision', async () => {
    let handler: ((payload: {
      readonly reason: 'window-close'
    }, signal: AbortSignal) => Promise<{ readonly ready: boolean }>) | undefined
    ;(globalThis as unknown as { __DSH_DESKTOP_LIFECYCLE__: unknown }).__DSH_DESKTOP_LIFECYCLE__ = {
      handle: (_method: string, registered: typeof handler) => {
        handler = registered
        return () => { handler = undefined }
      },
    }
    mount()
    const editor = await openMarkdown()
    fireEvent.change(editor, { target: { value: 'dirty' } })

    const cancelled = handler?.({ reason: 'window-close' }, new AbortController().signal)
    const first = await screen.findByRole('dialog', { name: '退出 DeepSeek Harness IDE？' })
    fireEvent.click(within(first).getAllByRole('button', { name: '取消' }).at(-1)!)
    await expect(cancelled).resolves.toEqual({ ready: false })

    const discarded = handler?.({ reason: 'window-close' }, new AbortController().signal)
    const second = await screen.findByRole('dialog', { name: '退出 DeepSeek Harness IDE？' })
    fireEvent.click(within(second).getByRole('button', { name: '放弃' }))
    await expect(discarded).resolves.toEqual({ ready: true })
  })

  it('waits for Host persistence before approving save-all-and-quit', async () => {
    let handler: ((payload: {
      readonly reason: 'application-quit'
    }, signal: AbortSignal) => Promise<{ readonly ready: boolean }>) | undefined
    ;(globalThis as unknown as { __DSH_DESKTOP_LIFECYCLE__: unknown }).__DSH_DESKTOP_LIFECYCLE__ = {
      handle: (_method: string, registered: typeof handler) => {
        handler = registered
        return () => { handler = undefined }
      },
    }
    const b = mount()
    const editor = await openMarkdown()
    fireEvent.change(editor, { target: { value: 'persist me' } })
    const response = handler?.({ reason: 'application-quit' }, new AbortController().signal)
    const dialog = await screen.findByRole('dialog', { name: '退出 DeepSeek Harness IDE？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '全部保存并退出' }))
    await expect(response).resolves.toEqual({ ready: true })
    expect(b.saveFile).toHaveBeenCalledWith({
      workspaceId,
      path: ['README.md'],
      content: 'persist me',
      expectedVersion: version('v1'),
    })
    expect(b.store.getSnapshot().tabs[0]?.dirty).toBe(false)
  })

  it('does not turn save-all-and-quit into an implicit conflict overwrite', async () => {
    let handler: ((payload: {
      readonly reason: 'application-quit'
    }, signal: AbortSignal) => Promise<{ readonly ready: boolean }>) | undefined
    ;(globalThis as unknown as { __DSH_DESKTOP_LIFECYCLE__: unknown }).__DSH_DESKTOP_LIFECYCLE__ = {
      handle: (_method: string, registered: typeof handler) => {
        handler = registered
        return () => { handler = undefined }
      },
    }
    const readFile = vi.fn()
      .mockResolvedValueOnce(successRead('disk base'))
      .mockResolvedValue(successRead('disk latest', 'v9'))
    const saveFile = vi.fn().mockResolvedValue({ ok: false, error: { code: 'version-conflict' } })
    const b = mount({ readFile, saveFile })
    const editor = await openMarkdown()
    fireEvent.change(editor, { target: { value: 'local buffer' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('文件已在磁盘上更改')).toBeTruthy()

    const response = handler?.({ reason: 'application-quit' }, new AbortController().signal)
    const dialog = await screen.findByRole('dialog', { name: '退出 DeepSeek Harness IDE？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '全部保存并退出' }))

    await expect(response).resolves.toEqual({ ready: false })
    expect(saveFile).toHaveBeenLastCalledWith({
      workspaceId,
      path: ['README.md'],
      content: 'local buffer',
      expectedVersion: version('v1'),
    })
    expect(b.store.getSnapshot().tabs[0]).toMatchObject({ content: 'local buffer', dirty: true })
  })

  it('selects the first workspace and renders the empty inventory state', async () => {
    const automatic = mount({
      initialize: () => {},
    })
    await waitFor(() => { expect(automatic.store.getSnapshot().selectedWorkspaceId).toBe(workspaceId) })
    cleanup()

    const empty = mount({
      workspaces: [],
      initialize: () => {},
    })
    expect(screen.getByText('请先添加一个工作区，再从文件树打开文本文件。')).toBeTruthy()
    const select = screen.getByRole('combobox', { name: '工作区' }) as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(select.value).toBe('')
    fireEvent.keyDown(window, { key: 's' })
    fireEvent.keyDown(window, { key: 's', ctrlKey: true, altKey: true })
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'w', metaKey: true })
    expect(empty.saveFile).not.toHaveBeenCalled()
  })

  it('changes the selected workspace through the workspace selector', async () => {
    const b = mount({ workspaces: [workspace, workspace2] })
    fireEvent.change(screen.getByRole('combobox', { name: '工作区' }), {
      target: { value: workspace2.workspaceId },
    })
    await waitFor(() => {
      expect(b.store.getSnapshot()).toMatchObject({ selectedWorkspaceId: workspace2.workspaceId, tabs: [] })
    })
  })

  it('renders business and transport read failures and retries a failed tab', async () => {
    const readFile = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'not-text' } })
      .mockResolvedValueOnce(successRead('recovered'))
      .mockRejectedValueOnce(new Error('offline'))
    mount({ readFile })

    fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('不是有效的 UTF-8 文本')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('textbox', { name: 'README.md' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '关闭标签页: README.md' }))
    await waitFor(() => { expect(screen.queryByRole('textbox', { name: 'README.md' })).toBeNull() })
    fireEvent.click(screen.getByRole('treeitem', { name: /README\.md/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('连接 Host 失败')
  })

  it('aborts reads for a closed tab and for an unmounted surface', async () => {
    const first = deferred<WorkspaceFilesResult<WorkspaceFilesReadValue>>()
    const second = deferred<WorkspaceFilesResult<WorkspaceFilesReadValue>>()
    const readFile = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const b = mount({ readFile })

    fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }))
    await waitFor(() => { expect(readFile).toHaveBeenCalledTimes(1) })
    const firstSignal = readFile.mock.calls[0]?.[1] as AbortSignal
    const loadingId = b.store.getSnapshot().activeTabId!
    act(() => {
      b.store.actions.dispatch({ type: 'edit-tab', id: loadingId, content: 'ignored while loading' })
    })
    expect(firstSignal.aborted).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '关闭标签页: README.md' }))
    await waitFor(() => { expect(firstSignal.aborted).toBe(true) })
    await act(async () => {
      first.resolve(successRead('stale'))
      await first.promise
    })
    expect(b.store.getSnapshot().tabs).toHaveLength(0)

    fireEvent.click(screen.getByRole('treeitem', { name: /README\.md/ }))
    await waitFor(() => { expect(readFile).toHaveBeenCalledTimes(2) })
    const secondSignal = readFile.mock.calls[1]?.[1] as AbortSignal
    b.view.unmount()
    expect(secondSignal.aborted).toBe(true)
    await act(async () => {
      second.reject(new Error('settled after unmount'))
      await second.promise.catch(() => {})
    })
  })

  it('reports save rejection, transport failure, and a failed conflict refresh', async () => {
    const readFile = vi.fn()
      .mockResolvedValueOnce(successRead('base'))
      .mockResolvedValueOnce({ ok: false, error: { code: 'not-found' } })
    const saveFile = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'permission-denied' } })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: false, error: { code: 'version-conflict' } })
    mount({ readFile, saveFile })
    const editor = await openMarkdown()
    fireEvent.change(editor, { target: { value: 'local' } })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect((await screen.findByRole('alert')).textContent).toContain('没有权限')
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('连接 Host 失败') })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('不存在') })
  })

  it('saves a dirty tab before closing it', async () => {
    const b = mount()
    const editor = await openMarkdown()
    fireEvent.change(editor, { target: { value: 'save then close' } })
    fireEvent.click(screen.getByRole('button', { name: '关闭标签页: README.md' }))
    const dialog = await screen.findByRole('dialog', { name: '此文件尚未保存' })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(b.store.getSnapshot().tabs).toHaveLength(0) })
    expect(b.saveFile).toHaveBeenCalledWith({
      workspaceId,
      path: ['README.md'],
      content: 'save then close',
      expectedVersion: version('v1'),
    })
  })

  it('cancels and confirms an explicit conflict reload', async () => {
    const readFile = vi.fn()
      .mockResolvedValueOnce(successRead('base'))
      .mockResolvedValueOnce(successRead('latest', 'v9'))
    const saveFile = vi.fn().mockResolvedValue({ ok: false, error: { code: 'version-conflict' } })
    mount({ readFile, saveFile })
    const editor = await openMarkdown()
    fireEvent.change(editor, { target: { value: 'local' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('文件已在磁盘上更改')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '从磁盘重新加载' }))
    let dialog = await screen.findByRole('dialog', { name: '放弃本地更改？' })
    fireEvent.click(within(dialog).getAllByRole('button', { name: '取消' }).at(0)!)
    expect(screen.queryByRole('dialog', { name: '放弃本地更改？' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '从磁盘重新加载' }))
    dialog = await screen.findByRole('dialog', { name: '放弃本地更改？' })
    fireEvent.click(within(dialog).getAllByRole('button', { name: '取消' }).at(-1)!)
    expect(screen.queryByRole('dialog', { name: '放弃本地更改？' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '从磁盘重新加载' }))
    dialog = await screen.findByRole('dialog', { name: '放弃本地更改？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '放弃并重新加载' }))
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'README.md' })).toHaveProperty('value', 'latest')
    })
  })

  it('overwrites a conflict against the displayed disk version', async () => {
    const readFile = vi.fn()
      .mockResolvedValueOnce(successRead('base'))
      .mockResolvedValueOnce(successRead('latest', 'v9'))
    const saveFile = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'version-conflict' } })
      .mockResolvedValueOnce({ ok: true, value: { path: ['README.md'], version: version('v10') } })
    const b = mount({ readFile, saveFile })
    const editor = await openMarkdown()
    fireEvent.change(editor, { target: { value: 'local' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    fireEvent.click(await screen.findByRole('button', { name: '用本地内容覆盖' }))

    await waitFor(() => { expect(b.store.getSnapshot().tabs[0]?.conflict).toBeUndefined() })
    expect(saveFile).toHaveBeenLastCalledWith({
      workspaceId,
      path: ['README.md'],
      content: 'local',
      expectedVersion: version('v9'),
    })
  })

  it('supports every dirty-workspace decision from the selector prompt', async () => {
    const b = mount({ workspaces: [workspace, workspace2] })
    const editor = await openMarkdown()
    fireEvent.change(editor, { target: { value: 'local' } })
    const select = screen.getByRole('combobox', { name: '工作区' })

    fireEvent.change(select, { target: { value: workspace2.workspaceId } })
    let dialog = await screen.findByRole('dialog', { name: '切换工作区？' })
    fireEvent.click(within(dialog).getAllByRole('button', { name: '取消' }).at(0)!)

    fireEvent.change(select, { target: { value: workspace2.workspaceId } })
    dialog = await screen.findByRole('dialog', { name: '切换工作区？' })
    fireEvent.click(within(dialog).getAllByRole('button', { name: '取消' }).at(-1)!)

    fireEvent.change(select, { target: { value: workspace2.workspaceId } })
    dialog = await screen.findByRole('dialog', { name: '切换工作区？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '放弃' }))
    await waitFor(() => {
      expect(b.store.getSnapshot()).toMatchObject({ selectedWorkspaceId: workspace2.workspaceId, tabs: [] })
    })
  })

  it('saves all dirty tabs before switching workspaces', async () => {
    const pending = deferred<unknown>()
    const saveFile = vi.fn(() => pending.promise)
    const b = mount({ saveFile, workspaces: [workspace, workspace2] })
    const editor = await openMarkdown()
    fireEvent.change(editor, { target: { value: 'persist' } })
    fireEvent.change(screen.getByRole('combobox', { name: '工作区' }), {
      target: { value: workspace2.workspaceId },
    })
    const dialog = await screen.findByRole('dialog', { name: '切换工作区？' })
    const saveAll = within(dialog).getByRole('button', { name: '全部保存并切换' }) as HTMLButtonElement
    fireEvent.click(saveAll)
    await waitFor(() => { expect(saveAll.disabled).toBe(true) })
    pending.resolve({ ok: true, value: { path: ['README.md'], version: version('v2') } })
    await waitFor(() => { expect(b.store.getSnapshot().selectedWorkspaceId).toBe(workspace2.workspaceId) })
  })

  it('disables workspace save-all while a tab save is already in flight', async () => {
    const pending = deferred<unknown>()
    const saveFile = vi.fn(() => pending.promise)
    mount({ saveFile, workspaces: [workspace, workspace2] })
    const editor = await openMarkdown()
    fireEvent.change(editor, { target: { value: 'persist' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    fireEvent.change(screen.getByRole('combobox', { name: '工作区' }), {
      target: { value: workspace2.workspaceId },
    })
    const dialog = await screen.findByRole('dialog', { name: '切换工作区？' })
    expect(within(dialog).getByRole('button', { name: '全部保存并切换' })).toHaveProperty('disabled', true)
    pending.resolve({ ok: true, value: { path: ['README.md'], version: version('v2') } })
  })

  it('handles clean, aborted, duplicate, and UI-cancelled desktop quit requests', async () => {
    let handler: ((payload: {
      readonly reason: 'window-close'
    }, signal: AbortSignal) => Promise<{ readonly ready: boolean }>) | undefined
    ;(globalThis as unknown as { __DSH_DESKTOP_LIFECYCLE__: unknown }).__DSH_DESKTOP_LIFECYCLE__ = {
      handle: (_method: string, registered: typeof handler) => {
        handler = registered
        return () => { handler = undefined }
      },
    }
    const b = mount()
    const editor = await openMarkdown()

    const cleanUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(cleanUnload)
    expect(cleanUnload.defaultPrevented).toBe(false)
    await expect(handler?.({ reason: 'window-close' }, new AbortController().signal)).resolves.toEqual({ ready: true })

    fireEvent.change(editor, { target: { value: 'dirty' } })
    const dirtyUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirtyUnload)
    expect(dirtyUnload.defaultPrevented).toBe(true)
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
    let closeDialog = await screen.findByRole('dialog', { name: '此文件尚未保存' })
    fireEvent.click(within(closeDialog).getAllByRole('button', { name: '取消' }).at(-1)!)

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(handler?.({ reason: 'window-close' }, alreadyAborted.signal)).resolves.toEqual({ ready: false })

    const firstController = new AbortController()
    const first = handler?.({ reason: 'window-close' }, firstController.signal)
    await screen.findByRole('dialog', { name: '退出 DeepSeek Harness IDE？' })
    await expect(handler?.({ reason: 'window-close' }, new AbortController().signal)).resolves.toEqual({ ready: false })
    firstController.abort()
    await expect(first).resolves.toEqual({ ready: false })

    const cancelled = handler?.({ reason: 'window-close' }, new AbortController().signal)
    const quitDialog = await screen.findByRole('dialog', { name: '退出 DeepSeek Harness IDE？' })
    fireEvent.click(within(quitDialog).getAllByRole('button', { name: '取消' }).at(0)!)
    await expect(cancelled).resolves.toEqual({ ready: false })
    closeDialog = screen.queryByRole('dialog', { name: '此文件尚未保存' }) as HTMLElement
    expect(closeDialog).toBeNull()
    expect(b.store.getSnapshot().tabs[0]?.dirty).toBe(true)
  })
})
