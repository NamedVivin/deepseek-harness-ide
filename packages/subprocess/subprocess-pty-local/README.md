# @deepseek-ai/dsh-subprocess-pty-local

English | [中文](README.zh.md)

Local Service Provider for [`ctx.subprocessPty`](../subprocess-pty/README.md). It allocates terminals through `node-pty`, scrubs the ambient environment with the same local rules as ordinary subprocesses, and uses platform process inspection to own foreground signalling and complete observable-session cleanup.

The provider publishes a handle only after `node-pty` supplies a positive process id. It retains exact pid/start identities from the rooted process tree; Linux also enumerates the POSIX session after its leader exits. Foreground inspection and signals therefore remain fenced against PID reuse, and awaited `terminate()` sweeps observable descendants before and after stopping the top-level shell. Normal service disposal terminates and joins every terminal session; Node's synchronous exit phase performs a final identity-checked force stop for handles still retained. The macOS package also ships `node-pty`'s executable spawn helper through the reviewed postinstall restoration step.

This package is optional. Local compositions that enable `terminal-bash` mount it explicitly; compositions without persistent terminals keep their dependency closure free of `node-pty` and its macOS helper.

## Model Experience

Indirectly, through terminal Consumers, which own prompts, schemas, bounded output, and diagnostics.

#### KV Cache effect

No direct invalidation; Consumers own any model-request prefix or result changes.

## Known Limitations and Deferred Work

- Windows PTY behavior depends on ConPTY through `node-pty`; the repository's native Windows CI remains authoritative for process/session behavior that POSIX hosts cannot emulate.
- Linux exact stdin-wait probes cover x64 and arm64; macOS uses `ps` snapshots and cannot prove syscall-level stdin waiting.
- A daemon can escape observation: on macOS by reparenting before any foreground snapshot, or on Linux by calling `setsid` and leaving both the rooted tree and owned terminal session.
