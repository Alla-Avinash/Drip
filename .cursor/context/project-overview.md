# DRIP — Project overview

Bridge between the **canonical product spec** and the **current codebase**.

---

## What DRIP is

A VS Code extension for a personal knowledge base stored as files on disk. Users:

1. Select a knowledge-base (KB) folder
2. Write structured notes (`.d.txt` / `.md`)
3. Use **ingestion** (Composer + Storage) to place notes in the KB
4. Use **retrieval** (Retriever, search) to find headings and content
5. Manage **tags** as graphs linked to note metadata

**Location:** `vscode/extensions/drip/`  
**Entry:** `extension.js` → `lib/*`

---

## Canonical spec

**`cursor/new/features.txt`** is the main application document. It defines:

- About, setup, and run instructions
- Full **userflow** (`.driplock`, `.dripindex/`, startup check, update icon, nested KB merge)
- **Heading / file identity** (`@f`, `@h`, hidden IDs in files)
- **SQLite index schema** (`index.drip`), incremental parse, hash-based dirty tracking
- **UI layout** — LHS (Components, KB, Drafts), Editor, RHS (Storage)
- Future work — update this file when shipping new behavior

Use `@.cursor/context/features-index.md` to jump to sections without reading all 800 lines.

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js, VS Code Extension API |
| Language | JavaScript (CommonJS) |
| UI | Tree views, webview panels (`media/*`, `lib/views.js`) |
| Optional ML | `@xenova/transformers` when `drip.experimentalEmbeddings` is on |

---

## Spec vs current implementation

The extension is a **prototype** moving toward the spec. Key mappings:

| Spec (`features.txt`) | Current code |
|------------------------|--------------|
| `.driplock` KB root | User-selected folder (`drip.selectKnowledgeBase`) |
| `.dripindex/index.drip` SQLite | Per-folder `_index.d.txt` text (`lib/dripnoteIndex.js`) |
| `@f` file ID, `@h` heading ID hidden in files | `fileId` in header (`lib/dripnoteFileIdentity.js`) |
| `ref: [@f26, @f45:h18]` | `L.` link lines (`lib/dripnoteReference*.js`) |
| `graphs.drip/` in `.dripindex` | Tag graph JSON (`lib/tagGraphStore.js`) |
| `settings.drip` per KB | VS Code `drip.*` settings + settings webview |
| `drafts.drip/` | Draft state (`lib/state.js`) |
| Nested `.driplock` isolation / merge | Not fully implemented — spec only |

When implementing, align toward the spec and call out remaining gaps.

---

## UI sections (target)

### LHS — primary sidebar

- **Components:** Composer, Retriever, Tags graph, Canvas; settings button → DRIP settings
- **Knowledge base:** Tree explorer, `.dripignore`, update/reindex, CRUD on notes/folders
- **Drafts:** Loaded from KB draft store

### Editor — center

- `.d.txt` dripnote language (metadata, headings, tags, special prefixes)
- Panel UIs: Composer, Retriever, Canvas, Tags graph (when opened as panels)

### RHS — secondary sidebar

- **Storage:** KB navigation, placement picker, ingest suggestions (optional embeddings)

---

## Developer ergonomics

The codebase should stay **easy to navigate and change** for frequent and new developers — clear modules, not long hunts through flat `lib/`. See `.cursor/context/developer-ergonomics.md` and ADR-11 in `architecture-decisions.md`. Keep `module-map.md` updated when files move.

## Verification

User manually tests in the Extension Development Host after changes. **Do not add automated test files** unless explicitly requested.

---

## Related documentation

| Document | Role |
|----------|------|
| `cursor/new/features.txt` | **Main spec** |
| `.cursor/context/features-index.md` | Section index |
| `.cursor/context/system-flows.md` | Flows (spec + code pointers) |
| `.cursor/context/app-startup.md` | Extension boot + `activate()` + index startup reconcile |
| `.cursor/context/architecture-decisions.md` | ADRs |
| `.cursor/context/module-map.md` | Code file ownership |
| `.cursor/context/developer-ergonomics.md` | Navigation, naming, team productivity |
| `cursor/implementations/DRIPNOTE_FORMAT.md` | Current `.d.txt` v1 draft format |

---

## Run locally

```powershell
# from vscode/ repo root
$env:VSCODE_SKIP_PRELAUNCH = "1"
.\scripts\code.bat
```

Extension Host logs: **Help → Toggle Developer Tools**
