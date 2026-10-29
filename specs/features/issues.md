# Feature: Issues

## What it is

Issues are the individual units of work tracked in DRIP. They live under a project or a feature, can be assigned, and can have sub-issues.

## How to access it

- See and manage issues in the **Project View** panel.
- Each project's issues live in its `_issues.d.txt` file, editable in the editor; external AI apps can create/update issues via the MCP server.

## Structure

- Issues are stored in a project's `_issues.d.txt` inbox file, with an `_inbox` section holding newly created issues. Issues can also live inside a feature note or a feature's `_inbox` mailbox.
- Each issue has two identities: a hidden unique id that never changes, and a visible Linear-style key (`i-N`). The hidden id is what operations and parent links use internally. The file still *shows* `parent: i-12` so the text stays readable.
- Metadata is priority, status, deadline, **completed** (the time it became completed), category, **team** (who owns the work, once the project has teams), and — after archive — **feature** (which feature it came from). An issue does not store a feature field while it still lives in a feature file; that link is the file’s location. Archive writes `feature` because the issue has left that file. Team is a label, not a folder.
- A logical parent link (`parent`) lets one issue be a sub-issue of another. Creating a sub-issue does not move it into the parent's feature. An issue stays where it was created until it is assigned. The Project View can still show the parent/child tree across features.

### Issue block in each note format

The same issue is written differently depending on the note's format, but the `i-N` id and metadata are preserved in both:

- **`.d.txt`** — a marker-level heading `# .i-N Title` (or `#1 .i-N Title` when nested), with a `.issue` type marker indented one tab under it and its `key: value` attributes one tab deeper. Hierarchy is read from the marker number and mirrored by leading tabs; a nested sub-issue sits under its parent at one level deeper.
- **`.d.md`** — a markdown heading `# i-N Title` (or `## i-N Title` when nested), with the id kept in the title and the type/metadata in a one-line hidden comment directly under it: `<!-- drip hN | issue | status: to-do | priority: medium -->`. Hierarchy comes only from the markdown `#` level — there are no tab indents, so a sub-issue is a `##` under its parent's `#`.

When an issue block is moved between notes of different formats (e.g. assigned from `_issues.d.txt` into a `.d.md` feature note), its block is converted to the destination syntax — `.d.txt` marker + indented metadata ⇄ `.d.md` heading level + hidden comment — keeping the hidden unique id, the `i-N` key, title, fields, and nested sub-headings intact. The `parent: i-N` attribute also moves to the right place for the format: an indented `.issue` block's `parent:` line in `.d.txt`, or a `parent: i-N` field inside the hidden comment in `.d.md`.

## Sub-features

### Issue inbox / mailbox

The `_issues.d.txt` file acts as the project's issue mailbox; issues are laid out and read from it.

On a shared project, after a change is applied the touched file is **reprinted** so every member writes the same text: one kind of newline, a file identity if missing, missing heading ids filled in (existing ones kept), every heading ordered by hidden unique id (children stay under their parent), and one blank line between headings. Reprint never moves an issue into another file. See Project sync.

### Assign to feature

An issue can be assigned to a feature (or left at the project level as a project issue). Assigning a parent to a feature also assigns its children that are still in the project inbox. Children already in another feature stay there. On a shared project the assign is an operation other members receive while they are online — the issue moves into the same feature folder on their machine, not only on yours.

### Issue parent link

Issues can reference a parent issue, forming a sub-issue tree. Creating a sub-issue writes `parent: i-N` and leaves the new issue in the current inbox. When that parent is later assigned to a feature, inbox children go with it.

### Issue block editing

Editing an issue's block updates its metadata and content in place.

### Entity ID stamping

New issues are stamped with the next available `i-N` number and a hidden unique id.

A project is **solo** (one person) until it is shared with other people — see Project sharing. On a solo project, deleting the current highest number lets that number be reused. On a **shared** project, deleted numbers are never reused — reuse across peers is how two different issues both think they are `i-10`. Every write on a shared project is also an **operation** that other members receive (see Project sync).

If two people create an issue offline and both request `i-12`, the later one is **reminted** on sync (e.g. to `i-15`). Both sides compute the same result from the same operations. Visible `parent: i-N` lines that pointed at the reminted issue are rewritten by following the hidden id, so the link does not jump to the wrong issue. The person whose number changed sees a quiet notice once. See Project sync.

### Issue tree

The full parent/child tree of an issue can be retrieved.

### Archive completed issues

When status becomes **completed**, the issue is stamped with `completed` (date and time to the minute). If status leaves completed, that stamp is cleared. Once a week on **Sunday**, DRIP looks at every project: a completed issue whose stamp is **at least 3 days** old is **moved** into that project’s `_archive` folder. If DRIP was closed that Sunday, the job runs the next time DRIP is open. It does not run while the app is closed.

Archive notes are `done-1.d.txt` (or `.d.md` from the user’s default new-note format), about **100** issues per file, then the next file. In `.d.txt` those issues sit **flat** (no indent). `parent` stays so the tree can still be read. `feature` is written from the file it left. Children that are not completed stay where they are.

On a shared project this is the same kind of **move** other members receive — they archive the same issue into the same archive file. Creating a project also creates `_archive` (empty, ready).

## Flow (plain steps)

1. User creates an issue under a project or feature; it gets an `i-N` key (and a hidden unique id) and lands in the file they created it in (the project inbox, a feature mailbox, or that feature note). The other members write it to the same file.
2. The user can assign it to a feature or link a parent to make it a sub-issue. Assigning the parent to a feature takes along any children still in the project inbox.
3. The Project View and MCP tools read the issue from the index, showing the tree and metadata.
4. On a shared project the same write is also an operation, so other members receive it (see Project sync).
5. Marking it completed stamps the time. After 3 days it moves into `_archive` (flat, with parent and feature). Peers get that move.
