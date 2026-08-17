# @deepseek-ai/dsh-subprocess-pty

English | [中文](README.zh.md)

Service Definition for the optional `ctx.subprocessPty` capability. It owns terminal allocation, ordered byte input/output, foreground process-group inspection and signalling, and awaited cleanup of the complete provider-observable terminal session. Persistent-shell readiness, scrollback, prompts, sandbox policy, and tool presentation remain consumer behavior.

`spawnTerminal(spec)` resolves only after allocation has produced a positive process id and the provider owns the session. A handle exposes output, writes, foreground operations, exit facts, and one retryable `terminate()` transaction that reaches quiescence before resolving.

PTY capability is independent from ordinary `ctx.subprocess`. Deployments can keep generic shell commands while omitting every PTY provider and persistent-terminal consumer; a consumer that requires PTY declares `subprocessPty` as a required injection and fails at load when absent.

## Model Experience

Indirectly, through terminal Consumers, which own all model-visible schemas, output, and cleanup diagnostics.

#### KV Cache effect

No direct invalidation; Consumers own any model-request prefix or result changes.

## Known Limitations and Deferred Work

- Providers can promise cleanup only for process identities and session members their operating-system or remote substrate can authoritatively observe; each provider README records its remaining observability limits.
