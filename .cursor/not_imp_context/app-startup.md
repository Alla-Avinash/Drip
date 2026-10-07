# DRIP — Application startup flow

Deep dive into **how DRIP boots** in the Extension Development Host: when the extension activates, what runs in `activate()`, what is deferred, and how KB/index startup reconcile fits in.

**Spec reference:** `cursor/new/features.txt` Userflow (~L34–96) describes target behavior (`startup_check`, `.driplock`, `.dripindex/`). **This doc describes the current code path.**

**Primary files:** `extension.js`, `lib/dripnoteIndexSync.js`, `lib/state.js`, `lib/tagGraphStore.js`, `package.json`

---

## 1. Before `activate()` — when does DRIP load?

VS Code loads `extension.js` only when an **activation event** fires. DRIP does **not** use `"*"`.

| Trigger | Example |
|---------|---------|
| `onLanguage:dripnote` | User opens a `.d.txt` file |
| `onView:drip.*` | User opens DRIP activity bar (Components, KB, Drafts) |
| `onView:drip.storage` | User opens Storage in secondary sidebar |
| `onCommand:drip.*` | User runs a DRIP command |
| `onWebviewPanel:drip.*` | Tags / Retriever / Canvas panel restored |

**Implication:** Until one of these happens, DRIP is inactive. Opening only the Explorer does not activate DRIP.

**Entry:** `package.json` → `"main": "./extension.js"` → `activate(context)`.

---

## 2. `activate()` — ordered phases

Everything below runs **once per activation**, synchronously unless `await` is used.

```
┌─────────────────────────────────────────────────────────────────┐
│ PHASE A — Global services (no KB required)                      │
├─────────────────────────────────────────────────────────────────┤
│ 1. initializeMultiGraphStorage(context)     [async, awaited]    │
│ 2. registerDripnoteTagCompletion(context)                       │
│ 3. registerDripnoteSemanticTokens(context)                      │
│ 4. registerDripnoteMetadataDiagnostics(context)                 │
│ 5. registerDripnoteMetadataCompletion(context)                  │
│ 6. registerDripnoteCustomDecorations(context)                   │
│ 7. registerDripCanvasPanel(context)                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ PHASE B — Session state + startup hooks                         │
├─────────────────────────────────────────────────────────────────┤
│ 8.  new DripState(context)                                      │
│ 9.  registerDripnoteIndexSync(context, state)  ← index startup │
│ 10. registerRetrieverAutoRefresh(context, state)                │
│ 11. state.syncTagGraphCheckpointFromStorage()                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ PHASE C — Sidebar UI (trees exist; data may be empty)           │
├─────────────────────────────────────────────────────────────────┤
│ 12. DripTreeDataProvider × 3 (components | knowledge | drafts)│
│ 13. sidebarRefreshHub { refresh() }                             │
│ 14. createTreeView × 3 + kb drag-drop                           │
│ 15. registerDripSidebarViewBehavior(kbTreeView)                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ PHASE D — Editor providers + Storage webview registration       │
├─────────────────────────────────────────────────────────────────┤
│ 16. registerNoteImagePasteAndDrop                               │
│ 17. registerDripnoteReferenceAssist(state)                       │
│ 18. registerNoteDocumentLinks / Definitions / LinkDropInsert    │
│ 19. registerDripnoteDocumentSymbols                             │
│ 20. registerWebviewViewProvider(Storage)                        │
│ 21. registerCommand(...) — all drip.* commands                  │
│ 22. onDidChangeConfiguration(drip.*)                            │
│ 23. kbTreeView.onDidChangeVisibility → optional auto-open Composer│
│ 24. ensureKnowledgeBaseWatcher()                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Phase A — Tag graph + language services

### 3.1 `initializeMultiGraphStorage(context)`  
**File:** `lib/tagGraphStore.js`

Runs **first** (awaited). Prepares tags graph persistence before any UI reads it.

```
If registry already valid in globalState
  → ensure active graph blob exists
  → syncStoredGraphsFromFolder(context)
Else (first run or legacy)
  → migrate legacy TAG_GRAPH_KEY → multi-graph registry
  → create "default" graph blob
  → write mirror JSON to extension globalStorage/tag-graphs/
  → syncStoredGraphsFromFolder(context)
