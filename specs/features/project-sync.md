# Feature: Project sync

## What it is

The engine that keeps a **shared** project folder the same for every member. It does not run on solo projects.

People do not share a live typing session, a workspace, or a database. They exchange **operations** — discrete, signed changes such as "create this issue in this file" or "set status to in-progress". Each operation is applied to the project files (all or nothing). The two local indexes are then rebuilt from those files. Index rows, embeddings, drafts, and secrets never leave the machine.

Who can see a project, and how they join, is **Project sharing**.

## How to access it

- Mostly background: while DRIP is open and sharing is on, a shared project notices online members and exchanges the changes each person is missing. After a restart it listens on the same port as last time and says hello to remembered people, so they show as online again without a new invite. An admin’s **Stop sharing** (in Project Sharing settings) pauses that: this machine goes offline and does not send or receive, even if you keep editing. **Start sharing** resumes. Missed edits wait in the local log.
- When DRIP opens a knowledge base, every shared project that still has sharing on starts listening right away. You do not have to open Share settings first.
- The Project View header shows a small status: synced / syncing / waiting for a peer / could not connect.
- Shared projects that are sharing-on show a green online count on the Projects sidebar folder. That badge is a decoration — the Projects list is not reloaded for presence, so the loading bar under that section does not appear. The count updates every 30 seconds, or immediately when someone joins, is removed, or sharing is started or stopped. The list only reloads when you create, delete, rename, or join a project.
- **Join new Project** downloads the **entire** project folder from a reachable member (every file inside the `.p` folder, including features and the sidecar). If every address on the invite fails, it also tries this machine. Only when nobody answers does it ask for a **project export**. See Project sharing.

## What travels

The whole project folder is the unit:

- the project index, `_issues.d.txt`, feature folders and files, feature inboxes, notes inside features, `_concepts`, `_decisions`, `_archive`
- the `.drip/` sidecar (project id, members, tags, metadata overrides, operation log, checkpoints, last-known peer addresses)

Nothing else in the knowledge base is part of this project.

## How a change travels (the engine)

There is **one changelog per project**, not a separate admin log and file log. Every member’s changes land in that same list. The **project files** are the long-term record. The log is only a **short recent queue**.

Each person numbers **their own** changes (1, 2, 3…). Everyone remembers “I have up to number N from this person.” When two people connect they compare those numbers and **append** only the missing slice. They do not rebuild or re-sort a shared history. A change with the same id twice is skipped.

Time is **not** used to mix the log into one timeline. Time is used only when two people did the **same kind of thing** on the same item (same field, or two creates that both asked for `i-12`): earlier write wins, then peer id if the clocks are close. Clocks can be a few minutes off; both sides still agree because they use the same rule.

**Reprint has no clock.** It runs once, immediately, when a change is applied. The waits that *do* exist are different jobs: a few seconds after you stop editing so title / fields / body become one operation; about 80 log lines and at most once every two minutes for an admin fold; every 30 seconds for the green online count.

This is the live path, in order:

