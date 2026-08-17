# @deepseek-ai/dsh-client-modules-desktop

English | [中文](README.zh.md)

Desktop provider for the carrier-neutral Client module registry. It advertises immutable `dsh-app://plugins/<id>/client.js?rev=<revision>` URLs and resolves only URLs that exactly match a row in the current Host-produced boot manifest.

Exact matching rejects traversal, unlisted bundles, and revision mismatches before Electron maps a request to a packaged path. The provider does not execute bundles through preload; the existing renderer `ClientModuleSystem` remains the only loader.

## Model Experience

None, as desktop Client bundle delivery registers no model-facing content.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The provider requires Electron main to map its advertised URLs through the packaged resource manifest; it cannot deliver source-tree or remotely supplied bundles.
