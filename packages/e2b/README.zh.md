# e2b/ — E2B 远程运行时家族

[English](README.md) | 中文

这是一个实验性提供方组合 POC，把一个文件系统／进程执行环境放进 E2B Linux 沙箱。E2B 只提供沙箱生命周期与两个基础 OS 适配器；提供方无关的消费方在其上构建更高层能力。

| 包（package） | ctx 键 | 职责 |
|---|---|---|
| [`e2b`](e2b/README.zh.md)（`@deepseek-ai/dsh-e2b`） | `ctx.e2b` | 创建一个沙箱，准备其工作目录与运行时目录，公开共享 SDK 句柄，并在超时或资源释放时将其删除 |
| [`fs-e2b`](fs-e2b/README.zh.md)（`@deepseek-ai/dsh-fs-e2b`） | `ctx.fs` | 通过 E2B Filesystem API 实现文件系统 seam |
| [`subprocess-e2b`](subprocess-e2b/README.zh.md)（`@deepseek-ai/dsh-subprocess-e2b`） | `ctx.subprocess` | 通过 E2B Commands 实现可执行文件查找、受管进程组、stdio 与远端 spill 文件 |
| [`subprocess-pty-e2b`](subprocess-pty-e2b/README.zh.md)（`@deepseek-ai/dsh-subprocess-pty-e2b`） | `ctx.subprocessPty` | 可选地通过 E2B PTY API 实现终端会话与前台操作 |

现有的 [`dsh-bash-local`](../shell/bash-local/README.zh.md)、[`dsh-terminal-bash`](../terminal/terminal-bash/README.zh.md) 和 [`dsh-lsp-stdio`](../lsp/lsp-stdio/README.zh.md) 无需 E2B 专用 fork。它们把执行世界操作委托给 `ctx.fs`、`ctx.subprocess` 与可选的 `ctx.subprocessPty`；挂载对应 E2B 适配器后，其可变工作都发生在同一个沙箱内。

该边界不会迁移 harness 进程、Cordis 对象、模型调用、agent（智能体）／会话状态、会话持久化、skill（技能）、更高层协议状态或 E2B SDK 缓冲。[可移植执行世界决策](../../.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.zh.md)同时界定通用组合和此 POC 边界。
