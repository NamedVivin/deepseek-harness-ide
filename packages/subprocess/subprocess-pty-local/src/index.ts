/**
 * Local `node-pty` Service Provider for `ctx.subprocessPty`. The provider owns
 * process identities, terminal byte transport, foreground signalling, and
 * complete observable-session cleanup.
 * @module @deepseek-ai/dsh-subprocess-pty-local
 */

import { Context } from '@deepseek-ai/cordis'
import * as nodePty from 'node-pty'
import type { IPtyForkOptions } from 'node-pty'
import { childEnv, registerLocalSubprocessTeardown } from '@deepseek-ai/dsh-subprocess-local'
import { SubprocessPtyRuntime } from '@deepseek-ai/dsh-subprocess-pty'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess-pty'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { createProcessInspector } from './process-inspector.ts'
import type { ProcessInspector } from './process-inspector.ts'
import { LocalTerminalHandle } from './terminal.ts'

/** Local node-pty provider with process-table-backed session ownership. */
export class LocalSubprocessPtyRuntime extends SubprocessPtyRuntime {
  private terminals = new Set<LocalTerminalHandle>()
  /** Test hook for platform process inspection; production resolves lazily on terminal spawn. */
  terminalInspector: ProcessInspector | undefined
  private disposing = false

  constructor(ctx: Context) {
    super(ctx)
    registerLocalSubprocessTeardown(
      ctx,
      'local subprocess PTY teardown',
      () => { this.terminateForHostExit() },
      async () => {
        this.disposing = true
        await this.disposeTerminals()
      },
    )
  }

  /** @inheritdoc */
  // Local allocation is synchronous, but the Service Definition permits remote asynchronous providers.
  // oxlint-disable-next-line typescript/require-await -- Preserve rejection semantics at the async provider contract.
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.disposing) throw new Error('subprocess-pty-local: service is disposing')
    const file = spec.argv[0]
    if (file === undefined || file.length === 0) {
      throw new Error('subprocess-pty-local: terminal argv must contain a program')
    }
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
    }
    spec.signal?.throwIfAborted()
    const options: IPtyForkOptions = {
      name: 'dumb',
      rows: spec.rows,
      cols: spec.cols,
      cwd: spec.cwd,
      env: childEnv(spec.env),
    }
    const terminal = nodePty.spawn(file, [...spec.argv.slice(1)], options)
    if (!Number.isSafeInteger(terminal.pid) || terminal.pid <= 0) {
      try {
        terminal.kill('SIGKILL')
      } catch (_invalidPidRollbackFailure) {
        // The readiness rejection remains authoritative; no identity exists for stronger cleanup.
      }
      throw new Error('subprocess-pty-local: node-pty allocated a terminal without a positive process id')
    }
    const inspector = this.terminalInspector ?? createProcessInspector()
    const handle = new LocalTerminalHandle(terminal, inspector, spec.graceMs)
    this.terminals.add(handle)
    const release = async (): Promise<void> => {
      await handle.terminate()
      this.terminals.delete(handle)
    }
    void handle.done.then(release, release).catch((_automaticReleaseFailure: unknown) => {
      // Retain the handle so service disposal can retry its cleanup transaction.
    })
    return handle
  }

  private terminateForHostExit(): void {
    for (const terminal of this.terminals) {
      try {
        terminal.terminateForHostExit()
      } catch (_terminalTerminationFailure) {
        // One terminal must not prevent final termination of another target.
      }
    }
  }

  private async disposeTerminals(): Promise<void> {
    const outcomes = await Promise.allSettled([...this.terminals].map(terminal => terminal.terminate()))
    const failures = outcomes.flatMap<unknown>(outcome => outcome.status === 'rejected'
      ? [outcome.reason as unknown]
      : [])
    if (failures.length > 0) this.terminateForHostExit()
    this.terminals.clear()
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'local subprocess PTY teardown failed')
  }
}

export default LocalSubprocessPtyRuntime
