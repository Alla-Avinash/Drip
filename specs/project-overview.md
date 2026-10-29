# DRIP — project overview

## What DRIP is

DRIP is a VS Code extension that combines a **plain-text personal knowledge base** with a **Linear-style project tracker**, built to help a developer (especially one who leans on AI assistants) keep track of what has actually been built and why.

Notes are plain text files (`.d.txt`) stored in a folder on disk. DRIP indexes them into a local database so they can be searched, sorted, and browsed. On top of that, it adds a project/feature/issue structure so work is grouped into features, and each feature can hold issues and sub-issues.

## The problem it solves

A developer makes many changes to a codebase over time — often vibe-coding with an AI — and quickly loses track of:

- what functionality already exists,
- why it was built a certain way,
- what approaches were considered and rejected,
- which parts are done and which still need work.

LLM chats record prompts and edits, but they are hard to search, heavy with code terms, and not written for a non-coder who wants to understand *what* the app does and *why*.

## The core goal

DRIP gives that developer a single, structured place to store — in plain English — what each feature does, what problem each issue solves, and how things are implemented as a logical flow (not code). It is deeply integrated with the AI assistant: instead of creating a new issue for every small edit, the assistant checks whether an existing issue already covers the change, and only records meaningful feature work.

## Main capabilities

- **Knowledge base** — a `.driplock` folder tree of notes, with filtering and CRUD.
- **Structured notes** — `.d.txt` files with metadata, tags, relations, and stable IDs.
- **Projects, features, issues** — a hierarchy for planning and tracking work, browsed in a Linear-like Project View. A project can stay solo or be shared with other people; only that project folder is the shared world, and there is no central server.
- **Indexing** — a local SQLite index for fast search, sorting, and backlinks.
- **Semantic search** — embeddings-based matching of headings, files, folders, and tags.
- **AI integration** — an LLM chat with long-term memory, and a local MCP server so external AI apps can manage issues.
- **Backup** — one-click push/pull of the whole KB to GitHub.

## How it fits the user

The user treats DRIP as both the documentation of the app and the tracker of what to build next. When they rebuild the same DRIP extension, the goal is that the codebase is cleaner and the knowledge lives in DRIP itself rather than being lost in scattered prompts.
