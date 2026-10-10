# Feature: Projects and features

## What it is

Work is organized into **projects**, and each project is broken into **features**. This mirrors Linear's project structure and is the backbone for planning and tracking.

## How to access it

- Create projects/features from the KB tree **New** menu.
- Browse them in the **Project View** panel (via the **Open Project View** command).

## Structure

- A **project** is a folder with a project index note (`.project` file-level type). It carries status, priority, and deadline.
- A **feature** is a folder (or file) with a feature index note (`.feature` file-level type). It carries a `category` (enum).
- Both projects and features get stable entity IDs (`f-N` for features; the folder acts as the project container).

## The Project View panel

A Linear-style panel (`drip.openProjectView`) that:

- lists projects from the index,
- lists each project's children (features, and issues not assigned to a feature),
- is backed by the index query so it reflects the current state.

The **projects list** has a toolbar (search + Filter / Display / Sort menus) and two layouts:

- **Search** filters instantly by title or path, keeping focus while typing.
- **Filter** narrows by metadata fields (status, priority, deadline presets or a custom date). Active filters show as chips under the toolbar; clicking a chip opens that field's checkbox dropdown right on the chip.
- **Display** toggles which fields are shown and switches between **List** and **Board** view.
- **Sort** groups/orders the results. List view has **Group by + Order by**; Board view has **Column + Row + Order by**, with ascending/descending (and custom order for enums) direction toggles. A field used on one axis is hidden from the others, and enum groups always show every schema value even when empty. Datetime groups bucket into quarters (e.g. `2026 Q1`).
- Each project shows its issues as a clickable **issue bubble** with a fraction `completed / total`. Clicking it opens a dropdown breaking down the issues by status. In the board view this bubble sits on the card's last line.
- Filtering and sorting are done in the webview on the already-loaded project list (no extra query).
- The toolbar is remembered while navigating: opening a project hides it (the detail view takes over), and going back restores it with the same search/filter/sort.

Inside an open project, the panel has two view modes, switched with a **Features / Issues** toggle that sits right beside the **New issue** button.

In the detail header, **Overview** and **Tags** buttons sit to the left of the Features/Issues toggle. **Overview** opens the project's index note `_<Name>.p.d.txt`, creating it first if missing. **Tags** opens a popover listing the project's own tags (see "Per-project tags"): each tag can be renamed, given a description, or deleted with inline controls, and new tags can be added there.

Each feature row also has an **Overview** button on its right, which opens that feature's index note — `_<Name>.f.d.txt` for a `.f` folder (created if missing), or the feature file itself for a standalone `Name.f.d.txt`. Both folder features and standalone `.f.d.txt` feature files appear in the Features section with their issues, so file-format features are listed and grouped exactly like folder features.

- **Features view (default)** keeps the original grouped layout. A **search bar** filters the project's issues by title or issue key, keeping results grouped into the existing **Project issues (_issues)** and **Features** sections. Empty sections (and empty features) are hidden while searching, and a "no issues match" note shows when nothing matches. Issues always render as a **file tree** with connected guide lines (`├─` / `└─` / `│`): each issue joins to its parent with a branch or corner line, and vertical lines run through ancestor levels so the whole hierarchy reads as one continuous tree. The lines are drawn with CSS borders rather than spaced monospace characters, so they stay tight and connected; they are tinted from the theme foreground at partial opacity, so they read light on dark themes and dark on light themes. Top-level rows are flush with no leading connector — the connector appears only on nested rows. Issues whose parent lives in the same section (the same feature or inbox) sit under that parent. A **Show repeated parent issue** toggle next to the search bar additionally reveals, as dimmed rows, the missing ancestors of an issue whose `parent:` link points to an issue in a *different* feature or file (so the full cross-section chain is visible); when off, those issues simply appear as top-level rows.
- **Issues view** gives the project's issues the same search/filter/display/sort toolbar the projects list has: a search box plus **Filter**, **Display**, and **Sort** menus with **List** and **Board** layouts, Group by / Column / Row / Order by, and ascending/descending direction. **Feature** is an issue field (the feature each issue belongs to, or "Project issues" for inbox issues, or "Other"), so it can be used to group, column, row, filter, or sort. Issue rows/cards open the issue's heading on click; the Assign/Move/Sub actions stay in the Features view.

Each issue row carries two small actions:

- **Assign** (project inbox issues) and **Move** (feature issues) both open the **RHS Storage sidebar in "move issue" mode** for that issue.
- **Sub** opens an inline input directly under the issue to create a sub-issue there, instead of a top-level prompt.

**Move-issue mode (RHS Storage).** Reuses the Storage sidebar with a project-scoped overlay, so the normal Storage flow is left untouched. The header shows the project name and the full title of the issue being moved (not truncated). The **Cancel** and **Move** buttons sit together at the bottom, with **Move** disabled until a destination is chosen. When it opens:

