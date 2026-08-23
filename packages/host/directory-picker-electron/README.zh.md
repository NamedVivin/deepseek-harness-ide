# @deepseek-ai/dsh-host-directory-picker-electron

[English](README.md) | 中文

[目录选择 seam](../directory-picker/README.zh.md) 的 Electron main provider。它在 Node sidecar 中注册普通的 `native` `ctx.directoryPicker` capability，但会通过独立的 `ctx.desktopHostBridge` Host-initiated channel 转发每次选择请求。Electron main 打开原生 chooser，并且只把选中的绝对路径返回给仍存活的 Host 请求；renderer 不能调用这个方法，也不能观察其结果。

调用方取消会传播到 bridge。因为 Electron 原生 chooser 没有 abort handle，取消会终止逻辑请求，随后返回的 chooser 结果会被丢弃。Workspace registration BFF 会在注册路径前执行最终的存活检查。

## 模型体验

无，因为这个 Host capability provider 不注册 prompt、tool、message 或模型输入。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- Provider 不承诺在取消后关闭已经显示的原生 chooser。
- 它只适用于由 Electron main 提供 Host-initiated bridge 的打包 sidecar 组合。
