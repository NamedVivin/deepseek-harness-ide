/**
 * Sandbox-consuming PowerShell executor — the pwsh twin of
 * `@deepseek-ai/dsh-bash-sandbox`. It wraps the exact local pwsh argv through
 * `ctx.sandbox` (which on Windows resolves to the ACL restricted-token runner
 * chain), inherits local process mechanics, and reports the selected mode,
 * enforcement, and denial facts. Positive runner-launch evidence means the
 * command never ran: foreground calls throw `SANDBOX_UNAVAILABLE`, while
 * background processes carry `runnerFailed`; other spawn rejections retain
 * local-executor semantics. The tool layer owns the escalation approval flow
 * through `ctx.approval`; this executor reports the sandbox facts the tool
 * renders.
 * @module @deepseek-ai/dsh-pwsh-sandbox
 */

import { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type {
  ConfinedArgv,
  ConfinedSandboxMode,
  RunnerFailureRule,
  SandboxEnforcement,
  SandboxExecutionPolicy,
  SandboxMode,
  SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { PwshLocalExecutor } from '@deepseek-ai/dsh-pwsh-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-pwsh-local'
import { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature } from './helpers.ts'

/**
 * Plugin config: the local executor's knobs, verbatim. The sandbox policy —
 * the default mode and fallback `workspace-write` root — is NOT here: it lives
 * on `ctx.sandboxPolicy` (`@deepseek-ai/dsh-sandbox-policy`), which resolves
 * each calling session's mode and cwd for every enforcing capability. The
 * runner choice is likewise the `ctx.sandbox` provider's config, not this
 * executor's.
 */
export type Config = LocalConfig

/**
 * Registers as `ctx.shell` in place of the local pwsh executor and requires a
 * `ctx.sandbox` provider plus `ctx.sandboxPolicy`; the tool layer carries the
 * sandbox denial rendering and escalation surface (see the
 * pwsh-tool-and-executor Agent Note). Tool calls pass the calling session's
 * resolved policy; direct calls fall back to deployment policy.
 * `result.sandbox` reports the mode, enforcement, and denial facts the tool
 * renders.
 */
/* jscpd:ignore-start -- deliberate call-for-call mirror of bash-sandbox's executor (pwsh-tool-and-executor Agent Note) */
export class SandboxPwshExecutor extends PwshLocalExecutor {
  static override inject = ['subprocess', 'sandbox', 'sandboxPolicy']

  // No own Config: the sandbox default (mode + workspaceRoot) moved to
  // ctx.sandboxPolicy, so this executor inherits PwshLocalExecutor's Config
  // verbatim (the config catalog walks the inherited static).

  private readonly mode: SandboxMode
  /**
   * Per-process confinement facts retained until settlement. Providers may
   * vary enforcement and diagnostic dialect between overlapping calls, so a
   * shared latest-wrap value would classify a process against the wrong facts.
   * Unconfined processes have no entry.
   */
  private readonly processFacts = new Map<ShellProcess, {
    mode: ConfinedSandboxMode
    enforcement: SandboxEnforcement
    denialSignatures: readonly string[]
    runnerFailureRules: readonly RunnerFailureRule[]
  }>()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    // The default mode is the capability fact used for schema advertisement;
    // actual tool executions carry their resolved per-call policy.
    this.mode = ctx.sandboxPolicy.defaultMode
  }

  /** The configured default mode — the capability fact the tool layer reads. */
  override get sandboxMode(): SandboxMode {
    return this.mode
  }

  /**
   * Stamp a complete per-call policy onto the spec. Tool calls supply the
   * calling session's resolved mode and root; lower-level callers fall back to
   * the deployment policy.
   */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    return { ...super.resolve(request), sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve() }
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const policy = spec.sandboxPolicy as SandboxExecutionPolicy
    const { mode } = policy
    if (mode === 'danger-full-access') {
      const result = await super.run(spec)
      return { ...result, sandbox: { mode, denied: false } }
    }
    const confined = this.confine(spec, { ...policy, mode })
    let result: ShellRunResult
    try {
      result = await this.runArgv(spec, confined.argv)
    } catch (error) {
      // An upstream abort remains cancellation even when it prevents spawn.
      if (spec.signal?.aborted === true) spec.signal.throwIfAborted()
      if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) {
        throw new SandboxUnavailableError(mode, String(error))
      }
      throw error
    }
    // Runner failure outranks denial because the command did not run. Carry
    // the matched fatal line, not an informational line that preceded it.
    const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, confined.runnerFailureRules)
    if (runnerFailure !== undefined) {
      throw new SandboxUnavailableError(mode, runnerFailure.detail)
    }
    return { ...result, sandbox: { mode, denied: classifyDenial(result, confined.denialSignatures), enforcement: confined.enforcement } }
  }

  override async start(spec: ShellExecSpec): Promise<ShellProcess> {
    const policy = spec.sandboxPolicy as SandboxExecutionPolicy
    const { mode } = policy
    if (mode === 'danger-full-access') return super.start(spec)
    const confined = this.confine(spec, { ...policy, mode })
    const facts = {
      mode,
      enforcement: confined.enforcement,
      denialSignatures: confined.denialSignatures,
      runnerFailureRules: confined.runnerFailureRules,
    }
    try {
      return await this.startArgv(spec, confined.argv, (proc) => {
        this.processFacts.set(proc, facts)
      })
    } catch (error) {
      if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) {
        throw new SandboxUnavailableError(mode, String(error))
      }
      throw error
    }
  }

  /**
   * Stamp per-process sandbox facts before `done` settles. Full-access
   * processes have no facts; signal deaths are not denials.
   */
  protected override onProcessDone(proc: ShellProcess, stderr: string, observationFailed: boolean, observationError?: unknown): void {
    const facts = this.processFacts.get(proc)
    if (facts !== undefined) {
      this.processFacts.delete(proc)
      // A post-creation observation failure carries no trustworthy command
      // outcome. Otherwise runner failure outranks denial because its
      // diagnostics may contain denial terms.
      const runnerFailed = !observationFailed
        && classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== undefined
      proc.sandbox = {
        mode: facts.mode,
        denied: !runnerFailed && matchesSignature(proc.exitCode, stderr, facts.denialSignatures),
        enforcement: facts.enforcement,
        ...(runnerFailed ? { runnerFailed } : {}),
      }
    }
    super.onProcessDone(proc, stderr, observationFailed, observationError)
  }

  /**
   * Wrap one pwsh invocation via the `ctx.sandbox` provider. Provider errors
   * propagate unchanged; the returned argv is handed directly to the local
   * executor's subprocess path.
   * @param spec - resolved execution spec whose pwsh argv is confined.
   * @param policy - resolved confined execution policy.
   * @returns the provider's exact argv and settlement-classification facts.
   */
  private confine(spec: ShellExecSpec, policy: SandboxPolicy): ConfinedArgv {
    return this.ctx.sandbox.confine(this.argv(spec), policy)
  }
}
/* jscpd:ignore-end */

export default SandboxPwshExecutor
