# Search, embeddings, LLM, MCP, backup

## Retriever (search)

- **Open:** command **Open Retriever**, or `Ctrl+Shift+Alt+R` (default).  
- Search by **meaning** (local embeddings) and/or **words**.  
- Filter by tags, relations, metadata; jump to a heading.  
- Project View has its own issue search (word / semantic / recommended) scoped to that project.

## Embeddings (background)

- Always on; model is fixed local **MiniLM** (see **Settings → Embedding model**).  
- Vectors live in local SQLite under the KB’s `.dripindex/` (`index.drip` for document notes; **project/issue heading vectors** in `projects.drip`).  
- Project files/folders under `.p`/`.f` are excluded from the *file/folder* embedding stores in `index.drip`.  
- Better titles and clear first lines improve semantic results more than tweaking nonexistent model settings.

## Lightweight LLM

- **Settings → Lightweight LLM**  
- Named provider profiles (URL, model, enable, API key in Secret Storage).  
- Used for chat/placement help inside DRIP — **separate from Copilot**.  
- Optional; core note/project workflow works without it.

## MCP (Model Context Protocol)

**Purpose:** let external AI apps (Cursor, Claude, Copilot, …) **read/manage DRIP projects and issues** through a **local** MCP server.

**Configure:**

1. **DRIP Settings → MCP connection**  
2. Enable MCP  
3. Set port if needed  
4. Copy **URL + bearer token**  
5. Paste those into your AI app’s MCP / connector settings  

**Facts:**

- Listens on `127.0.0.1` only (loopback)  
- Token required  
- Client tools are meta: `search_tools` then `call_tool` (projects, issues, system ops underneath)  

**If connection fails:** MCP off, wrong/expired token, non-loopback host, firewall, or AI app misconfigured — regenerate token if rotated, re-copy URL.

## GitHub backup

- **Settings → GitHub backup** — remote, PAT (Secret Storage), push/pull the **whole knowledge base**.  
- Good for personal backup/versioning.  
- **Not** the live collaboration path for a shared project (that is peer operations + optional mailbox). Mixing git-merge of live shared files + `.drip/` op logs forks the project.

## Quick “which AI thing?”

| Goal | Use |
|------|-----|
| Find old notes by meaning | Retriever |
| Suggest where to file a capture | Lightweight LLM / Chat (optional) |
| Let Cursor create/update issues | MCP connection |
| Snapshot whole KB to GitHub | GitHub backup |
| Live edits with a teammate on one project | Project Sharing (P2P) |
