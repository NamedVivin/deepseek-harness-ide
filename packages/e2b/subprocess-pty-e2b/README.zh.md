# @deepseek-ai/dsh-subprocess-pty-e2b

[English](README.md) | 中文

可选 [`ctx.subprocessPty`](../../subprocess/subprocess-pty/README.zh.md) 能力的 E2B Service Provider。先加载 [`dsh-e2b`](../e2b/README.zh.md)；远端 composition 需要 persistent terminal session 时再加载本包。普通远端进程仍由 [`dsh-subprocess-e2b`](../subprocess-e2b/README.zh.md) 提供。

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `pollMs` | `20` | 远端 session 存活轮询间隔（毫秒）；每个 tick 是一次控制面请求。 |

## 行为

- `spawnTerminal()` 使用 E2B 字节 PTY API，并通过 mode 为 `0600` 的私有文件安装原样 argv 与共享 provider 清理后的远端环境。随机输出边界会移除 bootstrap shell prompt 和回显的 runner 命令，同时保留请求进程字节。
- 发布会等待正数 PTY 进程 ID、bootstrap 输出边界和已解析的 POSIX session ID。setup 期间取消或 service dispose 会在拒绝前执行自有回滚；provisional terminal handle 不会跨过服务。
- Handle 报告前台进程组、发送真实信号，并跟踪在途 write、inspection 和 signal。可重试且须等待的 `terminate()` 会拒绝新操作、结算已有操作，并终止远端 terminal session 中仍可见的每个存活进程组。仅含 zombie 的进程组视为完全停稳。
- Setup 与 teardown 负责各自的私有状态目录。`SandboxNotFoundError` 证明远端执行世界无法继续保留工作，因此视为完全停稳；其他清理失败仍可观察。
- Prompt 检测、scrollback、readiness、sandbox policy 与 owner 生命周期仍归 [`dsh-terminal-bash`](../../terminal/terminal-bash/README.zh.md) 所有。

## 模型体验

通过 terminal Consumer 间接影响；这些 Consumer 负责模型可见 schema、有界输出与清理诊断。

#### KV Cache 影响

不会直接导致 KV Cache 失效；模型请求前缀或结果变更归 Consumer 所有。

## 已知限制与后续工作

- E2B 只公开数值 PID／PGID 操作，没有原子绑定的 start-identity 围栏，因此延迟足够久的操作可能与 PID 复用重叠。
- SDK 公开前台进程组，但不公开证明 fd 0 等待所需的 syscall 证据；terminal consumer 会回退到受控 prompt marker 与有界静默。
- E2B PTY 传输没有可等待的背压通道；暂停的输出 consumer 可能在宿主内存中累积 terminal 字节。
- Provider 假定 E2B Linux 镜像提供 Bash、`ps`、`awk`、`kill`、`env`、`chmod`、`rm`、`id` 和 `getent`；不支持 Windows 与逃逸 session 恢复。
