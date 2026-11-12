'use strict';

/**
 * Today panel — Calendar / Search / Tasks for Daily Notes only.
 * UI matches Project View: compact chrome, word/semantic/recommended search.
 */

const vscode = require('vscode');
const { DRIP_TODAY_CALENDAR_PANEL_ID } = require('../../../shared/constants');
const { getNonce } = require('../../../shared/utils');
const {
	getTodayCalendarMonth,
	getTodayCalendarWeek,
	getTodayCalendarDayDetail,
	listTodayTaskBoard,
	listTodayDailyLog,
	getTodaysLogSummary
} = require('../../../indexing/todayQuery');
const { searchTodayHeadingsHybrid } = require('../../../indexing/todayHeadingSearch');
const {
	ensureTodayDailyNote,
	loadDailyNotesTree,
	loadDailyMonthNodes,
	loadDailyNoteNodes,
	toRelPath
} = require('../../../startup/dailyNotesDrip');
const { setTodayTaskStatus, createTodayTask } = require('../../../startup/todayTaskActions');

/** @type {import('vscode').WebviewPanel | undefined} */
let panel;

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {{ getVerifiedKnowledgeBaseRoot?: () => import('vscode').Uri | undefined, getKnowledgeBaseRoot?: () => import('vscode').Uri | undefined }} state
 */
