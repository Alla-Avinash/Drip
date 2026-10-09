# Feature: Indexing and identity

## What it is

DRIP maintains a local SQLite index (`.dripindex/index.drip`) that mirrors the KB's notes so they can be searched, sorted, and queried quickly — without reparsing the whole KB.

## How to access it

- Mostly background — it runs on save and startup automatically.
- The only user-facing trigger is **Update index** on the Knowledge Base toolbar (forces a full rebuild).

## What the index stores

- **Files** — one row per note, with path and file ID.
- **Headings** — one row per heading, with title, parent, file, and metadata type.
- **Tags** and **relations** — tags and typed relations between notes/headings.
- **Typed metadata** — fixed tables for each built-in type: concept (`domain`, `status`), task (`status`, `priority`, `deadline`, `category`), and issue (`status`, `priority`, `deadline`, `category`, `parent`). Project fields (`status`, `priority`, `deadline`) live on the projects registry and feature `category` on the features registry. Any user-added keys go into a single EAV table (`metadata_remaining_keys`).
- **Projects** and **issues** — the project/issue hierarchy tables.
- **Embeddings** — vector records for headings (used by semantic search).

## Identity

- Files get a stable file ID (in the header).
- Headings get stable heading IDs.
- Projects and features get entity IDs (`f-N`).
- Issues get entity IDs (`i-N`).

These IDs survive renames, moves, and restructuring, so links keep pointing correctly.

## How the index is kept up to date

- **On save** — the affected note is re-parsed and compared; only changed parts are updated.
- **Incremental parse** — edits are mapped to the affected heading subtree and re-parsed selectively.
- **Startup reconcile** — on startup, path/name mismatches are repaired lightly (no full re-parse).
- **Full rebuild** — available on demand ("Update index") for a complete re-parse.
- **Static schema** — the database schema is fixed; a fresh index is created with the current schema and there is no in-place upgrade from older versions.

## Flow (plain steps)

1. User saves a note → DRIP re-parses just that note and updates its index rows.
2. On startup → DRIP lightly reconciles paths/names against disk.
3. User runs "Update index" → a full rebuild happens.

## Sub-features

- Entity ID stamping and pooling (allocating `i-N`/`f-N` numbers).
- File identity, heading identity, and reconcile helpers.
- Document watch, update queue, and KB reindex sync.
