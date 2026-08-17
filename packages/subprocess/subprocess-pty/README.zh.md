# @deepseek-ai/dsh-subprocess-pty

[English](README.md) | 中文

可选 `ctx.subprocessPty` 能力的 Service Definition。它负责 terminal 分配、有序字节输入输出、前台进程组检查与信号，以及等待 provider 可观察的完整 terminal session 清理完成。持久 shell readiness、scrollback、prompt、sandbox policy 与 tool presentation 仍属于 consumer 行为。

`spawnTerminal(spec)` 只有在分配得到正数进程 ID 且 provider 已掌控 session 后才 resolve。Handle 提供 output、write、前台操作、退出事实，以及一项可重试的 `terminate()` transaction；该 transaction 到达 quiescence 后才 resolve。

PTY 能力与普通 `ctx.subprocess` 相互独立。Deployment 可保留普通 shell 命令，同时省略所有 PTY provider 和 persistent-terminal consumer；需要 PTY 的 consumer 会把 `subprocessPty` 声明为必需 injection，缺失时在 load 阶段明确失败。

## 模型体验

通过 terminal Consumer 间接影响；这些 Consumer 负责所有模型可见 schema、输出与清理诊断。

#### KV Cache 影响

不会直接导致 KV Cache 失效；模型请求前缀或结果变更归 Consumer 所有。

## 已知限制与后续工作

- Provider 只能对其操作系统或远端底层能够权威观察的进程 identity 与 session member 承诺清理；每个 provider README 会记录尚存的可观察性限制。
