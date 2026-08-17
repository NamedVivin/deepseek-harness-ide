# @deepseek-ai/dsh-client-connection-desktop

[English](README.md) | 中文

`@deepseek-ai/dsh-client-connection` 的类型化 desktop provider。sidecar 挂载 `ChildProcessDesktopIpcAdapter`；Electron main 在语义化 child-IPC endpoint 上挂载 `DesktopMainIpcPeer`。peer 实现 preload Client provider 消费的窄 `DesktopRendererBridge`：unary `invoke`、闭合 `system`，以及两条 `subscribe` stream。desktop bundle 在 `connection-transport` row 选择本包。

Electron main 从 `./adapter` 导入 Node value，在应用自有的 JSON guardian endpoint 上创建 peer，并提供闭合的 `DesktopMainHandlers` 表。只需协议类型的消费者使用 `./protocol`，分帧消费者使用 `./wire`，因此它们不会加载包根的 Cordis provider。sidecar 在 same-Node advanced IPC channel 上使用 `createNodeChildProcessEndpoint(process)`。sandboxed preload 只暴露冻结的 `DesktopPreloadApi` function table；renderer main world 重建 `DesktopRendererBridge` 与 `DesktopRendererLifecycleHost`，因此 `AbortSignal`、`AsyncIterable`、原始 Electron channel、物理 frame 与 endpoint send method 都不会跨越 context isolation。

## 类型化方法集合

三套 method 集合彼此独立。Renderer ApiProxy call 必须通过 `DESKTOP_RENDERER_API_METHODS`；`session.create` 还只接受非空 `workspaceId`、可选 string `sessionId`，以及缺省或 `desktop-default` 的 `agentPreset`。`DesktopRendererSystemMethodMap` 只含 `desktop.bootManifest`，它直接返回 `ctx.clientModules.graph()`，不会进入 ApiProxy dispatch。`HostInitiatedMethodMap` 只含 `directory.pick`；sidecar Host code 调用 `ctx.desktopHostBridge.request('directory.pick', {}, signal)`，并接收 `{ path: string | null }`。取消与断连会终止这三类 request。

应用自有的 renderer lifecycle 表再次独立。`DesktopMainToRendererBridge` 与 `DesktopRendererLifecycleHost` 只定义 `desktop.prepareQuit`，renderer 解决 dirty state 后返回 `{ ready }`。`DesktopPortHandoff` 只随 transferred port 携带已校验的 body limit，`DesktopPreloadStreamEnd` 表示 callback stream 的完成状态。这些 request 都不经过 sidecar。

## Body 分帧与限制

Request、response、Host capability 与 downlink event body 都编码为 UTF-8 JSON。Control frame 只带 correlation metadata 与 `bodyId`；物理 body 使用 `body-start`、有序且有界的 `body-chunk`、`body-ack`、`body-end` 与 `body-cancel`。一个 hop-wide credit pool 约束全部并发 body 的未确认 byte，不会把逐 request window 按调用数放大。

`DesktopBodyFrame` 在语义层把每个 `body-chunk` 保持为 `Uint8Array`，Electron MessagePort 以及 guardian-to-sidecar 的 same-Node channel 都遵循该类型。应用负责物理 parent channel 所需的编码；Electron-to-guardian JSON adapter 使用独立 base64 envelope 携带 chunk，并在本包解析前恢复语义 frame。

`maxDesktopBodyBytes`、`maxDesktopChunkBytes` 与 `maxDesktopInflightBytes` 默认分别为 160 MiB、1 MiB 与 16 MiB。它们必须是正的 safe integer，且 chunk limit 不得超过 in-flight limit。如果 body limit 无法容纳当前 10 MiB 文本文件限制在最坏 JSON escaping 下的大小，或无法容纳配置的聚合图片限制经 base64 膨胀与信封余量后的大小，provider 会在加载时失败。sender 与 receiver 都会拒绝过大 body；乱序、重复、格式错误及 acknowledgement 不匹配 frame 会让 peer 进入 terminal 状态。

## 模型体验

无，因为 desktop carrier 只改变物理交付。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- 本包实现 Electron-main-to-sidecar peer 与 context-isolation-safe public type。`apps/desktop` 负责 persistent MessagePort binding、renderer 销毁以及 `desktop.prepareQuit` request handler。
- 每个 endpoint 会在 schema dispatch 前重新组装一个已校验的 JSON body，因此 aggregate body limit 同时也是单 body 驻留上限。
