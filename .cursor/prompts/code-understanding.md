# Code understanding — prompt template

Use when you want to **learn** how part of DRIP works. **No code changes** unless you ask separately.

Copy into chat or `@` this file.

---

## Your question (fill in)

**What I want to understand:**  
[e.g. "how `_index` sync works on save", "Composer → Storage ingest", "lib/views.js Tags panel"]

**Scope (optional):**  
[specific file, command, UI area — LHS / Editor / RHS]

**Depth:**  
[ ] high-level flow only  
[ ] entry points + call chain  
[ ] include data/state and spec mapping  

---

## Instructions for the agent

Activate `@.cursor/rules/prompts/understanding.mdc` and `@.cursor/rules/core/developer-ergonomics.mdc`.

1. Read `@.cursor/context/module-map.md` for files in scope.
2. Read `@.cursor/context/system-flows.md` for the matching flow.
3. Map to `@cursor/new/features.txt` via `@.cursor/context/features-index.md`.
4. Grep/read **only** relevant files — trace from `extension.js` or the command the user named.

### Deliver

- **What it is** — 1–2 sentences  
- **Spec link** — features.txt section or "prototype gap"  
- **Entry points** — commands, activation, events  
- **Call chain** — top → bottom with function names  
- **Data & state** — what persists, what `DripState` holds  
- **Related files** — neighbors only  
- **Spec vs code** — one note if different  
- **Where to edit** — if you change this later, start at `path/file.js` → `function`

Keep it concise but complete enough to orient you in the codebase.

---

## Example openers

> Explain how `drip.processPendingLinkMigrations` works end-to-end.

> Walk me through Retriever: from command to opening a heading. Entry points + call chain.

> What does `lib/dripnoteIndexSync.js` do on startup? Map to features.txt if possible.
