# DRIP codebase refactor — task list

**Goal:** Move the **existing working** extension into the folder layout from `@.cursor/context/application-folder-structure.txt`. Same behavior, same logic — only paths change.

**Scope:**
- **Move + update `require()` paths** — that is the default for every task.
- **Small cleanup OK:** delete confirmed dead files (e.g. unused `dripnoteMetadataDiagnostics.js`), remove orphan `src/extension.ts` if unused.
- **Not in scope:** new features, new facades, stub/placeholder modules, splitting god files for style, renaming classes to match reference filenames, SQLite/`database/`, TypeScript migration, state/session splits.

**Do not touch:** `.cursor/` and `cursor/` (no moves, no restructure).

**Rules per task:**
- One task per session when user asks.
- Manual smoke in Extension Development Host after each task.
- Update `@.cursor/context/module-map.md` after moves (only when user asks to implement a task).

**Entry point:** keep `package.json` → `"main": "./extension.js"` until final cleanup; root `extension.js` can be a thin shim during migration.

---

## Target layout (folders that hold **existing** code)

Reference names like `DocumentManager.ts` are **aspirational** — we keep **current filenames** inside the matching folders.

```
extensions/drip/
├── .cursor/                         ← untouched
├── cursor/                          ← untouched
├── resources/
│   ├── syntaxes/
│   ├── media/
│   └── language-configuration.json
├── src/
│   ├── extension/
│   │   ├── extension.js             ← exports activate
│   │   └── activate.js              ← body of today’s extension.js
│   ├── shared/
│   │   ├── constants.js
│   │   └── utils.js
│   ├── knowledgebase/
│   │   ├── knowledgeBase.js
│   │   └── noteFileTypes.js
│   ├── filesystem/                  ← only if a whole file is extracted later; skip for now
│   ├── document/
│   │   ├── parse/
│   │   │   ├── dripnoteCanvasParse.js
│   │   │   ├── dripnoteHeadingAboveIndent.js
│   │   │   └── dripnoteDatetime.js
│   │   ├── model/
│   │   │   └── dripnoteMetadataTemplates.js
│   │   └── validate/
│   │       └── dripnoteMetadataDiagnosticsTemplates.js
│   ├── indexing/
│   │   ├── dripnoteIndex.js
│   │   ├── dripnoteIndexSync.js
│   │   ├── dripnoteFileIdentity.js
│   │   ├── dripnoteEntityIds.js
│   │   ├── dripnoteFileIdDefinitions.js
│   │   ├── dripnoteFileIdMigration.js
│   │   └── dripnoteReferencePhase3.js
│   ├── graph/
│   │   ├── tagGraphStore.js
│   │   ├── tagGraphCommands.js
│   │   ├── tagsWebview.js
│   │   ├── tagsGraphEmbedRuntime.js
│   │   ├── tagsGraphSubOnlyEmbed.js
│   │   ├── dripnoteReferenceSync.js
│   │   ├── dripnoteReferenceAssist.js
│   │   ├── dripnoteReferenceDefinitions.js
│   │   ├── dripnoteLinkDropInsert.js
│   │   └── noteDocumentLinks.js
│   ├── retrieval/
│   │   ├── retrieverPanel.js
│   │   ├── retrieverQuickOpen.js
│   │   ├── dripnoteRetrieverQuery.js
│   │   └── embeddings.js
│   ├── state/
│   │   └── state.js                 ← whole DripState file, no split
│   └── views/
│       ├── views.js                 ← whole file (no split unless user asks later)
│       ├── storageWebview.js
│       ├── webviews.js
│       ├── settingsWebview.js
│       ├── dripnoteCanvasPanel.js
│       ├── capturePreprocess.js
│       ├── editor/                  ← dripnote editor UI providers
│       │   ├── dripnoteSemanticTokens.js
│       │   ├── dripnoteCustomDecorations.js
│       │   ├── dripnoteMetadataCompletion.js
│       │   ├── dripnoteTagCompletion.js
│       │   ├── dripnoteDocumentSymbols.js
│       │   └── noteImagePaste.js
│       └── lhs/
│           └── knowledgebase/
│               ├── tree.js
│               ├── kbCreateMenu.js
│               ├── kbTreeIcon.js
│               ├── kbTreeDragDrop.js
│               └── dripSidebarViews.js
├── package.json
├── extension.js                     ← thin shim until Task 10
└── (lib/ deleted after Task 10)
```

