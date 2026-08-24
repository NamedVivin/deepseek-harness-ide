# @deepseek-ai/dsh-client-ui-layout

English | [中文](README.zh.md)

Shell plugin: four-column AppFrame (`sidebar | conversation | details | editor`) plus the `ctx.layout` panel service. It registers into the runtime-owned `root` slot and declares `sidebar`, `conversation`, `details`, root-scoped `shell.editor`, and additive `shell.overlay`. Stable `data-shell-frame`, `data-shell-panel`, and `data-resize-handle` attributes identify the frame, tracks, and boundaries. A closed sidebar retains a 56px control rail; closed details and editor tracks stay mounted at zero width and inert.

The concession solver first shrinks details, then the editor, and derives details closed before reducing the conversation below its normal 640px floor. An editor-only split may use a 400px conversation floor. An open editor owns the content region at 900px or narrower, and also when even the 56px control rail cannot leave an adjustable split range. If the configured navigation width cannot fit but the rail can, AppFrame derives the rail while preserving the split; widening never changes a split into exclusive mode. The rail's expand action shows the stored sidebar width and makes the editor exclusive in the remaining region; collapsing returns to the derived rail without rewriting sidebar or editor preferences. Wider frames restore stored preferences. The editor separator supports pointer capture plus `ArrowLeft`, `ArrowRight`, `Home`, and `End`; its ARIA range is the same solver-reachable range used by pointer resizing.

AppFrame always mounts conversation, details, and editor occupants, including before a Session exists. The transient layout store starts with the sidebar at its default width and both right tracks closed, and it never reads or writes `localStorage`. The editor retains its last open width across close/reopen within one store instance. `ctx.layout.editorOpen` is an observable projection of that same root store, so header controls and the docked surface cannot diverge. Selecting a different non-blank Session closes details before paint without closing the root editor.

The conversation and details owner shares are empty. The sidebar receives `collapsed` and rendered `width`; the editor receives `collapsed`, `exclusive`, and rendered `width`. Registrants obtain business data from standard hooks and actions from their own inject faces. The `/client` exports are the plugin body (`apply`/`inject`), `LayoutController`, and the four owner-share interfaces. AppFrame, the panel store, its observable bridge, and the concession solver remain package-internal.

The package also seats the theme presenter: it consumes resolved `ctx.theme` snapshots and projects them onto the document (`html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, the theme's alias tokens as inline variables on body, and one owned `<meta name="theme-color">` whose content follows the computed body background). Measuring after palette and token application keeps the rendered background as the single color authority; disposing the presenter removes its metadata node with its other global writes.

## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Panel geometry is transient** — reload restores the sidebar default with details and editor closed; the editor's remembered width lasts only for the current root store instance.
- **Concessions do not rewrite preferences** — a rendered details or editor width may be smaller than its stored width; consumers must use owner geometry for rendering and `ctx.layout.editorOpen` only for open-state observation.
- **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.
