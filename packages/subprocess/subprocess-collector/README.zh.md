# @deepseek-ai/dsh-subprocess-collector

[English](README.md) | 中文

普通 subprocess provider 共用的 provider-neutral 输出收集实现。`OutputCollector` 保留按字节精确限制的尾部，以全流 offset 支持互不干扰的 reader，并可选地把完整流写入私有 spill 文件。`collectReadable()` 为使用 Node `Readable` 的 provider 增加 clean EOF drain 生命周期。

Spill path 分为两种状态。仍可能接收字节时，`provisionalSpillPath` 仅供 provider 私下使用。只有 `finalize()` 成功关闭已完整 drain 的文件后，`readFrom()` 才会发布 spill path；`fail()` 处理 transport 错误、提前 close 和有界 drain 取消，不发布并删除 provisional 文件，同时仍保留可读尾部。open、write 或最终 close 失败会禁用可选 spill 恢复，但不会丢失有界尾部。

Provider 通过 `push()` 传入原样字节，只在 collector 完成 drain/finalization 后结算进程 outcome，并让 reader 在进程退出后继续可用。使用自有 framing transport 的 provider 可直接驱动 `OutputCollector`；使用 Node stream 的 provider 使用 `collectReadable()`。

## 模型体验

通过 subprocess Consumer 间接影响；这些 Consumer 决定如何渲染收集文本、截断状态和完整 spill 恢复信息。

#### KV Cache 影响

不会直接导致 KV Cache 失效；模型请求前缀或结果变更归 Consumer 所有。

## 已知限制与后续工作

- 成功发布的 spill 文件会保留在 provider 的私有临时区域，供 consumer 读取；deployment 层的保留和删除策略与 collector finalization 分开处理。
