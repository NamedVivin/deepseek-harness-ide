# @deepseek-ai/dsh-subprocess-guardian

[English](README.md) | 中文

面向打包桌面 Host 的纯 Node subprocess provider 与进程所有权 guardian runtime。Sidecar 侧的 `GuardianSubprocessRuntime` 在 guardian 环境中解析 executable，并执行异步的 stopped-child prepare/resume transaction；因此只有在 stdio 已安装、原生所有权已确认、执行已恢复且拿到正数操作系统 PID 后，`spawn()` 才会返回。

`FramedGuardianPeer` 通过 guardian 与 sidecar 之间的 same-Node advanced-serialization IPC channel 复用有界 JSON call 与 stdio。每条 byte stream 都携带 sequence、acknowledgement、cancellation，并共享单跳 credit budget；guardian parser 会忽略无关的桌面消息。`GuardianHost` 接受单独编码的 Electron parent endpoint，在本地终止 guardian frame，并在 Electron main 与 Host 之间按顺序转发其他 sidecar 流量。Parent 丢失、sidecar 丢失、保留控制消息格式错误或显式 dispose，都会启动同一个幂等的 quiescent cleanup transaction。

原生 supervisor 是必需组件，不存在 JavaScript detached-process fallback：

- Windows x64 上，`KoffiWindowsJobTransport` 创建私有的 `KILL_ON_JOB_CLOSE` Job Object，以 suspended 状态创建 target，在 resume 前完成分配，并持有 Job 与 process handle，直到 active-process count 归零。尽管 `CreateProcessW` 必须开启 handle inheritance，`STARTUPINFOEXW` 与 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 仍只把请求的 target stdio handle 加入白名单。
- macOS 上，`MacOsProcessCapsuleTransport` 启动固定且已签名的 `dsh-process-capsule` helper。Helper 保持在 target group 之外，并 fork 出调用 `setsid()` 的 capsule child；该 child 创建与其 PID 不同的 stopped target child，只在 guardian 和 Electron main 均确认所有权后 resume，监视两条 liveness channel，对完整 group 执行 TERM → grace → KILL，并在 release 前报告 group-zero。Electron main 持有只读 PGID mirror；stopped rollback 或 resumed outcome/terminate/wait/release 的任何失败都会使用 `recover`/`recovered` 控制 transaction，由 main kill 并 join 已记录的 group，随后才删除所有权。

桌面 guardian entry 构建为 `apps/desktop/lib/guardian.js`。打包后的 macOS 应用把 helper 放在 `desktop-resources/native/dsh-process-capsule`；`apps/desktop/native/process-capsule/build.sh <arm64|x86_64> <absolute-output>` 构建指定架构的 Mach-O 产物。Electron main 把已签名 runtime config 直接映射为 guardian 参数：`maxDesktopBodyBytes`、`maxDesktopChunkBytes` 和 `maxDesktopInflightBytes` 设置三项 IPC limit；`nativeProcessPollMs` 设置原生与 main 所持有 liveness probe 的最大间隔；`gracefulShutdownMs` 和 `forceShutdownMs` 限制直接 sidecar 的 termination；`mirrorTimeoutMs` 限制每次 main ownership acknowledgement。Main 还提供 sidecar entry 绝对路径；macOS 另提供 helper 路径和继承自 main 的 liveness descriptor。

发布到 npm 的 payload 会携带 provider、guardian 和 Host entrypoint 共享的全部 `lib/channel-*.js` 运行时 chunk。桌面组装会在 Forge 运行前链接已部署的 Host entry，因此不完整的发布清单会在创建应用包之前失败。

`DesktopGuardianMainOwner` 必须在接受 sidecar ready 前记录特权 `dsh.guardian.mirror` `sidecar-started` 消息，并且只在收到 `sidecar-joined` 后清除记录。它还持有每项 macOS capsule 记录，并串行处理 register、release 与 recover acknowledgement。Guardian exit、error、disconnect、控制消息格式错误或转发的 runtime failure，都会为所有保留的 PID 与 PGID 启动有界 TERM → poll → KILL → poll 清理；`prepareShutdown()` 在不移除监听器的情况下标记预期退出，`dispose()` 等待清理完成。Sidecar 仍是 guardian 的直接 child，而不是 kernel Job/capsule member，所以不能把这项第二所有者清理描述为内核强制的 orphan guarantee。

## 模型体验

通过普通 subprocess 和 shell Consumer 间接影响。Provider 在把进程创建移出 sidecar 的同时，保留它们现有的 outcome、stdio、collected tail、truncation 与 spill 语义。

#### KV Cache 影响

不会直接导致 KV Cache 失效；模型可见的结果格式归 Consumer 所有。

## 已知限制与后续工作

- 不支持 Windows arm64；第一版打包 Windows target 是 x64。
- 原生失败路径以相应的 macOS 和 Windows release runner 为权威。跨平台单元测试验证协议和所有权 transaction 顺序，但不能替代这些操作系统检查。
- Sidecar crash cleanup 在应用协议层由两个所有者共同负责，而不是依赖已转移的原生 process handle。未来可以替换为原生 sidecar owner，而无需改变通用 guardian protocol。
