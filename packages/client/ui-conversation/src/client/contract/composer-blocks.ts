/**
 * Composer blocks are the one client path for another plugin to stop a
 * session's input. The dependency runs toward ui-conversation, so a blocker
 * publishes its localized reason here and the composer reads its session's
 * store. This is an affordance; the Host independently enforces whether a
 * prompt can be routed.
 */
import type {
  SessionId, SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Why one session's composer is inert. */
export interface ComposerBlock {
  /** Localized placeholder replacing the composer's own, owned by the plugin that raised the block. */
  readonly reason: string
}

/** The registry face other plugins reach through `ctx.conversation.blocks`. */
export interface ComposerBlocks {
  /**
   * Raise or clear this session's block. Equal writes and clearing an absent
   * block notify nobody.
   * @param sessionId - the session whose composer is affected.
   * @param block - the block to raise, or undefined to clear it.
   */
  set(sessionId: SessionId, block: ComposerBlock | undefined): void
  /**
   * Resolve a session's lazily created stable block store. Creation on either
   * side preserves a block raised before the composer mounts.
   * @param sessionId - the session to observe.
   * @returns that session's block store; undefined means not blocked.
   */
  storeFor(sessionId: SessionId): SnapshotStore<ComposerBlock | undefined>
  /**
   * Drop one session's store when its scope is released.
   * @param sessionId - the session being released.
   */
  forget(sessionId: SessionId): void
}
