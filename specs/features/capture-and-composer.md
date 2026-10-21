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
- Capture detects the source format (`.d.txt` vs `.d.md`) and converts the selection into a neutral draft shape that both formats share: a clean heading title, a metadata type, an ordered list of key/value fields, and the body (which keeps any nested headings).
- A selection spanning several heading levels is trimmed to the first heading's own subtree: capture stops at the first heading *above* the first captured heading (a shallower level — e.g. a `#` above a `##` heading). Everything from that heading onward is dropped, so the Composer (and the cut from the editor) only ever contain the captured heading plus the headings nested under it; sibling headings at the same level stay, and any parent heading above it is left in the file untouched.
- Capturing from the `.d.md` WYSIWYG editor also works: the extension asks that editor's webview for its CodeMirror selection (a custom webview editor has no `activeTextEditor`), then cuts it the same way.

### Neutral draft (intermediate format)

- A draft is `title` (clean heading text), `typeId` (concept/task/issue/decision, `persistent` for untyped-but-indexed, or empty for plain), `fields` (ordered `key: value` pairs; list values such as tags are stored bracketed like `[a, b]`), `content` (body prose plus nested headings), and `sourceFormat` (the format the selection came from: `drip-md` or `drip-txt`).
- Nested headings in `content` are kept in a neutral markdown form (flush-left ATX `##`/`###`), so they round-trip: `.d.txt` marker levels (`#1`, `#2`) become `##`/`###` on capture, and are re-levelled back into the target's heading syntax on ingest (markdown headings stay flush-left; `.d.txt` headings re-appear as `#1`, `#2`). Heading levels are rebased relative to the captured root, so a child one level under the captured heading always maps to `##`, two levels under to `###`, and so on — the draft keeps the subtree's *relative* shape no matter how deep in the file the captured heading sat (a `##` parent's `###` child and a `#` parent's `##` child both become a `##` child, and re-appear one level under the new note title in either target).
- Nested-heading metadata is normalized to the same neutral form on capture: a `.d.md` `<!-- drip hN | type | key: value … -->` comment stays a comment, and a `.d.txt` metadata block (`.marker` + indented `key: value` lines) is lifted into a comment. On ingest the comment is re-serialized for the target — back to a `.marker` block for `.d.txt`, or kept as a comment for `.d.md` — so sub-headings never leak one format's syntax into the other.
- `.d.txt` headings carry a type shortcut (`# .c Concept`); capture strips the shortcut into `typeId` and keeps only `Concept` as the title. The metadata block (`.concept`, `key: value` lines) becomes the fields.
- `.d.md` headings are already clean (`# Concept`); the `<!-- drip hN | type | key: value … -->` comment under the heading becomes the `typeId` and fields. A stray `.d.txt`-style `.marker` block under a `.d.md` heading (from a hand-edit or older ingest) is read the same way and converted to a comment.
- When a selection holds two or more sibling top-level headings, capture sets `multipleRoots`: the whole selection is kept as the body with no single title (so nothing is collapsed into one note) and the Composer says so — it can be saved as a draft instead.

### Composer panel

- A panel for writing a note draft before saving it into the KB.
- The heading field shows the clean title (no `.d.txt` type shortcut).
- The metadata section mirrors the `.d.md` editor's chip picker, split into two rows: heading-level metadata on top, tags and relations below. The top row is the dashed type chip (showing the current type, or `persistent` when untyped) followed by one chip per heading attribute already present (`key: value`) and a faint dashed `+ key` chip for each attribute not yet present. The bottom row is one chip per relation field present (`tags`, `pre-req`, …) and a `+ key` chip for each missing relation. Clicking the type chip opens the "Heading type" picker listing `persistent`, `concept`, and `task` (the current one ticked).
- Picking a type (including `persistent`) clears the previous type's heading attributes — a heading carries exactly one type, so its type-specific attributes no longer apply. Tags and relations live on their own row and stay.
- Clicking a heading-attribute chip opens a small dropdown to edit its value: an enum shows its allowed values (the current one ticked, re-clicking it removes the field), and a free-text value (datetime/duration/ref) shows a text input with a Remove option.
- Every relation chip (`tags`, `pre-req`, …) opens the same searchable dropdown the `.d.md` editor uses — relations all reference tags, so they share one picker: a search box, the current values (ticked) plus a small slice of the KB's known tags, a live filter with word matches (exact → starts-with → contains) followed by semantic (embedding) matches from the host, and a "create new tag" input at the bottom that creates the tag in the KB graph. Tags are read from the KB tag graphs and new tags are created in the KB "individual tags" graph — the Composer is knowledge-base-only, so `issue` and `decision` never appear and project tags are never offered.
- Drafts can be opened, edited, and saved.

### Ingest planning

- After writing, DRIP decides where the note should go: merge into an existing note, append, or create a new heading/file.
- Ingest candidates are computed to suggest the best destination.
- The note is serialized back into the target file's own format, and nested sub-headings inside the body are converted the same way as the top heading:
  - A `.d.txt` target gets a tab-nested heading with the type shortcut re-applied (`# .c Concept`) and a metadata block (`.concept` plus indented `key: value` lines) above the body; an untyped-but-indexed heading gets a bare `.` shortcut and no `.marker` line (only its fields). Nested headings re-appear as `#1`, `#2` with the same shortcut/marker treatment.
  - A `.d.md` target gets a flush-left markdown heading (`# Concept`) with a hidden `<!-- drip h0 | concept | key: value … -->` comment directly under it (its real `hN` id is resolved on the next open/save). Nested headings keep their comments as-is.
  - A brand-new `.d.md` file gets the `<!-- drip-file … -->` header, a `---` separator, two blank lines, then the h0 title (with its metadata comment — `persistent` by default) and the body.

## Flow (plain steps)

1. User captures a selection (or clipboard) → it opens in the Composer as a neutral draft.
2. User edits the clean heading and the metadata chips.
3. On save/ingest, DRIP suggests where to place it (top folder, next heading, etc.), optionally using embeddings to rank the best spot.
4. The note is written into the KB in the target's format and indexed.
