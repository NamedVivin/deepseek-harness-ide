# @deepseek-ai/dsh-subprocess-guardian

English | [中文](README.zh.md)

Pure-Node subprocess provider and process-owning guardian runtime for the packaged desktop Host. The sidecar-facing `GuardianSubprocessRuntime` resolves executables in the guardian environment and performs an asynchronous stopped-child prepare/resume transaction, so `spawn()` returns only after stdio is installed, native ownership is confirmed, execution is resumed, and a positive operating-system PID is available.

`FramedGuardianPeer` multiplexes bounded JSON calls and stdio over the same-Node advanced-serialization IPC channel between guardian and sidecar. Every byte stream carries a sequence, acknowledgement, cancellation, and one hop-wide credit budget; unrelated desktop messages are ignored by the guardian parser. `GuardianHost` accepts a separately encoded Electron parent endpoint, terminates guardian frames locally, and relays all other sidecar traffic in order between Electron main and the Host. Parent loss, sidecar loss, malformed reserved control, or explicit disposal starts one idempotent quiescent cleanup transaction.

The native supervisor is mandatory and has no JavaScript detached-process fallback:

- On Windows x64, `KoffiWindowsJobTransport` creates a private `KILL_ON_JOB_CLOSE` Job Object, creates the target suspended, assigns it before resume, and retains the Job and process handles until active-process count reaches zero. `STARTUPINFOEXW` and `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` whitelist only the requested target stdio handles even though `CreateProcessW` must enable handle inheritance.
- On macOS, `MacOsProcessCapsuleTransport` launches the fixed signed `dsh-process-capsule` helper. The helper remains outside the target group and forks a capsule child that calls `setsid()`, creates a distinct stopped target child, resumes only after guardian and Electron-main ownership confirmation, monitors both liveness channels, applies TERM → grace → KILL to the complete group, and reports group-zero before release. Electron main retains a read-only PGID mirror; any stopped rollback or resumed outcome/terminate/wait/release failure uses the `recover`/`recovered` control transaction so main kills and joins the recorded group before deleting ownership.

The desktop guardian entry is built as `apps/desktop/lib/guardian.js`. Packaged macOS applications place the helper at `desktop-resources/native/dsh-process-capsule`; `apps/desktop/native/process-capsule/build.sh <arm64|x86_64> <absolute-output>` builds the architecture-specific Mach-O artifact. Electron main maps signed runtime configuration directly to the guardian arguments: `maxDesktopBodyBytes`, `maxDesktopChunkBytes`, and `maxDesktopInflightBytes` set the three IPC limits; `nativeProcessPollMs` sets the maximum interval between native and main-owned liveness probes; `gracefulShutdownMs` and `forceShutdownMs` bound direct-sidecar termination; and `mirrorTimeoutMs` bounds each main ownership acknowledgement. Main also supplies the absolute sidecar entry and, on macOS, the helper path and inherited main-liveness descriptor.

The published npm payload carries every generated `lib/channel-*.js` runtime chunk shared by the provider, guardian, and Host entrypoints. Desktop assembly links the deployed Host entry before Forge runs, so an incomplete publish list fails before an application package is created.

`DesktopGuardianMainOwner` records the privileged `dsh.guardian.mirror` `sidecar-started` message before accepting sidecar readiness and clears it only after `sidecar-joined`. It also owns every macOS capsule record and serializes register, release, and recover acknowledgements. Guardian exit, error, disconnect, malformed control, or relayed runtime failure triggers bounded TERM → poll → KILL → poll cleanup for every retained PID and PGID; `prepareShutdown()` marks an expected exit without removing listeners, and `dispose()` waits for cleanup. The sidecar remains a direct guardian child rather than a kernel Job/capsule member, so this second-owner cleanup must not be described as a kernel-enforced orphan guarantee.

## Model Experience

Indirectly, through ordinary subprocess and shell Consumers. The provider preserves their existing outcome, stdio, collected-tail, truncation, and spill semantics while moving process creation outside the sidecar.

#### KV Cache effect

No direct invalidation; Consumers own model-visible result formatting.

## Known Limitations and Deferred Work

- Windows arm64 is not supported; the first packaged Windows target is x64.
- Native failure-path authority comes from the corresponding macOS and Windows release runners. Cross-platform unit tests verify protocol and ownership transaction ordering but do not substitute for those operating-system checks.
- Sidecar crash cleanup is dual-owned at the application protocol level, not by a transferred native process handle. A future native sidecar owner can replace that transport without changing the generic guardian protocol.
