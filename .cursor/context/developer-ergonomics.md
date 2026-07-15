# DRIP — Developer ergonomics

**Goal:** Anyone opening this repo — veteran or new — can **find where to change behavior quickly** without long searches through a flat, unclear `lib/`.

This is a **team priority**, not optional polish. Cursor agents and human contributors should follow it when implementing, refactoring, or documenting.

---

## Why this matters here

Current pain points (prototype state):

- **~49 files in flat `lib/`** with mixed naming (`dripnote*`, `kb*`, `tag*`, `views.js`)
- **God files** (`views.js`, `state.js`, `knowledgeBase.js`, `dripnoteIndex.js`) — hard to know which section to edit
- **Duplicated line parsers** across semantic tokens, diagnostics, decorations
- **Module map** (`module-map.md`) is the main navigation aid — must stay accurate

Target: structure aligned with `cursor/new/features.txt` UI/domains so **product area → folder → file** is predictable.

---

## Navigation workflow (for humans and agents)

```
1. What am I changing?  (UI: LHS / Editor / RHS — or domain: index, links, tags…)
2. Open @.cursor/context/module-map.md  OR  features-index → spec section
3. Grep ONLY the 1–3 files listed for that domain
4. Trace from extension.js command/register OR editor provider register
5. Make the smallest change in that module
6. Update module-map.md if you added/moved/renamed files
```

**Startup / boot:** `app-startup.md`  
**Editor / .d.txt coloring:** grep `dripnoteSemanticTokens`, `dripnoteCustomDecorations`, `dripnoteMetadataDiagnosticsTemplates`  
**Ingest / Storage:** `views.js` + `storageWebview.js` (today — split target: `lib/ui/storage/`)

---

## Naming conventions (target)

| Pattern | Use for | Example |
|---------|---------|---------|
| `lib/kb/` or `lib/knowledge-base/` | KB tree, state CRUD, `.dripignore` | `state.js`, `tree.js`, `knowledgeBase.js` |
| `lib/index/` | `_index`, sync, reconcile | `dripnoteIndex.js`, `dripnoteIndexSync.js` |
| `lib/references/` | `L.` links, migrations, go-to-def | `dripnoteReference*.js` |
| `lib/editor/` or `lib/dripnote/` | Language: tokens, diagnostics, completion | `dripnoteSemanticTokens.js`, … |
| `lib/ui/` | Panels, webviews, composer, storage | split from `views.js` |
| `lib/tags/` | Tag graph store + webview | `tagGraphStore.js`, `tagsWebview.js` |
| `lib/retrieval/` | Retriever, embeddings, quick-open | `retrieverPanel.js`, … |
| `lib/shared/` | Stateless utils only | `utils.js`, `constants.js` |

**File names:** `{domain}{Concern}.js` or keep `dripnote{Concern}.js` **only** inside `lib/editor/`.

**`extension.js`:** registration and thin delegates only — never new business logic.

---

## Code clarity rules

1. **Top-of-file comment** (1–3 lines) only when module role is non-obvious from the name.
2. **Export one primary responsibility** per file where possible.
3. **Webview messages:** `message.type` strings documented in a small table at top of handler file.
4. **No drive-by edits** in unrelated modules — keeps blame and mental model clean.
5. **Prefer explicit `require`** paths that match folder layout after restructure.

---

## Onboarding path for new developers

| Day 1 | Read |
|-------|------|
| What the product is | `cursor/new/features.txt` About + UI/UX (~L678+) |
| How it boots | `.cursor/context/app-startup.md` |
| Where code lives | `.cursor/context/module-map.md` |
| How to run | `app-startup.md` run section |

| First task type | Start here |
|-----------------|------------|
| Bug in KB tree | `lib/state.js`, `lib/tree.js`, `lib/knowledgeBase.js` |
| Bug in editor color | `lib/dripnoteSemanticTokens.js`, `dripnoteCustomDecorations.js` |
| Bug in ingest | `lib/views.js`, `storageWebview.js` |
| New command | `package.json` → `extension.js` → target `lib/*` module |

Use `@.cursor/prompts/code-understanding.md` in chat for guided traces.

---

## Cursor agent obligations

When implementing or fixing:

1. **State where to edit next time** — e.g. "For Retriever catalog refresh, edit `lib/retrieverPanel.js` → `rebuildAndPushInit`."
2. **Do not scatter** — if a change touches >3 unrelated files, explain why or propose a follow-up consolidation.
3. **Cleanup mode** — use `@.cursor/prompts/codebase-cleanup.md` when structure blocks productivity.
4. **Update docs** — if file ownership changes, patch `module-map.md` in the same PR/session.

---

## Measuring success

A change is ergonomically good when:

- A new dev can answer "which file?" in **< 2 minutes** using module map + grep
- Related code for one feature sits in **one folder or 2–3 adjacent files**
- No duplicate parsers for the same line types without a shared module
- `extension.js` does not grow with feature logic

---

## Related

| Doc | Role |
|-----|------|
| `module-map.md` | Current file ownership |
| `architecture-decisions.md` | ADR-11 developer ergonomics |
| `codebase-cleanup.md` prompt | Restructure planning |
| `cleanup.mdc` / `understanding.mdc` | Agent rules |
