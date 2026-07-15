# Debugging — prompt template

Copy into chat or `@` this file when investigating a bug.

---

## Your report (fill in)

**Symptom:**  
[Command, view, editor, webview — what fails]

**Repro steps:**  
1. …  
2. …

**Expected (from spec if applicable):**  
[From `cursor/new/features.txt` or your understanding]

**Actual:**  
[What happens instead]

**Error / log:**  
[Paste exact Extension Host console or DevTools output]

**Recent changes (optional):**  
[Files or feature area touched]

---

## Instructions for the agent

Follow:
- `@.cursor/rules/core/workflow.mdc` (Debugging)
- `@.cursor/rules/core/developer-ergonomics.mdc`
- `@.cursor/rules/prompts/debugging.mdc`

### Step 1 — Locate (no blind patches)

1. Map symptom to a flow in `@.cursor/context/system-flows.md`.
2. Cross-check expected behavior in `@cursor/new/features.txt` if relevant.
3. Grep **only** files listed in `@.cursor/context/module-map.md` for that subsystem.
4. State **Problem** with file + function (and line if helpful).

### Step 2 — Root cause

One or two sentences: **Cause** — wrong assumption, missing refresh, stale index, message handler bug, etc.

### Step 3 — Fix

- Minimal change in affected `lib/*` or `extension.js`.
- Note **side effects** (index sync, link migration, webview refresh, tree refresh).
- No refactors. No unrelated files.

### Step 4 — Report

```
Problem: …
Cause: …
Fix: …
User tests: [what you should do in Extension Host to confirm]
Where to edit next time: [path/file → function if this area breaks again]
```

Do **not** write automated test files unless explicitly requested.

---

## Common failure areas

| Symptom | Likely area | Start in |
|---------|-------------|----------|
| Tree stale after external edit | Watcher / refresh | `extension.js`, `lib/state.js`, `refreshUi` |
| `L.` link won't resolve | fileId / definitions | `lib/dripnoteFileIdentity.js`, `lib/dripnoteReferenceDefinitions.js` |
| Index out of date | Index sync | `lib/dripnoteIndex.js`, `lib/dripnoteIndexSync.js` |
| Webview blank or stale | Message protocol | `lib/views.js`, relevant `*Webview.js` |
| Tag completion empty | Graph store | `lib/tagGraphStore.js`, `lib/dripnoteTagCompletion.js` |
| Unknown tag not underlined | Diagnostics | `lib/dripnoteMetadataDiagnostics*.js` |
| Slow activation | Activation events | `package.json` — avoid `*` |

---

## Run and logs

```powershell
# from vscode/ repo root
$env:VSCODE_SKIP_PRELAUNCH = "1"
.\scripts\code.bat
```

Extension Host: **Help → Toggle Developer Tools**

---

## Example opener

> Bug: [symptom]. Repro: … Expected: … Actual: … Log: … Find root cause, minimal fix, tell me what to test.
