# Architecture planning — prompt template

Copy into chat or `@` this file when evaluating design **before** coding.

---

## Your request (fill in)

**Change:**  
[Feature, refactor, new module, data format change]

**Spec section:**  
[In `cursor/new/features.txt` — use `.cursor/context/features-index.md`]

**Constraints:**  
[Compat, performance, must-not-break, timeline]

**Questions:**  
[Specific decisions you want answered]

---

## Instructions for the agent

Follow:
- `@.cursor/rules/core/workflow.mdc` (Architecture / planning)
- `@.cursor/rules/core/developer-ergonomics.mdc`
- `@.cursor/rules/prompts/planning.mdc`
- `@.cursor/rules/context/drip-architecture.mdc`
- `@.cursor/context/developer-ergonomics.md` (folder/naming targets)

**No code** until you approve changes to module boundaries or data formats.

### Required output format

#### 1. Spec alignment

- Which `cursor/new/features.txt` sections apply?
- Does this conflict with or extend current code?

#### 2. Options

| Option | Summary | Tradeoff |
|--------|---------|----------|
| A | … | … |
| B | … | … |
| C (optional) | … | … |

#### 3. Recommendation

**Pick:** [A / B / C]

**Why best for DRIP:** Tie to spec, existing `lib/*` layout, activation cost, migration risk. Reference ADRs in `@.cursor/context/architecture-decisions.md` where relevant.

#### 4. Non-goals (this phase)

- …

#### 5. Files likely touched

From `@.cursor/context/module-map.md` — list modules, not full implementation plan.

#### 5b. Developer ergonomics

Which option makes **where to edit** most obvious for frequent and new devs? (folders, naming, file size)

#### 6. Spec vs current code gap

- What exists today?
- What migration is needed to reach spec?

#### 7. Manual verification plan

What you will test in Extension Host after implementation — no automated test files unless requested.

---

## Reference documents

| Topic | `@` |
|-------|-----|
| Main spec | `cursor/new/features.txt` |
| Spec index | `.cursor/context/features-index.md` |
| Project overview | `.cursor/context/project-overview.md` |
| Code map | `.cursor/context/module-map.md` |
| Flows | `.cursor/context/system-flows.md` |
| ADRs | `.cursor/context/architecture-decisions.md` |
| Developer ergonomics | `.cursor/context/developer-ergonomics.md` |

---

## Example opener

> Plan: [change X] aligned with features.txt DB schema section (~L306). Constraints: no breaking fileId. Options, recommend one, list modules — no code yet.
