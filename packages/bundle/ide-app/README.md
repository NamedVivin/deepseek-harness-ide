# @deepseek-ai/dsh-ide-app

English | [中文](README.zh.md)

Profile patch layer that adds IDE capabilities over `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`. It mounts the Host-owned bounded `workspaceFiles` Remote with a 10 MiB text limit and a 10,000-entry directory limit, then mounts `@deepseek-ai/dsh-client-ui-ide` as the workspace file tree, CodeMirror editor, Markdown preview, compare-and-swap conflict surface, and internal handler for supported Agent-produced file locations.

This bundle deliberately selects no connection carrier or module-delivery provider. The shipped source `ide` profile composes `[dsh-base, dsh-web-app, dsh-ide-app]`, so browser development uses the Web carrier. Desktop composition replaces carrier-specific rows without changing this IDE capability layer.

The package has no runtime API. Its public artifact is `cordis.patch.yml`, declared by `dsh.bundle.patch` in `package.json`.

## Model Experience

None, as the Host/Client workspace-file capability registers no prompts, tools, messages, or provider requests.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The Client surface edits existing regular UTF-8 files only; file creation, filesystem watching, LSP, and durable unsaved-buffer recovery are deferred.
- Desktop transport, native directory registration, preset admission, and guardian subprocess ownership are outside this bundle and belong to desktop composition.
