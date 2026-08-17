/** Root-scoped IDE store declaration, shared by the overlay and footer action. */

import {
  defineStore,
  type EngineStoreHandle,
  type EngineStoreInstance,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  INITIAL_IDE_STATE,
  reduceIdeState,
  type IdeAction,
  type IdeState,
} from './state.ts'

type IdeActions = {
  dispatch: (draft: IdeState, action: IdeAction) => void
}

/**
 * Create one IDE store handle. `apply` creates it once and gives the same
 * handle to both root registrations.
 * @returns shared root store declaration.
 */
export function createIdeStore(): EngineStoreHandle<IdeState, IdeActions> {
  return defineStore({
    init: (): IdeState => ({ ...INITIAL_IDE_STATE, tabs: [] }),
    actions: {
      dispatch: (draft, action: IdeAction) => {
        Object.assign(draft, reduceIdeState(draft, action))
      },
    },
  })
}

/**
 * Bind an effect-scoped command writer to the root instance that the slot
 * renderer creates lazily. Commands received before the root mounts are
 * replayed in order into that same instance.
 * @returns shared handle, command writer, and current snapshot reader.
 */
export function createIdeStoreBridge(): {
  readonly handle: EngineStoreHandle<IdeState, IdeActions>
  readonly dispatch: (action: IdeAction) => void
  readonly getSnapshot: () => IdeState
} {
  const declared = createIdeStore()
  let instance: EngineStoreInstance<IdeState, IdeActions> | undefined
  let pendingSnapshot: IdeState = declared.spec.init()
  const pending: IdeAction[] = []
  const handle: EngineStoreHandle<IdeState, IdeActions> = {
    ...declared,
    create(scopeKey?: string) {
      if (instance !== undefined) return instance
      instance = declared.create(scopeKey)
      for (const action of pending.splice(0)) instance.actions.dispatch(action)
      pendingSnapshot = instance.getSnapshot()
      return instance
    },
  }
  return {
    handle,
    dispatch(action) {
      if (instance === undefined) {
        pending.push(action)
        pendingSnapshot = reduceIdeState(pendingSnapshot, action)
      } else {
        instance.actions.dispatch(action)
      }
    },
    getSnapshot: () => instance?.getSnapshot() ?? pendingSnapshot,
  }
}
