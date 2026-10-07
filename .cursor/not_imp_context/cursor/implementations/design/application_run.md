# DRIP / vscode-drip – Application Run (Windows-only)

## Goal
Run your trimmed `vscode-drip` (Code-OSS) Electron app on **Windows** so you can:
1. Confirm the UI boots.
2. Identify any build/runtime errors quickly.
3. Learn which parts are still needed after trimming.

This is written for a beginner (Electron / Code-OSS). You can follow step-by-step and stop whenever you hit an error.

---

## Important note about your current trimming (based on current repo state)
1. `vscode-drip/product.json` currently has:
   - `builtInExtensions: []`
2. That means “built-in extensions” downloading/installation may be empty, so language features (markdown rendering, JSON features, etc.) might not be present.
3. The core workbench UI should still load, but expect missing extension-based features until `builtInExtensions` is configured to load your kept extensions.

If the app fails early: the first thing to check is missing required files referenced by the build scripts (common ones are license/notice files and extension definitions).

---

## What you do next (steps)

### Step 1: Open the correct folder
Make sure the active Cursor/VScode workspace is the folder:
`vscode-drip/`

### Step 2: Install dependencies (choose one approach)
You have two options; pick the one that matches how much you want automation.

Option A (manual, explicit):
1. Go to `vscode-drip/`
2. Run `npm install` or `npm ci`
3. Then run the build/launch steps below.

Option B (uses repo script to prepare):
1. Run `node build/lib/preLaunch.ts`
   - This script ensures `node_modules` exist
   - It ensures `out/` exists (compiles if needed)
   - It also runs built-in extension sync (may be a no-op if `builtInExtensions: []`)

If you want, you can start with Option A so you can control where failures happen.

### Step 3: Compile
Build output is expected under:
`vscode-drip/out/`
Run:
- `npm run compile`

### Step 4: Launch Electron app
Run:
- `npm run electron`

### Step 5: If you see errors
Copy/paste the **first error block** (the stack trace top) and the line that mentions:
- missing files (e.g. `LICENSE.txt`, `ThirdPartyNotices.txt`)
- missing/failed extension installation
- “module not found” or “cannot find package”

We’ll map that error back to the exact build file that triggered it.

---

## What is required in `vscode-drip/build/` (and why it matters)
For running on Windows, the `build/` folder is the orchestration layer:
it compiles TypeScript, bundles UI, and launches Electron.

Here are the key files that matter for a beginner (high level):

1. **`build/lib/electron.ts`**
   - Entry for the Electron build/run flow.
   - Used by the `npm run electron` script in `package.json`.
2. **`build/lib/preLaunch.ts`**
   - “Prep” script used by `smoketest`.
   - Ensures `node_modules` are installed (runs `npm ci` if missing).
   - Ensures the project is compiled by checking `out/`.
   - Triggers built-in extension sync (may be empty in your trimmed version).
3. **`build/lib/builtInExtensions.ts`**
   - Downloads/syncs built-in extensions into `.build/builtInExtensions`.
   - Reads `product.json.builtInExtensions`.
   - If you keep `builtInExtensions: []`, this likely does little.
4. **`build/lib/builtInExtensionsCG.ts`**
   - Downloads additional “component data” used by VS Code’s webview/UI machinery.
5. **`build/npm/preinstall.ts` / `build/npm/postinstall.ts`**
   - These scripts run during `npm install` to install dependencies in multiple subdirectories.
   - `postinstall.ts` also coordinates a lot of build state after dependency installs.
6. **`build/npm/dirs.ts`**
   - The list of subfolders where npm will install dependencies.
   - You trimmed this so it no longer references deleted `test/` folders.
7. **`build/filters.ts`**
   - Influences linting/formatting filters used by build tooling.

If you want to keep things simple and Windows-only, you typically **don’t delete** these files. Instead, you trim inputs that they depend on (extensions, builtInExtensions definitions, etc.).

---

## Quick “error checklist” (what to look for first)
When something fails, identify which category it is:

1. **Cannot find file** (examples: `LICENSE.txt`, `ThirdPartyNotices.txt`)
   - Usually missing files referenced by `build/gulpfile.*`
2. **Built-in extension sync failures**
   - Likely connected to `product.json.builtInExtensions`
3. **TypeScript compile failures**
   - Usually means build config references something you deleted
4. **Electron startup errors**
   - Usually means `out/` bundle missing or Electron main entry failed

---

## Next action from you
Tell me:
1. Do you want to start with **Option A** (manual) or **Option B** (`preLaunch.ts`)?
2. If you hit an error, paste the top stack trace.

Once you answer, I’ll guide you through the minimum set of edits needed to get a successful boot.

