# 子进程

[English](subprocess.md) | 中文

普通进程与终端会话是相互独立的能力 seam。[`dsh-subprocess`](../../packages/subprocess/subprocess) 定义用于可执行文件查找和受管管道进程树的 `ctx.subprocess`；[`dsh-subprocess-pty`](../../packages/subprocess/subprocess-pty) 定义用于控制终端与提供方可观察会话清理的可选 `ctx.subprocessPty`。[bash 执行器家族](shell.zh.md)使用收集模式批量输出，LSP 与 ACP 使用原始协议管道，PTY 后端使用可选终端服务。`ctx.subprocess` 拥有受管 `DSH_*` 环境命名空间、共享凭据清除（`scrubbedParentEnv`）与 `CollectedOutput` 词汇；[`dsh-subprocess-collector`](../../packages/subprocess/subprocess-collector) 提供提供方中立的尾部、偏移量、spill 与 drain 行为。

源码：[`packages/subprocess/subprocess/src/types.ts`](../../packages/subprocess/subprocess/src/types.ts) 与 [`packages/subprocess/subprocess/src/index.ts`](../../packages/subprocess/subprocess/src/index.ts)

## 可执行文件查找

一个 provider 的 spawn 工作目录、可执行文件路径与普通进程，和挂载的文件系统 provider 处于同一路径与进程命名空间。`resolveExecutable(command, env?, signal?)` 验证绝对可执行文件路径，或通过 provider 清理后的 `PATH` 加显式覆盖来解析裸名称。独立挂载的 PTY provider 在 consumer 共享路径时必须指向同一个执行世界。

## 受管环境命名空间与捕获的输出

`DSH_*` 变量是归 Harness 所有的子进程事实；实现会在合并调用方显式 `env` 之前丢弃环境中已有的 `DSH_*` 名称，因此当前事实只会以有意提供的字符串条目形式到达，而显式的 `undefined` tombstone 会删除普通环境中已有的值。每条被收集的流都通过 `CollectedOutput` 报告自身的截断与 spill 恢复状态。

```ts type-equiv
/** One environment key inside the managed {@link DSH_ENV_PREFIX} namespace. */
type DshEnvironmentKey = `${typeof DSH_ENV_PREFIX}${string}`
```

```ts type-equiv
/** Trusted DeepSeek Harness variables for one child-process execution. */
type DshEnvironment = Readonly<Record<DshEnvironmentKey, string>>
```

```ts type-equiv
/** One captured stream: the (possibly truncated) text plus recovery info. */
interface CollectedOutput {
  /** Collected text — the TAIL of the stream when truncated. */
  text: string
  /** True when bytes were dropped from `text`. */
  truncated: boolean
  /** Path to a file holding the COMPLETE stream, when truncated and available. */
  spillPath?: string
}
```

## Node 风格的 stdio 处置方式（disposition）

每条流的处置方式都显式给出，由各消费方自行选择：原始管道用于协议分帧（LSP JSON-RPC、ACP ndjson），inherit 用于直通的诊断输出，收集模式用于有界的批量输出；其中 spill 文件是可选的，因此诊断尾部（语言服务器的 stderr）可以只在内存中缓冲，不留下任何文件。

```ts type-equiv
/**
 * stdin disposition. `'ignore'` leaves fd 0 on `/dev/null`; `'pipe'` exposes
 * {@link SubprocessHandle.stdin} for the caller's ongoing protocol writes;
 * `{ data }` writes the bytes and closes (the batch shape).
 */
type SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string }
```

```ts type-equiv
/**
 * Bounded in-memory collection for one output stream, with an optional
 * full-stream spill file. Omitting `spill` keeps only the in-memory tail —
 * the diagnostic-tail shape (a language server's stderr); including it makes
 * the complete stream recoverable up to its cap (the bash tool shape).
 */
interface SubprocessCollect {
  /** In-memory cap in bytes; overflow keeps the TAIL. */
  maxBytes: number
  /** Full-stream spill file; absent disables spilling entirely. */
  spill?: {
    /** Whole-stream byte cap; a larger stream discards its now-incomplete spill. */
    maxBytes: number
  }
}
```

