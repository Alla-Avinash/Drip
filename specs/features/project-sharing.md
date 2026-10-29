# Feature: Project sharing

## What it is

A project can stay **solo** (one person, on this machine) or become **shared** with other people. Sharing is opt-in. Only that project folder is the shared world — the rest of the knowledge base stays private. There is no DRIP server and no central account.

How changes actually travel between people is **Project sync**. This file is who can see a project and how they join.

## How to access it

- **DRIP Settings → Account**: the one identity on this PC. While GitHub is signed in, people see only that GitHub name. After sign out, they see the guest PC name. The unique id stays on this machine. Sharing and joining use this same account.
- **DRIP Settings → Join a Project**: paste the **project invite** to **ask** to join a shared project. This is a section of its own (it shows who you will join as), separate from Project Sharing.
- **DRIP Settings → Project Sharing**: pick a project in the dropdown to see only that project’s share settings. Only an **admin** sees invite, rotate, mailbox, who-can-join, and the **Waiting to join** list. Admin, member, and updater all see their own **Stop sharing / Start sharing / Reconnect now** controls; a viewer sees none of those. Other roles see their teams and Leave. The account used is the one in Account.
- In the Project View, the header **gear** offers two choices: **Project metadata** or **Share settings**. Share settings opens that same Settings section with the current project already selected.
- **Join new Project** is also on the Project View list and the Projects sidebar. Those use the same Account.
- Once a project is shared and sharing is on, the Project View header shows a compact **"N online"** pill (not a list of names) plus a small sync status. Clicking the pill opens a **People / Teams** popover: People lists who is online and which teams they belong to; Teams lists each team with how many of its members are online. Names read `@login` for GitHub users and `#name` for guests. The Projects sidebar shows a green online count on the project folder. That badge is a file decoration — the Projects tree is not reloaded for presence, so the loading bar under that section does not appear. The count is refreshed every 30 seconds, or immediately when someone joins, is removed, or sharing is started or stopped. The tree only reloads when you create, delete, rename, or join a project.

## Solo vs shared

A new project is **solo**. Creating issues, features, and notes needs no network, no member list, and no extra workflow.

**Share this project** is the opt-in moment. Sharing uses the **DRIP** GitHub account already linked on this machine, or signs in once if none is linked. After that:

- The project gets a stable hidden **project id** that survives folder renames. Two people who each create a folder named `Research.p` have two different projects — the folder name is not the identity.
- You become the first **admin** and the **owner**. The owner is that GitHub account, not a local file. Other people see you as that GitHub name (`@login`). The project folder keeps the name you already gave it.
- A **sidecar** folder named `.drip/` is written inside the project folder so membership, tags, metadata overrides, and the change log travel with the project.
- Every existing issue, feature, concept, decision, and project note is stamped with a hidden unique id (see Project sync).
- From that moment sharing is **on**, every change is an operation, and background sync runs for this project only. The person who joins is announced to the others so their later changes are accepted. When DRIP opens a knowledge base, every shared project that still has sharing on starts listening right away — you do not have to open Share settings first. It uses the same listen port as last time and says hello to the people it already knows (this machine and the internet path), so a guest who is still sharing shows as online again without a new invite.

Other projects on the same machine can stay solo forever. Never pressing Share means nothing new runs.

## Peer identity

A **peer** is this PC’s guest identity, stored at user level (not inside a knowledge base). There is only one on the machine:

- a **unique id** that never changes when the PC name changes
- a **PC name** (the guest name other people see) — this can be changed in Account; spaces are turned into dashes so the name stays a single token for `@`/`#` mentions
- a **signing keypair** (Ed25519) used to sign operations, so other members can tell a change really came from this PC
- a separate **encryption keypair** (X25519) whose public half travels with the member record, used to seal chat room keys to that person (the signing key cannot encrypt)
- an optional **GitHub** login (at most one at a time)

PC names can collide. Members trust the unique id and the key for a guest, and the GitHub account for an owner or a GitHub-linked member.

The member list is who may send a change. How those people find each other, and how work hops through someone you never met, is **Project sync** (remembered addresses, hello, and folder snapshot when the log was folded).

