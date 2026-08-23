# Client 模块

[English](client-modules.md) | 中文

[dsh-client-modules](../../packages/client/modules) 中载体中立的 Client 插件表，以 `ctx.clientModules`（`ClientModuleRegistry`）形式提供。它扫描声明了 `dsh.client` 的 Host Loader entry，为浏览器 bundle 计算哈希，并组合一份带 revision 的依赖图。必须且只能有一个 `ctx.clientModuleDelivery` 提供方负责物理 URL 并在对应载体上安装该图：[dsh-client-modules-web](../../packages/client/modules-web) 消费 [dsh-host-webserver](../../packages/host/webserver) 并持有 HTTP 路由与 index 注入，[dsh-client-modules-desktop](../../packages/client/modules-desktop) 则负责根据打包 manifest 解析不可变 `dsh-app://` URL。这项 GUI 能力是可选的，不属于 agent loop 主干。renderer 半（`ctx.modules`）仍是唯一代码 loader，记录在[包 README](../../packages/client/modules/README.zh.md)中。

源码：[`packages/client/modules/src/index.ts`](../../packages/client/modules/src/index.ts)

## wire

图是 Host 半与 renderer 半之间协议层的唯一真源。Host 从扫描到的包组合出 `WebBootEntry` 行，再由选定的交付提供方分配各行 URL。Web 把图发布为一条 `global` 注入行、渲染在后续 script 行之前（`globalThis["__DSH_BOOT__"]`，其中 `<` 已转义，插件可控的字符串因此无法逃出 script 元素）；desktop 则在启动前通过闭合的 `desktop.bootManifest` IPC method 取得同一份图。shell 会在加载任何 Client bundle 前解析 manifest，缺失或畸形时大声抛错。

```ts type-equiv
/**
 * One composed client entry pushed by the host (a graph row). Wire
 * single source: the host node half (package root) produces this same shape.
 * `immediately` marks stage-one prefetch; `inject` is informational graph
 * metadata (the authoritative edges live in each package's `dsh.client`
 * declaration and reach fibers through entry creation). `external` carries
 * module-graph edges: unlike `inject`, they constrain code arrival because
 * `require` is synchronous (see {@link WebBootGraph.entries}).
 */
interface WebBootEntry {
  /** Entry name == package name. */
  id: string
  /** Bundle endpoint, '/plugins/<id>/client.js?rev=<rev>'. */
  url: string
  /** Bundle content hash (cache-busting consistency anchor). */
  rev: string
  /** Package-name dependency edges, informational (preflight display / HMR diffing). */
  inject?: string[]
  /** Stage-one prefetch mark: load the script for factory registration during module-face boot. */
  immediately?: boolean
  /** Non-baseline module specifiers this row requests; omitted when it requests none. */
  external?: string[]
}
```

```ts type-equiv
/** The composed client entry graph the host injects as `window.__DSH_BOOT__`. */
interface WebBootGraph {
  /** Consistency anchor over the whole graph (content + bundle hashes). */
  rev: string
  /**
   * Composed entries in module-graph order — a dynamic package row precedes
   * rows whose `external` requests that package. Cordis activation order is
   * unrelated and remains owned by fiber service waiting.
   */
  entries: WebBootEntry[]
}
```

每一行的 `rev` 是该 bundle 的内容哈希，并附在载体 URL 上；图的 `rev` 对组合后的各行做哈希，因此任何一行的变化都会改变它。`immediately` 标记第一阶段预取档位（在模块面启动期间 fetch 并执行，只做登记）；惰性行在首次 import 时才拉取。

## 扫描

包加入这张表的方式，是在自己的 package.json 中声明 `dsh.client`（`platform: 'web'`、可选的 `inject` 边、可选的 `immediately`），并在 `exports["./client"]` 导出构建好的 bundle。包解析锚定在配置树的 `ctx.baseUrl`——即 cordis.yml 所在目录，该目录的包把每个被组合的插件声明为依赖——这一锚点未设置时，构造即抛错。

扫描是单包增量的；不存在全量重扫代码路径。fiber 构造或 dispose（资源释放）时的每次 cordis `internal/plugin` 发射都把该 fiber 的 entry 名标脏，一次微任务 flush 把每个脏名与实时 loader entry 对账。激活趟以全部当前 entry 灌入同一个脏集合并同步 flush，因此初扫与稳态共享一条实现——但失败姿态相反。激活时，已加载 entry 中的畸形声明或缺失 bundle 会聚合为一个大声的 `AggregateError`，列出每个损坏的包：该 fiber 进入 FAILED，由启动的大声失败 sweep 上报。稳态下，损坏的包只记录一条警告，且不得殃及其他包。

包元数据——包括「非 client 包」这一否定结论——按名缓存且永不过期：插件集合的变更在重启后生效。fiber 重启原样复用其行与 rev；bundle 内容变更只经 `rebuilt()` 到达图。

## 交付提供方

Web 提供方以 `no-cache` 从磁盘提供 `GET`/`HEAD /plugins/<id>/client.js`（锚定一致性的是 rev 查询参数，而非 HTTP 缓存），其他 method 返回 405，并在每次 index 渲染时注入当前图。未知 id 与不可读的已注册 bundle 会大声返回 404。desktop 提供方生成 `dsh-app://plugins/<id>/client.js?rev=<rev>`，且只解析与当前图完全一致的 URL；Electron 随后再通过单独计算哈希的打包资源 manifest 映射该 URL。路径穿越、过期 revision、不可读 bundle 与重复交付提供方都会大声失败。

## 服务

