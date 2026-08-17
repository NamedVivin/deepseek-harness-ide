# @deepseek-ai/dsh-host-directory-picker-electron

English | [中文](README.zh.md)

Electron-main provider for the [directory-picker seam](../directory-picker/README.md). It registers the ordinary `native` `ctx.directoryPicker` capability in the Node sidecar, but forwards each pick through the separate `ctx.desktopHostBridge` Host-initiated channel. Electron main opens the native chooser and returns the selected absolute path only to the still-live Host request; the renderer cannot invoke this method or observe its result.

Caller cancellation is propagated to the bridge. Because Electron's native chooser has no abort handle, cancellation terminates the logical request and a later chooser result is discarded. The workspace-registration BFF performs the final liveness check before registering the path.

## Model Experience

None, as this Host capability provider registers no prompts, tools, messages, or model inputs.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The provider does not promise to close an already visible native chooser after cancellation.
- It is meaningful only in the packaged sidecar composition where Electron main supplies the Host-initiated bridge.
