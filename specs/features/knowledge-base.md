# Feature: Knowledge base

## What it is

The knowledge base (KB) is a folder of notes on disk, marked as a `.driplock` folder. It is the root of everything DRIP stores — notes, projects, features, issues, and sidecar data.

## How to access it

- Lives in the left activity bar under **DRIP → Knowledge Base**.
- First pick your KB with **Select Knowledge Base** (in the Components view or the KB toolbar).
- Create items with the **New** menu and manage them from right-click menus.

## Sub-features

### Selecting a KB folder

- The user picks a folder via the "Select Knowledge Base" command (from the Components tree or KB toolbar).
- The folder must be a `.driplock` folder.
- The choice is remembered for the workspace; the KB tree and watcher are set up immediately.

### The KB tree explorer

- The sidebar shows the folder tree of the KB, honoring `.dripignore`.
- Folders and notes are shown with distinct icons (plain folder, project folder, feature folder, note file, image file, `.dripignore` file).
- Collapse-all and multi-select are supported.

### Creating and managing items

From the tree and the "New" menu the user can create:

- a plain folder,
- a project folder,
- a feature folder,
- a feature file,
- a markdown file,
- a note (`.d.txt`) file,
- a `.dripignore` file.

Context-menu actions include copy path, rename, delete, convert a folder to a feature folder, delete a project, delete a feature, and "add to `.dripignore`".

### `.dripignore`

- A `.dripignore` file inside the KB lists paths to exclude from the tree, search, and ingest.
- "Add to `.dripignore`" writes the selected path into it.

### Drag and drop

- Items can be dragged and dropped within the tree to move/restructure folders and notes.

### Automatic refresh

- A file watcher watches the whole KB tree.
- Create/change/delete events trigger a debounced refresh of the sidebar (and skip internal index artifacts so opening the database doesn't loop).

## Flow (plain steps)

1. User selects a `.driplock` folder → it becomes the KB root.
2. The tree shows folders and notes, filtering out ignored paths.
3. The user creates or drags items; each change refreshes the tree.
4. New/edited notes are picked up by the index on save.
