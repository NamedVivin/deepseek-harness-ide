# Agent Note: 可打包的跨平台桌面 IDE

Status: proposed

[English](2026-08-14-packaged-cross-platform-desktop-ide.md) | 中文

## 问题

DeepSeek Harness 已提供交互式 Web 应用和 headless 应用，但还没有可安装的桌面 IDE。Web 应用需要存活的 Host 进程，目前也会把工作区文件操作交给操作系统，而不是在应用内打开文件。静态 renderer bundle 本身无法提供 agent（智能体）执行、文件系统访问、会话持久化、设置或凭据。

第一版桌面应用必须在 macOS 和 Windows 上运行，不要求系统安装 Node.js 或 pnpm，也不要求用户持续打开终端或本地 HTTP server。它必须可靠地编辑现有文本、源代码和 Markdown 文件；在 Markdown 源码与预览之间切换；使用平台快捷键保存；在 agent 和用户同时编辑同一文件时防止静默覆盖；并在内部编辑器打开 agent 生成的文件。

这项工作涉及桌面 carrier、工作区范围的文件能力、Client 插件、profile 组合、原生运行时打包、签名和已安装产物测试。把它当作静态 Web 构建或单一 UI 组件，会遗漏特权 Host 行为和分发生命周期的定义。

## 提案

新增一个打包后的 Electron 应用，复用现有 Web Client 和 Host 插件图，同时用本地资源协议和窄 IPC carrier 替换 Web server 与浏览器传输。Electron 负责窗口和应用生命周期。随应用打包的纯 Node.js 24 sidecar 负责 Cordis、agent 运行时、文件系统服务、子进程、持久化、设置和凭据。Electron Forge 按受支持的操作系统和架构分别打包并签名产物。

打包后的应用不监听端口，也不需要单独管理 server。源码开发仍可通过 `ide` profile 使用现有 Web carrier，但安装产物只使用桌面 carrier。

### 第一版产品约定

| 能力 | 必需行为 |
| --- | --- |
| 文本和代码 | 浏览已注册工作区，在 tab 中打开现有常规 UTF-8 文件，编辑 buffer，并在切换文件时保留未保存的 tab 状态。 |
| Markdown | 编辑 `.md` 和 `.markdown` 源码，并在当前 tab 中切换源码和基于当前未保存 buffer 渲染的预览。 |
| 保存 | 在 macOS 上处理 `Meta+S`，在 Windows 上处理 `Control+S`；Host 确认持久写入后再清除 dirty 状态；失败后保持 buffer 为 dirty。 |
| 并发编辑 | 把用户保存与通过 Harness 文件工具执行的 Agent 编辑串行化；根据读取时返回的版本保存；版本过期时保留用户 buffer；展示当前磁盘内容和 diff；在该 Host-mediated 路径中永不静默覆盖。 |
| Agent 生成的文件 | 把现有工具位置、deliverable chip 和内联文件提及路由到桌面编辑器，复用已打开的 tab，并在 IDE 界面中显示该文件。 |

第一版只编辑现有文件。创建、删除、重命名、移动、复制、文件系统 watch、全局搜索、Git UI、交互式终端、完整的语言服务器补全和诊断、WYSIWYG Markdown、PDF 或 DOCX 编辑、远程 Web IDE 访问、第三方桌面 Client 插件、用户自定义桌面 Agent preset 和应用内 preset 切换均不在本次范围内。

### 包和 profile 拓扑

| Workspace | 职责 |
| --- | --- |
| `packages/fs/fs` 和每个 provider | 新增必需的 provider-side `listDirBounded`，且不允许无界 fallback；local、E2B、sandbox、invariant、fixture 和 test provider 一起迁移。 |
| `packages/host/workspace-files` | 基于 `ctx.fs` 定义工作区范围的 `list`、`read`、版本化 `save` 和由 Host 掌权的 `resolveLocation` 操作。 |
| `packages/client/ui-ide` | 提供文件树、编辑器 tab、CodeMirror 6 集成、Markdown 预览、dirty 状态、保存流程、冲突 UI 和桌面文件 opener。 |
| `packages/client/ui-conversation` | 通过异步 opener 路由完整 Agent 文件位置，并要求 desktop carrier 创建 session 时选择已注册工作区。 |
| `packages/api/remotes` | 挂载并重新导出生成的工作区文件 business Remote contribution。 |
| `packages/client/connection` | 保留现有 Client graph identity，同时成为 carrier-neutral connection contract、request router、event multiplexer 和 Client consumer。 |
| `packages/client/connection-web` 和 `packages/client/connection-desktop` | 在独立的 `connection-transport` row 下，为同一个 connection contract 提供互斥的 HTTP/WebSocket transport 和 child-IPC transport。 |
| `packages/client/modules` | 保留 manifest discovery 和现有 Client module graph，同时把 asset delivery 移到 provider interface 后。 |
| `packages/client/modules-web` 和 `packages/client/modules-desktop` | 在独立的 `module-delivery` row 下，分别通过 `/plugins/*` 或不可变 `dsh-app://plugins/*` URL 交付 Client bundle。 |
| `packages/host/directory-picker-electron` | 通过把 Host 发起的请求从 sidecar 转发到 Electron main，实现现有 directory-picker capability。 |
| `packages/host/workspace-registration` | 提供 user-paced BFF Remote，调用 directory picker 并注册其结果，不返回带权限的 path。 |
| `packages/client/ui-directory-picker-desktop` | 使用 Host-owned registration call 填充现有 workspace directory-flow slot，并把已注册 workspace 返回给 slot owner。 |
| `packages/preset/agent-presets-desktop` | 提供不可变的 `desktop-default` roster，以及在每个 preset resolve、mount、recompose、standing-key、resume 和 fork 入口前运行的 Host admission contribution。 |
| `packages/subprocess/subprocess` 和 `packages/subprocess/subprocess-pty` | 把普通 `ctx.subprocess.spawn()` 改为返回 `Promise<SubprocessHandle>` 并迁移每个 provider 和 consumer；把 `spawnTerminal()` 移到独立的 `ctx.subprocessPty` Service Definition 和 Consumer 约定。 |
| `packages/subprocess/subprocess-collector` | 负责 local 和 guardian subprocess provider 共享的 provider-neutral 有界尾部、可选 spill、offset reader、drain 和 finalization 实现。 |
| `packages/subprocess/subprocess-pty-local` | 通过 `node-pty` 提供 `ctx.subprocessPty`，作为桌面 profile 忽略的可选本地 provider。 |
| `packages/subprocess/subprocess-guardian` | 把 executable resolution、spawn、stdio、signal 和 wait request 转发给桌面 runtime guardian，从而提供普通 `ctx.subprocess` 操作。 |
| `packages/bundle/ide-app` | 添加工作区文件 Host provider 和 IDE Client 插件，不选择 carrier。 |
| `packages/bundle/desktop-app` | 选择桌面 connection、module-delivery、directory-picker、preset-policy 和 guardian-subprocess provider，并禁用对应的 Web、Koffi-picker 和 direct-local provider。 |
| `apps/desktop` | 负责 Electron main 和 preload 代码、Node sidecar 与 guardian 生命周期、固定的 macOS process-capsule helper、不可变的 desktop-safe preset roster、Forge 配置、图标、entitlement、签名 hook 和打包产物测试。 |

