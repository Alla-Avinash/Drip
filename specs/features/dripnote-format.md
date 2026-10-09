# Feature: The `.d.txt` note format

## What it is

DRIP notes are plain text files with the `.d.txt` extension. They are written in a "dripnote" language that combines free-form markdown with structured metadata, typed headings, tags, and special prefixes.

## How to access it

- You see this whenever you open or create a `.d.txt` note in the editor — it is the note itself.
- Create one from the KB **New → New Note** menu.

## Structure

### File header

At the top of the file, key/value lines such as:

```
filename: react basics
created: April 02 2026
fileId: @sok02394
```

The `fileId` starts with `@` and is unique — it is the file's stable identity.

### Metadata blocks

A root type marker followed by indented key/value lines, for example:

```
.concept
    domain: frontend
    status: in-progress
    tags: [ react, hooks ]
    pre-req: [ javascript, webdev ]
```

- `tags: [ ... ]` is the default searchable relation.
- Other relations use `relation-name: [ ... ]` (e.g. `pre-req`).
- If no type is given, the default is `.concept`.

### Headings

Markdown-style headings (`# ...`) structure the note. A bare bracketed list directly under a heading means heading-level tags for that section.

### Typed blocks inside sections

A type marker with its own metadata can appear inside a section, e.g. a `.task` block with `status`, `priority`, `deadline`.

### Special prefixes

Quick-scannable markers:

- `Q.` a question
- `R.` a resource/reference (URLs allowed)
- `L.` a link to other KB files
- `U.` a use case / real-world example

## Metadata types

The application ships with a fixed, standard set of metadata types, split into two groups:

**Document KB types** (heading types, in the note zone):

- `.concept` — `domain` (enum), `status` (enum)
- `.task` — `status` (enum), `priority` (enum), `deadline` (datetime), `category` (enum)

**Project types** (file-level types for `.p` / `.f` index notes, plus issues):

- `.project` (file-level) — `status`, `priority`, `deadline`
- `.feature` (file-level) — `category` (enum)
- `.issue` — `priority` (enum), `status` (enum), `deadline` (datetime), `category` (enum), and a built-in `parent` (`i-N`) link

These built-in fields cannot be deleted, but the user can edit their enum values and add new keys with the standard datatypes (enum, datetime, duration). The built-in fields map to fixed database columns; anything the user adds is stored in a shared remaining-keys table.

File-level types apply to the whole file (project/feature index notes); document types apply to headings.

## How it fits together

The format is parsed by the editor language services (coloring, completion, diagnostics) and by the indexer (which turns it into indexed headings, tags, relations, and metadata). The format stays human-readable and diff-friendly — the structured parts are just indented lines, not hidden markup.
