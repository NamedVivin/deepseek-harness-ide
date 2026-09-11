# @deepseek-ai/dsh-client-ui-ide

[English](README.md) | 中文

限定在 Workspace 内的 IDE Client 插件。它向 root scope `shell.editor` slot 贡献编辑器面板，并向 root scope `conversation.header.utilities` slot 贡献纯图标编辑器操作。布局关闭编辑器列时，面板的 root store 仍然挂载，因此已打开标签、dirty buffer、保存状态与冲突恢复状态都会保留。该 header 操作在没有 Session 时也可用。空间足够时，编辑器与 conversation 占据相邻列，并由可拖动的分隔条分开；当折叠 sidebar rail 后仍无法保留两个面板的最小宽度时，编辑器会占用该 rail 旁的内容区域。900px 及以下的 viewport 始终采用这种独占形态。编辑器 header 提供关闭操作。

文件浏览器从标准 `useWorkspaces` 投影选择 Host 签发的 `WorkspaceId`，只把该 id 与规范化相对路径段传给 `ctx.remote.workspaceFiles`。它通过 Host 有界的 `list` 操作按需读取目录的直接子项，从不把 Client 可见的 Workspace 绝对路径当作文件权限。越界链接与不支持的文件系统对象保持不可操作。

该插件为 Agent 产出的位置注册 effect-scoped `ClientFileOpener` handler。它通过请求中的 session 找到已注册 Workspace，将完整的 `{ path, line? }` candidate 传给 Host `resolveLocation`，并且只接管受支持的普通文本文件。接管后，位置会通过同一个 root store 打开或复用标签、打开编辑器列，并在读取完成后定位到已校验的行；若需要离开 dirty Workspace，仍须明确选择保存、放弃或取消。未注册、被拒绝或不受支持的位置会向 owner-controlled carrier fallback 返回 `unhandled`；本包绝不调用任意路径打开器。

打开普通 UTF-8 文件时，会按 `(workspaceId, pathSegments)` 创建或复用标签。CodeMirror 6 编辑内存 buffer，按已挂载文件的扩展名启用常见语言解析器，支持 Cmd/Ctrl+S 与 Cmd/Ctrl+W，并把 buffer 保存在共享 root store 中。Markdown 标签可在源码与现有、经过清理的 `MarkdownText` 渲染管线之间切换；预览始终读取尚未保存的 buffer。由于还没有有界、Workspace-aware 的资源解析器，Workspace 相对图片暂不支持。

每次保存都会在调用 Host compare-and-swap 操作前，快照当前 buffer、不透明 base version 与单调递增的 local revision。确认回执会推进 base content 与 version，但只有期间没有更新编辑时才清除 dirty 状态。传输与策略失败会保留 buffer。发生 version conflict 时，界面会读取最新磁盘内容，将其与本地 buffer 同时保留，并明确提供三个操作：继续编辑、确认后重新加载已显示的磁盘版本、或以该已显示版本为基准对本地 buffer 再做一次 compare-and-swap。若期间再次写入，会再次产生冲突；不存在无条件覆盖操作。

关闭 dirty 标签或在存在 dirty 标签时切换 Workspace，都会提供明确的保存、放弃或取消对话框。关闭编辑器列返回会话界面不属于关闭标签，不会提示，也不会丢弃 buffer。首版的未保存 buffer 仅存在于进程内，进程崩溃时可能丢失。

`/client` 入口只导出 slot 注册所需的 `apply`、`inject`、共享 store factory，以及组合后的 props／inject face 类型。组件与 reducer helper 保持包内私有；测试通过 `./src/*` 直接导入。

## 模型体验

无，因为编辑器不添加 prompt section、工具、模型可见消息或 provider 输入。

#### KV Cache 影响

无。

## 已知限制与延期工作

- 首版只编辑已有的普通 UTF-8 文件，不支持创建、重命名、移动、删除、监听、全局搜索、Git UI 或交互式终端。
- 语言支持为常见 Web、JSON、Markdown、CSS、HTML 与 Python 文件提供语法解析，不包含 LSP 补全或诊断。
- 关闭编辑器列会保留临时标签状态，但崩溃恢复与持久草稿仍延期。
- dirty 标签提示覆盖标签关闭与 Workspace 切换；打包应用退出拦截属于 desktop shell 生命周期。
