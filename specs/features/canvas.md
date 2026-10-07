# Feature: Canvas

## What it is

The Canvas is a panel that visualizes a note's structure as a graph — headings, their hierarchy, and any workflow/dependency links.

## How to access it

- **Open Canvas** command, or right-click a `.d.txt` heading/file and choose **Open in Canvas**.

## Sub-features

### Heading graph

- Renders a note's headings and their parent/child relationships.

### Workflow graph

- Renders a note's task workflow, with tasks as nodes and dependency arrows.

### Open-in-canvas

- From the editor, the user can open the current file (or a specific heading) in the Canvas.

### Filtering

- Canvas can filter by metadata type, and show/hide headings that have no type.

## Flow (plain steps)

1. User opens a `.d.txt` note and chooses "Open in Canvas".
2. The Canvas parses the note and draws the heading tree (and workflow, if present).
3. The user can filter by type to focus on certain headings.
