# Feature: Issues

## What it is

Issues are the individual units of work tracked in DRIP. They live under a project or a feature, can be assigned, and can have sub-issues.

## How to access it

- See and manage issues in the **Project View** panel.
- Each project's issues live in its `_issues.d.txt` file, editable in the editor; external AI apps can create/update issues via the MCP server.

## Structure

- Issues are stored in a project's `_issues.d.txt` inbox file, with an `_inbox` section holding newly created issues.
- Each issue has a stable entity ID (`i-N`), a type prefix (`.i-N`), and metadata (priority, status, deadline, category).
- A logical parent link (`parent`) lets one issue be a sub-issue of another.

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
