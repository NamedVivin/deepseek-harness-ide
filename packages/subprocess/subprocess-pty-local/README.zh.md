# @deepseek-ai/dsh-subprocess-pty-local

[English](README.md) | 中文

[`ctx.subprocessPty`](../subprocess-pty/README.md) 的本地 Service Provider。它通过 `node-pty` 分配 terminal，使用与普通本地 subprocess 相同的规则清理 ambient environment，并通过平台进程检查掌控前台信号和完整的可观察 session 清理。

Provider 只有在 `node-pty` 提供正数进程 ID 后才发布 handle。它从有根进程树中保留精确的 pid/start identity；Linux 还会在 leader 退出后枚举 POSIX session。因此，前台检查与信号不会跟随 PID 复用，须等待的 `terminate()` 会在停止顶层 shell 前后清理可观察后代。Service 正常 dispose 会终止并等待每个 terminal session；Node 同步 exit 阶段会对仍被保留的 handle 执行最后一次 identity-checked 强制停止。macOS 包还通过已审查的 postinstall 恢复步骤交付 `node-pty` 的可执行 spawn helper。

此包是可选的。启用 `terminal-bash` 的本地 composition 会显式挂载它；不提供 persistent terminal 的 composition 依赖闭包不包含 `node-pty` 及其 macOS helper。

## 模型体验

通过 terminal Consumer 间接影响；这些 Consumer 负责 prompt、schema、有界输出与诊断。

#### KV Cache 影响

不会直接导致 KV Cache 失效；模型请求前缀或结果变更归 Consumer 所有。

## 已知限制与后续工作

- Windows PTY 行为通过 `node-pty` 依赖 ConPTY；对于 POSIX Host 无法模拟的进程与 session 行为，仓库的原生 Windows CI 仍是权威结果。
- Linux 精确 stdin-wait 探针覆盖 x64 与 arm64；macOS 使用 `ps` 快照，无法证明 syscall 层面的 stdin 等待。
- daemon 仍可逃出观察范围：macOS 子进程可在任何前台快照前重新指定父进程；Linux 子进程可调用 `setsid`，同时离开有根进程树与自有 terminal session。