function openTodayCalendarPanel(context, state) {
	const kbRoot =
		(state.getVerifiedKnowledgeBaseRoot && state.getVerifiedKnowledgeBaseRoot()) ||
		(state.getKnowledgeBaseRoot && state.getKnowledgeBaseRoot());
	if (!kbRoot) {
		void vscode.window.showInformationMessage('Select a Knowledge Base first.');
		return;
	}

	if (panel) {
		panel.title = 'DRIP Today';
		panel.reveal(vscode.ViewColumn.One);
		const now = new Date();
		void postMonth(panel.webview, kbRoot, now.getFullYear(), now.getMonth());
		void postTasks(panel.webview, kbRoot);
		void postNotesTreeRoot(panel.webview, kbRoot);
		return;
	}

	panel = vscode.window.createWebviewPanel(
		DRIP_TODAY_CALENDAR_PANEL_ID,
		'DRIP Today',
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [
				vscode.Uri.joinPath(context.extensionUri, 'src', 'views', 'lhs', 'today', 'webview')
			]
		}
	);

	panel.webview.html = getHtml(panel.webview, context.extensionUri);
	panel.onDidDispose(() => {
		panel = undefined;
	});

	panel.webview.onDidReceiveMessage(async msg => {
		const root =
			(state.getVerifiedKnowledgeBaseRoot && state.getVerifiedKnowledgeBaseRoot()) ||
			(state.getKnowledgeBaseRoot && state.getKnowledgeBaseRoot());
		if (!root || !panel) return;
		try {
			if (msg.type === 'ready' || msg.type === 'refresh') {
				const now = new Date();
				const lens = String(msg.lens || 'month');
				if (lens === 'week') await postWeek(panel.webview, root, now);
				else await postMonth(panel.webview, root, now.getFullYear(), now.getMonth());
				await postDay(panel.webview, root, now.getFullYear(), now.getMonth(), now.getDate());
				await postTasks(panel.webview, root);
				await postNotesTreeRoot(panel.webview, root);
			} else if (msg.type === 'loadMonth') {
				await postMonth(panel.webview, root, Number(msg.year), Number(msg.month0));
			} else if (msg.type === 'loadWeek') {
				const date = new Date(Number(msg.year), Number(msg.month0), Number(msg.day));
				await postWeek(panel.webview, root, date);
			} else if (msg.type === 'selectDay') {
				await postDay(panel.webview, root, Number(msg.year), Number(msg.month0), Number(msg.day));
			} else if (msg.type === 'openOrCreateNote') {
				const date = new Date(Number(msg.year), Number(msg.month0), Number(msg.day));
				const { uri } = await ensureTodayDailyNote(root, date, { context });
				await vscode.window.showTextDocument(uri);
				await postMonth(panel.webview, root, date.getFullYear(), date.getMonth());
				await postWeek(panel.webview, root, date);
				await postDay(panel.webview, root, date.getFullYear(), date.getMonth(), date.getDate());
				await postNotesTreeRoot(panel.webview, root);
			} else if (msg.type === 'openTodaysLog') {
				const date = new Date();
				const { uri } = await ensureTodayDailyNote(root, date, { context });
				await vscode.window.showTextDocument(uri);
				await postTodaysLog(panel.webview, root);
				await postMonth(panel.webview, root, date.getFullYear(), date.getMonth());
				await postWeek(panel.webview, root, date);
				await postDay(panel.webview, root, date.getFullYear(), date.getMonth(), date.getDate());
				await postNotesTreeRoot(panel.webview, root);
			} else if (msg.type === 'loadTodaysLog') {
				await postTodaysLog(panel.webview, root);
			} else if (msg.type === 'openTask' || msg.type === 'openHeading') {
				const rel = String(msg.path || '').replace(/\\/g, '/');
				if (!rel) return;
				const uri = vscode.Uri.joinPath(root, ...rel.split('/'));
				await vscode.window.showTextDocument(uri);
			} else if (msg.type === 'search') {
				const seq = Number(msg.seq) || 0;
				const result = await searchTodayHeadingsHybrid(root, {
					query: String(msg.query || ''),
					searchEngine: msg.searchEngine,
					topN: msg.topN,
					headingKind: msg.headingKind,
					seq
				});
				panel.webview.postMessage({
					type: 'searchResults',
					rows: result.rows,
					searchEngine: result.searchEngine,
					query: result.query,
					headingKind: result.headingKind,
					seq: result.seq
				});
			} else if (msg.type === 'loadTasks') {
				await postTasks(panel.webview, root);
			} else if (msg.type === 'loadDailyLog') {
				await postDailyLog(panel.webview, root, {
					limit: Number(msg.limit) || 12,
					offset: Number(msg.offset) || 0,
					fromMs: msg.fromMs != null ? Number(msg.fromMs) : null,
					toMs: msg.toMs != null ? Number(msg.toMs) : null,
					append: msg.append === true,
					seq: Number(msg.seq) || 0
				});
			} else if (msg.type === 'loadNotesTree') {
				await postNotesTreeRoot(panel.webview, root);
			} else if (msg.type === 'expandNotesNode') {
				await postNotesTreeChildren(panel.webview, root, msg);
			} else if (msg.type === 'openNotePath') {
				const rel = String(msg.path || '').replace(/\\/g, '/');
				if (!rel) return;
				const uri = vscode.Uri.joinPath(root, ...rel.split('/').filter(Boolean));
				await vscode.window.showTextDocument(uri);
			} else if (msg.type === 'completeTask') {
				await setTodayTaskStatus(
					root,
					String(msg.path || ''),
					Number(msg.headingId),
					'completed',
					context
				);
				await postTasks(panel.webview, root);
				const now = new Date();
				await postDay(panel.webview, root, now.getFullYear(), now.getMonth(), now.getDate());
				await postMonth(panel.webview, root, now.getFullYear(), now.getMonth());
			} else if (msg.type === 'normalizeDatetime') {
				const { normalizeDateTimeValue } = require('../../../document/parse/dripTxt/dripTxtDatetime.js');
				const raw = String(msg.value || '');
				const value = normalizeDateTimeValue(raw, new Date());
				panel.webview.postMessage({
					type: 'datetimeNormalized',
					field: String(msg.field || ''),
					value: value || raw
				});
			} else if (msg.type === 'addTask') {
				const y = Number(msg.year);
				const m0 = Number(msg.month0);
				const d = Number(msg.day);
				const date =
					Number.isFinite(y) && Number.isFinite(m0) && Number.isFinite(d)
						? new Date(y, m0, d)
						: new Date();
				const trimmed = String(msg.title || '').trim();
				if (!trimmed) {
					panel.webview.postMessage({ type: 'status', text: 'Task title required' });
					return;
				}
				const priority = String(msg.priority || '').trim();
				const deadlineRaw = String(msg.deadline || '').trim();
				await createTodayTask(root, date, trimmed, context, {
					deadline: deadlineRaw || undefined,
					priority: priority || undefined
				});
				await postDay(panel.webview, root, date.getFullYear(), date.getMonth(), date.getDate());
				await postWeek(panel.webview, root, date);
				await postMonth(panel.webview, root, date.getFullYear(), date.getMonth());
				await postTasks(panel.webview, root);
			}
		} catch (err) {
			panel.webview.postMessage({
				type: 'error',
				text: err && err.message ? String(err.message) : String(err)
			});
		}
	});
}

