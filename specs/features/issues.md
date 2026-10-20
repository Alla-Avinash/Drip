# Feature: Issues

## What it is

Issues are the individual units of work tracked in DRIP. They live under a project or a feature, can be assigned, and can have sub-issues.

## How to access it

- See and manage issues in the **Project View** panel.
- Each project's issues live in its `_issues.d.txt` file, editable in the editor; external AI apps can create/update issues via the MCP server.

## Structure

- Issues are stored in a project's `_issues.d.txt` inbox file, with an `_inbox` section holding newly created issues. Issues can also live inside a feature note or a feature's `_inbox` mailbox.
- Each issue has a stable entity ID (`i-N`) and metadata (priority, status, deadline, category).
- A logical parent link (`parent`) lets one issue be a sub-issue of another.

### Issue block in each note format

The same issue is written differently depending on the note's format, but the `i-N` id and metadata are preserved in both:

- **`.d.txt`** — a marker-level heading `# .i-N Title` (or `#1 .i-N Title` when nested), with a `.issue` type marker indented one tab under it and its `key: value` attributes one tab deeper. Hierarchy is read from the marker number and mirrored by leading tabs; a nested sub-issue sits under its parent at one level deeper.
- **`.d.md`** — a markdown heading `# i-N Title` (or `## i-N Title` when nested), with the id kept in the title and the type/metadata in a one-line hidden comment directly under it: `<!-- drip hN | issue | status: to-do | priority: medium -->`. Hierarchy comes only from the markdown `#` level — there are no tab indents, so a sub-issue is a `##` under its parent's `#`.

When an issue block is moved between notes of different formats (e.g. assigned from `_issues.d.txt` into a `.d.md` feature note), its block is converted to the destination syntax — `.d.txt` marker + indented metadata ⇄ `.d.md` heading level + hidden comment — keeping the `i-N` id, title, fields, and nested sub-headings intact. The `parent: i-N` attribute also moves to the right place for the format: an indented `.issue` block's `parent:` line in `.d.txt`, or a `parent: i-N` field inside the hidden comment in `.d.md`.

## Sub-features

### Issue inbox / mailbox

The `_issues.d.txt` file acts as the project's issue mailbox; issues are laid out and read from it.

### Assign to feature

An issue can be assigned to a feature (or left at the project level as a project issue).

### Issue parent link

Issues can reference a parent issue, forming a sub-issue tree.

### Issue block editing

Editing an issue's block updates its metadata and content in place.

### Entity ID stamping

New issues are stamped with the next available `i-N` number.

### Issue tree

The full parent/child tree of an issue can be retrieved.

## Flow (plain steps)

1. User creates an issue under a project or feature; it gets an `i-N` ID and lands in the inbox's `_inbox` section.
2. The user can assign it to a feature or link a parent to make it a sub-issue.
3. The Project View and MCP tools read the issue from the index, showing the tree and metadata.
