# Feature: Capture and Composer

## What it is

The Composer is where a user drafts a new note or captures a selection/clipboard before placing it into the knowledge base.

## How to access it

- **Open Composer**: `Ctrl+U` (or from the Components view).
- **Capture selection/clipboard**: `Ctrl+Shift+U`.

## Sub-features

### Quick capture

- Selecting text in the editor (or copying it) and running Capture sends it into the Composer.
- The selected text is cut from the source and copied to the clipboard.

### Composer panel

- A panel for writing a note draft before saving it into the KB.
- Drafts can be opened, edited, and saved.

### Ingest planning

- After writing, DRIP decides where the note should go: merge into an existing note, append, or create a new heading/file.
- Ingest candidates are computed to suggest the best destination.

## Flow (plain steps)

1. User captures a selection (or clipboard) → it opens in the Composer.
2. User writes/edits the note in the Composer.
3. On save/ingest, DRIP suggests where to place it (top folder, next heading, etc.), optionally using embeddings to rank the best spot.
4. The note is written into the KB and indexed.
