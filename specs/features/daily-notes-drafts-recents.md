# Feature: Today, daily notes, drafts, and recents

## What it is

Personal day-to-day capture and navigation: a **Today** calendar (from Components) with a File view for day logs, plus **Drafts** and **Recents**.

## How to access it

- **Today calendar:** left DRIP sidebar → **Components** → **Today** (opens the calendar panel with Day / Week / Month views). Use **File view** (right end of the left-column toolbar) to browse year → month → day notes.
- **Drafts** and **Recents** sit in the left DRIP sidebar under Knowledge Base.

## Daily Notes (day logs + personal tasks)

- Files live under the knowledge-base root in **`.drip.dailynotes`**, grouped as `year / Month / MM-DD-YYYY.d.txt` (e.g. `2026/November/11-05-2026.d.txt`). The folder is hidden from the Knowledge Base tree.
- In Today UI, paths show as a friendly date (**`5 November 2026`**), not the folder path.
- Day notes allow only **`.task`** typed headings, plus **persistent** (`# . …`) and **non-persistent** (plain `# …`) headings. No concept (or other) types, tags, or relations in these files.
- New tasks (compose or ingest into a day note) are written as **persistent typed** headings so they are indexed: `.d.txt` uses a title shortcut (`# .t …`) with `.task` at one tab and fields at two tabs; `.d.md` uses the hidden heading comment. After ingest into a day note, the open Today panel refreshes.
- Marking a `.task` **completed** stamps `completed` (date-time to the minute). Leaving completed clears that stamp.
- Day notes that only contain empty space or the file shell (metadata + date h0) are deleted as soon as they are closed, and also when the calendar notices them — they never stay as “real” day logs.
- Day files are browsed from Calendar → **File view** (year → month → day note).

### Separate index (`today.drip`)

- Daily / Today notes are **not** stored in `index.drip` (Retriever / KB search) or any project DB under `.dripindex/projects/` (Project View).
- They are indexed only in `<kb>/.dripindex/today.drip` (files, headings, task metadata). Persistent headings are indexed; plain non-persistent headings stay in the file only.
- Rebuild / reset of the knowledge base also rebuilds `today.drip` from `.drip.dailynotes`.

### Today component

Opened from **Components → Today** (editor tab title **DRIP Today**). Clean layout like Project View. Five sections (Daily Notes only). There is no sidebar Daily Notes tree; browsing day files is Calendar → **File view**.

1. **Calendar** — Two halves: left has Day / Week / Month, **Today**, legend, and **File view** (pushed to the right of that left toolbar), then the calendar grid; right half is the selected-day panel from the top (larger date heading, preview, **Create log** / **Open log**, **+ New task**, Due / Overdue). **File view** swaps the left calendar grid for a year → month → day-file tree; Day / Week / Month (or Today) returns to the calendar. **+ New task** opens a simple compose form (title; deadline + priority side by side — deadline text like the Heading form, `"2 hrs"` becomes `YYYY-MM-DD HH:mm` on blur; priority None/High/Low). **Day** view is a 24-hour timeline (12 AM → 11 PM) for that day’s due tasks; Due + Overdue remain on the right. Creating / completing a task does not show soft-lock bulk-add prompts or status toasts.
2. **Today's log** — Dedicated tab showing today’s date/day heading and a **Create log** / **Open log** button for today’s day note. Creates the file if needed and opens it in the editor. Closing an empty shell note deletes it (same empty-note cleanup as elsewhere).
3. **Search** — Narrow centered column. Engines: Recommended / semantic / word. Filters: All / Tasks / Log. Date h0 never listed. Paths show as friendly dates.
4. **Tasks** — Narrow centered column, shaded groups sorted by deadline (soonest first). **+ New task** opens the same compose form for a task due today. Click row to open; **Done** completes. On **Upcoming**, a second chip row (spaced below the main filters) narrows deadlines to **All**, **Tomorrow**, **Next 2 days**, **Next week**, or **Next X days** (custom number); those results stay ordered by deadline.
5. **Daily log** — Timeline of days that have persistent (non-task) headings, **newest day at the top**. Date on the left, vertical rail, headings on the right. Days with none are omitted. Click a heading to open it. Range chips: **Recent** (paged), **7 days**, **30 days**, or **Custom** from/to dates. The first page shows about a dozen days (~two scroll screens); scrolling to the bottom loads older days (infinite scroll).

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

1. User opens **Components → Today** for Day/Week/Month, Daily log, or **File view** to open a day file.
2. Completing a personal task in a day note stamps when it was done.
3. Saving a day note updates only `today.drip`.
4. Once a month, old completed day-tasks and empty day files are removed from Daily Notes only.
