# Where things live (UI & settings map)

Use this when the user asks “where do I…?”

## Open DRIP Settings

- Gear on the **Components** view, or command **Open DRIP Settings**.  
- Left sidebar lists sections; each scrolls independently.

## Settings sections (cheat sheet)

| Section | What it controls |
|---------|------------------|
| **About & Product Tour** | Product intro, sharing summary, Product Tour, **Ask ChatGPT** |
| **Knowledge Base** | KB folder, default new-note type, which extensions appear, auto-open Composer |
| **Editor** | Whether `# .` headings edit in RHS or in the file |
| **Update** | Extension update-related controls (as shown in UI) |
| **KB Metadata** | Document types / templates for notes (concept, task, issue, decision, …) |
| **Project Metadata** | Default or per-project overrides for project/feature/issue fields |
| **Account** | This PC’s identity; GitHub sign-in/out; export/import identity |
| **Join a Project** | Paste a project invite to *ask* to join |
| **Project Sharing** | Share project, invites, admit queue, teams/roles, start/stop sharing, mailbox |
| **Tags & Relations** | Tag/relation configuration |
| **Markdown** | Markdown-related options |
| **Doc Coloring** | Colors for `.d.txt` roles |
| **Embedding model** | Model info / benchmark (embeddings always on; model fixed) |
| **Lightweight LLM** | Provider profiles for DRIP’s small LLM helper |
| **GitHub backup** | Remote, PAT, push/pull whole KB |
| **MCP connection** | Enable local MCP, port, URL, token |
| **Saved Settings** | Import/export KB settings |
| **Keyboard Shortcuts** | DRIP keybindings |

## Sidebars & commands (day-to-day)

| Want to… | Go here |
|----------|---------|
| Browse notes | Left → **Knowledge Base** |
| Create a project | Left → **Projects** (above Knowledge Base) |
| Browse projects/issues UI | Command **Open Project View** |
| Draft / capture a note | **Composer** (`Ctrl+U` / capture variants) |
| Capture selection | `Ctrl+Shift+U` / `Cmd+Shift+U` (as bound) |
| Quick AI/capture inbox | Right → **Chat** |
| Browse headings / place notes | Right → **Storage** |
| Edit heading metadata | Right → **Heading** form |
| Search by meaning/words | Command **Open Retriever** (also `Ctrl+Shift+Alt+R`) |
| See tag graph | Command **Open Tags Graph** |
| Share settings for current project | Project View **gear** → Share settings |

## Project View (inside a project)

- Toggle **Features / Issues**.  
- **Features view:** grouped sections, search, Filter, Display (fields + “show repeated parent”), issue tree.  
- **Issues view:** Filter / Display / Sort, List or Board.  
- Shared projects: **Team** dropdown (My Teams / one team / None).  
- **Overview**, **Tags**, **New issue**, sync/online when shared.

## Mental “don’t look here for X”

- Don’t look in the general KB **New** flow for “new shared project invite” — use **Join a Project** / **Join new Project**.  
- Don’t look in GitHub backup for live teammate sync — use **Project Sharing**.  
- Don’t look in Lightweight LLM for MCP URL — use **MCP connection**.
