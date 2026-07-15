# Feature implementation — prompt template

Copy into chat or `@` this file when starting a new feature.

---

## Your request (fill in)

**Goal:**  
[What users can do after this ships]

**Spec section:**  
[Which part of `cursor/new/features.txt` — see `.cursor/context/features-index.md`]

**Non-goals:**  
[What to skip in this slice]

**Done when:**  
[What you will manually verify in Extension Host]

---

## Instructions for the agent

Follow:
- `@.cursor/rules/core/workflow.mdc`
- `@.cursor/rules/core/developer-ergonomics.mdc`
- `@.cursor/rules/prompts/feature.mdc`
- `@.cursor/rules/context/drip-spec.mdc` (when behavior comes from spec)

### Phase 1 — Understand (no code if scope is unclear)

1. Read the relevant section in `@cursor/new/features.txt`.
2. Check `@.cursor/context/features-index.md` if unsure where to look.
3. Break work into **numbered tasks** (1–7 slices).
4. For each task: files from `@.cursor/context/module-map.md`, intended change, risks.
5. Note **spec vs current code** gaps (see `@.cursor/context/project-overview.md`).

### Phase 2 — Implement

- **Smallest viable diff** — no refactors unless asked.
- Put code in the **obvious module** per `@.cursor/context/module-map.md` / `@.cursor/context/developer-ergonomics.md` — not scattered across unrelated files.
- Reuse existing `lib/*` patterns.
- New command → `package.json` contributes + `extension.js` register + handler module.
- KB/index changes → `@.cursor/context/system-flows.md` sections 3, 6, 7.
- Structural choice → `@.cursor/context/architecture-decisions.md`.
- Move implementation **toward the spec**; do not silently diverge.

### Phase 3 — Report (after each slice)

```
Changed: [files + one-line summary]
How: [1–3 sentences on behavior]
User tests: [what to click/do in Extension Host]
Where to edit next time: [path/file → function for this feature]
```

Do **not** write automated test files unless explicitly requested.

---

## Reference documents

| Need | `@` |
|------|-----|
| Main spec | `cursor/new/features.txt` |
| Spec index | `.cursor/context/features-index.md` |
| Project overview | `.cursor/context/project-overview.md` |
| Code map | `.cursor/context/module-map.md` |
| Flows | `.cursor/context/system-flows.md` |
| ADRs | `.cursor/context/architecture-decisions.md` |
| Note format (current) | `cursor/implementations/DRIPNOTE_FORMAT.md` |
| Developer ergonomics | `.cursor/context/developer-ergonomics.md` |

---

## Example opener

> Implement [feature X] per features.txt Userflow section (~L34). Non-goals: [Y]. Break into tasks, implement slice 1, tell me what to test manually.
