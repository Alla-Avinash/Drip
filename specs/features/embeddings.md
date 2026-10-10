# Feature: Embeddings (semantic search)

## What it is

DRIP can turn text into **vectors** (embeddings) locally and use vector similarity to find related content by meaning, not just exact words.

## How to access it

- Background — embeddings are always on and run automatically on save/search. The **Settings → Embeddings** panel only shows model info and a benchmark button.

## Sub-features

### Encoding

- A fixed sentence-embedding model, `Xenova/all-MiniLM-L6-v2` (Transformers.js / ONNX), runs locally to encode headings, files, folders, and tags into vectors. The model cannot be changed from settings.
- The model downloads on first use into the DRIP extension folder (`.cache/transformers`) — not the home-folder Hugging Face cache — so uninstalling the DRIP extension removes the model files cleanly.
- Each vector is encoded from a short, deterministic text built from what that thing *is* (kept deliberately small):
  - **Heading** → its title plus its semantic tags (`tags:` / `[…]`). Body, ancestors, ids, and workflow metadata are excluded.
  - **File** → its file name + folder path (name first so it carries the most weight).
  - **Folder** → its folder path, plus the folder's representative note title (h0) when one exists.
  - **Tag** → the tag name.

### Vector storage

- Vectors are stored as `Float32Array` BLOBs in ordinary SQLite tables — one per heading, file, folder, and tag — inside the index database (`index.drip`).
- No separate vector files or sidecar indexes exist.
- **Project data is never stored as vectors.** Project headings live in `projects.drip`, which has no embedding tables. Project files and project folders (anything under a `.p`/`.f` folder) are also excluded from the file and folder embedding stores, so nothing from the project hierarchy pollutes the document semantic index. The exclusion happens at sync/storage time, not just at query time.

### Vector search

- Similarity is a single exact L2 distance scan over all stored vectors, done in JavaScript. Distance is converted to a 0–1 score with `1 / (1 + distance)`.
- The same search path is used for every vector count — there is no threshold that switches to a different method.
- File/folder/tag embeddings support "best place to put this" and related-tag search.

### Ranking for "best place to put this" (AI / LLM ingest)

- The note is encoded once into a single query vector, then compared against the three stores separately: folders, files, and headings.
- **Headings** use a two-stage shortlist: a KNN pool of the closest 60 heading vectors is fetched, each is re-ranked, and the top 12 survive.
- Each heading's final score **mixes its own vector match with its file's vector match**:

  `score = 0.7 × similarity(note, heading) + 0.3 × similarity(note, file)`

- **Why the file term is there:** a heading with a common title (e.g. "Agentic AI") can appear in many folders. The file embedding (file name + folder path) tells the ranker *which* one is most on-topic for the note, so it breaks cross-folder ties by location. The 70/30 split keeps the heading leading while the file's location nudges it.
- After the top 12 are chosen, the **immediate parent title** of each is looked up from the index (`headings.parent`) purely as a display label for the LLM prompt — it does not affect the score, and it is fetched for the 12 finalists only, not the 60-heading pool.

### Sync

- Embeddings are synced as notes change, through queues that encode only new/changed text.
- A **Reset/reindex** shows two messages: first the note reconcile result (rewritten / unchanged / failed), then — after it has finished encoding every heading and folder vector — a second message with the totals actually stored in the index.

### Benchmark

- A command runs an embedding benchmark to measure quality/speed.

## Flow (plain steps)

1. Notes are encoded into vectors and stored in the index.
2. When the user searches or ingests, DRIP compares vectors to rank by meaning.
