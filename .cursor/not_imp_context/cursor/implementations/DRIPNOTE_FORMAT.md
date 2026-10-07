# DRIP `.d.txt` Unified Format (v1 draft)

This file defines a single, predictable structure for DRIP note files (`.d.txt`).
It is based on your `sample.d.txt` conventions and keeps free-form writing possible.

## 1) File-Level Header (top of file)

Put these at the top, before content sections:

```text
filename: react basics
created: April 02 2026
fileId: @sok02394
```

Rules:
- `fileId` starts with `@` and should be unique.
- Keep one value per line for easy parsing.

## 2) File-Level Metadata Block

Use one root metadata type (`.concept`, `.task`, `.project`) and indented key/value fields.

```text
.concept
    importance: advanced
    tags: [ react, react-hooks, framework, frontend ]
    pre-req: [ javascript, webdev, DOM ]
```

Rules:
- `tags: [ ... ]` is the default searchable tag relation.
- Any other relation is `relation-name: [ ... ]` (example: `pre-req`).
- Comma-separated values inside `[...]`.
- If no explicit type is given, default type is `.concept`.

## 3) Section and Heading Content

Use markdown headings for conceptual structure:

```text
# About React
    [react components, hooks]
```

Rules:
- A bare list like `[tag1, tag2]` directly under a heading means heading-level default tags.
- Heading-level tags are local to that heading context.

## 4) Inline Typed Blocks Inside Sections

Typed blocks can appear inside sections:

```text
.task
    status: in-progress
    priority: high
    deadline: 6 days
    tags: [ commands, cli ]
```

Supported standard keys (current draft):
- `status`
- `priority`
- `deadline`
- `difficulty`
- `importance`
- `tags`
- custom relation arrays like `pre-req: [ ... ]`

## 5) Special Prefix Conventions

Use these for quick-scannable note semantics:

- `Q.` question prompt
- `R.` resources/references (URLs allowed)
- `L.` links to other knowledge-base files
- `U.` use-cases / real-world examples

Examples:

```text
Q. why did facebook release react?
R. https://example.com
L. @fileid1, @fileid2
U. build a todo app with state + props
```

## 6) Tag Syntax (Canonical)

Canonical list form:

```text
tags: [ a, b, c ]
```

Alternate shorthand allowed under headings:

```text
[a, b, c]
```

Parsing boundaries:
- Suggestions and tag parsing apply only inside `[...]`.
- Tag token separator is `,`.
- Parsing stops at matching `]`.

## 7) Recommended Ordering Template

```text
filename: <name>
created: <date>
fileId: @<id>

.concept
    tags: [ ... ]
    <relation>: [ ... ]

# Section title
    [ ...optional heading tags... ]
    <content>

Q. ...
R. ...
L. ...
U. ...
```

## 8) Validation Notes (for parser behavior)

To keep parsing robust:
- Prefer one metadata field per line.
- Avoid mixing comments (`// ...`) on the same line as parseable fields.
- Keep bracket lists closed on the same logical block.
- Keep `tags:` and other relation keys lowercase for consistency.

## 9) Pending Items (next phase)

Not implemented in this format doc yet:
- `_index` file schema and merge rules.
- UI color customization schema for `Q./R./L./U.` prefixes.
- Differentiated autosuggestion coloring for already-declared file-level tags.

