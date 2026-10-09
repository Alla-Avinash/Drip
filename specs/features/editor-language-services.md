# Feature: Editor language services

## What it is

When a `.d.txt` file is open in the editor, DRIP provides VS Code language features that color, validate, and complete the structured parts of the note.

## How to access it

- Automatic — no button. Just open a `.d.txt` file and the coloring, squiggles, and completion appear as you type.

## Sub-features

### Semantic tokens (coloring)

- The whole note is colored in one pass by a single tokenizer that emits six roles, using theme-palette colors that follow the active light/dark theme.
  1. **Metadata type name / shortcut** — the leading `.concept`, `.c`, or plain `c` marker on a heading or type line.
  2. **Heading line** — the entire heading line (the `#` prefix, the type marker/shortcut, and the title text) rendered bold.
  3. **Metadata keys** — typed field keys like `status`, `deadline`, `parent`.
  4. **Tag / relation keys** — `tags`, `pre-req`, and other configured relation keys.
  5. **Values** — metadata values, tag-list items, file identity values, and the `---` section separator.
  6. **File-level identity** — the `filename`, `fileid`, and `headings` header fields.
- Each role defaults to a theme token. In the **Doc Coloring** settings panel the user can override any role with a custom hex color; empty overrides keep the theme color. Custom colors layer over the semantic tokens as editor decorations, so they only affect `.d.txt` notes.

### Metadata diagnostics

- Unknown metadata keys, invalid values, wrong indentation, and broken heading hierarchy are underlined with a quick-fix.
- Strict validation checks values against the configured template rules.
- Indentation errors (marker/key nesting, heading-adjacent metadata layout) are flagged.

### Completion

- **Metadata completion** — suggests valid metadata keys/values while typing, and auto-inserts missing template keys when a type marker is entered.
- **Tag completion** — suggests existing tags from the tag graphs while typing tag lists.

### Custom decorations (markdown marks)

- User-defined markdown marks (`L:`, `Q:`, `R:`, …) get their own editor decorations using the color the user assigned in settings; a mark with no assigned color stays plain text.

### Document symbols

- Headings appear in the outline / breadcrumb for quick navigation.

### Image paste and drop

- Pasting or dropping an image into a note saves it and inserts a reference.

### Persistent-heading soft-lock

- Persistent headings (the `# .…` sections that hold identity/metadata) can be edited either directly in the file or through the RHS Heading form. When edited via the form, the title/metadata area is soft-locked in the editor to prevent accidental edits.

## Flow (plain steps)

1. User opens/edits a `.d.txt` file.
2. The language services color the structured parts and show diagnostics as the user types.
3. Completion suggests valid keys/values/tags; templates auto-fill when a type is entered.
4. Errors are underlined with quick fixes; the user applies them inline.
