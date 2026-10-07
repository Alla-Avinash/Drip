# DRIP — System flows

End-to-end flows from **`cursor/new/features.txt`**, with pointers to **current code** where implemented.

Spec references: Userflow (~L34–96), File open (~L552–614), Incremental edit (~L616–641), DB update (~L644–669), UI (~L678–738).

---

## 1. Application open (spec)

See **`.cursor/context/app-startup.md`** for the full code-level boot sequence (`activate()` phases, `ensureStartupIndexReconcile`, lazy webviews).

```
User opens DRIP
  → Restored window: startup_check runs (before update icon is usable)
  → No KB selected: user picks folder or existing .driplock
  → New plain folder:
      → Check parent dirs for .driplock OR prompt to init as .driplock
      → Create .dripindex/ (index.drip, graphs.drip/, settings.drip, drafts.drip/)
      → Parse headings into index.drip
  → Load .dripignore → only visible file IDs participate in search/ingest/retriever/canvas
```

**Current code:** `extension.js` → `DripState`; folder pick via `drip.selectKnowledgeBase`; startup reconcile via `registerDripnoteIndexSync` — no `.driplock` yet.

**Modules:** `extension.js`, `lib/state.js`, `lib/dripnoteIndexSync.js`

---

## 2. Initialize `.dripindex/` (spec)

```
.dripindex/
  ├── index.drip       SQLite — headings, metadata, tags, refs
  ├── graphs.drip/     default tag graphs for this KB
  ├── settings.drip    KB-scoped settings snapshot
  └── drafts.drip/     draft files
→ Initial parse populates index.drip
```

**Current code:**

| Spec piece | Current |
|------------|---------|
| `index.drip` | `_index.d.txt` — `lib/dripnoteIndex.js` |
| `graphs.drip/` | `lib/tagGraphStore.js` |
| `settings.drip` | VS Code `drip.*` + settings webview |
| `drafts.drip/` | `lib/state.js` drafts |

---

## 3. Update icon / rebuild index (spec)

```
User clicks update in KB toolbar
  → Compare disk files vs index.drip entries
  → New files only → parse headings, append
  → No new files → no-op
  → Skip contents of nested .driplock folders
```

**Current code:** `drip.rebuildKbIndexNow`, `Create _index Here`, `Remove _index Here` → `lib/dripnoteIndex.js`

---

## 4. Nested and merge `.driplock` (spec)

| Scenario | Behavior |
|----------|----------|
| Child `.driplock` inside parent | Parent does not index child contents; child shown as folder name only |
| Merge option 1 | Move child into parent externally; child re-indexed with continued heading IDs |
| Merge option 2 | Remove `.driplock` extension on child + press update |
| Merge option 3 | Context menu "merge with parent .driplock" on child folder in tree |

**Current code:** Not implemented — spec reference only.

---

## 5. External file/folder changes (spec)

Fault-tolerant reconcile when folders are copied/moved into KB or restructured internally — similar semantics to child `.driplock` merge; compare index vs disk.

**Current code:** KB file watcher → `refreshUi()`; manual `_index` rebuild.

**Modules:** `extension.js` (watcher), `lib/dripnoteIndexSync.js`

---

## 6. File open → index sync (spec)

```
Open .d.txt in editor
  Step 1: Read file metadata (file_id, path) — fix path drift in DB
  Step 2: Parse heading tree + hidden IDs
  Step 3: Build in-memory AST per heading
  Step 4: Compare hashes vs index.drip → UNCHANGED | UPDATED | NEW | DELETED
  Step 5: Mark dirty headings only
```

**Current code:** Save hooks + selective `_index` update; identity normalize on lifecycle events.

**Modules:** `lib/dripnoteIndexSync.js`, `lib/dripnoteFileIdentity.js`

---

## 7. Incremental edit (spec)

```
Document change event
  → Determine affected line range
  → Find nearest headings → reparse subtree only
  → Recompute hashes → mark dirty → queue debounced DB batch (10–15s)
```

**Current code:** Partial — index sync on save when tracked signals differ.

---

## 8. References and links

**Spec:** `ref: [@f26, @f45:h18]` in metadata; `references` table with source/target file+heading.

**Current code:** `L.` lines — assist, go-to-definition, migration processing.

**Modules:** `lib/dripnoteReferenceSync.js`, `lib/dripnoteReferencePhase3.js`, `lib/dripnoteReferenceAssist.js`, `lib/dripnoteReferenceDefinitions.js`

**Commands:** `drip.processPendingLinkMigrations`

---

## 9. UI flows by section

### LHS — Components

```
User opens Composer / Retriever / Tags / Canvas from Components view
  → Respective panel or webview created
  → Settings button → DRIP settings webview
```

**Modules:** `lib/views.js`, `lib/dripSidebarViews.js`, `lib/settingsWebview.js`

### LHS — Knowledge base

```
Select KB root → tree shows notes/folders honoring .dripignore
  → CRUD, drag-drop, copy path, rename, delete
  → Update _index / link migrations from toolbar or context menu
```

**Modules:** `lib/state.js`, `lib/tree.js`, `lib/knowledgeBase.js`, `lib/kbTreeDragDrop.js`

### LHS — Drafts

```
Draft list → open in Composer → save → stored in draft store
```

**Modules:** `lib/state.js`, `DripComposerPanel` in `lib/views.js`

### Editor — `.d.txt`

```
Open note → semantic tokens, diagnostics, tag completion, L. assist
  → Save triggers index sync when signals change
```

**Modules:** `lib/dripnoteSemanticTokens.js`, `lib/dripnoteMetadataDiagnostics*.js`, `lib/dripnoteTagCompletion.js`, etc.

### RHS — Storage

```
Navigate KB → pick file/heading placement → ingest from Composer
  → Optional embedding-ranked suggestions
```

**Modules:** `lib/views.js`, storage webview provider

### Tags graph

```
Edit graph in webview → persist JSON → tag completion syncs from graph folder
```

**Modules:** `lib/tagGraphStore.js`, `lib/tagsWebview.js`, `lib/views.js`

### Retriever

```
Build heading catalog → search/filter → open document at heading
```

**Modules:** `lib/retrieverPanel.js`, `lib/dripnoteRetrieverQuery.js`, `lib/retrieverQuickOpen.js`

---

## 10. Manual verification (user-driven)

After any change, user runs Extension Host and exercises the affected flow above. Agent describes **what the user should see** — no automated test files unless requested.

```powershell
# vscode/ root
$env:VSCODE_SKIP_PRELAUNCH = "1"
.\scripts\code.bat
```

Logs: **Help → Toggle Developer Tools** in Extension Development Host.
