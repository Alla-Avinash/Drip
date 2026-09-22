# DRIP embedding benchmarks

Compare **which text fields** go into heading embeddings, and **exact vs FAISS** search cost.

## Run

```bash
# Fast (no MiniLM download) — good for search timing + recipe structure
node benchmarks/run.js

# Real model encode (uses extension .cache/transformers) — needed for field quality
node benchmarks/run.js --real

# Pieces
node benchmarks/run.js --fields
node benchmarks/run.js --search
node benchmarks/run.js --backends
node benchmarks/run.js --all --real
```

JSON reports land in `benchmarks/results/`.

## What is compared

### 1. Field recipes (`--fields`)

| Recipe id | Fields | Notes |
|-----------|--------|--------|
| `title` | title | Minimal |
| `title_tags` | title + tags | **Production default** |
| `title_ancestors` | title + ancestors | Hierarchy context |
| `title_tags_ancestors` | title + tags + ancestors | |
| `title_tags_body` | title + tags + body | More recall, more churn |
| `title_tags_ancestors_body` | all four | Maximal / slowest |

Metrics: avg encode ms, avg chars, probe **hit@1 / hit@3 / avg rank** on a small labeled corpus (`corpus.js`).

Use `--real` before trusting hit rates (fake vectors only check plumbing).

### 2. Search scale (`--search`)

Brute-force exact vs FAISS HNSW at n = 100…5000. Notes the production lock: **≤1000 exact**, **>1000 FAISS**.

### 3. Backends (`--backends`)

Brute vs **sqlite-vec** vs FAISS at a few sizes (closer to production exact path).

## Layout

```
benchmarks/
  run.js           CLI
  recipes.js       field recipes
  corpus.js        labeled docs + probe queries
  lib/metrics.js
  lib/encode.js
  lib/search.js
  results/         JSON outputs (gitignored contents ok)
  README.md
```

## Interpreting

- Prefer a recipe with strong **hit@1** without large encode cost.
- If `title_tags` ≈ `title_tags_body` on your probes, keeping body out (current policy) is justified.
- FAISS should stay near recall@10 ≈ 1.0 while beating exact ms as n grows.
