# @deepseek-ai/dsh-subprocess-local

[English](README.md) | 中文

普通 [`@deepseek-ai/dsh-subprocess`](../subprocess/README.zh.md) seam 的本地 Service Provider。`LocalSubprocessRuntime` 解析本地可执行文件，并以显式 stdio spawn detached 进程树。该实现没有配置：每项处置方式、限制、宽限期与目录都来自 [`dsh-bash-local`](../../shell/bash-local/README.zh.md)、[`dsh-lsp-stdio`](../../lsp/lsp-stdio/README.zh.md) 等 consumer。本地终端会话由可选且独立的 [`dsh-subprocess-pty-local`](../subprocess-pty-local/README.zh.md) 提供，因此本包不依赖 `node-pty`。

## 行为

- **以适合平台的方式发送信号的 detached 进程树**：POSIX 子进程使用 `detached` spawn（拥有独立进程组），信号以负 pgid 发送并以直接子进程作为回退；Windows 通过 `taskkill /PID <pid> /T /F` 终止进程树。`terminate()`（句柄唯一的终止操作）先发送 SIGTERM，经过 spec 的宽限期后再发送 SIGKILL（沿用 OpenCode 的升级策略；流水线与子 shell 会随父进程一起结束），进程树消亡后为空操作；`waitForExit()` 轮询整棵进程树的存活状态，使消费方的拆卸能确认真正的完全停稳。组长进程退出后，仍然打开的管道也只获得同样有界的排空宽限期，因此存活的后代进程无法无限期地拖住结果不结算。系统会容忍 ESRCH；重新指定父进程并脱离该组的 daemon 仍可能存活。
- **按流划分的处置方式**：`'pipe'` 把原始流原样交给调用方；`'inherit'` 直通父进程描述符；收集模式把有界尾部、全流 offset 和可选 spill 文件交给 [`dsh-subprocess-collector`](../subprocess-collector/README.zh.md)。spill 在完整 drain 并成功关闭前只供 provider 私下使用。transport 错误、提前 close 或有界 drain 到期会保留尾部，但不发布并删除不完整的 spill。
- **凭据清除 + 显式合并**：以 `process.env` 为基础，移除形似凭据的变量（`*KEY*`／`*PASSWORD*`／`*SECRET*`／`*TOKEN*`）和所有环境中已有的 `DSH_*` 名称；spec 的显式 `env` 在该清除之后合并且不做命名空间校验，因此有意提供的凭据或当前 `DSH_*` 事实会胜出，而陈旧的嵌套 harness 身份无法从环境中隐式漏入。提供的 stdin 会被写入后关闭；否则 fd 0 指向 `/dev/null`。参见 [stdin/env Agent Note](../../../.agents/notes/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-api.zh.md)与[受管环境 Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-agent-session-identity-and-log-location.zh.md)。
- **基于偏移量的读取**：收集模式的读取器按完整流的字节坐标返回增量；服务自身从不持有游标，因此消费方自有的游标（bash 的后台读取路径）与完整流重读可以共存，结算前后皆然。
- **可执行文件查找**：`resolveExecutable` 检查绝对文件，或根据平台可执行文件扩展名在清理后的有效 PATH 中搜索；含分隔符的相对路径在该 seam 处被拒绝，相对 PATH 条目从宿主进程 cwd 解析。
- **先终止再等待退出的 dispose（资源释放）**：服务保留存活句柄，使自身的 dispose 能对每个仍在运行的进程树执行升级并等待其退出；完全停稳与 spawn 失败的句柄会在整棵进程树清理完成后离开存活集合。
- **同步宿主退出最终清理**：服务 effect 仍有效时，Node `exit` listener 会强制终止仍被保留的普通进程树。该操作会向受管 POSIX 进程组发送 SIGKILL，或在 Windows 运行 `taskkill /T /F`；它不会创建 Promise 或 timer，不改变宿主退出码与诊断，会分别包含每个目标的失败，也不会声称已经完全停稳。正常 dispose 仍使用上面的须等待温和路径。参见[宿主退出清理决策](../../../.agents/notes/implemented/bug-fix/2026-08-11-synchronous-subprocess-exit-cleanup.zh.md)。

## 模型体验

通过 Consumer 间接影响（目前是 `dsh-tool-bash` 背后的 bash 执行器家族）；进程输出与生命周期面向模型的全部渲染归 Consumer 所有。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **Windows 进程树支持仅为尽力而为**：终止经由 `taskkill /PID <pid> /T /F` 完成，所有结果都被就地吸收，不向外抛出（进程树已不存在、竞态、二进制缺失），存活探测则回退到直接子进程边界。
- **进程内清理要求退出阶段仍能执行 JavaScript**：直接 `process.exit()`、默认未捕获异常和默认未处理 rejection 会发出 Node 同步 `exit` 事件。未安装 handler 时，`SIGTERM`、`SIGINT` 或 `SIGHUP` 的默认 OS 处置不会发出该事件；应用只有安装执行正常 dispose 或调用 `process.exit()` 的 handler 才能覆盖这些信号。`SIGKILL`、fatal OOM、`process.abort()`、native crash、断电，以及任何无法运行 JavaScript 的故障，都需要外部 supervisor、容器 init 或等价的 OS 所有者负责。
- **凭据清除依赖名称启发式规则**：只匹配 `*KEY*`／`*PASSWORD*`／`*SECRET*`／`*TOKEN*`；名称不同的 secret（例如 `*PASSPHRASE*`）会继续传递，对误删变量引入白名单属于已记录的后续工作。
- **不会删除已完成的 spill 文件**：有界的完整输出恢复文件（以及每个进程的私有 spill 目录）会在 OS tmpdir 下累积，直到外部机制进行清理；超大的不完整 spill 会被丢弃并立即尝试删除，但清理失败可能留下一个有界文件。

原始进程处理位于 `src/spawn.ts`；`src/index.ts` 负责服务接线。
