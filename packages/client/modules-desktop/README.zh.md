# @deepseek-ai/dsh-client-modules-desktop

[English](README.md) | 中文

载体中立 Client 模块注册表的桌面 provider。它发布不可变的 `dsh-app://plugins/<id>/client.js?rev=<revision>` URL，并且只解析与当前 Host 生成启动清单中某一行完全一致的 URL。

精确匹配会在 Electron 把请求映射到打包路径之前拒绝路径穿越、未列出的 bundle 和 revision 不匹配。provider 不通过 preload 执行 bundle；现有 renderer `ClientModuleSystem` 仍是唯一 loader。

## 模型体验

无，因为桌面 Client bundle 交付不注册模型可见内容。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- 该 provider 要求 Electron main 通过打包资源 manifest 映射其发布的 URL；它无法交付源码树或远程提供的 bundle。
