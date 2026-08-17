# host/ — GUI Host 能力

[English](README.md) | 中文

浏览器与打包桌面组合共享的 Host 侧 GUI 能力：传输无关的 API 网关、浏览器 HTTP 服务器、目录选择与 Workspace 访问。Client 包位于 [`client/`](../client/README.md)；[`apps/cli`](../../apps/cli/README.md) 组合 [`apps/web`](../../apps/web/) 中的源码 Web 应用，[`apps/desktop`](../../apps/desktop/README.md) 则组装打包应用。这些全是**产品**包。

| 包 | 职责 | ctx key |
|---|---|---|
| [`apiproxy/`](apiproxy/README.md) | 共享宿主 API 网关和协议约定 | `ctx.apiProxy` |
| [`webserver/`](webserver/README.md) | HTTP 路由载体 | `ctx.webServer` |
| [`frontend-static/`](frontend-static/README.md) | 占据 webserver 回退席位的 SPA dist 服务器 | 消费 `ctx.webServer` |
| [`directory-picker/`](directory-picker/README.md) | 工作区目录选择 seam | `ctx.directoryPicker` |
| [`directory-picker-native/`](directory-picker-native/README.md) | 原生目录选择器后端和浏览器交互 | 注册 `ctx.directoryPicker` |
| [`directory-picker-browse/`](directory-picker-browse/README.md) | 应用内目录浏览器后端和交互 | 注册 `ctx.directoryPicker` |
| [`directory-picker-electron/`](directory-picker-electron/README.md) | 桌面 sidecar 的 Electron main 目录选择器后端 | 注册 `ctx.directoryPicker` |
| [`directory-picker-auto/`](directory-picker-auto/README.md) | 宿主自适应选择器组合 | 挂载一个后端 |
| [`plugin-inventory/`](plugin-inventory/README.md) | 当前 Loader 条目的只读投影 | Remote `pluginInventory/list` |
| [`workspace-files/`](workspace-files/README.md) | 有界且限定工作区的 IDE 文件访问 | `ctx.workspaceFiles` |
| [`workspace-registration/`](workspace-registration/README.md) | Host 所有的原生选择与 Workspace 注册 | `ctx.workspaceRegistration` |

`apiproxy` 保持传输无关；[`client/connection`](../client/connection/README.md) 持有逻辑 Connection 行为，其 provider 包负责选择 Web 或 child IPC 交付。选择器实现可在共享 seam 后互相替换。

子系统参考：[web-server.md](../../docs/subsystems/web-server.md) 与 [workspace.md](../../docs/subsystems/workspace.md)（选择器 seam）。
