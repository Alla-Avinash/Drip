# Feature: Settings and startup check

## What it is

DRIP's configuration surface (a Settings webview and keybindings) plus the startup check that ensures the index is consistent.

## How to access it

- **Settings**: the gear icon on the Components view, or the **Open DRIP Settings** command.
- **Startup check**: automatic on launch — no action needed.

## Settings webview

A panel (`drip.openDripSettingsView`) with a large **DRIP Settings** heading and an always-visible **Sections** sidebar, with independent scrolling (the sidebar and the open panel each scroll on their own, so the sidebar stays visible). Sections:
- **Metadata** — types, templates, markers, relations. Types are shown in two groups: **Document KB types** (concept, task) and **Project types** (project, feature, issue). Built-in keys are fixed (shown as "built-in", not deletable, with their data type locked) — only enum values can be edited, and custom keys can be added. The issue `parent` key is a special fixed key (shown as a "parent" kind).
- **Doc Coloring** — a live sample of a `.d.txt` note (file identity lines, a heading, metadata, the `---` separator, tags and relations) rendered with the current colors, plus nine color picker rows. The nine roles are: (1) metadata type/shortcut, (2) heading line (bold), (3) metadata keys, (4) tag & relation keys, (5) the `---` separator and heading values, (6) file-level identity keys, (7) file identity values, (8) metadata type values, (9) tag list values. Each picker shows the exact color the editor renders for that role as its default (resolved in the extension host from the active theme's TextMate token colors plus any `editor.tokenColorCustomizations` / `editor.semanticTokenColorCustomizations`), so the swatches and live sample match the `.d.txt` document precisely rather than approximating the theme. Leaving a picker empty keeps the theme color, while setting a hex value overrides that role in `.d.txt` notes only. Dragging inside a picker updates the live sample without closing the picker, and a **Revert to Theme Defaults** button clears all nine back to the theme colors.
- **Embeddings** — model info and benchmark only (embeddings are always on; the model is fixed to `Xenova/all-MiniLM-L6-v2`).
- **LLM** — enable, base URL, model, API key.
- **MCP** — enable, port, token, connection details.
- **GitHub backup** — remote, init, push, pull, PAT.
- **Shortcuts** — view/edit DRIP keybindings.

Settings can be stored globally or per-KB (saved into the KB's sidecar when a KB is selected).

## Keybindings

- Default shortcuts are registered (e.g. `Ctrl+U` composer, `Ctrl+Shift+U` capture, `Ctrl+Shift+Alt+R` retriever, `Ctrl+Shift+Alt+H` quick open).
- Users can customize them through the settings webview.

## Startup check

- On activation (and again after a short delay), DRIP verifies the KB index exists and is consistent.
- If no index exists, it prompts to create one.
- It lightly reconciles paths/names (not a full re-parse) and processes pending link migrations.

## Flow (plain steps)

1. User opens Settings to change behavior; changes apply immediately and persist.
2. On startup, DRIP runs the startup check to make sure the index is in a good state.
3. The user can force a full reindex from the KB toolbar when needed.
