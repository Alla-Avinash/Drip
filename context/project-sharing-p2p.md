# Project sharing (peer-to-peer)

## Big idea

A project can stay **solo** (only this machine) or become **shared** with other people.

- Sharing is **opt-in**.  
- Only that **project folder** is the shared world.  
- The rest of the knowledge base stays **private**.  
- There is **no central DRIP server** that holds your project for everyone.

How people join is **Project sharing**. How changes travel is **Project sync** (signed operations between peers).

## Solo vs shared

| Solo | Shared |
|------|--------|
| Default for new projects | After you explicitly **Share** |
| No network needed | Peers exchange operations while sharing is on |
| No member list | Members, roles, teams, invites |
| Folder name is enough locally | Stable hidden **project id** (survives renames) |

## Identity (Account)

**DRIP Settings → Account** is the one identity on this PC:

- unique id (stays on the machine)  
- guest **PC name** (seen when not on GitHub)  
- optional **GitHub** login — when signed in, others see `@login`  
- export / import **identity file** to move to another PC  

Sharing and joining use this same Account.

## How someone joins

1. Admin opens **Project Sharing**, shares the project, copies a **project invite**.  
2. Other person pastes it in **Join a Project** (or **Join new Project**).  
3. That is an **ask**, not automatic membership.  
4. Admin sees **Waiting to join**, picks **role + team(s)**, **Admit** or **Decline**.  
5. If a peer is reachable, the **entire project folder** downloads (features, notes, `_concepts` / `_decisions` / `_archive`, `.drip/` sidecar).  

Rotate the invite if too many people got it.

## Roles & teams (short)

- Roles such as **admin / member / updater / viewer** control who can invite, edit, or only view.  
- **Teams** group people; Project View can filter by **My Teams**, one team, or **None** (all issues).  
- Unassigned issues may not show under “My Teams.”

## How sync works (plain English)

Peers do **not** share a live typing session or one shared database.

They exchange **operations** (“create this issue”, “set status to in-progress”), each **signed**. Each machine:

1. Writes/applies the change to the **project files**  
2. Rebuilds **local** indexes / embeddings from those files  

**Local-only (never leave the machine as sync payload):** index rows, embeddings, drafts, secrets.

**Paths peers may use:**

- **LAN** when they can reach each other  
- **Internet relay** for encrypted transfer when needed  
- Optional **GitHub mailbox** as a drop for signed change logs — **not** “git merge the project as live multiplayer”

While DRIP is open and sharing is **on**, machines listen/hello so people show **online**. **Stop sharing** pauses send/receive on this machine; missed ops wait in the local log. **Start sharing** / **Reconnect** resume.

## Where to click

- **Settings → Project Sharing** — full controls for a selected project  
- **Settings → Join a Project** — paste invite  
- Project View **gear → Share settings** — jump to that project’s share UI  
- Project View header — sync status + online pill when shared  

## Rules of thumb

- Share when you need collaborators; keep personal notes outside that `.p`.  
- Admit carefully; rotate leaked invites.  
- Keep sharing on while actively collaborating.  
- Do not use whole-KB GitHub backup / git merge as a substitute for live share sync.
