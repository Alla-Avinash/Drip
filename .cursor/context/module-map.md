# DRIP — Module map (current code)

**Navigation hub** — use this first so you do not search the whole repo. Maps **today's implementation** to files. **Product behavior:** `@cursor/new/features.txt`.

**When you add or move modules, update this file** (see `@.cursor/context/developer-ergonomics.md`).

Grep/read only files relevant to your task.

---

## Wire-up & constants

| Concern | Files |
|---------|-------|
| Activation, commands | `src/extension/activate.js` (entry: `extension.js` → `src/extension/extension.js`) |
| IDs | `src/shared/constants.js` |

## State & KB tree

| Concern | Files |
|---------|-------|
| Session state, KB root, drafts, CRUD | `src/state/state.js` |
| KB pick / `.driplock` userflow | `src/startup/selectKnowledgeBase.js` |
| `.dripindex/` skeleton init | `src/startup/initializeDripIndex.js` |
| `settings.drip.json` load/save/import/export | `src/startup/settingsDrip.js` |
| New `.driplock` default settings template | `src/startup/settings.drip.json` → `defaultKnowledgeBaseSettings.js` → `initializeDripIndex.js` (`ensureDripIndexSkeleton`) |
| **GitHub backup** (push/pull KB notes via Git) | `src/startup/githubBackup.js` — Settings panel in `settingsWebview.js`; commands `drip.github.*` in `activate.js`; optional PAT in `SecretStorage`; `.dripindex/` gitignored |
| `drafts.drip/` storage | `src/startup/draftsDrip.js` |
| KB sidecar load on startup | `src/startup/loadKbSidecar.js` |
| `startup_check` (restored window) | `src/startup/startupCheck.js` |
| Update icon / index rebuild | `src/startup/updateKnowledgeBase.js` |
| KB filesystem (scan, walk, `.dripignore`) | `src/indexing/kbFilesystem.js` |
| Note parse / ingest / ranking | `src/document/kbNoteOps.js` |
| Note extensions | `src/document/model/noteFileTypes.js` |
| **Project folders (`.p`)** | `src/document/model/dripProjectFolder.js`; `src/startup/dripProjectFolder.js`. Index note `_Name.p.d.txt` with h0 `# .p Title`. Create: `drip.createProjectFolder` / New menu (or New Folder named `Name.p`). Delete: `drip.deleteProject` (index note cannot be deleted alone). |
| **Feature / project placement** | `src/document/model/dripKbFolderRules.js` — project folder whitelist: `_Name.p.d.txt`, `_issues.d.txt`, feature folders `*.f` **and** feature files `*.f.d.txt`. Create: `drip.createFeatureFolder` / `drip.createFeatureFile` / New menu. |
| **Project structure / ids / mailbox** | Rules: `.cursor/rules/context/drip-project-structure.mdc`. Code: `src/document/project/projectStructureRules.js`, `projectEntityIds.js` (`f-#`/`i-#` alloc in `index_meta`), `projectIssuesMailbox.js` (create in `_issues`, **move** to feature `_recent`), `issueInboxLayout.js` (pure text placement: new issues as last child of plain `# recents` in `_issues`; sub-issues indented under their parent heading), `issueParentLink.js` (issue parent rules: nested under an issue in the same file → parent **implied** by indentation, no `parent:` line; else **optional** `parent: i-N` = any project issue except self/sub-issues; validation, cycle sanitize, line write — used by RHS, diagnostics, index, Project View, mailbox move). |
| **Special vs document metadata** | Notes: concept+task. Projects: project+feature+issue+task. Issue attribute `parent: i-N` → `issues.parent_issue_key` (and `issue_metadata` mirror). No decision in defaults. |
| **Project View** | `src/views/lhs/projects/panel.js` + `webview/projectView.js` / `projectView.css`; `src/indexing/projectViewQuery.js` (`projects` + `issues` by `project_id`). |
| **Project index helpers** | `src/indexing/projectIndex.js` — ensure `projects` row, resolve `project_id`, upsert `issues`. |
| Tables (v14) | `projects`, `headings.project_id`, `issues` (+ legacy `issue_metadata` mirror); `project_entity_alloc_*` cache in `index_meta` |
| Recents (last 10 `.d.txt`, KB-portable) | `.dripindex/recents.drip.json` via `src/startup/recentsDrip.js`; `DripState.getRecentFiles` / `touchRecentFile` / `refreshRecentsFromStorage`; view `drip.recents` |
| Daily Notes (LHS tree; KB folder hidden from KB tree) | KB-root `dailynotes.drip/<year>/<Month YYYY>/` via `src/startup/dailyNotesDrip.js` (`ensureTodayDailyNote` uses `buildNewNoteFile` + normal fileid/heading identity); view `drip.dailyNotes`; command `drip.openTodayDailyNote`; hidden in `kbFilesystem.getKnowledgeBaseTreeChildren` |
| Create menu, icons, drag-drop | `src/views/lhs/knowledgebase/kbCreateMenu.js`, `kbTreeIcon.js`, `kbTreeDragDrop.js`, `icons/*.svg` |
| Sidebar behavior | `src/views/lhs/knowledgebase/dripSidebarViews.js` |

