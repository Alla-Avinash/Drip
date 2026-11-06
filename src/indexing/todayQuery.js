'use strict';

/**
 * Read-only queries against `today.drip` for the Today calendar and task list.
 */

const vscode = require('vscode');
const { openDripTodayDb } = require('./dripTodayDb');
const { listDaysWithNotes, dailyNoteUri, todayDisplayPath } = require('../startup/dailyNotesDrip');
const { deleteTodayNoteIfEmpty } = require('../startup/todayCleanup');

/**
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {unknown[][]}
 */
function queryAll(db, sql, params = []) {
	const stmt = db.prepare(sql);
	stmt.bind(params);
	/** @type {unknown[][]} */
	const rows = [];
	while (stmt.step()) {
		rows.push(stmt.get());
	}
	stmt.free();
	return rows;
}

/**
 * Local midnight → next midnight for a date (milliseconds).
 * @param {Date} day
 */
function dayBounds(day) {
	const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
	return { start, end: start + 24 * 60 * 60 * 1000 };
}

/**
 * `task_metadata.deadline` is stored as unix **seconds**. UI / Date use milliseconds.
 * @param {unknown} raw
 * @returns {number | null}
 */
function deadlineSecondsToMs(raw) {
	if (raw == null) return null;
	const n = Number(raw);
	if (!Number.isFinite(n)) return null;
	// Heuristic: values before year ~2001 in ms are almost certainly seconds.
	return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
}

/**
 * @param {number} ms
 * @returns {number}
 */
function msToDeadlineSeconds(ms) {
	return Math.floor(Number(ms) / 1000);
}

/**
 * Sunday-start week containing `day`.
 * @param {Date} day
 * @returns {{ weekStart: Date, days: Date[] }}
 */
function weekContaining(day) {
	const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
	start.setDate(start.getDate() - start.getDay());
	/** @type {Date[]} */
	const days = [];
	for (let i = 0; i < 7; i++) {
		const d = new Date(start);
		d.setDate(start.getDate() + i);
		days.push(d);
	}
	return { weekStart: start, days };
}

/**
 * Open tasks from Today notes (status not completed), optionally filtered by deadline day.
 * @param {import('vscode').Uri} kbRootUri
 * @param {{ deadlineDayStartMs?: number, deadlineDayEndMs?: number, includeNoDeadline?: boolean }} [opts]
 */
