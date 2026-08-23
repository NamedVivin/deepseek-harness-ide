# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

载体中立的 Connection Service Definition 与 Consumer。Host 半侧提供 `ctx.connection`：受 effect 管理的逻辑 RPC registry、目标解析、ApiProxy fallback、响应交付，以及 `events.mux`／`events.host` source。Client 半侧提供共享 connection handle、按 generation 生效的 `hostDescription` 与单消费方重连循环。Host 与 Client 构造时都必须获得恰好一个 `connectionTransport` provider；Web 与 desktop 包负责物理载体。

导出的 `ClientTransportHooks` 命名 Web 提供方使用的页面全局量 `__DSH_TRANSPORT__`。served app 不设置它，使用 HTTP 与 WebSocket 载体；持有其他物理传输的 shell（例如 worker 预览的 `postMessage` 隧道）则提供 `createApiClient` 与 `fetch`，同时持有 bundle 字节时再加 `loadBundle`，无需 fork 载体中立插件。

`ctx.connection.rpc.handle(channel, handler, { authority })` 独占一条专用 channel。`ctx.connection.rpc.intercept('/api', matches, handler, { authority })` 会在 ApiProxy fallback 之前认领匹配 endpoint。注册、route 发布与移除都跟随调用方的 Cordis effect。载体会在业务分发前获得已经解析的实时目标，并必须执行自身闭合的授权策略；`loopback` registration 还会由 core router 要求 loopback caller authority。

Client provider 通过 `ClientConnectionTransport` 提供 `api`、通用 `rpc` 与 `isLoopback`。core `apply` 消费该 provider，并发布一个稳定的 `ctx.connection` handle。每次就绪握手成功后，都会在 `onConnected` 前发布完整的 `host.describe`；generation 失效或显式 stop 会清空它。

## 模型体验

无，因为 Connection transport 只搬运已经组合好的协议消息，不增加模型可见输入。

#### KV Cache 影响

无；本包既不组装也不发送 provider request。

## 已知限制与暂缓事项

- **History 会恢复未附加的会话**：打开 history 可能创建宿主侧 agent，并增加首次打开的延迟；没有仅从持久化读取的路径。
