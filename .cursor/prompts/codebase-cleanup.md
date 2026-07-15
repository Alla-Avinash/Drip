# Codebase cleanup — prompt template

Use when auditing structure, dead code, or planning reorganization. **Behavior unchanged** until you explicitly approve each cleanup slice.

Copy into chat or `@` this file.

---

## Your request (fill in)

**Scope:**  
[ ] whole `lib/`  
[ ] subsystem: index / links / webviews / editor / tags / retriever / state  
[ ] specific files: `@…`

**Goal this session:**  
[ ] inventory + problems list only (no edits)  
[ ] propose target folder structure + naming  
[ ] execute one approved cleanup slice  

**Constraints:**  
- No feature behavior changes  
- No deletes without proof of unused  
- Manual verification after any edit  

---

## Instructions for the agent

Activate `@.cursor/rules/prompts/cleanup.mdc` and `@.cursor/context/developer-ergonomics.md`.

**Primary goal:** Reduce time wasted searching — clear domains, names, and module map.

### If inventory only (default)

1. List files in scope with one-line purpose.
2. Map each to `features.txt` UI/feature area.
3. Report **Problems** with evidence (unused imports, duplication, wrong layer).
4. Propose **Target structure** tree and **Migration slices** (ordered, behavior-neutral).
5. **Risks** and **Non-goals**.

**Do not edit code** in this pass unless you asked to execute a slice.

### If executing a slice (you must say so)

1. One slice only — moves/renames/deletes explicitly listed.
2. Prove dead code with grep before delete.
3. Report Changed | How | User tests (Extension Host).

---

## Reference

| Need | `@` |
|------|-----|
| Spec | `cursor/new/features.txt` |
| Code map | `.cursor/context/module-map.md` |
| Flows | `.cursor/context/system-flows.md` |
| ADRs | `.cursor/context/architecture-decisions.md` |
| Understand first | `.cursor/prompts/code-understanding.md` |

---

## Example openers

> Audit `lib/dripnoteReference*.js` — inventory only, propose if anything should merge or move. No edits.

> Propose a future folder structure for all of `lib/` aligned with features.txt UI sections. No code changes.

> Approved slice 1: move X to Y, update requires only, no logic changes. Tell me what to test manually.
