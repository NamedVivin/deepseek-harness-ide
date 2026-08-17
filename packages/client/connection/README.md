# @deepseek-ai/dsh-client-connection

English | [中文](README.zh.md)

Carrier-neutral Connection Service Definition and Consumer. The Host half provides `ctx.connection`: an effect-scoped logical RPC registry, target resolution, ApiProxy fallback, response delivery, and the `events.mux`/`events.host` sources. The Client half provides the shared connection handle, generation-scoped `hostDescription`, and single-consumer reconnect loop. Host and Client construction each require exactly one `connectionTransport` provider; the Web and desktop packages provide the physical carrier.

`ctx.connection.rpc.handle(channel, handler, { authority })` owns one dedicated channel. `ctx.connection.rpc.intercept('/api', matches, handler, { authority })` claims matching ApiProxy endpoints before fallback. Registration, route publication, and removal share the caller's Cordis effect. A carrier receives the resolved live target before business dispatch and must enforce its own closed authorization policy; a `loopback` registration also requires loopback caller authority in the core router.

The Client provider supplies `api`, generic `rpc`, and `isLoopback` through `ClientConnectionTransport`. The core `apply` consumes that provider and publishes one stable `ctx.connection` handle. Each successful readiness handshake publishes the exact `host.describe` value before `onConnected`; generation loss and explicit stop clear it.

## Model Experience

None, as Connection transports move already-composed protocol messages without adding model-visible input.

#### KV Cache effect

None; this package neither assembles nor sends provider requests.

## Known Limitations and Deferred Work

- Opening history may resume an unattached Host session; there is no persistence-only history read path.