/**
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} kbRoot
 * @param {number} year
 * @param {number} month0
 */
async function postMonth(webview, kbRoot, year, month0) {
	const month = await getTodayCalendarMonth(kbRoot, year, month0);
	webview.postMessage({ type: 'month', month });
}

/**
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} kbRoot
 * @param {Date} anchor
 */
async function postWeek(webview, kbRoot, anchor) {
	const week = await getTodayCalendarWeek(kbRoot, anchor);
	webview.postMessage({ type: 'week', week });
}

/**
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} kbRoot
 * @param {number} year
 * @param {number} month0
 * @param {number} day
 */
async function postDay(webview, kbRoot, year, month0, day) {
	const date = new Date(year, month0, day);
	const detail = await getTodayCalendarDayDetail(kbRoot, date);
	webview.postMessage({ type: 'day', ...detail });
}

/**
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} kbRoot
 */
async function postTasks(webview, kbRoot) {
	const board = listTodayTaskBoard(kbRoot, new Date());
	webview.postMessage({ type: 'taskBoard', board });
}

/**
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} kbRoot
 * @param {{ limit?: number, offset?: number, fromMs?: number | null, toMs?: number | null, append?: boolean, seq?: number }} [opts]
 */
async function postDailyLog(webview, kbRoot, opts = {}) {
	const result = listTodayDailyLog(kbRoot, {
		limit: opts.limit,
		offset: opts.offset,
		fromMs: opts.fromMs,
		toMs: opts.toMs
	});
	webview.postMessage({
		type: 'dailyLog',
		days: result.days,
		hasMore: result.hasMore,
		nextOffset: result.nextOffset,
		total: result.total,
		append: opts.append === true,
		seq: Number(opts.seq) || 0
	});
}

/**
 * Status for the Today's log tab (calendar day = now).
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} kbRoot
 */
async function postTodaysLog(webview, kbRoot) {
	const summary = getTodaysLogSummary(kbRoot, new Date());
	webview.postMessage({ type: 'todaysLog', ...summary });
}

/**
 * Root years for the Calendar notes tree.
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} kbRoot
 */
async function postNotesTreeRoot(webview, kbRoot) {
	const years = await loadDailyNotesTree(kbRoot);
	webview.postMessage({
		type: 'notesTreeRoot',
		nodes: years.map(y => ({
			kind: 'year',
			label: y.label,
			path: toRelPath(kbRoot, y.uri)
		}))
	});
}

/**
 * Expand a year → months or month → day notes.
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} kbRoot
 * @param {{ kind?: string, path?: string }} msg
 */
async function postNotesTreeChildren(webview, kbRoot, msg) {
	const kind = String(msg.kind || '');
	const rel = String(msg.path || '').replace(/\\/g, '/');
	if (!rel) {
		webview.postMessage({ type: 'notesTreeChildren', path: '', nodes: [] });
		return;
	}
	const uri = vscode.Uri.joinPath(kbRoot, ...rel.split('/').filter(Boolean));
	/** @type {{ kind: string, label: string, path: string }[]} */
	let nodes = [];
	if (kind === 'year') {
		const months = await loadDailyMonthNodes(uri);
		nodes = months.map(m => ({
			kind: 'month',
			label: m.label,
			path: toRelPath(kbRoot, m.uri)
		}));
	} else if (kind === 'month') {
		const notes = await loadDailyNoteNodes(uri);
		nodes = notes.map(n => ({
			kind: 'note',
			label: n.label,
			path: toRelPath(kbRoot, n.uri)
		}));
	}
	webview.postMessage({ type: 'notesTreeChildren', path: rel, kind, nodes });
}

