# dsh-agent-presets-desktop

[English](README.md) | 中文

这是打包桌面应用第一版使用的固定 Agent 清单。本包只交付一个系统 preset：`desktop-default`；启动时验证它是唯一配置的根目录条目，并注册 effect-scoped 准入策略，在发现或组装前拒绝其他所有 preset。

## 组装与准入

桌面应用使用 `DESKTOP_PRESET_ROOT`、`default: desktop-default` 和 `includeUserRoot: false` 配置 [`dsh-agent-presets`](../agent-presets/README.zh.md)，随后挂载本 provider。若 live service 暴露了其他根目录、preset、默认值、创作路径、插件行，或 `fs`、`subprocess`、`subprocessPty`、`terminals` isolate，启动会以 `DesktopPresetStartupError` 失败。同时存在第二个 provider 实例也会导致启动失败。

`desktop-default` 挂载普通 Bash/PowerShell、文件系统、搜索、字符串替换、任务、skill、提问与 todo consumer。它继承 Host 的同一份 `ctx.fs` 和 `ctx.subprocess` service，且不包含文件系统 provider、subprocess provider、PTY service、持久终端 consumer 或持有 provider 的 isolate。这样，编辑器保存与 Harness 文件工具共用同一 Host 文件系统权限，而普通 shell 工具使用应用选择的桌面 guardian provider。

该 provider 通过 `ctx.agentPresets.registerAdmission()` 贡献策略。每个 preset service 操作只接受 `desktop-default`；其他 id 会抛出 `PresetAdmissionError`，其中包含 `desktop-preset-unsupported` code、尝试的操作和 id、稳定原因及 `details.supportedPreset`。销毁 provider fiber 会移除该 contribution，并释放单 provider 启动声明。

## 模型体验

### 桌面编码组装

#### 模型看到什么

模型会看到编码 Agent 人设，以及固定 `desktop-default` consumer 清单注册的工具 schema。准入策略本身不增加提示词或工具。

#### Token 影响

在模型与 Host 配置固定时保持固定：桌面人设、工具 schema、仓库指令与已加载的 skill 描述。provider 不增加动态准入 token。

#### KV Cache 影响

会话生命周期内前缀稳定，因为每个桌面 Agent 都会在发布前加入同一个不可变 preset。工作区指令与模型选择沿用各自既有的缓存影响。

## 已知限制与延期工作

- **不支持用户 preset 或切换**——桌面第一版有意拒绝 `desktop-default` 以外的所有 preset；未来的清单设计必须继续保证 Host provider ownership 和覆盖所有入口的准入。
- **package resource 是清单权威**——桌面应用必须传入 `DESKTOP_PRESET_ROOT`；provider 不会把其他 `agent-presets` 配置改写成合规配置。
