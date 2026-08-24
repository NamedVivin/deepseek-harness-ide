/**
 * The outward sessions-service face — what `ctx.sessions` exposes to feature
 * packages and the renderer host, and therefore exactly what the test
 * runtime's sessions double must implement. Wire-pump entry points
 * (handleMuxEnvelope/handleConnected/refresh) and runtime internals stay on
 * the concrete class; cross-domain consumers keep the narrower
 * [SessionsPort](./sessions-port.ts). Widening this interface is the
 * explicit act of widening what features may do to the sessions domain.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  JobView, RpcError, RpcResult, SessionId, SubagentAddress, SubagentCatalog,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable, SessionMaybeProvideInfo } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { AgentContext } from '../scope.ts'
import type { PendingInteractionStatus } from '../pending.ts'
import type { SessionFace } from './session.ts'
import type { ObservableSnapshot } from './store.ts'

/**
 * List arrival lifecycle, orthogonal to the pull-activity `state` axis:
 * `pending` (no successful pull yet — an empty items array means "nothing
 * arrived", not "nothing exists") → `ready` (at least one pull landed).
 * Monotone: `ready` never steps back — later pull failures and reconnect
 * re-pulls ride the `state`/`error` axis, which is where failure is modeled
 * (there is no `error` phase because that would duplicate `state`).
 */
export type SessionListPhase = 'pending' | 'ready'

/** One parent-addressed durable catalog projected through the sessions snapshot. */
export interface SubagentCatalogSnapshot extends SubagentCatalog {
  state: 'loading' | 'ready' | 'error'
  error: RpcError | null
}

/** Request-local content hit returned to sidebar search consumers. */
export interface SessionSearchResultItem {
  sessionId: SessionId
  snippet: string
}

/** Session list row projected from the Host list and live stream. */
export interface SessionSummary {
  id: SessionId
  /** Latest durable log-backed title, absent until the Host projects one. */
  title?: string
  /** Human-facing label: durable title, project basename, then session id. */
  displayTitle: string
  cwd?: string
  /**
   * Agent preset this session's agent was composed from; absent when the
   * deployment composes no presets. The label reflects the running
   * composition rather than the deployment's current default.
   */
  agentPreset?: string
  parentId?: SessionId
  /** Coarse durable origin for navigation filtering; not a continuation capability. */
  origin?: 'subagent'
  running: boolean
  /** User interaction currently blocking this session; absent means none. */
  pendingInteraction?: PendingInteractionStatus
  /** Finished while not selected and not yet opened; absent means false. */
  completed?: boolean
  /**
   * Host-derived empty-log bit used by New Session reuse. The store retains
   * every row; presentation consumers decide which blank row is visible.
   */
  blank: boolean
  updatedAt: number
  /** Current Host-computed projection values retained by the object layer. */
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
}

/**
 * Session list store state. `current` shares one snapshot with the rows, so
 * sidebar highlighting and SessionProvider read one arbitrated source.
 */
export interface SessionListState {
  /** Host-list order; addressed breadcrumb-only rows are excluded. */
  ids: SessionId[]
  /** Host rows plus the current addressed subagent route used by navigation. */
  byId: Record<SessionId, SessionSummary>
  current: SessionId | undefined
  /** Arrival lifecycle; empty with `ready` means the Host list is truly empty. */
  phase: SessionListPhase
  /** Direct durable catalogs keyed by their selected parent address. */
  subagentsByParent: Readonly<Record<SessionId, SubagentCatalogSnapshot>>
  /** Background jobs per session; an absent key is an empty set, never a sentinel. */
  jobsBySession: Readonly<Record<SessionId, readonly JobView[]>>
  /** Current session's catalog-derived address, absent on ordinary navigation. */
  currentAddress: SubagentAddress | undefined
}

/** Identity-stable session assembly handle for SessionProvider and inject factories. */
export interface SessionBinding {
  readonly sessionId: SessionId
  /** The outward session face; feature code never receives the concrete class. */
  readonly session: SessionFace
  readonly ctx: AgentContext
}

/** One plugin's per-session standard-props contribution. */
export interface SessionProvideContribution {
  /** Bare observable sources, keyed by hook base name (`input` → `useInput`). */
  hooks?: Record<string, HostObservable<unknown>>
  /** Stable plain members, including action callbacks, spread into standard props verbatim. */
  props?: Record<string, unknown>
}

/**
 * Static declaration plus per-session resolver for one standard-kit
 * contribution. Declared names keep the no-session and session faces equal.
 */
