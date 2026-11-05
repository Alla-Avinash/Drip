# What DRIP is (and who it is for)

## One sentence

DRIP is a **VS Code / Cursor extension** that combines a **plain-text personal knowledge base** with a **Linear-style project tracker** — notes stay as ordinary files on *your* disk, indexed locally so you can search, browse, and track work.

## The problem it solves

A developer (especially one who builds with AI assistants) makes many changes and quickly loses track of:

- what functionality already exists  
- why it was built a certain way  
- what approaches were considered and rejected  
- which parts are done and which still need work  

LLM chats record prompts and edits, but they are hard to search, heavy with code terms, and not written for “what does the app do and why?” in plain English.

## The core goal

Give that person **one structured place** to store — in plain English:

- what each feature does  
- what problem each issue solves  
- how things work as a **logical flow** (not a code dump)  

DRIP is both **documentation of the product** and the **tracker of what to build next**. Optional AI layers exist; the core workflow does **not** require an LLM, a cloud account, or an API key.

## Who it is for

- **Primary:** developers and builders who use AI a lot and need a durable memory outside chat threads  
- **Also fits:** anyone who wants a local, plain-text KB with projects → features → issues  
- **Not the focus:** a hosted SaaS wiki, a real-time Google-Docs co-editing suite, or a replacement for git itself  

## What you get (big pieces)

| Area | Plain meaning |
|------|----------------|
| Knowledge Base | A folder tree of notes (`.driplock`) with create / rename / delete |
| Notes | `.d.txt` (native plain text) and/or `.d.md` (Markdown + rich editor) |
| Projects | `.p` folders: **project → feature → issue** hierarchy |
| Project View | Board/list UI to browse and manage issues |
| Index | Local SQLite search, sorting, backlinks |
| Semantic search | Optional local embeddings (Retriever) |
| Sharing | Opt-in **peer-to-peer** share of **one project folder** (not the whole KB) |
| MCP / LLM | Optional hooks so external AI apps or a small LLM can help |

## What DRIP is *not*

- Not a mandatory AI product — AI is optional  
- Not a central DRIP server that stores your notes  
- Not “git merge the shared project” as the live collaboration model (collaboration is signed operations between peers)  
- Not only a todo list — issues live next to real notes and rationale  

## Why it is useful

1. **Capture without ceremony** — selection/clipboard into Composer, then file the note.  
2. **Structure without a proprietary vault** — files you can open in any editor.  
3. **Find things again** — local index + tags + Retriever.  
4. **Plan work like Linear** — projects, features, issues, sub-issues.  
5. **Collaborate only when needed** — share one project peer-to-peer; keep the rest private.  
6. **Let AI apps act on issues** — optional local MCP server for Cursor / Claude / etc.  

## Mental model (keep this)

```
Your machine
└── Knowledge Base folder (.driplock)
    ├── Normal notes (private to you)
    └── Projects (.p)
        ├── Features (.f), issues, concepts, decisions…
        └── Optional: shared with peers via .drip/ sidecar + sync
```

Indexes and embeddings live under the KB’s local `.dripindex/` (machine-local). A shared project’s membership and change log live in that project’s `.drip/` sidecar and travel with the project folder.