**Skipped until real code exists:** `src/database/`, empty `views/rhs/*` placeholders, `state/session|workspace|persistence` splits.

---

## Where to edit (after move)

| Feature | Folder |
|---------|--------|
| Boot / activate | `src/extension/` |
| Constants / utils | `src/shared/` |
| KB CRUD, `.dripignore` | `src/knowledgebase/` |
| KB / drafts trees (UI) | `src/views/lhs/knowledgebase/` |
| `.d.txt` parse / validate | `src/document/` |
| Editor colors, completion | `src/views/editor/` |
| `_index`, fileId, sync | `src/indexing/` |
| L. links, tag graph | `src/graph/` |
| Retriever | `src/retrieval/` |
| Composer, storage, panels | `src/views/` |
| Drafts, KB root URI | `src/state/` |
| Webview assets | `resources/media/` |

---

## Phase 0 — Baseline

### Task 0.1 — Smoke checklist (before any moves)
- [x] Pre-move static checks (2026-06-05): `extension.js` requires `dripnoteMetadataDiagnosticsTemplates` (not the deleted orphan); `package.json` main → `./extension.js`; 48 `lib/*.js` files remain.
- [ ] **Manual Extension Host smoke** — run before Phase 1; check boxes at bottom of this file.
- **Verify:** Extension host, `.driplock` KB, `.d.txt` editor, Composer, Storage, Tags graph, Retriever, save / index sync.

### Task 0.2 — Dead code (delete only if grep shows zero imports)
- [x] Deleted `lib/dripnoteMetadataDiagnostics.js` — zero `require()` in app code (superseded by `dripnoteMetadataDiagnosticsTemplates.js`).
- [x] Deleted `src/extension.ts` — not runtime entry (`main` is `./extension.js`); no references in codebase.
- **Verify:** Reload Extension Development Host; confirm diagnostics still work on `.d.txt`.

---

## Phase 1 — `resources/`

### Task 1.1 — Move static assets
- [x] `syntaxes/` → `resources/syntaxes/`
- [x] `media/` → `resources/media/`
- [x] `language-configuration.json` → `resources/language-configuration.json`
- [x] Updated `package.json` + `lib/kbTreeIcon.js`, `lib/retrieverPanel.js`, `lib/dripnoteCanvasPanel.js`
- **Verify:** Grammar + webviews load (manual Extension Host).

---

## Phase 2 — `src/shared/`

### Task 2.1
- [x] `lib/constants.js` → `src/shared/constants.js`
- [x] `lib/utils.js` → `src/shared/utils.js`
- [x] Updated all `require` paths in `extension.js` + 10 `lib/` consumers (no shims).
- **Verify:** Activates (manual Extension Host).

---

## Phase 3 — `src/state/`

### Task 3.1
- [x] `lib/state.js` → `src/state/state.js`
- [x] Updated `extension.js`, `lib/views.js`, `lib/tagGraphCommands.js` (JSDoc), and internal `lib/` paths in `state.js`.
- **Verify:** KB pick, drafts, persisted settings (manual Extension Host).

---

## Phase 4 — `src/knowledgebase/` + LHS trees

