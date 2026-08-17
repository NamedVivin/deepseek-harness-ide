# dsh-desktop

[English](README.md) | 中文

这是可安装的 DeepSeek Harness IDE。Electron 负责已签名窗口、原生目录选择器、本地 `dsh-app://` 资源和有界应用生命周期。随应用打包的纯 Node.js 24 运行时会启动 Cordis Host sidecar 以及持有所有普通子进程的 guardian；安装产物不监听 TCP，也不要求系统安装 Node.js 或 pnpm。

## 运行时组装

Sidecar 在已检入的空根配置上组合 `dsh-base`、`dsh-web-app`、`dsh-ide-app` 和 `dsh-desktop-app`。桌面层会替换 Web connection 与 module-delivery provider、原生目录选择器、可变 preset 清单和直接 subprocess provider。Cordis 裸包行只会从已打包的 Host 闭包解析；profile 目录和用户插件根不参与桌面代码解析。在创建第一个窗口前，Electron 会验证每个已签名资源的路径、普通文件状态、字节上限和 SHA-256 摘要，然后把 Client bundle 请求限制到 sidecar 实际返回的精确图。

沙箱化 preload 只暴露带版本的桌面 Connection bridge 和应用自有的退出前确认交换。Renderer 启用上下文隔离，不启用 Node integration，没有导航、新窗口或网络 CSP 权限，也没有任意路径或进程方法。

Electron main 与随附 Node.js guardian 通过 JSON child IPC 通信，因为两个 executable 可能嵌入不同版本的 V8 serialization。应用自有 codec 只把有界 Connection body chunk 转换为字段严格且采用规范 base64 的 envelope，并在分配 decoded byte 前校验声明的 decoded length；lifecycle 与 ownership-control 消息仍是普通 JSON value。Guardian 使用 same-Node advanced IPC 启动 sidecar，因此二进制 guardian stream frame 不会跨越 V8 版本边界。

## 打包

Electron Forge 在原生 macOS arm64/x64 runner 生成 DMG 和 ZIP，在原生 Windows x64 runner 生成 Squirrel Setup 和 ZIP。应用直接调用固定版本的 Forge core API，启用严格 Electron fuse，并把纯 Node Host 闭包保留在 ASAR 外。打包必须通过 `DSH_DESKTOP_ELECTRON_ZIP_DIR` 指定包含 Electron `43.2.0` 精确目标压缩包的目录，并通过 `DSH_DESKTOP_ELECTRON_SHASUMS` 指定官方校验和清单；组装过程会验证压缩包，并从同一份字节中提取 Electron 和 Chromium 许可证。Forge 不会从网络解析 Electron 分发文件。发布 job 提供签名、时间戳、公证和 stapling 凭据；未签名的本地 package 只是开发产物，不能发布。

### 原生候选产物 workflow

[Desktop Artifacts workflow](../../.github/workflows/desktop-artifacts.yml) 会在每个目标的原生 GitHub-hosted runner 上构建。每个 job 都会从 `nodejs.org` 下载固定的官方 Node.js `v24.16.0` 压缩包与校验和清单，并从官方 GitHub release 下载固定的 Electron `43.2.0` 压缩包与校验和清单，在解压或打包前验证两个压缩包，然后运行确定性的组装过程与 Forge maker，执行随附 Node 的身份探测，检查封闭的 Host 与 Client payload，并在不发布的情况下上传候选产物。

| 目标 | 原生 runner | 候选产物 | 原生验证 |
| --- | --- | --- | --- |
| macOS arm64 | `macos-15` | DMG 和 ZIP | 单一架构的 Mach-O payload、应用与 DMG 签名及 Gatekeeper 评估、hardened runtime、应用与 DMG 公证 ticket、冷启动／替换／强制关闭生命周期 smoke、无 TCP 监听端口以及数据保留。 |
| macOS x64 | `macos-15-intel` | DMG 和 ZIP | 在原生 Intel 硬件上执行相同检查；不合并 universal 产物。 |
| Windows x64 | `windows-2025` | Squirrel Setup、portable ZIP、完整 NuGet package 和 `RELEASES` index | Squirrel index 完整性、Setup 与两份应用副本中可执行 payload 的 Authenticode 签名及时间戳、portable／安装后／强制关闭生命周期 smoke、lifecycle-only invocation、无 TCP 监听端口、安装／升级／卸载以及数据保留。 |

每个已安装应用都会在 `desktop-resources/` 下携带项目 `LICENSE`、生成的 `THIRD_PARTY_NOTICES.md`，以及 Electron／Chromium、Node.js、ripgrep 和 Koffi 的原始许可证文件。通知还会标明第一方 macOS process capsule。固定 Electron 与 Node.js 版本对应的任一必需通知或许可证文件缺失、为空或过期时，组装检查和最终压缩包检查都会失败。

Pull Request 和 master push 使用 `unsigned` 模式：构建原生 installer 布局、探测打包资源并运行生命周期检查，但不会声称已通过操作系统信任检查。手动 `signed` 运行还要求提供全部平台凭据；缺失任一凭据都会明确失败。macOS 使用 `APPLE_CERTIFICATE_P12_BASE64`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGN_IDENTITY`、`APPLE_API_KEY_P8_BASE64`、`APPLE_API_KEY_ID` 和 `APPLE_API_ISSUER`。Windows 使用 `WINDOWS_CERTIFICATE_PFX_BASE64` 和 `WINDOWS_CERTIFICATE_PASSWORD`；`windows_baseline_run_id` 必须指向版本号更低的 signed-candidate 运行，使原生 smoke 执行真实升级，而不是重新安装相同字节。

该 workflow 没有创建 release 或发布 asset 的 job，上传并保留 7 天的产物仅作为候选证据。普通 `dsh` npm release 会发布 family 中的其他包，但会保留 `@deepseek-ai/dsh-desktop`；只有 operator 提供同一 release commit 上成功的 signed workflow run id 后，才会继续发布该包。持有凭据的 release job 会验证 workflow 身份、commit、手动触发事件、完整 job 响应和 3 个精确的 signed 原生 job，然后才允许该 npm 包晋级。此门禁不会发布 installer asset；installer 发布仍未接线。

在 `pnpm run make` 之后，`pnpm run verify:artifacts -- --target <macos-arm64|macos-x64|windows-x64> --out out` 会执行平台本地的 payload 检查。随后，macOS 与 Windows 验证脚本会检查最终压缩包的内容，而不是信任 Forge 解包目录。

## 模型体验

### 桌面编码 Agent

#### 模型看到什么

模型会看到不可变的 `desktop-default` 编码人设，以及其文件系统、shell、搜索、编辑、job、skill、问题和 todo 工具。Electron 和 IPC 实现对模型不可见。

#### Token 影响

在模型和工作区固定时保持固定：桌面人设、工具 schema、仓库指令和已加载的 skill 描述。桌面 transport 元数据不增加提示 token。

#### KV Cache 影响

会话期间保持稳定，因为每个打包桌面 Agent 都会在发布前进入同一个固定 preset。

## 已知限制与延后工作

- 未保留编辑器未保存 buffer 的 crash 恢复；有序关闭 tab、切换工作区和退出应用都必须选择保存、放弃或取消。
- 第一版不支持 Windows arm64、自动更新、第三方 renderer 插件、交互式 PTY 终端和用户编写的桌面 preset。
- 已签名和已公证 installer 只能在持有平台凭据的原生发布 runner 上验证。
