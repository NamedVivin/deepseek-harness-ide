# @deepseek-ai/dsh-subprocess-pty-local

[English](README.md) | 中文

[`ctx.subprocessPty`](../subprocess-pty/README.zh.md) 的本地 Service Provider。它通过 `node-pty` 分配 terminal，使用与普通本地 subprocess 相同的规则清理 ambient environment，并通过平台进程检查掌控前台信号和完整的可观察 session 清理。

提供方只有在 `node-pty` 提供正数进程 ID 后才发布句柄。它从有根进程树中保留精确的 pid/启动身份；Linux 还会在 leader 退出后枚举 POSIX session。须等待的 `terminate()` 会重新检查这些身份，并在停止顶层 shell 前后清理可观察后代。服务正常 dispose 会终止并等待每个 terminal session；Node 同步 exit 阶段会对仍被保留的句柄执行最后一次身份检查后强制停止。

在 Windows 上，基于 koffi 的检查器通过 Toolhelp32 枚举进程表，把 GetProcessTimes 启动身份与进程句柄零时等待结合起来判断存活状态；由于 Windows 没有 POSIX 进程组，它会把 shell pid 报告为伪前台进程组。被外部 taskkill 的 shell 可能永远不会发出 `node-pty` 的退出通知，因此拆卸会通过该检查器验证 shell 已终止。macOS 包还通过已审查的 postinstall 恢复步骤交付 `node-pty` 的可执行 spawn helper。

此包是可选的。启用 `terminal-bash` 的本地 composition 会显式挂载它；不提供 persistent terminal 的 composition 依赖闭包不包含 `node-pty` 及其 macOS helper。

## 模型体验

通过 terminal Consumer 间接影响；这些 Consumer 负责 prompt、schema、有界输出与诊断。

#### KV Cache 影响

不会直接导致 KV Cache 失效；模型请求前缀或结果变更归 Consumer 所有。

## 已知限制与后续工作

- Windows PTY 行为通过 `node-pty` 依赖 ConPTY；对于 POSIX Host 无法模拟的进程与 session 行为，仓库的原生 Windows CI 仍是权威结果。
- Windows terminal 信号是控制台级的：SIGINT 以 `\x03` Ctrl-C 输入写入投递，由 conhost 转为控制台级 CTRL_C 事件；SIGTSTP 与 SIGHUP 被拒绝（不可用）。SIGTERM 使用不带 `/F` 的 `taskkill`，它无法终止控制台进程，因此 TERM 档是强制 `/F` 升级前的宽限等待。Windows 检查器无法证明精确的 stdin 等待，并报告 `inputWaiting: false`。
- Linux 精确 stdin-wait 探针覆盖 x64 与 arm64；macOS 使用 `ps` 快照，无法证明 syscall 层面的 stdin 等待。
- daemon 仍可逃出观察范围：macOS 子进程可在任何前台快照前重新指定父进程；Linux 子进程可调用 `setsid`，同时离开有根进程树与自有 terminal session。提供方不会持续监视进程表。
- 进程内清理要求退出阶段仍能执行 JavaScript。直接 `process.exit()`、默认未捕获异常和默认未处理 rejection 会发出 Node 同步 `exit` 事件。未安装 handler 时，`SIGTERM`、`SIGINT` 或 `SIGHUP` 的默认 OS 处置不会发出该事件；应用只有安装执行正常 dispose 或调用 `process.exit()` 的 handler 才能覆盖这些信号。`SIGKILL`、fatal OOM、`process.abort()`、native crash、断电，以及任何无法运行 JavaScript 的故障，都需要外部 supervisor 或 OS 所有者负责。
