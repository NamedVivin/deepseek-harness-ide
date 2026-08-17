/**
 * E2B provider for the independent PTY subprocess capability.
 * @module @deepseek-ai/dsh-subprocess-pty-e2b
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { asError } from '@deepseek-ai/dsh-subprocess-e2b'
import { SubprocessPtyRuntime } from '@deepseek-ai/dsh-subprocess-pty'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess-pty'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { spawnE2BTerminal } from './terminal.ts'

/** Configuration for E2B PTY control-plane polling. */
export interface Config {
  /** Remote status/liveness poll cadence in milliseconds; each tick is one control-plane request. */
  pollMs?: number
}

interface SchemaResolvedConfig extends Config {
  pollMs: number
}

interface TerminalSetup {
  done: Promise<void>
  controller: AbortController
}

function requireRepresentableGrace(graceMs: number): void {
  if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/** E2B PTY provider registered as `ctx.subprocessPty`. */
export class E2BSubprocessPtyRuntime extends SubprocessPtyRuntime {
  static inject = ['e2b']

  static Config: z<Config> = z.object({
    pollMs: z.number().default(20),
  })

  private readonly terminals = new Set<SubprocessTerminalHandle>()
  private readonly terminalSetups = new Set<TerminalSetup>()
  private readonly pollMs: number
  private disposing = false

  /**
   * Create the E2B PTY service and bind pending allocations and live sessions to its lifetime.
   * @param ctx - context carrying the shared E2B sandbox owner.
   * @param config - validated remote polling configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    const { pollMs } = config as SchemaResolvedConfig
    if (!Number.isSafeInteger(pollMs) || pollMs <= 0) {
      throw new Error('subprocess-pty-e2b: pollMs must be a positive safe integer')
    }
    this.pollMs = pollMs
    ctx.effect(() => async () => {
      this.disposing = true
      for (const setup of this.terminalSetups) {
        setup.controller.abort(new Error('subprocess-pty-e2b: service disposed during terminal setup'))
      }
      await Promise.all([...this.terminalSetups].map(setup => setup.done))
      const pending = [...this.terminals].map(terminal => terminal.terminate().then(() => {
        this.terminals.delete(terminal)
      }))
      const outcomes = await Promise.allSettled(pending)
      const failures = outcomes.flatMap<unknown>(outcome => outcome.status === 'rejected'
        ? [outcome.reason as unknown]
        : [])
      if (failures.length === 1) throw asError(failures[0])
      if (failures.length > 1) throw new AggregateError(failures, 'subprocess-pty-e2b: teardown failed')
    }, 'e2b subprocess PTY teardown')
  }

  /** @inheritdoc */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.disposing) throw new Error('subprocess-pty-e2b: service is disposing')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('subprocess-pty-e2b: terminal argv must contain a program')
    }
    requireRepresentableGrace(spec.graceMs)
    spec.signal?.throwIfAborted()
    const stateDir = posix.join(this.ctx.e2b.runtimeRoot, 'terminals', randomUUID())
    const done = Promise.withResolvers<void>()
    const setup: TerminalSetup = { done: done.promise, controller: new AbortController() }
    const setupSignal = spec.signal === undefined
      ? setup.controller.signal
      : AbortSignal.any([spec.signal, setup.controller.signal])
    this.terminalSetups.add(setup)
    try {
      const terminal = await spawnE2BTerminal(
        this.ctx.e2b,
        { ...spec, signal: setupSignal },
        stateDir,
        this.pollMs,
      )
      this.terminals.add(terminal)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Remote allocation yields to disposal.
      if (this.disposing) {
        await terminal.terminate()
        this.terminals.delete(terminal)
        throw new Error('subprocess-pty-e2b: service disposed during terminal setup')
      }
      const release = async (): Promise<void> => {
        await terminal.terminate()
        this.terminals.delete(terminal)
      }
      void terminal.done.then(release, release).catch((_automaticReleaseFailure: unknown) => {
        // Retain the terminal so service disposal can retry its cleanup transaction.
      })
      return terminal
    } finally {
      this.terminalSetups.delete(setup)
      done.resolve()
    }
  }
}

export default E2BSubprocessPtyRuntime
