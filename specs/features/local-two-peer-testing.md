# Feature: Local two-peer testing

## What it is

A developer workflow for pretending two people are using DRIP on **one computer**. One window is the owner (Peer A). A second, fully isolated editor is the guest (Peer B). They talk over this machine's own network, so you can watch a share, a join, and a sync without a second PC.

This is only for local testing. Real members still each have their own computer.

## How to access it

In the Run and Debug list:

- **Run Extension (DRIP)** — Peer A (the usual F5 window).
- **Run Extension (DRIP) — Peer B (isolated)** — starts the second person.
- **Run Extension (DRIP) — two peers** — starts both in one click.

You can also run the Peer B task **Launch Peer B (isolated instance)**, or `npm run launch:peer-b`.

Start this from the **VS Code** window that has the DRIP extension folder open — not from Cursor. Peer B starts `Code.exe` directly (it does not use the `code` command, because Cursor often steals that name). If VS Code is installed in an unusual place, set `VSCODE_EXE` to your `Code.exe` path. A new window titled **Extension Development Host** should appear.

## Why a second window is not enough

DRIP's "who I am" lives in the editor's profile storage, not in the project folder:

- the public id and name live in profile state
- the private signing key lives in Secret Storage

Two ordinary windows of the same editor are still **one person**. They share the same id and the same key. Sharing a project with yourself this way does not test membership, invites, or signed operations.

A named editor **profile** (the kind you pick in the editor UI) splits settings and public state, but Secret Storage is still one vault for the whole app. The guest window would mint a new key and overwrite the owner's. That is why this workflow does **not** use a second profile.

## Why a second app instance works

Peer B is a **separate editor process** with its own user-data folder and its own extensions folder. That folder is the whole sandbox: settings, profile state, Secret Storage, and UI layout. The first time it starts, DRIP creates a new guest identity. The owner identity in the F5 window is untouched.

Both windows still load the same DRIP source (the extension under development). Code changes appear in both after a reload. Only the *person* and the *knowledge base* are different.

The F5 Extension Host cannot take a custom user-data folder — the editor ignores that flag in a debug launch. So Peer A stays the normal debug window, and Peer B is started as a real second app.

## Two knowledge bases

Each person needs their own `.driplock` folder. If both windows pointed at the same folder they would fight over the same notes and the same local index.

The Peer B launch creates two empty test folders (ignored by git):

- Peer A knowledge base — pick this in the F5 window
- Peer B knowledge base — pick this in the isolated window

Do not open the DRIP source folder as a knowledge base.

## What each launch does

**Peer A (F5).** Builds the webview assets, then opens the Extension Development Host with your normal identity. Debug as usual. In DRIP, select the Peer A knowledge base.

**Peer B (isolated).** Builds the webview assets if needed, creates the sandbox folders, and starts a second **VS Code** via `Code.exe` (never Cursor, never the `code` PATH shim) that:

- uses the isolated user-data and extensions folders
- loads this same DRIP source
- opens an empty window folder (not the source repo)
- skips the welcome page and the workspace-trust prompt

The first launch looks like a fresh install. Select the Peer B knowledge base. Leave GitHub unsigned so this window stays a guest.

**Two peers.** Starts A, then B. Stopping debug on A does not close B.

## Flow (plain steps)

1. Start **two peers** (or start A, then B).
2. In A: select the Peer A knowledge base → create a project → Share (GitHub sign-in is required for the owner) → copy the invite. Sharing starts A's listener.
3. In A, copy a **fresh** invite while sharing is on. In B: select the Peer B knowledge base → stay a guest → **Join new Project** → paste the invite. B downloads the **whole** project folder (features, notes, sidecar). A leftover empty stub with the same name is replaced. If the two windows cannot see each other on LAN, the download still goes through the internet relay as long as both PCs are online.
4. A gets a notice that B joined, and Share settings lists B with a Remove action. Both Projects sidebars show a green online count (no loading bar under Projects; the count is not refreshed every few seconds). Create an issue in A; confirm it appears in B. In B, assign an inbox issue to a feature; confirm the same issue moves into that feature on A. The Project View header shows the members and who is online.
5. In A (the admin), **Stop sharing** — live connections drop. Edit in A while stopped, then **Start sharing** in A and confirm B receives the missing change.
6. Optional: create the same new issue number on both while B is stopped, then reconnect and confirm one display key is reminted.

If the join cannot reach A, allow the editor through Windows Firewall on a private network. The invite already carries this machine's LAN address and a random port — two instances on one PC do not collide, because each listener picks its own port.

## What this does not replace

- A dropped-connection test on a real second device (NAT, a different clock, a real firewall).
- Automated replay of the operation log. The sync rules are still verified by watching the two windows.

## How teams that ship this kind of product test it

They layer three kinds of test. This workflow is the middle one.

**1. Two fake members in one process.** No editor. Two in-memory "people" push the same operations at each other and check that both folders end up identical (same remint, same last-write-wins). Linear-style clients, Automerge, and Yjs lean on this for conflict rules. Fast, no UI. DRIP does not ship these yet — the user verifies by hand.

**2. Two isolated app instances on one machine.** Each instance has its own user-data folder, so each is a different account. This is the usual Electron / VS Code pattern (VS Code Live Share, Slack desktop, and Microsoft's official extension-test runner all do this). It is what the Peer B launch is. It catches identity, invite, snapshot join, and live gap-exchange.

**3. Two real devices, two VMs, or two OS users.** Used before a sharing release. Catches networks the same PC cannot show.

Products with a **central server** (Linear, Jira, Notion) instead create two test accounts against a staging backend. DRIP has no server, so that path does not exist here — the two local people *are* the system.

A named editor profile is the right tool for "try DRIP with a clean settings set." It is the wrong tool for "try DRIP as a second person."
