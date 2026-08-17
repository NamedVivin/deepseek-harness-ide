# @deepseek-ai/dsh-host-workspace-registration

English | [中文](README.zh.md)

Host-owned BFF Remote for adding a desktop Workspace. `workspaceRegistration.pickAndRegister()` opens the configured native `ctx.directoryPicker`, consumes the selected path inside the Host, canonicalizes and registers it through `ctx.workspaceRegistry`, and returns the resulting Workspace projection. The renderer never supplies a path to this operation.

The operation is intentionally user-paced and has no package-level deadline. Caller cancellation propagates to the picker when supported and is checked again before registration and response publication, so a late chooser result cannot register a Workspace after its renderer request has ended. Cancellation, missing native capability, and registration failure use stable business results.

## Model Experience

None, as the native workspace-registration BFF registers no model-facing content.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The Remote registers one result from a native picker. Remote directory browsing and renderer-supplied path registration are outside this capability.
