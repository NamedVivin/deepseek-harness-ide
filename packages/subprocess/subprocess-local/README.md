# @deepseek-ai/dsh-subprocess-local

English | [中文](README.zh.md)

Local Service Provider for the ordinary [`@deepseek-ai/dsh-subprocess`](../subprocess/README.md) seam. `LocalSubprocessRuntime` resolves local executables and spawns detached process trees with explicit stdio. It has no config: every disposition, limit, grace, and directory arrives from consumers such as [`dsh-bash-local`](../../shell/bash-local/README.md) and [`dsh-lsp-stdio`](../../lsp/lsp-stdio/README.md). Local terminal sessions are an optional separate provider in [`dsh-subprocess-pty-local`](../subprocess-pty-local/README.md), so this package has no `node-pty` dependency.

## Behavior

- **Detached process trees with platform-correct signalling** — POSIX children are spawned `detached` (own process group) and signalled by negative pgid with a direct-child fallback; Windows terminates the tree via `taskkill /PID <pid> /T /F`. `terminate()` — the handle's only termination verb — sends SIGTERM then SIGKILL after the spec's grace (OpenCode's escalation; pipelines and subshells die with the parent) and is a no-op once the tree is gone; `waitForExit()` polls whole-tree liveness so consumer teardown confirms real quiescence. After the leader exits, still-open pipes receive the same bounded drain grace so a surviving descendant cannot hold the outcome open indefinitely. ESRCH is tolerated; daemons that re-parent away from the group can still survive.
- **Per-stream dispositions** — `'pipe'` hands the raw stream to the caller untouched; `'inherit'` passes the parent descriptor through; collect mode delegates bounded tails, whole-stream offsets, and optional spill files to [`dsh-subprocess-collector`](../subprocess-collector/README.md). A spill remains provider-private until clean stream drain closes it successfully. Transport error, early close, or bounded drain expiry preserves the tail but withholds and deletes the incomplete spill.
- **Credential scrub + explicit merge** — `process.env` minus credential-shaped vars (`*KEY*`/`*PASSWORD*`/`*SECRET*`/`*TOKEN*`) and all ambient `DSH_*` names; the spec's explicit `env` merges after that scrub with no namespace validation, so a deliberately supplied credential or current `DSH_*` fact wins while stale nested-harness identity cannot leak in ambiently. Supplied stdin is written and closed; otherwise fd 0 is `/dev/null`. See the [stdin/env Agent Note](../../../.agents/notes/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-api.md) and [managed environment Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-agent-session-identity-and-log-location.md).
- **Offset-based reads** — collect-mode readers return deltas in whole-stream byte coordinates; the service never holds a cursor, so consumer-owned cursors (the bash background read path) and full-stream re-reads coexist, before and after settlement.
- **Executable lookup** — `resolveExecutable` checks absolute files or searches the scrubbed effective PATH with platform-aware executable extensions; relative paths containing separators are rejected at the seam, and relative PATH entries resolve from the host process cwd.
- **Terminate-and-join disposal** — the service retains live handles so its own disposal can escalate every running tree and await its exit; quiescent and spawn-failed handles leave the live set after whole-tree cleanup finishes.
- **Synchronous host-exit finalization** — while the service effect is active, a Node `exit` listener force-terminates every retained ordinary tree. The operation sends POSIX SIGKILL to the managed group or runs Windows `taskkill /T /F`; it creates no promise or timer, preserves the host's exit code and diagnostic, contains each target's failure, and does not claim quiescence. Normal disposal keeps the awaited graceful path above. See the [host-exit cleanup decision](../../../.agents/notes/implemented/bug-fix/2026-08-11-synchronous-subprocess-exit-cleanup.md).

## Model Experience

Indirectly, through Consumers (today the bash executor family behind `dsh-tool-bash`), which own all model-facing rendering of process output and lifecycle.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **Windows tree support is best-effort** — termination routes through `taskkill /PID <pid> /T /F` with all outcomes contained (absent tree, races, missing binary), and liveness falls back to the direct-child boundary.
- **In-process cleanup requires a JavaScript-observable exit** — direct `process.exit()`, default uncaught exceptions, and default unhandled rejections emit Node's synchronous `exit` event. The default OS disposition for an unhandled `SIGTERM`, `SIGINT`, or `SIGHUP` bypasses that event; an application covers those signals only by installing a handler that performs normal disposal or calls `process.exit()`. `SIGKILL`, fatal OOM, `process.abort()`, native crashes, power loss, and any failure that cannot run JavaScript require an external supervisor, container init, or equivalent OS owner.
- **The credential scrub is a name heuristic** — `*KEY*`/`*PASSWORD*`/`*SECRET*`/`*TOKEN*` only; differently-named secrets (e.g. `*PASSPHRASE*`) pass through, and a whitelist for over-scrubbed vars is noted future work.
- **Completed spill files are not deleted** — bounded full-output recovery files (and the private per-process spill dir) accumulate under the OS tmpdir until something external cleans them; oversize incomplete spills are discarded and deletion is attempted immediately, but a cleanup failure can leave a bounded file behind.

The raw process handling lives in `src/spawn.ts`; `src/index.ts` is the service wiring.
