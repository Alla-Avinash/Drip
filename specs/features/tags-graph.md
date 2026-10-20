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

- A webview panel lets the user create and edit tag graphs (add tags, join them with links, group them, and nest sub-tags).
- Links are plain directed edges (no relation labels); the sidebar has no relation-type controls.
- Changes persist and immediately affect completion.

### Tag completion sync

- The editor's tag completion reads from the active graph, so only known tags are suggested.

### Tag embedding search

- Tags can be searched semantically (embedding-based), letting the user find related tags by meaning.

### Per-project tags

- The panel opens with a header showing the **Tags Graph** title and, right beside it, a **Knowledge Base / Projects** radio switch. Below the header is a single selection box that holds all the top controls together: in **Knowledge Base** mode the graph selector (plus rename/delete/combine), and in **Projects** mode the project dropdown; **Export**, **Reset view**, and **Delete nodes** sit in the same box in both modes. The graph canvas fills the left and the right sidebar (tag list + graph settings) always stays on the right, in both modes.
- **Knowledge Base** mode edits the global KB tag graph as before.
- **Projects** mode swaps the canvas to a per-project graph: it shows the selected project's own tags and behaves exactly like the Knowledge Base graph — the user can add tags, join them with links, and use groups and sub-tags. The selection row shows only a project dropdown. Multi-graph management controls (graph selector, rename/delete/combine, export, undo/redo) are hidden because each project has a single graph.
- In Projects mode every graph edit (tags, links, groups, sub-tags, layout) writes to that project's own graph, never the global KB graph.
- Each project's graph is stored as one file under `<kb>/.dripindex/project-tags.drip/`, using the same node/link shape as the global graph, plus an optional per-node `description`. The Project View's **Tags** popover reads the same graph and shows only its top-level (root) tags with their name and description.

## Flow (plain steps)

1. User opens the Tags graph panel and edits the set of tags and links.
2. The graph is saved; the editor's tag completion now suggests those tags.
3. A note using an unknown tag is underlined as an error rather than silently adding a new tag. The error carries a quick fix that creates the tag in the note's own scope — the per-project graph for a note inside a `.p`/`.f` folder (creating that graph if missing), or the KB "individual tags" graph otherwise — and the message names that scope (`Unknown tag "bug". Create this tag in the project graph.` for a project note).
