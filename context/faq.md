# FAQ — DRIP

## What is DRIP?

A VS Code / Cursor extension: plain-text knowledge base + project tracker (projects → features → issues). Files stay on your disk; search is local.

## Who is it for?

Builders and developers (especially AI-assisted) who need durable, searchable memory of *what was built and why*, outside chat threads. Also anyone who wants a local Linear-like tracker next to plain notes.

## Do I need AI / ChatGPT / an API key?

No. Core capture, notes, projects, and search work locally. LLM, MCP, and ChatGPT help are optional.

## Is my data in the cloud?

Notes are local files. Optional pieces: GitHub backup (you choose), GitHub login for identity/sharing, peer sync of a *shared project* with people you invite, optional internet relay for that sync. There is no “DRIP note cloud” that stores your KB by default.

## `.d.txt` vs `.d.md`?

- **`.d.txt`** — native plain text, `# .` persistent headings, tab hierarchy.  
- **`.d.md`** — Markdown + rich editor; DRIP metadata in hidden comments.  
Set the default under **Settings → Knowledge Base**.

## Why isn’t my heading showing up in search?

In `.d.txt`, use a **persistent** heading: `# .` (with the dot), not a plain `#`. Wait for indexing or reindex from the KB toolbar. Confirm you’re searching the right KB.

## Where do I create a project?

**Projects** sidebar (above Knowledge Base), not a generic “new file” elsewhere. Then open **Project View** to manage issues.

## What’s the difference between a note and an issue?

Notes/concepts/decisions explain and remember. Issues track unfinished work through status. Prefer issues for actionable work; prefer notes for lasting explanation.

## How do I share a project with a teammate?

1. **Account** — identity (optional GitHub).  
2. **Project Sharing** — Share the project, copy invite.  
3. Teammate **Join a Project** with the invite.  
4. You **Admit** them (role + teams).  
5. Keep **sharing on** while collaborating.  

Only that project folder is shared; the rest of the KB stays private. See `project-sharing-p2p.md`.

## Join created an empty / broken project?

Join needs a reachable member with sharing on (or export fallback). Membership starts only after **Admit**. An invite alone is not membership.

## Teammates don’t see my edits

Check: sharing started on both sides, online/sync status in Project View, your **role** can write, network/VPN, try **Reconnect**. Sync is operation-based, not live keystrokes.

## Issues missing under “My Teams”

Team filter may hide issues with no team. Switch Team dropdown to **None** or assign a team.

## How do I connect Cursor / Claude via MCP?

**Settings → MCP connection** → enable → copy URL + token → paste into the AI app. Loopback only. See `mcp-llm-search.md`.

## MCP won’t connect

Enable MCP, use the current URL/token, ensure localhost, check firewall, regenerate token if you rotated it, restart MCP from settings/commands if available.

## Semantic search feels weak

Write clearer titles and opening lines. Model is fixed local MiniLM. Project issue semantic search uses project-zone vectors in `projects.drip`.

## GitHub backup vs sharing?

| Backup | Sharing |
|--------|---------|
| Whole KB push/pull | One project peer sync |
| Snapshot / versioning | Live collaboration ops |
| Your remote | Invited peers |

Don’t git-merge live shared `.drip/` logs as if that were sync.

## Do I need to study before using DRIP?

No. Start writing; learn concepts when you hit them. See `learning-curve.md` for the few ideas that unlock the app (especially `# .` headings, projects vs KB tree, sharing vs backup).

## How should I get value quickly?

Capture often, file into a real project/feature when it’s buildable work, search before duplicating issues. Optional share/MCP only when you need them. See `best-practices.md`.

## Where is the Product Tour / Ask ChatGPT?

**DRIP Settings → About & Product Tour** (Ask ChatGPT is at the top of that panel).

## Can ChatGPT read this FAQ from GitHub?

Yes — point it at  
https://github.com/Alla-Avinash/Drip/tree/production/context  
and tell it to start with `README.md`, then this file and the siblings as needed.  
**Note:** files must be pushed to that branch on GitHub for the assistant to fetch them.
