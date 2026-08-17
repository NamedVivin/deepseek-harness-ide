# @deepseek-ai/dsh-subprocess-pty-e2b

English | [中文](README.zh.md)

E2B Service Provider for the optional [`ctx.subprocessPty`](../../subprocess/subprocess-pty/README.md) capability. Load [`dsh-e2b`](../e2b/README.md) first, then this package when a remote composition needs persistent terminal sessions. Ordinary remote processes remain in [`dsh-subprocess-e2b`](../subprocess-e2b/README.md).

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `pollMs` | `20` | Remote session-liveness polling interval in milliseconds; each tick is a control-plane request. |

## Behavior

- `spawnTerminal()` uses E2B's byte PTY API and mode-`0600` private files to install exact argv plus the shared provider's scrubbed remote environment. A random output boundary removes the bootstrap shell prompt and echoed runner command while preserving requested-process bytes.
- Publication waits for a positive PTY process id, the bootstrap output boundary, and a resolved POSIX session id. Cancellation or service disposal during setup runs the owned rollback before rejecting; no provisional terminal handle crosses the service.
- The handle reports foreground process groups, sends real signals, and tracks in-flight writes, inspections, and signals. Its retryable awaited `terminate()` rejects new operations, settles existing operations, and terminates every live process group still visible in the remote terminal session. Zombie-only groups count as quiescent.
- Setup and teardown own their private state directories. `SandboxNotFoundError` proves that the remote execution world cannot retain work and is treated as quiescent; unrelated cleanup failures remain observable.
- Prompt detection, scrollback, readiness, sandbox policy, and owner lifecycle remain in [`dsh-terminal-bash`](../../terminal/terminal-bash/README.md).

## Model Experience

Indirectly, through terminal Consumers, which own model-visible schemas, bounded output, and cleanup diagnostics.

#### KV Cache effect

No direct invalidation; Consumers own any model-request prefix or result changes.

## Known Limitations and Deferred Work

- E2B exposes numeric PID/PGID operations without an atomic start-identity fence, so a sufficiently delayed operation can overlap PID reuse.
- The SDK exposes foreground groups but not syscall evidence for an fd-0 wait; the terminal consumer falls back to controlled prompt markers and bounded silence.
- A paused output consumer can accumulate terminal bytes in host memory because E2B PTY delivery has no awaited backpressure channel.
- The provider assumes the E2B Linux image supplies Bash, `ps`, `awk`, `kill`, `env`, `chmod`, `rm`, `id`, and `getent`; Windows and escaped-session recovery are unsupported.
