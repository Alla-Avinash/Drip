# DRIP — application startup

## Run and test commands

```powershell
# Run in the Extension Development Host (from the VS Code repo root)
$env:VSCODE_SKIP_PRELAUNCH = "1"
.\scripts\code.bat
```

- Debug logs: in the Extension Development Host, **Help → Toggle Developer Tools**, then filter the console for `[DRIP]`.
- Type check: `npm run compile-web`
- Embedding benchmark: `npm run bench:embeddings` (add `--real` or `--all` for heavier runs)

There are no automated tests — the user verifies behavior manually in the Extension Development Host.

## Entry point

- `package.json` declares `"main": "./extension.js"`.
- The root `extension.js` simply re-exports the real entry in `src/extension/extension.js`, which re-exports `activate()` from `src/extension/activate.js`.
- `activate(context)` is the only wiring point: it registers commands, providers, and webviews. All real behavior lives in the domain modules under `src/`.

## When DRIP loads

DRIP does **not** use a catch-all activation event. It activates only when one of these happens:

- a `.d.txt` (dripnote) file is opened,
- a DRIP view/panel is opened (Components, KB, Drafts, Storage, Chat, etc.),
- a DRIP command is run.

Until one of those fires, DRIP is inactive.

## Activation flow (ordered)

1. **Global services** — set up the embeddings model cache, initialize multi-graph storage, and register the editor language providers (tag completion, semantic tokens, metadata diagnostics/completion, custom decorations, heading identity display).
2. **State + sync** — create the session state, register index sync and startup check, register persistent-heading soft-lock and project/feature folder watchers, then sync the tag-graph checkpoint.
3. **Sidebar trees** — create the five sidebar trees (Components, Knowledge Base, Daily Notes, Drafts, Recents) and wire drag-drop and refresh.
4. **Editor + references** — register image paste, reference assist/definitions, document links, link drop-in, and document symbols.
5. **Webviews + commands** — register the Heading Form, Storage, and Chat providers, and register every command (open Composer/Retriever/Project View/Tags/Settings, GitHub backup, KB CRUD, index commands, embedding benchmark).

## KB selection and index startup

On first install there is no knowledge base. The user picks a folder (which must be a `.driplock` folder). After picking:

- the KB root is saved to workspace state,
- a file watcher starts watching the KB tree,
- the startup check runs the index reconcile.

Index reconcile compares the on-disk notes against the index and repairs path/name mismatches; a full content rebuild is only done on demand via the "Update index" command.

## Lazy loading

Panels and webviews are created only when first opened. Storage, Chat, and Heading Form register providers at startup but build their HTML/state on first reveal. The Settings webview is created on first open.
