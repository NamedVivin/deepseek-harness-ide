# @deepseek-ai/dsh-client-ui-directory-picker-desktop

[English](README.md) | 中文

ui-workspace 两个目录流 slot 的无渲染桌面占用者。每次打开请求都会调用 `workspaceRegistration.pickAndRegister()`，并把 Host 签发的 Workspace 直接交给 slot owner。它绝不会向 `workspace.create` 发送文件系统路径。

关闭或卸载流程会中止 Remote 请求。迟到的原生选择器结果会同时被该 Client 占用者和 Host BFF 忽略；正常取消选择器只会关闭流程，不显示错误对话框。

## 模型体验

无，因为桌面 Workspace 注册流程不注册模型可见内容。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- 该流程依赖桌面 Workspace registration Remote；它不提供浏览器回退或 renderer 侧路径输入。
