# Feature: Workflows

## What it is

Tasks can be organized into a **workflow** — a logical sequence/dependency of steps — represented inside a note and visualized as a graph.

## How to access it

- In the editor: write task headings with `workflow: true` and `parent:` links in a `.d.txt` note.
- View the resulting graph in the **Canvas** panel.

## Sub-features

### Workflow parsing

- A task's `workflow: true` flag marks it as part of a workflow.
- Task identity uses numeric IDs (`tN`) in headings.
- A `parent: [ ... ]` line lists the tasks this task depends on (prerequisites).

### Workflow diagnostics

- Invalid workflow structure (e.g. missing parents, bad IDs) is flagged in the editor.

### Workflow graph (Canvas)

- The workflow can be rendered as a graph in the Canvas panel, showing tasks and their dependencies.

## Flow (plain steps)

1. User marks tasks with `workflow: true`, numeric task IDs, and `parent:` links.
2. The editor validates the workflow and flags errors.
3. The Canvas renders the tasks and their dependency arrows.
