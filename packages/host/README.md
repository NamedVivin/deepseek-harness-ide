# host/ — GUI Host capabilities

English | [中文](README.zh.md)

Host-side GUI capabilities shared by browser and packaged desktop compositions: the transport-neutral API gateway, browser HTTP server, directory selection, and workspace access. Client packages live in [`client/`](../client/README.md); [`apps/cli`](../../apps/cli/README.md) composes the source Web application in [`apps/web`](../../apps/web/), while [`apps/desktop`](../../apps/desktop/README.md) assembles the packaged application. All are **product** packages.

| Package | Role | ctx key |
|---|---|---|
| [`apiproxy/`](apiproxy/README.md) | Shared host API gateway and wire contract | `ctx.apiProxy` |
| [`webserver/`](webserver/README.md) | HTTP route carrier | `ctx.webServer` |
| [`frontend-static/`](frontend-static/README.md) | SPA dist server on the webserver fallback seat | consumes `ctx.webServer` |
| [`directory-picker/`](directory-picker/README.md) | Workspace-directory picking seam | `ctx.directoryPicker` |
| [`directory-picker-native/`](directory-picker-native/README.md) | Native directory-picker backend and browser interaction | registers `ctx.directoryPicker` |
| [`directory-picker-browse/`](directory-picker-browse/README.md) | In-app directory-browser backend and interaction | registers `ctx.directoryPicker` |
| [`directory-picker-electron/`](directory-picker-electron/README.md) | Electron-main directory-picker backend for the desktop sidecar | registers `ctx.directoryPicker` |
| [`directory-picker-auto/`](directory-picker-auto/README.md) | Host-adaptive picker composition | mounts a backend |
| [`plugin-inventory/`](plugin-inventory/README.md) | Read-only projection of current Loader entries | Remote `pluginInventory/list` |
| [`workspace-files/`](workspace-files/README.md) | Bounded, workspace-scoped IDE file access | `ctx.workspaceFiles` |
| [`workspace-registration/`](workspace-registration/README.md) | Host-owned native pick and Workspace registration | `ctx.workspaceRegistration` |

`apiproxy` remains transport-independent; [`client/connection`](../client/connection/README.md) owns logical Connection behavior while its provider packages select Web or child IPC delivery. Picker implementations replace one another behind the shared seam.

The subsystem references: [web-server.md](../../docs/subsystems/web-server.md) and [workspace.md](../../docs/subsystems/workspace.md) (the picker seam).
