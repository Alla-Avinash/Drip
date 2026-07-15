(function () {
	'use strict';
	const vscode = acquireVsCodeApi();

	/** @type {{ id: string, label: string, marker: string }[]} */
	let metadataTypes = [];
	/** @type {string[]} */
	let allTags = [];
	/** @type {{ tag: string, count: number }[]} */
	let tagCounts = [];
	let kbMissing = false;
	/** Only the first catalog init after load should overwrite chips from disk; later inits wipe in-session picks. */
	let retrieverPersistHydrated = false;
	let headingsInCatalog = 0;
	let noteFilesVisited = 0;
	let kbRootPath = '';
	let usedWorkspaceFallback = false;
	/** Host has not run a full heading scan yet (template-only shell). */
	let catalogShellOnly = false;
	/** @type {Set<string>} */
	const selectedTypes = new Set();
	/** @type {Set<string>} */
	const selectedTags = new Set();

	/** @returns {{ scopeFiles: boolean, scopeHeadings: boolean }} */
	function readScopeFromUi() {
		const f = /** @type {HTMLInputElement | null} */ ($('rz-scope-files'));
		const h = /** @type {HTMLInputElement | null} */ ($('rz-scope-headings'));
		return {
			scopeFiles: f ? f.checked : true,
			scopeHeadings: h ? h.checked : true
		};
	}

	let viewMode = 'list';
	let groupBy = 'none';
	let sortBy = 'recent';
	let showBreadcrumbs = true;
	let showPathLine = true;
	let showTypeStrip = true;
	let showRowTags = false;

	const $ = id => document.getElementById(id);
	const QUERY_PAGE_SIZE = 500;
	/** @type {Set<string>} expanded note `relPath` keys for file-group accordion */
	const expandedFileGroupPaths = new Set();

	/** Clicks on text inside a <button> use a Text node target — Text has no .closest(). */
	function elementFromPointerEvent(ev) {
		let n = ev.target;
		if (n && n.nodeType === Node.TEXT_NODE) n = n.parentElement;
		return n instanceof Element ? n : null;
	}

	/** Chip shows marker only (e.g. `.concept`), not `label (.marker)`. */
	function metaTypeChipFaceText(t, idLower) {
		const mk = String(t && t.marker != null ? t.marker : '').trim();
		if (mk) return mk;
		if (idLower.startsWith('.')) return idLower;
		return idLower ? `.${idLower}` : '';
	}

	/** Rows accumulated across pagination (slice of full matching set). */
	let accumulatedRows = [];

	let persistTimer = null;
	function getPersistPayload() {
		const { scopeFiles, scopeHeadings } = readScopeFromUi();
		return {
			v: 4,
			q: ($('rz-heading-search') && $('rz-heading-search').value) || '',
			selectedTypeIds: [...selectedTypes],
			selectedTags: [...selectedTags],
			scopeFiles,
			scopeHeadings,
			viewMode,
			groupBy,
			sortBy,
			showBreadcrumbs: !!( $('rz-show-bc') && $('rz-show-bc').checked ),
			showPathLine: !!( $('rz-show-path') && $('rz-show-path').checked ),
			showTypeStrip: !!( $('rz-show-type') && $('rz-show-type').checked ),
			showRowTags: !!( $('rz-show-tags') && $('rz-show-tags').checked )
		};
	}
	function persistUiSoon() {
		clearTimeout(persistTimer);
		persistTimer = setTimeout(() => {
			vscode.postMessage({ type: 'retrieverSaveUi', payload: getPersistPayload() });
		}, 380);
	}

	/**
	 * @param {unknown} raw
	 */
	function applyPersistedUi(raw) {
		if (!raw || typeof raw !== 'object') return;
		const p = /** @type {Record<string, unknown>} */ (raw);
		if ($('rz-heading-search') && typeof p.q === 'string') $('rz-heading-search').value = p.q;
		selectedTypes.clear();
		if (Array.isArray(p.selectedTypeIds)) {
			for (const x of p.selectedTypeIds) {
				const id = String(x != null ? x : '')
					.trim()
					.toLowerCase();
				if (id) selectedTypes.add(id);
			}
		}
		selectedTags.clear();
		if (Array.isArray(p.selectedTags)) {
			for (const x of p.selectedTags) {
				const id = String(x != null ? x : '')
					.trim()
					.toLowerCase();
				if (id) selectedTags.add(id);
			}
		}
		const sf = /** @type {HTMLInputElement | null} */ ($('rz-scope-files'));
		const sh = /** @type {HTMLInputElement | null} */ ($('rz-scope-headings'));
		if (sf && sh) {
			const v = typeof p.v === 'number' ? p.v : 0;
			if (v >= 4 && typeof p.scopeFiles === 'boolean' && typeof p.scopeHeadings === 'boolean') {
				sf.checked = p.scopeFiles;
				sh.checked = p.scopeHeadings;
			} else {
				sf.checked = true;
				sh.checked = true;
			}
		}
		viewMode = p.viewMode === 'board' ? 'board' : 'list';
		groupBy =
			p.groupBy === 'folder' ? 'folder' : p.groupBy === 'type' ? 'type' : 'none';
		sortBy =
			p.sortBy === 'title' ? 'title' : p.sortBy === 'path' ? 'path' : 'recent';
		const sel = id => /** @type {HTMLSelectElement | null} */ ($(id));
		const vs = sel('rz-view-mode');
		if (vs) vs.value = viewMode;
		const gs = sel('rz-group-by');
		if (gs) gs.value = groupBy;
		const ss = sel('rz-sort-by');
		if (ss) ss.value = sortBy;
		function setCk(id, defVal, key) {
			const el = /** @type {HTMLInputElement | null} */ ($(id));
			if (!el) return;
			const v = p[key];
			el.checked = typeof v === 'boolean' ? v : defVal;
		}
		setCk('rz-show-bc', true, 'showBreadcrumbs');
		setCk('rz-show-path', true, 'showPathLine');
		setCk('rz-show-type', true, 'showTypeStrip');
		setCk('rz-show-tags', false, 'showRowTags');
		showBreadcrumbs = !!( $('rz-show-bc') && $('rz-show-bc').checked );
		showPathLine = !!( $('rz-show-path') && $('rz-show-path').checked );
		showTypeStrip = !!( $('rz-show-type') && $('rz-show-type').checked );
		showRowTags = !!( $('rz-show-tags') && $('rz-show-tags').checked );
	}

	/**
	 * @param {number} offset
	 */
	function queryPayload(offset) {
		const { scopeFiles, scopeHeadings } = readScopeFromUi();
		return {
			q: ($('rz-heading-search') && $('rz-heading-search').value) || '',
			selectedTypeIds: [...selectedTypes],
			selectedTags: [...selectedTags],
			selectedScopeIds: [],
			scopeFiles,
			scopeHeadings,
			sortBy,
			groupBy,
			viewMode,
			offset,
			limit: QUERY_PAGE_SIZE
		};
	}

	let flushTimer = null;
	function scheduleQuery() {
		clearTimeout(flushTimer);
		flushTimer = setTimeout(() => {
			vscode.postMessage({ type: 'retrieverQuery', payload: queryPayload(0) });
			persistUiSoon();
			scheduleSuggest();
		}, 200);
	}

	/** Lets the browser paint scope/filters before the first (often heavy) host query. */
	function runAfterNextPaint(fn) {
		if (typeof requestAnimationFrame === 'function') {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					try {
						fn();
					} catch (_) {
						// ignore
					}
				});
			});
		} else {
			setTimeout(fn, 0);
		}
	}

	/**
	 * @param {{ skipSuggest?: boolean }} [opts]
	 */
	function scheduleQueryImmediate(opts) {
		const skipSuggest = !!(opts && opts.skipSuggest);
		clearTimeout(flushTimer);
		vscode.postMessage({ type: 'retrieverQuery', payload: queryPayload(0) });
		persistUiSoon();
		if (!skipSuggest) scheduleSuggest();
	}

	/** Increments each suggest request — stale completions are discarded. */
	let suggestTrip = 0;
	let sugTimer = null;

	function pruneStalePersistedFilters() {
		const okTypes = new Set(
			metadataTypes
				.map(x => String(x && x.id != null ? x.id : '')
					.trim()
					.toLowerCase())
				.filter(Boolean)
		);
		for (const id of [...selectedTypes]) {
			if (!okTypes.has(id)) selectedTypes.delete(id);
		}
		for (const t of [...selectedTags]) {
			if (!allTags.includes(t)) selectedTags.delete(t);
		}
	}

	/**
	 * After a full heading index reload, re-apply saved scope toggles from workspace if present (v4).
	 * @param {unknown} raw
	 */
	function restorePersistedScopeCheckboxes(raw) {
		if (!raw || typeof raw !== 'object') return;
		const p = /** @type {Record<string, unknown>} */ (raw);
		if (typeof p.v !== 'number' || p.v < 4) return;
		const sf = /** @type {HTMLInputElement | null} */ ($('rz-scope-files'));
		const sh = /** @type {HTMLInputElement | null} */ ($('rz-scope-headings'));
		if (!sf || !sh) return;
		if (typeof p.scopeFiles === 'boolean') sf.checked = p.scopeFiles;
		if (typeof p.scopeHeadings === 'boolean') sh.checked = p.scopeHeadings;
	}

	function hideSuggestPanel() {
		const p = $('rz-suggest-panel');
		const inp = $('rz-heading-search');
		if (p) {
			p.classList.add('hidden');
			p.innerHTML = '';
		}
		if (inp) inp.setAttribute('aria-expanded', 'false');
	}

	function scheduleSuggest() {
		clearTimeout(sugTimer);
		sugTimer = setTimeout(() => {
			const inp = $('rz-heading-search');
			if (kbMissing) {
				hideSuggestPanel();
				return;
			}
			const trip = ++suggestTrip;
			const { scopeFiles, scopeHeadings } = readScopeFromUi();
			vscode.postMessage({
				type: 'retrieverSuggest',
				payload: {
					q: (inp && inp.value) || '',
					selectedTypeIds: [...selectedTypes],
					selectedTags: [...selectedTags],
					selectedScopeIds: [],
					scopeFiles,
					scopeHeadings,
					_seq: trip,
					limit: 26
				}
			});
		}, 105);
	}

	function renderTypeChips() {
		const host = $('rz-type-chips');
		if (!host) return;
		host.innerHTML = '';
		const hintEl = $('rz-types-empty-hint');
		const hasTypes = !!(metadataTypes && metadataTypes.length);
		if (hintEl) hintEl.classList.toggle('hidden', hasTypes);
		for (const t of metadataTypes) {
			const id = String(t && t.id != null ? t.id : '')
				.trim()
				.toLowerCase();
			if (!id) continue;
			const on = selectedTypes.has(id);
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'rz-meta-type-chip' + (on ? ' rz-meta-type--selected' : '');
			b.dataset.typeId = id;
			b.setAttribute('aria-pressed', on ? 'true' : 'false');
			const face = metaTypeChipFaceText(t, id);
			const longName = [String(t.label || '').trim(), (t.marker || '').trim()].filter(Boolean).join(' — ') || face;
			b.setAttribute('aria-label', `${longName}${on ? ', selected' : ', not selected'}`);
			b.textContent = face;
			if (on) b.dataset.selected = 'true';
			else delete b.dataset.selected;
			b.title =
				`${longName}. Click to filter headings to this marker; click again to clear. Multiple types = show if heading matches any (OR).`;
			host.appendChild(b);
		}
	}

	function renderSelectedTagChips() {
		const host = $('rz-tag-chips');
		if (!host) return;
		host.innerHTML = '';
		for (const tag of [...selectedTags].sort()) {
			const span = document.createElement('span');
			span.className = 'rz-chip rz-chip-tag';
			span.dataset.tag = tag;
			const x = document.createElement('button');
			x.type = 'button';
			x.className = 'rz-chip-remove';
			x.setAttribute('aria-label', 'Remove tag');
			x.textContent = '×';
			span.appendChild(document.createTextNode(tag));
			span.appendChild(x);
			host.appendChild(span);
		}
	}

	function populateTagDatalist() {
		const dl = $('rz-tag-list');
		if (!dl) return;
		const seen = new Set();
		const ordered = [];
		for (const tc of tagCounts || []) {
			const t = (tc && tc.tag) || '';
			if (!t || seen.has(t)) continue;
			seen.add(t);
			ordered.push(t);
		}
		for (const t of allTags) {
			if (!seen.has(t)) {
				seen.add(t);
				ordered.push(t);
			}
		}
		dl.innerHTML = '';
		for (const t of ordered) {
			const o = document.createElement('option');
			o.value = t;
			dl.appendChild(o);
		}
	}

	function esc(s) {
		return String(s || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	/** Stable `data-file-rel` encoding — avoids attribute/HTML-escape mismatches on paths with `&`, spaces, etc. */
	function relToFileGroupDataAttr(rel) {
		return encodeURIComponent(String(rel || ''));
	}

	function relFromFileGroupDataAttr(raw) {
		if (raw == null || raw === '') return '';
		try {
			return decodeURIComponent(String(raw));
		} catch {
			return String(raw);
		}
	}

	function formatRelPath(rel, line) {
		return `${rel}:${line}`;
	}

	function folderKeyFromRel(rel) {
		const s = String(rel || '').replace(/\\/g, '/');
		const i = s.lastIndexOf('/');
		return i <= 0 ? '.' : s.slice(0, i);
	}

	function formatGroupHeading(key, kind) {
		if (!key && kind === 'type') return '— Untyped';
		if (kind === 'folder') return key === '.' ? '(root)' : key;
		return key || '— Untyped';
	}

	function tagsRowHtml(row) {
		if (!showRowTags || !row.tags || !row.tags.length) return '';
		const shown = row.tags.slice(0, 12);
		const more = row.tags.length > shown.length ? ` +${row.tags.length - shown.length}` : '';
		return (
			`<div class="rz-tags-row">` +
			shown.map(t => `<span class="rz-tag-pill">${esc(t)}</span>`).join('') +
			(more ? `<span class="rz-tag-more">${esc(more)}</span>` : '') +
			`</div>`
		);
	}

	function rowHtml(row) {
		const bc =
			showBreadcrumbs && row.breadcrumbs && row.breadcrumbs.length > 1
				? `<div class="rz-bc">${esc(row.breadcrumbs.slice(0, -1).join(' › '))}</div>`
				: '';
		const pathLine =
			showPathLine
				? `<div class="rz-meta">${esc(formatRelPath(row.relPath, row.line))}</div>`
				: '';
		let typeHtml = '';
		if (showTypeStrip) {
			const tid = (row.typeId || '').trim();
			const marker = (row.marker || '').trim();
			if (tid || marker) {
				typeHtml = `<span class="rz-type-pill">${esc(marker ? marker : '.' + tid)}</span>`;
			}
		}
		const invalid = row.validHeading === false;
		const titleClass = invalid ? 'rz-title is-invalid-heading' : 'rz-title';
		const tagsHtml = tagsRowHtml(row);
		const rp = esc(row.relPath || '');
		const fid = esc(row.fileId || '');
		return (
			`<button type="button" class="rz-row" role="option" tabindex="-1" data-uri="${esc(row.uri)}" data-line="${Number(row.line) || 1}" data-rel="${rp}" data-fileid="${fid}">` +
			`<span class="${titleClass}">${esc(row.title)}</span>` +
			typeHtml +
			tagsHtml +
			bc +
			pathLine +
			`</button>`
		);
	}

	function bindRowClicks(scope) {
		const root = scope || document;
		root.querySelectorAll('.rz-row, .rz-card').forEach(btn => {
			btn.addEventListener('click', () => {
				const uri = btn.getAttribute('data-uri');
				const line = Number(btn.getAttribute('data-line')) || 1;
				if (!uri) return;
				vscode.postMessage({ type: 'retrieverOpen', uri, line });
			});
		});
	}

	function focusRowsOrCards(items, idx) {
		items.forEach((r, i) => r.setAttribute('tabindex', i === idx ? '0' : '-1'));
		if (items[idx]) items[idx].focus();
	}

	/**
	 * One row per note file; click the file row to expand **all** matching headings in that file
	 * (rows are already search-matched on the host). When the search box is non-empty, this layout
	 * is used regardless of "Group by" so results stay file-centric. Without search, it matches
	 * legacy behavior: file groups only if Group by = None and both Files + Headings are on.
	 */
	function useFileHeadingGroupLayout() {
		if (viewMode !== 'list') return false;
		const q = retrieverTrimmedSearchQuery();
		// Non-empty search: always show one bucket per file so expand/collapse can list matches.
		if (q.length > 0) return true;
		const { scopeFiles, scopeHeadings } = readScopeFromUi();
		if (!scopeFiles) return false;
		if (groupBy !== 'none') return false;
		return !!(scopeFiles && scopeHeadings);
	}

	/** One row per note file (best-first order); used only for flat “Files only” when not using file groups. */
	function dedupeRowsOnePerFile(rows) {
		const seen = new Set();
		const out = [];
		for (const row of rows) {
			const k = String((row && row.relPath) || '');
			if (seen.has(k)) continue;
			seen.add(k);
			out.push(row);
		}
		return out;
	}

	/**
	 * @param {unknown[]} rows
	 */
	function buildFileHeadingGroupsHtml(rows) {
		const list = Array.isArray(rows) ? rows : [];
		if (!list.length) return '';
		/** @type {Map<string, unknown[]>} */
		const byRel = new Map();
		for (const row of list) {
			const rel = String((row && row.relPath) || '');
			if (!byRel.has(rel)) byRel.set(rel, []);
			byRel.get(rel).push(row);
		}
		const fileOrder = [];
		const seen = new Set();
		for (const row of list) {
			const rel = String((row && row.relPath) || '');
			if (!seen.has(rel)) {
				seen.add(rel);
				fileOrder.push(rel);
			}
		}
		const chevronSvg =
			'<svg class="rz-chevron-ic" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.5 3.5L11 8l-4.5 4.5V3.5z"/></svg>';
		const parts = [];
		for (const rel of fileOrder) {
			const groupRows = byRel.get(rel) || [];
			const baseName =
				rel && rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel || '(note)';
			const expanded = expandedFileGroupPaths.has(rel);
			const rowCount = groupRows.length;
			parts.push(`<section class="rz-file-group" role="group">`);
			parts.push(
				`<button type="button" class="rz-file-group-header" aria-expanded="${expanded ? 'true' : 'false'}" aria-label="${esc(
					expanded ? 'Collapse' : 'Expand'
				)} ${esc(baseName)}, ${rowCount} matching heading${rowCount === 1 ? '' : 's'}" data-file-rel="${relToFileGroupDataAttr(rel)}">` +
					`<span class="rz-file-group-chevron${expanded ? ' is-open' : ''}" aria-hidden="true">${chevronSvg}</span>` +
					`<span class="rz-file-group-title">${esc(baseName)}</span>` +
					`<span class="rz-file-group-meta">${esc(rel)} · ${rowCount} match${rowCount === 1 ? '' : 'es'}</span>` +
					`</button>`
			);
			parts.push(`<div class="rz-file-group-body" ${expanded ? '' : 'hidden'}>`);
			for (const row of groupRows) {
				parts.push(rowHtml(row));
			}
			parts.push(`</div></section>`);
		}
		return parts.join('');
	}

	function buildGroupedListParts(rows) {
		if (groupBy === 'none') {
			const { scopeFiles, scopeHeadings } = readScopeFromUi();
			if (scopeFiles && !scopeHeadings && !useFileHeadingGroupLayout()) {
				return dedupeRowsOnePerFile(rows).map(rowHtml);
			}
			return rows.map(rowHtml);
		}
		let prevKey = '__rz_none__';
		const parts = [];
		for (const row of rows) {
			let curKey;
			let labelKind = 'folder';
			if (groupBy === 'folder') {
				curKey = folderKeyFromRel(row.relPath);
				labelKind = 'folder';
			} else {
				curKey = (row.typeId || '').trim().toLowerCase() || '__untyped__';
				labelKind = 'type';
			}
			if (curKey !== prevKey) {
				prevKey = curKey;
				const displayKey =
					groupBy === 'type' && curKey === '__untyped__' ? '' : curKey;
				const label = formatGroupHeading(displayKey, labelKind);
				parts.push(`<div class="rz-group-hdr" role="presentation">${esc(label)}</div>`);
			}
			parts.push(rowHtml(row));
		}
		return parts;
	}

	function cardParts(r) {
		const tagsHtml = showRowTags && r.tags && r.tags.length
			? `<div class="rz-card-tags">${r.tags.slice(0, 6).map(t => `<span class="rz-tag-pill">${esc(t)}</span>`).join('')}</div>`
			: '';
		const rp = esc(r.relPath || '');
		const fid = esc(r.fileId || '');
		return (
			`<button type="button" class="rz-card" tabindex="-1" data-uri="${esc(r.uri)}" data-line="${Number(r.line) || 1}" data-rel="${rp}" data-fileid="${fid}">` +
			`<span class="rz-card-title">${esc(r.title)}</span>` +
			`<span class="rz-card-path">${esc(formatRelPath(r.relPath, r.line))}</span>` +
			tagsHtml +
			`</button>`
		);
	}

	function buildBoardInnerHtml(rows) {
		if (groupBy === 'none') {
			return '<div class="rz-board-grid">' + rows.map(r => cardParts(r)).join('') + '</div>';
		}
		/** @type {{ label: string, rows: typeof rows }[]} */
		const sections = [];
		let prev = '__rz_init__';
		for (const r of rows) {
			const curKey =
				groupBy === 'folder'
					? folderKeyFromRel(r.relPath)
					: (r.typeId || '').trim().toLowerCase() || '__untyped__';
			const label =
				groupBy === 'folder'
					? formatGroupHeading(folderKeyFromRel(r.relPath), 'folder')
					: formatGroupHeading((r.typeId || '').trim().toLowerCase(), 'type');
			if (curKey !== prev) {
				prev = curKey;
				sections.push({ label, rows: [r] });
			} else {
				sections[sections.length - 1].rows.push(r);
			}
		}
		return sections
			.map(
				s =>
					`<section class="rz-board-section"><h4 class="rz-group-hdr">${esc(s.label)}</h4>` +
					`<div class="rz-board-grid">` +
					s.rows.map(rr => cardParts(rr)).join('') +
					`</div></section>`
			)
			.join('');
	}

	function setupListRovingFocus(listEl) {
		const sel = useFileHeadingGroupLayout()
			? '.rz-file-group-header, .rz-row'
			: '.rz-row';
		const rows = [...listEl.querySelectorAll(sel)];
		rows.forEach((r, i) => r.setAttribute('tabindex', i === 0 ? '0' : '-1'));
	}

	let lastResultPayload = { rows: [], totalMatched: 0, truncated: false };

	function retrieverTrimmedSearchQuery() {
		return (
			String(($('rz-heading-search') && $('rz-heading-search').value) || '')
				.trim()
		);
	}

	function scopeDiffersFromDefault() {
		const { scopeFiles, scopeHeadings } = readScopeFromUi();
		return !scopeFiles || !scopeHeadings;
	}

	function filtersOrSearchActive() {
		return (
			selectedTypes.size > 0 ||
			selectedTags.size > 0 ||
			scopeDiffersFromDefault() ||
			retrieverTrimmedSearchQuery().length > 0
		);
	}

	function clearAllRetrieverFilters() {
		selectedTypes.clear();
		selectedTags.clear();
		expandedFileGroupPaths.clear();
		const inp = $('rz-heading-search');
		if (inp) inp.value = '';
		const sf = /** @type {HTMLInputElement | null} */ ($('rz-scope-files'));
		const sh = /** @type {HTMLInputElement | null} */ ($('rz-scope-headings'));
		if (sf) sf.checked = true;
		if (sh) sh.checked = true;
		renderTypeChips();
		renderSelectedTagChips();
		hideSuggestPanel();
		scheduleQueryImmediate();
		persistUiSoon();
	}

	function renderSuggestDropdown(payload) {
		const inp = $('rz-heading-search');
		const pnl = $('rz-suggest-panel');
		if (!inp || !pnl || kbMissing) return;
		if (
			payload &&
			typeof payload._seq === 'number' &&
			payload._seq !== suggestTrip
		) {
			return;
		}
		const items = payload && Array.isArray(payload.items) ? payload.items : [];
		if (!items.length) {
			hideSuggestPanel();
			return;
		}
		pnl.innerHTML = items
			.map(
				r =>
					`<button type="button" role="option" tabindex="0" class="rz-suggest-item" data-uri="${esc(
						r.uri
					)}" data-line="${Number(r.line) || 1}">` +
					`<span class="rz-suggest-title">${esc(r.title)}</span>` +
					`<span class="rz-suggest-meta">${esc(String(r.relPath || ''))}:${Number(r.line) || 1}</span>` +
					`</button>`
			)
			.join('');
		pnl.classList.remove('hidden');
		inp.setAttribute('aria-expanded', 'true');
	}

	function renderResults(payload) {
		lastResultPayload = payload || lastResultPayload;
		const empty = $('rz-empty');
		const listEl = $('rz-list');
		const boardEl = $('rz-board');
		const foot = $('rz-footer');
		const loadBtn = $('rz-load-more');
		if (!empty || !listEl || !boardEl) return;

		const rows = (lastResultPayload && lastResultPayload.rows) || [];
		const truncated = lastResultPayload && lastResultPayload.truncated;
		const totalMatched =
			typeof (lastResultPayload && lastResultPayload.totalMatched) === 'number'
				? lastResultPayload.totalMatched
				: rows.length;

		if (loadBtn) {
			loadBtn.classList.toggle('hidden', !(truncated && rows.length > 0));
		}

		const copyMdBtn = $('rz-copy-md');
		if (copyMdBtn) {
			copyMdBtn.disabled = !rows.length || kbMissing;
		}

		if (foot) {
			if (!rows.length) {
				if (catalogShellOnly && !kbMissing && !filtersOrSearchActive()) {
					foot.textContent =
						'KB is ready — headings are scanned only after you search or use type/tag filters (in-memory until you quit VS Code).';
				} else if (!kbMissing && headingsInCatalog > 0 && !filtersOrSearchActive()) {
					foot.textContent = `${headingsInCatalog} headings indexed — no matches loaded. Try Refresh if this persists.`;
				} else {
					foot.textContent = kbMissing
						? 'Choose a knowledge base folder first (DRIP Storage).'
						: 'No headings match this search / filters.';
				}
			} else if (truncated) {
				foot.textContent = useFileHeadingGroupLayout()
					? `Showing ${rows.length} of ${totalMatched} heading matches — expand each file to see all matches loaded so far. Load more for additional pages.`
					: `Showing ${rows.length} of ${totalMatched} matches.`;
			} else {
				foot.textContent = useFileHeadingGroupLayout()
					? `${totalMatched} heading matches — click a file row to expand or collapse matching headings.`
					: totalMatched === 1
						? '1 heading.'
						: `${totalMatched} headings.`;
			}
		}

		if (!rows.length) {
			listEl.innerHTML = '';
			boardEl.innerHTML = '';
			empty.hidden = false;
			listEl.hidden = true;
			boardEl.hidden = true;
			listEl.classList.remove('hidden');
			boardEl.classList.remove('hidden');
			const sub = empty.querySelector('p');
			if (sub) {
				if (kbMissing) {
					sub.textContent =
						'Open a folder in VS Code or use DRIP sidebar → Select Knowledge Base Folder, then Refresh.';
				} else if (catalogShellOnly && !filtersOrSearchActive()) {
					sub.textContent =
						'Type in the search box (or pick metadata types / tags) to scan headings from your KB. Nothing is saved to disk; closing VS Code clears the Retriever cache.';
				} else if (headingsInCatalog === 0 && noteFilesVisited === 0) {
					sub.textContent =
						'No KB note files found under this root (extensions in drip.knowledgeBaseFileExtensions, .dripignore). Root: ' +
						(kbRootPath || '(unknown)') +
						'. Pin a folder with “Select Knowledge Base” or open the folder as your workspace, then Refresh.';
				} else if (headingsInCatalog === 0 && noteFilesVisited > 0) {
					sub.textContent =
						'Scanned ' +
						noteFilesVisited +
						' note file(s) but found 0 headings. Add # headings in the note body (after the top metadata block). Root: ' +
						(kbRootPath || '') +
						'.';
				} else if (filtersOrSearchActive()) {
					sub.textContent = `Nothing matched (${headingsInCatalog} headings indexed). Use Clear filters or change search / type / tag picks. Metadata type chips are below the search bar.`;
				} else {
					sub.textContent =
						'Indexed headings returned no rows. Click Refresh — if it keeps happening, report a DRIP bug.';
				}
			}
			return;
		}

		empty.hidden = true;
		listEl.hidden = viewMode !== 'list';
		boardEl.hidden = viewMode !== 'board';
		listEl.classList.remove('hidden');
		boardEl.classList.remove('hidden');

		if (viewMode === 'list') {
			listEl.innerHTML = useFileHeadingGroupLayout()
				? buildFileHeadingGroupsHtml(rows)
				: buildGroupedListParts(rows).join('');
			listEl.removeAttribute('hidden');
			bindRowClicks(listEl);
			setupListRovingFocus(listEl);
		} else {
			boardEl.innerHTML = buildBoardInnerHtml(rows);
			bindRowClicks(boardEl);
			const cards = [...boardEl.querySelectorAll('.rz-card')];
			cards.forEach((c, i) => c.setAttribute('tabindex', i === 0 ? '0' : '-1'));
		}
	}

	function setKbBanner() {
		const b = $('rz-kb-banner');
		if (!b) return;
		if (kbMissing) {
			b.textContent =
				'No knowledge base root available. Open a workspace folder or pick KB in the DRIP sidebar (Select Knowledge Base).';
			b.hidden = false;
			return;
		}
		if (usedWorkspaceFallback) {
			b.textContent =
				'No folder pinned in DRIP yet — indexing your first workspace folder. Use “Select Knowledge Base Folder” in the DRIP sidebar to choose a different root.';
			b.hidden = false;
			return;
		}
		b.hidden = true;
	}

	window.addEventListener('message', event => {
		try {
			const msg = event.data;
			if (!msg || typeof msg !== 'object') return;
			switch (msg.type) {
				case 'retrieverCatalogInit': {
					const p = msg.payload || {};
					metadataTypes = Array.isArray(p.metadataTypes) ? p.metadataTypes : [];
					allTags = Array.isArray(p.allTags) ? p.allTags : [];
					tagCounts = Array.isArray(p.tagCounts) ? p.tagCounts : [];
					kbMissing = Boolean(p.kbMissing);
					headingsInCatalog = Number(p.headingsIndexed);
					headingsInCatalog = Number.isFinite(headingsInCatalog) ? headingsInCatalog : 0;
					noteFilesVisited = Number(p.noteFilesVisited);
					noteFilesVisited = Number.isFinite(noteFilesVisited) ? noteFilesVisited : 0;
					kbRootPath = typeof p.kbRootPath === 'string' ? p.kbRootPath : '';
					usedWorkspaceFallback = Boolean(p.usedWorkspaceFallback);
					catalogShellOnly = Boolean(p.shellOnly);
					setKbBanner();
					accumulatedRows = [];
					populateTagDatalist();
					if (!retrieverPersistHydrated) {
						applyPersistedUi(p.persistedUi);
						retrieverPersistHydrated = true;
					} else if (!p.shellOnly) {
						restorePersistedScopeCheckboxes(p.persistedUi);
					}
					pruneStalePersistedFilters();
					renderTypeChips();
					renderSelectedTagChips();
					runAfterNextPaint(() => scheduleQueryImmediate({ skipSuggest: true }));
					break;
				}
				case 'retrieverSuggestResult':
					renderSuggestDropdown(msg.payload || {});
					break;
				case 'retrieverCatalogResult': {
					const p = msg.payload || {};
					const rowSlice = Array.isArray(p.rows) ? p.rows : [];
					const off = typeof p.offset === 'number' ? p.offset : 0;
					if (off === 0) {
						accumulatedRows = [...rowSlice];
						expandedFileGroupPaths.clear();
					} else {
						accumulatedRows = [...accumulatedRows, ...rowSlice];
					}
					renderResults({ ...p, rows: accumulatedRows });
					break;
				}
				case 'retrieverApplyQuery': {
					const q = msg.payload && typeof msg.payload.query === 'string' ? msg.payload.query : '';
					const inp = $('rz-heading-search');
					if (inp) inp.value = q;
					scheduleQueryImmediate();
					persistUiSoon();
					break;
				}
				default:
					break;
			}
		} catch (_) {
			// ignore malformed host messages
		}
	});

	// Events
	const search = $('rz-heading-search');
	const suggestPanel = $('rz-suggest-panel');
	if (suggestPanel) {
		suggestPanel.addEventListener('keydown', e => {
			const btn = e.target && e.target.closest && e.target.closest('.rz-suggest-item');
			const items = [...suggestPanel.querySelectorAll('.rz-suggest-item')];
			if (!btn || !items.length) return;
			const ix = items.indexOf(btn);
			if (e.key === 'ArrowUp' && ix <= 0) {
				e.preventDefault();
				hideSuggestPanel();
				if (search) search.focus();
				return;
			}
			if (e.key === 'ArrowUp' && ix > 0) {
				e.preventDefault();
				items[ix - 1].focus();
				return;
			}
			if (e.key === 'ArrowDown' && ix < items.length - 1) {
				e.preventDefault();
				items[ix + 1].focus();
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				hideSuggestPanel();
				if (search) search.focus();
			}
		});
		suggestPanel.addEventListener('mousedown', e => {
			const t = e.target && e.target.closest && e.target.closest('.rz-suggest-item');
			if (t) {
				e.preventDefault();
			}
		});
		suggestPanel.addEventListener('click', e => {
			const b = e.target && e.target.closest && e.target.closest('.rz-suggest-item');
			if (!b) return;
			const uri = b.getAttribute('data-uri');
			const line = Number(b.getAttribute('data-line')) || 1;
			hideSuggestPanel();
			if (uri) vscode.postMessage({ type: 'retrieverOpen', uri, line });
		});
	}
	if (search) {
		search.addEventListener('input', () => {
			scheduleQuery();
			scheduleSuggest();
		});
		search.addEventListener('focus', () => {
			scheduleSuggest();
		});
		search.addEventListener('blur', () => {
			setTimeout(() => hideSuggestPanel(), 200);
		});
		search.addEventListener('keydown', e => {
			if (e.key === 'Escape') {
				hideSuggestPanel();
				return;
			}
			if (e.key === 'Enter') {
				e.preventDefault();
				hideSuggestPanel();
				clearTimeout(flushTimer);
				clearTimeout(sugTimer);
				suggestTrip++;
				vscode.postMessage({ type: 'retrieverQuery', payload: queryPayload(0) });
				persistUiSoon();
				return;
			}
			if (e.key !== 'ArrowDown') return;
			const pnl = $('rz-suggest-panel');
			const firstSug =
				pnl && !pnl.classList.contains('hidden')
					? pnl.querySelector('.rz-suggest-item')
					: null;
			if (firstSug instanceof HTMLElement) {
				e.preventDefault();
				firstSug.focus();
				return;
			}
			const listEl = $('rz-list');
			if (!listEl || listEl.hidden) return;
			const rows = [...listEl.querySelectorAll('.rz-row')];
			if (!rows.length) return;
			e.preventDefault();
			focusRowsOrCards(rows, 0);
		});
	}

	const viewport = document.querySelector('.viewport');
	if (viewport && !viewportKeyNavBound) {
		viewportKeyNavBound = true;
		viewport.addEventListener('keydown', e => {
			const active = document.activeElement;
			if (!active) return;
			const listEl = $('rz-list');
			const boardEl = $('rz-board');
			if (viewMode === 'list' && listEl && !listEl.hidden) {
				const hdrFocus = active.closest && active.closest('.rz-file-group-header');
				if (hdrFocus && listEl.contains(hdrFocus)) {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						toggleFileGroupFromHeader(hdrFocus);
						return;
					}
				}
				const rows = [...listEl.querySelectorAll('.rz-row')];
				const rowEl = active.closest && active.closest('.rz-row');
				if (rowEl && rows.includes(rowEl)) {
					let ix = rows.indexOf(rowEl);
					if (e.key === 'ArrowDown') {
						if (ix < rows.length - 1) {
							e.preventDefault();
							focusRowsOrCards(rows, ix + 1);
						}
						return;
					}
					if (e.key === 'ArrowUp') {
						if (ix > 0) {
							e.preventDefault();
							focusRowsOrCards(rows, ix - 1);
							return;
						}
						e.preventDefault();
						if (search) search.focus();
						return;
					}
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						rowEl.click();
						return;
					}
				}
			}
			if (viewMode === 'board' && boardEl && !boardEl.hidden) {
				const cards = [...boardEl.querySelectorAll('.rz-card')];
				const cardEl = active.closest && active.closest('.rz-card');
				if (cardEl && cards.includes(cardEl)) {
					let ix = cards.indexOf(cardEl);
					if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
						if (ix < cards.length - 1) {
							e.preventDefault();
							focusRowsOrCards(cards, ix + 1);
						}
						return;
					}
					if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
						if (ix > 0) {
							e.preventDefault();
							focusRowsOrCards(cards, ix - 1);
							return;
						}
						e.preventDefault();
						if (search) search.focus();
						return;
					}
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						cardEl.click();
					}
				}
			}
		});
	}

	const clr = $('rz-clear-filters');
	if (clr) {
		clr.addEventListener('click', clearAllRetrieverFilters);
	}

	const refresh = $('rz-refresh');
	if (refresh) {
		refresh.addEventListener('click', () => {
			vscode.postMessage({ type: 'retrieverRebuild' });
		});
	}

	function flattenForMdLine(text) {
		return String(text || '').replace(/\s+/g, ' ').trim();
	}

	function copyVisibleMarkdown() {
		if (!accumulatedRows.length) {
			vscode.postMessage({ type: 'retrieverClipboardEmpty' });
			return;
		}
		const qRaw =
			($('rz-heading-search') && $('rz-heading-search').value && $('rz-heading-search').value.trim()) || '';
		const qLabel = flattenForMdLine(qRaw) || '(empty)';
		const total =
			typeof lastResultPayload.totalMatched === 'number'
				? lastResultPayload.totalMatched
				: accumulatedRows.length;
		const truncated =
			lastResultPayload.truncated === true ? '\n_(More matches exist — click Load more in Retriever.)_' : '';
		const hdr =
			'# Retriever export\n\n' +
			`_Search: ${qLabel} · ${accumulatedRows.length} of ${total} match(es)_${truncated}\n\n`;
		const body = accumulatedRows
			.map(r => {
				const rel = String(r.relPath || '');
				const ln = Number(r.line) || 1;
				return `- ${flattenForMdLine(r.title)} — \`${rel}:${ln}\``;
			})
			.join('\n');
		vscode.postMessage({ type: 'retrieverClipboard', text: hdr + body });
	}

	const copyMd = $('rz-copy-md');
	if (copyMd) {
		copyMd.addEventListener('click', copyVisibleMarkdown);
	}

	const loadMoreBtn = $('rz-load-more');
	if (loadMoreBtn) {
		loadMoreBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'retrieverQuery', payload: queryPayload(accumulatedRows.length) });
			persistUiSoon();
		});
	}

	/** @type {{ uri: string, line: string, rel: string } | null} */
	let ctxPinned = null;
	const ctxMenu = $('rz-ctx-menu');
	function hideCtx() {
		if (!ctxMenu) return;
		ctxMenu.hidden = true;
		ctxMenu.setAttribute('aria-hidden', 'true');
		ctxPinned = null;
	}
	const rzViewportEl = document.querySelector('.viewport');
	if (rzViewportEl && ctxMenu) {
		rzViewportEl.addEventListener('contextmenu', e => {
			const row = e.target.closest && e.target.closest('.rz-row, .rz-card');
			if (!row) return;
			if (!(row.closest && row.closest('#rz-list')) && !(row.closest && row.closest('#rz-board'))) {
				return;
			}
			e.preventDefault();
			ctxPinned = {
				uri: row.getAttribute('data-uri') || '',
				line: row.getAttribute('data-line') || '1',
				rel: row.getAttribute('data-rel') || ''
			};
			ctxMenu.hidden = false;
			ctxMenu.setAttribute('aria-hidden', 'false');
			const pad = 8;
			ctxMenu.style.position = 'fixed';
			ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - 200 - pad) + 'px';
			ctxMenu.style.top = Math.min(e.clientY, window.innerHeight - 180 - pad) + 'px';
		});

		ctxMenu.addEventListener('click', evt => {
			const b = evt.target.closest && evt.target.closest('[data-act]');
			if (!b || !ctxPinned || !ctxPinned.uri) {
				hideCtx();
				return;
			}
			evt.preventDefault();
			const act = b.getAttribute('data-act');
			const lineNum = Number(ctxPinned.line) || 1;
			if (act === 'open') {
				vscode.postMessage({ type: 'retrieverOpen', uri: ctxPinned.uri, line: lineNum });
			} else if (act === 'reveal') {
				vscode.postMessage({ type: 'retrieverReveal', uri: ctxPinned.uri });
			} else if (act === 'copy-path') {
				vscode.postMessage({
					type: 'retrieverCopyPathLine',
					relPath: ctxPinned.rel,
					line: lineNum
				});
			} else if (act === 'copy-l') {
				vscode.postMessage({
					type: 'retrieverCopyLLink',
					uri: ctxPinned.uri,
					fileId: ctxPinned.fileId || ''
				});
			}
			hideCtx();
		});
	}

	document.addEventListener(
		'mousedown',
		e => {
			if (!ctxMenu || ctxMenu.hidden) return;
			if (!ctxMenu.contains(e.target)) hideCtx();
		},
		true
	);

	(function wireScopeCheckboxes() {
		const f = /** @type {HTMLInputElement | null} */ ($('rz-scope-files'));
		const h = /** @type {HTMLInputElement | null} */ ($('rz-scope-headings'));
		if (!f || !h) return;
		const onChange = () => {
			if (!f.checked && !h.checked) {
				f.checked = true;
			}
			expandedFileGroupPaths.clear();
			persistUiSoon();
			scheduleQueryImmediate();
		};
		f.addEventListener('change', onChange);
		h.addEventListener('change', onChange);
	})();

	/** Expand/collapse file bucket (must not depend on `list.hidden` — Electron/webview can disagree with hit-testing). */
	function toggleFileGroupFromHeader(/** @type {Element} */ hdr) {
		const rel = relFromFileGroupDataAttr(hdr.getAttribute('data-file-rel'));
		if (!rel) return;
		if (expandedFileGroupPaths.has(rel)) expandedFileGroupPaths.delete(rel);
		else expandedFileGroupPaths.add(rel);
		renderResults(lastResultPayload);
	}

	const rzListFileToggle = $('rz-list');
	if (rzListFileToggle && rzListFileToggle.dataset.rzFileGroupDelegation !== '1') {
		rzListFileToggle.dataset.rzFileGroupDelegation = '1';
		rzListFileToggle.addEventListener('click', e => {
			const el = elementFromPointerEvent(e);
			const hdr = el && el.closest ? el.closest('.rz-file-group-header') : null;
			if (!hdr || !rzListFileToggle.contains(hdr)) return;
			e.preventDefault();
			e.stopPropagation();
			toggleFileGroupFromHeader(hdr);
		});
	}

	const typeHost = $('rz-type-chips');
	if (typeHost) {
		typeHost.addEventListener('click', e => {
			const el = elementFromPointerEvent(e);
			const btn = el && el.closest ? el.closest('.rz-meta-type-chip') : null;
			if (!btn || !btn.dataset.typeId) return;
			e.preventDefault();
			const id = String(btn.dataset.typeId || '')
				.trim()
				.toLowerCase();
			if (!id) return;
			if (selectedTypes.has(id)) selectedTypes.delete(id);
			else selectedTypes.add(id);
			renderTypeChips();
			scheduleQueryImmediate();
		});
	}

	const tagInput = $('rz-tag-input');
	if (tagInput) {
		tagInput.addEventListener('keydown', e => {
			if (e.key !== 'Enter') return;
			e.preventDefault();
			const raw = String(tagInput.value || '').trim().toLowerCase();
			if (!raw) return;
			if (!allTags.includes(raw)) return;
			selectedTags.add(raw);
			tagInput.value = '';
			renderSelectedTagChips();
			scheduleQueryImmediate();
		});
	}

	const tagChipsHost = $('rz-tag-chips');
	if (tagChipsHost) {
		tagChipsHost.addEventListener('click', e => {
			const rm = e.target && e.target.closest && e.target.closest('.rz-chip-remove');
			const wrap = rm && rm.closest('.rz-chip-tag');
			const tag = wrap && wrap.dataset && wrap.dataset.tag;
			if (!tag) return;
			selectedTags.delete(tag);
			renderSelectedTagChips();
			scheduleQueryImmediate();
		});
	}

	function wireSelect(id, field, needsServerRoundTrip) {
		const el = $(id);
		if (!el) return;
		el.addEventListener('change', () => {
			const v = el.value;
			if (field === 'view') viewMode = v;
			else if (field === 'group') groupBy = v;
			else if (field === 'sort') sortBy = v;
			if (needsServerRoundTrip) scheduleQueryImmediate();
			else {
				renderResults(lastResultPayload);
				scheduleSuggest();
			}
			persistUiSoon();
		});
	}

	wireSelect('rz-view-mode', 'view', false);
	wireSelect('rz-group-by', 'group', true);
	wireSelect('rz-sort-by', 'sort', true);

	['rz-show-bc', 'rz-show-path', 'rz-show-type', 'rz-show-tags'].forEach(id => {
		const el = $(id);
		if (!el) return;
		el.addEventListener('change', () => {
			showBreadcrumbs = !!( $('rz-show-bc') && $('rz-show-bc').checked );
			showPathLine = !!( $('rz-show-path') && $('rz-show-path').checked );
			showTypeStrip = !!( $('rz-show-type') && $('rz-show-type').checked );
			showRowTags = !!( $('rz-show-tags') && $('rz-show-tags').checked );
			renderResults(lastResultPayload);
			persistUiSoon();
			scheduleSuggest();
		});
	});

	vscode.postMessage({ type: 'retrieverPanelReady' });
})();
