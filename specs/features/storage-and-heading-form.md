# Feature: Storage and Heading form (RHS)

## What it is

Two right-sidebar views: **Storage** for browsing the KB and placing/ingesting notes, and the **Heading form** for editing a heading's structured metadata.

## How to access it

- Both are in the right (secondary) sidebar: the **Storage** view and the **Heading** view.
- Storage opens when ingesting; the Heading form appears when the cursor is on a heading.

## Storage

- Browse the KB tree to pick a file/heading destination.
- Ingest a note from the Composer into the chosen destination.
- Shows ingest suggestions (optionally ranked by embeddings).
- Receives and syncs note/settings state from the editor.

### Where the note lands in a file

When the target is a file, Storage shows that file's heading tree and the user picks a spot in it (by pointing at a heading row or moving the insert slot):

- **Before / after a heading** — the note becomes a sibling heading at that spot.
- **First sub-heading** — the note becomes the first child of the heading. It goes *after* the heading's metadata lines (`.concept`, `tags: […]`, …), because those lines belong to the heading and must stay directly under it.
- **End of section** — for a heading with no sub-headings yet, the note goes at the end of that heading's content.
- **Default** — if the user picks a heading but no exact spot, the note goes at the bottom of that heading (after its last sub-heading).

If the note has no title, the user chooses between **Append** (the text is added to the heading's own content, no new heading) and **New heading** (the user types a title; it defaults to the note's first line).

## Heading form

- Edits the current heading's metadata (title, type, tags, status, etc.) in a form.
- Works with project/feature/issue heading types (the form shows the relevant fields for that type).
- When editing via the form, the title/metadata is soft-locked in the editor.

## Flow (plain steps)

1. User opens Storage to browse where a captured note should go, then ingests it.
2. When on a heading, the Heading form shows its fields; edits apply back to the note.
3. Soft-lock prevents the title/metadata from being changed directly in the editor while using the form.