### Task 4.1
- [x] `lib/knowledgeBase.js` → `src/knowledgebase/knowledgeBase.js`
- [x] `lib/noteFileTypes.js` → `src/knowledgebase/noteFileTypes.js`
- [x] `lib/tree.js` → `src/views/lhs/knowledgebase/tree.js`
- [x] `lib/kbCreateMenu.js` → `src/views/lhs/knowledgebase/kbCreateMenu.js`
- [x] `lib/kbTreeIcon.js` → `src/views/lhs/knowledgebase/kbTreeIcon.js`
- [x] `lib/kbTreeDragDrop.js` → `src/views/lhs/knowledgebase/kbTreeDragDrop.js`
- [x] `lib/dripSidebarViews.js` → `src/views/lhs/knowledgebase/dripSidebarViews.js`
- [x] Updated requires in `extension.js`, `src/state/state.js`, `lib/views.js`, and 13 `lib/` consumers.
- **Verify:** KB tree, create/rename/delete, `.dripignore` (manual Extension Host).

---

## Phase 5 — `src/indexing/`

### Task 5.1
- [x] Move all `lib/dripnoteIndex.js`, `dripnoteIndexSync.js`, `dripnoteFileIdentity.js`, `dripnoteEntityIds.js`, `dripnoteFileIdDefinitions.js`, `dripnoteFileIdMigration.js`, `dripnoteReferencePhase3.js` → `src/indexing/` (same filenames).
- [x] Updated requires in `extension.js`, `src/state/state.js`, `src/knowledgebase/knowledgeBase.js`, `lib/dripnoteReferenceAssist.js`, and internal `src/indexing/` cross-refs.
- **Verify:** Startup reconcile, Update _index, fileId on open, link migrations command (manual Extension Host).

---

## Phase 6 — `src/graph/`

### Task 6.1
- [x] Move `tagGraphStore.js`, `tagGraphCommands.js`, `tagsWebview.js`, `tagsGraphEmbedRuntime.js`, `tagsGraphSubOnlyEmbed.js` → `src/graph/`
- [x] Move `dripnoteReferenceSync.js`, `dripnoteReferenceAssist.js`, `dripnoteReferenceDefinitions.js`, `dripnoteLinkDropInsert.js`, `noteDocumentLinks.js` → `src/graph/`
- [x] Updated requires in `extension.js`, `src/state/`, `src/indexing/`, `lib/views.js`, and 5 other `lib/` consumers.
- **Verify:** Tags graph, L. assist, F12, drop insert (manual Extension Host).

---

## Phase 7 — `src/document/` + `src/views/editor/`

### Task 7.1 — document parse / validate
- [x] `dripnoteCanvasParse.js`, `dripnoteHeadingAboveIndent.js`, `dripnoteDatetime.js` → `src/document/parse/`
- [x] `dripnoteMetadataTemplates.js` → `src/document/model/`
- [x] `dripnoteMetadataDiagnosticsTemplates.js` → `src/document/validate/`
- [x] Updated requires in moved files + `lib/dripnoteRetrieverQuery.js`, `lib/dripnoteCanvasPanel.js`, `lib/settingsWebview.js`.

### Task 7.2 — editor providers
- [x] `dripnoteSemanticTokens.js`, `dripnoteCustomDecorations.js`, `dripnoteMetadataCompletion.js`, `dripnoteTagCompletion.js`, `dripnoteDocumentSymbols.js`, `noteImagePaste.js` → `src/views/editor/`
- [x] Updated `extension.js` provider registration paths.
- **Verify:** Colors, diagnostics, completion, symbols, image paste (manual Extension Host).

---

## Phase 8 — `src/retrieval/`

### Task 8.1
- [x] `retrieverPanel.js`, `retrieverQuickOpen.js`, `dripnoteRetrieverQuery.js`, `embeddings.js` → `src/retrieval/`
- [x] Updated requires in `extension.js`, `lib/views.js`, `src/knowledgebase/knowledgeBase.js`, and internal `src/retrieval/` paths.
- **Verify:** Retriever panel, quick-open, embedding benchmark (manual Extension Host).

---

## Phase 9 — `src/views/`

