# @deepseek-ai/dsh-host-workspace-files

[English](README.md) | 中文

面向 IDE 的工作区范围文件访问。`WorkspaceFilesGateway` 注册仅限 Host 的 `workspaceFiles` 服务，并发布四个 Typert Remote：`list`、`read`、`save` 和 `resolveLocation`。每个请求都从 Host 签发的 `WorkspaceId` 开始，通过 `ctx.workspaceRegistry` 解析当前 canonical root，再经部署已有的 `ctx.fs` provider 执行文件系统操作。Renderer 从不提供具有授权含义的 root path。

`list({ workspaceId, directory })` 接受相对路径 segment，并按稳定名称顺序返回全部直接子项。它调用 provider-side `listDirBounded()`，因此超大目录会在 provider 观察到超过 `maxDirectoryEntries` 的一个 entry 后失败，而不是 materialize 完整目录。canonical target 位于已注册 root 之外的 symbolic link 或等价 alias 会作为 inert `blocked` entry 返回。

`read({ workspaceId, path })` 接受指向现有常规文件的非空 segment path。Provider 把原始分配限制在 `maxTextFileBytes` 内；gateway 随后要求内容是有效 UTF-8，且 binary sample 不含 NUL byte。它在读取前捕获文件系统 metadata，读取后重新解析路径；只有 target identity 和 version 都没有变化时，才返回 content 与 opaque `WorkspaceFileVersion`。并发 mutation 会返回 `changed-during-read`，不会把旧 content 与新 version 配对。

`save({ workspaceId, path, content, expectedVersion })` 只能替换现有常规文件。它检查 UTF-8 byte size，在 mutation 前立即重新解析并围住 target，然后使用 `replaceIfVersion` 和显式 per-call policy `{ mode: 'workspace-write', workspaceRoot }` 调用 `ctx.fs.writeText()`。过期 version 返回 `version-conflict`。本服务没有无条件覆盖、force-save、文件创建、重命名或删除方法。

`resolveLocation({ workspaceId, location })` 是唯一接受 absolute 或 relative path candidate 的操作。它用于 model-facing `{ path, line? }` 值，把该值视为不可信输入：relative path 从已注册 root 解析，foreign path-family absolute form 与 canonical escape 会被拒绝；结果只包含 canonical relative segment、当前文件 kind、bounded-text eligibility 和可选且已校验的 one-based line。

Segment 操作拒绝空 component、`.`、`..`、NUL、内嵌 POSIX 或 Windows separator、drive-prefixed value、UNC spelling 和 absolute path。稳定 business failure 包括 `workspace-not-found`、`invalid-path`、`outside-workspace`、`not-found`、`not-directory`、`not-regular-file`、`not-text`、`too-large`、`permission-denied`、`changed-during-read` 和 `version-conflict`。Cancellation 与意外 provider fault 仍属于 infrastructure failure。

配置字段：

- `maxTextFileBytes` —— 单次读取或保存的 inclusive byte limit；默认 10 MiB。
- `maxDirectoryEntries` —— 单次完整 listing 的 inclusive direct-child limit；默认 10,000。

本包从 `./types` 导出 Client-safe payload type。Typert 在 `./typert` 生成 Host descriptor，在 `./remote` 生成 Client contribution；由被选中的 Client assembly 负责挂载该 generated contribution。

## 模型体验

无，因为这个 Host business Remote 不注册 prompt、tool、message 或 provider request。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **仅支持现有文本文件** —— 第一版不创建、重命名、删除、watch 或 search 文件。
- **没有文件系统 watcher** —— 变更通过 read revalidation 和 compare-and-swap save 检测；clean buffer 的 Client refresh 行为由 IDE 负责。
- **仅对协作进程提供 linearization** —— 编辑器和 Harness file-tool mutation 共享 provider 的 per-target lock。Shell 或外部应用的直接写入仍可能在最终 canonical check 与 operating-system mutation 之间竞态。
- **Canonical check 的残余竞态** —— gateway 会阻止 static alias，以及在最终 containment check 前完成的 replacement。它不承诺防止受信任本地进程在该检查后替换 ancestor 的 descriptor-relative protection。
