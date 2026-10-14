// @ts-check
(function () {
	const vscode = acquireVsCodeApi();
	const DF = window.DripFilter || null;

	/** @type {any[]} */
	let projects = [];
	let selectedPrefix = '';
	let selectedTitle = '';
	/** @type {{ features: any[], issues: any[] }} */
	let detail = { features: [], issues: [] };
	let detailLoading = false;

	/** Per-project tags for the Tags popover. */
	/** @type {any[]} */
	let projectTags = [];
	let tagsPopoverOpen = false;
	/** @type {HTMLElement | null} */
	let tagsPopoverEl = null;

	// Field schema from the host (enum values read from DRIP settings).
	let schema = { project: { fields: [] }, issue: { fields: [] } };
	/** @type {any[]} */
	let projectFields = [];
	/** @type {any[]} */
	let issueFields = [];

	// Project list query / filter / display / group-sort state.
	let projectQuery = '';
	/** @type {Record<string, string[]>} */
	let projectFilters = {};
	/** @type {Record<string, boolean>} */
	let projectDisplay = {};
	let projectView = 'list'; // 'list' | 'board'

	// Issue detail search (filters issues within an open project).
	let issueQuery = '';

	// Project detail view mode: 'features' (grouped sections, default) or 'issues' (flat browser).
	let detailView = 'features';

	// Issues-view toolbar state (mirrors the project-list toolbar, but for the project's issues).
	let issuesQuery = '';
	/** @type {Record<string, string[]>} */
	let issuesFilters = {};
	/** @type {Record<string, boolean>} */
	let issuesDisplay = {};
	let issuesView = 'list'; // 'list' | 'board'
	let issuesListGroupBy = '';
	let issuesListOrderBy = 'title';
	let issuesListOrderDir = 'asc';
	let issuesBoardColumnBy = '';
	let issuesBoardRowBy = '';
	let issuesBoardOrderBy = 'title';
	let issuesBoardOrderDir = 'asc';
	/** @type {Set<string>} */
	const collapsedIssuesListGroups = new Set();
	/** @type {Set<string>} */
	const collapsedIssuesBoardRows = new Set();

	// Issues-view dropdown UI state (kept separate from the project-list menus).
	let openIssuesMenu = ''; // '', 'filter', 'display', 'groupsort'
	let openIssuesFilterField = '';
	let openIssuesChipField = '';

	// List view state.
	let listGroupBy = '';
	let listOrderBy = 'title';
	let listOrderDir = 'asc';

	// Board view state.
	let boardColumnBy = '';
	let boardRowBy = '';
	let boardOrderBy = 'title';
	let boardOrderDir = 'asc';

	// Collapsible group/row state (persists across re-renders).
	/** @type {Set<string>} */
	const collapsedListGroups = new Set();
	/** @type {Set<string>} */
	const collapsedBoardRows = new Set();

	// Dropdown UI state.
	let openMenu = ''; // '', 'filter', 'display', 'groupsort'
	let openFilterField = '';
	let openChipField = ''; // field id whose inline chip popover is open
	let openIssuePopover = ''; // project folderPrefix whose issue breakdown is open

	// Issue-row inline action state (detail view).
	let inlineSubKey = ''; // issueKey with an open inline sub-issue form
	let showParentChain = false; // show a sub-issue's parent hierarchy as dimmed rows when its parent lives elsewhere

	/** @type {{ parentIssueId: string, label: string } | null} */
	let compose = null;

	const PRESETS = {
		'1d': { label: 'Next 1 day', seconds: 86400 },
		'3d': { label: 'Next 3 days', seconds: 3 * 86400 },
		'1w': { label: 'Next 1 week', seconds: 7 * 86400 },
		'2w': { label: 'Next 2 weeks', seconds: 14 * 86400 },
		'1m': { label: 'Next 1 month', seconds: 30 * 86400 },
		'3m': { label: 'Next 3 months', seconds: 90 * 86400 },
		'6m': { label: 'Next 6 months', seconds: 180 * 86400 },
		'9m': { label: 'Next 9 months', seconds: 270 * 86400 },
		'1y': { label: 'Next 1 year', seconds: 365 * 86400 }
	};

	const kbMeta = document.getElementById('kbMeta');
	const root = document.getElementById('root');
	const btnRefresh = document.getElementById('btnRefresh');

	if (!kbMeta || !root || !btnRefresh) {
		return;
	}

	btnRefresh.addEventListener('click', function () {
		vscode.postMessage({ type: 'refresh' });
	});

	// ---- helpers ---------------------------------------------------------

	/**
	 * @param {unknown} s
	 */
	function esc(s) {
		return String(s == null ? '' : s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	/**
	 * @param {number} unixSeconds
	 */
	function formatDate(unixSeconds) {
		const d = new Date(unixSeconds * 1000);
		if (Number.isNaN(d.getTime())) return '';
		return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}

	/**
	 * Quarter bucket for a deadline, e.g. "2026 Q1".
	 * @param {number} unixSeconds
	 */
	function quarterLabel(unixSeconds) {
		const d = new Date(unixSeconds * 1000);
		if (Number.isNaN(d.getTime())) return '';
		return d.getFullYear() + ' Q' + (Math.floor(d.getMonth() / 3) + 1);
	}

	/** Fields that can be filtered (enum + datetime). */
	function filterableFields(fields) {
		return (fields || projectFields).filter(function (f) {
			return f.kind === 'enum' || f.kind === 'datetime';
		});
	}

	/** Fields that can be shown/hidden (everything except title). */
	function displayableFields(fields) {
		return (fields || projectFields).filter(function (f) {
			return f.id !== 'title';
		});
	}

	/** Fields that can be grouped by (enum + datetime). */
	function groupableFields(fields) {
		return (fields || projectFields).filter(function (f) {
			return f.kind === 'enum' || f.kind === 'datetime';
		});
	}

	/** Total selected filter values across all fields. */
	function activeFilterCount() {
		let n = 0;
		projectFields.forEach(function (f) {
			n += (projectFilters[f.id] || []).length;
		});
		return n;
	}

	/** Number of fields currently hidden from display. */
	function hiddenFieldCount() {
		let n = 0;
		displayableFields().forEach(function (f) {
			if (projectDisplay[f.id] === false) n++;
		});
		return n;
	}

	function groupSortActive() {
		if (projectView === 'board') {
			return (
				boardColumnBy !== '' ||
				boardRowBy !== '' ||
				boardOrderBy !== 'title' ||
				boardOrderDir !== 'asc'
			);
		}
		return listGroupBy !== '' || listOrderBy !== 'title' || listOrderDir !== 'asc';
	}

	/** End-of-day unix seconds for a YYYY-MM-DD string. */
	function customDateEndSeconds(dateStr) {
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
		if (!m) return NaN;
		const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
		return dt.getTime() / 1000;
	}

	// ---- filtering / sorting --------------------------------------------

	/**
	 * @param {any} item
	 * @param {any} field
	 * @param {string[]} values
	 */
	function filterMatches(item, field, values) {
		if (field.kind === 'datetime') {
			const d = DF ? DF.deadlineOf(item) : null;
			const now = Date.now() / 1000;
			return values.some(function (v) {
				if (PRESETS[v]) return d != null && d >= now && d <= now + PRESETS[v].seconds;
				if (v.indexOf('custom:') === 0) {
					const until = customDateEndSeconds(v.slice(7));
					return Number.isFinite(until) && d != null && d <= until;
				}
				return false;
			});
		}
		const actual = field.get(item);
		return values.some(function (v) { return actual === v; });
	}

	/**
	 * Projects matching the search text only (field filters not applied).
	 * @returns {any[]}
	 */
	function searchOnlyProjects() {
		let list = projects.slice();
		const q = projectQuery.trim().toLowerCase();
		if (q) {
			list = list.filter(function (p) {
				const hay =
					String(p.title || '') + ' ' + String(p.path || '') + ' ' + String(p.folderPrefix || '');
				return hay.toLowerCase().indexOf(q) !== -1;
			});
		}
		return list;
	}

	/**
	 * Projects after applying search and field filters (unsorted).
	 * @returns {any[]}
	 */
	function visibleProjects() {
		let list = searchOnlyProjects();

		projectFields.forEach(function (f) {
			const vals = projectFilters[f.id];
			if (!vals || !vals.length) return;
			list = list.filter(function (item) {
				return filterMatches(item, f, vals);
			});
		});

		return list;
	}

	/** Number of projects hidden by the active field filters (excludes search). */
	function hiddenByFilterCount() {
		if (activeFilterCount() === 0) return 0;
		return searchOnlyProjects().length - visibleProjects().length;
	}

	/**
	 * Sort a list in place by a field + direction.
	 * @param {any[]} list
	 * @param {string} orderBy
	 * @param {string} orderDir
	 */
	function sortList(list, orderBy, orderDir, fields) {
		const flds = fields || projectFields;
		if (!DF) {
			list.sort(function (a, b) {
				return String(a.title || '').toLowerCase().localeCompare(String(b.title || '').toLowerCase());
			});
			return list;
		}
		const field = DF.fieldById(flds, orderBy);
		const dir = orderDir === 'desc' ? -1 : 1;
		list.sort(function (a, b) {
			let cmp;
			if (!field || field.id === 'title') {
				cmp = String(a.title || '').toLowerCase().localeCompare(String(b.title || '').toLowerCase());
			} else if (field.kind === 'enum') {
				const ra = DF.enumRank(field, field.get(a));
				const rb = DF.enumRank(field, field.get(b));
				cmp = ra - rb;
				if (cmp === 0) {
					cmp = String(a.title || '').toLowerCase().localeCompare(String(b.title || '').toLowerCase());
				}
			} else {
				const va = field.get(a);
				const vb = field.get(b);
				const na = va == null ? Infinity : Number(va);
				const nb = vb == null ? Infinity : Number(vb);
				cmp = na - nb;
				if (cmp === 0) {
					cmp = String(a.title || '').toLowerCase().localeCompare(String(b.title || '').toLowerCase());
				}
			}
			return cmp * dir;
		});
		return list;
	}

	/**
	 * Group-bucket value for a field: quarters for datetime, else raw value.
	 * @param {any} field
	 * @param {any} item
	 */
	function groupValueForField(field, item) {
		if (field.kind === 'datetime') {
			const d = DF ? DF.deadlineOf(item) : null;
			if (d == null) return null;
			return quarterLabel(d);
		}
		return field.get(item);
	}

	/**
	 * Stable group key for an item (null/empty → "(none)").
	 * @param {any} field
	 * @param {any} item
	 */
	function groupKeyForItem(field, item) {
		const v = groupValueForField(field, item);
		return v == null || String(v) === '' ? '(none)' : String(v);
	}

	/**
	 * Ordered group keys for a field across a list. Enums always include every
	 * schema value (even when empty in data); datetimes show only quarters present.
	 * @param {any} field
	 * @param {any[]} list
	 * @returns {string[]}
	 */
	function orderedGroupKeys(field, list) {
		const seen = new Set();
		let hasNone = false;
		list.forEach(function (item) {
			const k = groupKeyForItem(field, item);
			if (k === '(none)') hasNone = true;
			else seen.add(k);
		});

		if (field.kind === 'enum') {
			const keys = (field.values || []).slice();
			seen.forEach(function (k) {
				if (keys.indexOf(k) === -1) keys.push(k);
			});
			if (hasNone) keys.push('(none)');
			return keys;
		}

		// datetime / other: present values only, sorted; "(none)" last.
		const arr = Array.from(seen).sort(function (a, b) {
			return String(a).localeCompare(String(b));
		});
		if (hasNone) arr.push('(none)');
		return arr;
	}

	// ---- toolbar rendering ----------------------------------------------

	function menuButton(key, label, badge) {
		const alignRight = key === 'display' || key === 'groupsort';
		return (
			'<span class="menu-anchor' +
			(alignRight ? ' align-right' : '') +
			'">' +
			'<button type="button" class="ghost menu-btn' +
			(openMenu === key ? ' open' : '') +
			'" data-menu="' +
			key +
			'">' +
			esc(label) +
			(badge > 0 ? '<span class="bubble">' + badge + '</span>' : '') +
			'</button>' +
			(openMenu === key ? renderMenuPanel(key) : '') +
			'</span>'
		);
	}

	function renderMenuPanel(key) {
		if (key === 'filter') return renderFilterMenu();
		if (key === 'display') return renderDisplayMenu();
		if (key === 'groupsort') return renderGroupSortMenu();
		return '';
	}

	function renderFilterMenu() {
		const fields = filterableFields();
		let rows = '';
		fields.forEach(function (f) {
			const active = (projectFilters[f.id] || []).length > 0;
			const expanded = openFilterField === f.id;
			rows += '<div class="fmenu-item' + (expanded ? ' open' : '') + '">';
			rows +=
				'<button type="button" class="fmenu-head" data-field="' +
				esc(f.id) +
				'">' +
				'<span class="fmark' +
				(active ? ' on' : '') +
				'"></span>' +
				'<span class="fmenu-label">' +
				esc(f.label) +
				'</span>' +
				'<span class="chev">\u203a</span>' +
				'</button>';
			if (expanded) rows += renderFilterSubmenu(f);
			rows += '</div>';
		});
		return '<div class="menu-panel" id="filterMenu">' + rows + '</div>';
	}

	function renderFilterSubmenu(f, activeVals) {
		activeVals = activeVals || projectFilters[f.id] || [];
		if (f.kind === 'datetime') {
			return renderDeadlineSubmenu(f, activeVals);
		}
		let opts = '';
		(f.values || []).forEach(function (v) {
			const checked = activeVals.indexOf(v) !== -1;
			opts +=
				'<label class="fopt"><input type="checkbox" data-field="' +
				esc(f.id) +
				'" data-value="' +
				esc(v) +
				'"' +
				(checked ? ' checked' : '') +
				' /> <span>' +
				esc(v) +
				'</span></label>';
		});
		return '<div class="fsub">' + opts + '</div>';
	}

	function renderDeadlineSubmenu(f, activeVals) {
		let opts = '';
		Object.keys(PRESETS).forEach(function (key) {
			const checked = activeVals.indexOf(key) !== -1;
			opts +=
				'<label class="fopt"><input type="checkbox" data-field="' +
				esc(f.id) +
				'" data-value="' +
				esc(key) +
				'"' +
				(checked ? ' checked' : '') +
				' /> <span>' +
				esc(PRESETS[key].label) +
				'</span></label>';
		});
		const customVal = activeVals.find(function (v) { return v.indexOf('custom:') === 0; }) || '';
		const dateStr = customVal.slice(7);
		opts +=
			'<div class="fsub-row"><span class="fsub-label">Custom date</span>' +
			'<input type="date" class="fcustom" data-field="' +
			esc(f.id) +
			'" value="' +
			esc(dateStr) +
			'" /></div>';
		return '<div class="fsub">' + opts + '</div>';
	}

	function renderDisplayMenu() {
		let rows = '';
		displayableFields().forEach(function (f) {
			const on = projectDisplay[f.id] !== false;
			rows +=
				'<label class="fopt"><input type="checkbox" data-display="' +
				esc(f.id) +
				'"' +
				(on ? ' checked' : '') +
				' /> <span>' +
				esc(f.label) +
				'</span></label>';
		});
		return (
			'<div class="menu-panel" id="displayMenu">' +
			'<div class="gs-label view-label">View</div>' +
			'<div class="view-toggle">' +
			'<button type="button" class="vt-btn' +
			(projectView === 'list' ? ' active' : '') +
			'" data-view="list">List</button>' +
			'<button type="button" class="vt-btn' +
			(projectView === 'board' ? ' active' : '') +
			'" data-view="board">Board</button>' +
			'</div>' +
			'<div class="gs-label view-label">Fields</div>' +
			rows +
			'</div>'
		);
	}

	/**
	 * A sort-menu section with a select of fields. `allowNone` adds a "None"
	 * option (for group / column / row). Fields in `excludeIds` are hidden so a
	 * field can only ever be used for one role at a time.
	 */
	function fieldSelectSection(id, label, selected, fields, excludeIds, allowNone) {
		let opts = allowNone ? '<option value="">None</option>' : '';
		fields.forEach(function (f) {
			if (excludeIds.indexOf(f.id) !== -1) return;
			opts +=
				'<option value="' +
				esc(f.id) +
				'"' +
				(selected === f.id ? ' selected' : '') +
				'>' +
				esc(f.label) +
				'</option>';
		});
		return (
			'<div class="gs-section"><div class="gs-label">' +
			esc(label) +
			'</div><select id="' +
			esc(id) +
			'" class="proj-select">' +
			opts +
			'</select></div>'
		);
	}

	function renderGroupSortMenu() {
		const isBoard = projectView === 'board';
		let sections = '';
		if (isBoard) {
			sections += fieldSelectSection('gsColumn', 'Column', boardColumnBy, groupableFields(), [boardRowBy, boardOrderBy], true);
			sections += fieldSelectSection('gsRow', 'Row', boardRowBy, groupableFields(), [boardColumnBy, boardOrderBy], true);
			sections += fieldSelectSection('gsOrder', 'Order by', boardOrderBy, projectFields, [boardColumnBy, boardRowBy], false);
		} else {
			sections += fieldSelectSection('gsGroup', 'Group by', listGroupBy, groupableFields(), [listOrderBy], true);
			sections += fieldSelectSection('gsOrder', 'Order by', listOrderBy, projectFields, [listGroupBy], false);
		}

		const orderBy = isBoard ? boardOrderBy : listOrderBy;
		const dirField = (DF && DF.fieldById(projectFields, orderBy)) || { kind: 'text' };
		const dirs = DF ? DF.orderDirectionsForKind(dirField.kind) : ['asc', 'desc'];
		const curDir = isBoard ? boardOrderDir : listOrderDir;
		let dirBtns = '';
		dirs.forEach(function (d) {
			const icon = d === 'asc' ? '\u2191' : d === 'desc' ? '\u2193' : '\u21c5';
			const label = d === 'asc' ? 'Ascending' : d === 'desc' ? 'Descending' : 'Custom';
			dirBtns +=
				'<button type="button" class="dir-btn' +
				(curDir === d ? ' active' : '') +
				'" data-dir="' +
				d +
				'" title="' +
				esc(label) +
				'">' +
				icon +
				'</button>';
		});

		return (
			'<div class="menu-panel gs" id="groupSortMenu">' +
			sections +
			'<div class="gs-section"><div class="gs-label">Direction</div><div class="dir-row">' +
			dirBtns +
			'</div></div>' +
			'</div>'
		);
	}

	function renderFilterChips() {
		/** @type {string[]} */
		const parts = [];
		projectFields.forEach(function (f) {
			const vals = projectFilters[f.id] || [];
			if (!vals.length) return;
			const open = openChipField === f.id;
			parts.push(
				'<span class="chip-anchor">' +
				'<button type="button" class="filter-chip' +
				(open ? ' open' : '') +
				'" data-field="' +
				esc(f.id) +
				'" title="Edit ' +
				esc(f.label) +
				' filter">' +
				esc(f.label) +
				' <span class="chip-count">' +
				vals.length +
				'</span></button>' +
				(open ? '<div class="chip-popover">' + renderFilterSubmenu(f) + '</div>' : '') +
				'</span>'
			);
		});
		if (!parts.length) return '';
		return '<div class="proj-chips">' + parts.join('') + '</div>';
	}

	function renderProjectToolbar() {
		const filterCount = activeFilterCount();
		const displayOff = hiddenFieldCount() + (projectView === 'board' ? 1 : 0);
		const gsActive = groupSortActive();
		const anyActive = filterCount > 0 || displayOff > 0 || gsActive;

		return (
			'<div class="proj-toolbar">' +
			'<div class="proj-toolbar-row">' +
			'<input type="text" id="projSearch" class="proj-search" placeholder="Search projects\u2026" autocomplete="off" value="' +
			esc(projectQuery) +
			'" />' +
			menuButton('filter', 'Filter', filterCount) +
			menuButton('display', 'Display', displayOff) +
			menuButton('groupsort', 'Sort', gsActive ? 1 : 0) +
			(anyActive
				? '<button type="button" class="ghost clear-btn" id="clearAll">Clear</button>'
				: '') +
			'</div>' +
			renderFilterChips() +
			'</div>'
		);
	}

	// ---- project card + list rendering ----------------------------------

	/**
	 * The status value that means an issue is "done" (used for the completed
	 * count). Reads live from the issue status enum: 'completed' when present,
	 * else the last enum value (mirrors the close-issue convention).
	 */
	function doneIssueStatus() {
		const f = DF ? DF.fieldById(issueFields, 'status') : undefined;
		const vals = (f && f.values) || [];
		if (vals.indexOf('completed') !== -1) return 'completed';
		return vals.length ? vals[vals.length - 1] : 'completed';
	}

	/**
	 * @param {any} p
	 * @returns {{ counts: Record<string, number>, total: number, doneCount: number }}
	 */
	function issueStats(p) {
		const counts = DF ? DF.issueStatusCountsOf(p) : {};
		const total = DF ? DF.issueCountOf(p) : 0;
		const doneCount = Number(counts[doneIssueStatus()] || 0);
		return { counts, total, doneCount };
	}

	/**
	 * Status breakdown popover for one project.
	 * @param {any} p
	 * @param {{ counts: Record<string, number> }} s
	 */
	function renderIssuePopover(p, s) {
		const statusField = DF ? DF.fieldById(issueFields, 'status') : undefined;
		const order = (statusField && statusField.values) || [];
		/** @type {string[]} */
		const keys = [];
		order.forEach(function (k) {
			if (keys.indexOf(k) === -1) keys.push(k);
		});
		Object.keys(s.counts).forEach(function (k) {
			if (keys.indexOf(k) === -1) keys.push(k);
		});
		let rows = '';
		keys.forEach(function (k) {
			rows +=
				'<div class="iss-row"><span class="iss-status">' +
				esc(k) +
				'</span><span class="iss-count">' +
				(s.counts[k] || 0) +
				'</span></div>';
		});
		if (!keys.length) rows = '<div class="iss-empty">No issues yet</div>';
		return '<div class="issue-popover">' + rows + '</div>';
	}

	/**
	 * Clickable issue bubble showing the fraction `completed / total`.
	 * @param {any} p
	 */
	function renderIssueBubble(p) {
		const s = issueStats(p);
		const open = openIssuePopover === p.folderPrefix;
		return (
			'<span class="issue-bubble-anchor">' +
			'<button type="button" class="issue-bubble' +
			(open ? ' open' : '') +
			'" data-issue-prefix="' +
			esc(p.folderPrefix) +
			'" title="Issue breakdown">' +
			'<span class="issue-frac-num">' +
			s.doneCount +
			'</span><span class="issue-frac-sep">/</span><span class="issue-frac-total">' +
			s.total +
			'</span>' +
			'</button>' +
			(open ? renderIssuePopover(p, s) : '') +
			'</span>'
		);
	}

	function renderBoardCard(p) {
		const badges = [];
		projectFields.forEach(function (f) {
			if (f.id === 'title' || f.id === 'issues') return;
			if (projectDisplay[f.id] === false) return;
			const v = f.get(p);
			if (f.id === 'deadline') {
				if (v != null) badges.push('Due ' + formatDate(v));
				return;
			}
			if (v != null && String(v) !== '') badges.push(String(v));
		});
		const showIssues = projectDisplay.issues !== false;
		return (
			'<div class="proj-card board-card" role="button" tabindex="0" data-prefix="' +
			esc(p.folderPrefix) +
			'" data-path="' +
			esc(p.path) +
			'" data-title="' +
			esc(p.title) +
			'">' +
			'<span class="title">' +
			esc(p.title) +
			'</span>' +
			(badges.length
				? '<span class="sub">' + badges.map(function (b) { return esc(b); }).join(' \u00b7 ') + '</span>'
				: '') +
			(showIssues ? '<div class="board-card-foot">' + renderIssueBubble(p) + '</div>' : '') +
			'</div>'
		);
	}

	/** Columns shown in the list table: title + every visible display field. */
	function visibleColumns() {
		const cols = ['title'];
		displayableFields().forEach(function (f) {
			if (projectDisplay[f.id] !== false) cols.push(f.id);
		});
		return cols;
	}

	/**
	 * @param {string} id
	 */
	function columnLabel(id) {
		if (id === 'title') return 'Title';
		const f = DF ? DF.fieldById(projectFields, id) : undefined;
		return f ? f.label : id;
	}

	/**
	 * @param {string} id
	 * @param {any} p
	 */
	function cellValue(id, p) {
		if (id === 'title') return String(p.title || '');
		const f = DF ? DF.fieldById(projectFields, id) : undefined;
		if (!f) return '';
		if (id === 'deadline') {
			const d = f.get(p);
			return d != null ? formatDate(d) : '';
		}
		const v = f.get(p);
		return v != null ? String(v) : '';
	}

	/**
	 * @param {string[]} cols
	 */
	function columnTemplate(cols) {
		return cols.map(function (id) { return id === 'title' ? '2fr' : '1fr'; }).join(' ');
	}

	/**
	 * @param {string[]} cols
	 * @param {string} tmpl
	 */
	function renderListHeader(cols, tmpl) {
		let head = '<div class="lt-row lt-head" style="grid-template-columns:' + tmpl + '">';
		cols.forEach(function (id) {
			head += '<div class="lt-cell">' + esc(columnLabel(id)) + '</div>';
		});
		head += '</div>';
		return head;
	}

	/**
	 * @param {any[]} list
	 * @param {string[]} cols
	 * @param {string} tmpl
	 */
	function renderListRows(list, cols, tmpl) {
		let rows = '';
		list.forEach(function (p) {
			rows +=
				'<div class="lt-row proj-row" role="button" tabindex="0" style="grid-template-columns:' +
				tmpl +
				'" data-prefix="' +
				esc(p.folderPrefix) +
				'" data-path="' +
				esc(p.path) +
				'" data-title="' +
				esc(p.title) +
				'">';
			cols.forEach(function (id) {
				if (id === 'issues') {
					rows += '<div class="lt-cell">' + renderIssueBubble(p) + '</div>';
				} else {
					rows += '<div class="lt-cell">' + esc(cellValue(id, p)) + '</div>';
				}
			});
			rows += '</div>';
		});
		return rows;
	}

	/**
	 * List view: a table with a single header; optional collapsible groups.
	 * @param {any[]} list
	 */
	function renderList(list) {
		const cols = visibleColumns();
		const tmpl = columnTemplate(cols);
		if (!listGroupBy) {
			sortList(list, listOrderBy, listOrderDir);
			return (
				'<div class="list-table">' +
				renderListHeader(cols, tmpl) +
				renderListRows(list, cols, tmpl) +
				'</div>'
			);
		}
		const field = DF ? DF.fieldById(projectFields, listGroupBy) : undefined;
		const keys = orderedGroupKeys(field || { kind: 'text', values: [] }, list);
		let body = '';
		keys.forEach(function (k) {
			const items = list.filter(function (p) {
				return groupKeyForItem(field, p) === k;
			});
			sortList(items, listOrderBy, listOrderDir);
			const collapsed = collapsedListGroups.has(k);
			body +=
				'<details class="lt-group"' +
				(collapsed ? '' : ' open') +
				' data-group="' +
				esc(k) +
				'"><summary class="lt-group-head">' +
				esc(k) +
				'<span class="count">' +
				items.length +
				'</span></summary>' +
				renderListRows(items, cols, tmpl) +
				'</details>';
		});
		return (
			'<div class="list-table">' +
			renderListHeader(cols, tmpl) +
			body +
			'</div>'
		);
	}

	/**
	 * Board view: a grid with one column header row (once) and, when a Row
	 * field is set, one full-width band per row value. Each band is collapsible;
	 * its row value remains visible when collapsed.
	 * @param {any[]} list
	 */
	function renderBoard(list) {
		const colField = DF ? DF.fieldById(projectFields, boardColumnBy) : undefined;
		const rowField = DF ? DF.fieldById(projectFields, boardRowBy) : undefined;
		const colKeys = colField
			? orderedGroupKeys(colField, list)
			: ['(all)'];
		const rowKeys = rowField ? orderedGroupKeys(rowField, list) : null;

		/** @type {Map<string, any[]>} */
		const buckets = new Map();
		list.forEach(function (p) {
			const c = colField ? groupKeyForItem(colField, p) : '(all)';
			const r = rowField ? groupKeyForItem(rowField, p) : '';
			const k = c + '||' + r;
			if (!buckets.has(k)) buckets.set(k, []);
			buckets.get(k).push(p);
		});

		const nCols = colKeys.length;
		const tmpl = 'repeat(' + nCols + ', 240px)';

		// Column header row (rendered once).
		let header = '';
		colKeys.forEach(function (c) {
			let cnt = 0;
			(rowKeys || ['']).forEach(function (r) {
				cnt += (buckets.get(c + '||' + r) || []).length;
			});
			header +=
				'<div class="bcol-head">' +
				esc(c) +
				'<span class="count">' +
				cnt +
				'</span></div>';
		});

		let body = '';
		if (rowField && rowKeys) {
			rowKeys.forEach(function (r) {
				let cnt = 0;
				colKeys.forEach(function (c) {
					cnt += (buckets.get(c + '||' + r) || []).length;
				});
				const collapsed = collapsedBoardRows.has(r);
				body +=
					'<button type="button" class="brow-head' +
					(collapsed ? ' collapsed' : '') +
					'" style="grid-column:1 / -1" data-row="' +
					esc(r) +
					'"><span class="brow-label">' +
					esc(r) +
					'</span><span class="count">' +
					cnt +
					'</span></button>';
				colKeys.forEach(function (c) {
					const items = buckets.get(c + '||' + r) || [];
					sortList(items, boardOrderBy, boardOrderDir);
					body +=
						'<div class="bcell' +
						(collapsed ? ' collapsed' : '') +
						'" data-row="' +
						esc(r) +
						'">' +
						items.map(renderBoardCard).join('') +
						'</div>';
				});
			});
		} else {
			colKeys.forEach(function (c) {
				const items = buckets.get(c + '||') || [];
				sortList(items, boardOrderBy, boardOrderDir);
				body += '<div class="bcell">' + items.map(renderBoardCard).join('') + '</div>';
			});
		}

		return (
			'<div class="board-scroll"><div class="board-grid" style="grid-template-columns:' +
			tmpl +
			'">' +
			header +
			body +
			'</div></div>'
		);
	}

	function renderProjectList() {
		if (!projects.length) {
			root.innerHTML =
				'<p class="page-title">Projects</p>' +
				'<p class="page-sub">No project folders (.p) in the index yet. Create a project and reindex.</p>';
			return;
		}

		const visible = visibleProjects();
		let body = '';
		if (!visible.length) {
			body = '<p class="muted-block">No projects match your search or filters.</p>';
		} else if (projectView === 'board') {
			body = renderBoard(visible);
		} else {
			body = renderList(visible);
		}

		const hidden = hiddenByFilterCount();
		let footer = '';
		if (hidden > 0) {
			footer =
				'<div class="hidden-note"><span>' +
				hidden +
				' hidden by filters</span>' +
				'<button type="button" class="ghost" id="removeFilters">Remove filters</button></div>';
		}

		root.innerHTML =
			'<p class="page-title">Projects</p>' +
			renderProjectToolbar() +
			body +
			footer;
		bindProjectToolbar();
		bindProjectClickTargets();
		positionIssuePopovers();
	}

	function bindProjectClickTargets() {
		root.querySelectorAll('.proj-row, .board-card').forEach(function (el) {
			el.addEventListener('click', function () {
				selectProjectFromElement(el);
			});
			el.addEventListener('keydown', function (e) {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					selectProjectFromElement(el);
				}
			});
		});

		// Issue bubbles: open the status breakdown without selecting the project.
		root.querySelectorAll('.issue-bubble').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.stopPropagation();
				const prefix = btn.getAttribute('data-issue-prefix') || '';
				openIssuePopover = openIssuePopover === prefix ? '' : prefix;
				renderProjectList();
			});
			btn.addEventListener('keydown', function (e) {
				if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
			});
		});
	}

	/** Position issue popovers as fixed overlays (escapes clipped list/board containers). */
	function positionIssuePopovers() {
		root.querySelectorAll('.issue-popover').forEach(function (pop) {
			const anchor = pop.parentElement;
			if (!anchor) return;
			const r = anchor.getBoundingClientRect();
			pop.style.position = 'fixed';
			pop.style.top = r.bottom + 4 + 'px';
			pop.style.left = '0px';
			pop.style.visibility = 'hidden';
			const w = pop.offsetWidth;
			pop.style.left = r.right - w + 'px';
			pop.style.visibility = 'visible';
		});
	}

	/**
	 * @param {Element} el
	 */
	function selectProjectFromElement(el) {
		selectedPrefix = el.getAttribute('data-prefix') || '';
		selectedTitle = el.getAttribute('data-title') || '';
		detail = { features: [], issues: [] };
		detailLoading = true;
		issueQuery = '';
		detailView = 'features';
		inlineSubKey = '';
		render();
		vscode.postMessage({
			type: 'selectProject',
			folderPrefix: selectedPrefix,
			path: el.getAttribute('data-path')
		});
	}

	// ---- toolbar binding -------------------------------------------------

	function toggleFilterValue(fieldId, value) {
		const list = (projectFilters[fieldId] || []).slice();
		const idx = list.indexOf(value);
		if (idx === -1) list.push(value);
		else list.splice(idx, 1);
		if (list.length) projectFilters[fieldId] = list;
		else delete projectFilters[fieldId];
	}

	function setCustomDeadline(fieldId, dateStr) {
		const list = (projectFilters[fieldId] || []).filter(function (v) {
			return v.indexOf('custom:') !== 0;
		});
		if (dateStr) list.push('custom:' + dateStr);
		if (list.length) projectFilters[fieldId] = list;
		else delete projectFilters[fieldId];
	}

	function clearAllFilters() {
		projectQuery = '';
		projectFilters = {};
		projectDisplay = {};
		listGroupBy = '';
		listOrderBy = 'title';
		listOrderDir = 'asc';
		boardColumnBy = '';
		boardRowBy = '';
		boardOrderBy = 'title';
		boardOrderDir = 'asc';
		projectView = 'list';
		openMenu = '';
		openFilterField = '';
		openChipField = '';
		openIssuePopover = '';
		renderProjectList();
	}

	function bindProjectToolbar() {
		const search = document.getElementById('projSearch');
		if (search) {
			search.addEventListener('input', function () {
				projectQuery = search.value;
				renderProjectList();
				const again = document.getElementById('projSearch');
				if (again) {
					again.focus();
					try {
						again.setSelectionRange(again.value.length, again.value.length);
					} catch (e) {
						/* ignore */
					}
				}
			});
		}

		// Menu open/close.
		root.querySelectorAll('.menu-btn').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.stopPropagation();
				const key = btn.getAttribute('data-menu') || '';
				openMenu = openMenu === key ? '' : key;
				if (openMenu === 'filter') openFilterField = '';
				renderProjectList();
			});
		});

		// Filter field accordion head.
		root.querySelectorAll('.fmenu-head').forEach(function (head) {
			head.addEventListener('click', function (e) {
				e.stopPropagation();
				const fid = head.getAttribute('data-field') || '';
				openFilterField = openFilterField === fid ? '' : fid;
				renderProjectList();
			});
		});

		// Filter checkboxes.
		root.querySelectorAll('.fsub input[type="checkbox"]').forEach(function (cb) {
			cb.addEventListener('click', function (e) {
				e.stopPropagation();
			});
			cb.addEventListener('change', function () {
				const fid = cb.getAttribute('data-field') || '';
				const val = cb.getAttribute('data-value') || '';
				toggleFilterValue(fid, val);
				renderProjectList();
			});
		});

		// Custom deadline date input.
		root.querySelectorAll('.fcustom').forEach(function (input) {
			input.addEventListener('click', function (e) {
				e.stopPropagation();
			});
			input.addEventListener('change', function () {
				const fid = input.getAttribute('data-field') || '';
				setCustomDeadline(fid, input.value);
				renderProjectList();
			});
		});

		// Display toggles.
		root.querySelectorAll('input[data-display]').forEach(function (cb) {
			cb.addEventListener('click', function (e) {
				e.stopPropagation();
			});
			cb.addEventListener('change', function () {
				const fid = cb.getAttribute('data-display') || '';
				projectDisplay[fid] = cb.checked;
				renderProjectList();
			});
		});

		// View mode toggle (List / Board).
		root.querySelectorAll('.vt-btn').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.stopPropagation();
				projectView = btn.getAttribute('data-view') === 'board' ? 'board' : 'list';
				renderProjectList();
			});
		});

		// Group / column / row / order selects + direction buttons.
		const gsGroup = document.getElementById('gsGroup');
		if (gsGroup) {
			gsGroup.addEventListener('change', function () {
				listGroupBy = gsGroup.value;
				renderProjectList();
			});
		}
		const gsColumn = document.getElementById('gsColumn');
		if (gsColumn) {
			gsColumn.addEventListener('change', function () {
				boardColumnBy = gsColumn.value;
				renderProjectList();
			});
		}
		const gsRow = document.getElementById('gsRow');
		if (gsRow) {
			gsRow.addEventListener('change', function () {
				boardRowBy = gsRow.value;
				renderProjectList();
			});
		}
		const gsOrder = document.getElementById('gsOrder');
		if (gsOrder) {
			gsOrder.addEventListener('change', function () {
				const v = gsOrder.value;
				if (projectView === 'board') {
					boardOrderBy = v;
					if (boardOrderDir === 'custom') boardOrderDir = 'asc';
				} else {
					listOrderBy = v;
					if (listOrderDir === 'custom') listOrderDir = 'asc';
				}
				renderProjectList();
			});
		}
		root.querySelectorAll('.dir-btn').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.stopPropagation();
				const d = btn.getAttribute('data-dir') || 'asc';
				if (projectView === 'board') boardOrderDir = d;
				else listOrderDir = d;
				renderProjectList();
			});
		});

		// Grouped filter chip: clicking opens an inline popover on the chip itself.
		root.querySelectorAll('.filter-chip').forEach(function (chip) {
			chip.addEventListener('click', function (e) {
				e.stopPropagation();
				const fid = chip.getAttribute('data-field') || '';
				openMenu = '';
				openFilterField = '';
				openChipField = openChipField === fid ? '' : fid;
				renderProjectList();
			});
		});

		// Collapsible list groups.
		root.querySelectorAll('.lt-group').forEach(function (grp) {
			grp.addEventListener('toggle', function () {
				const k = grp.getAttribute('data-group') || '';
				if (!grp.open) collapsedListGroups.add(k);
				else collapsedListGroups.delete(k);
			});
		});

		// Collapsible board row bands.
		root.querySelectorAll('.brow-head').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.stopPropagation();
				const r = btn.getAttribute('data-row') || '';
				if (collapsedBoardRows.has(r)) collapsedBoardRows.delete(r);
				else collapsedBoardRows.add(r);
				renderProjectList();
			});
		});

		// Remove filters (from the "hidden by filters" note).
		const removeFilters = document.getElementById('removeFilters');
		if (removeFilters) {
			removeFilters.addEventListener('click', function (e) {
				e.stopPropagation();
				projectFilters = {};
				renderProjectList();
			});
		}

		// Clear all.
		const clear = document.getElementById('clearAll');
		if (clear) {
			clear.addEventListener('click', function (e) {
				e.stopPropagation();
				clearAllFilters();
			});
		}
	}

	// Close menus when clicking outside the toolbar.
	document.addEventListener('click', function (e) {
		const target = /** @type {HTMLElement | null} */ (e.target);
		if (target && target.closest && target.closest('.issue-bubble-anchor')) return;
		if (target && target.closest && target.closest('.proj-toolbar')) return;
		let changed = false;
		if (openMenu || openChipField || openIssuePopover) {
			openMenu = '';
			openFilterField = '';
			openChipField = '';
			openIssuePopover = '';
			changed = true;
		}
		if (openIssuesMenu || openIssuesChipField) {
			openIssuesMenu = '';
			openIssuesFilterField = '';
			openIssuesChipField = '';
			changed = true;
		}
		if (changed) {
			if (selectedPrefix) renderProjectDetail();
			else renderProjectList();
		}
	});

	// ---- compose / issues / detail --------------------------------------

	/**
	 * @param {string} [parentIssueId]
	 */
	function openCompose(parentIssueId) {
		const parent = String(parentIssueId || '').trim();
		compose = {
			parentIssueId: parent,
			label: parent ? 'Sub-issue under ' + parent : 'New issue'
		};
		render();
		const input = document.getElementById('composeTitle');
		if (input) {
			input.focus();
			input.select();
		}
	}

	function closeCompose() {
		compose = null;
		render();
	}

	function submitCompose() {
		if (!compose || !selectedPrefix) return;
		const input = document.getElementById('composeTitle');
		const title = input ? String(input.value || '').trim() : '';
		if (!title) {
			if (input) input.focus();
			return;
		}
		const parentIssueId = compose.parentIssueId || '';
		compose = null;
		vscode.postMessage({
			type: 'createIssue',
			folderPrefix: selectedPrefix,
			parentIssueId: parentIssueId || undefined,
			title: title
		});
		detailLoading = true;
		render();
	}

	/**
	 * @returns {string}
	 */
	function renderComposeForm() {
		if (!compose) return '';
		return (
			'<div class="compose" id="composeBox">' +
			'<label class="compose-label" for="composeTitle">' +
			esc(compose.label) +
			'</label>' +
			'<div class="compose-row">' +
			'<input type="text" id="composeTitle" placeholder="Short problem statement" autocomplete="off" />' +
			'<div class="compose-actions">' +
			'<button type="button" id="composeSubmit">Create</button>' +
			'<button type="button" class="ghost" id="composeCancel">Cancel</button>' +
			'</div></div></div>'
		);
	}

	function bindCompose() {
		const submit = document.getElementById('composeSubmit');
		const cancel = document.getElementById('composeCancel');
		const input = document.getElementById('composeTitle');
		if (submit) submit.addEventListener('click', submitCompose);
		if (cancel) cancel.addEventListener('click', closeCompose);
		if (input) {
			input.addEventListener('keydown', function (e) {
				if (e.key === 'Enter') {
					e.preventDefault();
					submitCompose();
				} else if (e.key === 'Escape') {
					e.preventDefault();
					closeCompose();
				}
			});
		}
	}

	function bindIssueSearch() {
		const input = document.getElementById('issueSearch');
		if (input) {
			input.addEventListener('input', function () {
				issueQuery = input.value;
				renderProjectDetail();
				const again = document.getElementById('issueSearch');
				if (again) {
					again.focus();
					try {
						again.setSelectionRange(again.value.length, again.value.length);
					} catch (e) {
						/* ignore */
					}
				}
			});
		}
		const showParent = document.getElementById('showParentChain');
		if (showParent) {
			showParent.checked = showParentChain;
			showParent.addEventListener('change', function () {
				showParentChain = showParent.checked;
				renderProjectDetail();
			});
		}
	}

	/**
	 * @param {string|null} path
	 * @param {number} fileId
	 * @param {number} headingId
	 * @param {string|null} title
	 */
	function openHeading(path, fileId, headingId, title) {
		vscode.postMessage({
			type: 'openHeading',
			path: path,
			fileId: fileId,
			headingId: headingId,
			title: title
		});
	}

	/**
	 * @param {any} issue
	 * @param {number} depth
	 * @param {boolean} inFeature whether the issue lives in a feature (vs the project inbox)
	 * @param {string} guideHtml tree guide markup (empty string for top-level roots)
	 */
	function renderIssueRow(issue, depth, inFeature, guideHtml) {
		const ikey = esc(issue.issueKey || '');
		const actionBtn = inFeature
			? '<button type="button" class="ghost issue-btn issue-move" data-ikey="' +
			  ikey +
			  '" title="Move to a feature, project issues, or under another issue (opens Storage)">Move</button>'
			: '<button type="button" class="ghost issue-btn issue-assign" data-ikey="' +
			  ikey +
			  '" title="Move to a feature or under another issue (opens Storage)">Assign</button>';

		// Top-level roots sit flush with no connector; nested rows get a CSS tree guide.
		const isTree = guideHtml !== '';

		return (
			'<div class="issue' +
			(isTree ? ' tree' : '') +
			'" style="padding-left:' +
			(isTree ? '12px' : 12 + depth * 16 + 'px') +
			'" data-path="' +
			esc(issue.path) +
			'" data-fid="' +
			issue.fileId +
			'" data-hid="' +
			issue.headingId +
			'" data-title="' +
			esc(issue.title) +
			'" data-ikey="' +
			ikey +
			'">' +
			guideHtml +
			'<span class="name">' +
			esc(issue.title) +
			'</span>' +
			'<span class="pill">' +
			esc(issue.priority || '') +
			'</span>' +
			'<span class="pill">' +
			esc(issue.status || '') +
			'</span>' +
			actionBtn +
			'<button type="button" class="ghost issue-btn issue-sub" data-ikey="' +
			ikey +
			'" title="New sub-issue">Sub</button>' +
			'</div>'
		);
	}

	/**
	 * Inline sub-issue form shown directly under the parent issue it was triggered from.
	 * @param {any} issue
	 * @param {number} depth
	 */
	function renderInlineSubForm(issue, depth) {
		return (
			'<div class="inline-sub" style="margin-left:' +
			(12 + (depth + 1) * 16) +
			'px" data-ikey="' +
			esc(issue.issueKey || '') +
			'">' +
			'<input type="text" class="inline-sub-input" placeholder="Sub-issue title\u2026" autocomplete="off" />' +
			'<button type="button" class="inline-sub-create">Create</button>' +
			'<button type="button" class="ghost inline-sub-cancel">Cancel</button>' +
			'</div>'
		);
	}

	/**
	 * CSS-drawn tree guide for one row: a vertical line per ancestor level (blank when that
	 * ancestor is its parent's last child) plus an elbow for the row itself.
	 * @param {boolean[]} ancestorsLast whether each ancestor was the last child of its parent
	 * @param {boolean} isLast whether this row is the last child of its parent
	 * @returns {string}
	 */
	function treeGuideHtml(ancestorsLast, isLast) {
		let html = '<span class="tree-guides">';
		for (let k = 0; k < ancestorsLast.length; k++) {
			html += ancestorsLast[k] ? '<span class="tg tg-sp"></span>' : '<span class="tg tg-line"></span>';
		}
		html += '<span class="tg ' + (isLast ? 'tg-corner' : 'tg-branch') + '"></span>';
		html += '</span>';
		return html;
	}

	/**
	 * Ordered parent chain of an issue (immediate parent → … → root), resolved from the full
	 * project issue list. Stops at the first missing/looping parent.
	 * @param {any} issue
	 * @param {Map<string, any>} issueIndex
	 * @returns {any[]}
	 */
	function parentChainOf(issue, issueIndex) {
		/** @type {any[]} */
		const chain = [];
		const seen = new Set();
		let key = issue.parentIssueKey ? String(issue.parentIssueKey).toLowerCase() : '';
		while (key) {
			if (seen.has(key)) break;
			seen.add(key);
			const p = issueIndex.get(key);
			if (!p) break;
			chain.push(p);
			key = p.parentIssueKey ? String(p.parentIssueKey).toLowerCase() : '';
		}
		return chain;
	}

	/**
	 * Ancestors of an issue reached via `parent:` that are NOT in the current section's list
	 * (i.e. they live in another feature/file). Returned root-first for display; stops the moment
	 * an ancestor is already rendered locally so nothing is repeated twice.
	 * @param {any} issue
	 * @param {Map<string, any>} issueIndex
	 * @param {Map<string, any>} localKeys issues present in this section
	 * @returns {{ ghosts: any[], anchor: any | null }} ghosts (root-first) plus the first local
	 * ancestor they should hang under (so a multi-level cross-section chain nests under the
	 * ancestor that actually lives in this section).
	 */
	function ghostAncestorsFor(issue, issueIndex, localKeys) {
		const chain = parentChainOf(issue, issueIndex);
		/** @type {any[]} */
		const ghosts = [];
		let anchor = null;
		for (let i = 0; i < chain.length; i++) {
			const k = String(chain[i].issueKey || '').toLowerCase();
			if (localKeys.has(k)) {
				anchor = chain[i];
				break;
			}
			ghosts.push(chain[i]);
		}
		ghosts.reverse();
		return { ghosts, anchor };
	}

	/**
	 * A dimmed (dulled-out) ancestor row: a `parent:` link to an issue that lives in another
	 * feature/file, shown only when "Show repeated parent issue" is on.
	 * @param {any} issue
	 * @param {string} guide
	 */
	function renderGhostIssueRow(issue, guide) {
		return (
			'<div class="ghost-issue">' +
			guide +
			'<span class="name">' +
			esc(issue.title || '') +
			'</span>' +
			'<span class="ghost-tag">parent</span>' +
			'</div>'
		);
	}

	/**
	 * @param {any[]} list
	 * @param {boolean} inFeature
	 * @param {Map<string, any>} issueIndex
	 */
	function renderIssueForest(list, inFeature, issueIndex) {
		if (!list || !list.length) return '<div class="muted-block">No issues.</div>';
		/** @type {Map<string, any>} */
		const byIssueKey = new Map();
		for (let i = 0; i < list.length; i++) {
			const item = list[i];
			if (item.issueKey) byIssueKey.set(String(item.issueKey).toLowerCase(), item);
		}

		// Unified tree of local issues plus optional dimmed "ghost" ancestors (a `parent:` link to
		// an issue in another section). Ghost ancestors are inserted as shared parent nodes so that
		// sibling sub-issues render under one parent heading instead of repeating the parent row.
		/** @type {Map<string, any>} node key -> { issue, ghost, key } */
		const nodeByKey = new Map();
		/** @type {Map<string, any[]>} parent node key -> child nodes */
		const childrenByKey = new Map();
		/** @type {Set<string>} keys of nodes that already have a parent */
		const hasParent = new Set();

		function getNode(issue, ghost) {
			const key = ghost
				? 'g:' + String(issue.issueKey).toLowerCase()
				: issue.issueKey
				? 'ik:' + String(issue.issueKey).toLowerCase()
				: 'fh:' + issue.fileId + ':' + issue.headingId;
			let n = nodeByKey.get(key);
			if (!n) {
				n = { issue: issue, ghost: ghost, key: key };
				nodeByKey.set(key, n);
			}
			return n;
		}
		function addChild(parentNode, childNode) {
			let arr = childrenByKey.get(parentNode.key);
			if (!arr) {
				arr = [];
				childrenByKey.set(parentNode.key, arr);
			}
			if (!arr.includes(childNode)) arr.push(childNode);
			hasParent.add(childNode.key);
		}

		for (let j = 0; j < list.length; j++) {
			const iss = list[j];
			const node = getNode(iss, false);

			// Local parent: link straight into the local tree.
			let localParent = null;
			if (iss.parentIssueKey) {
				const pk = String(iss.parentIssueKey).toLowerCase();
				if (byIssueKey.has(pk)) localParent = byIssueKey.get(pk);
			}
			if (localParent && localParent !== iss) {
				const parentNode = getNode(localParent, false);
				if (parentNode.key !== node.key) {
					addChild(parentNode, node);
					continue;
				}
			}

			// Cross-section parent: attach under the shared ghost ancestor chain (root-first),
			// anchored to the first local ancestor so the whole chain nests under the issue
			// that actually lives in this section (not as a separate top-level parent).
			if (showParentChain && issueIndex) {
				const result = ghostAncestorsFor(iss, issueIndex, byIssueKey);
				if (result.ghosts.length) {
					let prev = result.anchor ? getNode(result.anchor, false) : null;
					for (let g = 0; g < result.ghosts.length; g++) {
						const gn = getNode(result.ghosts[g], true);
						if (prev) addChild(prev, gn);
						prev = gn;
					}
					addChild(prev, node);
					continue;
				}
			}
		}

		const roots = [];
		nodeByKey.forEach(function (n) {
			if (!hasParent.has(n.key)) roots.push(n);
		});

		// The hierarchy is always shown as connected tree lines, using whatever parent links are
		// present in this section. With "Show repeated parent issue" on, a cross-section `parent:`
		// link also renders its missing ancestors as dimmed rows above the issue.
		function walkTree(nodes, depth, ancestorsLast) {
			let html = '';
			for (let i = 0; i < nodes.length; i++) {
				html += renderTreeItem(nodes[i], depth, ancestorsLast, i === nodes.length - 1);
			}
			return html;
		}

		function renderTreeItem(node, depth, ancestorsLast, isLast) {
			const guide = depth > 0 ? treeGuideHtml(ancestorsLast, isLast) : '';
			let html = node.ghost
				? renderGhostIssueRow(node.issue, guide)
				: renderIssueRow(node.issue, depth, inFeature, guide);
			if (!node.ghost && inlineSubKey && node.issue.issueKey && inlineSubKey === node.issue.issueKey) {
				html += renderInlineSubForm(node.issue, depth);
			}
			const kids = childrenByKey.get(node.key) || [];
			return html + walkTree(kids, depth + 1, depth > 0 ? ancestorsLast.concat(isLast) : []);
		}

		return walkTree(roots, 0, []);
	}

	/**
	 * @param {ParentNode} container
	 */
	function bindIssues(container) {
		container.querySelectorAll('.issue').forEach(function (el) {
			el.addEventListener('click', function () {
				openHeading(
					el.getAttribute('data-path'),
					Number(el.getAttribute('data-fid')),
					Number(el.getAttribute('data-hid')),
					el.getAttribute('data-title')
				);
			});
		});
	}

	/**
	 * Issues matching the detail search text (title or issue key).
	 * @param {any[]} list
	 */
	function filterIssuesByQuery(list) {
		const q = String(issueQuery || '').trim().toLowerCase();
		if (!q) return list;
		return list.filter(function (i) {
			return (
				String(i.title || '').toLowerCase().indexOf(q) !== -1 ||
				String(i.issueKey || '').toLowerCase().indexOf(q) !== -1
			);
		});
	}

	/**
	 * Stamp each project issue with its `feature` name (the feature it belongs to, or
	 * "Project issues" for the inbox), and refresh the `feature` enum's values so the
	 * issues-view group/column/row/filter lists show the real, sorted feature names.
	 */
	function enrichIssuesWithFeature() {
		const features = detail.features || [];
		const issues = detail.issues || [];
		issues.forEach(function (i) {
			let feat = null;
			if (i.inProjectInbox) {
				feat = 'Project issues';
			} else {
				const fp = i.featurePathPrefix;
				if (fp) {
					for (let k = 0; k < features.length; k++) {
						const f = features[k];
						if (f.folderPrefix && (fp === f.folderPrefix || fp.startsWith(f.folderPrefix))) {
							feat = f.title;
							break;
						}
						if (fp === f.path) {
							feat = f.title;
							break;
						}
					}
				}
			}
			i.feature = feat || 'Other';
		});
		const featField = DF ? DF.fieldById(issueFields, 'feature') : undefined;
		if (featField) {
			const seen = new Set();
			issues.forEach(function (i) { seen.add(String(i.feature || '')); });
			featField.values = Array.from(seen)
				.filter(Boolean)
				.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
		}
	}

	// ---- issues view (flat, searchable browser for one project's issues) ----

	function issueFilterableFields() { return filterableFields(issueFields); }
	function issueDisplayableFields() { return displayableFields(issueFields); }
	function issueGroupableFields() { return groupableFields(issueFields); }

	function issueActiveFilterCount() {
		let n = 0;
		issueFields.forEach(function (f) { n += (issuesFilters[f.id] || []).length; });
		return n;
	}
	function issueHiddenFieldCount() {
		let n = 0;
		issueDisplayableFields().forEach(function (f) { if (issuesDisplay[f.id] === false) n++; });
		return n;
	}
	function issueGroupSortActive() {
		if (issuesView === 'board') {
			return (
				issuesBoardColumnBy !== '' ||
				issuesBoardRowBy !== '' ||
				issuesBoardOrderBy !== 'title' ||
				issuesBoardOrderDir !== 'asc'
			);
		}
		return issuesListGroupBy !== '' || issuesListOrderBy !== 'title' || issuesListOrderDir !== 'asc';
	}

	function searchOnlyIssues() {
		let list = (detail.issues || []).slice();
		const q = issuesQuery.trim().toLowerCase();
		if (q) {
			list = list.filter(function (i) {
				const hay = String(i.title || '') + ' ' + String(i.issueKey || '');
				return hay.toLowerCase().indexOf(q) !== -1;
			});
		}
		return list;
	}
	function visibleIssues() {
		let list = searchOnlyIssues();
		issueFields.forEach(function (f) {
			const vals = issuesFilters[f.id];
			if (!vals || !vals.length) return;
			list = list.filter(function (item) { return filterMatches(item, f, vals); });
		});
		return list;
	}
	function issueHiddenByFilterCount() {
		if (issueActiveFilterCount() === 0) return 0;
		return searchOnlyIssues().length - visibleIssues().length;
	}

	function toggleIssuesFilterValue(fieldId, value) {
		const list = (issuesFilters[fieldId] || []).slice();
		const idx = list.indexOf(value);
		if (idx === -1) list.push(value);
		else list.splice(idx, 1);
		if (list.length) issuesFilters[fieldId] = list;
		else delete issuesFilters[fieldId];
	}
	function setIssuesCustomDeadline(fieldId, dateStr) {
		const list = (issuesFilters[fieldId] || []).filter(function (v) {
			return v.indexOf('custom:') !== 0;
		});
		if (dateStr) list.push('custom:' + dateStr);
		if (list.length) issuesFilters[fieldId] = list;
		else delete issuesFilters[fieldId];
	}
	function clearIssuesFilters() {
		issuesQuery = '';
		issuesFilters = {};
		issuesDisplay = {};
		issuesListGroupBy = '';
		issuesListOrderBy = 'title';
		issuesListOrderDir = 'asc';
		issuesBoardColumnBy = '';
		issuesBoardRowBy = '';
		issuesBoardOrderBy = 'title';
		issuesBoardOrderDir = 'asc';
		issuesView = 'list';
		openIssuesMenu = '';
		openIssuesFilterField = '';
		openIssuesChipField = '';
		renderProjectDetail();
	}

	function issuesMenuButton(key, label, badge) {
		const alignRight = key === 'display' || key === 'groupsort';
		return (
			'<span class="menu-anchor' +
			(alignRight ? ' align-right' : '') +
			'">' +
			'<button type="button" class="ghost menu-btn' +
			(openIssuesMenu === key ? ' open' : '') +
			'" data-issues-menu="' +
			key +
			'">' +
			esc(label) +
			(badge > 0 ? '<span class="bubble">' + badge + '</span>' : '') +
			'</button>' +
			(openIssuesMenu === key ? renderIssuesMenuPanel(key) : '') +
			'</span>'
		);
	}

	function renderIssuesMenuPanel(key) {
		if (key === 'filter') return renderIssuesFilterMenu();
		if (key === 'display') return renderIssuesDisplayMenu();
		if (key === 'groupsort') return renderIssuesGroupSortMenu();
		return '';
	}

	function renderIssuesFilterMenu() {
		const fields = issueFilterableFields();
		let rows = '';
		fields.forEach(function (f) {
			const active = (issuesFilters[f.id] || []).length > 0;
			const expanded = openIssuesFilterField === f.id;
			rows += '<div class="fmenu-item' + (expanded ? ' open' : '') + '">';
			rows +=
				'<button type="button" class="fmenu-head" data-issues-field="' +
				esc(f.id) +
				'">' +
				'<span class="fmark' +
				(active ? ' on' : '') +
				'"></span>' +
				'<span class="fmenu-label">' +
				esc(f.label) +
				'</span>' +
				'<span class="chev">\u203a</span>' +
				'</button>';
			if (expanded) rows += renderFilterSubmenu(f, issuesFilters[f.id] || []);
			rows += '</div>';
		});
		return '<div class="menu-panel" id="issuesFilterMenu">' + rows + '</div>';
	}

	function renderIssuesDisplayMenu() {
		let rows = '';
		issueDisplayableFields().forEach(function (f) {
			const on = issuesDisplay[f.id] !== false;
			rows +=
				'<label class="fopt"><input type="checkbox" data-issues-display="' +
				esc(f.id) +
				'"' +
				(on ? ' checked' : '') +
				' /> <span>' +
				esc(f.label) +
				'</span></label>';
		});
		return (
			'<div class="menu-panel" id="issuesDisplayMenu">' +
			'<div class="gs-label view-label">View</div>' +
			'<div class="view-toggle">' +
			'<button type="button" class="vt-btn' +
			(issuesView === 'list' ? ' active' : '') +
			'" data-issues-view="list">List</button>' +
			'<button type="button" class="vt-btn' +
			(issuesView === 'board' ? ' active' : '') +
			'" data-issues-view="board">Board</button>' +
			'</div>' +
			'<div class="gs-label view-label">Fields</div>' +
			rows +
			'</div>'
		);
	}

	function renderIssuesGroupSortMenu() {
		const isBoard = issuesView === 'board';
		let sections = '';
		if (isBoard) {
			sections += fieldSelectSection('igsColumn', 'Column', issuesBoardColumnBy, issueGroupableFields(), [issuesBoardRowBy, issuesBoardOrderBy], true);
			sections += fieldSelectSection('igsRow', 'Row', issuesBoardRowBy, issueGroupableFields(), [issuesBoardColumnBy, issuesBoardOrderBy], true);
			sections += fieldSelectSection('igsOrder', 'Order by', issuesBoardOrderBy, issueFields, [issuesBoardColumnBy, issuesBoardRowBy], false);
		} else {
			sections += fieldSelectSection('igsGroup', 'Group by', issuesListGroupBy, issueGroupableFields(), [issuesListOrderBy], true);
			sections += fieldSelectSection('igsOrder', 'Order by', issuesListOrderBy, issueFields, [issuesListGroupBy], false);
		}

		const orderBy = isBoard ? issuesBoardOrderBy : issuesListOrderBy;
		const dirField = (DF && DF.fieldById(issueFields, orderBy)) || { kind: 'text' };
		const dirs = DF ? DF.orderDirectionsForKind(dirField.kind) : ['asc', 'desc'];
		const curDir = isBoard ? issuesBoardOrderDir : issuesListOrderDir;
		let dirBtns = '';
		dirs.forEach(function (d) {
			const icon = d === 'asc' ? '\u2191' : d === 'desc' ? '\u2193' : '\u21c5';
			const label = d === 'asc' ? 'Ascending' : d === 'desc' ? 'Descending' : 'Custom';
			dirBtns +=
				'<button type="button" class="dir-btn' +
				(curDir === d ? ' active' : '') +
				'" data-issues-dir="' +
				d +
				'" title="' +
				esc(label) +
				'">' +
				icon +
				'</button>';
		});

		return (
			'<div class="menu-panel gs" id="issuesGroupSortMenu">' +
			sections +
			'<div class="gs-section"><div class="gs-label">Direction</div><div class="dir-row">' +
			dirBtns +
			'</div></div>' +
			'</div>'
		);
	}

	function renderIssuesFilterChips() {
		/** @type {string[]} */
		const parts = [];
		issueFields.forEach(function (f) {
			const vals = issuesFilters[f.id] || [];
			if (!vals.length) return;
			const open = openIssuesChipField === f.id;
			parts.push(
				'<span class="chip-anchor">' +
				'<button type="button" class="filter-chip' +
				(open ? ' open' : '') +
				'" data-issues-field="' +
				esc(f.id) +
				'" title="Edit ' +
				esc(f.label) +
				' filter">' +
				esc(f.label) +
				' <span class="chip-count">' +
				vals.length +
				'</span></button>' +
				(open ? '<div class="chip-popover">' + renderFilterSubmenu(f, vals) + '</div>' : '') +
				'</span>'
			);
		});
		if (!parts.length) return '';
		return '<div class="proj-chips">' + parts.join('') + '</div>';
	}

	function renderIssuesToolbar() {
		const filterCount = issueActiveFilterCount();
		const displayOff = issueHiddenFieldCount() + (issuesView === 'board' ? 1 : 0);
		const gsActive = issueGroupSortActive();
		const anyActive = filterCount > 0 || displayOff > 0 || gsActive;

		return (
			'<div class="proj-toolbar">' +
			'<div class="proj-toolbar-row">' +
			'<input type="text" id="issuesSearch" class="proj-search" placeholder="Search issues\u2026" autocomplete="off" value="' +
			esc(issuesQuery) +
			'" />' +
			issuesMenuButton('filter', 'Filter', filterCount) +
			issuesMenuButton('display', 'Display', displayOff) +
			issuesMenuButton('groupsort', 'Sort', gsActive ? 1 : 0) +
			(anyActive ? '<button type="button" class="ghost clear-btn" id="issuesClearAll">Clear</button>' : '') +
			'</div>' +
			renderIssuesFilterChips() +
			'</div>'
		);
	}

	/** Columns shown in the issues list: title + every visible issue field. */
	function issuesVisibleColumns() {
		const cols = ['title'];
		issueDisplayableFields().forEach(function (f) {
			if (issuesDisplay[f.id] !== false) cols.push(f.id);
		});
		return cols;
	}
	function issuesColumnLabel(id) {
		if (id === 'title') return 'Title';
		const f = DF ? DF.fieldById(issueFields, id) : undefined;
		return f ? f.label : id;
	}
	function issuesCellValue(id, item) {
		if (id === 'title') return String(item.title || '');
		const f = DF ? DF.fieldById(issueFields, id) : undefined;
		if (!f) return '';
		if (id === 'deadline') {
			const d = f.get(item);
			return d != null ? formatDate(d) : '';
		}
		const v = f.get(item);
		return v != null ? String(v) : '';
	}

	function renderIssuesListHeader(cols, tmpl) {
		let head = '<div class="lt-row lt-head" style="grid-template-columns:' + tmpl + '">';
		cols.forEach(function (id) {
			head += '<div class="lt-cell">' + esc(issuesColumnLabel(id)) + '</div>';
		});
		head += '</div>';
		return head;
	}
	function renderIssuesListRows(list, cols, tmpl) {
		let rows = '';
		list.forEach(function (i) {
			rows +=
				'<div class="lt-row issue-list-row" role="button" tabindex="0" style="grid-template-columns:' +
				tmpl +
				'" data-path="' +
				esc(i.path) +
				'" data-fid="' +
				i.fileId +
				'" data-hid="' +
				i.headingId +
				'" data-title="' +
				esc(i.title) +
				'">';
			cols.forEach(function (id) {
				if (id === 'title') {
					rows +=
						'<div class="lt-cell">' +
						esc(i.title) +
						(i.issueKey ? ' <span class="issue-key">' + esc(i.issueKey) + '</span>' : '') +
						'</div>';
				} else {
					rows += '<div class="lt-cell">' + esc(issuesCellValue(id, i)) + '</div>';
				}
			});
			rows += '</div>';
		});
		return rows;
	}

	function renderIssuesBoardCard(i) {
		/** @type {string[]} */
		const pills = [];
		issueFields.forEach(function (f) {
			if (f.id === 'title') return;
			if (issuesDisplay[f.id] === false) return;
			const v = f.get(i);
			if (f.id === 'deadline') {
				if (v != null) pills.push('Due ' + formatDate(v));
				return;
			}
			if (v != null && String(v) !== '') pills.push(String(v));
		});
		return (
			'<div class="issue-card" role="button" tabindex="0" data-path="' +
			esc(i.path) +
			'" data-fid="' +
			i.fileId +
			'" data-hid="' +
			i.headingId +
			'" data-title="' +
			esc(i.title) +
			'">' +
			'<span class="title">' +
			esc(i.title) +
			'</span>' +
			(i.issueKey ? ' <span class="issue-key">' + esc(i.issueKey) + '</span>' : '') +
			(pills.length
				? '<span class="pills">' +
				  pills.map(function (p) { return '<span class="pill">' + esc(p) + '</span>'; }).join('') +
				  '</span>'
				: '') +
			'</div>'
		);
	}

	function renderIssuesList(list) {
		const cols = issuesVisibleColumns();
		const tmpl = columnTemplate(cols);
		if (!issuesListGroupBy) {
			sortList(list, issuesListOrderBy, issuesListOrderDir, issueFields);
			return (
				'<div class="list-table">' +
				renderIssuesListHeader(cols, tmpl) +
				renderIssuesListRows(list, cols, tmpl) +
				'</div>'
			);
		}
		const field = DF ? DF.fieldById(issueFields, issuesListGroupBy) : undefined;
		const keys = orderedGroupKeys(field || { kind: 'text', values: [] }, list);
		let body = '';
		keys.forEach(function (k) {
			const items = list.filter(function (p) { return groupKeyForItem(field, p) === k; });
			sortList(items, issuesListOrderBy, issuesListOrderDir, issueFields);
			const collapsed = collapsedIssuesListGroups.has(k);
			body +=
				'<details class="lt-group"' +
				(collapsed ? '' : ' open') +
				' data-group="' +
				esc(k) +
				'"><summary class="lt-group-head">' +
				esc(k) +
				'<span class="count">' +
				items.length +
				'</span></summary>' +
				renderIssuesListRows(items, cols, tmpl) +
				'</details>';
		});
		return (
			'<div class="list-table">' +
			renderIssuesListHeader(cols, tmpl) +
			body +
			'</div>'
		);
	}

	function renderIssuesBoard(list) {
		const colField = DF ? DF.fieldById(issueFields, issuesBoardColumnBy) : undefined;
		const rowField = DF ? DF.fieldById(issueFields, issuesBoardRowBy) : undefined;
		const colKeys = colField ? orderedGroupKeys(colField, list) : ['(all)'];
		const rowKeys = rowField ? orderedGroupKeys(rowField, list) : null;

		/** @type {Map<string, any[]>} */
		const buckets = new Map();
		list.forEach(function (i) {
			const c = colField ? groupKeyForItem(colField, i) : '(all)';
			const r = rowField ? groupKeyForItem(rowField, i) : '';
			const k = c + '||' + r;
			if (!buckets.has(k)) buckets.set(k, []);
			buckets.get(k).push(i);
		});

		const nCols = colKeys.length;
		const tmpl = 'repeat(' + nCols + ', 240px)';

		let header = '';
		colKeys.forEach(function (c) {
			let cnt = 0;
			(rowKeys || ['']).forEach(function (r) {
				cnt += (buckets.get(c + '||' + r) || []).length;
			});
			header += '<div class="bcol-head">' + esc(c) + '<span class="count">' + cnt + '</span></div>';
		});

		let body = '';
		if (rowField && rowKeys) {
			rowKeys.forEach(function (r) {
				let cnt = 0;
				colKeys.forEach(function (c) {
					cnt += (buckets.get(c + '||' + r) || []).length;
				});
				const collapsed = collapsedIssuesBoardRows.has(r);
				body +=
					'<button type="button" class="brow-head' +
					(collapsed ? ' collapsed' : '') +
					'" style="grid-column:1 / -1" data-issues-row="' +
					esc(r) +
					'"><span class="brow-label">' +
					esc(r) +
					'</span><span class="count">' +
					cnt +
					'</span></button>';
				colKeys.forEach(function (c) {
					const items = buckets.get(c + '||' + r) || [];
					sortList(items, issuesBoardOrderBy, issuesBoardOrderDir, issueFields);
					body +=
						'<div class="bcell' +
						(collapsed ? ' collapsed' : '') +
						'">' +
						items.map(renderIssuesBoardCard).join('') +
						'</div>';
				});
			});
		} else {
			colKeys.forEach(function (c) {
				const items = buckets.get(c + '||') || [];
				sortList(items, issuesBoardOrderBy, issuesBoardOrderDir, issueFields);
				body += '<div class="bcell">' + items.map(renderIssuesBoardCard).join('') + '</div>';
			});
		}

		return (
			'<div class="board-scroll"><div class="board-grid" style="grid-template-columns:' +
			tmpl +
			'">' +
			header +
			body +
			'</div></div>'
		);
	}

	/** Shared detail header (back / title / Overview / Tags / Features-Issues switch / New issue). */
	function detailHeaderHtml(title) {
		return (
			'<div class="toolbar">' +
			'<button type="button" class="ghost" id="btnBack">\u2190 Projects</button>' +
			'<h2>' +
			esc(title) +
			'</h2>' +
			'<button type="button" class="ghost" id="btnProjectSettings" title="Project settings">\u2699</button>' +
			'<button type="button" class="ghost" id="btnOverview">Overview</button>' +
			'<button type="button" class="ghost" id="btnArchitecture">Architecture</button>' +
			'<button type="button" class="ghost" id="btnTags">Tags</button>' +
			'<div class="detail-switch">' +
			'<button type="button" class="vs-btn' +
			(detailView === 'features' ? ' active' : '') +
			'" data-detail-view="features">Features</button>' +
			'<button type="button" class="vs-btn' +
			(detailView === 'issues' ? ' active' : '') +
			'" data-detail-view="issues">Issues</button>' +
			'</div>' +
			'<button type="button" id="btnNewIssue">New issue</button>' +
			'</div>'
		);
	}

	function bindDetailHeader() {
		const backBtn = document.getElementById('btnBack');
		if (backBtn) backBtn.addEventListener('click', goBack);
		const btnNew = document.getElementById('btnNewIssue');
		if (btnNew) btnNew.addEventListener('click', function () { openCompose(''); });
		const btnProjectSettings = document.getElementById('btnProjectSettings');
		if (btnProjectSettings)
			btnProjectSettings.addEventListener('click', function () {
				vscode.postMessage({ type: 'openProjectSettings', folderPrefix: selectedPrefix, title: selectedTitle });
			});
		const btnOverview = document.getElementById('btnOverview');
		if (btnOverview)
			btnOverview.addEventListener('click', function () {
				vscode.postMessage({ type: 'openProjectOverview', folderPrefix: selectedPrefix });
			});
		const btnArchitecture = document.getElementById('btnArchitecture');
		if (btnArchitecture)
			btnArchitecture.addEventListener('click', function () {
				vscode.postMessage({ type: 'openProjectArchitecture', folderPrefix: selectedPrefix, title: selectedTitle });
			});
		const btnTags = document.getElementById('btnTags');
		if (btnTags)
			btnTags.addEventListener('click', function (e) {
				e.stopPropagation();
				toggleTagsPopover();
			});
		root.querySelectorAll('.vs-btn').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.stopPropagation();
				detailView = btn.getAttribute('data-detail-view') === 'issues' ? 'issues' : 'features';
				renderProjectDetail();
			});
		});
	}

	function bindIssuesToolbar() {
		const search = document.getElementById('issuesSearch');
		if (search) {
			search.addEventListener('input', function () {
				issuesQuery = search.value;
				renderProjectDetail();
				const again = document.getElementById('issuesSearch');
				if (again) {
					again.focus();
					try {
						again.setSelectionRange(again.value.length, again.value.length);
					} catch (e) {
						/* ignore */
					}
				}
			});
		}
		root.querySelectorAll('[data-issues-menu]').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.stopPropagation();
				const key = btn.getAttribute('data-issues-menu') || '';
				openIssuesMenu = openIssuesMenu === key ? '' : key;
				if (openIssuesMenu === 'filter') openIssuesFilterField = '';
				renderProjectDetail();
			});
		});
		root.querySelectorAll('.fmenu-head[data-issues-field]').forEach(function (head) {
			head.addEventListener('click', function (e) {
				e.stopPropagation();
				const fid = head.getAttribute('data-issues-field') || '';
				openIssuesFilterField = openIssuesFilterField === fid ? '' : fid;
				renderProjectDetail();
			});
		});
		root.querySelectorAll('.fsub input[type="checkbox"]').forEach(function (cb) {
			cb.addEventListener('click', function (e) {
				e.stopPropagation();
			});
			cb.addEventListener('change', function () {
				const fid = cb.getAttribute('data-field') || '';
				const val = cb.getAttribute('data-value') || '';
				toggleIssuesFilterValue(fid, val);
				renderProjectDetail();
			});
		});
		root.querySelectorAll('.fcustom').forEach(function (input) {
			input.addEventListener('click', function (e) {
				e.stopPropagation();
			});
			input.addEventListener('change', function () {
				const fid = input.getAttribute('data-field') || '';
				setIssuesCustomDeadline(fid, input.value);
				renderProjectDetail();
			});
		});
		root.querySelectorAll('input[data-issues-display]').forEach(function (cb) {
			cb.addEventListener('click', function (e) {
				e.stopPropagation();
			});
			cb.addEventListener('change', function () {
				const fid = cb.getAttribute('data-issues-display') || '';
				issuesDisplay[fid] = cb.checked;
				renderProjectDetail();
			});
		});
		root.querySelectorAll('[data-issues-view]').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.stopPropagation();
				issuesView = btn.getAttribute('data-issues-view') === 'board' ? 'board' : 'list';
				renderProjectDetail();
			});
		});
		const igsGroup = document.getElementById('igsGroup');
		if (igsGroup) {
			igsGroup.addEventListener('change', function () {
				issuesListGroupBy = igsGroup.value;
				renderProjectDetail();
			});
		}
		const igsColumn = document.getElementById('igsColumn');
		if (igsColumn) {
			igsColumn.addEventListener('change', function () {
				issuesBoardColumnBy = igsColumn.value;
				renderProjectDetail();
			});
		}
		const igsRow = document.getElementById('igsRow');
		if (igsRow) {
			igsRow.addEventListener('change', function () {
				issuesBoardRowBy = igsRow.value;
				renderProjectDetail();
			});
		}
		const igsOrder = document.getElementById('igsOrder');
		if (igsOrder) {
			igsOrder.addEventListener('change', function () {
				const v = igsOrder.value;
				if (issuesView === 'board') {
					issuesBoardOrderBy = v;
					if (issuesBoardOrderDir === 'custom') issuesBoardOrderDir = 'asc';
				} else {
					issuesListOrderBy = v;
					if (issuesListOrderDir === 'custom') issuesListOrderDir = 'asc';
				}
				renderProjectDetail();
			});
		}
		root.querySelectorAll('[data-issues-dir]').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.stopPropagation();
				const d = btn.getAttribute('data-issues-dir') || 'asc';
				if (issuesView === 'board') issuesBoardOrderDir = d;
				else issuesListOrderDir = d;
				renderProjectDetail();
			});
		});
		root.querySelectorAll('.filter-chip[data-issues-field]').forEach(function (chip) {
			chip.addEventListener('click', function (e) {
				e.stopPropagation();
				const fid = chip.getAttribute('data-issues-field') || '';
				openIssuesMenu = '';
				openIssuesFilterField = '';
				openIssuesChipField = openIssuesChipField === fid ? '' : fid;
				renderProjectDetail();
			});
		});
		root.querySelectorAll('.lt-group').forEach(function (grp) {
			grp.addEventListener('toggle', function () {
				const k = grp.getAttribute('data-group') || '';
				if (!grp.open) collapsedIssuesListGroups.add(k);
				else collapsedIssuesListGroups.delete(k);
			});
		});
		root.querySelectorAll('[data-issues-row]').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.stopPropagation();
				const r = btn.getAttribute('data-issues-row') || '';
				if (collapsedIssuesBoardRows.has(r)) collapsedIssuesBoardRows.delete(r);
				else collapsedIssuesBoardRows.add(r);
				renderProjectDetail();
			});
		});
		const removeFilters = document.getElementById('issuesRemoveFilters');
		if (removeFilters) {
			removeFilters.addEventListener('click', function (e) {
				e.stopPropagation();
				issuesFilters = {};
				renderProjectDetail();
			});
		}
		const clear = document.getElementById('issuesClearAll');
		if (clear) {
			clear.addEventListener('click', function (e) {
				e.stopPropagation();
				clearIssuesFilters();
			});
		}
	}

	function bindIssuesView() {
		root.querySelectorAll('.issue-list-row, .issue-card').forEach(function (el) {
			el.addEventListener('click', function () {
				openHeading(
					el.getAttribute('data-path'),
					Number(el.getAttribute('data-fid')),
					Number(el.getAttribute('data-hid')),
					el.getAttribute('data-title')
				);
			});
			el.addEventListener('keydown', function (e) {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					openHeading(
						el.getAttribute('data-path'),
						Number(el.getAttribute('data-fid')),
						Number(el.getAttribute('data-hid')),
						el.getAttribute('data-title')
					);
				}
			});
		});
	}

	function renderIssuesView(title) {
		const visible = visibleIssues();
		let body = '';
		if (!visible.length) {
			body =
				detail.issues && detail.issues.length
					? '<p class="muted-block">No issues match your search or filters.</p>'
					: '<p class="muted-block">No issues in this project yet.</p>';
		} else if (issuesView === 'board') {
			body = renderIssuesBoard(visible);
		} else {
			body = renderIssuesList(visible);
		}

		const hidden = issueHiddenByFilterCount();
		let footer = '';
		if (hidden > 0) {
			footer =
				'<div class="hidden-note"><span>' +
				hidden +
				' hidden by filters</span>' +
				'<button type="button" class="ghost" id="issuesRemoveFilters">Remove filters</button></div>';
		}

		let html = detailHeaderHtml(title);
		if (compose) html += renderComposeForm();
		html += renderIssuesToolbar() + body + footer;

		root.innerHTML = html;
		bindDetailHeader();
		if (compose) bindCompose();
		bindIssuesToolbar();
		bindIssuesView();
	}

	function renderProjectDetail() {
		const title = selectedTitle || selectedPrefix.replace(/\/+$/, '') || 'Project';

		if (detailLoading) {
			root.innerHTML = detailHeaderHtml(title) + '<div class="empty">Loading features and issues\u2026</div>';
			bindDetailHeader();
			return;
		}

		if (detailView === 'issues') {
			renderIssuesView(title);
			return;
		}

		const features = detail.features || [];
		const issues = detail.issues || [];
		const hasQuery = String(issueQuery || '').trim() !== '';
		const inbox = filterIssuesByQuery(issues.filter(function (i) {
			return i.inProjectInbox;
		}));
		const elsewhere = filterIssuesByQuery(issues.filter(function (i) {
			return !i.inProjectInbox;
		}));
		/** @type {Map<string, any>} */
		const issueIndex = new Map();
		issues.forEach(function (i) {
			if (i.issueKey) issueIndex.set(String(i.issueKey).toLowerCase(), i);
		});

		let html = detailHeaderHtml(title);
		html +=
			'<div class="toolbar issue-toolbar">' +
			'<input type="text" id="issueSearch" class="proj-search" placeholder="Search issues\u2026" autocomplete="off" value="' +
			esc(issueQuery) +
			'" />' +
			'<label class="parent-chain-toggle"><input type="checkbox" id="showParentChain"' +
			(showParentChain ? ' checked' : '') +
			' /> Show repeated parent issue</label>' +
			'</div>';

		// Project issues (inbox) section — hidden while searching when empty.
		if (inbox.length || !hasQuery) {
			html +=
				'<div class="section"><div class="section-head"><h3>Project issues (_issues)</h3><span class="count">' +
				inbox.length +
				'</span></div>';
			if (!hasQuery) html += renderComposeForm();
			html +=
				'<div class="card"><div>' +
			(inbox.length
				? renderIssueForest(inbox, false, issueIndex)
				: '<div class="muted-block">No inbox issues yet. Use New issue above.</div>') +
				'</div></div></div>';
		}

		html +=
			'<div class="section"><div class="section-head"><h3>Features</h3><span class="count">' +
			features.length +
			'</span></div>';
		if (!features.length) {
			html +=
				'<div class="card"><div class="muted-block">No .f features yet. Create a feature folder under this project.</div></div>';
		} else {
			features.forEach(function (f) {
				const childIssues = elsewhere.filter(function (i) {
					return (
						i.featurePathPrefix &&
						(i.featurePathPrefix === f.folderPrefix || i.featurePathPrefix === f.path)
					);
				});
				// While searching, skip features with no matching issues.
				if (hasQuery && !childIssues.length) return;
				html += '<details class="card" open>';
				html +=
					'<summary><span class="chip">' +
					(f.isFolderIndex ? 'folder' : 'file') +
					'</span> ' +
					'<button type="button" class="linkish feat-open" data-path="' +
					esc(f.path) +
					'" data-fid="' +
					f.fileId +
					'" data-hid="' +
					f.headingId +
					'" data-title="' +
					esc(f.title) +
					'">' +
					esc(f.title) +
					'</button>' +
					'<span class="count">' +
					childIssues.length +
					' issues</span>' +
					'<button type="button" class="feat-overview" data-folder-prefix="' +
					esc(f.folderPrefix || '') +
					'" data-path="' +
					esc(f.path) +
					'" data-is-folder-index="' +
					(f.isFolderIndex ? '1' : '0') +
					'">Overview</button></summary>';
				html +=
					'<div>' +
					(childIssues.length
						? renderIssueForest(childIssues, true, issueIndex)
						: '<div class="muted-block">No issues in this feature yet.</div>') +
					'</div>';
				html += '</details>';
			});
		}
		html += '</div>';

		if (hasQuery && !inbox.length && !elsewhere.length) {
			html += '<div class="muted-block">No issues match your search.</div>';
		}

		root.innerHTML = html;
		bindDetailHeader();
		bindIssueSearch();
		bindCompose();
		root.querySelectorAll('.feat-open').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				openHeading(
					btn.getAttribute('data-path'),
					Number(btn.getAttribute('data-fid')),
					Number(btn.getAttribute('data-hid')),
					btn.getAttribute('data-title')
				);
			});
		});
		root.querySelectorAll('.feat-overview').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				vscode.postMessage({
					type: 'openFeatureOverview',
					folderPrefix: selectedPrefix,
					featureFolderPrefix: btn.getAttribute('data-folder-prefix') || '',
					path: btn.getAttribute('data-path') || '',
					isFolderIndex: btn.getAttribute('data-is-folder-index') === '1'
				});
			});
		});
		bindIssues(root);
		bindIssueActions();
	}

	/**
	 * Bind assign / move / sub / popover / inline-sub controls in the detail view.
	 */
	function bindIssueActions() {
		// Inbox issue: open the RHS Storage sidebar in "move issue" mode.
		root.querySelectorAll('.issue-assign').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				const ikey = btn.getAttribute('data-ikey') || '';
				if (!ikey) return;
				vscode.postMessage({
					type: 'moveIssue',
					folderPrefix: selectedPrefix,
					issueId: ikey
				});
			});
		});
		// Feature issue: open the RHS Storage sidebar in "move issue" mode.
		root.querySelectorAll('.issue-move').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				const ikey = btn.getAttribute('data-ikey') || '';
				if (!ikey) return;
				vscode.postMessage({
					type: 'moveIssue',
					folderPrefix: selectedPrefix,
					issueId: ikey
				});
			});
		});
		// Sub: open an inline sub-issue form under the issue.
		root.querySelectorAll('.issue-sub').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				const ikey = btn.getAttribute('data-ikey') || '';
				if (!ikey) return;
				inlineSubKey = inlineSubKey === ikey ? '' : ikey;
				renderProjectDetail();
			});
		});

		// Inline sub-issue form.
		root.querySelectorAll('.inline-sub').forEach(function (form) {
			const ikey = form.getAttribute('data-ikey') || '';
			const input = form.querySelector('.inline-sub-input');
			const create = form.querySelector('.inline-sub-create');
			const cancel = form.querySelector('.inline-sub-cancel');
			if (create) {
				create.addEventListener('click', function (e) {
					e.stopPropagation();
					submitInlineSub(ikey, input);
				});
			}
			if (cancel) {
				cancel.addEventListener('click', function (e) {
					e.stopPropagation();
					inlineSubKey = '';
					renderProjectDetail();
				});
			}
			if (input) {
				input.addEventListener('click', function (e) {
					e.stopPropagation();
				});
				input.addEventListener('keydown', function (e) {
					if (e.key === 'Enter') {
						e.preventDefault();
						submitInlineSub(ikey, input);
					} else if (e.key === 'Escape') {
						e.preventDefault();
						inlineSubKey = '';
						renderProjectDetail();
					}
				});
				input.focus();
			}
		});
	}

	/**
	 * @param {string} ikey
	 * @param {HTMLInputElement | null} input
	 */
	function submitInlineSub(ikey, input) {
		const title = input ? String(input.value || '').trim() : '';
		if (!title) {
			if (input) input.focus();
			return;
		}
		inlineSubKey = '';
		vscode.postMessage({
			type: 'createIssue',
			folderPrefix: selectedPrefix,
			parentIssueId: ikey,
			title: title
		});
		detailLoading = true;
		renderProjectDetail();
	}

	/** Create (once) the persistent Tags popover overlay, appended outside `root`. */
	function ensureTagsPopoverEl() {
		if (tagsPopoverEl) return tagsPopoverEl;
		tagsPopoverEl = document.createElement('div');
		tagsPopoverEl.id = 'dripTagsPopover';
		tagsPopoverEl.className = 'tags-popover';
		tagsPopoverEl.style.display = 'none';
		document.body.appendChild(tagsPopoverEl);
		tagsPopoverEl.addEventListener('click', function (e) {
			if (e.target === tagsPopoverEl) closeTagsPopover();
		});
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && tagsPopoverOpen) closeTagsPopover();
		});
		return tagsPopoverEl;
	}

	function openTagsPopover() {
		tagsPopoverOpen = true;
		ensureTagsPopoverEl();
		// Request fresh tags; render immediately with what we have, then update on reply.
		vscode.postMessage({ type: 'requestProjectTags', folderPrefix: selectedPrefix });
		renderTagsPopover();
	}

	function closeTagsPopover() {
		tagsPopoverOpen = false;
		if (tagsPopoverEl) tagsPopoverEl.style.display = 'none';
	}

	function toggleTagsPopover() {
		if (tagsPopoverOpen) closeTagsPopover();
		else openTagsPopover();
	}

	function renderTagsPopover() {
		const el = ensureTagsPopoverEl();
		if (!tagsPopoverOpen) {
			el.style.display = 'none';
			return;
		}
		el.style.display = '';
		let html =
			'<div class="tags-popover-card">' +
			'<div class="tags-popover-head"><span>Project tags</span><button type="button" id="tagsPopClose">\u00d7</button></div>' +
			'<div class="tags-popover-body">' +
			'<div class="tags-add-row">' +
			'<input id="tagsNewName" type="text" placeholder="Tag name" autocomplete="off" />' +
			'<input id="tagsNewDesc" type="text" placeholder="Description (optional)" autocomplete="off" />' +
			'<button type="button" id="tagsAddBtn">Add</button>' +
			'</div>';
		if (!projectTags.length) {
			html += '<div class="muted-block">No tags yet.</div>';
		} else {
			html += '<ul class="tags-popover-list">';
			projectTags.forEach(function (t) {
				html +=
					'<li data-tag-id="' +
					esc(t.id) +
					'"><div class="tag-line">' +
					'<input type="text" class="tag-name-inp" value="' +
					esc(t.name) +
					'" autocomplete="off" />' +
					'<button type="button" class="tag-del" title="Delete tag">\uD83D\uDDD1</button>' +
					'</div>' +
					'<input type="text" class="tag-desc-inp" placeholder="Description" value="' +
					esc(t.description || '') +
					'" autocomplete="off" /></li>';
			});
			html += '</ul>';
		}
		html += '</div></div>';
		el.innerHTML = html;
		bindTagsPopover();
	}

	function bindTagsPopover() {
		const el = ensureTagsPopoverEl();
		const close = document.getElementById('tagsPopClose');
		if (close) close.addEventListener('click', closeTagsPopover);
		const addBtn = document.getElementById('tagsAddBtn');
		const nameInp = document.getElementById('tagsNewName');
		const descInp = document.getElementById('tagsNewDesc');
		if (addBtn) {
			addBtn.addEventListener('click', function () {
				const name = nameInp ? String(nameInp.value || '').trim() : '';
				if (!name) return;
				vscode.postMessage({
					type: 'addProjectTag',
					folderPrefix: selectedPrefix,
					name: name,
					description: descInp ? String(descInp.value || '') : ''
				});
				if (nameInp) nameInp.value = '';
				if (descInp) descInp.value = '';
			});
		}
		el.querySelectorAll('li[data-tag-id]').forEach(function (li) {
			const tagId = li.getAttribute('data-tag-id') || '';
			const nameInp = li.querySelector('.tag-name-inp');
			const descInp = li.querySelector('.tag-desc-inp');
			const del = li.querySelector('.tag-del');
			if (nameInp) {
				nameInp.addEventListener('change', function () {
					const name = String(nameInp.value || '').trim();
					if (!name) return;
					vscode.postMessage({ type: 'renameProjectTag', folderPrefix: selectedPrefix, tagId: tagId, name: name });
				});
			}
			if (descInp) {
				descInp.addEventListener('change', function () {
					vscode.postMessage({
						type: 'setProjectTagDescription',
						folderPrefix: selectedPrefix,
						tagId: tagId,
						description: String(descInp.value || '')
					});
				});
			}
			if (del) {
				del.addEventListener('click', function () {
					vscode.postMessage({ type: 'deleteProjectTag', folderPrefix: selectedPrefix, tagId: tagId });
				});
			}
		});
	}

	function goBack() {
		selectedPrefix = '';
		selectedTitle = '';
		detail = { features: [], issues: [] };
		projectTags = [];
		closeTagsPopover();
		detailLoading = false;
		compose = null;
		issueQuery = '';
		detailView = 'features';
		inlineSubKey = '';
		openMenu = '';
		openFilterField = '';
		openChipField = '';
		openIssuePopover = '';
		vscode.postMessage({ type: 'clearProject' });
		render();
	}

	function render() {
		if (selectedPrefix) renderProjectDetail();
		else renderProjectList();
	}

	window.addEventListener('message', function (event) {
		const msg = event.data || {};
		if (msg.type === 'projects') {
			projects = msg.projects || [];
			if (msg.schema) {
				schema = msg.schema;
				projectFields = DF ? DF.hydrate((schema.project && schema.project.fields) || []) : [];
				issueFields = DF ? DF.hydrate((schema.issue && schema.issue.fields) || []) : [];
			}
			kbMeta.textContent = msg.kbLabel || '';
			if (
				selectedPrefix &&
				!projects.some(function (p) {
					return p.folderPrefix === selectedPrefix;
				})
			) {
				selectedPrefix = '';
				selectedTitle = '';
				detail = { features: [], issues: [] };
				detailLoading = false;
			}
			render();
		}
		if (msg.type === 'projectDetail') {
			detail = { features: msg.features || [], issues: msg.issues || [] };
			selectedPrefix = msg.folderPrefix || selectedPrefix;
			detailLoading = false;
			compose = null;
			enrichIssuesWithFeature();
			if (selectedPrefix) {
				const match = projects.find(function (p) {
					return p.folderPrefix === selectedPrefix;
				});
				if (match) selectedTitle = match.title || selectedTitle;
			}
			render();
		}
		if (msg.type === 'projectTagsState') {
			projectTags = msg.tags || [];
			if (tagsPopoverOpen) renderTagsPopover();
		}
		if (msg.type === 'error') {
			kbMeta.textContent = msg.message || 'Error';
			detailLoading = false;
			if (!projects.length) {
				root.innerHTML =
					'<p class="page-title">Projects</p>' +
					'<p class="page-sub">' +
					esc(msg.message || 'Failed to load projects') +
					'</p>';
			} else {
				render();
			}
		}
	});

	kbMeta.textContent = 'Connecting\u2026';
	vscode.postMessage({ type: 'ready' });
})();
