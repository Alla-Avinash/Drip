# Feature: Markdown editor (`.d.md`)

## What it is

`.d.md` files open in a custom editor that shows the note in a WYSIWYG markdown view — you type plain markdown, but the syntax is hidden and the text renders in place (headings appear large and bold, `**bold**` looks bold, `[link](url)` shows just the label as a link, task lists show checkboxes). This uses CodeMirror 6 the same way Obsidian's Live Preview does: the file stays plain markdown on disk, and editor "decorations" hide the markers and style the content. The whole editor is centered in the panel at a comfortable max width (860px), so the reading canvas never stretches to the window edges; the fold gutter stays right beside the text. The current line is highlighted with a translucent background — translucent because the text selection is drawn behind the text, so an opaque highlight would hide it and make a single-line selection invisible.

The file-identity banner (the `<!-- drip-file … -->` header comment) renders as a block widget at the very top. Like every block-widget root in the editor, it uses padding (never a vertical margin) for its spacing — a vertical margin isn't measured by CodeMirror, so it would shift every fold chevron below it out of vertical alignment with its heading.

## Where to access it

- Automatic — no command or setting. Opening any `*.d.md` file opens this editor directly: it is set as the default editor for `.d.md` (over the plain text editor and Markdown Preview). The "Reopen Editor With…" menu still lets you switch temporarily.

## Scope

- The editor itself only loads and saves the note text and is self-contained. Separately from the editor, a host-side validator watches `.d.md` notes for hidden metadata comments (see "Metadata comments" below) and cleans them once on open; it does not touch the editor rendering or the DRIP index/database.

## What renders in place

