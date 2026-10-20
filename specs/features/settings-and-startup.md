# Feature: Settings and startup check

## What it is

DRIP's configuration surface (a Settings webview and keybindings) plus the startup check that ensures the index is consistent.

## How to access it

- **Settings**: the gear icon on the Components view, or the **Open DRIP Settings** command.
- **Startup check**: automatic on launch — no action needed.

## Settings webview

A panel (`drip.openDripSettingsView`) with a large **DRIP Settings** heading and an always-visible **Sections** sidebar, with independent scrolling (the sidebar and the open panel each scroll on their own, so the sidebar stays visible). Sections:
- **Knowledge Base** — the KB folder picker, the auto-open-composer toggle, the two KB scan extensions (`.d.txt`, `.d.md`), and a **New note uses** dropdown that sets the default new-note extension. The dropdown is fixed to the two DRIP formats — `.d.txt` and `.d.md` only (no plain `.md`, no custom extensions).
- **KB Metadata** — the metadata template toggles (enable templates, auto-insert keys, strict validation, ignore errors, indent errors, heading hierarchy indent) plus **Document KB types** (the fixed concept / task / issue / decision set). The type list is fixed — there is no "add type" button and no delete-type action. Built-in keys are fixed (shown as "built-in", not deletable, with their data type locked) — only enum values can be edited, and custom keys can be added. The four built-in document types (concept, task, issue, decision) always exist in resolved settings: if a KB's saved settings predate one of them, the missing built-in is filled back in from the default template, and any custom type saved in old settings is dropped.
- **Project Metadata** — a **Select project** dropdown at the top listing every project in the KB plus a `default` entry. `default` edits the standard project template (project, feature, issue, concept, decision types). Picking a specific project edits that project's overrides — only changed/added keys are saved; everything else inherits the default template. The issue `parent` key is a special fixed key (shown as a "parent" kind) and is never overridden.
- **Doc Coloring** — a live sample of a `.d.txt` note (file identity lines, a heading, metadata, the `---` separator, tags and relations) rendered with the current colors, plus nine color picker rows. The nine roles are: (1) metadata type/shortcut, (2) heading line (bold), (3) metadata keys, (4) tag & relation keys, (5) the `---` separator and heading values, (6) file-level identity keys, (7) file identity values, (8) metadata type values, (9) tag list values. Each picker shows the exact color the editor renders for that role as its default (resolved in the extension host from the active theme's TextMate token colors plus any `editor.tokenColorCustomizations` / `editor.semanticTokenColorCustomizations`), so the swatches and live sample match the `.d.txt` document precisely rather than approximating the theme. Leaving a picker empty keeps the theme color, while setting a hex value overrides that role in `.d.txt` notes only. Dragging inside a picker updates the live sample without closing the picker, and a **Revert to Theme Defaults** button clears all nine back to the theme colors.
- **Embeddings** — model info and benchmark only (embeddings are always on; the model is fixed to `Xenova/all-MiniLM-L6-v2`).
- **LLM** — named provider profiles, each with its own base URL, model, enable toggle, and API key; one profile is active at a time, and profiles can be added, edited, deleted, or switched.
- **About & Product Tour** — an overview of what DRIP is, the two note formats (`.d.txt` vs `.d.md`), and a step-by-step getting-started flow. A **Start Product Tour** button opens a guided, in-webview walkthrough of every main area (Knowledge Base, Composer, Chat, Storage, Retriever, Project View, Tags Graph, LLM, MCP, GitHub backup); it can be re-run any time and dismissed at any step.
- **MCP** — enable, port, token, connection details.
- **GitHub backup** — remote, init, push, pull, PAT.
- **Shortcuts** — view/edit DRIP keybindings.

Settings can be stored globally or per-KB (saved into the KB's sidecar when a KB is selected).

## Project metadata overrides

Per-project metadata is stored in one sidecar file at the KB root — `.dripindex/settings-project.drip.json` — never inside a project folder, so project directories stay clean. The file is keyed by project folder prefix, e.g. `{ "projects": { "sample/kjh.p/": { "project": {…}, "feature": {…}, "issue": {…} } } }`, and each type only carries the attributes the user changed.

When a note, heading, or issue is edited inside a project folder, DRIP resolves that note's project prefix, layers the project's overrides on top of the default template, and uses the merged result (project/feature overrides apply to their index notes; the issue override applies to issue headings inside the project). The default template still fills in every key the project didn't touch.

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
