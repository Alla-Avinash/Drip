# Feature: Today, daily notes, drafts, and recents

## What it is

Personal day-to-day capture and navigation: a **Today** calendar (from Components), a **Daily Notes** folder tree for day logs, plus **Drafts** and **Recents**.

## How to access it

- **Today calendar:** left DRIP sidebar → **Components** → **Today** (opens the calendar panel with Day / Week / Month views).
- **Daily Notes folder tree:** left DRIP sidebar, under Knowledge Base — year / month / day files. Toolbar **Open Today** (+) opens or creates today’s day log.
- **Drafts** and **Recents** sit below Daily Notes in the same sidebar.

## Daily Notes (day logs + personal tasks)

- Files live under the knowledge-base root in **`.drip.dailynotes`**, grouped as `year / Month / MM-DD-YYYY.d.txt` (e.g. `2026/November/11-05-2026.d.txt`). The folder is hidden from the Knowledge Base tree.
- In Today UI, paths show as a friendly date (**`5 November 2026`**), not the folder path.
- Day notes allow only **`.task`** typed headings, plus **persistent** (`# . …`) and **non-persistent** (plain `# …`) headings. No concept (or other) types, tags, or relations in these files.
- New tasks (compose or ingest into a day note) are written as **persistent typed** headings so they are indexed: `.d.txt` uses a title shortcut (`# .t …`) with `.task` at one tab and fields at two tabs; `.d.md` uses the hidden heading comment. After ingest into a day note, the open Today panel refreshes.
- Marking a `.task` **completed** stamps `completed` (date-time to the minute). Leaving completed clears that stamp.
- Day notes that only contain empty space or the file shell (metadata + date h0) are deleted as soon as they are closed, and also when the calendar notices them — they never stay as “real” day logs.
- The Daily Notes tree lists year → month → day notes.

### Separate index (`today.drip`)

- Daily / Today notes are **not** stored in `index.drip` (Retriever / KB search) or `projects.drip` (Project View).
- They are indexed only in `<kb>/.dripindex/today.drip` (files, headings, task metadata). Persistent headings are indexed; plain non-persistent headings stay in the file only.
- Rebuild / reset of the knowledge base also rebuilds `today.drip` from `.drip.dailynotes`.

### Today component

Opened from **Components → Today** (editor tab title **DRIP Today**). Clean layout like Project View. Four sections (Daily Notes only):

1. **Calendar** — Day / Week / Month, **Today** jump, and legend dots (day log / pending tasks) on month and week cells. Side panel: preview, then **Create log** / **Open log** beside **+ New task**. **+ New task** opens a simple compose form under those buttons (title; deadline + priority side by side — deadline text like the Heading form, `"2 hrs"` becomes `YYYY-MM-DD HH:mm` on blur; priority None/High/Low). Side panel always lists **Due** and **Overdue** in the same shaded color boxes as the Tasks section, with **Done** on each row. **Day** view is a 24-hour timeline (12 AM → 11 PM) for that day’s due tasks; Due + Overdue remain on the right. Creating / completing a task does not show soft-lock bulk-add prompts or status toasts.
2. **Search** — Narrow centered column. Engines: Recommended / semantic / word. Filters: All / Tasks / Log. Date h0 never listed. Paths show as friendly dates.
3. **Tasks** — Narrow centered column, shaded groups, **+ New task** opens the same compose form for a task due today. Click row to open; **Done** completes.
4. **Daily log** — Timeline of days that have persistent (non-task) headings. Date on the left, vertical rail, headings on the right. Days with none are omitted. Click a heading to open it. Range chips: **Recent** (paged), **7 days**, **30 days**, or **Custom** from/to dates. The first page shows about a dozen days (~two scroll screens); scrolling to the bottom loads the next page (infinite scroll).

### Monthly cleanup (Today only)

- About once a calendar month (or the next time DRIP opens if it was closed), a job walks `.drip.dailynotes` only.
- It **deletes** `.task` blocks whose status is completed and whose `completed` stamp is **at least 30 days** old (if there is no stamp, the day-file’s date is used as a fallback).
- After that, day files that are effectively empty (only whitespace or the unused file shell) are **deleted** from disk and dropped from `today.drip`.
- Knowledge Base tasks and project issues are never touched by this job — lasting notes belong in the KB.

## Drafts

- Draft notes are saved and listed in the Drafts tree.
- A draft can be opened in the Composer to continue editing.

## Recents

- Recently opened notes are tracked and listed in the Recents tree.
- Picking a recent opens the file again.

## Flow (plain steps)

1. User opens **Components → Today** for Day/Week/Month, Daily log, or **Daily Notes** to browse day files.
2. Completing a personal task in a day note stamps when it was done.
3. Saving a day note updates only `today.drip`.
4. Once a month, old completed day-tasks and empty day files are removed from Daily Notes only.