## Webviews & panels

| Concern | Files |
|---------|-------|
| Composer, Tags, Storage | `src/views/views.js` |
| Composer | `src/views/composer/` — title + metadata + body; `composerHtml.js`, `webview/*` |
| Capture | `src/views/capturePreprocess.js` — strip `@f…` ids + blank noise; split title / metadata / body |
| Webview helpers | `src/views/webviews.js` (sidebar; Composer re-exported from `composer/`) |
| Storage (RHS) | `src/views/rhs/storage/` — `storageHtml.js` (host shell), `webview/storage.js` (UI logic), `storage.css`, `storageBody.html` |
| Heading form (RHS) | `src/views/rhs/headingForm/` — `panel.js` (webview host), `headingFormSession.js` (open/close/bind), `headingFormApply.js` (surgical buffer write via `document/model/headingBlockPatch.js`), `headingFormIssueParent.js` (Parent issue field: locked state, project-wide options, apply-time validation), `webview/*`. Soft-lock: `src/views/editor/persistentHeadingSoftLock.js`. Zones: `document/model/persistentHeadingZones.js`. Modes: `headingEditModes.js` |
| RHS Storage reveal | `src/views/rhs/revealStorageOnly.js` — mutually exclusive Heading ↔ Storage via `drip.rhsHideHeading` / `drip.rhsHideStorage` |
| Settings HTML | `src/views/settingsWebview.js` |
| Tags UI | `src/graph/tagsWebview.js` |
| Retriever | `src/views/lhs/retriever/panel.js`, `webview/retrieverPanel.js` — multi-relation filters; search engine modes; session custom paths; Files scope; attribute filters |
| Canvas | `src/views/lhs/canvas/panel.js`, `webview/canvas.js`, `src/document/parse/dripnoteCanvasParse.js`, `src/document/workflow/dripnoteWorkflowParse.js`, `src/document/graph/dripnoteNodeGraphParse.js` (file-local node graph) |

## File identity (→ spec: `@f`, heading `@h`)

| Concern | Files |
|---------|-------|
| Header identity, hash | `src/indexing/dripnoteFileIdentity.js` |
| Entity IDs | `src/indexing/dripnoteEntityIds.js`, `src/indexing/dripnoteFileIdDefinitions.js` |
| Heading identity (`@fN:hM`) reconcile | `src/indexing/dripnoteHeadingIdentity.js` — hash suffix, `index.drip` per-file allocator (`heading_alloc_*`) |
| Heading identity reconcile on disk (index update) | `src/indexing/dripnoteHeadingIdentityReconcile.js` — `reconcileNoteHeadingIdentitiesOnDisk`, `reconcileHeadingIdentitiesScope` |
| **reconcile-update** (unwired; planned feature base) | `src/indexing/sync/dripnoteReconcileUpdate.js` — `reconcileUpdate`: file-id ownership vs `files.path`, header/h0 above `---`, heading rewrite, immediate `index.drip` persist. Not hooked to editor events. |
| Copy heading id command | `src/views/editor/dripnoteHeadingIdentityDisplay.js` |
| ID migration | `src/indexing/dripnoteFileIdMigration.js` |

## Index (→ spec: `index.drip` SQLite)

