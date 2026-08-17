# @deepseek-ai/dsh-client-ui-directory-picker-desktop

English | [中文](README.zh.md)

Renderless desktop occupant for ui-workspace's two directory-flow slots. Each open request calls `workspaceRegistration.pickAndRegister()` and passes the Host-issued Workspace directly to the slot owner. It never sends a filesystem path to `workspace.create`.

Closing or disposing the flow aborts the Remote request. A late native chooser result is ignored by both this Client occupant and the Host BFF, while a normal chooser cancellation closes the flow without an error dialog.

## Model Experience

None, as the desktop workspace-registration flow registers no model-facing content.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The flow requires the desktop workspace-registration Remote; it provides no browser fallback or renderer-side path entry.
