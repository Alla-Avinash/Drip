# Feature: Editor language services

## What it is

When a `.d.txt` file is open in the editor, DRIP provides VS Code language features that color, validate, and complete the structured parts of the note.

## How to access it

- Automatic — no button. Just open a `.d.txt` file and the coloring, squiggles, and completion appear as you type.

## Sub-features

### Semantic tokens (coloring)

- Metadata keys, values, tags, type markers, headings, and special prefixes are colored distinctly.
- Colors can be customized per metadata type or token in settings.

### Metadata diagnostics

- Unknown metadata keys, invalid values, wrong indentation, and broken heading hierarchy are underlined with a quick-fix.
- Strict validation checks values against the configured template rules.
- Indentation errors (marker/key nesting, heading-adjacent metadata layout) are flagged.

### Completion

- **Metadata completion** — suggests valid metadata keys/values while typing, and auto-inserts missing template keys when a type marker is entered.
- **Tag completion** — suggests existing tags from the tag graphs while typing tag lists.

### Custom decorations

- Heading identity and special markers get editor decorations (e.g. subtle visuals for stable IDs and prefixes).

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
