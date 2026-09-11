/** Workspace editor pane mounted in the layout-owned `shell.editor` column. */

import type {
  WorkspaceFileSegments,
  WorkspaceFilesFailure,
  WorkspaceFilesReadRequest,
  WorkspaceFilesReadValue,
  WorkspaceFilesResult,
  WorkspaceFilesSaveRequest,
  WorkspaceFilesSaveValue,
  WorkspaceFileVersion,
  WorkspaceId,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  Button,
  IconCloseOutline16,
  IconCodeOutline16,
  IconRefreshOutline16,
  MarkdownText,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import clsx from 'clsx'
import { CodeEditor } from './CodeEditor.tsx'
import { FileTree, type ListWorkspaceFiles } from './FileTree.tsx'
import type { IdeLocaleKey } from './locales.ts'
import type { IdeConflict, IdeSaveAttempt, IdeTab } from './state.ts'
import type { IdeState } from './state.ts'
import type { createIdeStore } from './store.ts'
import css from './IdeSurface.module.css'

/** Narrow Host file operations delivered by the slot inject factory. */
export interface IdeFilesInjected {
  readonly listFiles: ListWorkspaceFiles
  readonly readFile: (
    request: WorkspaceFilesReadRequest,
    signal?: AbortSignal,
  ) => Promise<WorkspaceFilesResult<WorkspaceFilesReadValue>>
  readonly saveFile: (
    request: WorkspaceFilesSaveRequest,
    signal?: AbortSignal,
  ) => Promise<WorkspaceFilesResult<WorkspaceFilesSaveValue>>
  /** Read the current root editor state outside React's render snapshot. */
  readonly getIdeSnapshot: () => IdeState
}

/** Pane callbacks and file operations delivered by the slot inject factory. */
export interface IdeSurfaceInjected extends IdeFilesInjected {
  /** Open the layout-owned editor column. */
  readonly openEditor: () => void
  /** Close the layout-owned editor column without discarding IDE state. */
  readonly closeEditor: () => void
}

/** Props composed from the editor owner, IDE store, injected callbacks, and dictionary. */
export type IdeSurfaceProps =
  PropsRuntime<'shell.editor'>
  & PropsStore<ReturnType<typeof createIdeStore>>
  & IdeSurfaceInjected
  & PropsLocale<'ide'>

function failureKey(failure: WorkspaceFilesFailure): IdeLocaleKey {
  return `error.${failure.code}`
}

function isMarkdown(segments: WorkspaceFileSegments): boolean {
  return /\.(?:md|mdown|markdown)$/i.test(segments.at(-1) as string)
}

function tabElementId(kind: 'tab' | 'panel', id: string): string {
  return `ide-${kind}-${encodeURIComponent(id)}`
}

/** Render the editor, file tree, save recovery, and unsaved-buffer prompts. */
export function IdeSurface({
  collapsed,
  exclusive,
  useWorkspaces,
  useStore,
  actions,
  listFiles,
  readFile,
  saveFile,
  getIdeSnapshot,
  openEditor,
  closeEditor,
  t,
}: IdeSurfaceProps) {
  const selectedWorkspaceId = useStore(state => state.selectedWorkspaceId)
  const tabs = useStore(state => state.tabs)
  const activeTabId = useStore(state => state.activeTabId)
  const pendingCloseTabId = useStore(state => state.pendingCloseTabId)
  const pendingReloadTabId = useStore(state => state.pendingReloadTabId)
  const pendingWorkspaceId = useStore(state => state.pendingWorkspaceId)
  const workspaces = useWorkspaces(state => state.items)
  const [savingWorkspace, setSavingWorkspace] = useState(false)
  const [quitPrompt, setQuitPrompt] = useState(false)
  const quitRequest = useRef<{
    readonly settle: (ready: boolean) => void
    readonly removeAbort: () => void
  }>()
  const reads = useRef(new Map<string, { controller: AbortController; tab: IdeTab }>())
  const tabButtons = useRef(new Map<string, HTMLButtonElement>())
  const closeButton = useRef<HTMLButtonElement>(null)
  const previousCollapsed = useRef(collapsed)
  const previousExclusive = useRef(exclusive)
  const activeTab = tabs.find(tab => tab.id === activeTabId)
  const closeTab = tabs.find(tab => tab.id === pendingCloseTabId)

  useEffect(() => {
    if (selectedWorkspaceId !== undefined && workspaces.some(workspace => workspace.workspaceId === selectedWorkspaceId)) return
    const first = workspaces[0]
    if (first !== undefined) actions.dispatch({ type: 'request-workspace', workspaceId: first.workspaceId })
  }, [actions, selectedWorkspaceId, workspaces])

  const openFile = useCallback((segments: WorkspaceFileSegments): void => {
    actions.dispatch({ type: 'begin-open', workspaceId: selectedWorkspaceId as WorkspaceId, segments })
  }, [actions, selectedWorkspaceId])

  useEffect(() => {
    for (const [id, active] of reads.current) {
      if (tabs.find(tab => tab.id === id) !== active.tab) {
        active.controller.abort()
        reads.current.delete(id)
      }
    }
    for (const tab of tabs) {
      if (tab.phase !== 'loading' || reads.current.has(tab.id)) continue
      const controller = new AbortController()
      reads.current.set(tab.id, { controller, tab })
      void readFile({ workspaceId: tab.workspaceId, path: tab.segments }, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return
          reads.current.delete(tab.id)
          if (result.ok) {
            actions.dispatch({
              type: 'open-succeeded',
              id: tab.id,
              content: result.value.content,
              version: result.value.version,
            })
          } else {
            actions.dispatch({ type: 'open-failed', id: tab.id, error: t(failureKey(result.error)) })
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            reads.current.delete(tab.id)
            actions.dispatch({ type: 'open-failed', id: tab.id, error: t('error.transport') })
          }
        })
    }
  }, [actions, readFile, t, tabs])

  useEffect(() => () => {
    for (const active of reads.current.values()) active.controller.abort()
    reads.current.clear()
  }, [])

  const saveTab = useCallback(async (
    tab: IdeTab,
    expectedVersion: WorkspaceFileVersion = tab.baseVersion as WorkspaceFileVersion,
    closeAfterSave = false,
  ): Promise<void> => {
    if (tab.phase !== 'ready' || tab.save !== undefined) return
    const attempt: IdeSaveAttempt = {
      content: tab.content,
      expectedVersion,
      revision: tab.revision,
      closeAfterSave,
    }
    actions.dispatch({ type: 'save-started', id: tab.id, attempt })
    try {
      const result = await saveFile({
        workspaceId: tab.workspaceId,
        path: tab.segments,
        content: attempt.content,
        expectedVersion: attempt.expectedVersion,
      })
      if (result.ok) {
        actions.dispatch({ type: 'save-succeeded', id: tab.id, version: result.value.version })
        return
      }
      if (result.error.code !== 'version-conflict') {
        actions.dispatch({ type: 'save-failed', id: tab.id, error: t(failureKey(result.error)) })
        return
      }
      const latest = await readFile({ workspaceId: tab.workspaceId, path: tab.segments })
      if (latest.ok) {
        actions.dispatch({
          type: 'save-conflicted',
          id: tab.id,
          diskContent: latest.value.content,
          diskVersion: latest.value.version,
        })
      } else {
        actions.dispatch({ type: 'save-failed', id: tab.id, error: t(failureKey(latest.error)) })
      }
    } catch {
      actions.dispatch({ type: 'save-failed', id: tab.id, error: t('error.transport') })
    }
  }, [actions, readFile, saveFile, t])

  const saveAllAndSwitch = useCallback(async (): Promise<void> => {
    setSavingWorkspace(true)
    try {
      await Promise.all(tabs.filter(tab => tab.dirty && tab.save === undefined).map(tab => saveTab(tab)))
      actions.dispatch({ type: 'finish-workspace-if-clean' })
    } finally {
      setSavingWorkspace(false)
    }
  }, [actions, saveTab, tabs])

  const settleQuit = useCallback((ready: boolean): void => {
    const pending = quitRequest.current
    if (pending === undefined) return
    quitRequest.current = undefined
    pending.removeAbort()
    setQuitPrompt(false)
    pending.settle(ready)
  }, [])

  const saveAllAndQuit = useCallback(async (): Promise<void> => {
    const snapshot = getIdeSnapshot()
    await Promise.all(snapshot.tabs
      .filter(tab => tab.dirty && tab.save === undefined)
      .map(tab => saveTab(tab)))
    const latest = getIdeSnapshot()
    settleQuit(latest.tabs.every(tab => !tab.dirty && tab.save === undefined && tab.conflict === undefined))
  }, [getIdeSnapshot, saveTab, settleQuit])

  useEffect(() => {
    type LifecycleHost = {
      handle(
        method: 'desktop.prepareQuit',
        handler: (
          payload: { readonly reason: 'window-close' | 'application-quit' | 'application-replace' },
          signal: AbortSignal,
        ) => Promise<{ readonly ready: boolean }>,
      ): () => void
    }
    const lifecycle = (globalThis as unknown as {
      readonly __DSH_DESKTOP_LIFECYCLE__?: LifecycleHost
    }).__DSH_DESKTOP_LIFECYCLE__
    if (lifecycle === undefined) return
    return lifecycle.handle('desktop.prepareQuit', async (_payload, signal) => {
      const snapshot = getIdeSnapshot()
      if (snapshot.tabs.every(tab => !tab.dirty && tab.save === undefined && tab.conflict === undefined)) {
        return { ready: true }
      }
      if (signal.aborted || quitRequest.current !== undefined) return { ready: false }
      return new Promise<{ readonly ready: boolean }>((resolve) => {
        const onAbort = (): void => { settleQuit(false) }
        signal.addEventListener('abort', onAbort, { once: true })
        quitRequest.current = {
          settle: (ready) => { resolve({ ready }) },
          removeAbort: () => { signal.removeEventListener('abort', onAbort) },
        }
        openEditor()
        setQuitPrompt(true)
      })
    })
  }, [getIdeSnapshot, openEditor, settleQuit])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (getIdeSnapshot().tabs.some(tab => tab.dirty || tab.save !== undefined)) event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => { window.removeEventListener('beforeunload', onBeforeUnload) }
  }, [getIdeSnapshot])

  useEffect(() => () => { settleQuit(false) }, [settleQuit])

  useEffect(() => {
    if (collapsed) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 's' && activeTab !== undefined) {
        event.preventDefault()
        void saveTab(activeTab)
      } else if (key === 'w' && activeTab !== undefined) {
        event.preventDefault()
        actions.dispatch({ type: 'request-close', id: activeTab.id })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [actions, activeTab, collapsed, saveTab])

  const workspaceOptions = useMemo(
    () => workspaces.map(workspace => ({ id: workspace.workspaceId, title: workspace.title })),
    [workspaces],
  )

  const moveTabFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, id: string): void => {
    const index = tabs.findIndex(tab => tab.id === id)
    let target: IdeTab | undefined
    if (event.key === 'ArrowLeft') target = tabs[(index - 1 + tabs.length) % tabs.length]
    else if (event.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length]
    else if (event.key === 'Home') target = tabs[0]
    else if (event.key === 'End') target = tabs.at(-1)
    if (target === undefined) return
    event.preventDefault()
    actions.dispatch({ type: 'activate-tab', id: target.id })
    tabButtons.current.get(target.id)?.focus()
  }

  const setSurfaceRef = useCallback((node: HTMLElement | null): void => {
    if (node !== null) node.toggleAttribute('inert', collapsed)
  }, [collapsed])

  useEffect(() => {
    const wasCollapsed = previousCollapsed.current
    const wasExclusive = previousExclusive.current
    previousCollapsed.current = collapsed
    previousExclusive.current = exclusive
    if (!wasCollapsed && collapsed) {
      document.getElementById('dsh-ide-toggle')?.focus()
      return
    }
    const enteredExclusive = !wasExclusive && exclusive
    const activeInHiddenPanel = document.activeElement instanceof Element
      && document.activeElement.closest(
        '[data-shell-panel="conversation"], [data-shell-panel="details"]',
      ) !== null
    const focusLeftDocumentTree = document.activeElement === document.body
    if ((wasCollapsed && !collapsed)
      || (enteredExclusive && (activeInHiddenPanel || focusLeftDocumentTree))) {
      closeButton.current?.focus()
    }
  }, [collapsed, exclusive])

  return (
    <section
      ref={setSurfaceRef}
      id="dsh-ide-surface"
      className={clsx(css.surface, collapsed && css.hidden)}
      aria-label={t('action.open')}
      aria-hidden={collapsed}
    >
      <header className={css.header}>
        <div className={css.brand}><IconCodeOutline16 /><strong id="dsh-ide-title">{t('action.open')}</strong></div>
        <label className={css.workspaceLabel}>
          <span>{t('workspace.label')}</span>
          <select
            value={selectedWorkspaceId ?? ''}
            disabled={workspaceOptions.length === 0}
            onChange={(event) => {
              actions.dispatch({ type: 'request-workspace', workspaceId: event.target.value as WorkspaceId })
            }}
          >
            {workspaceOptions.length === 0 && <option value="">—</option>}
            {workspaceOptions.map(workspace => (
              <option key={workspace.id} value={workspace.id}>{workspace.title}</option>
            ))}
          </select>
        </label>
        <button
          ref={closeButton}
          type="button"
          className={css.iconButton}
          aria-label={t('action.close')}
          onClick={closeEditor}
        >
          <IconCloseOutline16 />
        </button>
      </header>

      {workspaceOptions.length === 0 || selectedWorkspaceId === undefined
        ? <div className={css.empty}>{t('workspace.empty')}</div>
        : (
          <div className={css.body}>
            <aside className={css.explorer}>
              <div className={css.explorerTitle}>{t('tree.title')}</div>
              <FileTree workspaceId={selectedWorkspaceId} list={listFiles} onOpen={openFile} t={t} />
            </aside>
            <main className={css.editorPane}>
              <div className={css.tabs} role="tablist">
                {tabs.map(tab => (
                  <div
                    key={tab.id}
                    role="presentation"
                    className={clsx(css.tab, tab.id === activeTabId && css.activeTab)}
                  >
                    <button
                      type="button"
                      role="tab"
                      id={tabElementId('tab', tab.id)}
                      aria-controls={tabElementId('panel', tab.id)}
                      aria-selected={tab.id === activeTabId}
                      tabIndex={tab.id === activeTabId ? 0 : -1}
                      className={css.tabActivate}
                      ref={(node) => {
                        if (node === null) tabButtons.current.delete(tab.id)
                        else tabButtons.current.set(tab.id, node)
                      }}
                      onKeyDown={(event) => { moveTabFocus(event, tab.id) }}
                      onClick={() => { actions.dispatch({ type: 'activate-tab', id: tab.id }) }}
                    >
                      <span className={css.tabTitle}>{tab.title}</span>
                      {tab.dirty && <span className={css.dirtyDot} aria-label={t('editor.dirty')}>●</span>}
                    </button>
                    <button
                      type="button"
                      className={css.tabClose}
                      aria-label={`${t('editor.closeTab')}: ${tab.title}`}
                      onClick={() => { actions.dispatch({ type: 'request-close', id: tab.id }) }}
                    ><IconCloseOutline16 size={12} /></button>
                  </div>
                ))}
              </div>

              {activeTab === undefined
                ? <div className={css.empty}>{t('editor.empty')}</div>
                : (
                  <>
                    <div className={css.toolbar}>
                      <span className={css.breadcrumb}>{activeTab.segments.join(' / ')}</span>
                      <span className={css.status} role="status">
                        {activeTab.save !== undefined
                          ? t('editor.saving')
                          : activeTab.dirty ? t('editor.dirty') : activeTab.phase === 'ready' ? t('editor.saved') : ''}
                      </span>
                      {isMarkdown(activeTab.segments) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => { actions.dispatch({ type: 'toggle-preview', id: activeTab.id }) }}
                        >
                          {activeTab.preview ? t('editor.source') : t('editor.preview')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!activeTab.dirty || activeTab.save !== undefined || activeTab.phase !== 'ready'}
                        onClick={() => { void saveTab(activeTab) }}
                      >
                        {activeTab.save !== undefined ? t('editor.saving') : t('editor.save')}
                      </Button>
                    </div>
                    {activeTab.error !== undefined && (
                      <div className={css.error} role="alert">
                        <span>{activeTab.error}</span>
                        {activeTab.phase === 'error' && (
                          <Button size="sm" variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => {
                            actions.dispatch({ type: 'request-close', id: activeTab.id })
                            openFile(activeTab.segments)
                          }}>{t('tree.retry')}</Button>
                        )}
                      </div>
                    )}
                    {activeTab.conflict !== undefined && (
                      <ConflictPanel
                        tab={activeTab}
                        t={t}
                        onContinue={() => { actions.dispatch({ type: 'continue-conflict', id: activeTab.id }) }}
                        onReload={() => { actions.dispatch({ type: 'request-reload', id: activeTab.id }) }}
                        onOverwrite={() => {
                          void saveTab(activeTab, (activeTab.conflict as IdeConflict).diskVersion)
                        }}
                      />
                    )}
                    <div className={css.documents}>
                      {tabs.map(tab => (
                        <div
                          key={tab.id}
                          role="tabpanel"
                          id={tabElementId('panel', tab.id)}
                          aria-labelledby={tabElementId('tab', tab.id)}
                          tabIndex={0}
                          className={css.document}
                          hidden={tab.id !== activeTabId}
                        >
                          {tab.phase === 'loading' && <div className={css.empty}>{t('editor.loading')}</div>}
                          {tab.phase === 'ready' && (
                            <>
                              <div className={clsx(css.code, tab.preview && css.concealed)}>
                                <CodeEditor
                                  value={tab.content}
                                  path={tab.segments}
                                  label={tab.title}
                                  {...(tab.focusLine === undefined ? {} : { focusLine: tab.focusLine })}
                                  focusRevision={tab.focusRevision}
                                  onChange={(content) => { actions.dispatch({ type: 'edit-tab', id: tab.id, content }) }}
                                />
                              </div>
                              {isMarkdown(tab.segments) && (
                                <div
                                  className={clsx(css.preview, !tab.preview && css.concealed)}
                                  role="region"
                                  aria-label={t('editor.preview')}
                                >
                                  <MarkdownText text={tab.content} />
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
            </main>
          </div>
        )}

      <Modal
        open={quitPrompt}
        title={t('quit.title')}
        description={t('quit.description')}
        closeLabel={t('action.cancel')}
        onClose={() => { settleQuit(false) }}
        footer={(
          <div className={css.modalActions}>
            <Button variant="ghost" onClick={() => { settleQuit(false) }}>{t('action.cancel')}</Button>
            <Button variant="outline" onClick={() => { settleQuit(true) }}>{t('action.discard')}</Button>
            <Button
              variant="primary"
              disabled={tabs.some(tab => tab.save !== undefined)}
              onClick={() => { void saveAllAndQuit() }}
            >{t('action.saveAllQuit')}</Button>
          </div>
        )}
      />

      <Modal
        open={closeTab !== undefined}
        title={t('close.title')}
        description={t('close.description')}
        closeLabel={t('action.cancel')}
        onClose={() => { actions.dispatch({ type: 'cancel-close' }) }}
        footer={closeTab === undefined ? undefined : (
          <>
            <Button variant="ghost" onClick={() => { actions.dispatch({ type: 'cancel-close' }) }}>{t('action.cancel')}</Button>
            <Button variant="outline" onClick={() => { actions.dispatch({ type: 'discard-close' }) }}>{t('action.discard')}</Button>
            <Button
              variant="primary"
              disabled={closeTab.save !== undefined}
              onClick={() => { void saveTab(closeTab, closeTab.baseVersion, true) }}
            >{t('action.save')}</Button>
          </>
        )}
      />

      <Modal
        open={pendingReloadTabId !== undefined}
        title={t('reload.title')}
        description={t('reload.description')}
        closeLabel={t('action.cancel')}
        onClose={() => { actions.dispatch({ type: 'cancel-reload' }) }}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { actions.dispatch({ type: 'cancel-reload' }) }}>{t('action.cancel')}</Button>
            <Button variant="primary" onClick={() => { actions.dispatch({ type: 'confirm-reload' }) }}>
              {t('action.confirmReload')}
            </Button>
          </>
        )}
      />

      <Modal
        open={pendingWorkspaceId !== undefined}
        title={t('switch.title')}
        description={t('switch.description')}
        closeLabel={t('action.cancel')}
        onClose={() => { actions.dispatch({ type: 'cancel-workspace' }) }}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { actions.dispatch({ type: 'cancel-workspace' }) }}>{t('action.cancel')}</Button>
            <Button variant="outline" onClick={() => { actions.dispatch({ type: 'discard-workspace' }) }}>{t('action.discard')}</Button>
            <Button
              variant="primary"
              disabled={savingWorkspace || tabs.some(tab => tab.save !== undefined)}
              onClick={() => { void saveAllAndSwitch() }}
            >{t('action.saveAll')}</Button>
          </>
        )}
      />
    </section>
  )
}

function ConflictPanel({ tab, t, onContinue, onReload, onOverwrite }: {
  tab: IdeTab
  t: (key: IdeLocaleKey) => string
  onContinue: () => void
  onReload: () => void
  onOverwrite: () => void
}) {
  const conflict = tab.conflict as IdeConflict
  return (
    <section className={css.conflict} aria-labelledby={`${tab.id}-conflict-title`}>
      <div className={css.conflictHeading}>
        <div>
          <strong id={`${tab.id}-conflict-title`}>{t('conflict.title')}</strong>
          <p>{t('conflict.description')}</p>
        </div>
        <div className={css.conflictActions}>
          <Button size="sm" variant="ghost" onClick={onContinue}>{t('conflict.continue')}</Button>
          <Button size="sm" variant="outline" onClick={onReload}>{t('conflict.reload')}</Button>
          <Button size="sm" variant="primary" disabled={tab.save !== undefined} onClick={onOverwrite}>
            {t('conflict.overwrite')}
          </Button>
        </div>
      </div>
      <div className={css.diff}>
        <div><span>{t('conflict.local')}</span><pre>{tab.content}</pre></div>
        <div><span>{t('conflict.disk')}</span><pre>{conflict.diskContent}</pre></div>
      </div>
    </section>
  )
}