/**
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} extensionUri
 */
function getHtml(webview, extensionUri) {
	const nonce = getNonce();
	const styleUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'src', 'views', 'lhs', 'today', 'webview', 'todayCalendar.css')
	);
	const jsUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'src', 'views', 'lhs', 'today', 'webview', 'todayCalendar.js')
	);
	const csp = [
		`default-src 'none';`,
		`style-src ${webview.cspSource};`,
		`script-src 'nonce-${nonce}' ${webview.cspSource};`
	].join(' ');
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>DRIP Today</title>
<link rel="stylesheet" href="${styleUri}" />
</head>
<body>
	<header>
		<h1>DRIP Today</h1>
		<span class="spacer"></span>
		<span id="status" class="status-line" aria-live="polite"></span>
		<button type="button" id="refresh" class="ghost">Refresh</button>
	</header>

	<nav class="tabs" aria-label="Today sections">
		<button type="button" data-section="calendar" class="active">Calendar</button>
		<button type="button" data-section="todayslog">Today's log</button>
		<button type="button" data-section="search">Search</button>
		<button type="button" data-section="tasks">Tasks</button>
		<button type="button" data-section="dailylog">Daily log</button>
	</nav>

	<div class="layout">
		<section class="panel active" data-panel="calendar" aria-label="Calendar">
			<div class="cal-layout" id="cal-layout">
				<div class="cal-main">
					<div class="toolbar cal-toolbar">
						<div class="segment" role="group" aria-label="View">
							<button type="button" data-lens="day">Day</button>
							<button type="button" data-lens="week">Week</button>
							<button type="button" data-lens="month" class="active">Month</button>
						</div>
						<button type="button" id="jump-today" class="ghost today-jump">Today</button>
						<div class="cal-legend" aria-label="Legend">
							<span><i class="dot"></i> Day log</span>
							<span><i class="dot task"></i> Pending tasks</span>
						</div>
						<button type="button" id="file-view" class="ghost file-view-btn">File view</button>
					</div>
					<div class="cal-main-body" id="cal-main-body">
						<div class="cal-nav">
							<button type="button" id="prev-range" class="ghost nav-btn" aria-label="Previous" title="Previous">‹</button>
							<span class="month-label" id="month-label">—</span>
							<button type="button" id="next-range" class="ghost nav-btn" aria-label="Next" title="Next">›</button>
						</div>
						<div id="day-lens-block" class="day-lens hidden">
							<div class="day-hour-grid" id="day-hour-grid" role="list" aria-label="Day timeline"></div>
						</div>
						<div class="weekdays" id="weekdays">
							<span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span>
							<span>Thu</span><span>Fri</span><span>Sat</span>
						</div>
						<div class="grid" id="cal-grid"></div>
						<div class="week-grid hidden" id="week-grid"></div>
					</div>
					<div class="file-view-panel hidden" id="file-view-panel" aria-label="Daily notes folders">
						<div class="section-label">Notes</div>
						<div id="notes-tree" class="notes-tree">
							<div class="empty">Loading…</div>
						</div>
					</div>
				</div>
				<aside id="cal-aside" aria-label="Selected day">
					<div class="side-head">
						<div class="side-head-text">
							<h2 class="side-title" id="day-title">Select a day</h2>
							<p class="side-sub" id="day-sub"></p>
						</div>
					</div>
					<p class="preview" id="day-preview"></p>
					<div class="side-actions">
						<button type="button" id="open-note" class="tint">Create log</button>
						<button type="button" id="add-side-task" class="tint">+ New task</button>
					</div>
					<div id="task-compose" class="compose hidden">
						<label class="compose-label" for="composeTitle">New task</label>
						<input type="text" id="composeTitle" class="compose-title" placeholder="Short task title" autocomplete="off" />
						<div class="compose-fields">
							<label class="compose-field">
								<span>Deadline</span>
								<input type="text" id="composeDeadline" placeholder='YYYY-MM-DD HH:mm or "2 hrs"' autocomplete="off" />
							</label>
							<label class="compose-field">
								<span>Priority</span>
								<select id="composePriority" aria-label="Priority">
									<option value="">None</option>
									<option value="high">High</option>
									<option value="low">Low</option>
								</select>
							</label>
						</div>
						<div class="compose-actions">
							<button type="button" id="composeSubmit" class="tint">Create</button>
							<button type="button" id="composeCancel" class="ghost">Cancel</button>
						</div>
					</div>
					<div id="side-task-lists">
						<div id="side-due-group" class="task-group today">
							<div class="section-label">Due</div>
							<ul class="task-list" id="due-list"></ul>
						</div>
						<div id="side-overdue-group" class="task-group overdue">
							<div class="section-label">Overdue</div>
							<ul class="task-list" id="overdue-list"></ul>
						</div>
					</div>
				</aside>
			</div>
		</section>

		<section class="panel panel-narrow" data-panel="search" aria-label="Search">
			<div class="search-row">
				<input id="search-input" class="proj-search" type="search" placeholder="Search day notes…" autocomplete="off" />
				<span class="search-type-anchor" id="search-engine-anchor"></span>
			</div>
			<div class="chips" role="group" aria-label="Heading type">
				<button type="button" data-heading-kind="all" class="active">All</button>
				<button type="button" data-heading-kind="task">Tasks</button>
				<button type="button" data-heading-kind="other">Log</button>
			</div>
			<ul class="result-list" id="search-results"></ul>
		</section>

		<section class="panel panel-narrow" data-panel="tasks" aria-label="Tasks">
			<div class="tasks-toolbar">
				<div class="chips" id="task-filter-chips" role="group" aria-label="Task filters">
					<button type="button" data-filter="all" class="active">All</button>
					<button type="button" data-filter="overdue">Overdue</button>
					<button type="button" data-filter="today">Today</button>
					<button type="button" data-filter="upcoming">Upcoming</button>
					<button type="button" data-filter="later">Later</button>
				</div>
				<button type="button" id="add-task" class="tint">+ New task</button>
			</div>
			<div id="upcoming-horizon" class="upcoming-horizon hidden" aria-label="Upcoming deadline range">
				<div class="chips" id="upcoming-range-chips" role="group" aria-label="Upcoming range">
					<button type="button" data-upcoming-range="any" class="active">All</button>
					<button type="button" data-upcoming-range="tomorrow">Tomorrow</button>
					<button type="button" data-upcoming-range="2">Next 2 days</button>
					<button type="button" data-upcoming-range="7">Next week</button>
					<button type="button" data-upcoming-range="custom">Next X days</button>
				</div>
				<div id="upcoming-custom" class="upcoming-custom hidden">
					<label class="upcoming-custom-field">
						<span>Days</span>
						<input type="number" id="upcoming-custom-days" min="1" max="365" step="1" value="3" />
					</label>
					<button type="button" id="upcoming-custom-apply" class="tint">Apply</button>
				</div>
			</div>
			<div id="tasks-compose" class="compose hidden">
				<label class="compose-label" for="tasksComposeTitle">New task</label>
				<input type="text" id="tasksComposeTitle" class="compose-title" placeholder="Short task title" autocomplete="off" />
				<div class="compose-fields">
					<label class="compose-field">
						<span>Deadline</span>
						<input type="text" id="tasksComposeDeadline" placeholder='YYYY-MM-DD HH:mm or "2 hrs"' autocomplete="off" />
					</label>
					<label class="compose-field">
						<span>Priority</span>
						<select id="tasksComposePriority" aria-label="Priority">
							<option value="">None</option>
							<option value="high">High</option>
							<option value="low">Low</option>
						</select>
					</label>
				</div>
				<div class="compose-actions">
					<button type="button" id="tasksComposeSubmit" class="tint">Create</button>
					<button type="button" id="tasksComposeCancel" class="ghost">Cancel</button>
				</div>
			</div>
			<div id="task-board">
				<div class="empty">Loading…</div>
			</div>
		</section>

		<section class="panel panel-narrow" data-panel="todayslog" aria-label="Today's log">
			<div class="tlog-card">
				<p class="tlog-eyebrow">Today</p>
				<h2 class="tlog-title" id="tlog-title">Today's log</h2>
				<button type="button" id="open-todays-log" class="tint">Create log</button>
			</div>
		</section>

		<section class="panel panel-narrow" data-panel="dailylog" aria-label="Daily log">
			<div class="dlog-toolbar">
				<div class="chips" role="group" aria-label="Daily log range">
					<button type="button" data-dlog-range="recent" class="active">Recent</button>
					<button type="button" data-dlog-range="7">7 days</button>
					<button type="button" data-dlog-range="30">30 days</button>
					<button type="button" data-dlog-range="custom">Custom</button>
				</div>
				<div id="dlog-custom" class="dlog-custom hidden">
					<label class="dlog-date-field">From <input type="date" id="dlog-from" /></label>
					<label class="dlog-date-field">To <input type="date" id="dlog-to" /></label>
					<button type="button" id="dlog-apply" class="tint">Apply</button>
				</div>
			</div>
			<div id="daily-log-scroll" class="dlog-scroll">
				<div id="daily-log" class="timeline">
					<div class="empty">Loading…</div>
				</div>
				<div id="daily-log-sentinel" class="dlog-sentinel" aria-hidden="true"></div>
				<div id="daily-log-foot" class="dlog-foot muted-block"></div>
			</div>
		</section>
	</div>

	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

