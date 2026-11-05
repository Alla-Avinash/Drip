# Feature: Retrieval and search

## What it is

The Retriever lets the user find and jump to headings across the knowledge base.

## How to access it

- **Retriever panel**: **Open Retriever** (`Ctrl+Shift+Alt+R`).
- **Quick jump to a heading**: `Ctrl+Shift+Alt+H`.

## Sub-features

### Retriever panel

- A panel that builds a catalog of headings and lets the user search/filter them, then opens a note at a chosen heading.
- Layout matches the Project View: slim top bar (status + Refresh), then a centered page with title, toolbar, and results.

Centered chrome:

- **Retriever** title and short subtitle in the middle.
- Menu chips above the search box: **Scope**, **Filter**, **Tags**, **Display**, **Sort**, then **Clear** (Clear appears only when something differs from defaults).
- Centered search box with a Project View–style search-engine icon beside it (Recommended / semantic-only / word-only, plus **Top embeddings** 1–50 when not word-only; default 20).
- Active type / tag / relation picks as removable chips under the search row.
- Results fill the remaining height and scroll inside that area (title/toolbar stay put). Heading rows and file sections use their natural height — expanding a file section grows the scroll area instead of squishing other sections. Idle empty state invites the user to type a search — it does not show a perpetual "Preparing…" label.
- **Clear** resets scope/corpus, filters, tags/relations, Display (list + shown fields), Sort (group by), search engine, and top embeddings back to defaults. It leaves the search box text alone.

Menus (one open at a time; badge counts show non-default choices):

- **Scope** — **Headings** or **Files**, plus **Corpus** (Working set with `.dripignore`, Entire KB, or custom paths).
- **Filter** — metadata type chips limited to **None**, **concept**, and **task** (KB note headings only; project types are not offered). Selecting a type opens that type's metadata key filters; each key uses a compact dropdown (selection is kept when the menu closes or you switch to another key).
- **Tags** — tag filters (with a saved tag-graph picker) and relation-type filters. Tag suggestions drop outside the popover (not clipped inside a scroll box). Multiple tags on the same relation type are shown together, comma-separated.
- **Display** — **List** / **Board** and "Shown in results" (type marker, key-values, tags, relations, filepath).
- **Sort** — **Group by** only (none / folder / file / type). Search engine + Top embeddings live on the icon next to the search box.

- **Files scope** shows results as collapsible file sections (filename + count; expand to see matching headings). Sections start collapsed. **Headings scope** uses Group by instead.
- Result rows and board cards stay compact (title + score, pills row, optional path).

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
2. (Optional) opens Scope / Filter / Tags / Display / Sort, or the search-engine icon beside the search box.
3. Types a search term → headings matching across the KB are listed (list or board).
4. Picking one opens the file at that heading.