**Account.** **DRIP Settings → Account** is the only place to manage this. Sign in with GitHub, sign out, or switch to another GitHub account. If GitHub was already used while sharing a project, it shows here. While signed in, the PC name is hidden so the GitHub name is the only name people see. Signing out of GitHub shows the guest PC name again. The unique id stays. Switching GitHub replaces the login; the unique id stays.

**Admin / owner.** Share uses the GitHub account already linked in Account. If none is linked yet, Share signs in once through the **DRIP** GitHub app (device login, profile only). That GitHub user is stored on the project as the owner. The sign-in token stays in VS Code Secret Storage.

**Guest.** A person who joins with an invite uses this PC’s guest name, or the GitHub already linked in Account. They do not create a second identity on this machine.

**Second machine (admin).** Sign in with the **same** GitHub account on that PC’s Account. That account is still the owner. A new local signing key is minted on that machine; other members accept “same GitHub owner, new key.”

**Move to another PC (identity file).** Anyone — including a guest with no GitHub — can move their identity to a second computer with an **identity file**. In **Account → Use on another PC**, **Export identity file** writes the whole identity (unique id, signing key, encryption key) to a `.json` file the user keeps private; on the new PC, **Import identity file** replaces that machine’s identity with it, so the same unique id and keys follow the person and old signed messages still check out. The export message points to the import step on the other PC. This is the guest path for moving machines; a GitHub-linked member or admin can simply sign in with the same GitHub account instead, which is the same person by account rather than by keys.

GitHub is who the admin is. Live sync does not need a repo. An optional **mailbox repo** on one shared project is a drop for that project’s signed change log only — see Project sync.

## The project sidecar

The sidecar lives at `<project>/.drip/` and is part of the project folder, not the knowledge-base index. It holds:

- the project id, member list, people waiting to be admitted, roles, teams (lead and who is on each team), the current **project invite** secret, and who may ask to join (GitHub only or guests too)
- the project's tag graph
- the project's metadata overrides (the extra status / priority / category values this project uses)
- the append-only operation log and the "how far we've seen each member" checkpoints
- last-known peer addresses (host and port from the invite or a hello), so the next change can be pushed without waiting for someone to open Share settings
- optional GitHub mailbox repo (`owner/repo`) for that project’s signed change log

Project tags and metadata overrides live here so they travel with the project. They are not stored under the knowledge-base `.dripindex/` sidecar — that location is machine-local and GitHub backup skips it.

The sidecar is hidden from the knowledge-base tree as ordinary notes. Resetting or rebuilding the index leaves the sidecar and the project files untouched, and must not strip hidden ids from those files.

## Invite, join, leave, remove

A **project invite** is a code that holds the project id, a **capability** (a secret that proves you were invited), the project name, and optional connection hints (`host:port`) when a member is listening. Knowing the invite is enough to **ask** to join — it is not enough to become a member. The admin admits each person and picks their role and teams. If too many people ask, the admin **rotates** the invite. The project id does not change. People already on the member list stay until an admin removes them.

**Join.** Paste the project invite in **DRIP Settings → Join a Project**, or use **Join new Project** on the Project View list or Projects sidebar. They join as the Account on this PC: GitHub if they are signed in (that name only), otherwise the guest **PC name**. A person who left or was removed can use a fresh invite the same way — the invite is the ask, not a closed door. The admin sees that name and whether they are GitHub or a guest. The project may be set to **GitHub users only** or to **also allow guests**. A guest is refused when the project is GitHub-only. If the invite is valid and a member is reachable, the **entire project folder** is downloaded — every feature, note, inbox, `_concepts`, `_decisions`, `_archive` (even when those folders are empty), and the `.drip/` sidecar — and they wait on **Waiting to join**. They are not a member until the admin admits them. Join never creates an empty project from just the name. A leftover empty stub with the same name is replaced by that download.

Reachable means: a direct address on the invite (same network, or this machine), **or** the public-internet relay if both people are online. The relay only carries an encrypted copy of the folder for a moment; it does not keep issues. GitHub is still only who the owner is, not how the folder travels.

