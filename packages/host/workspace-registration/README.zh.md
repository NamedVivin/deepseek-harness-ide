# @deepseek-ai/dsh-host-workspace-registration

[English](README.md) | 中文

用于添加桌面 Workspace 的宿主所有 BFF Remote。`workspaceRegistration.pickAndRegister()` 打开配置的原生 `ctx.directoryPicker`，在 Host 内部消费选中路径，通过 `ctx.workspaceRegistry` 完成规范化与注册，并返回生成的 Workspace 投影。renderer 不会向该操作提供路径。

该操作由用户节奏决定，包内不设置固定截止时间。调用方取消会在后端支持时传递到选择器，并在注册前与发布响应前再次检查，因此 renderer 请求结束后迟到的选择器结果不会注册 Workspace。取消、缺少原生能力和注册失败使用稳定的业务结果。

## 模型体验

无，因为原生 Workspace 注册 BFF 不注册模型可见内容。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- 该 Remote 只注册原生选择器返回的单个结果；远程目录浏览和由 renderer 提供路径的注册不属于这项能力。