```ts type-equiv
/**
 * stdout/stderr disposition. `'pipe'` exposes the raw `Readable` for the
 * caller's protocol decoding; `'inherit'` passes the parent's descriptor
 * through (child diagnostics land on the harness's own stream); a
 * {@link SubprocessCollect} object buffers boundedly with offset-based reads.
 */
type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect
```

```ts type-equiv
/** Per-stream stdio dispositions, all explicit — this seam applies no defaults. */
interface SubprocessStdio {
  stdin: SubprocessStdinMode
  stdout: SubprocessOutputMode
  stderr: SubprocessOutputMode
}
```

## 完全显式的 spawn spec

该 seam 不应用任何默认值：每项处置方式、限制与目录都在 spec 上显式给出，因此由调用方自己的配置决定它们，而不是由某个隐藏的子进程服务默认值决定。`argv` 绝不经过 shell 解释。

```ts type-equiv
/**
 * A fully-specified spawn request. This seam applies no defaults: every
 * disposition, limit, and directory is explicit, so the caller's own config —
 * not a hidden subprocess-service default — decides them (the `dsh-shell`
 * request/spec split is the owning template).
 */
interface SubprocessSpawnSpec {
  /** Executable and arguments; `argv[0]` is the program. Never shell-interpreted here. */
  argv: readonly string[]
  /** Working directory for the child. */
  cwd: string
  /** Per-stream stdio dispositions. */
  stdio: SubprocessStdio
  /**
   * Positive finite grace period in milliseconds, no greater than
   * `MAX_TIMER_DELAY_MS`, for the {@link SubprocessHandle.terminate} escalation
   * and for draining still-open collected pipes after the process exits (an
   * inherited descriptor held by a surviving descendant cannot hold the
   * outcome open indefinitely).
   */
  graceMs: number
  /**
   * Abort signal — starts the terminate escalation on the process tree when
   * it fires. The caller owns deadlines and cause classification; this seam
   * only reacts to the abort.
   */
  signal?: AbortSignal | undefined
  /**
   * Explicit environment entries merged onto the implementation's scrubbed
   * parent base (see `scrubbedParentEnv`), with no namespace validation. A
   * string is a deliberate caller opt-in, so a forwarded credential-shaped
   * entry or current `DSH_*` fact survives the scrub; `undefined` is a
   * tombstone that removes an ordinary ambient entry from the child.
   */
  env?: NodeJS.ProcessEnv | undefined
}
```

## 句柄：流、读取器与以进程树为范围的终止

`spawn(spec)` 返回 Promise，且只在 provider 取得正进程 ID 并拥有该进程树后 resolve。收集模式的读取器接受全流字节 offset 且从不消费，因此独立 reader 不会抢走彼此的增量；管道化流归调用方所有。终止在每个平台上都以进程树为范围：`terminate()`（唯一终止动词）执行 SIGTERM→宽限期→SIGKILL 升级，`waitForExit()` 观察整棵进程树。这足以让 consumer 构建自己的分级清理流程；ACP 后端先关闭 stdin 的 `disposeAcpChild` 是仓库内参考实现。

```ts type-equiv
/**
 * A live child process rooted in its own process tree. Collected output
 * remains readable after exit; piped streams belong to the caller.
 *
 * Termination is tree-scoped everywhere: POSIX signals the detached process
 * group (falling back to the direct child when the group is gone), Windows
 * terminates the tree via `taskkill /T`, so helper processes cannot outlive
 * the handle unnoticed.
 */
interface SubprocessHandle {
  /** Positive process id of the provider-owned tree root. */
  readonly pid: number
  /** The child's stdin, present iff spawned with `stdin: 'pipe'`. */
  readonly stdin: Writable | undefined
  /** The child's raw stdout, present iff spawned with `stdout: 'pipe'`. */
  readonly stdout: Readable | undefined
  /** The child's raw stderr, present iff spawned with `stderr: 'pipe'`. */
  readonly stderr: Readable | undefined
  /** Offset-based readers for collect-mode streams (also readable after exit). */
  readonly collected: SubprocessCollectedOutputs
  /** Resolves at process close with exit facts; rejects only for failures after creation succeeds. */
  readonly done: Promise<SubprocessOutcome>
  /**
   * Begin the SIGTERM → `graceMs` → SIGKILL escalation on the process tree
   * (Windows force-terminates immediately) — the seam's only termination
   * verb. Idempotent, a no-op once the tree is gone (the pid may be reused),
   * and also triggered by the spec's abort signal.
   */
  terminate(): void
  /**
   * Wait until the process tree has exited — the tree, not just the direct
   * child, so a still-running helper is observable before teardown returns.
   * @param signal - optional bound for the wait.
   * @returns `true` when the tree exited, `false` when the signal aborted first.
   */
  waitForExit(signal?: AbortSignal): Promise<boolean>
}
```

