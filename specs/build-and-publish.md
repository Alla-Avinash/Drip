# DRIP — build & publish to the Marketplace

## What this is

A GitHub Actions workflow that builds DRIP once per platform and publishes it to the VS Code Marketplace. It runs on GitHub's servers, so the developer never has to build each OS on their own machine.

## Why it's needed

DRIP depends on `better-sqlite3`, a native module. `better-sqlite3` v13 is a **N-API** addon, so its compiled binary is ABI-stable: the prebuilt binary the npm package ships (in `prebuilds/`) loads in VS Code's Electron without being recompiled. The same `.vsix` still cannot run on a different OS (the binary is per-OS), so each platform (Windows, macOS Intel, macOS Apple Silicon, Linux) is still built separately on its own machine — but there is no rebuild-against-Electron step.

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
2. Dependencies install (`npm ci`), which puts `better-sqlite3`'s ABI-stable prebuilt binary at `node_modules/better-sqlite3/prebuilds/`.
3. The webview assets (Settings, Tags, `.d.md` editor) are bundled into `dist/`.
4. Dev-only dependencies are pruned so the package stays small.
5. The platform package is published to the Marketplace.

These things must **not** happen, or the extension breaks at runtime:

- Do **not** rebuild `better-sqlite3` against Electron. It is a N-API addon, so the shipped prebuilt binary already works; and `better-sqlite3`'s own build script is a no-op when a prebuild is present (it compiles `type: none` and produces no binary).
- Do **not** delete `prebuilds/`. That deletes the only working binary.
- Do **not** use `--no-dependencies` on the publish. That skips packaging `node_modules` entirely, so the extension fails with `Cannot find module 'better-sqlite3'`.

## Upgrading `better-sqlite3`

Because it is N-API, `better-sqlite3` does not break when VS Code ships a new Electron — the prebuilt binary keeps loading. When the dependency itself is upgraded (`npm install better-sqlite3@latest`), just re-publish:

1. Bump `version` in `package.json` (the Marketplace rejects a republish of the same version).
2. Re-publish: **Actions → Publish to Marketplace → Run workflow**, or push a `v*` tag.

## Secrets

- `VSCE_PAT` — a Personal Access Token from the publisher's Azure DevOps account with **Marketplace → Manage** scope. Set once in **GitHub repo → Settings → Secrets and variables → Actions**.

## When a run fails

- The summary "Node.js 20 is deprecated" and "runner queue" messages are harmless warnings, not errors.
- The real error is always in the single step marked with a red ✕ — open that step and read its text.
- Common causes: version already published (bump `version` in `package.json`), or `better-sqlite3`'s prebuilt binary was deleted/not packaged (keep `prebuilds/`, don't use `--no-dependencies`).
