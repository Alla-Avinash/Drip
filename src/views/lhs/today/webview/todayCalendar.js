(function () {
	const vscode = acquireVsCodeApi();

	/** @type {'calendar' | 'todayslog' | 'search' | 'tasks' | 'dailylog'} */
	let section = 'calendar';
	/** @type {'day' | 'week' | 'month'} */
	let lens = 'month';
	/** @type {'calendar' | 'files'} */
	let calendarSurface = 'calendar';
	/** @type {{ year: number, month0: number, days: any[] } | null} */
	let month = null;
	/** @type {{ weekStart: any, days: any[] } | null} */
	let week = null;
	/** @type {{ y: number, m: number, d: number } | null} */
	let selected = null;
	/** @type {'all' | 'overdue' | 'today' | 'upcoming' | 'later'} */
	let taskFilter = 'all';
	/** @type {'any' | 'tomorrow' | '2' | '7' | 'custom'} */
	let upcomingRange = 'any';
	let upcomingCustomDays = 3;
	/** @type {any} */
	let taskBoard = null;
	/** @type {any[]} */
	let dailyLogDays = [];
	/** @type {'recent' | '7' | '30' | 'custom'} */
	let dailyLogRange = 'recent';
	let dailyLogFrom = '';
	let dailyLogTo = '';
	let dailyLogOffset = 0;
	let dailyLogHasMore = false;
	let dailyLogLoading = false;
	let dailyLogSeq = 0;
	const DAILY_LOG_PAGE = 12;

	/** @type {'word' | 'semantic' | 'recommended'} */
	let searchEngine = 'recommended';
	/** @type {'all' | 'task' | 'other'} */
	let headingKind = 'all';
	let topEmbeddings = 20;
	let searchMenuOpen = false;
	let searchDebounce = null;
	let searchSeq = 0;
	let searchPending = false;
	/** @type {boolean} */
	let selectedHasNote = false;

	/** @type {{ kind: string, label: string, path: string }[]} */
	let notesRoot = [];
	/** @type {Record<string, { kind: string, label: string, path: string }[]>} */
	let notesChildren = Object.create(null);
	/** @type {Record<string, boolean>} */
	let notesExpanded = Object.create(null);
	/** @type {Record<string, boolean>} */
	let notesLoading = Object.create(null);

	const SEARCH_ENGINE_ICON_SVG =
		'<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.5 1a5.5 5.5 0 0 1 4.383 8.823l3.147 3.147-.708.708-3.147-3.147A5.5 5.5 0 1 1 6.5 1zm0 1a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z"/></svg>';

	const statusEl = document.getElementById('status');
	const monthLabel = document.getElementById('month-label');
	const grid = document.getElementById('cal-grid');
	const weekGrid = document.getElementById('week-grid');
	const weekdaysEl = document.getElementById('weekdays');
	const dayTitle = document.getElementById('day-title');
	const daySub = document.getElementById('day-sub');
	const dayPreview = document.getElementById('day-preview');
	const dueList = document.getElementById('due-list');
	const overdueList = document.getElementById('overdue-list');
	const sideDueGroup = document.getElementById('side-due-group');
	const sideOverdueGroup = document.getElementById('side-overdue-group');
	const dayHourGrid = document.getElementById('day-hour-grid');
	const searchInput = document.getElementById('search-input');
	const searchResults = document.getElementById('search-results');
	const searchAnchor = document.getElementById('search-engine-anchor');
	const openNoteBtn = document.getElementById('open-note');
	const taskCompose = document.getElementById('task-compose');
	const tasksCompose = document.getElementById('tasks-compose');
	const taskList = document.getElementById('task-board');
	const notesTreeEl = document.getElementById('notes-tree');
	const calMainBody = document.getElementById('cal-main-body');
	const calAside = document.getElementById('cal-aside');
	const fileViewPanel = document.getElementById('file-view-panel');
	const fileViewBtn = document.getElementById('file-view');
	const openTodaysLogBtn = document.getElementById('open-todays-log');
	const tlogTitle = document.getElementById('tlog-title');
	const dailyLogEl = document.getElementById('daily-log');
	const dailyLogScroll = document.getElementById('daily-log-scroll');
	const dailyLogSentinel = document.getElementById('daily-log-sentinel');
	const dailyLogFoot = document.getElementById('daily-log-foot');
	const dailyLogCustom = document.getElementById('dlog-custom');
	const upcomingHorizon = document.getElementById('upcoming-horizon');
	const upcomingCustom = document.getElementById('upcoming-custom');
	const upcomingCustomDaysInput = document.getElementById('upcoming-custom-days');
	/** @type {'calendar' | 'tasks' | null} */
	let composeTarget = null;

	function monthName(m0) {
		return [
			'January', 'February', 'March', 'April', 'May', 'June',
			'July', 'August', 'September', 'October', 'November', 'December'
		][m0] || '';
	}

	function escapeHtml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function setStatus(text) {
		if (statusEl) statusEl.textContent = text || '';
	}

	function ensureSelected() {
		if (selected) return;
		const now = new Date();
		selected = { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
	}

	function clampTopEmbeddings(raw) {
		let n = parseInt(String(raw), 10);
		if (!Number.isFinite(n) || n < 1) n = 1;
		if (n > 50) n = 50;
		return n;
	}

	function showSection(next) {
		section = next;
		document.querySelectorAll('.tabs button').forEach(btn => {
			btn.classList.toggle('active', btn.getAttribute('data-section') === section);
		});
		document.querySelectorAll('.panel').forEach(p => {
			p.classList.toggle('active', p.getAttribute('data-panel') === section);
		});
		if (section === 'calendar') {
			if (calendarSurface === 'files') showFileView();
			else requestCalendar();
		} else if (section === 'todayslog') vscode.postMessage({ type: 'loadTodaysLog' });
		else if (section === 'tasks') vscode.postMessage({ type: 'loadTasks' });
		else if (section === 'dailylog') requestDailyLog({ reset: true });
		else if (section === 'search') {
			renderSearchEngineControls();
			if (searchInput && searchInput.value.trim()) runSearch();
		}
	}

	function applyCalendarSurface() {
		const files = calendarSurface === 'files';
		if (calMainBody) calMainBody.classList.toggle('hidden', files);
		if (calAside) calAside.classList.toggle('hidden', files);
		if (fileViewPanel) fileViewPanel.classList.toggle('hidden', !files);
		if (fileViewBtn) fileViewBtn.classList.toggle('active', files);
		document.querySelectorAll('.segment button[data-lens]').forEach(btn => {
			btn.classList.toggle('active', !files && btn.getAttribute('data-lens') === lens);
		});
	}

	function showFileView() {
		calendarSurface = 'files';
		applyCalendarSurface();
		vscode.postMessage({ type: 'loadNotesTree' });
	}

	function showCalendarSurface() {
		calendarSurface = 'calendar';
		applyCalendarSurface();
		requestCalendar();
	}

	function renderTodaysLog(payload) {
		const hasNote = Boolean(payload && payload.hasNote);
		const label = payload && payload.label ? String(payload.label) : "Today's log";
		if (tlogTitle) tlogTitle.textContent = label;
		if (openTodaysLogBtn) {
			openTodaysLogBtn.textContent = hasNote ? 'Open log' : 'Create log';
		}
	}

	function renderNotesTree() {
		if (!notesTreeEl) return;
		notesTreeEl.innerHTML = '';
		if (!notesRoot.length) {
			notesTreeEl.innerHTML = '<div class="empty">No daily notes yet</div>';
			return;
		}
		for (const node of notesRoot) {
			notesTreeEl.appendChild(buildNotesNode(node, 0));
		}
	}

	function buildNotesNode(node, depth) {
		const wrap = document.createElement('div');
		const isFolder = node.kind === 'year' || node.kind === 'month';
		const expanded = Boolean(notesExpanded[node.path]);
		const row = document.createElement('button');
		row.type = 'button';
		row.className = 'notes-row' + (isFolder ? ' folder' : '');
		row.style.paddingLeft = `${6 + depth * 14}px`;
		const chevron = isFolder ? (expanded ? '▼' : '▶') : '';
		row.innerHTML =
			`<span class="notes-chevron">${chevron}</span>` +
			`<span class="notes-label">${escapeHtml(node.label || '')}</span>`;
		row.addEventListener('click', () => {
			if (node.kind === 'note') {
				vscode.postMessage({ type: 'openNotePath', path: node.path });
				return;
			}
			toggleNotesFolder(node);
		});
		wrap.appendChild(row);
		if (isFolder && expanded) {
			const kids = document.createElement('div');
			kids.className = 'notes-children';
			if (notesLoading[node.path]) {
				const loading = document.createElement('div');
				loading.className = 'empty';
				loading.style.paddingLeft = `${20 + depth * 14}px`;
				loading.textContent = 'Loading…';
				kids.appendChild(loading);
			} else {
				const list = notesChildren[node.path] || [];
				if (!list.length) {
					const empty = document.createElement('div');
					empty.className = 'empty';
					empty.style.paddingLeft = `${20 + depth * 14}px`;
					empty.textContent = 'Empty';
					kids.appendChild(empty);
				} else {
					for (const child of list) {
						kids.appendChild(buildNotesNode(child, depth + 1));
					}
				}
			}
			wrap.appendChild(kids);
		}
		return wrap;
	}

	function toggleNotesFolder(node) {
		const path = node.path;
		if (notesExpanded[path]) {
			delete notesExpanded[path];
			renderNotesTree();
			return;
		}
		notesExpanded[path] = true;
		if (notesChildren[path]) {
			renderNotesTree();
			return;
		}
		notesLoading[path] = true;
		renderNotesTree();
		vscode.postMessage({ type: 'expandNotesNode', kind: node.kind, path });
	}

	function applyNotesTreeRoot(nodes) {
		notesRoot = Array.isArray(nodes) ? nodes : [];
		notesChildren = Object.create(null);
		notesExpanded = Object.create(null);
		notesLoading = Object.create(null);
		renderNotesTree();
	}

	function applyNotesTreeChildren(msg) {
		const path = String((msg && msg.path) || '');
		if (!path) return;
		notesChildren[path] = Array.isArray(msg.nodes) ? msg.nodes : [];
		delete notesLoading[path];
		notesExpanded[path] = true;
		renderNotesTree();
	}

	function dailyLogRangeBounds() {
		const now = new Date();
		const end = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		if (dailyLogRange === '7') {
			const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
			return { fromMs: start, toMs: end };
		}
		if (dailyLogRange === '30') {
			const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29).getTime();
			return { fromMs: start, toMs: end };
		}
		if (dailyLogRange === 'custom') {
			let fromMs = null;
			let toMs = null;
			if (dailyLogFrom) {
				const p = dailyLogFrom.split('-').map(Number);
				if (p.length === 3) fromMs = new Date(p[0], p[1] - 1, p[2]).getTime();
			}
			if (dailyLogTo) {
				const p = dailyLogTo.split('-').map(Number);
				if (p.length === 3) toMs = new Date(p[0], p[1] - 1, p[2]).getTime();
			}
			return { fromMs, toMs };
		}
		return { fromMs: null, toMs: null };
	}

	function requestDailyLog(opts) {
		const reset = Boolean(opts && opts.reset);
		if (dailyLogLoading) return;
		if (!reset && !dailyLogHasMore) return;
		if (reset) {
			dailyLogOffset = 0;
			dailyLogDays = [];
			dailyLogHasMore = true;
			if (dailyLogEl) dailyLogEl.innerHTML = '<div class="empty">Loading…</div>';
			if (dailyLogFoot) dailyLogFoot.textContent = '';
		}
		dailyLogLoading = true;
		if (dailyLogFoot && !reset) dailyLogFoot.textContent = 'Loading…';
		dailyLogSeq += 1;
		const seq = dailyLogSeq;
		const bounds = dailyLogRangeBounds();
		vscode.postMessage({
			type: 'loadDailyLog',
			limit: DAILY_LOG_PAGE,
			offset: dailyLogOffset,
			fromMs: bounds.fromMs,
			toMs: bounds.toMs,
			append: !reset,
			seq
		});
	}

	function sortDailyLogNewestFirst(days) {
		return (Array.isArray(days) ? days.slice() : []).sort(
			(a, b) =>
				Number((b && b.dateMs) || 0) - Number((a && a.dateMs) || 0) ||
				String((b && b.dateKey) || '').localeCompare(String((a && a.dateKey) || ''))
		);
	}

	function appendDailyLogDays(days) {
		if (!dailyLogEl) return;
		for (const g of days || []) {
			const row = document.createElement('div');
			row.className = 'timeline-row';
			const headings = (g.headings || [])
				.map(
					h =>
						`<button type="button" class="timeline-heading" data-path="${escapeHtml(h.path || '')}" data-hid="${Number(h.headingId) || 0}">${escapeHtml(h.title || 'Untitled')}</button>`
				)
				.join('');
			row.innerHTML =
				`<div class="timeline-date">${escapeHtml(g.label || '')}</div>` +
				`<div class="timeline-rail" aria-hidden="true"><span class="timeline-dot"></span></div>` +
				`<div class="timeline-body">${headings}</div>`;
			row.querySelectorAll('.timeline-heading').forEach(btn => {
				btn.addEventListener('click', () => {
					vscode.postMessage({
						type: 'openHeading',
						path: btn.getAttribute('data-path') || '',
						headingId: Number(btn.getAttribute('data-hid')) || 0
					});
				});
			});
			dailyLogEl.appendChild(row);
		}
	}

	function renderDailyLog(opts) {
		if (!dailyLogEl) return;
		const append = Boolean(opts && opts.append);
		const incoming = sortDailyLogNewestFirst(opts && opts.days);
		if (!append) {
			dailyLogEl.innerHTML = '';
			dailyLogDays = [];
		}
		if (!incoming.length && !dailyLogDays.length) {
			dailyLogEl.innerHTML = '<div class="empty">No daily log headings in this range</div>';
		} else {
			const empty = dailyLogEl.querySelector('.empty');
			if (empty) empty.remove();
			if (append) {
				appendDailyLogDays(incoming);
				dailyLogDays = sortDailyLogNewestFirst(dailyLogDays.concat(incoming));
			} else {
				dailyLogDays = incoming;
				appendDailyLogDays(dailyLogDays);
			}
		}
		dailyLogHasMore = Boolean(opts && opts.hasMore);
		dailyLogOffset = Number(opts && opts.nextOffset) || dailyLogDays.length;
		if (dailyLogFoot) {
			if (dailyLogLoading) dailyLogFoot.textContent = 'Loading…';
			else if (dailyLogHasMore) dailyLogFoot.textContent = 'Scroll for more';
			else if (dailyLogDays.length)
				dailyLogFoot.textContent = `${dailyLogDays.length} day${dailyLogDays.length === 1 ? '' : 's'} · newest first`;
			else dailyLogFoot.textContent = '';
		}
	}

	function setDailyLogRange(next) {
		if (next !== 'recent' && next !== '7' && next !== '30' && next !== 'custom') return;
		dailyLogRange = next;
		document.querySelectorAll('[data-dlog-range]').forEach(btn => {
			btn.classList.toggle('active', btn.getAttribute('data-dlog-range') === dailyLogRange);
		});
		if (dailyLogCustom) dailyLogCustom.classList.toggle('hidden', dailyLogRange !== 'custom');
		if (dailyLogRange !== 'custom') requestDailyLog({ reset: true });
	}

	function setLens(next) {
		lens = next;
		calendarSurface = 'calendar';
		applyCalendarSurface();
		if (grid) grid.classList.toggle('hidden', lens !== 'month');
		if (weekdaysEl) weekdaysEl.classList.toggle('hidden', lens !== 'month');
		if (weekGrid) weekGrid.classList.toggle('hidden', lens !== 'week');
		const dayFocus = document.getElementById('day-lens-block');
		if (dayFocus) dayFocus.classList.toggle('hidden', lens !== 'day');
		updateRangeNavLabels();
		requestCalendar();
	}

	function requestCalendar() {
		ensureSelected();
		if (lens === 'month') {
			vscode.postMessage({ type: 'loadMonth', year: selected.y, month0: selected.m });
		} else if (lens === 'week') {
			vscode.postMessage({
				type: 'loadWeek',
				year: selected.y,
				month0: selected.m,
				day: selected.d
			});
		} else {
			vscode.postMessage({
				type: 'selectDay',
				year: selected.y,
				month0: selected.m,
				day: selected.d
			});
			updateNavLabel();
		}
	}

	function updateNavLabel() {
		if (!monthLabel || !selected) return;
		if (lens === 'month' && month) {
			monthLabel.textContent = `${monthName(month.month0)} ${month.year}`;
		} else if (lens === 'week' && week && week.days && week.days.length) {
			monthLabel.textContent = `${week.days[0].label} – ${week.days[6].label}`;
		} else {
			const d = new Date(selected.y, selected.m, selected.d);
			monthLabel.textContent = d.toLocaleDateString(undefined, {
				weekday: 'short',
				month: 'short',
				day: 'numeric',
				year: 'numeric'
			});
		}
	}

	function updateRangeNavLabels() {
		const unit = lens === 'month' ? 'month' : lens === 'week' ? 'week' : 'day';
		const prev = document.getElementById('prev-range');
		const next = document.getElementById('next-range');
		if (prev) {
			prev.title = `Previous ${unit}`;
			prev.setAttribute('aria-label', `Previous ${unit}`);
		}
		if (next) {
			next.title = `Next ${unit}`;
			next.setAttribute('aria-label', `Next ${unit}`);
		}
	}

	function selectDay(y, m, d) {
		selected = { y, m, d };
		renderMonthGrid();
		renderWeekGrid();
		vscode.postMessage({ type: 'selectDay', year: y, month0: m, day: d });
		if (lens === 'day') updateNavLabel();
	}

	function renderMonthGrid() {
		if (!month || !grid || lens !== 'month') return;
		grid.innerHTML = '';
		const first = new Date(month.year, month.month0, 1);
		const startPad = first.getDay();
		const lastDay = new Date(month.year, month.month0 + 1, 0).getDate();
		const today = new Date();
		const byDay = new Map(month.days.map(d => [d.day, d]));
		for (let i = 0; i < startPad; i++) {
			const cell = document.createElement('button');
			cell.type = 'button';
			cell.className = 'day outside';
			cell.disabled = true;
			grid.appendChild(cell);
		}
		for (let day = 1; day <= lastDay; day++) {
			const info = byDay.get(day) || { day, hasNote: false, taskCount: 0 };
			const cell = document.createElement('button');
			cell.type = 'button';
			cell.className = 'day';
			if (
				selected &&
				selected.y === month.year &&
				selected.m === month.month0 &&
				selected.d === day
			) {
				cell.classList.add('selected');
			}
			if (
				today.getFullYear() === month.year &&
				today.getMonth() === month.month0 &&
				today.getDate() === day
			) {
				cell.classList.add('today-mark');
			}
			cell.innerHTML =
				`<span class="num">${day}</span><span class="dots">` +
				(info.hasNote ? '<span class="dot" title="Log"></span>' : '') +
				(info.taskCount > 0 ? '<span class="dot task" title="Tasks"></span>' : '') +
				`</span>`;
			cell.addEventListener('click', () => selectDay(month.year, month.month0, day));
			grid.appendChild(cell);
		}
		updateNavLabel();
	}

	function renderWeekGrid() {
		if (!week || !weekGrid || lens !== 'week') return;
		weekGrid.innerHTML = '';
		for (const d of week.days) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'week-day';
			if (
				selected &&
				selected.y === d.year &&
				selected.m === d.month0 &&
				selected.d === d.day
			) {
				btn.classList.add('selected');
			}
			btn.innerHTML =
				`<span class="wd-label">${escapeHtml(String(d.label || '').split(',')[0] || '')}</span>` +
				`<span class="wd-num">${d.day}</span>` +
				`<span class="dots">` +
				(d.hasNote ? '<span class="dot" title="Day log"></span>' : '') +
				(d.taskCount > 0 ? '<span class="dot task" title="Pending tasks"></span>' : '') +
				`</span>`;
			btn.addEventListener('click', () => selectDay(d.year, d.month0, d.day));
			weekGrid.appendChild(btn);
		}
		updateNavLabel();
	}

	function renderDayDetail(payload) {
		const label = payload && payload.label ? String(payload.label) : 'Select a day';
		selectedHasNote = Boolean(payload && payload.hasNote);
		if (dayTitle) dayTitle.textContent = label;
		if (daySub) {
			daySub.textContent = selectedHasNote ? 'Day log' : 'No log yet';
		}
		if (dayPreview) {
			const preview = payload && payload.preview ? String(payload.preview) : '';
			dayPreview.textContent = preview || '';
		}
		if (openNoteBtn) {
			openNoteBtn.textContent = selectedHasNote ? 'Open log' : 'Create log';
		}
		const due = (payload && payload.dueToday) || [];
		const overdue = (payload && payload.overdue) || [];
		renderDayHourTimeline(due);
		fillSimpleTasks(dueList, due, 'None', { showTime: false });
		fillSimpleTasks(overdueList, overdue, 'None', { showTime: false });
		if (sideDueGroup) sideDueGroup.classList.remove('hidden');
		if (sideOverdueGroup) sideOverdueGroup.classList.remove('hidden');
	}

	function hourLabel(hour) {
		const h = ((hour % 24) + 24) % 24;
		const suffix = h < 12 ? 'AM' : 'PM';
		const twelve = h % 12 === 0 ? 12 : h % 12;
		return `${twelve} ${suffix}`;
	}

	function renderDayHourTimeline(dueTasks) {
		if (!dayHourGrid) return;
		dayHourGrid.innerHTML = '';
		/** @type {Map<number, any[]>} */
		const byHour = new Map();
		for (let h = 0; h < 24; h++) byHour.set(h, []);
		for (const t of dueTasks || []) {
			const d = deadlineToDate(t.deadline);
			const hour = d ? d.getHours() : 9;
			const bucket = byHour.get(hour) || byHour.get(9);
			bucket.push(t);
		}
		for (let h = 0; h < 24; h++) {
			const row = document.createElement('div');
			row.className = 'day-hour-row';
			row.setAttribute('role', 'listitem');
			const tasks = byHour.get(h) || [];
			const chips = tasks
				.map(
					t =>
						`<button type="button" class="day-hour-task" data-path="${escapeHtml(t.path || '')}" data-hid="${Number(t.headingId) || 0}">` +
						`<span class="day-hour-task-title">${escapeHtml(t.title || 'Untitled')}</span>` +
						`${pill(t.priority)}` +
						`</button>`
				)
				.join('');
			row.innerHTML =
				`<div class="day-hour-label">${hourLabel(h)}</div>` +
				`<div class="day-hour-slot">${chips || '<span class="day-hour-empty"></span>'}</div>`;
			row.querySelectorAll('.day-hour-task').forEach(btn => {
				btn.addEventListener('click', () => {
					vscode.postMessage({
						type: 'openTask',
						path: btn.getAttribute('data-path') || '',
						headingId: Number(btn.getAttribute('data-hid')) || 0
					});
				});
			});
			dayHourGrid.appendChild(row);
		}
	}

	function jumpToToday() {
		const now = new Date();
		selected = { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
		requestCalendar();
	}

	function composeFieldIds() {
		const isTasks = composeTarget === 'tasks';
		return {
			title: isTasks ? 'tasksComposeTitle' : 'composeTitle',
			deadline: isTasks ? 'tasksComposeDeadline' : 'composeDeadline',
			priority: isTasks ? 'tasksComposePriority' : 'composePriority'
		};
	}

	function openCompose(target) {
		composeTarget = target === 'tasks' ? 'tasks' : 'calendar';
		if (taskCompose) taskCompose.classList.toggle('hidden', composeTarget !== 'calendar');
		if (tasksCompose) tasksCompose.classList.toggle('hidden', composeTarget !== 'tasks');
		const ids = composeFieldIds();
		const titleEl = document.getElementById(ids.title);
		const deadlineEl = document.getElementById(ids.deadline);
		const priEl = document.getElementById(ids.priority);
		if (titleEl) titleEl.value = '';
		if (deadlineEl) deadlineEl.value = '';
		if (priEl) priEl.value = '';
		if (titleEl) {
			titleEl.focus();
			titleEl.select();
		}
	}

	function closeCompose() {
		composeTarget = null;
		if (taskCompose) taskCompose.classList.add('hidden');
		if (tasksCompose) tasksCompose.classList.add('hidden');
	}

	function requestDeadlineNormalize(fieldId) {
		const el = document.getElementById(fieldId);
		if (!el) return;
		const raw = String(el.value || '').trim();
		if (!raw || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)) return;
		vscode.postMessage({ type: 'normalizeDatetime', field: fieldId, value: raw });
	}

	function submitCompose() {
		if (!composeTarget) return;
		const isTasks = composeTarget === 'tasks';
		const ids = composeFieldIds();
		const titleEl = document.getElementById(ids.title);
		const deadlineEl = document.getElementById(ids.deadline);
		const priEl = document.getElementById(ids.priority);
		const title = titleEl ? String(titleEl.value || '').trim() : '';
		if (!title) {
			if (titleEl) titleEl.focus();
			return;
		}
		const deadline = deadlineEl ? String(deadlineEl.value || '').trim() : '';
		const priority = priEl ? String(priEl.value || '').trim() : '';
		ensureSelected();
		const now = new Date();
		const y = isTasks ? now.getFullYear() : selected.y;
		const m = isTasks ? now.getMonth() : selected.m;
		const d = isTasks ? now.getDate() : selected.d;
		closeCompose();
		vscode.postMessage({
			type: 'addTask',
			year: y,
			month0: m,
			day: d,
			title,
			deadline,
			priority
		});
	}

	function wireComposeDeadline(fieldId) {
		const el = document.getElementById(fieldId);
		if (!el) return;
		el.addEventListener('blur', () => requestDeadlineNormalize(fieldId));
		el.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				el.blur();
			}
		});
	}

	function bindTaskRow(row, t) {
		row.querySelector('[data-act="done"]')?.addEventListener('click', e => {
			e.stopPropagation();
			vscode.postMessage({
				type: 'completeTask',
				path: t.path,
				headingId: t.headingId
			});
		});
		row.querySelector('.body')?.addEventListener('click', () => {
			vscode.postMessage({ type: 'openTask', path: t.path, headingId: t.headingId });
		});
	}

	function fillSimpleTasks(el, tasks, emptyLabel, opts) {
		if (!el) return;
		const showTime = Boolean(opts && opts.showTime);
		el.innerHTML = '';
		if (!tasks.length) {
			el.innerHTML = `<li class="empty">${escapeHtml(emptyLabel)}</li>`;
			return;
		}
		for (const t of tasks) {
			const li = document.createElement('li');
			li.className = 'task-row';
			const when = showTime ? timePill(t.deadline) : deadlinePill(t.deadline);
			li.innerHTML =
				`<div class="body"><div class="task-title">${escapeHtml(t.title || 'Untitled')}</div>` +
				`<div class="meta">${pill(t.status)}${pill(t.priority)}${when}</div></div>` +
				`<div class="row-actions"><button type="button" class="tint" data-act="done">Done</button></div>`;
			bindTaskRow(li, t);
			el.appendChild(li);
		}
	}

	function pill(v) {
		return v ? `<span class="pill">${escapeHtml(v)}</span>` : '';
	}

	function deadlineToDate(raw) {
		if (raw == null || !Number.isFinite(Number(raw))) return null;
		let ms = Number(raw);
		if (ms > 0 && ms < 1e12) ms *= 1000;
		const d = new Date(ms);
		return Number.isNaN(d.getTime()) ? null : d;
	}

	function deadlinePill(raw) {
		const d = deadlineToDate(raw);
		if (!d) return '';
		return `<span class="pill">${escapeHtml(d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span>`;
	}

	function timePill(raw) {
		const d = deadlineToDate(raw);
		if (!d) return '';
		return `<span class="pill time">${escapeHtml(d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}</span>`;
	}

	function shiftRange(dir) {
		ensureSelected();
		const d = new Date(selected.y, selected.m, selected.d);
		if (lens === 'month') d.setMonth(d.getMonth() + dir);
		else if (lens === 'week') d.setDate(d.getDate() + dir * 7);
		else d.setDate(d.getDate() + dir);
		selected = { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
		requestCalendar();
	}

	function renderSearchEngineControls() {
		if (!searchAnchor) return;
		const highlight = searchEngine !== 'recommended';
		let menu = '';
		if (searchMenuOpen) {
			menu =
				'<div class="menu-panel" role="dialog" aria-label="Search engine">' +
				'<div class="gs-label">Search engine</div>' +
				'<select id="todaySearchEngine" class="proj-select" aria-label="How results are ranked">' +
				'<option value="recommended"' +
				(searchEngine === 'recommended' ? ' selected' : '') +
				'>Recommended</option>' +
				'<option value="semantic"' +
				(searchEngine === 'semantic' ? ' selected' : '') +
				'>Only semantic search</option>' +
				'<option value="word"' +
				(searchEngine === 'word' ? ' selected' : '') +
				'>Only word search</option>' +
				'</select>';
			if (searchEngine !== 'word') {
				menu +=
					'<div class="gs-label search-engine-top-label">Top embeddings</div>' +
					'<input type="number" id="todayTopEmbeddings" class="top-emb-input" min="1" max="50" step="1" value="' +
					topEmbeddings +
					'" aria-label="Top embeddings to show" />';
			}
			menu += '</div>';
		}
		searchAnchor.innerHTML =
			'<button type="button" class="ghost search-type-btn' +
			(searchMenuOpen ? ' open' : '') +
			(highlight ? ' has-engine' : '') +
			'" id="todaySearchType" title="Search engine" aria-label="Search engine" aria-haspopup="true" aria-expanded="' +
			(searchMenuOpen ? 'true' : 'false') +
			'">' +
			SEARCH_ENGINE_ICON_SVG +
			'</button>' +
			menu;

		const typeBtn = document.getElementById('todaySearchType');
		typeBtn?.addEventListener('click', e => {
			e.stopPropagation();
			searchMenuOpen = !searchMenuOpen;
			renderSearchEngineControls();
		});
		const engSel = document.getElementById('todaySearchEngine');
		engSel?.addEventListener('click', e => e.stopPropagation());
		engSel?.addEventListener('change', () => {
			const t = engSel.value || 'recommended';
			searchEngine = t === 'semantic' ? 'semantic' : t === 'word' ? 'word' : 'recommended';
			runSearch();
			renderSearchEngineControls();
		});
		const topInput = document.getElementById('todayTopEmbeddings');
		topInput?.addEventListener('click', e => e.stopPropagation());
		topInput?.addEventListener('change', () => {
			topEmbeddings = clampTopEmbeddings(topInput.value);
			topInput.value = String(topEmbeddings);
			runSearch();
		});
	}

	function runSearch() {
		clearTimeout(searchDebounce);
		const q = searchInput ? searchInput.value.trim() : '';
		if (!q) {
			searchPending = false;
			if (searchResults) searchResults.innerHTML = '';
			return;
		}
		searchPending = true;
		searchDebounce = setTimeout(() => {
			const seq = ++searchSeq;
			if (searchResults) searchResults.innerHTML = '';
			vscode.postMessage({
				type: 'search',
				query: q,
				searchEngine,
				topN: topEmbeddings,
				headingKind,
				seq
			});
		}, 200);
	}

	function renderSearchResults(rows, seq) {
		if (seq != null && seq !== searchSeq) return;
		searchPending = false;
		if (!searchResults) return;
		searchResults.innerHTML = '';
		if (!rows || !rows.length) {
			if (searchInput && searchInput.value.trim()) {
				searchResults.innerHTML = '<li class="empty">No matches</li>';
			}
			return;
		}
		for (const r of rows) {
			const li = document.createElement('li');
			const shown = r.displayPath || r.path || '';
			li.innerHTML =
				`<div class="task-title">${escapeHtml(r.title || 'Untitled')}</div>` +
				`<div class="meta">${pill(r.type || 'heading')}<span>${escapeHtml(shown)}</span></div>`;
			li.addEventListener('click', () => {
				vscode.postMessage({
					type: 'openHeading',
					path: r.path,
					headingId: r.headingId
				});
			});
			searchResults.appendChild(li);
		}
	}

	function setHeadingKind(next) {
		headingKind = next;
		document.querySelectorAll('[data-heading-kind]').forEach(btn => {
			btn.classList.toggle('active', btn.getAttribute('data-heading-kind') === headingKind);
		});
		runSearch();
	}

	function setTaskFilter(next) {
		taskFilter = next;
		document.querySelectorAll('#task-filter-chips button').forEach(btn => {
			btn.classList.toggle('active', btn.getAttribute('data-filter') === taskFilter);
		});
		updateUpcomingHorizonVisibility();
		renderTaskBoard();
	}

	function updateUpcomingHorizonVisibility() {
		const show = taskFilter === 'upcoming';
		if (upcomingHorizon) upcomingHorizon.classList.toggle('hidden', !show);
		if (upcomingCustom) {
			upcomingCustom.classList.toggle('hidden', !show || upcomingRange !== 'custom');
		}
	}

	function setUpcomingRange(next) {
		if (
			next !== 'any' &&
			next !== 'tomorrow' &&
			next !== '2' &&
			next !== '7' &&
			next !== 'custom'
		) {
			return;
		}
		upcomingRange = next;
		document.querySelectorAll('#upcoming-range-chips button').forEach(btn => {
			btn.classList.toggle('active', btn.getAttribute('data-upcoming-range') === upcomingRange);
		});
		if (upcomingCustom) upcomingCustom.classList.toggle('hidden', upcomingRange !== 'custom');
		if (upcomingRange !== 'custom') renderTaskBoard();
	}

	function clampUpcomingDays(raw) {
		let n = parseInt(String(raw), 10);
		if (!Number.isFinite(n) || n < 1) n = 1;
		if (n > 365) n = 365;
		return n;
	}

	/**
	 * Upcoming deadlines after end-of-today, limited to the next N calendar days.
	 * @param {any[]} items
	 * @param {number | null} daysAhead null = any upcoming
	 */
	function filterUpcomingByHorizon(items, daysAhead) {
		const sorted = sortTasksByDeadline(items);
		if (daysAhead == null) return sorted;
		const asOf = Number(taskBoard && taskBoard.asOf);
		const todayStart = Number.isFinite(asOf)
			? asOf
			: new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
		const dayMs = 24 * 60 * 60 * 1000;
		const windowEnd = todayStart + (daysAhead + 1) * dayMs;
		return sorted.filter(t => {
			const d = Number(t && t.deadline);
			return Number.isFinite(d) && d < windowEnd;
		});
	}

	function sortTasksByDeadline(items) {
		return (Array.isArray(items) ? items.slice() : []).sort(
			(a, b) =>
				Number((a && a.deadline) || 0) - Number((b && b.deadline) || 0) ||
				String((a && a.title) || '').localeCompare(String((b && b.title) || ''))
		);
	}

	function upcomingHorizonDays() {
		if (upcomingRange === 'any') return null;
		if (upcomingRange === 'tomorrow') return 1;
		if (upcomingRange === '2') return 2;
		if (upcomingRange === '7') return 7;
		if (upcomingRange === 'custom') return clampUpcomingDays(upcomingCustomDays);
		return null;
	}

	function upcomingHorizonLabel() {
		const days = upcomingHorizonDays();
		if (days == null) return 'Upcoming';
		if (days === 1) return 'Tomorrow';
		if (days === 2) return 'Next 2 days';
		if (days === 7) return 'Next week';
		return `Next ${days} days`;
	}

	function renderTaskBoard() {
		if (!taskList || !taskBoard) return;
		updateUpcomingHorizonVisibility();
		const buckets = {
			overdue: sortTasksByDeadline(taskBoard.overdue || []),
			today: sortTasksByDeadline(taskBoard.dueToday || []),
			upcoming: filterUpcomingByHorizon(taskBoard.upcoming || [], upcomingHorizonDays()),
			later: Array.isArray(taskBoard.noDeadline) ? taskBoard.noDeadline.slice() : []
		};
		/** @type {{ key: string, label: string, items: any[] }[]} */
		let groups = [];
		if (taskFilter === 'all') {
			groups = [
				{ key: 'overdue', label: 'Overdue', items: buckets.overdue },
				{ key: 'today', label: 'Today', items: buckets.today },
				{
					key: 'upcoming',
					label: 'Upcoming',
					items: filterUpcomingByHorizon(taskBoard.upcoming || [], null)
				},
				{ key: 'later', label: 'Later', items: buckets.later }
			];
		} else if (taskFilter === 'upcoming') {
			groups = [
				{
					key: 'upcoming',
					label: upcomingHorizonLabel(),
					items: buckets.upcoming
				}
			];
		} else {
			const map = {
				overdue: 'Overdue',
				today: 'Today',
				later: 'Later'
			};
			groups = [{ key: taskFilter, label: map[taskFilter], items: buckets[taskFilter] || [] }];
		}
		taskList.innerHTML = '';
		let any = false;
		for (const g of groups) {
			if (!g.items.length && taskFilter === 'all') continue;
			any = true;
			const wrap = document.createElement('div');
			wrap.className = `task-group ${g.key}`;
			const head = document.createElement('div');
			head.className = 'section-label';
			head.textContent = `${g.label} (${g.items.length})`;
			wrap.appendChild(head);
			if (!g.items.length) {
				const empty = document.createElement('div');
				empty.className = 'empty';
				empty.textContent = 'Nothing here';
				wrap.appendChild(empty);
			} else {
				for (const t of g.items) {
					wrap.appendChild(taskBoardRow(t));
				}
			}
			taskList.appendChild(wrap);
		}
		if (!any) {
			taskList.innerHTML = '<div class="empty">No open tasks</div>';
		}
	}

	function taskBoardRow(t) {
		const row = document.createElement('div');
		row.className = 'task-row';
		const shown = t.displayPath || t.path || '';
		row.innerHTML =
			`<div class="body">` +
			`<div class="task-title">${escapeHtml(t.title || 'Untitled')}</div>` +
			`<div class="meta">${pill(t.status || 'to-do')}${pill(t.priority)}${deadlinePill(t.deadline)}` +
			`<span>${escapeHtml(shown)}</span></div></div>` +
			`<div class="row-actions">` +
			`<button type="button" class="tint" data-act="done">Done</button>` +
			`</div>`;
		bindTaskRow(row, t);
		return row;
	}

	document.querySelectorAll('.tabs button').forEach(btn => {
		btn.addEventListener('click', () => {
			const s = btn.getAttribute('data-section');
			if (
				s === 'calendar' ||
				s === 'todayslog' ||
				s === 'search' ||
				s === 'tasks' ||
				s === 'dailylog'
			) {
				showSection(s);
			}
		});
	});
	openTodaysLogBtn?.addEventListener('click', () => {
		vscode.postMessage({ type: 'openTodaysLog' });
	});
	document.querySelectorAll('.segment button[data-lens]').forEach(btn => {
		btn.addEventListener('click', () => {
			const l = btn.getAttribute('data-lens');
			if (l === 'day' || l === 'week' || l === 'month') setLens(l);
		});
	});
	fileViewBtn?.addEventListener('click', () => {
		if (calendarSurface === 'files') showCalendarSurface();
		else showFileView();
	});
	document.querySelectorAll('#task-filter-chips button').forEach(btn => {
		btn.addEventListener('click', () => {
			const f = btn.getAttribute('data-filter');
			if (f === 'all' || f === 'overdue' || f === 'today' || f === 'upcoming' || f === 'later') {
				setTaskFilter(f);
			}
		});
	});
	document.querySelectorAll('#upcoming-range-chips button').forEach(btn => {
		btn.addEventListener('click', () => {
			const r = btn.getAttribute('data-upcoming-range');
			if (r === 'any' || r === 'tomorrow' || r === '2' || r === '7' || r === 'custom') {
				setUpcomingRange(r);
			}
		});
	});
	document.getElementById('upcoming-custom-apply')?.addEventListener('click', () => {
		upcomingCustomDays = clampUpcomingDays(
			upcomingCustomDaysInput ? upcomingCustomDaysInput.value : upcomingCustomDays
		);
		if (upcomingCustomDaysInput) upcomingCustomDaysInput.value = String(upcomingCustomDays);
		renderTaskBoard();
	});
	upcomingCustomDaysInput?.addEventListener('keydown', e => {
		if (e.key === 'Enter') {
			e.preventDefault();
			document.getElementById('upcoming-custom-apply')?.click();
		}
	});
	document.querySelectorAll('[data-dlog-range]').forEach(btn => {
		btn.addEventListener('click', () => {
			const r = btn.getAttribute('data-dlog-range');
			if (r === 'recent' || r === '7' || r === '30' || r === 'custom') setDailyLogRange(r);
		});
	});
	document.getElementById('dlog-apply')?.addEventListener('click', () => {
		const fromEl = document.getElementById('dlog-from');
		const toEl = document.getElementById('dlog-to');
		dailyLogFrom = fromEl ? String(fromEl.value || '') : '';
		dailyLogTo = toEl ? String(toEl.value || '') : '';
		requestDailyLog({ reset: true });
	});
	document.getElementById('prev-range')?.addEventListener('click', () => shiftRange(-1));
	document.getElementById('next-range')?.addEventListener('click', () => shiftRange(1));
	document.getElementById('jump-today')?.addEventListener('click', () => {
		if (calendarSurface === 'files') showCalendarSurface();
		jumpToToday();
	});
	document.getElementById('add-side-task')?.addEventListener('click', () => openCompose('calendar'));
	document.getElementById('add-task')?.addEventListener('click', () => openCompose('tasks'));
	document.getElementById('composeSubmit')?.addEventListener('click', () => submitCompose());
	document.getElementById('composeCancel')?.addEventListener('click', () => closeCompose());
	document.getElementById('tasksComposeSubmit')?.addEventListener('click', () => submitCompose());
	document.getElementById('tasksComposeCancel')?.addEventListener('click', () => closeCompose());
	wireComposeDeadline('composeDeadline');
	wireComposeDeadline('tasksComposeDeadline');
	document.getElementById('composeTitle')?.addEventListener('keydown', e => {
		if (e.key === 'Enter') {
			e.preventDefault();
			submitCompose();
		} else if (e.key === 'Escape') {
			closeCompose();
		}
	});
	document.getElementById('tasksComposeTitle')?.addEventListener('keydown', e => {
		if (e.key === 'Enter') {
			e.preventDefault();
			submitCompose();
		} else if (e.key === 'Escape') {
			closeCompose();
		}
	});
	openNoteBtn?.addEventListener('click', () => {
		ensureSelected();
		vscode.postMessage({
			type: 'openOrCreateNote',
			year: selected.y,
			month0: selected.m,
			day: selected.d
		});
	});
	document.getElementById('refresh')?.addEventListener('click', () => {
		vscode.postMessage({ type: 'refresh', section, lens });
		if (section === 'todayslog') vscode.postMessage({ type: 'loadTodaysLog' });
		else if (section === 'tasks') vscode.postMessage({ type: 'loadTasks' });
		else if (section === 'dailylog') requestDailyLog({ reset: true });
		else if (section === 'calendar' && calendarSurface === 'files') {
			vscode.postMessage({ type: 'loadNotesTree' });
		}
	});
	if (dailyLogSentinel && typeof IntersectionObserver === 'function') {
		const io = new IntersectionObserver(
			entries => {
				if (section !== 'dailylog') return;
				if (!entries.some(e => e.isIntersecting)) return;
				requestDailyLog({ reset: false });
			},
			{ root: dailyLogScroll || null, rootMargin: '120px', threshold: 0 }
		);
		io.observe(dailyLogSentinel);
	} else if (dailyLogScroll) {
		dailyLogScroll.addEventListener('scroll', () => {
			if (section !== 'dailylog' || dailyLogLoading || !dailyLogHasMore) return;
			const nearBottom =
				dailyLogScroll.scrollTop + dailyLogScroll.clientHeight >=
				dailyLogScroll.scrollHeight - 80;
			if (nearBottom) requestDailyLog({ reset: false });
		});
	}
	document.querySelectorAll('[data-heading-kind]').forEach(btn => {
		btn.addEventListener('click', () => {
			const k = btn.getAttribute('data-heading-kind');
			if (k === 'all' || k === 'task' || k === 'other') setHeadingKind(k);
		});
	});
	searchInput?.addEventListener('input', () => runSearch());
	searchInput?.addEventListener('keydown', e => {
		if (e.key === 'Enter') runSearch();
	});
	document.addEventListener('click', () => {
		if (searchMenuOpen) {
			searchMenuOpen = false;
			renderSearchEngineControls();
		}
	});

	window.addEventListener('message', event => {
		const msg = event.data || {};
		if (msg.type === 'month') {
			month = msg.month;
			ensureSelected();
			if (lens === 'month') {
				renderMonthGrid();
				vscode.postMessage({
					type: 'selectDay',
					year: selected.y,
					month0: selected.m,
					day: selected.d
				});
			}
			setStatus('');
		} else if (msg.type === 'week') {
			week = msg.week;
			if (lens === 'week') {
				renderWeekGrid();
				vscode.postMessage({
					type: 'selectDay',
					year: selected.y,
					month0: selected.m,
					day: selected.d
				});
			}
		} else if (msg.type === 'day') {
			renderDayDetail(msg);
		} else if (msg.type === 'searchResults') {
			renderSearchResults(msg.rows || [], msg.seq);
		} else if (msg.type === 'taskBoard') {
			taskBoard = msg.board || null;
			renderTaskBoard();
			setStatus('');
		} else if (msg.type === 'todaysLog') {
			renderTodaysLog(msg);
			setStatus('');
		} else if (msg.type === 'dailyLog') {
			if (Number(msg.seq) && Number(msg.seq) !== dailyLogSeq) return;
			dailyLogLoading = false;
			renderDailyLog({
				days: Array.isArray(msg.days) ? msg.days : [],
				hasMore: Boolean(msg.hasMore),
				nextOffset: Number(msg.nextOffset) || 0,
				append: Boolean(msg.append)
			});
			setStatus('');
		} else if (msg.type === 'notesTreeRoot') {
			applyNotesTreeRoot(msg.nodes || []);
			setStatus('');
		} else if (msg.type === 'notesTreeChildren') {
			applyNotesTreeChildren(msg);
		} else if (msg.type === 'datetimeNormalized') {
			const field = String(msg.field || '');
			const value = String(msg.value || '');
			const el = field ? document.getElementById(field) : null;
			if (el && value) el.value = value;
		} else if (msg.type === 'status') {
			setStatus(String(msg.text || ''));
		} else if (msg.type === 'error') {
			setStatus(String(msg.text || 'Error'));
		}
	});

	showSection('calendar');
	setLens('month');
	renderSearchEngineControls();
	vscode.postMessage({ type: 'ready' });
})();
