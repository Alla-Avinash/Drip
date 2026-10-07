# DRIP — Architecture decisions

Extracted from **`cursor/new/features.txt`**. Full detail remains in the spec; this file records decisions, rationale, and **spec vs current code** gaps.

---

## ADR-1: Canonical spec location

**Decision:** `cursor/new/features.txt` is the single product and architecture source of truth.

**Implication:** Planning, features, and structural changes must reference the spec. Update the spec when behavior ships.

---

## ADR-2: `.driplock` knowledge base root

**Decision (spec):** KB is a `.driplock` folder; sidecar data lives in `.dripindex/`.

**Current code:** Plain folder selection — no `.driplock` rename yet.

**Why spec:** Clear KB boundary; supports nested `.driplock` isolation and explicit merge workflows.

**Alternatives considered:** Plain folder (current) — simpler but no nested-KB semantics.

---

## ADR-3: `index.drip` SQLite index

**Decision (spec):** Persistent index in SQLite — files, headings, references, typed metadata tables, tags, relations.

**Current code:** Text `_index.d.txt` per folder (`lib/dripnoteIndex.js`, `lib/dripnoteIndexSync.js`).

**Why spec:** Fast heading search, sorting, backlinks, incremental updates without full vault reparse.

**Alternatives considered:** Text index only (current prototype) — human-readable but weak for query/sort at scale.

---

## ADR-4: Heading as primary searchable entity

**Decision (spec):** Index headings with stable `@fileid:headingid`; embed hidden IDs in `.d.txt` below heading lines.

**Current code:** `fileId` at file header; partial heading-level identity; `L.` for cross-file refs.

**Why spec:** Duplicate heading titles in one file; deterministic updates on rename/move/restructure.

---

## ADR-5: Incremental parse and content hash

**Decision (spec):** On edit, reparse affected subtree; compare content hashes; batch dirty rows to SQLite (debounce ~10–15s).

**Current code:** Selective `_index` refresh on save when signals change.

**Why spec:** Performance on large KBs; avoid full-file reparse on every keystroke.

---

## ADR-6: Hierarchy vs references

**Decision (spec):**
- **Within file:** `parent_id` for heading tree
- **Cross file:** `ref:` field and references table — not cross-file heading parenthood

**Why:** Clear separation between document structure and graph-like links.

---

## ADR-7: Tags validated against graphs

**Decision (spec):** Tags in notes must exist in a graph under `graphs.drip/`; unknown tags → diagnostic (red underline), not silently added to DB.

**Current code:** Tag graph store + diagnostics for unknown tags.

---

## ADR-8: Nested `.driplock` isolation

**Decision (spec):**
- Child `.driplock` inside parent is **not** indexed by parent
- Shown as opaque folder in parent tree
- Merge via: external move, remove extension + update, or context menu "merge with parent"

**Current code:** Not implemented — design reference in spec only.

---

## ADR-9: Extension module layout

**Decision (code):**
- `extension.js` — register commands, providers, webviews only
- `lib/*` — all behavior
- `DripState` — session KB path, drafts, settings-derived state
- Webviews — explicit message types, no shared hidden globals

**Why:** Supports incremental migration from prototype toward spec without monolithic entry file.

---

## ADR-10: No `*` activation

**Decision:** Specific `activationEvents` in `package.json` only.

**Why:** Keep extension host startup cheap.

---

## ADR-11: Developer ergonomics and navigability

**Decision:** The codebase must stay **easy to understand and fast to change** for frequent and new developers.

**Practices:**
- Domain-oriented folders and clear file names (see `@.cursor/context/developer-ergonomics.md`)
- `module-map.md` kept accurate when files move or are added
- No new business logic in `extension.js`; avoid god files without a split plan
- Agents and contributors state **where to edit next time** after changes

**Why:** Flat `lib/` and duplicated parsers already slow onboarding; structure is a product concern for team velocity.

**Alternatives rejected:** "We'll document later" — docs drift; search cost stays high.

---

## Anti-patterns

| Avoid | Reason |
|-------|--------|
| Full vault reparse on every save | Violates incremental parse ADR |
| Silent tag creation outside graph | Breaks graph-as-source-of-truth |
| Breaking ID/link format without migration | Breaks references and index |
| Duplicate state outside `DripState` | Refresh and sync bugs |
| Copying entire spec into rules | Goes stale — `@cursor/new/features.txt` instead |
| Logic in `extension.js` or random `lib/` file | Next dev cannot find edit point |
| Mega-files without domain folder | Long scroll; unclear ownership |
| Moves without updating `module-map.md` | Navigation docs wrong |

---

## Checklist before structural changes

1. Read matching section in `features.txt`
2. List modules from `module-map.md`
3. State spec vs current gap and migration path
4. Define non-goals for this phase
5. User verifies manually — no automated tests unless requested
