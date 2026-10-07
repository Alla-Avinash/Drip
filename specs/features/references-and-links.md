# Feature: References and links

## What it is

Notes can link to other notes and to specific headings inside them. These links use stable IDs, so they keep working when files are renamed or moved.

## How to access it

- In the editor: type an `L.` line in a `.d.txt` note, use completion, and click links to follow them.
- Process pending migrations via the **Process pending link migrations** command.

## How links look

- `L.` lines carry links to other KB files (and optionally specific headings), e.g. `L. @fileid1, @fileid2` or a heading reference.
- References use `@f` for a file and `@f:h` for a heading within a file.

## Sub-features

### Reference assist

While typing, the editor suggests known file/heading IDs to complete a reference.

### Go-to-definition

Clicking/triggering on a reference navigates to the linked file (and heading).

### Document links

The editor exposes references as links the user can follow.

### Link drop-in

Dropping a file into the editor inserts a link to it.

### Link migrations

When IDs change (e.g. a heading is restructured), pending link migrations are tracked. The user runs a command to process them so references stay consistent.

## Flow (plain steps)

1. User writes an `L.` line and gets completion suggestions for target files/headings.
2. The reference is clickable; following it opens the target.
3. If a target's identity changes, the change is queued as a migration and processed on demand.
