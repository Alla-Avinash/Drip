# Concepts that help (learn as you go)

You do **not** need to study DRIP before using it. Open a knowledge base, write a note, create a project — the rest shows up when you need it.

These are the ideas that unlock the app when you bump into them. Skim only what is relevant.

## Knowledge Base folder

DRIP works on a folder on disk. Notes and projects are normal files you own.  
**Where:** left activity bar → **DRIP → Knowledge Base**.  
**Configure:** **DRIP Settings → Knowledge Base** (default note type, which extensions show).

## Two note formats

- **`.d.txt`** — native plain text; fast and keyboard-first.  
- **`.d.md`** — Markdown with a rich editor; DRIP details sit in hidden comments.  

Pick a default when convenient; you can still mix later.

## Basic `.d.txt` structure

A note is plain text. Typical shape:

```
file: …
id: …

# .concept Title of the idea
	status: open
	---
	Body text under the heading (same tab level as metadata).

	# .task A child heading
		---
		Nested with one more Tab.
```

- **File header** (optional lines at the top) — file-level identity / metadata.  
- **`#` headings** — structure the note.  
- **Metadata** — indented under a heading (`key: value`), often ended by `---`, then body.  
- **Tabs** — one more Tab = one level deeper (children under a parent).

## How `#` headings work

- **`# .…`** (hash, space, **dot**, then type/title) = **persistent** heading — indexed, searchable, browsable. Example: `# .concept My idea` or shortcuts like `# .c`.  
- **`# …`** without the dot = ordinary heading for reading/structure only — **not** the same indexed persistent heading.  
- Typing `# .` then space (or `# .c` etc.) can open the **RHS Heading Form**.  
- **Configure:** **DRIP Settings → Editor** (RHS vs edit in the file).

## Capture → file

**Composer** (or capture shortcuts) drafts a note; then you **file** it — merge, append, or new heading. The point is speed, not ceremony.

## Projects → features → issues

- **Projects** sidebar (above Knowledge Base) creates `.p` projects.  
- Inside: **features** (`.f`) and **issues** (typed headings like `i-N`).  
- **Open Project View** to browse them like a tracker (Features tree + Issues list/board).

## Search when the tree is not enough

- **Retriever** — meaning (embeddings) and/or words.  
- **Tags Graph** — how tags connect.  

Useful once you have enough notes that scrolling the tree is annoying.

## Optional later (only if you need them)

- **Account + Project Sharing** — peer-to-peer collaboration on one project.  
- **MCP** — let Cursor/Claude manage projects/issues.  
- **Lightweight LLM** — placement / chat helpers.  
- **GitHub backup** — snapshot the whole KB (not the same as live sharing).

## Things that confuse people once

1. **`#` vs `# .`** — only `# .` is the persistent/indexed style in `.d.txt`.  
2. **KB tree vs Projects sidebar** — projects live in their own section.  
3. **Sharing vs backup** — sharing is live peer sync of one project; backup is a KB snapshot.  
4. **Team filter** — on shared projects, “My Teams” can hide issues with no team.
