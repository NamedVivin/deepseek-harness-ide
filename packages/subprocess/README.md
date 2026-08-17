# subprocess/ — subprocess capability family

English | [中文](README.zh.md)

The shared process substrate for one execution world. Ordinary processes and PTY sessions are independent capabilities: deployments that need batch commands or protocol children do not acquire the native `node-pty` dependency. Command defaulting, shell semantics, deadlines, protocol framing, readiness, and presentation stay with consumers — the [bash executors](../shell/README.md), [LSP host](../lsp/README.md), [PTY shell backend](../terminal/README.md), and [ACP subagent backend](../subagent/README.md).

| Package | ctx key | Role |
|---|---|---|
| [`subprocess`](subprocess/README.md) (`@deepseek-ai/dsh-subprocess`) | `ctx.subprocess` | Service Definition for executable lookup and ordinary managed process trees |
| [`subprocess-collector`](subprocess-collector/README.md) (`@deepseek-ai/dsh-subprocess-collector`) | — | Provider-neutral bounded tail, offsets, provisional/finalized spill, and drain lifecycle |
| [`subprocess-local`](subprocess-local/README.md) (`@deepseek-ai/dsh-subprocess-local`) | `ctx.subprocess` | Local ordinary-process provider using detached process trees and shared collection |
| [`subprocess-pty`](subprocess-pty/README.md) (`@deepseek-ai/dsh-subprocess-pty`) | `ctx.subprocessPty` | Optional Service Definition for terminal allocation, foreground operations, and session cleanup |
| [`subprocess-pty-local`](subprocess-pty-local/README.md) (`@deepseek-ai/dsh-subprocess-pty-local`) | `ctx.subprocessPty` | Optional local `node-pty` provider with platform process inspection |

The service owns process lifetime across consumer reloads; consumers own what a process means (a bash command, a future non-shell runner) and every default that shapes one.

The subsystem reference — spawn specs, output readers, outcomes, the `DSH_*` environment, and the optional PTY service — is [docs/subsystems/subprocess.md](../../docs/subsystems/subprocess.md).
