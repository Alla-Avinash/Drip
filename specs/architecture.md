# DRIP — architecture

## Key decisions

### 1. Files are the source of truth, the index is derived

Notes live as plain `.d.txt` files in a `.driplock` folder. The SQLite index (`index.drip`) is built *from* those files and can always be rebuilt from disk. This keeps data portable and diff-friendly while still enabling fast search.

### 2. Two local SQLite indexes, split by scope

Document data and project data live in two SQLite files under `.dripindex/`:

- `index.drip` — the shared `files` registry (every note), document headings (concept/task), tags, relations, and embeddings. Global search reads only this file, so project headings never surface in it.
- `projects.drip` — projects, features, issues, and project headings. It is opened only when the Project View (or a project operation) needs it.

`index.drip` mints `@fN` for knowledge-base notes. Each project folder mints its own `@fN` sequence (written in the file, remembered in the sidecar). `projects.drip` records those ids; it does not mint them. If a project `@fN` and a knowledge-base `@fN` collide in the local `files` table, the index may use a different row id for the project note — the file is not rewritten. Heading-number memory is keyed the same way (knowledge-base file vs project folder + `@fN`). Once a project is shared, reconcile refreshes the local index only and does not rewrite those files. This keeps project files identical across peers without changing how ordinary notes get ids.

### 3. Stable, hidden IDs for identity

Knowledge-base files carry `@fN` unique in this knowledge base. Project files carry a project-owned `@fN` (same number on every peer) plus a hidden unique id that peers share. Headings carry heading IDs. Features and issues carry a visible Linear-style key (`f-N`, `i-N`) plus a hidden unique id that never changes — the visible key can be reminted if two people mint the same number offline. A shared project also has a hidden project id that survives folder renames. These survive moves and restructuring, so links keep pointing at the right thing.

### 4. Incremental parsing and reconciliation

On save, only the affected note is re-parsed and compared; the index is updated selectively. Startup reconcile repairs path/name drift lightly; a full rebuild is explicit. The database schema is fixed — a fresh index is created with the current schema, with no in-place upgrade from older versions.

### 5. Projects → features → issues hierarchy

The top planning unit is a project; each project holds features; each feature (or the project itself) holds issues; issues can have sub-issues via a parent link. This mirrors Linear's structure and maps onto DRIP's folder/index layout.

### 6. Tag graphs are the source of truth for tags

Tags used in notes must exist in a tag graph; unknown tags are flagged in the editor rather than silently added. Graphs are edited in a webview and sync into the editor completion. `.d.md` notes resolve which graph is authoritative per path — the per-project graph inside a `.p`/`.f` folder, otherwise every KB graph — through one shared `graph/noteTagScope.js` helper, so the editor dropdown, tag creation, and the open-time metadata sweep all agree on the same set.

### 7. Embeddings for semantic matching

Text is turned into vectors locally; vector search powers "best place to put this note", heading/folder/tag similarity, and the MCP tool search. Model choice can be changed, which rebuilds only the embedding tables.

Vectors are stored as `Float32Array` BLOBs in ordinary SQLite tables and searched with one exact L2 scan in JavaScript — no native vector library. FAISS HNSW and sqlite-vec were benchmarked and rejected: at DRIP's scale (thousands of vectors, ≤384 dims) the exact scan is sub-10 ms with 100% recall, while HNSW returned the wrong neighbors 10–80% of the time at those sizes and both add a native addon that must be recompiled for VS Code's Electron host. The benchmarks measuring this live in `benchmarks/`.

### 8. A local MCP server exposes DRIP to AI apps

DRIP runs a small loopback HTTP MCP server. External AI apps use two meta tools — `search_tools` and `call_tool` — to discover and call project/feature/issue operations. Tool discovery itself is semantic.

### 9. Minimal wiring in the entry file

The entry file only registers commands, providers, and webviews. All behavior lives in domain modules grouped by area, so a new developer can find where to change something in seconds. The larger chunks were pulled out into their own modules: the Settings panel (panel lifecycle + message handler + theme sync) lives under `src/views/settings/`, the `drip.github.*` command registrations live in `src/startup/githubBackupCommands.js`, the tags-graph panels and message routing live in `src/views/tags/panel.js`, and the stateless editor/document helpers plus tag-graph state were split out of `DripState` into `src/state/documentFileOps.js` and `src/state/tagGraphState.js`.

### 10. Webview assets are real files, bundled with esbuild

Webview client scripts and styles live as actual `.ts`/`.css`/`.html` files instead of giant inline template strings. The tag graph (`src/graph/tags/`), Settings (`src/views/settings/webview/`), and the `.d.md` WYSIWYG markdown editor (`src/views/editor/dripMdEditor/`, built on CodeMirror 6) clients are bundled by esbuild into flat `dist/*.js`/`*.css` files (`npm run build:webview`), and the F5 `preLaunchTask` runs it automatically. The Composer and Storage webviews load plain `.js`/`.css`/`.html` files directly from their `webview/` folders (no bundling). The extension host loads assets with `webview.asWebviewUri(...)` under a CSP that allows the nonce'd inline bootstrap plus the `cspSource` script/style origins. Bundled browser `.ts` uses a lenient local `tsconfig.json` (DOM lib) so it stays out of the strict Node type-check.