新增名为 `ide` 的随附源码开发模板，内容为 `[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, @deepseek-ai/dsh-ide-app]`，并把 IDE bundle 加入 CLI 依赖闭包。这样 `dsh --profile ide` 会成为有效的浏览器开发入口，而不是依赖隐式自定义 profile。

桌面可执行程序直接启动 `[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, @deepseek-ai/dsh-ide-app, @deepseek-ai/dsh-desktop-app]`。Carrier refactor 保持 row `connection` 映射到 `@deepseek-ai/dsh-client-connection`，保持 row `modules` 映射到 `@deepseek-ai/dsh-client-modules`；这些稳定 core row 继续负责 Client graph injection、`ctx.connection.rpc`、`ClientModuleSystem` 和 `__DSH_MODULES__` bootstrap exception。Web bundle 在 row `connection-transport` 选择 `@deepseek-ai/dsh-client-connection-web`，在 row `module-delivery` 选择 `@deepseek-ai/dsh-client-modules-web`。Desktop patch 禁用真实的 `web-startup`、`webserver`、`web-runtime` 和 `client-hmr` row；`frontend-static` 是 `web-runtime` 的 child，不是独立 row。它只把 `connection-transport` 和 `module-delivery` 替换为对应 desktop provider，把 row `directory-picker` 替换为 `@deepseek-ai/dsh-host-directory-picker-electron`，把 base row `subprocess` 替换为 `@deepseek-ai/dsh-subprocess-guardian`，再插入 workspace registration、desktop directory-flow、`agent-presets-desktop` admission 与 roster 以及 IDE row。因此 ApiProxy unary call、Typert interceptor、`events.mux` 和 `events.host` downlink stream 保留同一个 dispatch graph。每种 carrier capability 启动时必须有一个 core 和恰好一个 provider，同时必须恰好有一个 desktop preset-admission contribution，且不得存在 user preset root。