```

**Persists in:** `context.globalState` (registry + per-graph blobs) and optional user-configured folder (`drip.tagGraph.folderUri.v1`).

**Not KB-scoped** — tag graphs are extension-global today (spec target: per-KB `graphs.drip/`).

### 3.2 Language / editor registrations

Registered immediately; they activate when a `dripnote` document is opened or edited:

| Registration | File |
|--------------|------|
| Tag completion | `lib/dripnoteTagCompletion.js` |
| Semantic tokens | `lib/dripnoteSemanticTokens.js` |
| Metadata diagnostics | `lib/dripnoteMetadataDiagnosticsTemplates.js` |
| Metadata completion | `lib/dripnoteMetadataCompletion.js` |
| Custom decorations | `lib/dripnoteCustomDecorations.js` |
| Canvas panel command | `lib/dripnoteCanvasPanel.js` |

These attach listeners/providers to VS Code API; **no KB folder required** at register time.

---

## 4. Phase B — Session state and index startup

### 4.1 `new DripState(context)`

**File:** `lib/state.js`

Lightweight constructor:

- Holds `context` (extension context)
- In-memory tag graph undo/redo stacks
- `_tagGraphCheckpoint` — snapshot for "dirty graph" prompts

**Does not** load KB folder on construct. KB root comes from **workspace state**:

```javascript
// constants.js
KB_ROOT_KEY = 'drip.kbRoot'  // workspaceState
DRAFTS_KEY = 'drip.drafts'    // globalState
```

On first install: **no KB root** until user runs `drip.selectKnowledgeBase`.

### 4.2 `registerDripnoteIndexSync(context, state)`  
**File:** `lib/dripnoteIndexSync.js`

This is the closest equivalent to **spec `startup_check`** — runs index/path reconcile when a KB root exists.

**Registers:**

| Listener / command | Purpose |
|--------------------|---------|
| `onDidSaveTextDocument` | Selective `_index` update if tag/link signals changed |
| `onDidOpenTextDocument` | FileId drift realign + triggers startup reconcile |
| `onDidRenameFiles` / `onDidDeleteFiles` | Index sync on KB file moves |
| `drip.rebuildKbIndexNow` | Full identity normalize + reconcile all `_index` |
| `drip.processPendingLinkMigrations` | Process pending rows in `_index` preamble |

**Startup reconcile** — `ensureStartupIndexReconcile()`:

```
Called:
  • immediately at end of registerDripnoteIndexSync()
  • again after 2s delay (KB may be set shortly after activation)
  • again on first dripnote open (via maybeRealignFileIdOnOpen)

If no KB root → return (nothing to do)

If KB root already reconciled this session (same fsPath) → skip

If no root _index file:
  → Warning dialog: Create _index | Select another KB | Later

Else:
  → ensureRootIndexIfMissing(kbRoot)
  → reconcileIndexPathsLightweight(kbRoot, context)
       (path/name consistency only — NOT full content reparse)
  → processAllPendingLinkMigrations(kbRoot, context)
  → mark reconciledStartupKbFsPath = kbRoot.fsPath
