# @deepseek-ai/dsh-client-connection-desktop

English | [中文](README.zh.md)

Typed desktop provider for `@deepseek-ai/dsh-client-connection`. The sidecar mounts `ChildProcessDesktopIpcAdapter`; Electron main mounts `DesktopMainIpcPeer` over a semantic child-IPC endpoint. The peer implements the narrow `DesktopRendererBridge` consumed by the preload Client provider: unary `invoke`, closed `system`, and the two `subscribe` streams. The desktop bundle selects this package in the `connection-transport` row.

Electron main imports the Node values from `./adapter`, creates the peer over the app-owned JSON guardian endpoint, and supplies the closed `DesktopMainHandlers` table. Protocol-only consumers use `./protocol` and framing consumers use `./wire`, so they do not load the Cordis provider at the package root. The sidecar uses `createNodeChildProcessEndpoint(process)` over its same-Node advanced IPC channel. The sandboxed preload exposes only the frozen `DesktopPreloadApi` function table; the renderer main world reconstructs `DesktopRendererBridge` and `DesktopRendererLifecycleHost` so neither `AbortSignal`, `AsyncIterable`, raw Electron channels, physical frames, nor endpoint send methods cross context isolation.

## Typed method sets

The three method sets are independent. Renderer ApiProxy calls pass `DESKTOP_RENDERER_API_METHODS`; `session.create` additionally accepts only a non-empty `workspaceId`, optional string `sessionId`, and absent or `desktop-default` `agentPreset`. `DesktopRendererSystemMethodMap` contains only `desktop.bootManifest`, which returns `ctx.clientModules.graph()` without entering ApiProxy dispatch. `HostInitiatedMethodMap` contains only `directory.pick`; sidecar Host code calls `ctx.desktopHostBridge.request('directory.pick', {}, signal)` and receives `{ path: string | null }`. Cancellation and disconnect terminate all three request classes.

The app-owned renderer lifecycle table is separate again. `DesktopMainToRendererBridge` and `DesktopRendererLifecycleHost` define only `desktop.prepareQuit`, returning `{ ready }` after the renderer resolves dirty state. `DesktopPortHandoff` carries only the validated body limits with the transferred port, while `DesktopPreloadStreamEnd` represents callback-stream completion. None of these requests pass through the sidecar.

## Body framing and limits

Request, response, Host-capability, and downlink-event bodies are encoded as UTF-8 JSON. Control frames carry only correlation metadata and `bodyId`; physical bodies use `body-start`, ordered bounded `body-chunk`, `body-ack`, `body-end`, and `body-cancel`. One hop-wide credit pool bounds unacknowledged bytes across every concurrent body instead of multiplying a per-request window.

`DesktopBodyFrame` keeps each semantic `body-chunk` as a `Uint8Array`, including across the Electron MessagePort and the same-Node guardian-to-sidecar channel. The application owns any encoding required by a physical parent channel; its JSON Electron-to-guardian adapter carries chunks in a separate base64 envelope and restores the semantic frame before this package parses it.

`maxDesktopBodyBytes`, `maxDesktopChunkBytes`, and `maxDesktopInflightBytes` default to 160 MiB, 1 MiB, and 16 MiB. Values must be positive safe integers, and the chunk limit must not exceed the in-flight limit. The provider fails at load if the body limit cannot hold the current 10 MiB text-file limit under worst-case JSON escaping or the configured aggregate image limit after base64 expansion and envelope headroom. Sender and receiver both reject oversized bodies; out-of-order, duplicated, malformed, and mismatched acknowledgement frames make the peer terminal.

## Model Experience

None, as the desktop carrier changes physical delivery only.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- This package implements the Electron-main-to-sidecar peer and the context-isolation-safe public types. `apps/desktop` owns the persistent MessagePort binding, renderer destruction, and the `desktop.prepareQuit` request handler.
- Each endpoint reassembles one validated JSON body before schema dispatch; the aggregate body limit is therefore also a per-body resident bound.