桌面 transport 使用显式的 Host-side method allowlist。它拒绝 renderer 提供的旧 `workspace.create({ path })`、直接 `host.pickDirectory`、`host.openPath({ path })` 和 `agentPreset.select`。它把 `session.create` 收窄为 `{ workspaceId, sessionId?, agentPreset? }`：`workspaceId` 必填，禁止 `cwd`，`agentPreset` 只能省略或恰好为 `desktop-default`，两个权限字段都省略时也绝不 fallback 到 Host 默认目录。Desktop conversation flow 要求存在 active registered workspace，并发送其 `WorkspaceId`；底层 Host 方法会通过权威 registry 解析该标识符，并应用 desktop preset admission，然后才可能创建目录或启动 Agent。Desktop directory-flow contribution 调用 `workspaceRegistration.pickAndRegister()`；Host BFF 调用 `ctx.directoryPicker`，canonicalize 并注册选中的 root，只返回最终 workspace view。该 Remote 不使用固定 unary deadline，因为 dialog 由用户掌控节奏。Caller cancellation 或 renderer destruction 会中止 BFF，并让 Electron main 丢弃 chooser 稍后返回的结果；文档不承诺以编程方式关闭原生 chooser，因为 Electron 的 [`showOpenDialog`](https://www.electronjs.org/docs/latest/api/dialog)不暴露 abort handle。

扩展现有 directory-flow owner，新增 `onRegistered(workspace)` 结果。Desktop contribution 直接使用该结果；Web native 和 browse contribution 保留现有 `onPicked(path)` flow 和 Client-side create call。每个 directory-flow slot 恰好由一个 contribution 占用。

`apps/desktop` 通过 app-boot configuration 打包并注入自己的 shipped preset root，把省略 preset 时的默认值设为 `desktop-default`；它不依赖 CLI launcher 的 `SHIPPED_PRESET_ROOT`。第一版 roster 只包含 `desktop-default`：继承 root Host 的 `ctx.fs` 和 guardian-backed `ctx.subprocess`，挂载普通文件系统与 shell tool consumer，既不包含 PTY consumer，也不包含嵌套 filesystem 或 subprocess provider。CLI `minimal` preset 和用户 preset root 均不暴露，因为它们可能挂载 persistent-terminal 行为或隔离的 filesystem 和 subprocess provider。

在 `agent-presets` 中新增 preset-admission extension point，并在每个 resolve、mount、recompose、`standingKeyFor`、cold transcript ensure、create、resume 和 fork path 前调用；composed generation 会携带已执行 admission 的证明，因此 `composeFrom` 不能接受未验证 generation。Desktop contribution 只准入 `desktop-default`，桌面 UI 隐藏切换入口。Raw `agentPreset.select` 会被原子拒绝，当前 preset 不变。已记录的不支持 preset 会返回稳定的 `desktop-preset-unsupported` metadata，不会先挂载任何 provider 或启动 Agent；此类 session 仍可通过 Web/headless carrier 使用。

`desktop-default` 继承 `workspaceFiles` 使用的同一个 root filesystem service instance，因此 Agent file-tool save 和 editor save 共享同一个 per-target lock 与版本权威。它的 filesystem tool consumer 和 policy 不能替换 desktop-owned provider。该不可变第一版 roster 让 PTY 缺失、guardian ownership 和跨界面冲突保证成为每个 desktop Agent graph 的属性，而不是对任意 user composition 的 best-effort validation。

IDE 通过 `shell.overlay` 注册根作用域界面，并在现有 `sidebar.footer.action` slot 中注册 action。与 `conversation.view` 不同，该界面可在会话创建前使用；用户返回现有 conversation UI 时，它也能保留 tab。无需替换根 shell。

### 桌面运行时和 IPC

桌面应用采用以下生命周期：

1. 在 Windows 上，Electron 在获取单实例锁或启动 sidecar 之前处理每个 `--squirrel-*` 生命周期 event，包括 install、update、uninstall 和 obsolete，只执行所请求的生命周期工作，然后退出。
2. Electron 获取单实例锁，解析已签名资源目录和用户数据目录，并启动随应用打包的 runtime guardian。Guardian 使用明确的桌面组合和私有 IPC channel 启动纯 Node.js sidecar。
3. Sidecar 启动 Cordis，并通过 child IPC 返回与 Web Client 相同的 `BootManifest`，其中 bundle URL 为不可变的 `dsh-app://plugins/<id>/client.js?rev=<revision>`，同时返回 ready 状态或启动失败。它绝不监听 TCP。
4. Electron 为已签名 renderer 资源和 manifest allowlist 中的第一方 Client bundle 注册只读 `dsh-app://` 协议。固定且已签名的 desktop bootloader 先等待 `invoke('desktop.bootManifest')`，验证共享 manifest，在 renderer main world 赋值 `window.__DSH_BOOT__`，然后才动态 import 现有 shell。现有 `ClientModuleSystem.loadBundle()` 把 plugin URL 作为 classic script 加载，每个 bundle 必须完成现有 module-factory registration check。
5. 沙箱化 preload 只暴露带版本的 `invoke` 和 `subscribe` 方法。每个 invocation 和 subscription 都有标识符、dispose message 和 abort path；renderer destruction、timeout 或 transport loss 会中止对应 Host `AbortSignal` 并拒绝 pending call。Renderer 到 main 的 body 使用 transferred Electron MessagePort。Electron main 把它转换为带版本的 JSON child IPC，使随应用打包的 Node guardian 不会消费 Electron 的 V8 专用 structured-clone 格式。二进制 body chunk 使用带声明长度和配置字节上限、字段集合精确的规范 base64 envelope；guardian 恢复语义字节后，再通过 advanced serialization 转发给使用同一 Node 运行时的 sidecar。带 sequence 的协议仍携带 acknowledgement、end 和 cancel frame。`DesktopApiClient` 通过 `invoke` 实现现有抽象 fetch transport；桌面 provider 把请求 dispatch 到 `ctx.connection.rpc`，并通过 `subscribe` 传递两个 Host event stream。
6. 应用退出时先请求 Cordis dispose，并等待有界的优雅关闭。如果 sidecar hang 或 crash，guardian 会在 Electron 退出前 kill 并 join 其已注册进程树。最后一个窗口关闭后，不得残留 child、worker、subprocess 或 persistent terminal。

启用 `contextIsolation: true`、`nodeIntegration: false`、renderer 沙箱、`webSecurity: true` 和严格的 Content Security Policy；拒绝任意导航和窗口创建；每个 IPC handler 都验证 sender；preload 和 sidecar 边界都执行类型化 wire validation。Renderer 不会获得 Node.js、Electron、绝对资源路径、凭据或通用进程执行 API。这遵循 Electron 当前的[安全指南](https://www.electronjs.org/docs/latest/tutorial/security)，同时保留仓库延后的零端口 Electron 方向。

Host 在随应用打包的纯 Node.js 可执行程序下运行，而不是在 Electron main 进程中运行。这样 `process.execPath`、Node engine 行为、原生 addon ABI 选择、进程检查和子进程清理都与现有 Host 假设一致。固定的 Node.js 构建必须满足仓库 engine 下限。

Guardian protocol 是 desktop composition 中唯一的 generic process-creation authority。Subprocess capability 把普通 `spawn()` 改为返回 `Promise<SubprocessHandle>`，每个 local、E2B、fixture、invariant 和 tool consumer 都迁移到异步结果。`subprocess-guardian` sidecar provider 把 spawn specification 发送给 guardian。在 Windows 上，每次 spawn 都获得独立的 kill-on-close Job Object：guardian 创建 suspended process，把它分配给该 handle 专属 Job，完成 stdio 与 ownership registration，然后才恢复执行。Handle termination 只影响该 Job，`waitForExit()` 等待其 active-process count 归零，guardian failure 则关闭所有保留的 Job handle，以终止全部 managed tree。在 macOS 上，Electron main 先把固定且已签名的 process-capsule helper 作为唯一 process-group leader 启动并记录，然后它才可以接收 target specification；该 helper 不接受 renderer call，main 也不能向它提供 executable path。Guardian 把 target specification 交给 capsule，由 capsule 在已经镜像的 process group 内创建 stopped child。Capsule 向 guardian 和 Electron main 同时报告 child PID 并确认 PGID，等待双方确认 ownership，然后才恢复 target。Guardian 返回包含真实 PID 的 spawn acknowledgement，provider 随后才 resolve handle；它绝不伪造 PID `-1` 或尚未被掌控的 handle。

Guardian provider 保留 `SubprocessSpawnSpec` 的每一种 stdio disposition。Pipe mode 暴露 Node `Readable` 和 `Writable` proxy。Inherit mode 把诊断 relay 到匹配的 sidecar descriptor。Collect mode 把 stdout 或 stderr 的精确 byte 喂给从 `subprocess-local` 抽出的 provider-neutral collector；在 sidecar 安装所请求的 pipe 或 collector 并确认 stream ready 前，capsule 不会恢复 target。共享 collector 保留独立的同步 `readFrom(fullStreamByteOffset)` reader、有界 tail、`lossy` 与 `truncated` fact、可选完整 `spillPath`、私有 spill 权限和 cap、settlement 前 drain，以及退出后可读性。Transport 或最终 close 失败时，不会把不完整 spill 宣称为完整路径。

`subprocess-guardian.resolveExecutable()` 在 guardian execution world 中运行，并保留现有 capability 规则：拒绝空名称；验证并 canonicalize 绝对路径且要求其可执行；根据 scrubbed guardian PATH 和显式 environment override 解析 bare name；拒绝包含 separator 的相对名称；明确报告 not found；传播 cancellation。Capsule resume 前，spawn 会再次验证返回的 executable，应用现有 scrubbed child environment 以及显式 override 和 tombstone，绝不继承 Electron-only entry。Provider 不 fallback 到 Electron environment，也不在 renderer 中解析。

Stdin、stdout 和 stderr 使用相同的带 sequence child-IPC framing，并携带 process 与 file-descriptor 标识符、有界 chunk、acknowledgement 和 hop-wide credit pool。Credit 耗尽时暂停 guardian pipe read，每次 stdin write 仅在得到 acknowledgement 后完成，end、error、signal、wait、collector finalization 和 cancellation 状态都恰好传播一次。在 macOS 上，每个 capsule 都监视 guardian 和 main 的 liveness pipe：guardian 丢失时 capsule 会 kill 并 join 自己的 group；capsule 丢失时 Electron main 使用只读 ownership mirror kill 并 join 已记录的 PGID。该第二所有者覆盖 resume 后的 guardian failure，sidecar hang 或 crash 时则仍由 capsule 负责。Load-time invariant 要求 desktop `subprocess` row 使用 guardian provider，并拒绝 desktop composition 中的任何 direct local spawn provider。

桌面 module-delivery provider 是 Web `/plugins/*` 交付的唯一替代；不存在 preload module-execution path。第一版打包一组封闭且已签名的第一方 Client 插件。Sidecar 在共享 manifest 中提供标识符、revision、injection 和加载时机，Electron 把每个允许的 URL 映射到不可变打包资源。当用户安装的 Host-only 插件不需要 renderer 代码时，仍可支持它们；第三方桌面 Client 插件加载需要单独的信任和签名设计。

Electron directory-picker provider 实现现有 Host capability，而不是暴露 renderer shortcut。Workspace UI 调用 `workspaceRegistration.pickAndRegister()`；该 Host 操作调用 capability，sidecar provider 通过 child IPC 发送类型化 Host-initiated request，Electron main 打开原生 dialog。选中的 path 只返回给仍存活的 Host 操作。Cancellation 会把 request 标记为 terminal，并丢弃延迟结果而不注册工作区；parent-window destruction 遵循平台 chooser 行为，不假设存在 close API。

### 工作区文件服务

把 `WorkspaceFilesGateway` 实现为由 workspace registry 和 `ctx.fs` 支持的 Typert business Remote。普通文件操作使用 branded `WorkspaceId` 和相对路径 segment 数组标识文件。只有 `resolveLocation` 接受绝对或相对 candidate，因为现有 model-facing `FileLocation.path` 可能是绝对路径。

| 操作 | 结果 |
| --- | --- |
| `workspaceFiles.list({ workspaceId, directory })` | 返回 canonical 相对目录和稳定 entry，字段包括 `name`、`segments`、`kind` 和可选 `size`。指向工作区外的 link 显示为 blocked，且不可遍历。 |
| `workspaceFiles.read({ workspaceId, path })` | 返回现有常规 UTF-8 文件的 `content` 和 opaque `WorkspaceFileVersion`。 |
| `workspaceFiles.save({ workspaceId, path, content, expectedVersion })` | 在 Host provider 的 target lock 下，仅当 `expectedVersion` 仍匹配时替换文件，返回新版本或明确的 `version-conflict` 结果。 |
| `workspaceFiles.resolveLocation({ workspaceId, location })` | 按需相对于工作区 root 解析 `{ path, line? }` candidate，在 Host 中强制 canonical containment，并返回 canonical path segment、文件 kind、文本支持状态和可选 line。 |

`WorkspaceFileVersion` 是 branded wire string，Host 在不解析它的情况下与 `FsVersion` 相互映射。服务不暴露 blind replace 或 force-write 操作。明确的冲突解决操作会先读取最新版本，再执行一次 compare-and-swap 保存；期间再次发生变化会再次产生冲突。

可靠冲突保证覆盖 accepted desktop preset 中的编辑器保存和通过 Harness 文件系统工具执行的 Agent mutation，因为两者继承同一个 root provider instance，并共享其 per-target lock 和版本检查。Shell command 或外部应用的直接写入属于不合作的跨进程 mutation：普通版本检查会检测 probe-to-replace 窄竞态之外的变化，但现有文件系统 seam 不承诺跨进程 linearizable compare-and-swap。UI 不得把该残余情况描述为已保证。

每个操作都通过权威 registry 解析 `WorkspaceId`，重新解析 canonical 工作区 root 和 target，并用 `ctx.fs.contains()` 证明包含关系。基于 segment 的操作拒绝空 segment、`.`、`..`、NUL、内嵌分隔符、Windows drive path 和 UNC path。`resolveLocation` 把 candidate 视为不可信输入，把相对 candidate 基于 `workspace.path` 解析，并拒绝逃逸 canonical root 的大小写 alias、symlink 或 junction target。保存会在原子写入前立即再次执行 canonical resolution 和 containment。

读取会在有界 stream 前捕获文件版本，解码后再次捕获，仅在两个版本匹配时返回内容。并发 mutation 会产生 `changed-during-read`，绝不会返回搭配新版本的旧内容。保存委托给带有 `replaceIfVersion` 和显式 per-call policy `{ mode: 'workspace-write', workspaceRoot: workspace.path }` 的 `ctx.fs.writeText()`；不会直接调用 `node:fs`，也不会继承 deployment fallback root。

扩展文件系统 Service Definition，新增必需的 `listDirBounded(path, { maxEntries })`。所有随附的 local、E2B、sandbox、invariant、fixture 和 test provider 都必须在读取 `maxEntries + 1` 个 entry 时停止并返回 `too-large`，不得委托给无界 `listDir()`；限制内的目录会在返回前排序。任何默认实现都不得 materialize 完整目录。

Config 负责 `maxTextFileBytes`、`maxDirectoryEntries`、`maxDesktopBodyBytes`、`maxDesktopChunkBytes` 和 `maxDesktopInflightBytes`；建议默认值为 10 MiB、10,000 个 entry、160 MiB、1 MiB 和 16 MiB。桌面 connection 会把 request、response 和 downlink-event body 编码为 UTF-8。Renderer 到 main 使用 request 或 subscription scoped Electron MessagePort stream 和有界 `Uint8Array` chunk。Main 到 guardian 使用带版本的 JSON control frame 和有界规范 base64 二进制 envelope；guardian 到 sidecar 只在相同的随应用打包 Node 运行时之间使用 advanced serialization。两段 child-IPC 都保留带 sequence 和 acknowledgement 的协议及有界 in-flight window。`invoke` 和 `subscribe` 只携带 control metadata 和 stream handle。每个 physical hop 都会累计 body 大小、实施 backpressure、传播 cancellation 和 disconnect，并在超过 `maxDesktopBodyBytes` 时拒绝。所有并发 body 在每一跳共享一个 credit pool，把 queued 和 unacknowledged byte 限制在 `maxDesktopInflightBytes` 内，而不会让 per-stream window 随 call 数量倍增。除非 total body limit 覆盖现有 prompt/attachment body 约定以及 `maxTextFileBytes` 最坏情况的 JSON escaping，并且 chunk 与 in-flight limit 形成非零 credit window，否则启动失败；测试包含当前 100 MiB 聚合图片请求和 10 MiB 全部需要 escaping 的文本 buffer。Host 还会在完整 Host allocation 前独立中止过大的文件读取，并在文件系统写入前拒绝过大的保存。这些限制不会阻止编辑器分配当前 buffer。

稳定 business failure 包括 `workspace-not-found`、`invalid-path`、`outside-workspace`、`not-found`、`not-directory`、`not-regular-file`、`not-text`、`too-large`、`permission-denied`、`changed-during-read` 和 `version-conflict`。传输和生命周期失败仍是 infrastructure error。

Canonical re-resolution 能阻止静态逃逸和在最终 containment fence 前完成的替换。现有文件系统 threat model 仍接受以下残余竞态：受信任本地进程在最终检查与操作系统 syscall 之间替换 ancestor；本提案不声称提供 descriptor-relative 或 handle-relative containment。

### 编辑器行为

第一版使用 CodeMirror 6，并按需加载语言支持。Tab identity 为 `(workspaceId, pathSegments)`。每个 tab 保留 `baseContent`、`baseVersion`、当前 buffer 内容、单调递增的本地 revision、dirty 状态和保存状态。切换 tab 或打开 conversation 界面不得丢弃这些状态。

Markdown 源码和预览是同一内存 buffer 的两个 view。预览复用现有 `MarkdownText` pipeline 提供 GFM、数学公式和语法高亮。Raw HTML、`file:` link 和任意本地路径保持 inert。在实现有界且能感知工作区的资源 resolver 前，延后支持工作区相对图片。

保存命令在调用时 snapshot 内容、base version 和本地 revision。只有 Host 确认写入且当前本地 revision 仍等于提交的 revision 时，tab 才清除 dirty 状态。如果用户在保存期间继续输入，已确认内容和返回版本会成为新 base，但更新后的 buffer 仍保持 dirty。IPC、policy、磁盘或关闭失败会保留 buffer 并提供重试操作。

发生 `version-conflict` 时，编辑器保留本地 buffer，读取最新磁盘内容，并展示本地与磁盘差异以及三个明确操作：继续编辑、从磁盘重新加载、覆盖显示的最新版本。本地存在更改时，重新加载需要确认。覆盖会针对所显示的磁盘版本执行新的 compare-and-swap，因此仍可再次冲突；不存在无条件写入路径。

能够标识已打开文件的 Agent mutation event，可以刷新 clean tab，或立即为 dirty tab 显示冲突状态。对于竞态、来自外部应用的更改以及未通过 event 观察到的 mutation，版本化保存仍是最终权威。第一版不要求文件系统 watch。

关闭 dirty tab、在存在 dirty tab 时切换工作区或退出应用，都需要明确选择保存、丢弃或取消。第一版发生 crash 时可能丢失未保存 buffer；durable draft recovery 是后续功能，不得把它暗示为 session persistence 的一部分。

### Agent 生成文件的交接

新增 effect-scoped asynchronous Client file-opener arbiter：`tryOpen({ sessionId, location }): Promise<'handled' | 'unhandled'>`。把 conversation owner action 从 `openFile(path: string): void` 改为 awaited `openFile(location: FileLocation): Promise<void>`，并让 tool row、生成文件位置、deliverable chip 和 inline mention 保留完整 `{ path, line? }` 值。所有内部 handler 都返回 `unhandled` 后，owner 调用 carrier-scoped fallback：Web 使用现有 operating-system opener，desktop 则报告不支持或工作区外位置，不调用任意路径 API。

桌面 handler 把 session 映射到已注册工作区并调用 `workspaceFiles.resolveLocation`；只有 Host 能把绝对或相对 model-facing path 转换为 canonical segment。Handled text location 会打开或复用匹配 tab、显示 IDE overlay，并在读取后定位可选 line。不支持的文件、目录、工作区外路径和未注册位置在 desktop profile 中只显示 inert diagnostic，不会到达任何操作系统 opener。这样，即使 renderer 被攻破，也不能把工作区内的 script、可执行文件、shortcut 或 application bundle 变成进程执行入口。

Web profile 保留当前使用操作系统打开的行为。内部编辑是桌面/IDE profile contribution，而不是对工作区 link 或 conversation UI 的全局更改。

### 打包和发布矩阵

使用 Electron Forge，并固定 Electron、Forge、maker、Node.js 和原生依赖版本。Forge 的 `package` 和 `make` 阶段通过确定性的 Host deploy assembly 和产物验证进行扩展；Forge 不会替代仓库的 TypeScript、Web、Cordis 或 release-family 构建。

| 目标 | 必需产物 | 发布门禁 |
| --- | --- | --- |
| macOS arm64 | `.dmg` 和包含已使用 Developer ID 签名、公证并 staple 的 `.app` 的 `.zip` | 原生 Apple Silicon runner；hardened runtime；嵌套签名验证；DMG 公证和 stapling；在干净账户中冷启动。 |
| macOS x64 | `.dmg` 和包含已使用 Developer ID 签名、公证并 staple 的 `.app` 的 `.zip` | 原生 Intel runner；相同的签名、公证和冷启动检查；不执行未经验证的 universal merge。 |
| Windows x64 | 使用 Authenticode 签名并加时间戳的 Squirrel `Setup.exe`，以及来自已签名应用目录的 portable `.zip` | 原生 Windows runner；验证 Setup、安装目录和 ZIP 内容签名；执行安装、启动、升级、卸载和 portable 启动检查。 |
| Windows arm64 | 延后 | 在原生依赖、签名和完整打包 smoke 未在原生硬件通过前，不声明支持。 |

Electron Forge 通常为当前平台和架构打包，并建议跨平台发布使用原生 CI。因此，发布 workflow 在 macOS 上构建 macOS 产物，在 Windows 上构建 Windows 产物，而不把交叉编译目录当作可发布产品。`.dmg`、Squirrel installer 和 ZIP maker 都显式配置；在出现企业部署需求前延后 MSI。Squirrel 的 `*-full.nupkg` 和 `RELEASES` output 作为经过验证的构建中间产物，但在自动更新进入范围前不发布。

打包资源树包含 Electron、固定版本的纯 Node.js 24 runtime、构建后的 Host deployment、desktop-safe preset roster、已签名 renderer 资源、第一方 Client bundle、worker 文件、语言和字体 chunk、license，以及已解析依赖图中的每个目标平台原生 module 或可执行文件。Electron main 和 preload 不依赖原生 addon。纯 Node sidecar closure 会单独针对 Node.js 24、目标操作系统和架构安装，排除在 Forge 的 Electron-ABI rebuild 之外，并在 Electron rebuild 后、最终签名前复制到资源目录。当 Node module resolution、动态加载、worker 或可执行权限需要真实文件时，Host deployment 保持在 ASAR 外部。

从 `SubprocessRuntime` 移除 `spawnTerminal()`，把它移到独立的 `SubprocessPtyRuntime` service。Terminal consumer 注入 `ctx.subprocessPty`，Web/local composition 挂载 `subprocess-pty-local`，其唯一原生 runtime 依赖是 `node-pty`。Desktop profile 忽略该 provider 并禁用 persistent-terminal consumer，因此其已解析 deploy graph 不包含 `node-pty` 或 macOS spawn helper；如果意外启用 PTY consumer，缺失的 required service 会使加载明确失败。普通 agent shell 命令仍可通过 guardian-backed macOS bash 和 Windows PowerShell provider 使用。Windows 打包验证基于 Koffi 的 guardian Job Object、ACL 和原子 JSONL 路径，但禁用 Koffi directory picker，改用 Electron provider。各平台使用随应用打包的 Node.js 可执行程序加载每个 sidecar `.node` payload，并单独探测 Sharp、ripgrep、worker-thread 和其他已解析的原生或可执行 payload。macOS 或 Windows 产物不包含 Landlock payload。

`apps/desktop` 保持为现有 `dsh` npm release family 的非 private member，并遵循其 version、pack、verification、publication 和 tag sequence。Forge installer 和 archive 是附加到同一 release tag 的非 npm asset。可变状态绝不位于应用目录内。Windows Squirrel 安装、升级和卸载，以及 macOS 复制、替换和移除 `.app`，都必须保留 `DSH_HOME`、已注册工作区、session、setting 和 credential。自动更新交付延后，但用较新的已签名应用替换旧版本属于发布阻断 smoke test。

### 安全和数据保护

打包后的 renderer 不具备特权。所有工作区访问、agent 操作和进程工作都通过带配置 aggregate-body limit、chunk limit 和 sender 验证的类型化 request/event IPC 方法。目录 dialog 使用类型化 sidecar-to-main capability request。应用只加载已打包本地内容，拒绝非预期协议和导航，也绝不把工作区文档作为 renderer 代码执行。

工作区和 session 权限以 Host-owned registration 签发的 `WorkspaceId` 为根，而不是 renderer 提供的绝对路径或默认 cwd。Host 在每个请求上强制 canonical containment、symlink 和 junction 检查、常规文件检查、大小限制、UTF-8 解码、sandbox policy 和版本化写入。桌面 method allowlist 阻止 raw root registration、基于 cwd 或无权限字段的 session 创建，以及任意外部打开；Renderer 检查可改善诊断，但不会授予权限。

Markdown 预览保留现有 sanitizer 和 URL policy。冲突恢复会同时保留用户 buffer 和最新磁盘文本，直到用户选择操作。任何 autosave、reload、Agent event、installer 操作或 shutdown 路径都不得静默丢弃 dirty buffer 或覆盖更新的文件版本。

签名 credential 保持为 CI secret。打包产物验证会在发布前枚举并验证嵌套可执行文件、原生 module、helper 和应用资源。第三方 notice 除 npm package 外，还覆盖 Electron/Chromium 和随应用打包的可执行 payload。

### 测试策略

| 层级 | 必需覆盖 |
| --- | --- |
| Host package | 针对每个 provider 的 bounded list、read、save、`resolveLocation`、大小和文本限制、版本映射、Host-mediated 保存恰好一个胜者、显式 workspace-write policy、伪造 root 拒绝、稳定错误，以及 POSIX 和 Windows 路径形式下 containment 拒绝的单元测试。 |
| Desktop transport | 针对 MessagePort 与 child-IPC chunk ordering、并发 stream 共享的 hop-wide in-flight credit、aggregate limit、100 MiB attachment flow、最坏情况 text escaping、stream 中途 cancellation、peer disconnect 和 guardian 双向转发的测试。 |
| Desktop preset policy | 测试在 resolve、mount、recompose、`standingKeyFor`、cold transcript ensure、create、resume 和 fork 前运行 admission；拒绝 raw `agentPreset.select` 且当前 preset 不变；准入 `desktop-default`；证明已记录的不支持 preset 不会挂载 filesystem、subprocess 或 PTY provider。 |
| Subprocess capability | Contract test 把每个 provider 和 consumer 迁移到 async `spawn()`，要求真实且已确认的 PID；覆盖 empty、absolute、bare、missing 和 non-executable lookup case、PATH override、无效 relative name、lookup cancellation 和 child-environment tombstone；再覆盖三种 stdio disposition、独立 collected offset、tail rollover 与 `lossy`、spill 成功和 cap failure、退出后读取、settlement 前 drain、credit 耗尽时 pause 与 resume、signal、wait、cancellation、两个并发 Windows Job 中只终止一个 handle 而另一个保持存活、guardian 与 capsule crash、恰好一次的 stream 和 collector termination、Windows 关闭全部 Job 的 cleanup 和 macOS mirrored-PGID cleanup。 |
| Client package | 针对 tab、dirty 状态、未保存 Markdown 预览、平台快捷键、保存期间编辑、重试、冲突 diff 和操作、dirty-close 提示以及 file-opener 路由的组件测试。 |
| 组装后应用 | 一条 keyless journey：注册临时工作区，通过 `WorkspaceId` 创建 `desktop-default` session，编辑文本/代码/Markdown，预览未保存 Markdown，保存，创建真实的 Agent 生成文件位置，点击进入编辑器，并通过共享 root filesystem provider 触发 Agent file-tool 并发冲突。 |
| 打包后应用 | 在原生 runner 执行 smoke：无系统 Node.js 或 pnpm，使用临时 `DSH_HOME`，离线启动，完成组装 journey，执行使用 collected stdout 和有界 spill 的真实 bash 或 PowerShell command，干净和强制关闭，重启后持久化，执行 Windows 安装/升级/卸载和 macOS 应用复制/替换/移除数据保留检查。 |
| 产物完整性 | 针对已解析 deploy graph 中随附的每个由 bundled Node.js 加载的原生 module、helper、可执行文件、worker、Client bundle、嵌套资源、签名、公证 ticket、Squirrel output 和 installer 路径执行目标平台探针。 |

路径安全测试在只接受 segment 的操作中拒绝绝对路径，并拒绝父目录穿越、sibling root、静态 symlink 和 junction 逃逸、在最终 canonical containment fence 前完成的替换、Windows drive 和 UNC 形式以及大小写 alias。每个被拒绝的请求都要证明已注册工作区之外没有字节被创建或修改。文档会记录已接受的 post-fence 操作系统残余竞态，不把它描述为已阻止。

桌面权限测试证明 renderer 无法调用 raw workspace creation、direct picking 或 arbitrary-path opening，无法伪造或重放 picker result、为已授权 root 创建 alias，或使用有效 `WorkspaceId` 访问 sibling root。测试会拒绝 raw `session.create({ cwd })`、`session.create({})`、缺失或伪造的 `WorkspaceId`、同时包含 `cwd` 和 `workspaceId` 的形式、除 `desktop-default` 外的每个 preset，以及 raw `agentPreset.select`，然后证明未创建任何外部目录、未挂载 provider，也未启动 Agent。原生 picker selection 在 user-paced Host BFF call 内被消费；chooser 返回结果前取消该 call 会阻止稍后的 registration；不支持的可执行文件或 script location 绝不会到达操作系统 opener。

并发测试把同一版本交给两个 writer，同时释放两个保存，并要求恰好一个成功和一个 `version-conflict`。失败方编辑器保留本地 buffer，显示成功方的磁盘内容，并且不能通过隐式覆盖解除该状态。

打包 smoke 在 macOS arm64、macOS x64 和 Windows x64 上运行。测试从实际 DMG/ZIP 或 installer 产物启动，打开工作区，完成第一版全部用户流程，退出最后一个窗口，断言 sidecar 及其 descendant 已结束，离线重启，并确认 workspace registration、setting、session 和用户文件保持完整。Windows 还会在 sidecar 启动前触发每个 `--squirrel-*` event，并证明 lifecycle-only invocation 绝不启动 Host。

失败路径 smoke 会在 process creation 后、resume 并确认前注入 crash，保留真实 subprocess group 运行，再分别 hang 和 crash sidecar，让 guardian 在该 live group 存在时 crash，让 macOS capsule 在 ownership mirror 建立后 crash，在存在 pending call 和 subscription 时销毁 renderer，并强制替换应用。Windows 必须证明 Job kill-on-close；macOS 必须证明 capsule liveness cleanup 和 Electron-main mirrored-PGID cleanup。每个 stopped child 和 running group 都必须被 kill 并 join，IPC peer 必须收到 cancellation 或 disconnect failure，而不是永久挂起。

### 实施顺序

1. 在 Service Definition 和每个 provider 中添加必需的 provider-side bounded directory listing，再添加工作区文件 Remote 和 `resolveLocation`、Host containment 和 compare-and-swap 行为、生成的 Remote assembly、聚焦测试、package 文档以及源码 `ide` profile。
2. 添加 preset-admission extension point、不可变的 `desktop-default` roster、覆盖所有入口的 desktop policy 和禁用的 preset-switching UI，再添加 IDE Client 插件、CodeMirror 编辑器、文件树、Markdown 预览、保存和冲突状态机、dirty-close 处理、file-opener service、基于 workspace 的 desktop session 创建和组装后的 keyless journey。
3. 把 connection 和 Client module delivery 重构为带互斥 Web/desktop provider 的 carrier-neutral core，把普通 subprocess spawn 和全部 consumer 迁移到异步 capability，抽出共享 collector，再添加 desktop bootloader、分块 body 和 stdio transport、精确的 Web row 替换、Electron directory-picker provider、user-paced workspace-registration BFF 和 Client flow、`subprocess-guardian` provider 与 guardian-owned runtime，以及零端口桌面 smoke。
4. 拆分 subprocess 与 PTY Service Definition，添加可选本地 PTY provider 并更新 terminal consumer，再组装 deploy closure，并添加 Electron Forge maker、独立的 Node-ABI deploy-graph assembly、Squirrel 生命周期处理、签名和公证、各目标产物探针、平台特定应用生命周期测试、notice 和 release asset。
5. 只有三个受支持目标的产物都从干净环境通过原生打包 smoke 后，才能启用公开发布。

每个阶段都保持完整的能力角色，并同步更新受影响 package README 和 public contract。桌面 carrier 不更改 `agent-loop`；用户编辑只有通过现有已记录的 prompt 或 tool flow 才会对模型可见。

### 与现有决策的关系

本提案实现 [GUI 分层与 RPC 协议](../../implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)中延后的 Electron IPC carrier，把本地 renderer 交付细化为只读应用协议，并使用 [Client 插件加载模型](../../implemented/architecture/2026-07-23-client-plugin-loading-model.md)中描述的可替换 loader。Client UI 仍按 [GUI Web Client 架构](../../implemented/architecture/2026-07-19-gui-web-client-architecture.md)作为插件和 slot contribution。

工作区操作是现有[文件系统能力 seam](../../implemented/architecture/2026-06-17-filesystem-capability-seam.md)及其 opaque version 的新 GUI 消费方，不是并行的 Electron 文件系统实现。残余 canonicalization 和 replacement 竞态仍遵循[跨 family 文件系统沙箱](../../implemented/feature/2026-07-14-cross-family-fs-sandbox.md)和[文件系统 absence observation](../../implemented/bug-fix/2026-08-09-filesystem-absence-observation.md)中的记录。桌面目录选择实现现有[目录选择器能力 seam](../../implemented/architecture/2026-07-28-directory-picker-capability-seam.md)。组合遵循 [profile 插件 bundle](../../implemented/architecture/2026-08-05-profile-plugin-bundles.md)。

内部编辑器是对[工具调用文件打开](../../implemented/feature/2026-07-28-tool-call-file-open-in-os.md)和 [Web 工作区文件 link](../../implemented/feature/2026-07-31-web-workspace-file-links.md)的桌面 profile 扩展；Web profile 保留操作系统打开行为。工作区 Remote 应用已实现的 [Typert Remote method 模型](../../implemented/architecture/2026-08-02-typert-remote-method-calls.md)，并与 active [unary API Proxy migration](../architecture/2026-08-10-unary-apiproxy-remote-migration.md)协调。它复用 [domain storage 和 workspace](../architecture/2026-07-24-domain-kv-storage-and-workspace.md)中 proposed 的 `WorkspaceId` 和 canonical registry；两个 active proposal 都保持 active。

打包遵守 [Node engine 下限](../../implemented/process/2026-07-06-node-engine-floor.md)、[原生 Windows CI](../../implemented/process/2026-08-08-native-windows-pull-request-ci.md)、[npm 发布顺序](../../implemented/process/2026-08-10-npm-release-sequences.md)和[生成的第三方 notice](../../implemented/process/2026-07-30-generated-third-party-notices.md)。它满足[无需 managed installer 的 source run](../../implemented/simplification/2026-08-10-source-run-without-managed-installer.md)中的未来分发条件，不复用或替换 [Python SDK 单文件运行时](../../implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md)。

Scoped Agent Note 审计未发现 full supersession。所有 implemented note 保持 active，不归档或删除任何 implemented 或 rejected note，两个协调中的 proposed note 继续保持 proposed。

## 考虑过的替代方案

**发布独立静态前端。** 拒绝，因为没有存活的 Host 运行时，renderer 无法执行 agent、强制文件系统 policy、持久化 session 或提供 credential。

**在 Electron main 中运行 Host。** 拒绝，因为 Electron 的 Node ABI 和 `process.execPath` 语义不同于 Host 的纯 Node 假设，并且 Host 故障会与窗口管理进程共享故障域。随应用打包的纯 Node.js sidecar 提供更清晰的生命周期和原生依赖目标。

**从 Electron 启动现有 loopback Web server。** 打包产品不采用此方案，因为特权文件操作仍会位于 HTTP/WebSocket surface 上，端口和 token 生命周期会变成产品行为，而且仓库已经为 Electron 预留 IPC。浏览器版 `ide` 开发 profile 仍使用 Web carrier。

**第一版使用 Tauri carrier。** 此方案可行，但现有 Host 仍需要 Node sidecar，同时还会引入 Rust command bridge 和打包系统。Electron 可直接复用 Client runtime，并与现有架构方向一致。

**第一版使用 Monaco。** 拒绝，因为它的 worker 和语言资源会增加包体和启动成本，而第一版需要可靠文本编辑，不需要 VS Code runtime。CodeMirror 6 能提供所需编辑器行为；如果后续需求足以证明其成本合理，仍可选择 Monaco。

**只保留操作系统文件打开。** 拒绝，因为它无法提供共享 dirty 状态、Markdown 预览、保存冲突处理或直接的 Agent 到编辑器流程。它仍是 Web profile 的行为；第一版桌面应用会让不支持的位置保持 inert。

**生成单一 SEA 可执行文件。** 第一版不采用此方案，因为动态插件解析、renderer 资源、worker、原生 module、helper、Electron，以及当前缺少 Windows Web runtime pipeline，都使应用目录成为更清晰且可验证的单元。平台 package 可以包含多个已签名可执行程序。

## 验收标准

1. 原生发布 job 生成并验证 macOS arm64 和 x64 DMG/ZIP 产物，其中应用已签名、公证并 staple；同时生成加时间戳的 Windows x64 Squirrel Setup 和 portable ZIP 产物，其中可执行内容已签名。
2. 每个安装产物都能在干净机器离线启动，无需系统 Node.js 或 pnpm，不打开 TCP 监听端口或终端窗口。
3. 用户可以浏览已注册工作区，并打开、编辑、切换 tab 和保存现有 UTF-8 文本、源代码和 Markdown 文件。
4. Markdown 预览渲染当前未保存 buffer，源码/预览往返不会修改源码文本，raw HTML 和本地文件 URL 保持 inert。
5. macOS 上的 `Meta+S` 和 Windows 上的 `Control+S` 只有在持久写入得到确认后才清除 dirty 状态；失败和保存期间编辑都会保留 dirty 内容。
6. 在不可变的 `desktop-default` preset 下，使用同一 base version 的 Host-mediated Agent 文件工具写入和编辑器保存会使用相同 root filesystem provider，并恰好产生一个成功和一个可见冲突；任何 IDE 或 Harness 文件工具路径都不执行无条件覆盖，失败方 buffer 保持可恢复。跨进程 shell 和外部写入保留明确记录的残余竞态。
7. 点击真实 Agent 生成文件位置，包括绝对 model-facing path，会由 Host 解析，并且在不同时外部打开的情况下打开或复用正确内部编辑器 tab，定位可选 line；不支持的位置保持 inert。
8. Host 测试证明 malformed segment path、逃逸 candidate、symlink、junction 和在最终 containment fence 前完成的替换都无法读取或修改已注册工作区之外的字节；desktop session 创建无法使用 raw、缺失或伪造的 cwd authority；同时明确保留已接受的 post-fence 残余竞态。
9. 关闭 dirty 状态需要选择保存、丢弃或取消；干净退出、guardian spawn 确认前的故障、sidecar hang、sidecar crash、存在 live group 时的 guardian crash、macOS capsule crash、renderer destruction 和强制替换后，不得残留 owned sidecar、stopped child、worker、subprocess 或 persistent terminal，也不得留下未取消的 pending IPC call。
10. Windows Squirrel 安装、升级、卸载和 lifecycle-only invocation，以及 macOS 应用复制、替换和移除，都会保留 `DSH_HOME`、已注册工作区、session、setting、credential 和工作区文件，并且每个受支持目标都通过完整原生打包 smoke。

## 风险

- IPC boot、Client 插件加载和 Web boot 可能分叉。保持一个 boot-manifest contract，让 core graph row 保持 carrier-neutral，并对两个 carrier 运行共享的 built-client journey。
- 原生 module、helper 和签名顺序可能产生能够构建但安装后失败的 package。在原生 runner 上组装，并在签名验证和发布前从最终产物执行 payload probe。
- 大目录、文件、prompt 和 attachment 可能耗尽 renderer 或 IPC 内存。要求每个 provider 执行有界 enumeration，使用有界读取、固定大小的分块 IPC stream、兼容全部现有调用的 aggregate body limit、hop-wide in-flight credit budget 和启动容量断言，同时承认编辑器会在内存中分配 buffer。
- 冲突 UI 仍可能通过误导性操作造成数据丢失。同时保留两个版本，破坏性操作要求明确确认，并让每次覆盖都受 compare-and-swap 保护。
- Windows path alias、junction、ACL 限制和外部进程行为不同于 POSIX。把原生 Windows 测试作为发布权威，而不是 Wine 或交叉构建结果。
- Host-mediated 版本检查不是跨进程文件系统 transaction。把受支持的 Agent 编辑保证限制在 Harness 文件工具上，准确标注 shell 和外部竞态，并在独立文件系统提案中重新评估操作系统特定 hardening。
- 普通 subprocess 创建改为异步会触及每个 provider 和 consumer。先用跨 provider contract test 完成 capability migration，再添加 guardian provider；绝不能用 placeholder handle 保留旧签名。
- Preset selection 可能通过 recompose 或 cold composition 绕过 provider ownership。保持第一版 desktop roster 不可变，在每个 preset composition 入口运行 Host admission；只有后续设计能保留相同不变式时，才加入 user preset。
- Electron 扩大了安全和补丁 surface。固定受支持版本，跟进上游安全发布，强制 fuse 和 renderer 隔离，并把 runtime 升级纳入常规维护。
- 禁用交互式终端会使第一版桌面产品的范围小于 Web bundle。在 release note 中声明此限制，并继续向 agent 提供普通 shell tool。
- 编辑器、Git、搜索、LSP、终端和更新需求可能让第一版超出可靠性目标。在五个必需 workflow 交付后，再通过独立 note 引入这些功能。