- **Suggestions / AI / Browse** buttons drive a project-scoped browser that mirrors the Storage picker's format. **Browse** shows the project's features first (highlighted with an accent border), followed by the project inbox, then drills down: selecting a feature shows its folders/files, and selecting a file shows the note's full heading tree. **Suggestions / AI** rank by the stored embeddings (heading vectors for issues, folder vectors for features) with a word-match fallback; in ranked mode only the **top 4 features** show their embedding score, and everything else (remaining features, the inbox, project issues) shows no score. From a ranked list the user can still drill into a feature/file to choose the exact landing spot (mailbox or a specific heading).
- A feature folder's file list hides the two housekeeping notes — its mailbox `_inbox.d.txt` and its index note `_Name.f.d.txt` — because picking the feature directly already routes to the mailbox.
- The heading tree shown for a file includes both **persistent** (`# .…`) and **non-persistent** (`# …`) headings, exactly like the Storage heading tree, with a "Persistent only" toggle that hides non-persistent headings and promotes their children. Headings are **collapsible** (a chevron folds/unfolds their children) and are shown **as-is** with their `#` prefix — an issue heading reads `# .i-N …` with no special icon, so nothing is pre-selected when a file opens.
- A feature can be picked directly (its "Inbox" action) to put the issue in that feature's mailbox (`_inbox.d.txt`); the feature's own row reads **"feature name (inbox)"**. The project root also offers **"Move to project inbox"** (quick) and a **"Project issues"** drill-down that lists the project's inbox issues as a tree so the issue can be nested under a specific project issue.
- Opening a file shows its heading tree with the **file name as the top "file root" row** (`📄 name`), exactly like the Storage heading tree. **Double-clicking any heading** (persistent or not) makes it the **placement anchor**: the anchor is highlighted in a bordered box and a **draggable placeholder row** (labelled with the moving issue) appears inside its children list — the same selection + drag-reorder used to ingest a note into Storage. Dragging that placeholder row up/down reorders it live among the anchor's children; on drop the slot becomes the recorded position (first child, after a sibling, or last child under the anchor). Double-clicking the **file name (file root)** instead anchors the file's top level, where the placeholder can be dragged to the **top** (before the first heading) or **bottom** (after the last heading) of the file — no hierarchy. A sub-issue (one that has a parent) cannot be nested under another issue — its existing `parent:` link would fight the new indentation — so double-clicking an issue heading shows an error asking for **Remove parent / hierarchy** to be ticked first; placing it above/below as a sibling keeps its `parent:` link intact.
- The breadcrumb reads as **project name › feature name › path inside the feature**, using clean names (no repeated feature-folder prefixes or raw file paths).
- Two checkboxes — **Persistent only** and **Remove parent / hierarchy** — sit side by side in one horizontal row above the Move button. **Remove parent / hierarchy** unchecked (default) keeps the issue's `parent:` link wherever it lands (inbox, feature mailbox, or under a plain heading); checked detaches the issue from its hierarchy — its `parent:` line is dropped — so it can be placed under any heading or issue, and its hierarchy is then whatever the new location gives it.
- The issue being moved and all of its descendants are excluded, so it can never be placed under itself.
- Nothing changes until the user clicks **Move** (the confirmation); Cancel dismisses the mode. A move is always a move — the issue is removed from its old file and added to the new location, never appended.

Moves are performed on the host: the issue block is cut from its current file, its outline parent is recorded as `parent: i-N` when it leaves a nested position (so the indentation link survives a move to the inbox or a feature mailbox), and it is appended to the destination — a feature's `_inbox.d.txt`, the project's `_issues.d.txt`, the top or bottom of a note, or relative to a heading or issue in a note (above it, below it, or under it as a child). The destination is written **before** the source, so a move that can't complete (e.g. the "has a parent" refusal, or the target heading/issue isn't found) leaves the issue untouched in its source file rather than losing it. When a subtree moves, its heading and every child lose the heading's base indent (one tab level) so the internal hierarchy is preserved relative to its new parent. The issue's `parent:` line is preserved on the way to the inbox, a feature mailbox, a plain heading, or a sibling position; it is stripped only when the issue is re-parented under another issue (indentation becomes the source of truth there) or when **Remove parent** is checked.

## Sub-features

- **Project/feature folders** — creating and watching project and feature folders.
- **Project index** — indexing projects and their structure into `projects.drip` (a separate SQLite file from the document `index.drip`, so project headings stay out of global search).
- **Project view query** — the queries that power the Project View panel (read from `projects.drip`, with file paths resolved from the shared `files` registry in `index.drip`).
- **Convert folder to feature** — a folder can be promoted to a feature folder.
- **Per-project tags** — each project keeps its own tag graph (same node/link shape as the global tags graph, plus an optional per-tag description), separate from the global tags graph. They are managed from two places: the **Tags** popover in the Project View detail header (which lists the top-level tags with name + description) and the **Projects** mode of the Tags graph panel (full graph editing with links, groups, and sub-tags). They are stored as JSON under `<kb>/.dripindex/project-tags.drip/`.

## Flow (plain steps)

1. User creates a project folder, then feature folders inside it.
2. The project index records the project/feature structure with entity IDs in `projects.drip`.
3. User opens the Project View to browse projects → features → issues in a Linear-style layout.