```ts type-equiv
/**
 * Cursor-free incremental access to one collected output stream. Offsets are
 * whole-stream byte coordinates owned by the caller, so independent readers
 * cannot consume one another's output; `readFrom(0)` after settlement is the
 * batch result (`lossy` then means the in-memory tail lost its head — the
 * {@link CollectedOutput.truncated} fact).
 */
interface SubprocessOutputReader {
  /**
   * Read everything captured since `fromByte`. When that offset has slid out
   * of the in-memory tail window the read is `lossy` — it returns the whole
   * retained tail and the gap is only recoverable from the spill file.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 for the first read).
   * @returns the delta text, the next offset, the `lossy` flag, and the spill path when one exists.
   */
  readFrom(fromByte: number): SubprocessOutputRead
}
```

```ts type-equiv
/** One incremental {@link SubprocessOutputReader.readFrom} read. */
interface SubprocessOutputRead {
  /** Stream text from the requested offset (the whole retained tail when lossy). */
  text: string
  /** Whole-stream offset to resume from on the next read. */
  nextOffset: number
  /** True when the requested offset slid out of the in-memory tail window. */
  lossy: boolean
  /** Path to the full-stream spill file, when one was created and remains intact. */
  spillPath?: string
}
```

```ts type-equiv
/** Offset-based readers for the streams spawned in collect mode. */
interface SubprocessCollectedOutputs {
  /** Present iff stdout is a {@link SubprocessCollect}. */
  readonly stdout?: SubprocessOutputReader
  /** Present iff stderr is a {@link SubprocessCollect}. */
  readonly stderr?: SubprocessOutputReader
}
```


## 结果只承载退出事实

`done` 报告 Node close 事件的词汇，不携带原因分类：服务会在中止时终止进程，但绝不判定原因（调用方读取归自己所有的 deadline 信号，例如 bash 执行器的 `timedOut`/`aborted` 拆分）。收集到的输出在结算后仍可经 `handle.collected` 读取，因此批量与流式调用方共用一条访问路径。

```ts type-equiv
/**
 * Exit facts of one closed process — Node's `close`-event vocabulary.
 * Deliberately carries NO timeout or cancellation classification (the caller
 * reads the signal it owns to classify causes) and NO output: collected
 * streams stay readable through {@link SubprocessHandle.collected} after
 * settlement, so batch and streaming callers share one access path.
 */
interface SubprocessOutcome {
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** Terminating signal (e.g. 'SIGTERM'); null on normal exit. */
  signal: NodeJS.Signals | null
}
```

## 终端进程原语

`ctx.subprocessPty.spawnTerminal(spec)` 是可选的非管道进程原语。独立 provider 分配控制终端，并负责 UTF-8 文本传输、前台进程组检查与信号发送，以及一项须等待的 TERM→KILL 操作；该操作会使其仍可观察到的每个 session member 完全停稳。PTY 后端仍负责 prompt 检测、readiness 推断、scrollback、sandbox policy 与 persistent-session ownership；普通 `spawn()` 无法重建控制终端语义。

终端 spec 完全指定 argv、cwd、环境覆盖、尺寸、清理宽限期与可选分配取消。其 handle 公开 `pid`、有序输出、`done`、`write`、`inspectForeground`、`signalForeground` 和须等待的 `terminate`。本地与 E2B provider 分别位于 [`dsh-subprocess-pty-local`](../../packages/subprocess/subprocess-pty-local) 与 [`dsh-subprocess-pty-e2b`](../../packages/e2b/subprocess-pty-e2b)。

## 服务行为

