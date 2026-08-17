# @deepseek-ai/dsh-client-modules-web

[English](README.md) | 中文

载体中立 Client 模块注册表的 Web provider。它发布带 revision 的 `/plugins/<id>/client.js` URL，通过 `ctx.webServer` 提供已注册 bundle 与 source map，并在浏览器 shell 执行前注入当前共享启动清单。

该包独占 Web 的物理交付。发现、依赖边、revision 和 Client 模块系统仍由 `@deepseek-ai/dsh-client-modules` 持有。

## 模型体验

无，因为 Web Client bundle 交付不注册模型可见内容。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- 该 provider 依赖 HTTP `WebServer` 和 index 渲染载体；非 HTTP 组合必须选择其他交付 provider。
