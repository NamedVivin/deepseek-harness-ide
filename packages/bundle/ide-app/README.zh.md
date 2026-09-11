# @deepseek-ai/dsh-ide-app

[English](README.md) | 中文

在 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app` 之上增加 IDE 能力的 profile patch layer。它会挂载 Host-owned 的有界 `workspaceFiles` Remote，并设置 10 MiB 文本限制和 10,000 entry 目录限制；随后挂载 `@deepseek-ai/dsh-client-ui-ide`，提供 Workspace 文件树、CodeMirror 编辑器、Markdown 预览、compare-and-swap 冲突界面，以及受支持 Agent 产出文件位置的内部 handler。

这个 bundle 刻意不选择 connection carrier 或 module-delivery provider。随附的源码 `ide` profile 组合 `[dsh-base, dsh-web-app, dsh-ide-app]`，因此浏览器开发使用 Web carrier。Desktop composition 会替换 carrier-specific row，而不改变这层 IDE capability。

本包没有 runtime API。其公开产物是 `package.json` 中由 `dsh.bundle.patch` 声明的 `cordis.patch.yml`。

## 模型体验

无，因为 Host/Client 工作区文件 capability 不注册 prompt、tool、message 或 provider request。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- Client 界面只编辑已有普通 UTF-8 文件；文件创建、文件系统监听、LSP 与未保存 buffer 的持久恢复仍延期。
- Desktop transport、native directory registration、preset admission 与 guardian subprocess ownership 不属于本 bundle，而由 desktop composition 负责。
