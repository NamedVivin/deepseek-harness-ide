# dsh-agent-presets-desktop

English | [中文](README.zh.md)

The fixed first-release Agent roster for the packaged desktop application. The package ships one system preset, `desktop-default`, validates that it is the only configured root entry at startup, and registers an effect-scoped admission policy that rejects every other preset before discovery or composition.

## Composition and admission

The desktop application configures [`dsh-agent-presets`](../agent-presets/README.md) with `DESKTOP_PRESET_ROOT`, `default: desktop-default`, and `includeUserRoot: false`, then mounts this provider. Startup fails with `DesktopPresetStartupError` if the live service exposes another root, preset, default, authoring path, plugin row, or an `fs`, `subprocess`, `subprocessPty`, or `terminals` isolate. A second live provider instance also fails startup.

`desktop-default` mounts the ordinary Bash/PowerShell, filesystem, search, string-replace, job, skill, question, and todo consumers. It inherits the Host's exact `ctx.fs` and `ctx.subprocess` services and contains no filesystem provider, subprocess provider, PTY service, persistent-terminal consumer, or provider-owning isolate. This keeps editor saves and Harness file tools on the same Host filesystem authority while ordinary shell tools use the desktop guardian provider selected by the application.

The provider contributes through `ctx.agentPresets.registerAdmission()`. Every preset service operation accepts only `desktop-default`; another id throws `PresetAdmissionError` with code `desktop-preset-unsupported`, the attempted operation and id, the stable reason, and `details.supportedPreset`. Disposing the provider fiber removes the contribution and releases the single-provider startup claim.

## Model Experience

### Desktop coding composition

#### What the model sees

A coding-agent persona plus the tool schemas registered by the fixed `desktop-default` consumer list. The admission policy itself adds no prompt text or tool.

#### Token effect

Fixed per model and Host configuration: the desktop persona, tool schemas, repository instructions, and loaded skill descriptions. The provider adds no dynamic admission tokens.

#### KV Cache effect

Prefix-stable for the session lifetime because every desktop Agent joins the same immutable preset before publication. Workspace instructions and model selection retain their existing cache effects.

## Known Limitations and Deferred Work

- **No user presets or switching** — the first desktop release deliberately refuses every preset except `desktop-default`; a future roster design must preserve Host provider ownership and all-entry-point admission.
- **Package resources are the roster authority** — the desktop application must pass `DESKTOP_PRESET_ROOT`; the provider does not rewrite another `agent-presets` configuration into compliance.
