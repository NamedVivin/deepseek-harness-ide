/**
 * Service Definition for the optional PTY subprocess capability
 * (`ctx.subprocessPty`): terminal allocation, byte transport, foreground
 * process groups, signals, and whole-session cleanup.
 * @module @deepseek-ai/dsh-subprocess-pty
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from './types.ts'

export type {
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from './types.ts'

export type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

declare module '@deepseek-ai/cordis' {
  interface Context {
    subprocessPty: SubprocessPtyRuntime
  }
}

/**
 * Optional PTY process service. Providers publish a handle only after terminal
 * allocation has a positive process id and the complete session is owned.
 * Service disposal terminates and joins every still-live handle.
 */
export abstract class SubprocessPtyRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subprocessPty')
  }

  /**
   * Allocate a real terminal and start one owned process session.
   * @param spec - fully specified argv, cwd, environment, dimensions, grace, and allocation cancellation.
   * @returns the live terminal handle after allocation and ownership succeed.
   */
  abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
}

export default SubprocessPtyRuntime