抽象的 [`SubprocessRuntime`](../../packages/subprocess/subprocess/src/index.ts) 规定执行世界坐标、可执行文件查找与普通 `spawn`；[`LocalSubprocessRuntime`](../../packages/subprocess/subprocess-local/src/index.ts) 以 detached 进程树、共享收集、凭据清除和先终止再等待退出的资源释放实现它。[`SubprocessPtyRuntime`](../../packages/subprocess/subprocess-pty/src/index.ts) 独立规定终端分配与 session ownership。这一拆分允许普通进程部署完全省略 `node-pty`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxe2b--e2bruntime"></a>

### `ctx.e2b` — `E2BRuntime`

Creates one lazily consumable E2B SDK handle and deletes the sandbox at timeout or disposal. Creation begins at plugin construction; adapters await getSandbox before their first operation.

```ts cordis-catalog
/**
 * Return the shared live SDK handle.
 * @returns the created sandbox after the configured cwd exists.
 * @throws when E2B rejects creation or the service is disposing.
 */
async getSandbox(): Promise<Sandbox>
```

Source: [`packages/e2b/e2b/src/index.ts`](../../packages/e2b/e2b/src/index.ts)

<a id="ctxsubprocess--subprocessruntime-abstract-seam"></a>

### `ctx.subprocess` — `SubprocessRuntime` (abstract seam)

Abstract subprocess service. Subclass, implement spawn, and load the subclass as a plugin — it registers as `ctx.subprocess` (one implementation per context; loading a second throws, which is cordis' standard duplicate-service behavior).

Implementations must honor these semantics:

- Executable paths belong to one execution world shared with the mounted filesystem provider.
- spawn resolves only after process creation has produced a real process id and the provider owns the process tree. It rejects when either condition cannot be established. `done` resolves at process close with exit facts and rejects only for failures after creation succeeds.
- Collect-mode readers are offset-based and non-consuming, so independent readers never consume one another's output; lossy reads report truncation and the spill file holding the complete stream when one exists. Piped streams are handed to the caller raw and never buffered here.
- SubprocessHandle.terminate (and the spec's abort signal) escalates SIGTERM→grace→SIGKILL — the only termination verb — tree-scoped on every platform. SubprocessHandle.waitForExit observes whole-tree liveness, so a consumer-owned teardown ladder can hold each tier on real quiescence.
- Disposal of the service terminates all still-running managed processes and awaits their exit.

```ts cordis-catalog
/**
 * Resolve one configured executable in this provider's execution world.
 * Absolute paths are verified; bare names use the provider's scrubbed PATH
 * plus explicit environment overrides. Relative paths containing separators
 * are rejected: the resolution base is undefined, so providers fail loud
 * instead of guessing.
 * @param command - absolute executable path or bare PATH name.
 * @param env - explicit environment entries used for lookup.
 * @param signal - aborts remote or local lookup.
 * @returns a canonical executable path.
 */
abstract resolveExecutable( command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal, ): Promise<string>

/**
 * Start one managed child process from a fully-specified spec; this seam
 * applies no defaults.
 * @param spec - argv, directory, stdio dispositions, grace, cancellation, and environment.
 * @returns the live process handle after its real process id and provider ownership are established.
 */
abstract spawn(spec: SubprocessSpawnSpec): Promise<SubprocessHandle>
```

Source: [`packages/subprocess/subprocess/src/index.ts`](../../packages/subprocess/subprocess/src/index.ts)

<a id="ctxsubprocesspty--subprocessptyruntime-abstract-seam"></a>

### `ctx.subprocessPty` — `SubprocessPtyRuntime` (abstract seam)

Optional PTY process service. Providers publish a handle only after terminal allocation has a positive process id and the complete session is owned. Service disposal terminates and joins every still-live handle.

```ts cordis-catalog
/**
 * Allocate a real terminal and start one owned process session.
 * @param spec - fully specified argv, cwd, environment, dimensions, grace, and allocation cancellation.
 * @returns the live terminal handle after allocation and ownership succeed.
 */
abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
```

Source: [`packages/subprocess/subprocess-pty/src/index.ts`](../../packages/subprocess/subprocess-pty/src/index.ts)
<!-- END GENERATED cordis-surface -->
