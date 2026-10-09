# DRIP — architecture

## Key decisions

### 1. Files are the source of truth, the index is derived

Notes live as plain `.d.txt` files in a `.driplock` folder. The SQLite index (`index.drip`) is built *from* those files and can always be rebuilt from disk. This keeps data portable and diff-friendly while still enabling fast search.

### 2. A local SQLite index for querying

Headings, metadata, tags, typed metadata (concept/task/issue plus project/feature registries), issues, projects, and embeddings all live in one local database. This gives fast sorting, filtering, and backlink lookups without reparsing the whole KB.

### 3. Stable, hidden IDs for identity

Files carry a file ID and headings carry heading IDs; projects and features carry entity IDs (`f-N`), and issues carry entity IDs (`i-N`). These survive renames, moves, and restructuring, so links keep pointing at the right thing.

### 4. Incremental parsing and reconciliation

On save, only the affected note is re-parsed and compared; the index is updated selectively. Startup reconcile repairs path/name drift lightly; a full rebuild is explicit. The database schema is fixed — a fresh index is created with the current schema, with no in-place upgrade from older versions.

### 5. Projects → features → issues hierarchy

The top planning unit is a project; each project holds features; each feature (or the project itself) holds issues; issues can have sub-issues via a parent link. This mirrors Linear's structure and maps onto DRIP's folder/index layout.

### 6. Tag graphs are the source of truth for tags

Tags used in notes must exist in a tag graph; unknown tags are flagged in the editor rather than silently added. Graphs are edited in a webview and sync into the editor completion.

### 7. Embeddings for semantic matching

Text is turned into vectors locally; vector search powers "best place to put this note", heading/folder/tag similarity, and the MCP tool search. Model choice can be changed, which rebuilds only the embedding tables.

### 8. A local MCP server exposes DRIP to AI apps

DRIP runs a small loopback HTTP MCP server. External AI apps use two meta tools — `search_tools` and `call_tool` — to discover and call project/feature/issue operations. Tool discovery itself is semantic.

### 9. Minimal wiring in the entry file

The entry file only registers commands, providers, and webviews. All behavior lives in domain modules grouped by area, so a new developer can find where to change something in seconds.

## Module layout

```
src/
  capture/        quick-capture and heading-content extraction
  document/       the .d.txt format: model, parsing, projects, issues, validation
  extension/      entry wiring (activate)
  graph/          cross-file links, tag graph
  indexing/       SQLite index, identity, embeddings, parse, sync
  ingest/         deciding where a captured note should go
  integrations/mcp/  local MCP server + tool catalog
  llm/            chat memory and the OpenAI-compatible client
  retrieval/      retriever query, quick open, embeddings benchmark
  shared/         constants, utilities, edit guards
  startup/        KB selection, settings, daily notes, drafts, github backup, startup check
  state/          session state
  views/          editor services, lhs (KB/projects/retriever), rhs (storage/heading/chat), composer, settings
```