```

**Lightweight reconcile** (`reconcileIndexPathsLightweight`): for each `_index` owner folder, compare indexed relative paths vs actual owned paths; rebuild index file only if lists differ. **Does not** re-parse all note headings on startup.

**Full rebuild** remains explicit: user command **Update _index** (`drip.rebuildKbIndexNow`).

### 4.3 `registerRetrieverAutoRefresh(context, state)`

**File:** `lib/retrieverPanel.js`

Registers `onDidSaveTextDocument` — if Retriever panel is open and saved file is a KB note, debounced catalog rebuild (~650ms). **No work at startup** unless panel is already visible.

### 4.4 `state.syncTagGraphCheckpointFromStorage()`

Loads active tag graph from `tagGraphStore` into `_tagGraphCheckpoint` so later edits can detect dirty state when switching graphs.

---

## 5. Phase C — Sidebar trees (LHS)

Three `TreeView`s are created **empty or partial** depending on persisted state:

| View ID | Provider mode | Initial content |
|---------|---------------|-----------------|
| `drip.components` | `components` | Static shortcuts (Composer, Retriever, Tags, Canvas, Choose KB, Settings) |
| `drip.knowledgeBase` | `knowledge` | Empty until KB root set; then folder tree via `knowledgeBase.getKnowledgeBaseTreeChildren` |
| `drip.drafts` | `drafts` | Drafts from `globalState` (`drip.drafts`) |

**`sidebarRefreshHub.refresh()`** — called after KB changes, file watcher events, many commands:

```
componentsTreeProvider.refresh()
kbTreeProvider.refresh()
draftsTreeProvider.refresh()
+ DripComposerPanel.postState()  (if composer open)
```

**`registerDripSidebarViewBehavior`** — sets VS Code context keys `drip.kbEmptySelection`, `drip.sidebarActive` for menu visibility. Does **not** force DRIP sidebar visible (by design).

**KB file watcher** — `ensureKnowledgeBaseWatcher()` at end of activate:

- If `state.getKnowledgeBaseRoot()` exists → `createFileSystemWatcher(kbRoot, **/*)`
- On create/change/delete → `refreshUi()`
- Re-created when user selects a new KB (`drip.selectKnowledgeBase`)

---

## 6. Phase D — Commands, Storage, configuration

### 6.1 Storage webview (RHS) — lazy HTML

**Registered** at activate: `registerWebviewViewProvider('drip.storage', DripStorageWebviewProvider)`.

**HTML and message handlers** run only when user opens Storage view → `resolveWebviewView()`:

```
getStorageWebviewHtml(webview)
registerTagGraphWebview(w)
onDidReceiveMessage → ingest, browse KB, composer note sync, etc.
```

Until Storage is opened, RHS ingest UI does not exist in memory.

### 6.2 All commands registered once

Composer, Retriever, Tags, KB CRUD, index commands, settings, embeddings benchmark — wired in one `context.subscriptions.push` block in `extension.js`.

Commands are **handlers only**; panels/webviews instantiate on first invoke (`createOrShow`).

### 6.3 Configuration listener

`onDidChangeConfiguration` when `drip.*` changes:

- Invalidate note extension cache
- `refreshUi()`
- Push KB note settings to Storage webview
- Optionally schedule Retriever catalog rebuild

### 6.4 Auto-open Composer (optional)

If `drip.autoOpenComposerOnSidebarReveal` is true:

- First time KB tree view becomes **visible** → `drip.openComposer` once per window session (`hasAutoOpenedComposer` flag).

---

## 7. KB selection — post-activation user path

Not part of `activate()` unless KB was already persisted in workspace state.

```
User: drip.selectKnowledgeBase (Components tree or command)
  → state.pickKnowledgeBaseFolder()
       → showOpenDialog (folder only)
       → MUST end with .driplock (current code enforces this)
       → workspaceState.update('drip.kbRoot', uri)
  → ensureKnowledgeBaseWatcher()
  → refreshUi()
  → refreshRetrieverCatalogIfShown() if Retriever open
  → ensureStartupIndexReconcile() (via index sync — on open/save/timer)
```

**Spec gap:** Target flow initializes `.dripindex/` on new `.driplock`; current code uses workspace-persisted folder + `_index.d.txt` text indexes, not `.dripindex/index.drip` SQLite.

---

## 8. Document open — secondary startup path

When user opens a `.d.txt` inside the KB **after** activation:

```
onDidOpenTextDocument
  → maybeRealignFileIdOnOpen(doc)
       → skip if not dripnote / outside KB / dirty / _index file
       → ensureStartupIndexReconcile()   ← may prompt for _index
       → detectFileIdDrift → normalize header if needed
       → apply link migration or syncNearestIndexForNote
```

This ties **first note open** to index startup if reconcile had not run yet (e.g. KB root existed but 2s timer had not fired).

---

## 9. End-to-end startup timeline (typical session)

```
T0  User opens DRIP view or .d.txt
    → VS Code activates extension

T1  activate() runs (~100–500ms depending on tag graph sync)
    → Language providers live
    → Index sync listeners registered
    → ensureStartupIndexReconcile() — no-op if no KB root
    → Trees render (Components + maybe empty KB + drafts)
    → KB watcher attached if kbRoot persisted from last session

T2  +2s  Second ensureStartupIndexReconcile() attempt

T3  User selects .driplock KB (if not already)
    → kbRoot saved, watcher started, trees refresh
    → Startup reconcile: _index check, lightweight path sync, link migrations

T4  User opens Storage (optional)
    → Storage webview HTML loads, requestState → composer/draft sync

T5  User opens KB tree (optional)
    → autoOpenComposer may fire once

T6  User opens/edits .d.txt
    → Language services apply
    → On save: maybeSyncForDocument if index signals changed
    → On open: fileId realign path
```

---

## 10. Persistence touched at startup

| Key / location | Scope | When read/written |
|----------------|-------|-------------------|
| `drip.kbRoot` | workspaceState | KB pick; read on every tree/index operation |
| `drip.drafts` | globalState | Drafts tree; not required for activate |
| Tag graph registry + blobs | globalState | Phase A init |
| `tag-graphs/*.json` | globalStorageUri | Phase A mirror sync |
| `_index.d.txt` (per folder) | KB disk | Startup reconcile if KB set |
| `drip.*` settings | VS Code configuration | On demand; listener refreshes UI |

---

## 11. Spec vs current startup (summary)

| Spec (`features.txt`) | Current code |
|------------------------|--------------|
| `startup_check` before update icon | `ensureStartupIndexReconcile()` in index sync |
| `.driplock` + `.dripindex/` init | `.driplock` required on pick; no `.dripindex/` folder yet |
| SQLite `index.drip` full heading index | Text `_index.d.txt`; lightweight path reconcile on startup |
| Load `.dripignore` then filter index | `.dripignore` honored in tree scan; index reconcile separate |
| Drafts from `.dripindex/drafts.drip/` | Drafts in `globalState` |

---

## 12. Debugging startup issues

| Symptom | Check |
|---------|-------|
| DRIP never loads | Was an activation event triggered? Open DRIP view or `.d.txt` |
| No KB tree | `drip.kbRoot` unset — run Choose KB; folder must be `.driplock` |
| `_index` prompt on every open | `reconciledStartupKbFsPath` reset — reconcile threw; see DevTools console `[DRIP] Phase2 startup index reconcile` |
| Tags broken on fresh install | `initializeMultiGraphStorage` — globalState / tag-graphs folder |
| Composer auto-opens unexpectedly | `drip.autoOpenComposerOnSidebarReveal` + first KB tree visibility |

**Logs:** Extension Development Host → **Help → Toggle Developer Tools** → Console filter `[DRIP]`.

**Run:**

```powershell
# vscode/ repo root
$env:VSCODE_SKIP_PRELAUNCH = "1"
.\scripts\code.bat
```

---

