# DRIP — application startup

## Run and test commands

- **F5 (recommended):** open the `extensions/drip` folder in VS Code and press F5. The `preLaunchTask` builds the webview assets (`dist/`) first, then launches the Extension Development Host. The build never touches KB storage. This window is **Peer A** (your normal identity).
- **Two people on one PC:** from VS Code, pick **Run Extension (DRIP) — two peers** in Run and Debug. That starts Peer A (F5) and a second, isolated **VS Code** (**Peer B**) with its own user-data folder, so DRIP treats them as two people. You can also start Peer B alone (**Run Extension (DRIP) — Peer B (isolated)**, the **Launch Peer B** task, or `npm run launch:peer-b`). Peer B always opens VS Code, not Cursor. See **Local two-peer testing**.
- **Whole editor from source (VS Code repo root):** `$env:VSCODE_SKIP_PRELAUNCH = "1"; .\scripts\code.bat`

- Debug logs: in the Extension Development Host, **Help → Toggle Developer Tools**, then filter the console for `[DRIP]`.
- Build webview assets: `npm run build:webview`
- Lint: `npm run lint`
- Type check: `npm run compile-web`
- Embedding benchmark: `npm run bench:embeddings` (add `--real` or `--all` for heavier runs)
- Peer sync selftest (no UI): `npm run selftest:peer-sync` — two temp folders exchange a create (and an assign) over localhost.

Two-window checks are still done by hand in Peer A / Peer B. The selftest only proves the create/assign path without an editor.

## Entry point

- `package.json` declares `"main": "./extension.js"`.
- The root `extension.js` loads the real entry in `src/extension/extension.js`, which re-exports `activate()` from `src/extension/activate.js`.
- `activate(context)` is the only wiring point: it registers commands, providers, and webviews. All real behavior lives in the domain modules under `src/`.

### Failed-load guard

The root `extension.js` wraps the entry-point require in a try/catch. If loading throws, it activates a degraded mode instead of letting VS Code show a cryptic "no data provider" message. Degraded mode registers empty sidebar views and shows a single simple error ("DRIP failed to start.") with the underlying error as the detail and a **Show Logs** action.

## When DRIP loads

DRIP does **not** use a catch-all activation event. It activates only when one of these happens:

- a `.d.txt` (dripnote) file is opened,
- a `.d.md` markdown file is opened (custom editor),
- a DRIP view/panel is opened (Components, KB, Drafts, Storage, Chat, etc.),
- a DRIP command is run.

Until one of those fires, DRIP is inactive.

## Activation flow (ordered)

1. **Global services** — set up the embeddings model cache, initialize multi-graph storage, and register the editor language providers (tag completion, semantic tokens, metadata diagnostics/completion, custom decorations, heading identity display) plus the `.d.md` custom markdown editor provider.
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
