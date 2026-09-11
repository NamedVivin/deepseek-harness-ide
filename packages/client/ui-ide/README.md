# @deepseek-ai/dsh-client-ui-ide

English | [中文](README.zh.md)

Workspace-scoped IDE Client plugin. It contributes an editor pane to the root-scoped `shell.editor` slot and an icon-only editor action to the root-scoped `conversation.header.utilities` slot. The pane's root store remains mounted while the layout closes its column, so open tabs, dirty buffers, save state, and conflict recovery remain intact. The header action is available before any Session exists. When space permits, the editor and conversation occupy adjacent columns separated by a draggable divider; when even a collapsed sidebar rail cannot retain both minimum panes, the editor takes the content area beside that rail. Viewports at or below 900px always use this exclusive posture. The editor header provides the close action.

The file explorer selects a Host-issued `WorkspaceId` from the standard `useWorkspaces` projection and sends only that id plus canonical relative path segments to `ctx.remote.workspaceFiles`. It lazily requests direct children through the Host-bounded `list` operation. It never uses the Workspace's client-visible absolute path as file authority. Blocked links and unsupported filesystem objects remain inert.

The plugin registers an effect-scoped `ClientFileOpener` handler for Agent-produced locations. It maps the request's session to its registered Workspace, passes the complete `{ path, line? }` candidate to Host `resolveLocation`, and claims only a supported regular text file. A claimed location opens or reuses its tab through the same root store, opens the editor column, and focuses the validated line after reading. A dirty Workspace change still requires the normal save, discard, or cancel choice. Unregistered, rejected, and unsupported locations return `unhandled` to the owner-controlled carrier fallback; this package never calls an arbitrary-path opener.

Opening a regular UTF-8 file creates or reuses a tab identified by `(workspaceId, pathSegments)`. CodeMirror 6 edits the in-memory buffer, activates common language parsers per mounted file extension, supports Cmd/Ctrl+S and Cmd/Ctrl+W, and keeps the buffer in the shared root store. Markdown tabs switch between source and the existing sanitized `MarkdownText` pipeline; preview always renders the unsaved buffer. Workspace-relative images remain unsupported because no bounded asset resolver exists.

Every save snapshots the current buffer, opaque base version, and monotonically increasing local revision before calling the Host compare-and-swap operation. An acknowledgement advances the base content and version, but clears dirty state only when no newer edit occurred. Transport and policy failures preserve the buffer. A version conflict reads and retains the latest disk content beside the local buffer and offers exactly three actions: continue editing, reload the displayed disk version after confirmation, or compare-and-swap the local buffer against that displayed version. A second intervening write produces another conflict; there is no unconditional overwrite operation.

Closing a dirty tab and switching Workspace while dirty tabs exist use explicit save, discard, or cancel dialogs. Closing the editor column to return to the conversation is not a tab close and never prompts or discards a buffer. Unsaved buffers are transient in the first release and can be lost if the process crashes.

The `/client` entry exports only `apply`, `inject`, the shared store factory, and the composed props/injected-face types required by slot registration. Components and reducer helpers stay package-internal and tests import them through `./src/*`.

## Model Experience

None, as the editor adds no prompt sections, tools, model-visible messages, or provider inputs.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The first release edits existing regular UTF-8 files only. It does not create, rename, move, delete, watch, globally search, run Git UI, or expose an interactive terminal.
- Language support provides syntax parsing for common Web, JSON, Markdown, CSS, HTML, and Python files; LSP completion and diagnostics are not included.
- Closing the editor column preserves transient tab state, but crash recovery and durable drafts are deferred.
- Dirty-tab prompts cover tab close and Workspace changes. Packaged-application quit interception belongs to the desktop shell lifecycle.
