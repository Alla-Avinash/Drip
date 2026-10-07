# Feature: Tags graph

## What it is

Tags in DRIP are managed as **graphs** — the graph is the source of truth for which tags exist. Notes can only use tags that exist in a graph; unknown tags are flagged.

## How to access it

- Open the graph editor with the **Open Tags Graph** command (or from the Components view).
- Tag completion in notes reads from this graph automatically.

## Sub-features

### Graph store

- Tag graphs are persisted (in the extension's global storage and mirrored to files).
- Multiple graphs are supported; the active graph is tracked per session.

### Tags webview editor

- A webview panel lets the user create and edit tag graphs (add tags, define relations like `tags` and `pre-req`).
- Changes persist and immediately affect completion.

### Tag completion sync

- The editor's tag completion reads from the active graph, so only known tags are suggested.

### Tag embedding search

- Tags can be searched semantically (embedding-based), letting the user find related tags by meaning.

## Flow (plain steps)

1. User opens the Tags graph panel and edits the set of tags/relations.
2. The graph is saved; the editor's tag completion now suggests those tags.
3. A note using an unknown tag is underlined as an error rather than silently adding a new tag.
