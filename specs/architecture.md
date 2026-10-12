# DRIP — architecture

## Key decisions

### 1. Files are the source of truth, the index is derived

Notes live as plain `.d.txt` files in a `.driplock` folder. The SQLite index (`index.drip`) is built *from* those files and can always be rebuilt from disk. This keeps data portable and diff-friendly while still enabling fast search.

### 2. Two local SQLite indexes, split by scope

Document data and project data live in two SQLite files under `.dripindex/`:

- `index.drip` — the shared `files` registry (every note), document headings (concept/task), tags, relations, and embeddings. Global search reads only this file, so project headings never surface in it.
- `projects.drip` — projects, features, issues, and project headings. It is opened only when the Project View (or a project operation) needs it.

The two files share one `@fN` file-id sequence (minted by `index.drip`; `projects.drip` only records ids, since SQLite foreign keys cannot cross files). This gives fast sorting, filtering, and backlink lookups without reparsing the whole KB.

### 3. Stable, hidden IDs for identity

Files carry a file ID and headings carry heading IDs; projects and features carry entity IDs (`f-N`), and issues carry entity IDs (`i-N`). These survive renames, moves, and restructuring, so links keep pointing at the right thing.

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

The entry file only registers commands, providers, and webviews. All behavior lives in domain modules grouped by area, so a new developer can find where to change something in seconds.

### 10. Webview assets are real files, bundled with esbuild

Webview client scripts and styles live as actual `.ts`/`.css`/`.html` files instead of giant inline template strings. The tag graph (`src/graph/tags/`), Settings (`src/views/settings/webview/`), and the `.d.md` WYSIWYG markdown editor (`src/views/editor/dripMdEditor/`, built on CodeMirror 6) clients are bundled by esbuild into flat `dist/*.js`/`*.css` files (`npm run build:webview`), and the F5 `preLaunchTask` runs it automatically. The Composer and Storage webviews load plain `.js`/`.css`/`.html` files directly from their `webview/` folders (no bundling). The extension host loads assets with `webview.asWebviewUri(...)` under a CSP that allows the nonce'd inline bootstrap plus the `cspSource` script/style origins. Bundled browser `.ts` uses a lenient local `tsconfig.json` (DOM lib) so it stays out of the strict Node type-check.

### 11. `.d.md` headings are prefix-free, with one writer per open document

`.d.md` heading titles are plain markdown (`# Foo`); a heading's type and persistence live only in its hidden comment (`<!-- drip hN | concept -->`, or `persistent` for untyped-but-indexed). The earlier `.c`/`.task`/`.i-N` title prefixes were dropped because they made the heading text itself ambiguous and forced a host rewrite to interpret. The webview is the single writer of an open document — every type/field change is a pure editor edit, and the host only reconciles on open and save, never on a mid-typing debounce, so the editor and the index can't fight over the same buffer (the source of the old "content is newer" save conflicts). The `.d.txt` heading-identity reconcile skips `.d.md` files for the same reason.

## Module layout

```
src/
  capture/        quick-capture and heading-content extraction
  document/       the .d.txt format: model, parsing, projects, issues, validation
  extension/      entry wiring (activate)
  graph/          cross-file links, tag graph (+ tags/ webview assets built to dist/)
  indexing/       SQLite index, identity, embeddings, parse, sync
  ingest/         deciding where a captured note should go
  integrations/mcp/  local MCP server + tool catalog
  llm/            chat memory and the OpenAI-compatible client
  retrieval/      retriever query, quick open, embeddings benchmark
  shared/         constants, utilities, edit guards
  startup/        KB selection, settings, daily notes, drafts, github backup, startup check
  state/          session state
  views/          editor services (incl. dripMdEditor/ custom `.d.md` editor), lhs (KB/projects/retriever), rhs (storage/heading/chat), composer, settings
scripts/          build-webview.mjs (esbuild bundle → dist/)
dist/             compiled webview assets (git-ignored, flat *.js/*.css)
```
