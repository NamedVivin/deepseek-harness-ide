# subprocess/：子进程能力家族

[English](README.md) | 中文

这里集中提供一个执行世界的共享进程基底。普通进程与 PTY 会话是相互独立的能力；只需要批量命令或协议子进程的部署不会因此引入原生 `node-pty` 依赖。命令默认值补全、shell 语义、时限、协议分帧、就绪状态与呈现留在消费方：[bash 执行器](../shell/README.zh.md)、[LSP 主机](../lsp/README.zh.md)、[PTY shell 后端](../terminal/README.zh.md)与 [ACP（Agent Client Protocol）subagent 后端](../subagent/README.zh.md)。参见 [subprocess seam Agent Note](../../.agents/notes/implemented/architecture/2026-07-26-subprocess-seam.zh.md)。

| 包 | ctx 键 | 角色 |
|---|---|---|
| [`subprocess`](subprocess/README.zh.md)（`@deepseek-ai/dsh-subprocess`） | `ctx.subprocess` | 可执行文件查找与普通受管进程树的 Service Definition |
| [`subprocess-collector`](subprocess-collector/README.zh.md)（`@deepseek-ai/dsh-subprocess-collector`） | 无 | 提供方无关的有界尾部、偏移量、临时／最终 spill 与 drain 生命周期 |
| [`subprocess-local`](subprocess-local/README.zh.md)（`@deepseek-ai/dsh-subprocess-local`） | `ctx.subprocess` | 使用 detached 进程树和共享收集器的本地普通进程提供方 |
| [`subprocess-pty`](subprocess-pty/README.zh.md)（`@deepseek-ai/dsh-subprocess-pty`） | `ctx.subprocessPty` | 可选的终端分配、前台操作与会话清理 Service Definition |
| [`subprocess-pty-local`](subprocess-pty-local/README.zh.md)（`@deepseek-ai/dsh-subprocess-pty-local`） | `ctx.subprocessPty` | 使用平台进程检查的可选本地 `node-pty` 提供方 |

即使消费方重载，进程生命周期仍由服务负责管理；消费方负责定义进程的含义（一条 bash 命令、未来的非 shell 运行器），以及决定塑造该进程的每一项默认值。

子系统参考——spawn spec、输出读取器、结果、`DSH_*` 环境和可选 PTY 服务——见 [docs/subsystems/subprocess.md](../../docs/subsystems/subprocess.zh.md)。
