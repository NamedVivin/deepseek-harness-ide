# @deepseek-ai/dsh-client-connection-web

[English](README.md) | 中文

`@deepseek-ai/dsh-client-connection` 的 Web provider。Host 半侧把逻辑 registry 绑定到 HTTP POST route，通过同一 `/api` 信任栅栏委托不带 body 的 ApiProxy GET 和 HEAD route，负责 `/api/respond` 响应 route，并提供 `events.mux` 与 `events.host` 的只下行 WebSocket。Client 半侧提供 `WebApiClient`、通用 fetch RPC、loopback 判定，以及显式的 `?fixture` 测试模式。Web bundle 在 `connection-transport` row 选择本包，并在独立的 `connection` row 挂载载体中立包。

## 浏览器信任栅栏

每条 HTTP route 与 WebSocket upgrade 都要求 `Host` authority 是 loopback 或列在 `trustedHosts` 中。条目必须是规范的纯 `host[:port]` authority；格式错误会在加载时失败。浏览器带有 `Origin` 时，它必须与 Host authority 匹配；显式 cross-site Fetch Metadata 会被拒绝。这是可达性策略，不是认证。即使 LAN authority 已声明，配置、凭据、原生 Host、模型发现与 agent preset 创作方法仍只限 loopback。

`maxRequestBodyBytes` 默认 300 MiB。如果配置限制无法容纳 attachment service 的聚合图片上限经 base64 膨胀与信封余量后的大小，provider 会在加载时失败。bridge 会在分发前完整缓冲一个 JSON request。

## 下行流

`/api/events.mux` 与 `/api/events.host` 各接受一条只下行 WebSocket。任何 client message 都会以策略违规关闭 socket。source 失败会在关闭前发送一个 `stream/error` envelope；socket 或 provider teardown 会中止 source 并等待 pump 结束。普通 HTTP GET 这两个 path 会返回 426。

## 模型体验

无，因为 Web 载体不会增加模型可见输入。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- Web 信任栅栏不会认证远程用户；非 loopback 部署需要独立的认证设计。
- HTTP bridge 会在内存中完整缓冲每个 request body，因此配置的 body limit 也是单 request 驻留上限。
