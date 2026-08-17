/** Vocabulary for the independent PTY subprocess Service Definition. */

import type { Readable } from 'node:stream'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

/**
 * Signals supported by the terminal-process primitive. Kept member-identical
 * to `TerminalSignal` in `@deepseek-ai/dsh-terminal` without a cross-seam dependency;
 * change both together.
 */
export type SubprocessTerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'

/** A fully specified terminal-process spawn. */
export interface SubprocessTerminalSpawnSpec {
  /** Executable and arguments; `argv[0]` is the program. */
  argv: readonly string[]
  /** Working directory in this PTY provider's execution world. */
  cwd: string
  /** Explicit environment layered after the provider's ambient scrub. */
  env?: Record<string, string> | undefined
  /** Initial terminal row count. */
  rows: number
  /** Initial terminal column count. */
  cols: number
  /** TERM-to-KILL cleanup grace for the complete terminal session. */
  graceMs: number
  /** Cancellation of terminal allocation; a published handle owns its later lifetime. */
  signal?: AbortSignal | undefined
}

/** Current foreground process-group facts for one terminal. */
export interface SubprocessTerminalForeground {
  /** Foreground process-group id published by the terminal driver. */
  processGroupId: number
  /** Whether the provider can currently prove that group is waiting on terminal input. */
  inputWaiting: boolean
}

/**
 * One live terminal process and its owned OS session. Terminal allocation,
 * foreground-group inspection/signalling, and session-tree cleanup stay in
 * this optional PTY seam rather than the generic process provider.
 */
export interface SubprocessTerminalHandle {
  /** Positive top-level terminal process id. */
  readonly pid: number
  /** UTF-8 terminal output bytes in delivery order; ends after queued output when the terminal exits. */
  readonly output: Readable
  /** Resolves when the top-level process exits; rejects only for a live transport failure. */
  readonly done: Promise<SubprocessOutcome>
  /**
   * Write text to the terminal input.
   * @param data - text to deliver without implicit newline conversion.
   * @returns fulfillment after the provider accepts the complete write.
   */
  write(data: string): Promise<void>
  /**
   * Inspect the current foreground process group.
   * @returns its id and input-wait fact, or undefined when no foreground group can be resolved.
   */
  inspectForeground(): Promise<SubprocessTerminalForeground | undefined>
  /**
   * Deliver a signal to the current foreground process group.
   * @param signal - permitted terminal signal.
   * @returns the exact group id that received it.
   */
  signalForeground(signal: SubprocessTerminalSignal): Promise<number>
  /**
   * Idempotently terminate every terminal-session member the provider can still observe and await quiescence.
   * After settlement, no write, inspection, or signal call remains in flight.
   * Providers document substrate-specific observability limits.
   * @returns fulfillment after the complete provider-observable session is quiescent.
   */
  terminate(): Promise<void>
}
