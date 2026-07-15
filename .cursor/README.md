# DRIP `.cursor` layout

How Cursor is configured for this extension. **`cursor/new/features.txt`** is the canonical product spec.

## Rules (auto-loaded `.mdc`)

| File | Mode | Purpose |
|------|------|---------|
| `rules/core/workflow.mdc` | Always | How to respond (feature / debug / plan) |
| `rules/core/developer-ergonomics.mdc` | Always | Navigable codebase; fast to find edit points |
| `rules/context/drip-overview.mdc` | Always | What DRIP is + pointers to docs |
| `rules/context/drip-spec.mdc` | Agent | When implementing against the spec |
| `rules/context/drip-architecture.mdc` | Agent | Structural, DB, identity changes |
| `rules/code/module-map.mdc` | Agent | Where code lives in `lib/` |
| `rules/prompts/feature.mdc` | Agent | New feature / vertical slice |
| `rules/prompts/debugging.mdc` | Agent | Bugs and regressions |
| `rules/prompts/planning.mdc` | Agent | Design before coding |
| `rules/prompts/understanding.mdc` | Agent | Explain modules/flows (read-only) |
| `rules/prompts/cleanup.mdc` | Agent | Audit structure, dead code, reorg plan |

## Context (manual `@` or referenced from rules)

| File | Purpose |
|------|---------|
| `context/project-overview.md` | App summary, spec vs current code |
| `context/features-index.md` | Section index into `features.txt` |
| `context/architecture-decisions.md` | ADRs and constraints |
| `context/system-flows.md` | Userflow, index, ingest, UI flows |
| `context/app-startup.md` | **Extension activate() and startup reconcile** |
| `context/module-map.md` | File → module ownership |
| `context/developer-ergonomics.md` | Navigation, naming, onboarding, structure goals |

## Prompts (paste or `@` in chat)

| File | Purpose |
|------|---------|
| `prompts/feature-implementation.md` | Full feature request template |
| `prompts/debugging.md` | Full bug report template |
| `prompts/architecture-planning.md` | Full planning template |
| `prompts/code-understanding.md` | Explain how code/features work |
| `prompts/codebase-cleanup.md` | Audit and restructure plan |

## Quick start

- **New feature:** `@.cursor/prompts/feature-implementation.md` + `@cursor/new/features.txt`
- **Bug:** `@.cursor/prompts/debugging.md`
- **Plan:** `@.cursor/prompts/architecture-planning.md`
- **Understand code:** `@.cursor/prompts/code-understanding.md`
- **Cleanup / structure:** `@.cursor/prompts/codebase-cleanup.md`
- **Understand startup:** `@.cursor/context/app-startup.md`
- **Find code:** `@.cursor/context/module-map.md`

User verifies manually in Extension Host — no automated tests unless explicitly requested.
