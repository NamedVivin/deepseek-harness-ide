/**
 * Process plumbing for the local subprocess service: detached process-tree
 * spawn with per-stream stdio dispositions, tail-keep collection with spill
 * files, tree-scoped signalling (POSIX groups; Windows taskkill), and the
 * SIGTERM→SIGKILL escalation. This layer reacts to an abort signal; callers
 * own deadlines, teardown ladders, and cause classification.
 * @module dsh-subprocess-local/spawn
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import type { Readable } from 'node:stream'
import { setTimeout as sleepMs } from 'node:timers/promises'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { collectReadable } from '@deepseek-ai/dsh-subprocess-collector'
import type { CollectedReadable } from '@deepseek-ai/dsh-subprocess-collector'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { linuxProcessGroupHasLiveMembers } from './linux-process-group.ts'

/**
 * Build a child environment: explicit caller entries override the scrubbed
 * parent base using the target platform's environment-key semantics. A string
 * deliberately restores or overrides an entry; an explicit `undefined`
 * tombstone removes an ordinary ambient entry.
 * @param extra - explicit caller entries and tombstones, merged after the scrub.
 * @returns the environment to hand to `spawn` for the child process.
 */
export function childEnv(extra?: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const env = scrubbedParentEnv()
  if (process.platform !== 'win32') return { ...env, ...extra }
  let entries: [string, string | undefined][] = Object.entries(env)
  for (const [key, value] of Object.entries(extra ?? {})) {
    const normalized = key.toUpperCase()
    entries = entries.filter(([inherited]) => inherited.toUpperCase() !== normalized)
    entries.push([key, value])
  }
  return Object.fromEntries(entries)
}

/** Injectable knobs so tests can exercise spill and platform behavior deterministically. */
export interface SpawnInternals {
  /** Directory for spill files (defaults to the OS temp dir). */
  spillDir?: string
  /** Windows tree-termination runner (defaults to `taskkill /PID <pid> /T /F`). */
  taskkill?: (pid: number) => void
  /** Host platform override for signalling decisions. */
  platform?: NodeJS.Platform
  /** Linux process-group member probe (defaults to `/proc` inspection). */
  linuxProcessGroupHasLiveMembers?: (processGroupId: number) => boolean | undefined
}

/**
 * Local-only synchronous final termination used by the owning service during
 * host exit and as the last fallback after failed normal disposal. It is
 * intentionally absent from the public subprocess seam.
 */
export interface LocalSubprocessHandle extends SubprocessHandle {
  /** Resolves after Node confirms process creation and the handle has a positive pid. */
  readonly ready: Promise<void>
  /** Force-terminate the current tree synchronously without starting timers or waits. */
  terminateForHostExit(): void
}

/**
 * Liveness-poll cadence for tree-exit waits. The timer stays ref'd: an
 * awaited teardown must keep the event loop alive until the tree really
 * exits, or the parent can exit while claiming quiescence and orphan the
 * survivors it promised to reap.
 */
function sleepTick(): Promise<void> {
  return sleepMs(15)
}

/**
 * Send `sig` to a detached POSIX process group. Never throws: delivery races
 * process exit and may run in a timer callback, so failures are contained and
 * a non-positive pid is a no-op.
 * @param pid - the group leader's pid; non-positive means the spawn failed and the call is a no-op.
 * @param sig - the signal to deliver to the whole group.
 */
export function killGroup(pid: number, sig: NodeJS.Signals): void {
  if (pid <= 0) return
  try {
    process.kill(-pid, sig)
  } catch {
    // Swallow: see contract above.
  }
}

/**
 * Terminate one Windows process tree with `taskkill /T /F`. Contained like
 * POSIX group signalling — delivery races tree exit, so an absent tree, a
 * nonzero status, or a missing taskkill binary must not break idempotent
 * teardown.
 * @param pid - root process id; non-positive is a no-op.
 */
