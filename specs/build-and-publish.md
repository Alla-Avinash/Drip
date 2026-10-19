# DRIP — build & publish to the Marketplace

## What this is

A GitHub Actions workflow that builds DRIP once per platform and publishes it to the VS Code Marketplace. It runs on GitHub's servers, so the developer never has to build each OS on their own machine.

## Why it's needed

DRIP depends on `better-sqlite3`, a native module. A native module is compiled code that must be built against the exact Electron version VS Code ships — not system Node. The same `.vsix` cannot run on a different OS, so each platform (Windows, macOS Intel, macOS Apple Silicon, Linux) must be built separately on its own machine.

## How to trigger it

- Open the repo on GitHub → **Actions → Publish to Marketplace → Run workflow** (manual), or
- push a tag starting with `v` (e.g. `v0.0.2`), which triggers it automatically.

## Platforms it builds

- `win32-x64` — Windows 64-bit
- `darwin-x64` — macOS Intel
- `darwin-arm64` — macOS Apple Silicon (M1/M2/M3)
- `linux-x64` — Linux 64-bit

There is no 32-bit build (VS Code dropped 32-bit support). Windows-ARM and Linux-ARM are omitted as rare/non-desktop targets.

## What happens, step by step

1. Each platform runs on its own fresh GitHub machine (a "matrix" job), one after another so the Marketplace never gets two publishes of the same version at once.
2. Dependencies install.
3. The webview assets (Settings, Tags, `.d.md` editor) are bundled into `dist/`.
4. `better-sqlite3` is rebuilt against VS Code's Electron, using the version in `.electron-version` (the single source of truth).
5. The package's own prebuilt binary is deleted, forcing it to use the freshly rebuilt one.
6. Dev-only dependencies are pruned so the package stays small.
7. The platform package is published to the Marketplace. The publish must **not** use `--no-dependencies`: production dependencies (including the rebuilt `better-sqlite3`) ship inside the `.vsix` from `node_modules`, so skipping dependency detection drops them and the extension fails to load at runtime with `Cannot find module 'better-sqlite3'`.

## Rebuilding for a new VS Code release

VS Code auto-updates users to a new Electron every few releases, which changes the ABI of `better-sqlite3` and breaks the published extension. To ship a fixed build:

1. Find the new Electron version — in VS Code, **Help → About** and read the `Electron:` line (e.g. `44.0.0`), or check the VS Code release notes for the Electron it ships.
2. Update `.electron-version` (repo root) with the new version.
3. Bump `version` in `package.json` (the Marketplace rejects a republish of the same version).
4. Re-publish: **Actions → Publish to Marketplace → Run workflow**, or push a `v*` tag.

For local development (F5 / Code OSS), rebuild the native binary against the local VS Code with:

```
npm run rebuild:native
```

This reads `.electron-version` by default; pass an explicit version with `npm run rebuild:native -- 44.0.0`. Reload the window afterwards.

## Secrets

- `VSCE_PAT` — a Personal Access Token from the publisher's Azure DevOps account with **Marketplace → Manage** scope. Set once in **GitHub repo → Settings → Secrets and variables → Actions**.

## When a run fails

- The summary "Node.js 20 is deprecated" and "runner queue" messages are harmless warnings, not errors.
- The real error is always in the single step marked with a red ✕ — open that step and read its text.
- Common causes: version already published (bump `version` in `package.json`), or VS Code ships a new Electron (update the `ELECTRON_VERSION` in the workflow).
