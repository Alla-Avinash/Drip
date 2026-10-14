# DRIP

A VS Code extension that combines a **plain-text personal knowledge base** with a **Linear-style project tracker** — built to help you (and the AI assistants you code with) keep track of what has actually been built and why.

Notes are plain `.d.txt` files in a folder on disk. DRIP indexes them into a local database so they can be searched, sorted, and browsed. On top of that, it groups work into **projects → features → issues** so you always know what exists, what changed, and what's next.

## Why DRIP

When you build a lot — especially vibe-coding with an AI — it's easy to lose track of:

- what functionality already exists,
- why it was built a certain way,
- which approaches were considered and rejected,
- what's done and what still needs work.

DRIP stores all of that in plain English, not code. The AI assistant checks whether an existing issue already covers a change instead of creating a new one for every edit, so only meaningful work gets recorded.

## What it does

- **Knowledge base** — a `.driplock` folder tree of notes, with filtering, drag-drop, and CRUD.
- **Structured notes** — `.d.txt` files with metadata, tags, relations, and stable IDs that survive renames.
- **Projects, features, issues** — a Linear-style hierarchy, browsed in the Project View panel.
- **Indexing** — a local SQLite index for fast search, sorting, and backlinks.
- **Semantic search** — embeddings-based matching of headings, files, folders, and tags.
- **AI integration** — an LLM chat with long-term memory, plus a local MCP server so any AI app can manage issues.
- **Backup** — one-click push/pull of the whole KB to GitHub.

## Getting started

1. Open the DRIP activity bar in VS Code.
2. Pick a knowledge base folder with **Select Knowledge Base**.
3. Create notes and folders from the **New** menu; organize work into projects and features.
4. Open the **Project View** to browse and manage issues.

### Common shortcuts

| Action | Shortcut |
|--------|----------|
| Open Composer | `Ctrl+U` |
| Capture selection / clipboard | `Ctrl+Shift+U` |
| Open Retriever | `Ctrl+Shift+Alt+R` |
| Quick jump to a heading | `Ctrl+Shift+Alt+H` |

## Running and developing

```powershell
# Run in the Extension Development Host (from the VS Code repo root)
$env:VSCODE_SKIP_PRELAUNCH = "1"
.\scripts\code.bat

# Type check
npm run compile-web
```

Debug logs: in the Extension Development Host, **Help → Toggle Developer Tools**, then filter for `[DRIP]`.

## Documentation

Detailed, plain-English documentation lives in [`specs/`](specs/README.md) — what the app is, the tech stack, the startup flow, and one file per feature. Read the relevant file before changing behavior, and update it in the same change.
