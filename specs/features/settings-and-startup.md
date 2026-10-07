# Feature: Settings and startup check

## What it is

DRIP's configuration surface (a Settings webview and keybindings) plus the startup check that ensures the index is consistent.

## How to access it

- **Settings**: the gear icon on the Components view, or the **Open DRIP Settings** command.
- **Startup check**: automatic on launch — no action needed.

## Settings webview

A panel (`drip.openDripSettingsView`) with sections for:

- **General** — note extensions, auto-open composer, editor edit mode.
- **Metadata** — types, templates, colors, markers, relations.
- **Embeddings** — enable/disable, model choice.
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
