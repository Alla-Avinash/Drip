# Feature: Project architecture

## What it is

Each project has an **architecture graph** — a visual map of the project's features, components, sub-components, and implementation workflows. It works like the tags graph (canvas with pan, zoom, drag, and link editing) but is scoped to a single project and models how the project is *built* rather than which tags exist.

## How to access it

- Open the **Project View**, click a project to show its detail header, then click the **Architecture** button (next to the Overview button). This opens the Project Architecture panel for that project.

## Where the data lives

- Everything is stored inside the project's own folder, in a `_architecture/` folder — never in the shared KB index (`index.drip`) or the project index (`projects.drip`).
- `_architecture/architecture.drip` is a SQLite database holding the entities (their stable IDs, names, type, nesting, feature membership, and on-canvas positions) and the directed links between them.
- Human-readable descriptions are plain `.d.md` notes: components live in `_architecture/components/*.d.md` and implementation workflows in `_architecture/implementations/*.d.md`. Each is a normal note with the standard DRIP header and an `# Name` title.

## Entity types

- **Feature** — mirrored from the project's real `.f` features, shown as read-only diamond nodes (they can't be created, renamed, or deleted here). A feature groups related components.
- **Component** — a reusable part of the project with a defined responsibility.
- **Sub-component** — a smaller part nested under a component. Components form a **multi-level hierarchy**: a sub-component can itself contain deeper sub-components, and the whole hierarchy shares one colour.
- **Implementation** — a named workflow describing how components cooperate to perform an action. An implementation is linked to a feature **or** a component.

## Graph behaviour

- Features are drawn as **diamond nodes**; components/sub-components as circles (one colour); implementations as hexagons.
- **Arrowed lines** show structure: a component points to its feature, a sub-component points to its parent component, and an implementation points to its feature or component.
- **Solid arrowed lines** show free links the user creates between any two nodes (e.g. one component depends on another).
- The canvas supports drag-to-move nodes, panning, wheel zoom, and a "Reset view" button. Dragged positions are saved back to the database.
- **Clicking empty canvas (or outside the canvas) clears the current selection.**

## Editing

- **New component / sub-component / implementation** toolbar buttons open a small sidebar form to name the entity, choose its feature, and (for a sub-component or implementation) its parent component. Creating it also creates its `.d.md` description file.
- **Right-click empty canvas** → "New component" / "New implementation" opens an inline name box right where the user clicked; typing a name and pressing Enter creates the node (no feature/parent preselected, since no node was chosen).
- **Selecting a node** (single click) opens a sidebar where the user can rename it, change its feature, change its parent component (sub-components and implementations), open its `.d.md` description, or delete it (deleting a component also removes its nested nodes, links, and description files). For an implementation the sidebar shows **Create workflow** when it has no workflow yet, and **Play workflow** + **Edit workflow** once one exists.
- **Linking** — single-click a node to arm it as the link source, then double-click a different node to draw a directed link from the source to the double-clicked one. **Right-click an arrow** offers "Delete this link" and "Add reverse link" (which draws the same link in the opposite direction).
- **Double-clicking** an unselected node opens it (its `.d.md`, or plays the workflow for an implementation).
- **Right-click a node** for Rename / Delete (implementations also get "Create workflow" when they have no workflow yet, or "Play workflow" + "Edit workflow" once one exists). The right-click menu dismisses when the user clicks anywhere on the canvas or outside it.

## Flow (plain steps)

1. The user opens a project and clicks **Architecture**.
2. DRIP opens (or creates) that project's `_architecture/architecture.drip`, mirrors the project's `.f` features as read-only diamond nodes, and loads all stored entities and links.
3. The webview draws the graph; the user pans, zooms, drags nodes, and edits entities/links.
4. Every change writes to the project's own architecture database and, for entity creation/rename/delete, keeps the matching `.d.md` description files in sync.
5. Double-clicking a component opens its `.d.md` description in the editor; double-clicking an implementation plays its workflow on the graph.

## Workflow playback

Each implementation node holds a **workflow definition** — an ordered list of steps, stored in the same architecture database (`workflows`, `workflow_steps`, `workflow_step_nodes`, `workflow_flows`). A step is a "frame" of the animation: the nodes that are active in it, plus the labelled flows (arrows) drawn between them. A flow can be **sync**, **parallel**, or **async**, and can carry a **nested implementation** that runs in its middle.

- **Playback runs on the architecture graph itself** (double-click an implementation, or right-click → "Play workflow"): the other components dim to a faint outline, the current step's nodes light up, and its flows draw as labelled arrows showing direction — several arrows out of one node read as parallel actions.
- Playback controls (Restart, Step Back, Play/Pause, Step Forward, and speed) move the highlight step by step; the bar shows "Step N of M". Clicking a node during playback opens its `.d.md`; **Exit** returns to normal editing.

## Workflow builder ("Create workflow" / "Make workflow")

- Click **Make workflow** (toolbar) and then click the implementation node, or right-click an implementation → **Create workflow**. Either opens the builder on the same graph.
- For each step the user **clicks nodes** to include them, then turns on **Draw arrow** and clicks a source then a target to add a labelled arrow between them. In the side panel each arrow gets a **label** (the sentence shown on it), a **sync / parallel / async** type, and an optional **nested implementation** that runs in its middle.
- **Add step / Remove step / Prev / Next** build the ordered sequence. **Save workflow** persists it; **Cancel** (or Esc) leaves without saving.

## Not yet implemented

Parallel-branch join semantics (a step forking into several concurrent steps then re-joining), retries/failure paths, Mermaid-based rendering, and AI-assisted maintenance are planned follow-ups on top of the step/subgraph model.
