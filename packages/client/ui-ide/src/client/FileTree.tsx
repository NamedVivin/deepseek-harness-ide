/** Lazy, bounded file tree over the Host-owned workspace file Remote. */

import type {
  WorkspaceFileEntry,
  WorkspaceFileSegments,
  WorkspaceFilesListRequest,
  WorkspaceFilesListValue,
  WorkspaceFilesResult,
  WorkspaceId,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCodeOutline16,
  IconFolderClose16,
  IconFolderOpen16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { IdeLocaleKey } from './locales.ts'
import css from './FileTree.module.css'

type DirectoryState =
  | { readonly phase: 'loading' | 'ready'; readonly entries: readonly WorkspaceFileEntry[] }
  | { readonly phase: 'error'; readonly entries: readonly WorkspaceFileEntry[]; readonly error: IdeLocaleKey }

/** Narrow workspace-file list callback supplied by the slot inject face. */
export type ListWorkspaceFiles = (
  request: WorkspaceFilesListRequest,
  signal?: AbortSignal,
) => Promise<WorkspaceFilesResult<WorkspaceFilesListValue>>

function directoryKey(segments: WorkspaceFileSegments): string {
  return JSON.stringify(segments)
}

/**
 * Render a lazy direct-child tree. The Host bounds every directory request;
 * this component never derives authority from a client-visible absolute path.
 * @param props.workspaceId - selected Host-issued workspace id.
 * @param props.list - narrow Remote callback.
 * @param props.onOpen - canonical file-segment selection callback.
 * @param props.t - IDE dictionary lookup.
 * @returns accessible tree view.
 */
export function FileTree({ workspaceId, list, onOpen, t }: {
  workspaceId: WorkspaceId
  list: ListWorkspaceFiles
  onOpen: (segments: WorkspaceFileSegments) => void
  t: (key: IdeLocaleKey) => string
}) {
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([directoryKey([])]))
  const workspaceRef = useRef(workspaceId)
  const controllers = useRef(new Set<AbortController>())

  const load = useCallback(async (segments: WorkspaceFileSegments): Promise<void> => {
    const key = directoryKey(segments)
    const expectedWorkspace = workspaceId
    const controller = new AbortController()
    controllers.current.add(controller)
    setDirectories(current => ({
      ...current,
      [key]: { phase: 'loading', entries: current[key]?.entries ?? [] },
    }))
    try {
      const result = await list({ workspaceId: expectedWorkspace, directory: segments }, controller.signal)
      if (workspaceRef.current !== expectedWorkspace) return
      setDirectories(current => ({
        ...current,
        [key]: result.ok
          ? { phase: 'ready', entries: result.value.entries }
          : { phase: 'error', entries: [], error: `error.${result.error.code}` },
      }))
    } catch {
      if (controller.signal.aborted) return
      setDirectories(current => ({
        ...current,
        [key]: { phase: 'error', entries: [], error: 'error.transport' },
      }))
    } finally {
      controllers.current.delete(controller)
    }
  }, [list, workspaceId])

  useEffect(() => {
    workspaceRef.current = workspaceId
    setDirectories({})
    setExpanded(new Set([directoryKey([])]))
    void load([])
    return () => {
      for (const controller of controllers.current) controller.abort()
      controllers.current.clear()
    }
  }, [load, workspaceId])

  const toggleDirectory = (segments: WorkspaceFileSegments): void => {
    const key = directoryKey(segments)
    const opening = !expanded.has(key)
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    if (opening && directories[key] === undefined) void load(segments)
  }

  const renderDirectory = (segments: WorkspaceFileSegments, depth: number): React.ReactNode => {
    const key = directoryKey(segments)
    const directory = directories[key]
    if (directory === undefined || directory.phase === 'loading') {
      return <li className={css.notice} style={{ '--ide-tree-depth': depth } as React.CSSProperties}>{t('tree.loading')}</li>
    }
    if (directory.phase === 'error') {
      return (
        <li className={css.notice} style={{ '--ide-tree-depth': depth } as React.CSSProperties}>
          <span role="alert">{t(directory.error)}</span>
          <button type="button" className={css.retry} onClick={() => { void load(segments) }}>{t('tree.retry')}</button>
        </li>
      )
    }
    if (directory.entries.length === 0) {
      return <li className={css.notice} style={{ '--ide-tree-depth': depth } as React.CSSProperties}>{t('tree.empty')}</li>
    }
    return directory.entries.map((entry) => {
      const entryKey = directoryKey(entry.segments)
      const isDirectory = entry.kind === 'directory'
      const isExpanded = isDirectory && expanded.has(entryKey)
      const disabled = entry.kind === 'blocked' || entry.kind === 'other'
      const title = entry.kind === 'blocked' ? t('entry.blocked') : entry.kind === 'other' ? t('entry.other') : entry.name
      return (
        <li key={entryKey} role="none">
          <button
            type="button"
            role="treeitem"
            aria-expanded={isDirectory ? isExpanded : undefined}
            className={css.entry}
            style={{ '--ide-tree-depth': depth } as React.CSSProperties}
            disabled={disabled}
            title={title}
            onClick={() => {
              if (isDirectory) toggleDirectory(entry.segments)
              else onOpen(entry.segments)
            }}
          >
            <span className={css.chevron} aria-hidden="true">
              {isDirectory
                ? isExpanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />
                : null}
            </span>
            <span className={css.kind} aria-hidden="true">
              {isDirectory
                ? isExpanded ? <IconFolderOpen16 /> : <IconFolderClose16 />
                : <IconCodeOutline16 />}
            </span>
            <span className={css.name}>{entry.name}</span>
          </button>
          {isDirectory && isExpanded && <ul role="group">{renderDirectory(entry.segments, depth + 1)}</ul>}
        </li>
      )
    })
  }

  return <ul className={css.tree} role="tree" aria-label={t('tree.title')}>{renderDirectory([], 0)}</ul>
}