export interface SessionProvideDescriptor {
  /** Hook base names (`input` becomes `useInput`). */
  hooks?: readonly string[]
  /** Plain standard-prop names. */
  props?: readonly string[]
  /** Resolve every declared member for one definite session. */
  resolve(binding: SessionBinding): SessionProvideContribution
}

/** The sessions-service face injected as `ctx.sessions`. */
export interface ISessions {
  /** The useSessions standard feed (list rows + current selection; read face — writes stay inside the domain). */
  readonly list: ObservableSnapshot<SessionListState>
  /** Atomic current-session provide projection (the renderer host's `sessions.provideInfo` feed). */
  readonly currentProvideInfo: HostObservable<SessionMaybeProvideInfo>
  /**
   * The `session.search` result bound the wire schema fixes, exposed to
   * presentation as injected data. Not per-connection state: every transport
   * (fixture included) reports the same number.
   */
  readonly searchResultLimit: number
  /**
   * Select a session as current.
   * @param id - session id (must exist in the list; unknown ids fail loud).
   */
  open(id: SessionId): void
  /**
   * Open a healthy catalog child through its exact direct-parent address.
   * @param address - catalog-derived parent and child ids.
   */
  openSubagent(address: SubagentAddress): void
  /**
   * Resolve an already discovered direct-parent address without opening it.
   * @param id - possible addressed child id.
   * @returns the retained address, when present.
   */
  subagentAddress(id: SessionId): SubagentAddress | undefined
  /**
   * Mark whether a catalog menu is consuming live membership updates.
   * @param parentSessionId - catalog owner.
   * @param open - current menu state.
   */
  setSubagentCatalogOpen(parentSessionId: SessionId, open: boolean): void
  /**
   * Refresh one direct-child catalog.
   * @param parentSessionId - catalog owner.
   * @returns completion of the current or newly started refresh.
   */
  refreshSubagents(parentSessionId: SessionId): Promise<void>

  /**
   * Record the composition one session now runs. The agent-preset seat calls
   * this after a successful blank-session switch, so the header label moves
   * with the composition instead of waiting for the next full list refresh.
   * @param sessionId - the switched session.
   * @param agentPreset - the preset id the host confirmed.
   */
  noteAgentPreset(sessionId: SessionId, agentPreset: string): void
  /** Clear the current selection into the no-session view state. */
  clear(): void
  /**
   * Search the Host's visible message-content index. Results stay
   * request-local; the list snapshot remains the metadata authority.
   * @param query - non-blank literal phrase.
   * @param signal - cancellation for a superseded search.
   * @returns bounded results, or a business/transport error.
   */
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<RpcResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>>
  /**
   * Fork a session from a completed-turn prefix of the source; on resolution
   * the child is in the list store and `open()` can target it.
   * @param opts - source session id, the optional event seq anchoring the
   *   cut (the boundary is the first turn/end at or after it; an in-log
   *   anchor in an open turn is unavailable rather than clipped backward),
   *   and whether to increment an inherited durable title before resolving.
   * @returns the child session id.
   * @throws when the fork fails, or when a requested child-title rename fails after creation.
   */
  fork(opts: { sessionId: SessionId; atSeq?: number; increaseTitle?: boolean }): Promise<SessionId>
  /**
   * Register a per-session standard-props provider (hooks become `use<Name>`
   * selector hooks on the render side; props spread verbatim).
   * @param descriptor - static member roster plus per-session resolver.
   * @returns disposer removing the provider.
   */
  provide(descriptor: SessionProvideDescriptor): () => void
  /**
   * Resolve an Agent-scoped context view (use-and-discard).
   * @param id - session id.
   * @returns scoped ctx, or undefined for a session neither listed nor already scoped.
   */
  scope(id: SessionId): AgentContext | undefined
  /**
   * Read the Agent scope tag off a context (service-method boundary: fetch
   * bundles must reach scope resolution through ctx.sessions).
   * @param ctx - any client context.
   * @returns the session id, or undefined on root contexts.
   */
  scopeOf(ctx: Context): SessionId | undefined
  /**
   * Resolve the session face behind an Agent-scoped context.
   * @param ctx - an Agent-scoped context.
   * @returns the session face, or undefined when the ctx is untagged or its scope was pruned.
   */
  sessionOf(ctx: Context): SessionFace | undefined
  /**
   * Resolve the stable session binding (scope-addressed assembly feed).
   * @param id - session id.
   * @returns binding, or undefined for a session neither listed nor already scoped.
   */
  binding(id: SessionId): SessionBinding | undefined
}