If nobody answers, they import a **project export** (the whole `.p` folder). The invite proves they were allowed in; the export is only the files. The project then appears in the Projects section and in Project View.

When the request lands, the admin gets a short notice with that person’s name (GitHub or guest). The admin admits them and picks a role and at least one team. They can be on several teams. A guest who signed in with GitHub appears as that GitHub name; a guest who did not appears as their PC name.

**Roles.** Owner (GitHub admin who shared), plus a project role on each member: **admin**, **member**, **updater**, or **viewer**. The creator is the first admin and the owner. The admin picks the role when they admit someone, and can change it later. Only an admin can invite, admit, decline, remove, rotate the invite, create teams, and change who may ask to join. Start and stop sharing is local to each PC: an admin, member, or updater can pause or resume their own connection; a viewer cannot.

Roles do **not** hide the files on disk — anyone who joined still has the folder. They change which buttons work and which signed operations other machines accept. A viewer cannot talk or change fields. An updater can change status (and talk) but cannot create, move, or rewrite an issue. A member can do the usual issue work. An admin can additionally manage the project share settings. Everyone sees the whole project — the **Team** dropdown is a personal filter, not a visibility limit.

**Teams.** There is no default "Everyone" team. Every member belongs to at least one real team, which the admin picks when they admit the person. Sharing a project for the first time asks the admin to name the first team. An admin can add more teams and put people on several at once; a member cannot be left with no team (removing them from the project is a separate action). Deleting a team removes members who are not on any other team. Issues may be **unassigned** — the `team` field is optional. Teams are not folders — the issue’s `team` field is only a label. Feature folders stay where the file lives. In Project View the **Team** dropdown defaults to **My Teams** (this person's teams), lists each team, and has a **None** option for the whole project.

An issue's `team` value is indexed in its own `issue_teams` table in `projects.drip`, keyed by the issue number (`i-N`) rather than the issue's file location — so a project's team assignments stay in one clean table, well separated from the standard project data and never in the generic EAV metadata store.

When sharing starts, each note in the project folder gets sharing-only markers: a `fileuid` in the file header, a hidden `uid` on every issue, concept, and decision, and (once teams exist) a `team` label on issues. When sharing ends (leave / remove / convert to solo), the sidecar drops members and teams, and the same markers are stripped back out — `fileuid`, `uid`, and `team` are removed from the note files, and the project's `issue_teams` rows are deleted. A solo project therefore carries no team data and no hidden ids, leaving just the normal project database tables.

**Admin share settings.** An admin copies or rotates the project invite (that is how other people ask to connect — there is no “connect to someone” step). **Waiting to join** lists each request with the person’s name and whether they are GitHub or a guest. The admin picks a role and at least one team, then **Admit** or **Decline**. They see everyone already on the project — GitHub name when signed in, otherwise guest PC name, role, and who is online — and can **Remove** any other person. The **Teams** section shows each team with its current members as chips: a **×** on a chip removes that person from the team, and a **+** opens a search box to pick a project member to add to that team. The **People & access** section shows each person's teams as chips with a **×** to remove one, plus a **+** that opens a dropdown to add that person to another team. Removing someone is confirmed first. That person no longer gets updates. They are **not** blocked: they can ask again with a project invite, and the admin decides again. Another admin is removed one person at a time from that list. **Remove all guests** drops every guest at once and keeps GitHub members. **Who can join** chooses who may *ask* — GitHub users only, or also guests. Switching to GitHub-only does not kick people already on the project. An admin does not leave the project from this screen.

**Member / updater settings.** These roles do not see invite, rotate, mailbox, who-can-join, or the admit list. They see the teams they belong to, the people on those teams, **Leave**, and their own **Stop sharing / Start sharing / Reconnect now** controls. A **viewer** sees no sharing controls — they only receive changes — just their teams and **Leave**. Someone still waiting to be admitted sees that they are waiting.

**Stop sharing.** An **admin, member, or updater** can **Stop sharing** to go offline on this PC. The project stays shared and members stay. Half-typed headings and issues that were still waiting to be sent are dropped — they stay on this machine only. This machine then sends nothing new and does not apply anything that still arrives. If this project has a GitHub mailbox and this person changed something, Stop sharing saves the log there first and asks anyone still online to pull. Then this machine closes every live path. If there is no mailbox, Stop sharing offers a **change file**. **Start sharing** turns live sync back on. **Reconnect now** (admin, member, or updater) re-opens the LAN and internet paths and immediately says hello to remembered peers, so a machine that fell out of sync can catch up without toggling sharing off and on. If an admin removed someone while sharing was stopped, Start sharing tells them those people stay offline — they do not get a green online mark.

**Remove.** An admin removes a member. That person's older operations stay. New operations from them are rejected until they are admitted again. If they are online, their copy becomes a solo project on that PC. Their green online mark drops right away. They can ask again with a project invite; the admin admits them or declines. Names are not kept on a block list.

**Convert to solo (unshare).** An admin can convert the whole shared project back into a solo project — the reverse of Share. It sits in its own **Danger zone** card in Project Sharing. The admin confirms first. When they convert:

- The admin records a signed **close** operation and sends it to every member who is online right now. Each of those machines turns its copy into a solo project too, stops looking for peers, and is told the project closed.
- If the project has a GitHub mailbox, the close operation is saved there before the admin goes solo, so a member who is **offline** right now detaches the next time they pull the mailbox.
- The admin's own copy then becomes solo: a new project id, no members or teams, and the shared history (log and checkpoints) is cleared so a later re-share starts clean and never replays the close.
- A member who is offline **and** has no mailbox cannot be reached (there is nothing that can carry any change to them). Their copy stays shared but unreachable, shows everyone as offline, and they can leave it themselves.

**GitHub mailbox (recommended, not required).** In **Project Sharing** for that project, an admin can point at a private GitHub repo (`owner/repo`). That is optional. When it is set, it is the recommended way to stay up to date when people are not online together: DRIP pulls the signed log when the app opens, and pushes when the app is closed (or sharing is stopped) only if this person changed that project. It does not merge project files through git. People without a mailbox still use live sync and a change file.

**Leave.** A guest or other member can **Leave this project**. That is not Stop sharing. They keep a local solo copy with a **new** project id. They stop getting updates. The admin is told they left, and their name drops from members and teams. They can ask to join again later with a project invite.

**Last admin.** Cannot remove themselves until they pass admin to someone else.

## Copying and renaming

- Renaming the project folder does not change the project id. Tags and metadata stay with the sidecar inside the folder, so they no longer depend on the folder path.
- **Export this project** writes the whole `.p` folder (notes, `_concepts`, `_decisions`, `_archive`, and the `.drip/` sidecar) to a place the user picks — including those special folders when they are empty. **Import project** unpacks it into `.drip.project/`. A join snapshot does the same. If it is shared and they have an invite, they ask to join again; if they are already a member they rejoin. Otherwise it lands as a solo copy.

## Flow (plain steps)

1. User works in a solo project in the Projects section as usual.
2. User opens **Share this project**. If GitHub is already linked in Account, they become owner/admin immediately; otherwise they sign in once (and Account then shows that login). They are asked to name their first team, then they copy a project invite.
3. Another person pastes the invite in **Join a new project** (or Join new Project) and asks to join. The admin sees their GitHub or guest name, admits them, and picks a role and at least one team. The folder lands under `.drip.project` including `_concepts` and `_decisions`. The new project is added to the local project list right away.
4. Both people keep working; Project sync exchanges changes for this project only.
5. An admin can stop sharing to work offline, then start it again. A member can leave (solo copy) and later ask to join again. An admin can remove one person or all guests, and can allow guests or GitHub users only. Removed people are not blocked. Another admin is removed one at a time. The owner recovers a dead machine with the same GitHub account already linked — they are not asked to sign in again. An admin can convert the whole project back to solo; online members become solo right away, offline members with a mailbox become solo on their next pull, and offline members without a mailbox leave it themselves.

## Testing two people on one PC

Two ordinary editor windows are still one person — they share the same id and signing key. To pretend there is a guest, start **Run Extension (DRIP) — two peers**: the F5 window is the owner, and a second isolated editor is the guest with its own knowledge base. Keep the guest unsigned from GitHub. The full workflow is **Local two-peer testing**.
