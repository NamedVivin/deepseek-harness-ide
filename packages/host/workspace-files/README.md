# @deepseek-ai/dsh-host-workspace-files

English | [中文](README.zh.md)

Workspace-scoped file access for the IDE. `WorkspaceFilesGateway` registers the Host-only `workspaceFiles` service and publishes four Typert Remotes: `list`, `read`, `save`, and `resolveLocation`. Every request starts from a Host-issued `WorkspaceId`, resolves the current canonical root through `ctx.workspaceRegistry`, and performs filesystem work through the deployment's existing `ctx.fs` provider. The Renderer never supplies an authority-bearing root path.

`list({ workspaceId, directory })` accepts relative path segments and returns all direct children in stable name order. It calls the provider-side `listDirBounded()` operation, so an oversized directory fails after the provider observes one entry beyond `maxDirectoryEntries` instead of materializing the complete directory. A symbolic link or equivalent alias whose canonical target is outside the registered root is returned as an inert `blocked` entry.

`read({ workspaceId, path })` accepts a non-empty segment path to an existing regular file. The provider limits raw allocation to `maxTextFileBytes`; the gateway then requires valid UTF-8 without a NUL-byte binary sample. It captures filesystem metadata before the read, resolves the path again afterwards, and returns content with an opaque `WorkspaceFileVersion` only when the target identity and version stayed unchanged. A concurrent mutation returns `changed-during-read` instead of pairing old content with a new version.

`save({ workspaceId, path, content, expectedVersion })` replaces an existing regular file only. It checks the UTF-8 byte size, resolves and fences the target again immediately before the mutation, then calls `ctx.fs.writeText()` with `replaceIfVersion` and the explicit per-call policy `{ mode: 'workspace-write', workspaceRoot }`. A stale version returns `version-conflict`. There is no unconditional overwrite, force-save, file creation, rename, or delete method.

`resolveLocation({ workspaceId, location })` is the only operation that accepts an absolute or relative path candidate. It exists for model-facing `{ path, line? }` values, treats that value as untrusted, resolves relative paths from the registered root, rejects foreign path-family absolute forms and canonical escapes, and returns only canonical relative segments, current file kind, bounded-text eligibility, and an optional validated one-based line.

Segment operations reject empty components, `.`, `..`, NUL, embedded POSIX or Windows separators, drive-prefixed values, UNC spellings, and absolute paths. Stable business failures are `workspace-not-found`, `invalid-path`, `outside-workspace`, `not-found`, `not-directory`, `not-regular-file`, `not-text`, `too-large`, `permission-denied`, `changed-during-read`, and `version-conflict`. Cancellation and unexpected provider faults remain infrastructure failures.

Configuration fields:

- `maxTextFileBytes` — inclusive byte limit for one read or save; defaults to 10 MiB.
- `maxDirectoryEntries` — inclusive direct-child limit for one complete listing; defaults to 10,000.

The package exports client-safe payload types from `./types`. Typert generates the Host descriptor at `./typert` and the Client contribution at `./remote`; the selected Client assembly owns mounting that generated contribution.

## Model Experience

None, as this Host business Remote registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Existing text files only** — the first version does not create, rename, delete, watch, or search files.
- **No filesystem watcher** — changes are detected by read revalidation and compare-and-swap save. Client refresh behavior for clean buffers is owned by the IDE.
- **Cooperating-process linearization only** — editor and Harness file-tool mutations share the provider's per-target lock. Direct writes by shells or external applications can still race between the final canonical check and the operating-system mutation.
- **Canonical-check residual race** — the gateway blocks static aliases and replacements completed before its final containment check. It does not claim descriptor-relative protection against a trusted local process replacing an ancestor after that check.
