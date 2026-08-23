# preset/：按会话组装 agent

[English](README.md) | 中文

**agent preset** 是一个目录，其中放置一份 `agent.cordis.yml`。把它挂载到某个 agent（智能体）的 scope 上下文之下，该会话就获得自己的工具与提示词段落，而其他在运行的会话各自保持不变，因此一个进程可以同时运行多个组装方式不同的 agent。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `agent-presets/` | preset 词汇体系、对受信任根目录和用户自定义根目录的文件系统发现，以及受防护的按 agent 挂载 | `ctx.agentPresets` |
| `agent-presets-desktop/` | 不可变的 `desktop-default` 清单与覆盖所有操作的桌面准入策略 | — |
| `persona/` | 把 agent 人设做成可组装的行，使 preset 不止能改工具、也能改身份 | — |

CLI preset 位于 [`apps/cli/config/agent-presets/`](../../apps/cli/config/agent-presets)。打包桌面应用改用 [`agent-presets-desktop/config/agent-presets/`](agent-presets-desktop/config/agent-presets/) 中由 package 持有的单一清单；每份目录列表都是对应部署的权威来源。

本组假定的组装划分是：注册表与跨会话设施是进程单例，留在宿主组装中；preset 只承载单个 agent 对它们的贡献。若 preset 中某一行发布了进程级全局服务，挂载时即被拒绝，而不是留到与下一个会话相撞。

设计详见 [按会话组装 agent preset 的 Agent Note](../../.agents/notes/implemented/architecture/2026-08-03-per-session-agent-presets.zh.md)。
