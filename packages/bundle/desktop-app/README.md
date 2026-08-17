# @deepseek-ai/dsh-desktop-app

English | [中文](README.zh.md)

Packaged-desktop patch layer over `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, and `@deepseek-ai/dsh-ide-app`. It keeps the carrier-neutral connection and Client-module graph, replaces their physical providers with child IPC and immutable `dsh-app://` delivery, replaces the native directory picker with the Electron-main bridge, and replaces direct local subprocess creation with guardian ownership. Web startup, HTTP serving, Web runtime delivery, Client HMR, and dynamic Cordis authoring are disabled, so the assembled desktop Host opens no listener and evaluates no runtime-supplied Client code.

The layer mounts the Host-owned workspace-registration Remote and its desktop Client flow. It also pins `agent-presets` to the package-owned `desktop-default` roster, disables user roots and authoring, installs the desktop admission provider, and hides preset switching. The Node sidecar provides `desktopRuntime.presetRoot` before Loader activation; no renderer value can choose this path.

The package has no runtime API. Its public artifact is `cordis.patch.yml`, declared by `dsh.bundle.patch` in `package.json`.

## Model Experience

Indirectly, through the fixed `desktop-default` preset and its filesystem and shell consumers.

#### KV Cache effect

The fixed preset makes the tool and instruction roster stable across desktop sessions. Workspace-specific runtime context still varies normally.

## Known Limitations and Deferred Work

- The first desktop release does not expose user-authored presets, preset switching, interactive terminals, or third-party Client bundles.
- Signing, notarization, installer construction, and native target smoke tests belong to `apps/desktop` and the release workflow, not this patch carrier.
