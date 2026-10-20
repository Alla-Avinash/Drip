# Feature: The `.d.txt` note format

## What it is

DRIP notes are plain text files with the `.d.txt` extension. They are written in a "dripnote" language that combines free-form markdown with structured metadata, typed headings, tags, and special prefixes.

## How to access it

- You see this whenever you open or create a `.d.txt` note in the editor — it is the note itself.
- Create one from the KB **New → New Note** menu.

## Structure

### File header

At the top of the file, three key/value lines, then a `---` separator, then one empty line, then the file's own root heading (`h0`):

```
filename: react basics
fileid: @f23
headings: 2
---

@h0
# . react basics
Some about text under the file heading

#1 First section
```

- `fileid` is the file's stable identity (`@fN`), unique across the KB.
- `headings` is the count of non-h0 headings below the `h0` block.
- `@h0` is the file heading's identity line; the heading itself is `# . <filename>`.
- Everything above `---` is file-level metadata (only the `filename` / `fileid` / `headings` keys); everything below it is the note body, starting with the `h0` block.

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

Headings use a numeric marker, not markdown `#`-counts or indentation:

- `#` is the root / file-level heading (`h0`).
- `#1` is a first-level heading, `#2` a second-level heading, and so on.

Hierarchy is read **from the marker number only** — leading tabs or spaces before the marker do not change a heading's level. Each heading has its own identity line (`@hN`) on the line directly above it. The `h0` heading sits below the `---` separator:

```
---

# . My Note            ← h0 (file heading)

#1 Concepts           ← level 1
	#2 Frontend        ← level 2, child of "#1 Concepts"
```

Body prose and metadata under a heading are tab-indented relative to its level: a metadata marker (`.concept`, `.issue`, …) sits at `level + 1` tabs, and its `key: value` attributes at `level + 2` tabs.

A bare bracketed list directly under a heading means heading-level tags for that section.

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

**Project types** (file-level types for `.p` / `.f` index notes, plus project-scoped heading types):

- `.project` (file-level) — `status`, `priority`, `deadline`
- `.feature` (file-level) — `category` (enum)
- `.issue` — `priority` (enum), `status` (enum), `deadline` (datetime), `category` (enum), a built-in `parent` (`i-N`) link, and `decision` / `concept` list links
- `.concept` — `status` (enum), `domain` (enum)
- `.decision` — `status` (enum), `category` (enum), a `superseded-by` link, and a `concept` link

These built-in fields cannot be deleted, but the user can edit their enum values and add new keys with the standard datatypes (enum, datetime, duration). The built-in fields map to fixed database columns; anything the user adds is stored in a shared remaining-keys table.

File-level types apply to the whole file (project/feature index notes); document types apply to headings.

### Which types a note can use (file check)

Every heading is either **persistent** or **plain**. A persistent heading's title starts with a dot (`# . Concept`, `# .c Idea`, or the bare `# .`); it is the kind that carries an identity line, metadata, and an index row. A plain heading has no dot (`# Notes`) and is just a section title — never indexed, no id, no metadata.

The typed headings a note may carry depend on where the note lives — one shared rule for both `.d.txt` and `.d.md`:

- A normal KB note allows `concept` and `task`.
- A note anywhere inside a project (`.p`) or feature (`.f`) folder allows `issue`.
- A note inside a project's `_concepts` folder allows only `concept` — numbered `c-N` within the project, just like issues get `i-N`. A note inside `_decisions` allows only `decision`, numbered `d-N`.
- A project/feature index note (`_Name.p.d.txt` / `_Name.f.d.txt`) allows only its own file-level type (`project` / `feature`).

The `h0` heading follows the same rule. It is persistent by default (`# . <filename>`), and the user can retype it as any type the note's location allows — `concept` in a normal KB note, the structural `.p` / `.f` marker on a project/feature index note, and so on.

Reconcile keeps the `h0` heading aligned with the file name (the `filename:` header — the note's human title — not the slugified disk file name, which may differ, e.g. "kv cache" lives in `kv-cache.d.txt`):

- When the `h0` name matches the file name, its type is kept if it is allowed for the note; otherwise it falls back to the note's structural convention — bare `.` for a normal note, `.p` for a project index note, `.f` for a feature index note or a standalone feature file (`Name.f.d.txt`). Only the type marker changes — the name, body, tags, and relations are untouched.
- When the `h0` name does **not** match the file name, that heading is demoted to a regular heading (its marker bumps one level, e.g. `#` → `#1`, and its id is renumbered to the next free id), and a fresh h0 heading is placed at the top with `@h0` — again using the note's structural convention (`.p`/`.f` for project/feature notes, bare `.` otherwise). The demoted heading's content moves down one tab with it.
- When the `h0` heading is deleted outright (the `# .p <name>` / `# . <name>` line removed), reconcile restores it with the same structural convention, so a project index note gets its `.p` back and a feature (index note or standalone feature file) gets its `.f` back rather than a bare `# .` heading.

Custom user-defined types are **not supported** — the type set is fixed to the built-in types above. Users can only add or edit keys (attributes) on those existing types, never create a new type. The check narrows the editor's type picker, the heading form, and diagnostics to the allowed set.

## How it fits together

The format is parsed by the editor language services (coloring, completion, diagnostics) and by the indexer (which turns it into indexed headings, tags, relations, and metadata). The format stays human-readable and diff-friendly — the structured parts are just indented lines, not hidden markup.
