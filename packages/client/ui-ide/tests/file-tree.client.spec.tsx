// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  WorkspaceFilesListRequest,
  WorkspaceFilesListValue,
  WorkspaceFilesResult,
  WorkspaceId,
} from '@deepseek-ai/dsh-api-remotes/client'
import { FileTree, type ListWorkspaceFiles } from '../src/client/FileTree.tsx'

afterEach(cleanup)

const workspace = (value: string): WorkspaceId => value as WorkspaceId
const t = (key: string): string => key
const empty = (directory: readonly string[] = []): WorkspaceFilesResult<WorkspaceFilesListValue> => ({
  ok: true,
  value: { directory, entries: [] },
})

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

describe('IDE file tree', () => {
  it('opens files and loads a directory only on its first expansion', async () => {
    const onOpen = vi.fn()
    const list = vi.fn((request: WorkspaceFilesListRequest) => Promise.resolve(
      request.directory.length === 0
        ? {
          ok: true as const,
          value: {
            directory: [],
            entries: [
              { name: 'src', segments: ['src'], kind: 'directory' as const },
              { name: 'README.md', segments: ['README.md'], kind: 'file' as const, size: 10 },
              { name: 'outside', segments: ['outside'], kind: 'blocked' as const },
              { name: 'socket', segments: ['socket'], kind: 'other' as const },
            ],
          },
        }
        : empty(request.directory),
    ))
    render(<FileTree workspaceId={workspace('w1')} list={list} onOpen={onOpen} t={t as never} />)

    const directory = await screen.findByRole('treeitem', { name: 'src' })
    const file = screen.getByRole('treeitem', { name: 'README.md' })
    const blocked = screen.getByRole('treeitem', { name: 'outside' }) as HTMLButtonElement
    const other = screen.getByRole('treeitem', { name: 'socket' }) as HTMLButtonElement
    expect(directory.getAttribute('aria-expanded')).toBe('false')
    expect(file.getAttribute('aria-expanded')).toBeNull()
    expect(blocked.disabled).toBe(true)
    expect(blocked.title).toBe('entry.blocked')
    expect(other.disabled).toBe(true)
    expect(other.title).toBe('entry.other')

    fireEvent.click(file)
    expect(onOpen).toHaveBeenCalledWith(['README.md'])

    fireEvent.click(directory)
    expect(await screen.findByText('tree.empty')).toBeTruthy()
    expect(directory.getAttribute('aria-expanded')).toBe('true')
    expect(list).toHaveBeenCalledWith(
      { workspaceId: workspace('w1'), directory: ['src'] },
      expect.any(AbortSignal),
    )

    fireEvent.click(directory)
    expect(directory.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('tree.empty')).toBeNull()
    fireEvent.click(directory)
    expect(await screen.findByText('tree.empty')).toBeTruthy()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('shows a business failure and replaces it after retry', async () => {
    const list = vi.fn<ListWorkspaceFiles>()
      .mockResolvedValueOnce({ ok: false, error: { code: 'invalid-path' } })
      .mockResolvedValueOnce(empty())
    render(<FileTree workspaceId={workspace('w1')} list={list} onOpen={() => {}} t={t as never} />)

    expect((await screen.findByRole('alert')).textContent).toBe('error.invalid-path')
    fireEvent.click(screen.getByRole('button', { name: 'tree.retry' }))
    expect(await screen.findByText('tree.empty')).toBeTruthy()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('shows a transport failure and retries the rejected request', async () => {
    const list = vi.fn<ListWorkspaceFiles>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(empty())
    render(<FileTree workspaceId={workspace('w1')} list={list} onOpen={() => {}} t={t as never} />)

    expect((await screen.findByRole('alert')).textContent).toBe('error.transport')
    fireEvent.click(screen.getByRole('button', { name: 'tree.retry' }))
    expect(await screen.findByText('tree.empty')).toBeTruthy()
  })

  it('aborts the previous workspace load and ignores its late result', async () => {
    const old = deferred<WorkspaceFilesResult<WorkspaceFilesListValue>>()
    const list = vi.fn<ListWorkspaceFiles>(request => request.workspaceId === workspace('old')
      ? old.promise
      : Promise.resolve(empty()))
    const view = render(
      <FileTree workspaceId={workspace('old')} list={list} onOpen={() => {}} t={t as never} />,
    )
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(1) })
    const oldSignal = list.mock.calls[0]?.[1]

    view.rerender(
      <FileTree workspaceId={workspace('new')} list={list} onOpen={() => {}} t={t} />,
    )
    expect(await screen.findByText('tree.empty')).toBeTruthy()
    expect(oldSignal?.aborted).toBe(true)

    await act(async () => {
      old.resolve({
        ok: true,
        value: {
          directory: [],
          entries: [{ name: 'stale.ts', segments: ['stale.ts'], kind: 'file' }],
        },
      })
      await old.promise
    })
    expect(screen.queryByRole('treeitem', { name: 'stale.ts' })).toBeNull()
  })

  it('aborts a pending load when the tree unmounts', async () => {
    const pending = deferred<WorkspaceFilesResult<WorkspaceFilesListValue>>()
    const list = vi.fn<ListWorkspaceFiles>(() => pending.promise)
    const view = render(
      <FileTree workspaceId={workspace('w1')} list={list} onOpen={() => {}} t={t as never} />,
    )
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(1) })
    const signal = list.mock.calls[0]?.[1]
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => {
      pending.reject(new Error('settled after abort'))
      await pending.promise.catch(() => {})
    })
  })
})
