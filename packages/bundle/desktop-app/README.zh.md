# @deepseek-ai/dsh-desktop-app

[English](README.md) | 中文

在 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 与 `@deepseek-ai/dsh-ide-app` 之上的打包桌面 patch layer。它保留 carrier-neutral 的 connection 与 Client module graph，把物理 provider 替换为 child IPC 和不可变 `dsh-app://` 交付，把原生目录选择器替换为 Electron main bridge，并把直接本地子进程创建替换为 guardian ownership。Web startup、HTTP serving、Web runtime delivery、Client HMR 与动态 Cordis authoring 都会禁用，因此组装后的桌面 Host 不会打开监听端口，也不会执行运行时提供的 Client 代码。

这一层挂载 Host-owned 的 Workspace registration Remote 及其桌面 Client flow。它还会把 `agent-presets` 固定到 package-owned 的 `desktop-default` roster，禁用用户 root 与 authoring，安装桌面 admission provider，并隐藏 preset 切换。Node sidecar 会在 Loader 激活前提供 `desktopRuntime.presetRoot`；renderer 的任何值都不能选择这条路径。

本包没有 runtime API。其公开产物是 `package.json` 中由 `dsh.bundle.patch` 声明的 `cordis.patch.yml`。

## 模型体验

通过固定的 `desktop-default` preset 及其文件系统和 shell consumer 间接影响。

#### KV Cache 影响

固定 preset 让桌面 session 之间的工具与 instruction roster 保持稳定。Workspace 特定的 runtime context 仍会正常变化。

## 已知限制与暂缓事项

- 第一版桌面应用不暴露用户自定义 preset、preset 切换、交互式终端或第三方 Client bundle。
- 签名、公证、installer 构建与原生目标 smoke test 属于 `apps/desktop` 和 release workflow，而不是这个 patch carrier。
