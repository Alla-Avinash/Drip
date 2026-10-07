# Feature: Embeddings (semantic search)

## What it is

DRIP can turn text into **vectors** (embeddings) locally and use vector similarity to find related content by meaning, not just exact words.

## How to access it

- Background — enable/disable and pick the model in **Settings → Embeddings**; it then runs automatically on save/search.

## Sub-features

### Encoding

- A sentence-embedding model (Transformers.js / ONNX) runs locally to encode headings, files, folders, and tags into vectors.
- The model downloads into the extension's cache on first use.

### Vector search

- Heading similarity uses FAISS (in-memory) and `sqlite-vec` (in the index DB).
- File/folder/tag embeddings support "best place to put this" and related-tag search.

### Sync

- Embeddings are synced as notes change, through queues that encode only new/changed text.

### Model change

- Changing the embedding model rebuilds only the embedding tables (not note IDs or metadata).

### Benchmark

- A command runs an embedding benchmark to measure quality/speed.

## Flow (plain steps)

1. Notes are encoded into vectors and stored in the index.
2. When the user searches or ingests, DRIP compares vectors to rank by meaning.
3. If the model changes, embeddings are rebuilt.

## Note

Embeddings are optional (a setting). When off, DRIP falls back to token/overlap matching for suggestions.
