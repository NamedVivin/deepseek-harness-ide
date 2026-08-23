# @deepseek-ai/dsh-subprocess-pty-local

English | [中文](README.zh.md)

Local Service Provider for [`ctx.subprocessPty`](../subprocess-pty/README.md). It allocates terminals through `node-pty`, scrubs the ambient environment with the same local rules as ordinary subprocesses, and uses platform process inspection to own foreground signalling and complete observable-session cleanup.

The provider publishes a handle only after `node-pty` supplies a positive process id. It retains exact pid/start identities from the rooted process tree; Linux also enumerates the POSIX session after its leader exits. Awaited `terminate()` rechecks those identities while sweeping observable descendants before and after stopping the top-level shell. Normal service disposal terminates and joins every terminal session; Node's synchronous exit phase performs a final identity-checked force stop for handles still retained.

On Windows, the koffi-backed inspector enumerates the process table through Toolhelp32, combines GetProcessTimes creation identities with zero-time process-handle waits for liveness, and reports the shell pid as a pseudo foreground group because Windows has no POSIX process groups. Teardown verifies shell termination through that inspector because an externally taskkilled shell may never emit `node-pty`'s exit notification. The macOS package also ships `node-pty`'s executable spawn helper through the reviewed postinstall restoration step.

This package is optional. Local compositions that enable `terminal-bash` mount it explicitly; compositions without persistent terminals keep their dependency closure free of `node-pty` and its macOS helper.

## Model Experience

Indirectly, through terminal Consumers, which own prompts, schemas, bounded output, and diagnostics.

#### KV Cache effect

No direct invalidation; Consumers own any model-request prefix or result changes.

## Known Limitations and Deferred Work

- Windows PTY behavior depends on ConPTY through `node-pty`; the repository's native Windows CI remains authoritative for process/session behavior that POSIX hosts cannot emulate.
- Windows terminal signalling is console-wide: SIGINT is delivered as a `\x03` Ctrl-C input write that conhost turns into a console-wide CTRL_C event; SIGTSTP and SIGHUP are rejected as unavailable. SIGTERM uses `taskkill` without `/F`, which does not terminate console processes, so the TERM tier is a grace wait before forced `/F` escalation. Windows inspection cannot prove exact stdin waiting and reports `inputWaiting: false`.
- Linux exact stdin-wait probes cover x64 and arm64; macOS uses `ps` snapshots and cannot prove syscall-level stdin waiting.
- A daemon can escape observation: on macOS by reparenting before any foreground snapshot, or on Linux by calling `setsid` and leaving both the rooted tree and owned terminal session. The provider does not continuously monitor the process table.
- In-process cleanup requires a JavaScript-observable exit. Direct `process.exit()`, default uncaught exceptions, and default unhandled rejections emit Node's synchronous `exit` event. The default OS disposition for an unhandled `SIGTERM`, `SIGINT`, or `SIGHUP` bypasses that event; an application covers those signals only by installing a handler that performs normal disposal or calls `process.exit()`. `SIGKILL`, fatal OOM, `process.abort()`, native crashes, power loss, and any failure that cannot run JavaScript require an external supervisor or OS owner.