| Concern | Files |
|---------|-------|
| `index.drip` SQLite | `src/indexing/dripIndexDb.js`, `dripIndexParse.js` |
| SQLite runtime (better-sqlite3) | `src/indexing/db/dripSqlite.js` — file-backed open; sql.js-compat `run`/`exec`/`prepare`; loads sqlite-vec |
| Heading embedding storage (v11) | `src/indexing/embeddings/headingEmbeddingStore.js` — records + vec0 |
| Heading embedding input text | `src/indexing/embeddings/headingEmbeddingText.js` — title + semantic tags only |
| Heading embedding encode | `src/indexing/embeddings/headingEmbeddingEncode.js` — wraps `retrieval/embeddings.js` |
| Heading embedding queue | `src/indexing/embeddings/headingEmbeddingQueue.js` — per-KB jobs |
| Heading embedding sync | `src/indexing/embeddings/headingEmbeddingSync.js` — plan upserts, drain, missing repair |
| Heading embedding search method | `src/indexing/embeddings/headingEmbeddingSearchMethod.js` — lock exact/faiss once per KB load |
| Heading embedding search | `src/indexing/embeddings/headingEmbeddingSearch.js` — query → sqlite-vec / FAISS → DB cards |
| Heading embedding FAISS | `src/indexing/embeddings/headingEmbeddingFaiss.js` — lazy HNSW under `.dripindex/heading-embeddings.faiss` |
| Folder embedding text | `src/indexing/embeddings/folderEmbeddingText.js` — path + folder h0 title |
| Folder embedding storage | `src/indexing/embeddings/folderEmbeddingStore.js` — records + vec0 (exact only) |
| Folder embedding queue/sync | `src/indexing/embeddings/folderEmbeddingQueue.js`, `folderEmbeddingSync.js` |
| Folder embedding search | `src/indexing/embeddings/folderEmbeddingSearch.js` — exact sqlite-vec |
| Tag embedding storage | `src/indexing/embeddings/tagEmbeddingStore.js` — records + vec0 (exact only, no FAISS) |
| Tag embedding sync | `src/indexing/embeddings/tagEmbeddingSync.js` — encode missing tags from `tags` |
| Tag embedding search | `src/indexing/embeddings/tagEmbeddingSearch.js` — hybrid suggest: 3 prefix + 5 sqlite-vec |
| Embedding model change | `src/indexing/embeddings/embeddingModelChange.js` — confirm → clear vectors/FAISS → rebuild (keep note IDs) |
| `index.drip` schema (runtime) | `src/indexing/dbSchema/dripIndexSchema.js` |
| `index.drip` schema (docs mirror) | `cursor/new/index.drip.schema.sql` |
| Typed metadata parse | `src/indexing/parse/dripIndexTypedMetadata.js` |
| Metadata type for index (NULL = untyped) | `src/indexing/parse/dripIndexMetadataType.js` |
| Metadata validate for index | `src/indexing/parse/dripIndexMetadataValidate.js` |
| Incremental subtree parse | `src/indexing/parse/dripIndexIncrementalParse.js` |
| Index update (parse → DB) | `src/indexing/sync/dripnoteIndexUpdate.js` |
| Index update buffer (6s) | `src/indexing/sync/dripnoteIndexUpdateQueue.js` |
| Document edit surveillance | `src/indexing/sync/dripnoteDocumentWatch.js` (`DOCUMENT_WATCH_MANIFEST`) |
| VS Code event wiring | `src/indexing/dripnoteIndexSync.js` |
| KB reindex (settings + toolbar update) | `src/indexing/sync/dripnoteKbReindex.js` — workspace (`.dripignore`) vs full driplock reset (`index.drip` wipe). Commands: `drip.reindexCurrentKbWorkspace` (KB toolbar + settings), `drip.resetReindexEntireKb` (**settings only**). |
| Tables (v12) | Core: `files`, `headings` (`parent` = same-file parent heading_id from tab indent), `heading_references`, `tags`, `searchtags`, `relations`; lookups: `metadata_types`, `relation_types`; hot metadata: `concept_metadata`, `project_metadata`, `task_metadata`, `issue_metadata`, `decision_metadata`; sparse EAV: `metadata_remaining_keys`; embeddings: `heading_embedding_records` + vec0 `heading_embedding_vectors`; folder embeddings: `folder_embedding_records` + vec0 `folder_embedding_vectors`; tag embeddings: `tag_embedding_records` + vec0 `tag_embedding_vectors` |
| `searchtags` | heading → searchable tag (`tags:` / `[…]`) |
| `relations` | heading → related tag via relation key (`pre-req: [react, …]`) |
| `heading_references` | `ref: [@f32 (topic), @f3]` file-level links (no heading target) |
| KB filesystem walk / ignore | `src/indexing/kbFilesystem.js` |
| Save/startup sync | `src/indexing/sync/dripnoteIndexUpdate.js`, `dripnoteIndexSync.js`, `src/startup/updateKnowledgeBase.js` |
| Legacy `_index.d.txt` (deprecated) | `src/indexing/dripnoteIndex.js` |
| Link migration (index) | `src/indexing/dripnoteReferencePhase3.js` |

