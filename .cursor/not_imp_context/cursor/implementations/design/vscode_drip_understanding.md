# How the vscode-drip (Code-OSS) app works – beginner guide

This doc explains how the trimmed Electron app is structured and what to read to understand it. You’re new to Electron, so the first section is a quick Electron refresher; the rest is specific to this repo.

---

## 1. Electron in 3 sentences

- **Electron** = Chromium (browser) + Node.js. One process talks to the OS and creates windows; the rest runs inside browser-like windows.
- **Main process** (Node.js): runs first, has access to OS, files, and `app` / `BrowserWindow`. Only one.
- **Renderer process(es)** (Chromium): each window is a “web page” (HTML + JS). No direct Node/OS; they talk to the main process via IPC (inter-process communication).

So: main process starts the app and creates windows; each window loads an HTML file that runs your UI (the “workbench”).

---

## 2. How this application starts (big picture)

```
npm run electron
    → runs: node build/lib/electron.ts
        → (build compiles TS and runs the real entry)

Real entry when you run the built app:
    package.json "main": "./out/main.js"
        → src/main.ts (compiled to out/main.js)
            → Electron app starts
            → app.on('ready') → startup()
                → bootstrapESM()
                → import('./vs/code/electron-main/main.js')   ← "real" main process
                    → CodeApplication runs (src/vs/code/electron-main/app.ts)
                    → Creates window and loads workbench HTML

Window loads:
    workbench.html (src/vs/code/electron-browser/workbench/workbench.html)
        → <script src="./workbench.js">
            → workbench.ts runs in the renderer
                → Loads workbench.desktop.main.js (the whole UI)
                    → workbench.desktop.main.ts
                        → workbench.common.main.ts (shared UI)
                        → electron-browser/desktop.main.ts (desktop-specific)
                        → All workbench “contrib” (explorer, editor, tabs, etc.)
```

So:

1. **main.ts** = first script; sets up Electron (sandbox, paths, protocol), then loads the rest of the main process.
2. **vs/code/electron-main/main.ts** = VS Code’s main-process entry; wires services and starts **CodeApplication**.
3. **vs/code/electron-main/app.ts** = **CodeApplication**: creates the first window and decides what URL/file to load (the workbench).
4. **workbench.html** = the single “page” for the main window. It loads **workbench.js** (from workbench.ts).
5. **workbench.ts** (renderer) = runs in the window; loads the big workbench bundle (**workbench.desktop.main.js**).
6. **workbench.desktop.main.ts** = top-level workbench entry; pulls in common UI + desktop-specific services and all “contrib” (explorer, editor, etc.).

---

## 3. Important folders under `src/` (what to look at first)