1. **Write locally first.** Project View, the editor (on save), or MCP writes the issue (or other change) into the file the person is actually editing.
2. **Record one operation.** That write is also appended to this project's log: who did it, a unique operation id, a sequence number for this person, a time, a payload, and a signature. A create names the file it was written in (relative to the project folder). A move names the destination. A join announces the new member so later changes from them are accepted.
3. **Push to remembered peers.** The invite stores a host and port when someone is listening (including this machine). After join, that address is remembered on the project. A new operation is pushed there immediately. A short hello also pulls anything this machine is missing. Those addresses survive a reload.
4. **Internet relay as backup.** If a direct address cannot be opened (two home networks, a firewall, or two windows that cannot see each other's LAN IP), the same operations go through a public **relay** as short-lived encrypted packets. The relay never stores issues and cannot read the folder — the invite secret encrypts the payload.
5. **Apply on the other machine.** The other peer checks the author is still a member, skips a duplicate id, writes the same file, **reprints** that file into a strict shape, then refreshes the local index and Project View. The Projects sidebar is not reloaded for this.

If nobody is reachable, the change stays in the local log until a member is online again.

**GitHub mailbox (optional per project).** A private GitHub repo can hold that project’s **signed operations log** — not the issue files, and not a git merge. When an admin sets `owner/repo` on that project, this is the recommended catch-up path: open DRIP → pull the mailbox → apply missing operations through the same reprint engine. Leave DRIP (or stop sharing) → if this person changed that project, push the log once, then tell anyone still online to pull. A few pulls and pushes a day stay far under GitHub limits. A project with no mailbox never talks to GitHub for sync.

A body / title / field edit on the same issue becomes **one** operation after you stop typing for a few seconds, not three operations and not on every keystroke.

## What each operation does

These are the operations the engine records and applies to files:

- **Create an issue** — write a new issue block into the **named file** (the feature note, feature mailbox, or project inbox the person actually wrote in). The payload carries the title, parent, status and other fields, the body, and the **section path** it sits under (plain or persistent headings, e.g. `Notes/This week`). A new issue waits a few seconds of no further typing before it is sent, so a half-written title from the heading form is not copied to other people. Further keystrokes fold into that same create. The other machine writes that same file, under that same section. If that file is missing, it first asks a live member for that one file; if nobody answers, it creates the folders and the file from the change, including any missing section headings. Only an older change that names no file uses `_issues.d.txt`.
- **Update an issue** — one operation for that save session: title, fields (status, priority, parent, …), and body together. The other machine applies them in one go. A burst of saves on the same issue waits a few seconds and is sent as one update, so sync stays light. Older single-field / title / body operations still apply if they arrive.
- **Set a field / title / parent** — kept so an older change can still land. New edits use **Update an issue**.
- **Set the body** — kept for older changes. New body edits ride on **Update an issue**.
- **Move / assign** — cut the issue block from its current file and put it in the destination (feature mailbox, project inbox, under a heading, or the project `_archive` after 3 days completed). Typing an existing issue under a different section and saving is the same kind of move (the section path travels). Inbox children of a parent follow only when that parent is assigned to a feature; children already in another feature stay there. Each child that moves is its own operation. An archive move names the archive file so both machines write the same `done-N` note.
- **Delete an issue** — remove that issue block from the file it lives in (heading form delete, or deleting the heading and saving).
- **Create a feature / note / concept / decision** — write the new file (and the feature folder when it is a folder feature) at the same relative path, with the same starting text.
- **Update a concept / decision** — one operation for that save of a note in `_concepts` or `_decisions`: the whole current file text (title, fields, and body). A burst of saves waits a few seconds, same as an issue edit. The other machine writes that same file. If a `c-N` / `d-N` number is already used by a different hidden id, it is reminted.
- **Update the project / feature index** — one operation for that save of the project index note (`_Name.p.d.txt` / `.md`) or feature index note (`_Name.f.d.txt` / `.md`): the whole current file text (the `# .p` / `# .f` heading, its fields, and any prose under it). A burst of saves waits a few seconds, same as an issue edit. The other machine writes that same file.
- **Delete a concept / decision** — remove that note from `_concepts` or `_decisions`.
- **Set a heading body** — one operation for a section in a feature (or other project) note: the heading path (plain or persistent) and the prose written **under that heading**, not under its child headings or issues. A new heading and a later edit of that heading both wait a few seconds of no further typing before they are sent, so a title still being typed in the heading form is not copied as extra junk sections. If that half-written title is changed or removed before the wait ends, nothing is sent for the old wording. The other machine creates the section if it is missing, then writes that prose. An empty body does not wipe prose that is already under that heading (a new heading with no text yet must not erase typing that landed first). A change that lands from another person is remembered locally so this machine does not send the same heading back.
- **Delete a heading** — remove that section title and its own prose after the same short wait. If the heading was never sent (still being typed), the delete is dropped and nothing goes out. Child headings stay. Issues deleted with the section are their own delete operations.
- **Tags / metadata** — update the project’s sidecar tag graph or metadata overrides.
- **Member accept / admit / remove / share / leave / join policy** — an invite is a request. Accept records the person as waiting. Admit (admin only) makes them a member with the role and teams the admin picked. Remove and leave drop them from the member list; they are not blocked and can ask again with an invite. A guest is refused only when the project is GitHub-only.
- **Teams and roles** — create/rename a team, set its people, or change a member’s role. Deleting a team also removes members left with no other team. Only an admin’s signed change is accepted.
- **Talk** — append or clear a short scratch room (one issue, one team, or the project). Useful text is saved onto the issue note as a normal issue update, then the room is cleared. Talk is not folded into the long-term file history.
- **Fold the log** — an admin checkpoint. Old changelog lines are dropped; the current folder is now the history. See “Keeping the changelog short”.

A signed change whose author does not have that role is refused. The files on disk can still be edited by hand — that is the peer-folder limit. See Project sharing.

An operation type this version does not understand is kept in the log and not applied. The person sees that they need to update DRIP to see that change. An operation from a removed member, *after* the remove, is rejected. Older operations from them stay.

Receiving the same operation twice is a no-op (the id makes it **idempotent**).

The durable log *is* the queue for recent changes. A dropped connection does not rely on an in-memory resend list. On reconnect the two people compare how far they have each got and send only the gap — or the current folder, if that gap was folded away.

## Placement rule

**If it was created in a particular file, it stays in that file** until someone assigns or moves it.

- Typed into a feature note, under a section → both peers write that feature note, under that same section path. The file heading (`# .f feat-1`) is the file, not a section — issues next to it stay `# .i-N` siblings, not nested `#1` children. A previous issue is a sibling, not a path crumb. If the file is not on the other machine yet, they create it (or copy that one file from a live member) instead of dropping the issue in the project inbox.
- Created in a feature mailbox → both peers write that mailbox.
- Created from Project View / MCP as a project issue → both peers write `_issues.d.txt`.

The other machine never "helpfully" puts a new issue in the project inbox just because that file is the usual mailbox.

## Reprint (same text on every peer)

After an operation is applied, the touched file is **reprinted** (repainted) into a strict shape so every peer writes the same bytes from the same operations. Reprint is not on a timer — it runs once when that change lands. Placement is never by line number — that is how two creates in the same file do not fight.

Reprint does this, in order:

1. **Unix line breaks** — one kind of newline, so Windows and Mac do not drift.
2. **Hidden file uid** — if the file header is missing a stable file identity, one is filled in. An existing one is kept.
3. **Heading ids** — `@hN` is the same number on every peer. The person who created the heading sends that number; the other machine writes that same `@hN` and does not pick a new one. Existing ids are never reminted. An `@hN` line is kept on the line immediately above its heading, at the same indent. A leftover `@hN` with no heading under it is dropped. The file heading stays `@h0` and stays first. Markdown project notes skip this step (their identity lives in the hidden comment).
4. **Same heading order everywhere** — every heading in the file, not only the inbox, is ordered by hidden unique id. Nested children stay under their parent. A heading with no id keeps its place among its siblings. When a heading is indented, its `@hN` line moves with it. An issue that was wrongly nested under the file heading is lifted back to a root sibling. An empty heading that only copied an issue title is dropped.
5. **One blank line between headings** — extra blank lines are collapsed so the file does not grow differently on each machine. There is never a blank line between a heading and its `@hN`.

When the file is open, a change is applied on top of what is on screen (including typing that is not saved yet), then reprint writes through the editor and saves, so the last heading and the end of the page are not wiped by a reprint that only knew the last saved copy. If that note still has unsaved typing, a catch-up folder snapshot leaves it alone and updates the other files. A catch-up snapshot never deletes the folder out from under the editor.

Reprint **never moves an issue into another file**. A sub-issue that lives in the project inbox stays there even if its parent lives in a feature. Moving is a separate assign/move operation.

A note that contains both issues and ordinary prose is updated **per heading**. The whole file is never last-write-wins — that would clobber issue operations.

Other project notes get the same reprint when they are stamped at Share. After a project is shared, reconcile does not rewrite those files; reprint (from an operation) is the writer. Solo projects still get the full file repair.

## Hidden unique id vs display key

Each issue, feature, concept, decision, and project file has two identities:

- a **hidden unique id** that never changes and is what operations and parent links use internally
- a visible Linear-style **display key** (`i-12`, `f-3`, and later `c-N` / `d-N`)

The file still *shows* `parent: i-12` so the text stays readable. A remint rewrites those visible numbers by following the hidden id, so the link does not jump to the wrong issue.

**Project files are their own world for `@fN`.** Each project has its own file-id sequence (first note is `@f0`, then `@f1`, …). That number is written in the file and remembered in the project's sidecar. A knowledge-base note may also be `@f0` — that does not change the project file. Reconcile and rebuild never remint a project file's `@fN` just because the same number is already used in this knowledge base. The local index may store a different row id for that note so the two worlds do not collide; that local row id is never written back into the file. Each project's heading-number pot is also separate, so two `@f0` files in different projects do not share heading ids.

**Once a project is shared, deleted display keys are never reused.** Solo projects can still reuse the highest deleted number. Reuse across peers is how two different issues both think they are `i-10`.

Concept and decision numbers are stamped with the same hidden-id + remint rules when those numbers are minted.

## Remint (same display key, two different things)

If two people both create an issue offline, both would request `i-12`. On sync:

1. Sort the two creates by time, then by peer id.
2. The earlier one keeps `i-12`.
3. The later one becomes one past the highest known number (e.g. `i-15`).
4. Both peers compute the same result from the same set of operations, so they do not argue.
5. The person whose number changed sees a quiet notice once: this issue is now `i-15` because someone else had already used `i-12` offline.

The same rule applies to `f-N` and, when they are stamped, `c-N` / `d-N`.

Clocks can be a few minutes off; the "earlier" winner can be slightly wrong. That is accepted — the rule stays simple and both sides still agree.

If two people create a feature folder with the same name, both folders are kept. The later folder gets a suffix. The `f-N` remint is a separate rule from the folder name.

## Who you know (not a global network map)

You do **not** discover every machine on the internet. You only talk to people this project already listed as members, at addresses this machine already remembered.

- **Who is allowed to send a change** — the member list in the project (GitHub name or guest PC). A change from someone not on that list is refused.
- **Where to knock** — last-known addresses: this machine, the invite host and port, later hellos, and the encrypted internet relay. Those addresses live in the project sidecar and survive a reload.
- **Who shows as online** — current members who said hello to *this* machine recently (the green count). A removed guest or member is dropped from that count immediately and is not marked online again. That is not a worldwide roster. If A never talks to C, A does not show C as live.

Work still reaches people you never met, because it rides in **someone you did meet**. If B already applied C’s changes, those changes are in B’s files and (until folded) in B’s log. When A meets B, A gets C’s missing slice from B — or B’s current folder if that slice was folded away. No extra gossip protocol. The group is only as connected as the people who actually say hello to each other.

A hello also carries this machine’s **recent** local changes (a short tail of this log, not the whole history). The other side applies those first, then replies with either the missing operations or a folder snapshot.

## Catch-up and new joiners

Each member remembers, per project, the last change number they have **from every other member**. When two members connect they only send the missing slice.

**New joiner.** Do not replay thousands of operations. Send a **snapshot** (the current project tree plus the sidecar), then only operations after that snapshot. After the folder lands, this machine indexes it so Project View and the Settings **Select project** dropdown show it immediately, already selected.

**Long-lost peer.** They come back and say hello to whoever they can still reach. If that person’s log still has the missing slice, they get **operations** and apply them onto their own files (same conflict rules as live sync). If that slice was folded away, they get a **folder snapshot** from the person they reached — after that person first applied the long-lost peer’s recent local changes, so those last edits are not wiped.

The engine does **not** vote on “which group has the newest tree.” It only asks: can this person still replay the changelog numbers I am missing? Yes → operations. No → their current files.

## Keeping the changelog short

The changelog is only a short tail of recent changes, not a forever history.

- Only an **admin** (the owner, or someone they passed admin to) can fold the log.
- After about **80** changes, and at most once every **two minutes**, the admin writes a fold checkpoint and keeps the last **16** lines plus that checkpoint. Older lines are deleted on that machine.
- Other members drop the same old lines when they receive the fold.
- A person whose last known change is older than what is still in the log cannot replay the missing slice. They get the **current project folder** from the admin (or any member who still has it).
- The hello always applies the other person’s recent local changes **before** a folder snapshot is sent, so work they did offline is applied first and then included in that snapshot.

The text files stay the long-term record. The log is only the recent queue.

**Fold does not pull in work the admin never received.** If the admin sat with a small group and folded, their files stay as *that* group last wrote them. Another group that kept working still has its own files and, if they never received the fold, a longer log.

When those two groups finally meet:

1. **If the person you reached still has the missing operations** (typical when the isolated admin knocks on someone in the larger group), those operations are applied **onto that person’s files**, one by one. Same item, two edits: the conflict rules below (time, then peer id). This is how the admin catches up without copying a whole tree.
2. **If they cannot replay the slice** (typical when someone from the larger group knocks on an admin who already folded), they send **their current project folder**. That is a file copy, not a merge: each path in that snapshot **overwrites the same path** on the receiver. Files that exist only on the receiver are left as they are. Shared files that the isolated admin never saw are replaced by the admin’s older copy of those paths — except for whatever recent local operations were applied onto the admin first (the short hello tail).
3. There is no automatic “take the larger group’s files because they have more work.” Who you connected to decides whose folder you get when replay is impossible. Meeting someone who still has the long log, or using the optional GitHub mailbox, is the safer catch-up. A later “get latest from the admin” action is the same snapshot rule: you get **that person’s current folder**, not a blended tree.

## Conflict rules

These rules are deterministic. Given the same operations, every member ends up with the same files.

- Different fields on the same issue merge.
- The same field: last write wins (time, then peer id).
- Two body edits on the same heading (issue or section): last write wins; a notice is shown if we overwrote someone.
- Move vs edit: both apply (content and placement do not fight).
- Two moves: last write wins placement.
- Delete vs a later edit of the same thing: delete wins.
- Delete vs a child created offline: the child stays; its parent link is cleared.
- Duplicate delivery: skip.

## Hand edits, MCP, and the two databases

The text files stay the source of truth. The two local indexes are derived and are never sent to anyone.

- **Project View and MCP** write the file, then reindex, and also append an operation that names that file.
- **Hand edit + save:** missing hidden unique ids on new issue headings are stamped, then each new issue is recorded as a create in **that** file (title, fields, and body). If a save stripped an existing id, the old id is put back — it is not minted again and is not sent as a new issue. A create that already exists in that file (same hidden id, or same `i-N` already there) is ignored. Later saves wait a few seconds, then send **one** update with the changed title, fields, and body. Delete is still its own operation. The heading form does the same after Apply or Delete. A new or edited **section heading** (plain or persistent) and the prose under it are recorded the same way — not as a whole-file overwrite. Opening the file first remembers the current sections so the next save only sends a real change.
- **New feature / note / concept / decision** in a shared project is recorded as a create that carries the new file’s text. Later saves of a concept or decision note, or of the project / feature index note, wait a few seconds, then send **one** update with the current file text. Deleting that note is its own operation. Missing hidden unique ids on `c-N` / `d-N` headings are stamped the same way as issues.
- Applying a remote operation and a local save on the same file are serialized so they cannot interleave halfway.
- If reindex fails after a successful file write, the files and the log are still right; the existing rebuild repairs the database.

Reset / reindex rebuilds the databases from disk. It must not strip hidden ids from project files, must not rewrite a shared project's files, and must not delete the sidecar.

## Git is not sync

GitHub backup can still snapshot a knowledge base for disaster recovery. Once a project is shared, do not merge that project's files through git. Mixing a git merge with the operation log forks the project.

## Flow (plain steps)

1. Someone changes a shared project (Project View, editor, heading form, or MCP). The change is written to the file they were in and appended to the project log (the create or move names that file; a body edit on save carries the full body).
2. The change is pushed to remembered members (this machine or the invite address). If that path is closed, the same change goes through the encrypted relay. A short hello also sends this machine’s recent changes and pulls any missed slice — or the current folder if that slice was folded away.
3. Each side applies the missing operations to the **same files**, remints colliding display keys, reprints those files into the strict shape, then reindexes them.
4. If nobody is reachable, the change waits in the log until a member is online again. If this project has a GitHub mailbox, leaving DRIP (or stopping sharing) after a local change saves that log there once. Opening DRIP pulls that mailbox and applies missing operations with the same reprint rules.
5. A new member receives a snapshot plus later operations, then the local index is built from the new folder so the project appears in Project View and in Settings.
6. When the admin’s log grows long, it is folded: old lines go away, the current folder is the history, and a late peer asks for that folder.
