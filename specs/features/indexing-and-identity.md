# Feature: Indexing and identity

## What it is

DRIP maintains a local SQLite index (`.dripindex/index.drip`) that mirrors the KB's notes so they can be searched, sorted, and queried quickly — without reparsing the whole KB.

## How to access it

- Mostly background — it runs on save and startup automatically.
- **Update index** on the Knowledge Base toolbar forces a full rebuild (keeps `index.drip`).
- **Reset/reindex** on the Knowledge Base toolbar wipes `index.drip` and `projects.drip`, then re-parses every note and re-encodes all embeddings.

## What the index stores

- **Files** — one row per note, with path and file ID.
- **Headings** — one row per heading, with title, parent, file, and metadata type.
- **Tags** and **relations** — tags and typed relations between notes/headings.
- **Typed metadata** — fixed tables for each built-in type: concept (`domain`, `status`), task (`status`, `priority`, `deadline`, `category`), and issue (`status`, `priority`, `deadline`, `category`, `parent`). Issue `completed`, `feature`, and `team` live on the issue in the file (and in remaining keys when indexed). Project fields (`status`, `priority`, `deadline`) live on the projects registry and feature `category` on the features registry. Any user-added keys go into a single EAV table (`metadata_remaining_keys`).
- **Projects** and **issues** — the project/issue hierarchy tables.
- **Embeddings** — vector records for headings (used by semantic search).

## Identity

- Files get a file ID in the header: `@fN`. Knowledge-base notes use one sequence unique **in this knowledge base**. Notes inside a project folder use a **separate sequence owned by that project** (first project note is `@f0`). Those project numbers stay in the file on every machine. If this knowledge base already has a note with the same `@fN`, the project file is not reminted — the local index may use a different row id so the two do not collide, and that row id is never written back into the file. Cross-file meaning inside a shared project uses the hidden file id and the entity ids.
- Headings get a per-file number written as `@hN` on the line above each `#`/`#N` heading (`@h0` for the file heading, which sits below the `---` separator). There is no file-id prefix or hash suffix on the heading identity line. `@h0` is reserved for the file-name heading only — reconcile renumbers any other heading that ends up carrying `@h0` (for example after a deleted id) rather than leaving a duplicate. The local heading-number pot is per knowledge-base file, or per project file (`project folder + @fN`), so two projects that both have `@f0` do not share heading numbers.
- A **shared** project file is not rewritten by reconcile (open, save, Update index, or Reset). Those passes only refresh the local index from the text already on disk. Missing ids are stamped at create and at Share. Solo project files still get the full repair.
- Heading ids are kept stable — reconcile never renumbers an existing heading to close a gap (that would break links). New ids (for headings that lost or never had an id) reuse the lowest free number first. If the `h0` heading's name doesn't match the file name, it is demoted to a regular heading with a new id and a fresh `@h0` file heading is added at the top.
- Projects and features get visible entity IDs (`f-N`) plus a hidden unique id that never changes. A shared project also has a hidden project id that survives folder renames.
- Issues get a visible entity ID (`i-N`) plus a hidden unique id that never changes. On a shared project, colliding `i-N` keys are reminted (see Issues and Project sync).

These IDs survive renames, moves, and restructuring, so links keep pointing correctly. A heading's parent in the index is derived from the heading marker level (`#` = 0, `#1` = 1, …), not from tab indentation.

The two indexes are **local only**. They are never sent to another person. After shared-project operations land in the files, the existing reindex updates the local rows. Reset / reindex rebuilds both databases from disk and must not strip hidden ids from project files or delete a project's `.drip/` sidecar.

## How the index is kept up to date

- **On save** — the affected note is re-parsed and compared; only changed parts are updated.
- **Incremental parse** — edits are mapped to the affected heading subtree and re-parsed selectively.
- **Startup reconcile** — on startup, path/name mismatches are repaired lightly (no full re-parse).
- **Full rebuild** — available on demand ("Update index") for a complete re-parse.
- **Static schema** — the database schema is fixed; a fresh index is created with the current schema and there is no in-place upgrade from older versions.
- **One lifecycle for both formats** — `.d.txt` and `.d.md` notes register through a single lifecycle entry point. It detects the format from the file path and dispatches to the right reconcile algorithm, both of which follow the same buffer-first rule: reconcile an open document through the editor buffer, and write straight to disk only when the tab is closed.

## Flow (plain steps)

1. User saves a note → DRIP re-parses just that note and updates its index rows.
2. On startup → DRIP lightly reconciles paths/names against disk.
3. User runs "Update index" → a full rebuild happens.

## Sub-features

- Entity ID stamping and pooling (allocating `i-N`/`f-N` numbers).
- File identity, heading identity, and reconcile helpers.
- Document watch, update queue, and KB reindex sync.
