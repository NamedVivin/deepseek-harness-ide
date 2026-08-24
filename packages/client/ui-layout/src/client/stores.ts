/**
 * The root entry's transient layout store: panel geometry as plain widths in
 * px (0 = closed). Module level exports the factory only — a module-level
 * handle would pin the store's identity in the module
 * cache (a de-facto singleton surviving plugin reloads). register() receives
 * the factory (exclusive use: the framework instantiates per entry), AppFrame
 * derives its PropsStore share from the return type, and the service face
 * receives the bound actions through the registration's inject hook.
 */
import {
  defineStore,
  type EngineStoreHandle,
  type EngineStoreInstance,
  type ObservableSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  clampWidth, DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  EDITOR_DEFAULT, EDITOR_MAX, EDITOR_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'

/**
 * Layout store state: live panel width preferences in px (0 = closed), the
 * editor's last nonzero width, and responsive sidebar overrides.
 * `editorRailForced` mirrors whether the open editor currently derives a rail
 * so toggleSidebar can visibly expand it; `editorRailExpanded` records that
 * explicit expansion without replacing the sidebar preference. `narrow`
 * mirrors AppFrame's breakpoint reading so `narrowExpanded` can manually
 * re-expand the auto-collapsed sidebar when no editor posture owns the rail.
 */
type LayoutState = {
  sidebar: number
  details: number
  editor: number
  editorLast: number
  editorRailForced: boolean
  editorRailExpanded: boolean
  narrow: boolean
  narrowExpanded: boolean
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type LayoutActions = {
  setSidebar: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number) => void
  setEditor: (draft: LayoutState, px: number) => void
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
  setEditorRailForced: (draft: LayoutState, forced: boolean) => void
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
  openEditor: (draft: LayoutState) => void
  closeEditor: (draft: LayoutState) => void
}

/**
 * Create the layout panel store handle. Actions are the complete write set:
 * width setters clamp to each panel's nonzero range, while open/close actions
 * own explicit visibility transitions. Details and the sidebar reopen at their
 * contract defaults; the editor retains its last open width across close/reopen
 * within this store instance. AppFrame mirrors responsive state into the two
 * rail flags so an explicit sidebar expansion can make the editor exclusive
 * without rewriting either width preference. Below the auto-collapse
 * breakpoint, ordinary sidebar toggles use the narrowExpanded override.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions>  {
  const handle = defineStore({
    init: (): LayoutState => ({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      editor: 0,
      editorLast: EDITOR_DEFAULT,
      editorRailForced: false,
      editorRailExpanded: false,
      narrow: false,
      narrowExpanded: false,
    }),
    actions: {
      setSidebar: (d, px: number) => { d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX) },
      setDetails: (d, px: number) => { d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX) },
      setEditor: (d, px: number) => {
        const width = clampWidth(px, EDITOR_MIN, EDITOR_MAX)
        d.editor = width
        d.editorLast = width
      },
      // A derived editor rail can be explicitly expanded by making the editor
      // exclusive; otherwise narrow toggles keep their existing override and
      // wide toggles update the sidebar preference.
      toggleSidebar: (d) => {
        if (d.editorRailForced) d.editorRailExpanded = !d.editorRailExpanded
        else if (d.narrow) d.narrowExpanded = !d.narrowExpanded
        else d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0
      },
      // Crossing the breakpoint in either direction drops the override: the
      // narrow default is auto-collapsed, the wide state is the preference.
      setNarrow: (d, narrow: boolean) => {
        if (d.narrow === narrow) return
        d.narrow = narrow
        d.narrowExpanded = false
      },
      setEditorRailForced: (d, forced: boolean) => {
        if (d.editorRailForced === forced) return
        d.editorRailForced = forced
        if (!forced) d.editorRailExpanded = false
      },
      openDetails: (d) => { if (d.details === 0) d.details = DETAILS_DEFAULT },
      closeDetails: (d) => { d.details = 0 },
      openEditor: (d) => { if (d.editor === 0) d.editor = d.editorLast },
      closeEditor: (d) => { d.editor = 0 },
    },
  })
  return handle
}

/** Shared root-store handle plus the editor-open projection exposed by ctx.layout. */
export interface LayoutStoreBridge {
  readonly handle: EngineStoreHandle<LayoutState, LayoutActions>
  readonly editorOpen: ObservableSnapshot<boolean>
}

/**
 * Create one apply-scoped layout handle and project its editor preference as
 * an observable boolean. The renderer remains the only instance creator;
 * subscribers registered before its first render are attached when create()
 * supplies that instance.
 * @returns the shared handle and editor-open projection.
 */
export function createLayoutStoreBridge(): LayoutStoreBridge {
  const declared = createLayoutStore()
  let instance: EngineStoreInstance<LayoutState, LayoutActions> | undefined
  const pendingSubscribers = new Set<{ listener: () => void; dispose?: () => void }>()
  const handle: EngineStoreHandle<LayoutState, LayoutActions> = {
    ...declared,
    create(scopeKey?: string) {
      if (instance !== undefined) return instance
      instance = declared.create(scopeKey)
      for (const pending of pendingSubscribers) {
        pending.dispose = instance.subscribe(pending.listener)
      }
      pendingSubscribers.clear()
      return instance
    },
  }
  const editorOpen: ObservableSnapshot<boolean> = {
    getSnapshot: () => (instance?.getSnapshot().editor ?? 0) > 0,
    subscribe(listener) {
      if (instance !== undefined) return instance.subscribe(listener)
      const pending: { listener: () => void; dispose?: () => void } = { listener }
      pendingSubscribers.add(pending)
      return () => {
        pending.dispose?.()
        pendingSubscribers.delete(pending)
      }
    },
  }
  return { handle, editorOpen }
}
