# @deepseek-ai/dsh-client-connection-web

English | [中文](README.zh.md)

Web provider for `@deepseek-ai/dsh-client-connection`. Its Host half binds the logical registry to HTTP POST routes, the `/api/respond` response route, and downlink-only WebSockets for `events.mux` and `events.host`. Its Client half provides `WebApiClient`, generic fetch RPC, loopback classification, and the explicit `?fixture` test mode. The Web bundle selects this package in the `connection-transport` row and mounts the carrier-neutral package separately in the `connection` row.

## Browser trust fence

Every HTTP route and WebSocket upgrade requires a `Host` authority that is loopback or listed in `trustedHosts`. Entries are canonical bare `host[:port]` authorities; a malformed entry fails at load. Browser `Origin` must match the Host authority when present, and explicit cross-site Fetch Metadata is rejected. This is a reachability policy, not authentication. Configuration, credential, native Host, model-discovery, and agent-preset authoring methods remain loopback-only even for a declared LAN authority.

`maxRequestBodyBytes` defaults to 160 MiB. The provider fails at load when the configured limit cannot hold the attachment service's aggregate image limit after base64 expansion and envelope headroom. The bridge buffers one complete JSON request before dispatch.

## Downlinks

`/api/events.mux` and `/api/events.host` each accept one downlink-only WebSocket. Any client message closes that socket as a policy violation. Source failure sends one `stream/error` envelope before closure; socket or provider teardown aborts the source and waits for its pump. Ordinary HTTP GETs to either path return 426.

## Model Experience

None, as the Web carrier does not add model-visible input.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The Web trust fence does not authenticate a remote user; non-loopback deployments need a separate authentication design.
- The HTTP bridge buffers each request body in memory, so its configured body limit is also the per-request resident bound.