/**
 * Push a fresh calendar/tasks snapshot into the open Today panel (if any).
 * Used after ingesting into a daily note so new tasks show up without a manual refresh.
 *
 * @param {{ getVerifiedKnowledgeBaseRoot?: () => import('vscode').Uri | undefined, getKnowledgeBaseRoot?: () => import('vscode').Uri | undefined } | null | undefined} state
 * @param {import('vscode').Uri | string | null | undefined} [touchedUri]
 */
async function refreshTodayCalendarIfOpen(state, touchedUri) {
	if (!panel || !state) return;
	const kbRoot =
		(state.getVerifiedKnowledgeBaseRoot && state.getVerifiedKnowledgeBaseRoot()) ||
		(state.getKnowledgeBaseRoot && state.getKnowledgeBaseRoot());
	if (!kbRoot) return;
	const { isDailyNoteUri } = require('../../../startup/dailyNotesDrip');
	let uri = null;
	if (touchedUri && typeof touchedUri === 'object' && touchedUri.fsPath) {
		uri = touchedUri;
	} else if (touchedUri) {
		try {
			uri = vscode.Uri.file(String(touchedUri));
		} catch {
			uri = null;
		}
	}
	if (uri && !isDailyNoteUri(kbRoot, uri)) return;

	if (uri && isDailyNoteUri(kbRoot, uri)) {
		try {
			const { updateNoteInDripIndex } = require('../../../indexing/sync/dripTxt/dripTxtIndexUpdate.js');
			const ctx = state.context || null;
			await updateNoteInDripIndex(kbRoot, uri, ctx, { force: true });
		} catch (err) {
			console.error('[DRIP] Today index after ingest', err);
		}
	}

	const now = new Date();
	await postMonth(panel.webview, kbRoot, now.getFullYear(), now.getMonth());
	await postWeek(panel.webview, kbRoot, now);
	await postDay(panel.webview, kbRoot, now.getFullYear(), now.getMonth(), now.getDate());
	await postTasks(panel.webview, kbRoot);
	await postDailyLog(panel.webview, kbRoot);
}

module.exports = {
	openTodayCalendarPanel,
	refreshTodayCalendarIfOpen
};
