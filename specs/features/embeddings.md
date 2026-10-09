# Feature: Embeddings (semantic search)

## What it is

DRIP can turn text into **vectors** (embeddings) locally and use vector similarity to find related content by meaning, not just exact words.

## How to access it

- Background — embeddings are always on and run automatically on save/search. The **Settings → Embeddings** panel only shows model info and a benchmark button.

## Sub-features

### Encoding

- A fixed sentence-embedding model, `Xenova/all-MiniLM-L6-v2` (Transformers.js / ONNX), runs locally to encode headings, files, folders, and tags into vectors. The model cannot be changed from settings.
- The model downloads on first use into the DRIP extension folder (`.cache/transformers`) — not the home-folder Hugging Face cache — so uninstalling the DRIP extension removes the model files cleanly.

### Vector storage

- Vectors are stored as `Float32Array` BLOBs in ordinary SQLite tables — one per heading, file, folder, and tag — inside the same index database.
- No separate vector files or sidecar indexes exist.

### Vector search

- Similarity is a single exact L2 distance scan over all stored vectors, done in JavaScript.
- The same search path is used for every vector count — there is no threshold that switches to a different method.
- File/folder/tag embeddings support "best place to put this" and related-tag search.

### Sync

- Embeddings are synced as notes change, through queues that encode only new/changed text.

### Benchmark

- A command runs an embedding benchmark to measure quality/speed.

## Flow (plain steps)

1. Notes are encoded into vectors and stored in the index.
2. When the user searches or ingests, DRIP compares vectors to rank by meaning.
