# dsh-desktop

English | [中文](README.zh.md)

The installable DeepSeek Harness IDE. Electron owns the signed window, native chooser, local `dsh-app://` resources, and bounded application lifecycle. A bundled pure Node.js 24 runtime starts the Cordis Host sidecar and the guardian that owns every generic subprocess; the packaged application opens no TCP listener and does not require a system Node.js or pnpm installation.

## Runtime assembly

The sidecar composes `dsh-base`, `dsh-web-app`, `dsh-ide-app`, and `dsh-desktop-app` over the checked-in empty root. The desktop layer replaces the Web connection and module-delivery providers, native directory picker, mutable preset roster, and direct subprocess provider. Bare Cordis rows resolve only from the packaged Host closure; profile directories and user plugin roots do not participate in desktop code resolution. Before the first window opens, Electron verifies every signed resource path, regular-file status, byte limit, and SHA-256 digest, then restricts Client bundle requests to the exact live sidecar graph.

The sandboxed preload exposes only the versioned desktop Connection bridge and the app-owned prepare-quit exchange. The renderer has context isolation, no Node integration, no navigation or new-window permission, no network CSP capability, and no arbitrary path or process method.

Electron main and the bundled Node.js guardian communicate through JSON child IPC because their executables may embed different V8 serialization versions. An app-owned codec converts only bounded Connection body chunks to exact-field, canonical-base64 envelopes and validates the declared decoded length before allocating decoded bytes; lifecycle and ownership-control messages remain ordinary JSON values. The guardian starts the sidecar with same-Node advanced IPC, which retains binary guardian stream frames without crossing a V8-version boundary.

## Packaging

Electron Forge produces DMG and ZIP outputs on native macOS arm64/x64 runners and Squirrel Setup plus ZIP on native Windows x64. The application invokes the pinned Forge core API directly, enables restrictive Electron fuses, and keeps the pure Node Host closure outside ASAR. Packaging requires `DSH_DESKTOP_ELECTRON_ZIP_DIR` to identify a directory containing the exact target archive for Electron `43.2.0` and `DSH_DESKTOP_ELECTRON_SHASUMS` to identify the official checksum list; assembly verifies the archive and extracts the Electron and Chromium licenses from those same bytes. Forge never resolves Electron distribution bytes from the network. Release jobs provide signing, timestamping, notarization, and stapling credentials; unsigned local packages are development artifacts and are not releasable.

### Native candidate workflow

The [Desktop Artifacts workflow](../../.github/workflows/desktop-artifacts.yml) builds each target on its native GitHub-hosted runner. Every job downloads the exact official Node.js `v24.16.0` archive and checksum list from `nodejs.org` plus the exact Electron `43.2.0` archive and checksum list from the official GitHub release, verifies both archives before extraction or packaging, runs the deterministic assembly and Forge maker, executes the bundled Node identity probe, checks the closed Host and Client payload, and uploads the candidate bytes without publishing them.

| Target | Native runner | Candidate outputs | Native verification |
| --- | --- | --- | --- |
| macOS arm64 | `macos-15` | DMG and ZIP | Single-architecture Mach-O payloads, application/DMG signature and Gatekeeper assessment, hardened runtime, app/DMG notarization tickets, cold/replacement/forced lifecycle smoke, zero TCP listeners, and data retention. |
| macOS x64 | `macos-15-intel` | DMG and ZIP | The same checks on native Intel hardware; no universal merge. |
| Windows x64 | `windows-2025` | Squirrel Setup, portable ZIP, full NuGet package, and `RELEASES` index | Squirrel index integrity, Authenticode signatures and timestamps on Setup and executable payloads in both application copies, portable/installed/forced lifecycle smoke, lifecycle-only invocations, zero TCP listeners, install/upgrade/uninstall, and data retention. |

Every installed application carries the project `LICENSE`, the generated `THIRD_PARTY_NOTICES.md`, and the original Electron/Chromium, Node.js, ripgrep, and Koffi license files under `desktop-resources/`. The notice also identifies the first-party macOS process capsule. Assembly and final-archive checks fail when any required notice or license file is absent, empty, or stale for the pinned Electron and Node.js releases.

Pull requests and master pushes use `unsigned` mode: they build native installer layouts, probe packaged resources, and run lifecycle checks, but do not claim that an operating-system trust check passed. A manual `signed` run additionally requires all platform credentials and fails closed when any credential is absent. macOS uses `APPLE_CERTIFICATE_P12_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGN_IDENTITY`, `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. Windows uses `WINDOWS_CERTIFICATE_PFX_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD`; `windows_baseline_run_id` must identify a lower-version signed-candidate run so the native smoke performs a real upgrade rather than reinstalling identical bytes.

The workflow has no release-creation or asset-publication job, and the uploaded seven-day artifacts are candidate evidence only. The ordinary `dsh` npm release holds `@deepseek-ai/dsh-desktop` while publishing the rest of the family unless the operator supplies a successful signed workflow run id for the same release commit. The credentialed release job verifies the workflow identity, commit, manual event, complete job response, and exact three signed native jobs before promoting that npm package. This gate does not publish installer assets; installer publication remains unwired.

`pnpm run verify:artifacts -- --target <macos-arm64|macos-x64|windows-x64> --out out` performs the platform-local payload check after `pnpm run make`. The macOS and Windows verification scripts then inspect the final archive contents instead of trusting the unpacked Forge directory.

## Model Experience

### Desktop coding agent

#### What the model sees

The immutable `desktop-default` coding persona and its filesystem, shell, search, edit, job, skill, question, and todo tools. The Electron and IPC implementation is not model-visible.

#### Token effect

Fixed for a selected model and workspace: the desktop persona, tool schemas, repository instructions, and loaded skill descriptions. Desktop transport metadata adds no prompt tokens.

#### KV Cache effect

Stable during a session because every packaged desktop Agent is admitted into the same fixed preset before publication.

## Known Limitations and Deferred Work

- Crash recovery for unsaved editor buffers is not provided; orderly tab, workspace, and application close paths require save, discard, or cancel.
- Windows arm64, automatic updates, third-party renderer plugins, interactive PTY terminals, and user-authored desktop presets are not supported in the first release.
- Signed and notarized installers can be verified only on the native release runners holding the platform credentials.