`ClientModuleRegistry`（`ctx.clientModules`，定义于 [`packages/client/modules/src/index.ts`](../../packages/client/modules/src/index.ts)）暴露读取面与重建面；签名见生成的[服务目录](#ctxclientmodules--clientmoduleregistry)。`graph()` 返回当前组合出的图（两次变更之间是同一个稳定对象），`clientPath(id)` 返回该 bundle 的绝对路径。`rebuilt(id)` 是 bundle 内容到达图的唯一入口：它对文件重新哈希，只有 rev 真正变化才会重新组合图并发出通知。`onRebuilt` 按发生变化的 bundle 逐个触发并携带新 rev；`onGraphChanged` 在任何一次重新组合了图的 flush 之后触发（行的增删，或 rebuilt 带来的 rev 变化），并采用拉取模型——监听器自行重读 `graph()`。两条通知路径都会兜住监听器异常，因此一个抛错的订阅者既不能让后续订阅者被跳过，也不能杀死触发这次 flush 的一方。

开发环境下，[dsh-client-hmr](../../packages/client/hmr/README.zh.md) 是注册表的监视驱动：它的 Node 半从同步取得的基线出发，对图中每一行的 bundle 做 stat 轮询，变化时调用 `rebuilt(id)`，经 `onGraphChanged` 重新同步监视集合，并通过 SSE（Server-Sent Events）把 rev 变化广播给浏览器半。生产环境的图完全不含 HMR（热模块替换）行；模块宿主自身从不监视文件。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxclientmoduledelivery--clientmoduledelivery-abstract-seam"></a>

### `ctx.clientModuleDelivery` — `ClientModuleDelivery` (abstract seam)

Service Definition implemented by Web and desktop module-delivery providers.

```ts cordis-catalog
/**
 * Produce the immutable URL advertised for one bundle revision.
 * @param id - Client package id.
 * @param revision - content revision.
 * @returns carrier URL placed in the shared boot manifest.
 */
abstract bundleUrl(id: string, revision: string): string

/**
 * Attach physical delivery to the composed registry.
 * @param host - read-only graph and bundle-path source.
 * @returns disposer for routes, protocol mapping, or retained state.
 */
abstract install(host: ClientModuleDeliveryHost): () => void

/**
 * Resolve an exact advertised URL to a bundle path.
 * @param url - untrusted physical asset URL.
 * @returns the matched bundle path, or undefined when it is not currently advertised.
 */
abstract resolveBundleUrl(url: string): string | undefined
```

Source: [`packages/client/modules/src/delivery.ts`](../../packages/client/modules/src/delivery.ts)

<a id="ctxclientmodules--clientmoduleregistry"></a>

### `ctx.clientModules` — `ClientModuleRegistry`

Incremental `dsh.client` scan and carrier-neutral wire composition. Construction runs the activation scan synchronously — a malformed declaration or missing bundle among the already-loaded entries aggregates into one loud throw (FAILED fiber; the boot activation audit reports it).

```ts cordis-catalog
/**
 * Current composed entry graph (stable object between changes).
 * @returns the graph served as `window.__DSH_BOOT__`.
 */
graph(): WebBootGraph

/**
 * Absolute path of an entry's client bundle.
 * @param id - entry id (package name).
 * @returns the path, or undefined for an unknown id.
 */
clientPath(id: string): string | undefined

/**
 * Re-hash one bundle (the HMR watch's registration hook — the only entry
 * point through which bundle content changes reach the graph).
 * @param id - entry id (package name).
 * @returns the new rev, or undefined for an unknown id.
 */
rebuilt(id: string): string | undefined

/**
 * Subscribe to bundle rebuilds; fires only when the re-hash changed the rev.
 * @param listener - receives the entry id and its new bundle rev.
 * @returns the unsubscriber.
 */
onRebuilt(listener: (id: string, rev: string) => void): () => void

/**
 * Fires after any flush that recomposed the graph (row added/removed, or a
 * rebuilt rev change). Pull model: listeners re-read {@link graph}.
 * @param listener - notified with no payload.
 * @returns the unsubscriber.
 */
onGraphChanged(listener: () => void): () => void
```

Source: [`packages/client/modules/src/index.ts`](../../packages/client/modules/src/index.ts)

<a id="ctxconnection--hostconnectionhandle"></a>

### `ctx.connection` — `HostConnectionHandle`

Host `ctx.connection` shape consumed by transport-independent adapters.

Source: [`packages/client/connection/src/rpc.ts`](../../packages/client/connection/src/rpc.ts)

<a id="ctxconnectiontransport--hostconnectiontransport-abstract-seam"></a>

### `ctx.connectionTransport` — `HostConnectionTransport` (abstract seam)

Service Definition implemented by the Web and desktop Connection providers.

```ts cordis-catalog
/**
 * Attach physical routes or IPC handlers to the core router.
 * @param host - carrier-neutral request and event owner.
 * @returns disposer that reaches transport quiescence.
 */
abstract install(host: HostConnectionTransportHost): () => void | Promise<void>
```

Source: [`packages/client/connection/src/transport.ts`](../../packages/client/connection/src/transport.ts)

<a id="ctxdesktophostbridge--desktophostbridge"></a>

### `ctx.desktopHostBridge` — `DesktopHostBridge`

Sidecar-to-Electron main capability service with a closed method map.

```ts cordis-catalog
/**
 * Invoke one Electron-main capability.
 * @param method - closed Host-initiated method name.
 * @param payload - method-derived request payload.
 * @param signal - optional caller cancellation propagated to main.
 * @returns method-derived response after IPC validation.
 */
request<K extends keyof HostInitiatedMethodMap>( method: K, payload: HostInitiatedRequest<K>, signal?: AbortSignal, ): Promise<HostInitiatedResponse<K>>
```

Source: [`packages/client/connection-desktop/src/index.ts`](../../packages/client/connection-desktop/src/index.ts)
<!-- END GENERATED cordis-surface -->