- Headings (`#`…`######`) — the `#` markers are hidden and the title is sized per level. A lone `#`/`##` at the start of a line stays plain text until a space follows it, so typing `#` then a space converts the line into a heading.
- Bold / italic / strikethrough — the `**` / `*` / `~~` delimiters are hidden and the text is styled.
- Inline code and fenced code blocks — backticks/fences are hidden and the code is monospace. An unclosed fenced block (only the opening ``` typed yet) stays raw until the closing ``` is typed, so a code block renders only once it is complete.
- Links — the `[`…`](url)` syntax is hidden; only the label shows, styled as a link.
- Horizontal rules (`---`, `***`, `___`) — render as an `<hr>`; the raw `---` reveals while the cursor is beside it.
- HTML entities (`&nbsp;`, `&amp;`, `&#160;`, …) — decode and render the actual character; the raw entity reveals while the cursor is beside it.
- Images — `![alt](url)` renders inline: remote URLs (http/https/data) show the real image, and local/relative paths (e.g. `./img.png`) are resolved against the note's directory and shown too (a "🖼 alt" placeholder appears only until the file resolves, or if the file can't be found). Clicking the image selects its whole source so you can retype or delete it. While the cursor is right beside the image, the full raw `![alt](url)` markdown is revealed instead of the rendered image, so the source is fully visible and editable.
- Tables — render as a real HTML table (header row, bordered/padded cells, hover highlight). Cells are directly editable: clicking a cell places the caret in it, typing edits it live, and the change commits back to the markdown source when focus leaves the cell. While a cell is focused, Tab / Shift+Tab move to the next / previous cell, and the Up/Down arrows move to the cell above/below in the same column. A "+" button below the table adds a row; a "+" button to the right adds a column. Right-clicking a cell opens a context menu with "Row" and "Column" submenus: rows offer add above/below, move up, duplicate, delete; columns offer add left/right, move left, duplicate, delete. Rows and columns also have drag-to-reorder grips: a small grip floats to the left of each row and above each column header, outside the table's borders. The grips appear only while the mouse is near that edge — a row grip shows while hovering the row's first cell, a column grip while hovering its header — not whenever the mouse is anywhere over the table. Dragging a grip shows an insertion line between the rows/columns (above/below the row, left/right of the column you hover), and dropping there reorders that row/column. The grips are floating overlays, so they never add cells or shift the table layout. Cells keep a simple rectangle shape — a minimum width and height so every column has real width and empty cells don't collapse; text wraps within the cell after that width. The table grows to its natural width and scrolls horizontally inside its own scroll area (its scroll bar appears whenever the table is wider than the editor); scrolling there never chains into scrolling the document, and the document itself only scrolls vertically. The table sits with margin around it so the "+" buttons (add row below, add column right) are always visible and clickable outside the table borders.
- HTML blocks — a standalone `<div>`/`<p>`/etc. renders as actual HTML, isolated inside a shadow root (so its CSS can't leak into the editor, and scripts/handlers are blocked by the CSP). The shadow content is styled with the editor's font/color and sensible defaults for headings, lists, tables, code, links, images, and rules. Clicking it selects the raw HTML source so it is editable; leaving re-renders it.
- Paired container HTML (e.g. `<details>…</details>`, `<div>…</div>`) that spans blank lines and markdown — the parser splits such a component into separate HTML blocks, so the editor merges the opening/closing tags back into one unit: the whole component renders as one block, and the entire raw source (both tags plus everything between) reveals together when the cursor is beside it. A `<details>` component renders as a real collapsible dropdown (native `<summary>` with a caret), not as plain text.
- Inline HTML — `<b>`, `<strong>`, `<i>`, `<em>`, `<u>`, `<s>`, `<del>`, `<code>`, `<mark>`, `<sub>`, `<sup>` tags are hidden and their content is styled with the matching effect; a `<span>` with an inline `style` attribute applies that style to its content, so `<span style="background:…">chip</span>` renders as a styled chip/badge; `<img>` renders the image; `<br>` inserts a line break; `<hr>` a rule; other void tags are hidden.
- Task lists — the `- ` marker is hidden and `[ ]` / `[x]` render as a checkbox you can click to toggle. The raw `- [ ]` / `- [x]` source shows dimmed instead of the checkbox only while the cursor is right beside the marker, so it can be edited without revealing on every line the cursor visits.
- Bullet lists — the `-`/`*` marker is replaced by a bullet. The raw `-`/`*` marker shows dimmed only while the cursor is right beside it (not anywhere else on the line). Tab indents list items by 4 spaces (the markdown standard), so nested lists align correctly; when a numbered item is indented into a sub-list, the sub-list restarts its numbering at `1.` instead of continuing the parent list's numbers.
- Blockquotes — the `>` marker is hidden and the quote is indented and tinted.
- Headings are collapsible — a fold gutter sits beside each heading with a bold SVG chevron (down when expanded, right when folded) so you can collapse/expand its body. Heading fold chevrons are always visible; the fold chevrons of other foldable sections (code blocks, HTML blocks, tables, lists, quotes) appear only while the mouse is over their line.

### Fold-chevron vertical alignment (block-widget rule)

The fold chevrons stay lined up beside their headings because every block-widget root in the editor measures exactly the space it occupies. CodeMirror sizes a block widget by its border box and positions each fold chevron by summing line and widget heights, so a widget that occupies more space than it measures throws every chevron below it out of vertical alignment. Two things cause that and are therefore banned on block-widget roots:

- **Vertical margins** — a margin is outside the border box, so it isn't measured. Block-widget roots use `padding` (which is inside the border box) for spacing instead. This is why the file-identity banner, chip rows, tables, `<hr>`, and HTML blocks all use padding and no vertical margin.
- **`inline-block` display** — an inline-block child sits inside the content's fixed line box, which reserves a full line height, while the widget measures only its own border box. Block-widget roots must be true `block` elements. This is why the `+` promote button is `display: block; width: max-content`.

## Reveal-on-cursor (editing a rendered line)

Markers are hidden only while the cursor is elsewhere. When the cursor is inside a text node (a heading, bold/italic span, inline code, or link), that node's markers (`#`, `**`, backticks, `[]()`) are shown dimmed instead of hidden, so the underline markdown is visible and directly editable — the same behavior as Obsidian's Live Preview. List markers (`-`, `- [ ]`) are the exception to the "whole node" rule: they reveal only when the cursor is right beside the marker, not anywhere else on the line. Tables stay rendered while editing, because their cells are edited directly inside the rendered table rather than by revealing source.

"Beside" always means on the same line: a marker that sits at the start or end of a line reveals only when the cursor is actually on that line, never when the cursor is on the line above or below. This applies to images (`![alt](url)`), task-list markers (`- [ ]`), horizontal rules (`---`), and HTML entities (`&nbsp;`), which each reveal their raw source only when the cursor is right next to them on the same line.

HTML reveals on adjacency: a rendered HTML block (or an inline HTML tag) shows its raw source whenever the cursor is inside it or on the same line as the element — but not when the cursor is on the line directly above or below it. Paired tags (e.g. `<b>` and `</b>`) reveal together as one unit. This applies only to HTML, never to tables (tables stay rendered through markdown).

## File header (identity block)

Every `.d.md` note keeps a one-line identity block at the very top, before the title, so a plain markdown editor shows only clean content:

    <!-- drip-file filename: "My Note" | fileid: @f23 | headings: 5 -->
    # My Note

- `filename` is the file stem (the basename minus `.d.md`), `fileid` the sequential per-knowledge-base id (`@fN`), and `headings` the count of persistent headings in the body (a heading is persistent when it has a hidden comment under it — see "Metadata comments").
- The identity block is **display-only** in the DRIP editor: it renders as a small banner above the title showing the filename, file id, and persistent-heading count. It is never editable — the raw comment stays hidden as the source of truth, and the banner is only a visual summary. The h0 title renders as a normal heading beneath it.

A host-side reconcile keeps this block in shape without touching the body. It runs on open and on save only: it reads the file and — only when something actually drifted — rewrites the top, correcting `filename` to the stem, aligning the h0 heading to match the stem, and refreshing the persistent-heading count. It never runs on a mid-typing debounce, because the webview is the single writer of an open document and a background rewrite would race the editor (see "Single writer" below).

The `fileid` is resolved against the database rather than trusted from the file. If the file already carries a valid `@fN` and that id points back to this same file in the index, it is kept verbatim; if it points at a different file (or is missing entirely), a fresh sequential `@fN` is allocated under the same lock the `.d.txt` notes use, so two files opened at once can't race to the same id. When the id changes, every other note that referenced the old id (links and backlinks) is rewritten to the new one, so changing an id never silently breaks links.

## Metadata comments (hidden, under headings)

A persistent heading carries its identity and metadata in a one-line HTML comment directly under it. The heading title is plain markdown — there is **no type prefix** in the title — the type lives only in the comment:

    # My Concept
    <!-- drip h12 | concept | status: in-progress | deadline: 2026-04-29 18:30 | tags: [a, b, c] -->

`h12` is the per-file heading number, `concept` the metadata type id, and the rest are `key: value` fields. An untyped-but-indexed heading uses the `persistent` marker instead of a type id (`<!-- drip h12 | persistent | tags: [a, b] -->`). A heading with no comment under it is a plain heading — not indexed, no id, no chips.

Because enum/datetime/duration values can only come from DRIP settings, invalid values only appear when a note is hand-edited as text. So a one-time sweep runs the first time each note is opened in a session (including tabs restored from a previous session) and drops invalid fields straight out of the comment: unknown keys, empty values, enum values outside the allowed list, non-canonical datetimes (`YYYY-MM-DD HH:mm` only), and bad durations. The comment's own type token is the authority for which fields are valid. This is host-side and never touches the database.

The same sweep also validates tags against the note's graph: each tag in `tags: [...]` must exist in the note's tag graph (the project graph when the note is inside a project/feature folder, otherwise all KB tags). A tag that was deleted from the graph is dropped from the comment — even though the tag may still linger in the database's tag vocabulary table — and a `tags` field left empty by that is removed. An empty graph means "nothing to validate against", so tags are left alone in that case.

The same sweep also removes **orphaned drip comments**: any `<!-- drip … -->` comment that isn't a valid header at the top and doesn't sit directly under a heading line is deleted outright. The `<!-- drip-file … -->` header is kept only when it appears before the first heading; a stray heading comment (`<!-- drip hN … -->`) with no heading above it is removed.

### Legacy prefixes are stripped automatically

Notes created before this change used a `.` prefix on the heading title to mark the type (`# .c Concept`, `# .task Do it`, `# .i-7 Bug`, `# . Plain`). The sync now strips that prefix from the heading line on open/save, leaving the clean title and keeping the type in the comment. An issue number like `.i-7` keeps its `i-7` in the title (only the type dot is dropped); the type itself moves to the comment as `issue`.

### The chip picker and type picker

In the DRIP editor, a drip comment is never shown as raw text. A heading's comment renders as a row of **chips** when it sits directly under its heading, and an orphaned drip comment — one that no longer sits directly under a heading — is hidden outright, so it can never flash into view before the open/save sweep removes it. The chips are built from the metadata schema sent by the host (the same `metadataTypes` + relations the `.d.txt` files use), so nothing is hardcoded.

A heading and its comment are treated as one unbreakable unit, and the comment line is **read-only to the user's keystrokes**. A transaction filter blocks any direct edit that would touch a drip comment (or the `<!-- drip-file -->` header, or the newline directly above/below one), so Backspace, Delete, Enter, typing, and paste can never split, merge, or alter a comment — no matter where the caret is. The comment can only change through two deliberate paths: the chip picker (which rewrites or deletes the comment line, opting out of the filter) and the host sync (which renumbers heading ids and reconciles the header on save, also opting out).

The caret can never rest on a drip comment line. A second transaction filter re-maps any selection that lands on a comment (or the file banner) to the nearest safe line: moving down/forward jumps to the start of the line *after* the comment, and moving up/backward lands at the end of the line *above* it. So arrow keys, Page Up/Down, and clicks all skip over the chip row as if it weren't there.

**Enter** at the very end of a heading line is the one key the filter leaves to a keymap handler, because it needs to re-route rather than block: it lands the caret on the line *after* the comment (creating a blank line there only when body text directly follows), so the comment always stays glued under the heading title.

The comment disappears only when its heading stops being a heading — the heading line is deleted, or the space after the `#` is removed so the line no longer reads as a heading. A comment left orphaned by such a removal is hidden in the editor and deleted by the open/save sweep.

The type list is filtered by where the note lives. A `.d.md` in a normal knowledge base offers only `concept` and `task`; a note inside a project or feature folder (any ancestor directory ending `.p` / `.f`) additionally offers `issue`. Project/feature themselves are file-level types for index notes, never heading types, so they are never offered here. `persistent` (the untyped-but-indexed marker) is always available alongside the filtered types.

- A **type chip** first (e.g. `concept` or `persistent`) — this one is a button. Clicking it opens the "Heading type" picker, which lists `persistent` plus the note's allowed metadata types as just the type name (no description subtext). The current type is marked with a tick; clicking the already-selected type again deselects it (demotes the heading back to a plain heading and deletes the comment), while clicking any other type selects it. Picking a type rewrites the comment's type token in the source.
- One chip per field already present, shown as `key: value` (e.g. `status: in-progress`).
- A faint **`+ key`** chip for every attribute (and relation) not yet present, so the user can add them.

A plain heading (no comment) shows a small **`+`** glyph on its own line directly **below** the heading, always visible (dimmed, brightening on hover) — placed below rather than beside the title so it never pushes the heading text sideways. It renders as a true block (not inline-block): an inline-block inside the content's fixed line box occupies a full 21px line while measuring only its own ~15px border box, so CodeMirror mis-measures it and every fold chevron below it drifts out of vertical alignment with its heading. Clicking it opens the same "Heading type" picker; picking a type inserts the comment line directly under the heading and the heading immediately renders its chip row — no host round-trip needed.

Clicking a field chip opens a small dropdown to edit that value: an enum shows its allowed values, a duration shows an amount + unit picker, and a relation (`tags`, `pre-req`, …) opens the same searchable tag dropdown (see "Tags dropdown"). An enum dropdown ticks the currently selected value (clicking it again deselects and removes the field); the duration/relation dropdowns instead offer a **Remove** option to clear that field. Picking a value rewrites the hidden comment in the source — a pure editor edit (like toggling a checkbox), with no database involvement. Every dropdown closes as soon as the user clicks anywhere back in the document (or presses Escape), so it never lingers after a pick or an outside click. The host re-sends the schema whenever DRIP settings change, so the chips stay in sync without reopening the note.

### Datetime normalization

A datetime field (e.g. `deadline`) edits through a free-text input that normalizes like `.d.txt`: an absolute `YYYY-MM-DD HH:mm` passes through unchanged, and a relative phrase (`2 days`, `45 min`) is converted into the absolute minute string. Input that doesn't parse (or is empty) clears the field. This is the same normalization the `.d.txt` completion offers, so the two formats always agree.

### Tags dropdown

Every relation (`tags`, `pre-req`, …) edits through the same dropdown instead of a plain list input — relations all reference tags, so they share one picker. It lists the current values (ticked) plus the tags already known for the note, and a **create new tag** input at the bottom creates the tag in the matching graph. Where a tag lives follows the note's location, and the KB and project scopes are kept fully separate:

- **Inside a project/feature folder** — the dropdown lists that project's own per-project tags, and a new tag is created in that project's tag graph.
- **In a normal KB** — the dropdown lists every KB tag (all tags across every KB tag graph, deduped), and a new tag is created in the dedicated **"individual tags"** KB graph — never the graph currently open in the Tags view. Project tags live in a separate per-project store, so they never leak into the KB list.

The dropdown has a **search box** at the top so it never dumps the full tag list. As you type it narrows the results live: word matches first (ranked exact → starts-with → contains, up to 3), then semantic matches from the tag embeddings (up to 3, non-overlapping with the word matches). Semantic matches come only from the KB tag embeddings, so a project note's dropdown stays word-only. The **create new tag** input at the bottom is pre-filled with what you typed, so an unmatched name can be created in one keystroke. With an empty search box, the dropdown shows just the current tags plus a small slice (8) of the graph's tags rather than everything.

Clicking an existing tag toggles it (adds it if missing, removes it if already present). Stale tags are cleaned out by the open-time sweep (see "Metadata comments"), not by the dropdown itself.

### Single writer (no background rewrites)

The webview is the **single writer** of an open `.d.md` document. Every type/field change is a pure editor edit that rewrites the hidden comment in the editor state; the change then propagates to the file through the normal save path. The host never writes an open document to disk behind the editor. Three `.d.txt`-era background writers are kept away from `.d.md` files for this reason: the heading-identity reconcile, the file-identity normalizer (the hash-based `.d.txt` identity layer), and the file-header reconcile on a mid-typing debounce. The `.d.md` sync itself only writes to disk when the tab is already closed, and folds its reconcile into the save itself. This is what prevents the "content is newer" save-conflict.

## Index sync (database & embeddings)

The editor itself is self-contained; a separate host-side layer keeps every `.d.md` note in the same index the `.d.txt` notes use, reusing that database layer unchanged. The `.d.md` format has no `@fN:hM` identity lines — its identity lives in the two hidden comment blocks — so this layer parses those comments and writes the same heading/tag/relation/metadata rows a `.d.txt` note would produce.

Persistent headings are the only ones indexed. A heading counts as persistent when it has a hidden `<!-- drip hN -->` comment directly under it; plain headings like `# Section` are excluded and never get an id or a comment. The first heading in the file is always the h0 title, kept as the file's name, never as a body heading.

The sync resolves an id for every persistent heading and writes it into that heading's `<!-- drip hN -->` comment. A valid id already in the comment is kept; a duplicate id (from a hand-edit) is replaced with a fresh one; a heading whose comment was deleted recovers its old id by matching its cleaned title against the database, otherwise it gets a fresh id. Parent is computed strictly from heading depth — indentation plus the markdown `#` level — and only persistent headings can be parents; body text, blank lines, and comments never close a parent section.

Two changes are treated differently so cheap edits stay cheap:

- **Title or tags changed** → the rows are updated and a vector embedding is queued (the embedding text is just the title + tags).
- **Metadata, parent, or relations changed** → the rows are updated in place with no re-embedding, so flipping `status: in-progress` never triggers a vector re-encode.

Persistence is a full replace of the file's heading rows each sync, so a deleted heading's embedding, tags, relations, and typed-metadata rows all fall away naturally, and any child whose parent pointed at it is re-pointed. The whole pass is idempotent: a signature of the index-relevant content is compared before writing, so an unchanged note never touches the database.

The lifecycle is host-side and does not depend on the webview being visible, so tabs restored from a previous session (which open before the knowledge-base root is verified) are picked up too:

1. On open — parse the note and persist its rows to the index. It never touches the open buffer or disk.
2. On save — reconcile-in-save: the sync computes the canonical text (fresh heading ids, stripped legacy prefixes) and returns it as the save edit, so the file is saved already reconciled — no separate disk write, no "content is newer". The rows are then persisted.
3. On close — flush immediately (writing straight to disk, since the tab is already closed).
4. On delete — remove the file's rows from the index.
5. At startup — poll briefly (bounded retries) until the knowledge-base root is verified, then sync every already-open `.d.md` document.

There is deliberately no mid-typing debounce: reconciling while the user types is what caused the save conflicts, so the sync waits for the note to be at rest (saved or closed). A newly promoted heading is written with `h0` and gets its real id on the next save.

When the file id changes (drift/collision), the link rewrite described under "File header" runs after the id is resolved, so references stay correct.

## Flow (plain steps)

1. User opens a `*.d.md` file; VS Code opens the custom editor webview.
2. The host embeds the current file text directly into the page, so the CodeMirror 6 editor renders it immediately on first paint — no round-trip needed.
3. As the user types, the editor posts the new text back and the host writes it to the document.
4. If the file changes on disk or in another editor, the host pushes the new text back — but only when it actually differs (after normalizing `\r\n`/`\r` line endings), so the caret and scroll position stay put while typing instead of jumping to the top.
5. The caret is always placed using CodeMirror's own document length (never the raw string length), so CRLF files don't crash with a "Selection points outside of document" error.
6. If the editor fails to start for any reason, the error message is printed into the editor area instead of leaving a silent blank page.