export function taskkillProcessTree(pid: number): void {
  if (pid <= 0) return
  // Outcome deliberately unchecked: an already-absent tree (status 128), exit
  // races, and a missing taskkill binary (spawnSync reports, never throws) are
  // as tolerable here as ESRCH is for a POSIX group signal.
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

/**
 * Signal a detached process tree with platform-correct semantics: POSIX
 * signals the negative process-group id and falls back to the direct child
 * when the group is gone; Windows terminates the tree via taskkill (any
 * signal value force-terminates — Node maps signals to TerminateProcess).
 */
function signalTree(
  platform: NodeJS.Platform,
  pid: number,
  sig: NodeJS.Signals,
  child: ChildProcess,
  taskkill: (pid: number) => void,
): void {
  if (platform === 'win32') {
    taskkill(pid)
    return
  }
  /* v8 ignore next -- kill/terminate gate on treeAlive(), which is false for pid -1; this guard protects direct callers only. */
  if (pid <= 0) return
  try {
    process.kill(-pid, sig)
  } catch {
    /* v8 ignore start -- the fallback needs a live child whose group signal fails
       (EPERM-style), which POSIX CI cannot stage; the swallow keeps teardown idempotent. */
    try {
      child.kill(sig)
    } catch {
      // The direct child already exited; teardown remains idempotent.
    }
    /* v8 ignore stop */
  }
}

/**
 * Begin one isolated detached process tree with the spec's per-stream stdio
 * dispositions. {@link LocalSubprocessHandle.ready} confirms creation;
 * runtime exits resolve `done` as {@link SubprocessOutcome}, while creation
 * or later process-observation failures reject it.
 * @param spec - fully resolved argv, cwd, stdio, grace, cancellation, environment.
 * @param internals - test-only spill-directory, platform, and taskkill overrides.
 * @returns an unpublished handle whose `ready` promise confirms its positive pid.
 * @throws when `graceMs` cannot be represented by one Node timer.
 */
export function spawnSubprocess(spec: SubprocessSpawnSpec, internals: SpawnInternals = {}): LocalSubprocessHandle {
  if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const platform = internals.platform ?? process.platform
  const taskkill = internals.taskkill ?? taskkillProcessTree
  const linuxGroupHasLiveMembers = internals.linuxProcessGroupHasLiveMembers ?? linuxProcessGroupHasLiveMembers

  if (spec.signal?.aborted) {
    throw new Error(`aborted before spawn: ${String(spec.signal.reason ?? 'aborted')}`)
  }
  const [program, ...args] = spec.argv
  if (program === undefined || program.length === 0) {
    throw new Error('invalid argv: expected a non-empty program name at argv[0]')
  }

  const isCollect = (mode: SubprocessOutputMode): mode is SubprocessCollect =>
    mode !== 'pipe' && mode !== 'inherit'
  const outMode = spec.stdio.stdout
  const errMode = spec.stdio.stderr
  const stdinMode = spec.stdio.stdin

  const env = childEnv(spec.env)
  const child = spawn(program, args, {
    cwd: spec.cwd,
    env,
    stdio: [
      stdinMode === 'ignore' ? 'ignore' : 'pipe',
      outMode === 'inherit' ? 'inherit' : 'pipe',
      errMode === 'inherit' ? 'inherit' : 'pipe',
    ],
    // `detached` gives teardown a tree root on POSIX (its own process group);
    // Windows terminates by root pid through taskkill /T instead.
    detached: platform !== 'win32',
  })

  const collectStream = (
    mode: SubprocessOutputMode,
    stream: Readable | null,
    label: string,
  ): CollectedReadable | undefined => {
    if (!isCollect(mode) || stream === null) return undefined
    return collectReadable(stream, {
      maxBytes: mode.maxBytes,
      ...mode.spill !== undefined ? { maxSpillBytes: mode.spill.maxBytes } : {},
      label,
      ...internals.spillDir !== undefined ? { spillDir: internals.spillDir } : {},
    })
  }
  const stdoutCollector = collectStream(outMode, child.stdout, 'stdout')
  const stderrCollector = collectStream(errMode, child.stderr, 'stderr')

  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let treeExitObserved = false
  let treeExitObservation: Promise<void> | undefined
  let settled = false

  // The numeric sentinel stays private to pre-publication signalling and liveness checks.
  const pid = child.pid ?? -1
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    child.once('spawn', resolveReady)
    child.once('error', rejectReady)
  })
  void ready.catch(() => {})

  /** Whether the detached tree's root (or POSIX group) is still alive. */
  const treeAlive = (): boolean => {
    /* v8 ignore next -- only a timer callback already queued when the observer settles can enter here;
       the guard is the final defense against probing an id after its tree was confirmed absent. */
    if (treeExitObserved) return false
    if (pid <= 0) return false
    if (platform === 'win32') {
      // Windows has no group-liveness probe; the direct child's exit is the
      // observable boundary (taskkill /T already took the tree with it).
      return child.exitCode === null && child.signalCode === null
    }
    try {
      process.kill(-pid, 0)
      // A group containing only unreaped zombies still answers kill(0), but
      // it can execute no work and cannot be signalled into quiescence. Only
      // inspect after direct-child settlement so live-process polls remain a
      // syscall rather than repeated process-table scans.
      if (settled && platform === 'linux' && linuxGroupHasLiveMembers(pid) === false) return false
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      /* v8 ignore next 2 -- POSIX reports an absent group as ESRCH; child-reaping timing
         makes observing the other arm platform-dependent. */
      if (code === 'ESRCH') return false
      /* v8 ignore start -- EPERM and non-POSIX negative-pid failures are platform defenses; CI runs
         tree-lifecycle tests on POSIX hosts where absence reports ESRCH. */
      if (code === 'EPERM') return true
      return child.exitCode === null && child.signalCode === null
      /* v8 ignore stop */
    }
  }

  /**
   * Start or reuse the handle's single whole-tree exit observer. The first
   * confirmed absence is a permanent no-more-signals boundary: it cancels a
   * pending escalation before this process-group id can be reused.
   */
  const observeTreeExit = (): Promise<void> => {
    treeExitObservation ??= (async () => {
      while (treeAlive()) await sleepTick()
      treeExitObserved = true
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      graceTimer = undefined
    })()
    return treeExitObservation
  }

  // The escalation's tier primitive (not on the handle — terminate() is the
  // only consumer-facing termination verb). Guards on TREE liveness, not
  // outcome settlement: a TERM-trapping helper can outlive the settled direct
  // child and must stay signalable, while a fully-dead tree (possible pid
  // reuse) must not be re-signalled by a later tier.
  const kill = (sig: NodeJS.Signals): void => {
    /* v8 ignore next -- the shared exit observer cancels the ordinary dead-tree timer;
       this remains the timer/death race guard and cannot be staged deterministically. */
    if (!treeAlive()) return
    signalTree(platform, pid, sig, child, taskkill)
  }

  const terminate = (): void => {
    if (treeExitObserved || graceTimer !== undefined) return
    // Observe from the first termination tier onward, even when inherited
    // pipes delay `done` and no consumer has begun its own teardown wait.
    void observeTreeExit()
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- observer can record absence before its first await.
    if (treeExitObserved) return
    kill('SIGTERM')
    // The escalation must survive direct-child settlement — the leader dying
    // does not mean the tree died — so settle does not clear this timer, and
    // kill() re-probes tree liveness before force-killing. It stays ref'd:
    // the pending SIGKILL is a commitment, and a parent exiting before it
    // fires would orphan a trapped survivor. Self-bounds at graceMs.
    graceTimer = setTimeout(() => { kill('SIGKILL') }, spec.graceMs)
  }

  const terminateForHostExit = (): void => {
    kill('SIGKILL')
  }

  // The caller owns timeout classification; this layer only reacts to abort.
  const onAbort = (): void => { terminate() }
  spec.signal?.addEventListener('abort', onAbort, { once: true })

  // Batch stdin is written and closed up front; process exit and captured
  // output remain authoritative, so write errors (EPIPE) are best-effort.
  if (typeof stdinMode === 'object' && child.stdin !== null) {
    child.stdin.on('error', () => { /* stdin write is best-effort; outcome rides on exit/output. */ })
    child.stdin.end(stdinMode.data)
  }

  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    let pipeDrainTimer: ReturnType<typeof setTimeout> | undefined
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      // Only harness-collected pipes are force-closed at the drain boundary;
      // a 'pipe'-mode stream belongs to the caller and closes with the child.
      cleanup()
      resolve({ exitCode, signal })
    }
    child.on('error', (error) => {
      // No meaningful close outcome follows a spawn failure.
      settled = true
      stdoutCollector?.fail(error)
      stderrCollector?.fail(error)
      cleanup()
      reject(error)
    })
    child.on('exit', (exitCode, signal) => {
      // A surviving descendant that inherited a pipe must not hold the
      // outcome open indefinitely: after exit, the same bounded grace that
      // governs kills also bounds the close wait.
      pipeDrainTimer = setTimeout(() => {
        const failure = new Error('subprocess-local: collected output did not drain before the process grace expired')
        stdoutCollector?.fail(failure)
        stderrCollector?.fail(failure)
        settle(exitCode, signal)
      }, spec.graceMs)
    })
    child.on('close', settle)
    function cleanup(): void {
      // graceTimer deliberately NOT cleared: the SIGKILL escalation must be
      // able to reach tree survivors after the direct child settles.
      if (pipeDrainTimer !== undefined) clearTimeout(pipeDrainTimer)
      spec.signal?.removeEventListener('abort', onAbort)
    }
  })

  const waitForExit = async (signal?: AbortSignal): Promise<boolean> => {
    const observed = observeTreeExit()
    if (treeExitObserved) return true
    if (signal?.aborted) return false
    if (signal === undefined) {
      await observed
      return true
    }
    const aborted = Promise.withResolvers<boolean>()
    const onAbort = (): void => { aborted.resolve(false) }
    signal.addEventListener('abort', onAbort, { once: true })
    /* v8 ignore next -- closes the event-loop race between the preceding aborted check and listener registration. */
    if (signal.aborted) onAbort()
    try {
      return await Promise.race([observed.then(() => true), aborted.promise])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  return {
    get pid(): number {
      if (pid <= 0) throw new Error('subprocess-local: process id requested before successful creation')
      return pid
    },
    /* v8 ignore start -- pipe-mode fds exist on every spawn Node returns; the null-coalesces guard a nonconforming ChildProcess only. */
    stdin: stdinMode === 'pipe' ? child.stdin ?? undefined : undefined,
    stdout: outMode === 'pipe' ? child.stdout ?? undefined : undefined,
    stderr: errMode === 'pipe' ? child.stderr ?? undefined : undefined,
    /* v8 ignore stop */
    collected: {
      ...stdoutCollector !== undefined ? { stdout: stdoutCollector.reader } : {},
      ...stderrCollector !== undefined ? { stderr: stderrCollector.reader } : {},
    },
    ready,
    done,
    terminate,
    terminateForHostExit,
    waitForExit,
  }
}
