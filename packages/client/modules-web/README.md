# @deepseek-ai/dsh-client-modules-web

English | [中文](README.zh.md)

Web provider for the carrier-neutral Client module registry. It advertises revisioned `/plugins/<id>/client.js` URLs, serves registered bundles and source maps through `ctx.webServer`, and injects the current shared boot manifest before the browser shell executes.

This package exclusively owns physical Web delivery. Discovery, dependency edges, revisions, and the Client module system remain in `@deepseek-ai/dsh-client-modules`.

## Model Experience

None, as Web Client bundle delivery registers no model-facing content.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The provider requires an HTTP `WebServer` and index-rendering carrier; non-HTTP compositions must select another delivery provider.
