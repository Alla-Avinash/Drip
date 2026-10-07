# Feature: Retrieval and search

## What it is

The Retriever lets the user find and jump to headings across the knowledge base.

## How to access it

- **Retriever panel**: **Open Retriever** (`Ctrl+Shift+Alt+R`).
- **Quick jump to a heading**: `Ctrl+Shift+Alt+H`.

## Sub-features

### Retriever panel

- A panel that builds a catalog of headings and lets the user search/filter them.
- Opens a note at a chosen heading.

### Heading quick open

- A quick-pick command (`Ctrl+Shift+Alt+H`) to jump straight to a heading by name.

### Retriever query

- Queries the index for headings matching a search term.

### Storage ranking

- Ranks folders/notes when suggesting where to place captured content (used by Storage and ingest).

### Auto-refresh

- The catalog rebuilds (debounced) when a KB note is saved while the panel is open.

## Flow (plain steps)

1. User opens the Retriever (panel or quick open).
2. Types a search term → headings matching across the KB are listed.
3. Picking one opens the file at that heading.