| Folder | Role | What to look at first |
|--------|------|------------------------|
| **src/main.ts** | Very first entry; Electron setup only | Lines 1–100: imports, `app.on('ready')`, `startup()` and `import('./vs/code/electron-main/main.js')`. |
| **src/vs/code/** | App-specific code: how the app starts and how the window is set up | **electron-main/main.ts** (services, CodeApplication), **electron-main/app.ts** (window creation, what URL the window loads), **electron-browser/workbench/workbench.html** and **workbench.ts** (what runs in the window). |
| **src/vs/base/** | Shared utilities (strings, URI, events, async, DOM, etc.) | Skim **common/uri.ts**, **common/event.ts**; no need to go deep at first. |
| **src/vs/platform/** | Cross-cutting “platform” services (files, config, dialogs, state, etc.) | Used everywhere. When you see “platform/configuration” or “platform/files”, that’s here. Browse folder names; open files when you need to see how a service is used. |
| **src/vs/editor/** | Core text editor (Monaco) – cursor, model, view, commands | **editorCommon/** and **browser/** for “how is the editor built”. |
| **src/vs/workbench/** | The whole UI: layout, sidebar, panels, tabs, contributions | **workbench.desktop.main.ts** (entry), **workbench.common.main.ts** (shared), **browser/** (shell, layout), **contrib/** (explorer, editor, search, settings, etc.). This is “the app UI”. |
| **src/vscode-dts/** | TypeScript definitions for the extension API | Only needed when you work on the public API. |
| **build/** | Build and packaging (Gulp, Electron packaging) | **build/lib/electron.ts** (how the Electron app is built/run), **gulpfile.ts** (tasks). Use when you need to change build or run. |

So for “how does the app work?” focus on: **main.ts → vs/code/electron-main (main.ts, app.ts) → workbench.html / workbench.ts → workbench.desktop.main.ts**, then **vs/workbench/** for the actual UI.

---

## 4. Important components (by concern)

- **Window creation and what the window loads**  
  **vs/code/electron-main/app.ts** (CodeApplication): creates the BrowserWindow and loads the workbench (e.g. workbench.html or its compiled path). Search for “loadURL” or “loadFile” in that file (or in the path that app.ts calls) to see the exact URL.

- **The “page” the window shows**  
  **vs/code/electron-browser/workbench/workbench.html** and **workbench.ts**. Everything you see in the main window is bootstrapped from here.

- **The main UI entry (desktop)**  
  **vs/workbench/workbench.desktop.main.ts**: imports common workbench + desktop-specific services and contributions. This is the top of the UI stack.

- **Layout and shell**  
  **vs/workbench/browser/** (e.g. **workbench.ts**, **layout.ts**, **parts/**): shell, activity bar, sidebar, editor area, status bar.

- **Explorer (file tree)**  
  **vs/workbench/contrib/explorer/**: file/folder tree, “open folder”, etc.

- **Editor (tabs, open files)**  
  **vs/workbench/contrib/editor/**, **vs/editor/**: opening files, editor tabs, and the Monaco editor itself.

- **Extensions**  
  **extensions/** at repo root: built-in extensions (markdown, json, theme-defaults, etc.). They are loaded by the workbench and add features (language support, themes, etc.).

- **Product name and config**  
  **product.json** at repo root: app name, IDs, and other product-level settings read by the main process and workbench.

---

## 5. Suggested reading order (beginner)

1. **src/main.ts** – from top to `startup()` and the `import('./vs/code/electron-main/main.js')`.  
2. **src/vs/code/electron-main/main.ts** – short; see how it creates services and starts CodeApplication.  
3. **src/vs/code/electron-main/app.ts** – find where the window is created and what is loaded (workbench).  
4. **src/vs/code/electron-browser/workbench/workbench.html** and **workbench.ts** – what runs in that window.  
5. **src/vs/workbench/workbench.desktop.main.ts** – list of imports; see “common” vs “desktop” and “contrib”.  
6. **src/vs/workbench/contrib/explorer/** – one concrete “contrib” (file tree).  
7. **package.json** – scripts: `electron`, `compile`, `watch`; and `"main": "./out/main.js"`.

That order gives you: process startup → main process → window creation → renderer bootstrap → workbench entry → one UI piece (explorer) → how you run and build.

---

## 6. Run / build (reference)

- **Install deps:** `npm install` (in vscode-drip; postinstall compiles build scripts and runs npm in subfolders).
- **Compile:** `npm run compile` (Gulp compiles TypeScript to `out/`).
- **Run:** `npm run electron` (runs the app; uses compiled `out/main.js` and the workbench bundle).
- **Develop with watch:** `npm run watch` (recompiles on changes; then run with `npm run electron` in another terminal).

The “main” process entry for the running app is **out/main.js** (from **src/main.ts**). The window loads the workbench HTML/JS produced by the build from **vs/code/electron-browser/workbench/** and **vs/workbench/**.

---

## 7. Summary diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  MAIN PROCESS (Node.js, one process)                            │
│  src/main.ts → vs/code/electron-main/main.ts → app.ts            │
│  - Creates window                                                │
│  - Loads workbench.html (or built equivalent)                    │
│  - Handles IPC, menus, dialogs, file system, etc.                │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            │  one window
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  RENDERER (Chromium, per window)                                 │
│  workbench.html → workbench.js → workbench.desktop.main.js       │
│  - vs/workbench: shell, explorer, editor, tabs, extensions       │
│  - vs/editor: Monaco editor                                     │
│  - vs/platform: config, files, state (used from renderer)       │
└─────────────────────────────────────────────────────────────────┘
```

Use this file as a map: start from **main.ts** and **vs/code/electron-main**, then follow the “what the window loads” into **workbench** and **contrib**. For DRIP, you’ll later change or add “contrib” pieces (e.g. ingestion, retrieval, tasks) and possibly the workbench shell; the flow above stays the same.
