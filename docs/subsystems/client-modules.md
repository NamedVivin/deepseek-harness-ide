# Client Modules

English | [中文](client-modules.zh.md)

The carrier-neutral Client plugin table in [dsh-client-modules](../../packages/client/modules), provided as `ctx.clientModules` (`ClientModuleRegistry`). It scans Host Loader entries declaring `dsh.client`, hashes their browser bundles, and composes one revisioned dependency graph. Exactly one `ctx.clientModuleDelivery` provider supplies physical URLs and installs the graph on its carrier: [dsh-client-modules-web](../../packages/client/modules-web) consumes [dsh-host-webserver](../../packages/host/webserver) to own HTTP routes and index injection, while [dsh-client-modules-desktop](../../packages/client/modules-desktop) owns immutable `dsh-app://` URLs resolved against the packaged manifest. This optional GUI capability is not part of the agent-loop spine. The renderer half (`ctx.modules`) remains the only code loader and is documented in the [package README](../../packages/client/modules/README.md).

Source: [`packages/client/modules/src/index.ts`](../../packages/client/modules/src/index.ts)

## The wire

The graph is the wire single source between the Host and renderer halves. The Host composes `WebBootEntry` rows from scanned packages and the selected delivery provider assigns each row's URL. Web publishes it as a `global` injection row rendered before later script rows (`globalThis["__DSH_BOOT__"]`, with `<` escaped so plugin-controlled strings cannot break out of the script element); desktop obtains the same graph through the closed `desktop.bootManifest` IPC method before boot. The shell parses the manifest before loading any Client bundle and throws loud when it is missing or malformed.

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

Each row's `rev` is the bundle's content hash and rides the carrier URL; the graph `rev` hashes the composed rows, so any row change changes it. `immediately` marks the stage-one prefetch tier (fetch and execute during module-face boot, registration only); a lazy row is fetched on first import.

## The scan

A package joins the table by declaring `dsh.client` (`platform: 'web'`, optional `inject` edges, optional `immediately`) in its package.json and exporting its built bundle at `exports["./client"]`. Package resolution anchors at the config tree's `ctx.baseUrl` — the cordis.yml directory, whose package declares every composed plugin as a dependency — and construction throws when that anchor is unset.

Scanning is incremental per package; there is no full-rescan code path. Every cordis `internal/plugin` emission (fiber construction or disposal) marks the fiber's entry name dirty, and a microtask flush reconciles each dirty name against the live loader entries. The activation pass seeds the same dirty set with all current entries and flushes synchronously, so first scan and steady state share one implementation — with opposite failure postures. At activation, a malformed declaration or missing bundle among the already-loaded entries aggregates into one loud `AggregateError` listing every broken package: the fiber FAILS and the boot's fail-loud sweep reports it. In steady state, a broken package logs a warning and must not poison the others.

Package metadata — including the negative "not a client package" verdict — is cached per name and never expires: plugin-set changes take effect on restart. A fiber restart reuses its row and rev untouched; bundle content changes reach the graph only through `rebuilt()`.

## Delivery providers

The Web provider serves `GET`/`HEAD /plugins/<id>/client.js` from disk with `no-cache` (the rev query, not HTTP caching, anchors consistency), returns 405 for other methods, and injects the current graph on every index render. Unknown ids and unreadable registered bundles return a loud 404. The desktop provider emits `dsh-app://plugins/<id>/client.js?rev=<rev>` and resolves only an exact current-graph URL; Electron then maps that URL through the separately hashed packaged resource manifest. Traversal, stale revisions, unreadable bundles, and delivery-provider duplication fail closed.

## The service

`ClientModuleRegistry` (`ctx.clientModules`, defined in [`packages/client/modules/src/index.ts`](../../packages/client/modules/src/index.ts)) exposes reads and the rebuild face; signatures are in the generated [service catalog](#ctxclientmodules--clientmoduleregistry). `graph()` returns the current composed graph (a stable object between changes) and `clientPath(id)` the bundle's absolute path. `rebuilt(id)` is the only entry point through which bundle content reaches the graph: it re-hashes the file, and only a real rev change recomposes the graph and notifies. `onRebuilt` fires per changed bundle with the new rev; `onGraphChanged` fires after any flush that recomposed the graph (row added or removed, or a rebuilt rev change) and is pull-model — listeners re-read `graph()`. Both notification paths contain listener exceptions so one throwing subscriber cannot skip later subscribers or kill whatever triggered the flush.

In development, [dsh-client-hmr](../../packages/client/hmr/README.md) is the registry's watch driver: its node half stat-polls every graph row's bundle from a synchronously captured baseline, calls `rebuilt(id)` on change, resyncs its watch set through `onGraphChanged`, and broadcasts rev changes to the browser half over SSE. Production graphs omit the HMR row entirely; the module host itself never watches files.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