### Task 9.1
- [x] `views.js` → `src/views/views.js` (**whole file**, no split)
- [x] `storageWebview.js`, `webviews.js`, `settingsWebview.js`, `dripnoteCanvasPanel.js`, `capturePreprocess.js` → `src/views/`
- [x] Updated requires in `extension.js` and moved files (`../shared/`, `../graph/`, etc.).
- [x] `lib/` is now empty (delete in Task 10.2).
- **Verify:** Composer, Storage ingest, Canvas, Settings, Tags panel messages (manual Extension Host).

---

## Phase 10 — `src/extension/` + remove legacy

### Task 10.1 — Entry
- [x] Move `extension.js` activate body → `src/extension/activate.js`
- [x] `src/extension/extension.js` exports `{ activate }`
- [x] Root `extension.js` → thin shim re-exporting `src/extension/extension.js`
- [x] `package.json` `"main": "./extension.js"` (shim kept)
- [x] All `require('./lib/...')` paths eliminated.

### Task 10.2 — Delete `lib/`
- [x] Removed empty `lib/` directory.
- [x] Grep: no `require('./lib/` or `require('../lib/` in application `.js` code.
- **Verify:** Full smoke 0.1 (manual Extension Host).

---

## Full file mapping (`lib/` → `src/`)

| Current | Target |
|---------|--------|
| `extension.js` (body) | `src/extension/activate.js` |
| `lib/constants.js` | `src/shared/constants.js` |
| `lib/utils.js` | `src/shared/utils.js` |
| `lib/state.js` | `src/state/state.js` |
| `lib/knowledgeBase.js` | `src/knowledgebase/knowledgeBase.js` |
| `lib/noteFileTypes.js` | `src/knowledgebase/noteFileTypes.js` |
| `lib/tree.js` | `src/views/lhs/knowledgebase/tree.js` |
| `lib/kbCreateMenu.js` | `src/views/lhs/knowledgebase/kbCreateMenu.js` |
| `lib/kbTreeIcon.js` | `src/views/lhs/knowledgebase/kbTreeIcon.js` |
| `lib/kbTreeDragDrop.js` | `src/views/lhs/knowledgebase/kbTreeDragDrop.js` |
| `lib/dripSidebarViews.js` | `src/views/lhs/knowledgebase/dripSidebarViews.js` |
| `lib/dripnoteIndex.js` | `src/indexing/dripnoteIndex.js` |
| `lib/dripnoteIndexSync.js` | `src/indexing/dripnoteIndexSync.js` |
| `lib/dripnoteFileIdentity.js` | `src/indexing/dripnoteFileIdentity.js` |
| `lib/dripnoteEntityIds.js` | `src/indexing/dripnoteEntityIds.js` |
| `lib/dripnoteFileIdDefinitions.js` | `src/indexing/dripnoteFileIdDefinitions.js` |
| `lib/dripnoteFileIdMigration.js` | `src/indexing/dripnoteFileIdMigration.js` |
| `lib/dripnoteReferencePhase3.js` | `src/indexing/dripnoteReferencePhase3.js` |
| `lib/tagGraphStore.js` | `src/graph/tagGraphStore.js` |
| `lib/tagGraphCommands.js` | `src/graph/tagGraphCommands.js` |
| `lib/tagsWebview.js` | `src/graph/tagsWebview.js` |
| `lib/tagsGraphEmbedRuntime.js` | `src/graph/tagsGraphEmbedRuntime.js` |
| `lib/tagsGraphSubOnlyEmbed.js` | `src/graph/tagsGraphSubOnlyEmbed.js` |
| `lib/dripnoteReferenceSync.js` | `src/graph/dripnoteReferenceSync.js` |
| `lib/dripnoteReferenceAssist.js` | `src/graph/dripnoteReferenceAssist.js` |
| `lib/dripnoteReferenceDefinitions.js` | `src/graph/dripnoteReferenceDefinitions.js` |
| `lib/dripnoteLinkDropInsert.js` | `src/graph/dripnoteLinkDropInsert.js` |
| `lib/noteDocumentLinks.js` | `src/graph/noteDocumentLinks.js` |
| `lib/dripnoteCanvasParse.js` | `src/document/parse/dripnoteCanvasParse.js` |
| `lib/dripnoteHeadingAboveIndent.js` | `src/document/parse/dripnoteHeadingAboveIndent.js` |
| `lib/dripnoteDatetime.js` | `src/document/parse/dripnoteDatetime.js` |
| `lib/dripnoteMetadataTemplates.js` | `src/document/model/dripnoteMetadataTemplates.js` |
| `lib/dripnoteMetadataDiagnosticsTemplates.js` | `src/document/validate/dripnoteMetadataDiagnosticsTemplates.js` |
| `lib/dripnoteSemanticTokens.js` | `src/views/editor/dripnoteSemanticTokens.js` |
| `lib/dripnoteCustomDecorations.js` | `src/views/editor/dripnoteCustomDecorations.js` |
| `lib/dripnoteMetadataCompletion.js` | `src/views/editor/dripnoteMetadataCompletion.js` |
| `lib/dripnoteTagCompletion.js` | `src/views/editor/dripnoteTagCompletion.js` |
| `lib/dripnoteDocumentSymbols.js` | `src/views/editor/dripnoteDocumentSymbols.js` |
| `lib/noteImagePaste.js` | `src/views/editor/noteImagePaste.js` |
| `lib/retrieverPanel.js` | `src/retrieval/retrieverPanel.js` |
| `lib/retrieverQuickOpen.js` | `src/retrieval/retrieverQuickOpen.js` |
| `lib/dripnoteRetrieverQuery.js` | `src/retrieval/dripnoteRetrieverQuery.js` |
| `lib/embeddings.js` | `src/retrieval/embeddings.js` |
| `lib/views.js` | `src/views/views.js` |
| `lib/storageWebview.js` | `src/views/storageWebview.js` |
| `lib/webviews.js` | `src/views/webviews.js` |
| `lib/settingsWebview.js` | `src/views/settingsWebview.js` |
| `lib/dripnoteCanvasPanel.js` | `src/views/dripnoteCanvasPanel.js` |
| `lib/capturePreprocess.js` | `src/views/capturePreprocess.js` |
| `syntaxes/` | `resources/syntaxes/` |
| `media/` | `resources/media/` |
| `language-configuration.json` | `resources/language-configuration.json` |