function listTodayTasks(kbRootUri, opts = {}) {
	const handle = openDripTodayDb(kbRootUri);
	try {
		const params = [];
		let where =
			`LOWER(COALESCE(tm.status, '')) NOT IN ('completed', 'done', 'cancelled', 'canceled')`;
		if (opts.deadlineDayStartMs != null && opts.deadlineDayEndMs != null) {
			where += ` AND tm.deadline IS NOT NULL AND tm.deadline >= ? AND tm.deadline < ?`;
			// SQL column is unix seconds; callers pass ms day-bounds.
			params.push(msToDeadlineSeconds(opts.deadlineDayStartMs), msToDeadlineSeconds(opts.deadlineDayEndMs));
		} else if (opts.includeNoDeadline === false) {
			where += ` AND tm.deadline IS NOT NULL`;
		}
		const rows = queryAll(
			handle.db,
			`
			SELECT h.file_id, h.heading_id, h.title,
			       COALESCE(tm.status, ''), COALESCE(tm.priority, ''), tm.deadline,
			       f.path
			FROM headings h
			JOIN task_metadata tm ON tm.file_id = h.file_id AND tm.heading_id = h.heading_id
			JOIN files f ON f.id = h.file_id
			WHERE ${where}
			ORDER BY CASE WHEN tm.deadline IS NULL THEN 1 ELSE 0 END, tm.deadline ASC, h.title ASC
			`,
			params
		);
		return rows.map(r => {
			const path = String(r[6] || '').replace(/\\/g, '/');
			return {
				fileId: Number(r[0]),
				headingId: Number(r[1]),
				title: String(r[2] || ''),
				status: String(r[3] || ''),
				priority: String(r[4] || ''),
				deadline: deadlineSecondsToMs(r[5]),
				path,
				displayPath: todayDisplayPath(path)
			};
		});
	} finally {
		handle.close();
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {Date} day
 */
function listTasksForCalendarDay(kbRootUri, day) {
	const { start, end } = dayBounds(day);
	const dueToday = listTodayTasks(kbRootUri, {
		deadlineDayStartMs: start,
		deadlineDayEndMs: end
	});
	const allOpen = listTodayTasks(kbRootUri, {});
	const overdue = allOpen.filter(
		t => t.deadline != null && Number.isFinite(t.deadline) && t.deadline < start
	);
	return { dueToday, overdue };
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {number} year
 * @param {number} month0
 */
async function getTodayCalendarMonth(kbRootUri, year, month0) {
	const daysWithNotes = await listDaysWithNotes(kbRootUri, year, month0);
	/** @type {Set<number>} */
	const realNotes = new Set();
	for (const day of daysWithNotes) {
		const uri = dailyNoteUri(kbRootUri, new Date(year, month0, day));
		const deleted = await deleteTodayNoteIfEmpty(kbRootUri, uri);
		if (!deleted) realNotes.add(day);
	}
	const monthStart = new Date(year, month0, 1).getTime();
	const monthEnd = new Date(year, month0 + 1, 1).getTime();
	const tasks = listTodayTasks(kbRootUri, {
		deadlineDayStartMs: monthStart,
		deadlineDayEndMs: monthEnd
	});
	/** @type {Map<number, typeof tasks>} */
	const tasksByDay = new Map();
	for (const t of tasks) {
		if (t.deadline == null || !Number.isFinite(t.deadline)) continue;
		const d = new Date(t.deadline);
		if (d.getFullYear() !== year || d.getMonth() !== month0) continue;
		const day = d.getDate();
		if (!tasksByDay.has(day)) tasksByDay.set(day, []);
		tasksByDay.get(day).push(t);
	}
	/** @type {{ day: number, hasNote: boolean, taskCount: number, tasks: typeof tasks }[]} */
	const days = [];
	const lastDay = new Date(year, month0 + 1, 0).getDate();
	for (let day = 1; day <= lastDay; day++) {
		const dayTasks = tasksByDay.get(day) || [];
		days.push({
			day,
			hasNote: realNotes.has(day),
			taskCount: dayTasks.length,
			tasks: dayTasks
		});
	}
	return { year, month0, days };
}

/**
 * Week payload (Sun–Sat) around the anchor date.
 * @param {import('vscode').Uri} kbRootUri
 * @param {Date} anchor
 */
async function getTodayCalendarWeek(kbRootUri, anchor) {
	const { weekStart, days } = weekContaining(anchor);
	/** @type {{ year: number, month0: number, day: number, label: string, hasNote: boolean, taskCount: number, tasks: ReturnType<typeof listTodayTasks> }[]} */
	const out = [];
	for (const d of days) {
		const y = d.getFullYear();
		const m = d.getMonth();
		const day = d.getDate();
		const { start, end } = dayBounds(d);
		const due = listTodayTasks(kbRootUri, {
			deadlineDayStartMs: start,
			deadlineDayEndMs: end
		});
		const noteUri = dailyNoteUri(kbRootUri, d);
		let hasNote = false;
		try {
			await vscode.workspace.fs.stat(noteUri);
			hasNote = !(await deleteTodayNoteIfEmpty(kbRootUri, noteUri));
		} catch {
			hasNote = false;
		}
		out.push({
			year: y,
			month0: m,
			day,
			label: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
			hasNote,
			taskCount: due.length,
			tasks: due
		});
	}
	return {
		weekStart: {
			year: weekStart.getFullYear(),
			month0: weekStart.getMonth(),
			day: weekStart.getDate()
		},
		days: out
	};
}

/**
 * Day detail: tasks + whether a note exists + short preview of diary body.
 * @param {import('vscode').Uri} kbRootUri
 * @param {Date} date
 */
async function getTodayCalendarDayDetail(kbRootUri, date) {
	const label = date.toLocaleDateString(undefined, {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});
	const noteUri = dailyNoteUri(kbRootUri, date);
	let hasNote = false;
	let preview = '';
	try {
		const raw = Buffer.from(await vscode.workspace.fs.readFile(noteUri)).toString('utf8');
		if (await deleteTodayNoteIfEmpty(kbRootUri, noteUri)) {
			hasNote = false;
			preview = '';
		} else {
			hasNote = true;
			preview = diaryPreviewFromNoteText(raw);
		}
	} catch {
		hasNote = false;
	}
	const { dueToday, overdue } = listTasksForCalendarDay(kbRootUri, date);
	return { label, hasNote, preview, dueToday, overdue };
}

/**
 * First non-empty prose lines under the note body (skip header / h0 / metadata markers).
 * @param {string} text
 */
function diaryPreviewFromNoteText(text) {
	const lines = String(text || '')
		.replace(/\r\n/g, '\n')
		.split('\n');
	let i = 0;
	while (i < lines.length && !/^\s*---\s*$/.test(lines[i])) i++;
	if (i < lines.length) i++;
	/** @type {string[]} */
	const prose = [];
	while (i < lines.length && prose.length < 6) {
		const L = lines[i++];
		const t = L.trim();
		if (!t) continue;
		if (/^@h\d+\s*$/i.test(t)) continue;
		if (/^#+\d*\s/.test(t)) continue;
		if (/^\.\w+/.test(t)) continue;
		if (/^[a-z][\w-]*\s*:/i.test(t) && L.startsWith('\t')) continue;
		prose.push(t);
	}
	return prose.join(' ').slice(0, 280);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {Date} date
 */
function todayNoteUriForDate(kbRootUri, date) {
	return dailyNoteUri(kbRootUri, date);
}

/**
 * Search headings inside Today notes only (`today.drip`).
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} query
 * @param {{ limit?: number }} [opts]
 */
function searchTodayHeadings(kbRootUri, query, opts = {}) {
	const q = String(query || '').trim().toLowerCase();
	const limit = Math.max(1, Math.min(100, Number(opts.limit) || 40));
	if (!q) return [];
	const handle = openDripTodayDb(kbRootUri);
	try {
		const like = `%${q.replace(/%/g, '')}%`;
		const rows = queryAll(
			handle.db,
			`
			SELECT h.file_id, h.heading_id, h.title,
			       COALESCE(mt.metadata_type_name, ''), f.path
			FROM headings h
			JOIN files f ON f.id = h.file_id
			LEFT JOIN metadata_types mt ON mt.metadata_type_id = h.metadata_type_id
			WHERE LOWER(h.title) LIKE ?
			ORDER BY
				CASE WHEN LOWER(h.title) = ? THEN 0
				     WHEN LOWER(h.title) LIKE ? THEN 1
				     ELSE 2 END,
				h.title ASC
			LIMIT ?
			`,
			[like, q, `${q}%`, limit]
		);
		return rows.map(r => ({
			fileId: Number(r[0]),
			headingId: Number(r[1]),
			title: String(r[2] || ''),
			type: String(r[3] || ''),
			path: String(r[4] || '').replace(/\\/g, '/')
		}));
	} finally {
		handle.close();
	}
}

/**
 * Open Today tasks bucketed for the Tasks section.
 * @param {import('vscode').Uri} kbRootUri
 * @param {Date} [now]
 */
function listTodayTaskBoard(kbRootUri, now = new Date()) {
	const { start, end } = dayBounds(now);
	const open = listTodayTasks(kbRootUri, {});
	/** @type {typeof open} */
	const overdue = [];
	/** @type {typeof open} */
	const dueToday = [];
	/** @type {typeof open} */
	const upcoming = [];
	/** @type {typeof open} */
	const noDeadline = [];
	for (const t of open) {
		if (t.deadline == null || !Number.isFinite(t.deadline)) {
			noDeadline.push(t);
			continue;
		}
		if (t.deadline < start) overdue.push(t);
		else if (t.deadline < end) dueToday.push(t);
		else upcoming.push(t);
	}
	return { overdue, dueToday, upcoming, noDeadline, asOf: start };
}

/**
 * Parse MM-DD-YYYY from a Today note path / filename.
 * @param {string} pathOrName
 * @returns {Date | null}
 */
function dateFromTodayNotePath(pathOrName) {
	const base = String(pathOrName || '')
		.replace(/\\/g, '/')
		.split('/')
		.pop() || '';
	const stem = base.replace(/\.d\.txt$/i, '');
	const m = stem.match(/^(\d{2})-(\d{2})-(\d{4})$/);
	if (!m) return null;
	const d = new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
	return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Persistent log headings (non-h0, non-task) grouped by day for the Daily log timeline.
 * Days with no such headings are omitted. Newest days first; supports date range + paging.
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {{
 *   limit?: number,
 *   offset?: number,
 *   fromMs?: number | null,
 *   toMs?: number | null,
 *   limitDays?: number
 * }} [opts]
 * @returns {{ days: any[], hasMore: boolean, nextOffset: number, total: number }}
 */
function listTodayDailyLog(kbRootUri, opts = {}) {
	// Page size ~2 scroll screens of day groups; callers can pass more.
	const limit = Math.max(
		1,
		Math.min(60, Number(opts.limit) || Number(opts.limitDays) || 12)
	);
	const offset = Math.max(0, Number(opts.offset) || 0);
	const fromMs =
		opts.fromMs != null && Number.isFinite(Number(opts.fromMs)) ? Number(opts.fromMs) : null;
	const toMs = opts.toMs != null && Number.isFinite(Number(opts.toMs)) ? Number(opts.toMs) : null;
	const handle = openDripTodayDb(kbRootUri);
	try {
		const rows = queryAll(
			handle.db,
			`
			SELECT h.file_id, h.heading_id, h.title,
			       COALESCE(mt.metadata_type_name, ''), f.path
			FROM headings h
			JOIN files f ON f.id = h.file_id
			LEFT JOIN metadata_types mt ON mt.metadata_type_id = h.metadata_type_id
			WHERE h.heading_id <> 0
			  AND LOWER(COALESCE(mt.metadata_type_name, '')) <> 'task'
			ORDER BY f.path DESC, h.heading_id ASC
			`
		);
		/** @type {Map<string, { dateKey: string, dateMs: number, label: string, year: number, month0: number, day: number, headings: any[] }>} */
		const byDay = new Map();
		for (const r of rows) {
			const path = String(r[4] || '').replace(/\\/g, '/');
			const date = dateFromTodayNotePath(path);
			if (!date) continue;
			const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
			if (fromMs != null && dayStart < fromMs) continue;
			if (toMs != null && dayStart > toMs) continue;
			const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
			if (!byDay.has(dateKey)) {
				byDay.set(dateKey, {
					dateKey,
					dateMs: dayStart,
					label: date.toLocaleDateString(undefined, {
						day: 'numeric',
						month: 'short',
						year: 'numeric'
					}),
					year: date.getFullYear(),
					month0: date.getMonth(),
					day: date.getDate(),
					headings: []
				});
			}
			byDay.get(dateKey).headings.push({
				fileId: Number(r[0]),
				headingId: Number(r[1]),
				title: String(r[2] || ''),
				type: String(r[3] || ''),
				path,
				displayPath: todayDisplayPath(path)
			});
		}
		const all = [...byDay.values()]
			.filter(g => g.headings.length > 0)
			.sort((a, b) => b.dateMs - a.dateMs);
		const days = all.slice(offset, offset + limit);
		const nextOffset = offset + days.length;
		return {
			days,
			hasMore: nextOffset < all.length,
			nextOffset,
			total: all.length
		};
	} finally {
		handle.close();
	}
}

module.exports = {
	listTodayTasks,
	listTasksForCalendarDay,
	getTodayCalendarMonth,
	getTodayCalendarWeek,
	getTodayCalendarDayDetail,
	todayNoteUriForDate,
	weekContaining,
	dayBounds,
	deadlineSecondsToMs,
	diaryPreviewFromNoteText,
	searchTodayHeadings,
	listTodayTaskBoard,
	listTodayDailyLog,
	dateFromTodayNotePath
};
