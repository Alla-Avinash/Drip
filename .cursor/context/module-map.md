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
| `drafts.drip/` storage | `src/startup/draftsDrip.js` |
| KB sidecar load on startup | `src/startup/loadKbSidecar.js` |
| `startup_check` (restored window) | `src/startup/startupCheck.js` |
| Update icon / index rebuild | `src/startup/updateKnowledgeBase.js` |
| KB filesystem (scan, walk, `.dripignore`) | `src/indexing/kbFilesystem.js` |
| Note parse / ingest / ranking | `src/document/kbNoteOps.js` |
| Note extensions | `src/document/model/noteFileTypes.js` |
| Tree providers | `src/views/lhs/knowledgebase/tree.js` |
| Create menu, icons, drag-drop | `src/views/lhs/knowledgebase/kbCreateMenu.js`, `kbTreeIcon.js`, `kbTreeDragDrop.js`, `icons/*.svg` |
| Sidebar behavior | `src/views/lhs/knowledgebase/dripSidebarViews.js` |

## Webviews & panels

| Concern | Files |
|---------|-------|
| Composer, Tags, Storage | `src/views/views.js` |
| Webview helpers | `src/views/webviews.js` |
| Storage (RHS) | `src/views/rhs/storage/` — `storageHtml.js` (host shell), `webview/storage.js` (UI logic), `storage.css`, `storageBody.html` |
| Settings HTML | `src/views/settingsWebview.js` |
| Tags UI | `src/graph/tagsWebview.js` |
| Retriever | `src/views/lhs/retriever/panel.js`, `webview/retrieverPanel.js` |
| Canvas | `src/views/lhs/canvas/panel.js`, `webview/canvas.js`, `src/document/parse/dripnoteCanvasParse.js`, `src/document/workflow/dripnoteWorkflowParse.js` |
| Capture | `src/views/capturePreprocess.js` |

## File identity (→ spec: `@f`, heading `@h`)

| Concern | Files |
|---------|-------|
| Header identity, hash | `src/indexing/dripnoteFileIdentity.js` |
| Entity IDs | `src/indexing/dripnoteEntityIds.js`, `src/indexing/dripnoteFileIdDefinitions.js` |
| Heading identity (`@fN:hM`) reconcile | `src/indexing/dripnoteHeadingIdentity.js` — hash suffix, `index.drip` per-file allocator (`heading_alloc_*`) |
| Heading identity reconcile on disk (index update) | `src/indexing/dripnoteHeadingIdentityReconcile.js` — `reconcileNoteHeadingIdentitiesOnDisk`, `reconcileHeadingIdentitiesScope` |
| Copy heading id command | `src/views/editor/dripnoteHeadingIdentityDisplay.js` |
| ID migration | `src/indexing/dripnoteFileIdMigration.js` |

## Index (→ spec: `index.drip` SQLite)

| Concern | Files |
|---------|-------|
| `index.drip` SQLite | `src/indexing/dripIndexDb.js`, `cursor/new/dripIndexSchema.js`, `dripIndexParse.js` |
| Typed metadata parse | `src/indexing/parse/dripIndexTypedMetadata.js` |
| Metadata type for index (NULL = untyped) | `src/indexing/parse/dripIndexMetadataType.js` |
| Metadata validate for index | `src/indexing/parse/dripIndexMetadataValidate.js` |
| Incremental subtree parse | `src/indexing/parse/dripIndexIncrementalParse.js` |
| Index update (parse → DB) | `src/indexing/sync/dripnoteIndexUpdate.js` |
| Index update buffer (6s) | `src/indexing/sync/dripnoteIndexUpdateQueue.js` |
| Document edit surveillance | `src/indexing/sync/dripnoteDocumentWatch.js` (`DOCUMENT_WATCH_MANIFEST`) |
| VS Code event wiring | `src/indexing/dripnoteIndexSync.js` |
| Tables (v4) | `files`, `headings`, `heading_references`, `tags`, `searchtags`, `relations`, `issue_metadata`, `project_metadata`, `concept_metadata` |
| `searchtags` | heading → searchable tag (`tags:` / `[…]`) |
| `relations` | heading → related tag via relation key (`pre-req: [react, …]`) |
| `heading_references` | `ref: [@f32:h4, …]` cross-file/heading links |
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
| Embeddings | `src/retrieval/embeddings.js` |

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