### 11. `.d.md` headings are prefix-free, with one writer per open document

`.d.md` heading titles are plain markdown (`# Foo`); a heading's type and persistence live only in its hidden comment (`<!-- drip hN | concept -->`, or `persistent` for untyped-but-indexed). The earlier `.c`/`.task`/`.i-N` title prefixes were dropped because they made the heading text itself ambiguous and forced a host rewrite to interpret. The webview is the single writer of an open document — every type/field change is a pure editor edit, and the host only reconciles on open and save, never on a mid-typing debounce, so the editor and the index can't fight over the same buffer (the source of the old "content is newer" save conflicts). The `.d.txt` heading-identity reconcile skips `.d.md` files for the same reason.

### 12. File naming: dripMd / dripTxt / dripNote

Source files are named by which note format they serve, so a developer can tell at a glance whether a file is `.d.md`-specific, `.d.txt`-specific, or shared:

- `dripMd*` — logic for `.d.md` (markdown notes with hidden comments).
- `dripTxt*` — logic for `.d.txt` (the structured "dripnote" language).
- `dripNote*` — common logic that handles both formats (extension rules, KB note file operations).

When one component holds logic for both formats, its files are split into `dripMd/` and `dripTxt/` subfolders; shared `dripNote*` files stay at the component root. The VS Code language id `dripnote` and scope `source.dripnote` (which apply to `.d.txt` only) keep their names — only the grammar *file* is `dripTxt.tmLanguage.json`.

### 13. A project folder is the collaboration unit

Every `.p` folder lives under `.drip.project/` at the knowledge-base root (hidden from the Knowledge Base tree; shown in the Projects sidebar). A project starts solo. Sharing is opt-in and only that `.p` folder — plus its `.drip/` sidecar (project id, members, tags, metadata overrides, operation log) — is the shared world. The rest of the knowledge base, the two SQLite indexes, embeddings, drafts, and secrets stay on the machine. There is no central DRIP server. The admin who shares must sign in with GitHub; that account is the recoverable owner.

### 14. Operations are the exchange unit; indexes stay local

Peers exchange discrete, signed operations — not live keystrokes, not database rows, not a git merge. A create names the file it was written in and carries enough of the issue (title, fields, body) for the other machine to write the same block. A move names the destination. Each operation is applied to those project files (all or nothing), the touched file is reprinted into a strict shape (same line breaks, same heading order by hidden id, one blank line between headings), then the local indexes are rebuilt from those files. Reprint never moves an issue into another file. The log is only a short recent queue: an admin folds old lines into the current folder so the changelog does not grow forever. A peer who missed the folded slice asks for that folder instead of a replay.

### 15. Internet sharing uses a relay, not a DRIP server

Two members first try a direct TCP path (same LAN or this machine). When that cannot be opened, they send the same snapshot and operations through a public MQTT relay as encrypted blobs. The relay introduces the two machines and forwards bytes; it is not an issue database. The invite secret is the encryption key. GitHub stays owner identity only.

### 16. Two-peer local test uses a second app, not a second profile

A second editor window (or a named profile) still shares Secret Storage, so both windows are the same DRIP person. Local sharing tests start a second VS Code with its own user-data folder. That is the only isolation that gives the guest a new id and a new signing key without overwriting the owner. The F5 Extension Host cannot take a custom user-data folder, so Peer A stays the debug window and Peer B is a real second VS Code process. See Local two-peer testing.

## Module layout

```
src/
  capture/        quick-capture and heading-content extraction
  document/       the note formats (model/parse/validate split into dripMd/ + dripTxt/ + dripNote*), projects, issues
  extension/      entry wiring (activate)
  graph/          cross-file links, tag graph (+ tags/ webview assets built to dist/)
  indexing/       SQLite index, identity (dripMd/ + dripTxt/ subfolders), embeddings, parse, sync
  ingest/         deciding where a captured note should go
  integrations/mcp/  local MCP server + tool catalog
  llm/            chat memory and the OpenAI-compatible client
  peer/           local identity, project sidecar, operations, share/sync, internet relay
  retrieval/      retriever query, quick open, embeddings benchmark
  shared/         constants, utilities, edit guards
  startup/        KB selection, settings, daily notes, drafts, github backup, startup check
  state/          session state (DripState + documentFileOps helpers + tagGraphState mixin)
  views/          editor services (dripMdEditor/ + dripTxt/), lhs (KB/projects/retriever), rhs (storage/heading/chat), composer, storage, tags (graph panels), settings
scripts/          build-webview.mjs (esbuild bundle → dist/); launch-peer-b.mjs (isolated second editor for sharing tests)
dist/             compiled webview assets (git-ignored, flat *.js/*.css)
```