**Delete if unused:** `lib/dripnoteMetadataDiagnostics.js`, `src/extension.ts`

---

## Order

```
0.1 → 0.2 → 1.1 → 2.1 → 3.1 → 4.1 → 5.1 → 6.1 → 7.1 → 7.2 → 8.1 → 9.1 → 10.1 → 10.2
```

Each step: move files → fix `require` paths → smoke test. No empty-folder scaffolding step.

---

## How to ask the agent

```
Implement Task 2.1 only from @.cursor/temp-tasks/refactoring-codebase.md
Move only — no new code. Do not touch .cursor/ or cursor/.
```

---

## Smoke checklist

Run from `vscode/` root: `.\scripts\code.bat` → Extension Development Host → F5 or open DRIP workspace.

- [ ] Extension host starts (`code.bat`)
- [ ] Select `.driplock` KB
- [ ] KB tree refresh / create note
- [ ] Open `.d.txt` — color + diagnostics
- [ ] Composer + Storage ingest
- [ ] Tags graph
- [ ] Retriever
- [ ] Update _index / save sync

**Last baseline run:** 2026-06-05 — Phase 0 static/dead-code done; **manual smoke pending** (check boxes above after you verify).

**Phase 0 dead-code removed:**
| File | Reason |
|------|--------|
| `lib/dripnoteMetadataDiagnostics.js` | Unused; runtime uses `dripnoteMetadataDiagnosticsTemplates.js` |
| `src/extension.ts` | Orphan; not `package.json` main |
