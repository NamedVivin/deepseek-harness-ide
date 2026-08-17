# @deepseek-ai/dsh-subprocess-e2b

English | [中文](README.zh.md)

E2B implementation of the [`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess/README.md) seam. Load [`@deepseek-ai/dsh-e2b`](../e2b/README.md) first, then this service in place of `dsh-subprocess-local`. Existing Bash and LSP consumers then execute in the shared remote sandbox without E2B-specific capability packages.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `pollMs` | `20` | Remote status/liveness poll cadence in milliseconds; each tick is one control-plane request, so a larger value trades exit-observation latency for fewer requests. |

## Behavior

- **Asynchronous remote start** — `spawn()` remains pending while `Sandbox.commands.run(..., { background: true })` starts remotely. It resolves only after the wrapper publishes a validated positive process-group id; no handle with a placeholder identity crosses the seam. An owned startup signal aborts environment and private-state preparation before allocation; once allocation begins, cancellation waits for the provisional SDK handle, terminates its group, proves quiescence, and then rejects startup.
- **Execution-world coordinates** — `cwd` and private `runtimeRoot` come from the shared owner; executable lookup verifies absolute paths or resolves a bare name against the sandbox PATH plus explicit overrides, and rejects relative paths containing separators like every subprocess provider.
- **Linux process groups** — a quoted wrapper starts each argv under `exec setsid --wait` and records its actual process-group id plus private status files beneath `ctx.e2b.runtimeRoot/processes`. The handle waits for that file instead of treating the SDK command PID as its published identity. Termination signals the negative recorded id with `SIGTERM`, waits the caller's `graceMs`, then escalates to `SIGKILL` and the SDK kill fallback; TERM delivery or probe failures also force that escalation. Process-table probes treat groups containing only zombie or dead entries as quiescent. Force cleanup succeeds only after a bounded probe finds the group empty; otherwise `waitForExit()` exposes a retryable failure, while proven quiescence makes later termination a no-op. Publication and monitoring failures apply the same cleanup transaction before rejecting. Service disposal rejects new starts, terminates and joins every retained process group, then awaits SDK settlement and private cleanup before the sandbox owner disposes.
- **Environment boundary** — one trusted control-shell probe resolves the sandbox user's login home from its passwd entry and transports the sandbox environment as base64 ASCII for one strict UTF-8 decode; the wrapper then removes ambient `DSH_*` and credential-shaped (`*KEY*`, `*SECRET*`, `*TOKEN*`) names and restores every valid `spec.env` entry as an explicit caller opt-in. Empty names, `=`, and NUL framing violations reject before launch. Subsequent E2B command shells receive a fresh randomized root-level `HOME` plus empty overrides for every scrubbed ambient name before user profiles can run; the requested argv receives the serialized environment afterward without changing the sandbox user's umask. Host ambient variables never enter the sandbox implicitly. Private environment files are removed after consumption, and failed command setup removes its private state before rejecting.
- **Stdio projection** — the remote wrapper branches raw bytes into optional bounded spill files, frames each live chunk as newline-delimited base64 ASCII, and the host incrementally restores bytes across arbitrary SDK callback boundaries. Pipe mode writes those bytes to host Node streams; inherit mode writes them to the harness process streams; collect mode retains a bounded host tail with offset reads. The wrapper publishes the direct command status before waiting for inherited writers. For collect or inherit output, the adapter disconnects an incomplete SDK stream after `graceMs`, withholds its partial spill, and returns that status while retaining the remote group for `waitForExit()` and termination. Natural raw-pipe completion instead awaits lossless transport and preserves backpressure; explicit termination destroys the host pipes and releases blocked output before remote cleanup. Batch and streaming stdin use the SDK handle.
- **Sandbox disappearance** — `SandboxNotFoundError` during process liveness, termination, rollback, or disconnect proves the remote execution world cannot retain work, so cleanup treats it as quiescent; unrelated failures remain observable.

The default E2B base image supplies the runtime and Bash/GNU utilities this adapter invokes: `node`, `bash`, `setsid`, `ps`, `awk`, `tr`, `env`, `base64`, `chmod`, `tee`, `head`, `rm`, `kill`, `id`, and `getent`.

## Model Experience

Indirectly, through Consumers such as the Bash executor behind `dsh-tool-bash`, which render remote output, exit facts, background deltas, and spill paths.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **The SDK still retains complete command output in host memory** — E2B `CommandHandle.stdout` and `.stderr` accumulate the base64 transport even when this adapter exposes bounded raw-byte tails, so the subprocess seam's normal host-memory bound is not achieved and transport retention is larger than the source stream.
- **Private state lives for the sandbox lifetime** — process directories and valid spill files remain under `.dsh-e2b` until the owner deletes the sandbox; this POC supplies no in-sandbox sweep.
- **Control state shares the sandbox user's UID** — E2B runs every command as the same default user, so `0700`/`0600` modes cannot isolate `.dsh-e2b` control files from concurrently running sandbox processes. A background process could rewrite `pid`/`exit-code` or read a not-yet-consumed `environment` file. The adapter validates published values and refuses group ids whose negative form is unsafe to signal (`<= 1`), but real isolation needs an E2B per-command user or an out-of-band control channel.
- **The initial environment probe inherits sandbox defaults** — E2B merges command overrides with default environment entries, so the probe cannot blank unknown credential-shaped names before enumerating them. A same-UID untrusted process already in the sandbox could inspect that short-lived control shell; this POC therefore does not support secrets in sandbox-default environment variables and requires an E2B replacement-environment primitive to close the gap.
- **E2B exposes no signal fact** — an adapter-requested `SIGTERM` or `SIGKILL` is reported only when no wrapper-published direct exit code wins; every unrequested SDK exit remains an exit code, including values equal to `128 + signal`.
- **Linux utility and E2B transport semantics are assumed** — there is no Windows, escaped-session recovery, or network-partition fidelity layer.