## Graph & links (→ spec: `ref:` table, tag graph)

| Concern | Files |
|---------|-------|
| Tag graph store | `src/graph/tagGraphStore.js` |
| Tag graph commands | `src/graph/tagGraphCommands.js` |
| Tags webview | `src/graph/tagsWebview.js`, `tagsGraphEmbedRuntime.js`, `tagsGraphSubOnlyEmbed.js` |
| Link sync | `src/graph/dripnoteReferenceSync.js` |
| Assist | `src/graph/dripnoteReferenceAssist.js` |
| Go-to-definition | `src/graph/dripnoteReferenceDefinitions.js` |
| Drop insert | `src/graph/dripnoteLinkDropInsert.js` |
| Document links | `src/graph/noteDocumentLinks.js` |

## Document (.d.txt parse / validate)

| Concern | Files |
|---------|-------|
| Parse | `src/document/parse/dripnoteCanvasParse.js`, `dripnoteRefLinks.js`, `dripnoteHeadingAboveIndent.js`, `dripnoteDatetime.js` |
| KB note ops (header/body, ingest) | `src/document/kbNoteOps.js` |
| Grammar / editor language config | `src/document/syntaxes/dripnote.tmLanguage.json`, `language-configuration.json` |
| Model / templates | `src/document/model/dripnoteMetadataTemplates.js`, `noteFileTypes.js` |
| Persistent heading rule (`# .` / configured type) | `src/document/model/dripnotePersistentHeading.js` |
| File-wide marked concept numbering (`c#` / `.c#`) | `src/document/concept/dripnoteConceptNumbering.js` |
| **Workflow DAG** (task `workflow: true` next-line, contiguous `.t1…tN`, `parent:`) | `src/document/workflow/dripnoteWorkflowParse.js`, `dripnoteWorkflowTaskIdentity.js` (renumber + parent remap/scrub), `dripnoteWorkflowDiagnostics.js`; title shortcut → `dripnoteMetadataTemplates.matchHeadingTitleTypePrefix` |
| Validate / diagnostics | `src/document/validate/dripnoteMetadataDiagnosticsTemplates.js` |

## Editor (language UI)

| Concern | Files |
|---------|-------|
| Semantic tokens | `src/views/editor/dripnoteSemanticTokens.js` |
| Decorations | `src/views/editor/dripnoteCustomDecorations.js` |
| Completion | `src/views/editor/dripnoteMetadataCompletion.js`, `dripnoteTagCompletion.js` |
| Symbols, image paste | `src/views/editor/dripnoteDocumentSymbols.js`, `noteImagePaste.js` |
| Grammar | `src/document/syntaxes/dripnote.tmLanguage.json`, `src/document/language-configuration.json` |

## Retrieval & embeddings

| Concern | Files |
|---------|-------|
| Retriever panel (host + webview) | `src/views/lhs/retriever/` |
| Retriever query / embeddings | `src/retrieval/dripnoteRetrieverQuery.js`, `embeddings.js`, `retrieverQuickOpen.js` |
| Query | `src/retrieval/dripnoteRetrieverQuery.js` |
| Quick open | `src/retrieval/retrieverQuickOpen.js` |
| Embeddings | `src/retrieval/embeddings.js` — Transformers.js; weights in `<extension>/.cache/transformers` |
| Embedding benchmarks | `benchmarks/` — field recipes + exact vs FAISS (`npm run bench:embeddings`) |
| Embedding benchmarks | `benchmarks/` — field recipes + exact vs FAISS (`node benchmarks/run.js`) |

## Spec cross-reference

| Spec area (`features.txt`) | Start in code |
|----------------------------|---------------|
| Userflow / KB select | `extension.js`, `src/state/state.js` |
| Update icon / index | `src/indexing/dripnoteIndex.js` |
| Heading/file IDs | `src/indexing/dripnoteFileIdentity.js` |
| References | `src/graph/dripnoteReference*.js` |
| LHS Components | `src/views/views.js` |
| RHS Storage / ingest | `src/views/views.js` (provider), `src/views/rhs/storage/` (webview) |
| Tags graph | `src/graph/tagGraphStore.js` |
| `.d.txt` format | `cursor/implementations/DRIPNOTE_FORMAT.md` + spec ~L218–268 |
