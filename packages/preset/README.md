# preset/ — per-session agent composition

English | [中文](README.zh.md)

An **agent preset** is a directory holding one `agent.cordis.yml`. Mounting it under an agent's scope context gives that session its own tools and prompt sections while every other live session keeps its own, so one process can run several differently composed agents at once.

| Package | Role | ctx key |
|---|---|---|
| `agent-presets/` | Preset vocabulary, filesystem discovery over trusted and user-authored roots, and the guarded per-agent mount | `ctx.agentPresets` |
| `agent-presets-desktop/` | Immutable `desktop-default` roster and all-operation desktop admission policy | — |
| `persona/` | The agent persona as a composable row, so a preset can change identity and not only tools | — |

The CLI presets live in [`apps/cli/config/agent-presets/`](../../apps/cli/config/agent-presets). The packaged desktop application instead uses the single package-owned roster under [`agent-presets-desktop/config/agent-presets/`](agent-presets-desktop/config/agent-presets/); each directory listing is authoritative for its deployment.

The composition split this group assumes: registries and cross-session facilities are process singletons and stay in the host composition, while a preset carries what one agent contributes to them. A preset that names a row publishing a process-global service is rejected at mount rather than allowed to collide with the next session.

Design: [the per-session agent-preset note](../../.agents/notes/implemented/architecture/2026-08-03-per-session-agent-presets.md).
