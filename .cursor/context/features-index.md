# DRIP — Features spec index

**Canonical document:** `cursor/new/features.txt` — `@` it for full detail.

Use this index to find the right section when planning, implementing, or debugging.

---

## Top-level outline

| Section | ~Lines | Topics |
|---------|--------|--------|
| About | 17–19 | Purpose, KB folder as knowledge tree |
| Setup & run | 23–29 | `code.bat`, persistent DRIP data |
| Userflow | 34–96 | Open app, startup_check, `.driplock`, `.dripindex/`, update icon, nested KB, merge |
| **Boot (current code)** | — | `.cursor/context/app-startup.md` — `activate()` + `ensureStartupIndexReconcile` |
| External changes | 99–104 | Copy/move folders, fault-tolerant reconcile |
| Why heading IDs | 111–128 | Search without full reparse, duplicate titles |
| ID storage | 130–193 | IDs in files + index, `@F` folder, `@f` file, `@h` heading |
| DB principles | 206–216 | Headings primary, SQLite, incremental parse |
| File example | 218–268 | `.d.txt` structure, metadata, tags, `ref:` |
| Heading identity | 270–284 | `@fileid:headingid` composite key |
| Hierarchy | 286–303 | `parent_id` in-file; cross-file via references |
| SQLite schema | 306–499 | files, headings, references, metadata tables, tags, relations |
| Enums & time | 501–536 | Metadata enums, unix timestamps, durations |
| Hash design | 538–549 | Content hash for change detection |
| File open flow | 552–614 | Parse → AST → hash compare → dirty |
| Incremental edit | 616–641 | Line-range subtree reparse |
| DB update / close | 644–669 | Debounced batch, flush on close |
| UI/UX | 678–738 | LHS, Editor, RHS feature areas |

---

## `.dripindex/` layout (target)

| Path | Purpose |
|------|---------|
| `index.drip` | SQLite DB — headings, metadata, tags, references |
| `graphs.drip/` | Tag/graph files (default graph location for this KB) |
| `settings.drip` | Per-KB DRIP settings snapshot |
| `drafts.drip/` | Draft files for this KB |

---

## UI feature areas (from spec)

### LHS

| View | Features |
|------|----------|
| Components | Composer, Retriever, Tags graph, Canvas; DRIP settings button |
| Knowledge base | Tree, `.dripignore`, update icon, create/rename/delete, nested `.driplock` rules |
| Drafts | List drafts from `.dripindex/drafts.drip/` |

### Editor

| Surface | Features |
|---------|----------|
| `.d.txt` | Metadata header, `---`, headings, indented hierarchy, tags, `Q./R./L./U.` prefixes |
| Panels | Composer UI, Retriever UI, Canvas, Graph view |

### RHS

| Surface | Features |
|---------|----------|
| Storage | File/heading navigation, placement selection, AI/embedding suggestions |

---

## Key commands (current prototype)

| Command | Purpose |
|---------|---------|
| `drip.selectKnowledgeBase` | Pick KB root folder |
| `drip.openComposer` | Open note composer |
| `drip.rebuildKbIndexNow` | Rebuild `_index` (→ future: sync `index.drip`) |
| `drip.processPendingLinkMigrations` | Process pending ID migrations in index |
| `drip.openTagsPanel` | Tags graph |
| `drip.openRetriever` | Retriever panel |

---

## When shipping a feature

1. Implement behavior described in the relevant `features.txt` section.
2. Update `features.txt` with what was implemented (per its own guidance at ~L12).
3. Note intentional deviations in chat/PR summary.

---

## Legacy reference

| File | Note |
|------|------|
| `cursor/features.txt` | Older implemented-features snapshot — prefer `cursor/new/features.txt` |
| `cursor/implementations/DRIPNOTE_FORMAT.md` | Current `.d.txt` v1 draft — converge toward spec over time |
