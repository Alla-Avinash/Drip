(function () {
	'use strict';
	const vscode = acquireVsCodeApi();

	/** @type {{ id: string, label: string, marker: string, color?: string, attributes?: { key: string, kind: string, values: string[] }[] }[]} */
	let metadataTypes = [];
	/** Live colors from Settings (same sources as editor decorations). */
	let metaUiColors = {
		useCustom: false,
		keyColor: '',
		valueColor: '',
		tagsColor: '',
		/** @type {Record<string, string>} */
		typeColors: {},
		/** @type {Record<string, string>} */
		markerColors: {}
	};
	/**
	 * Per-type attribute filters: typeId → key → filter state.
	 * @type {Record<string, Record<string, {
	 *   kind: string,
	 *   values?: string[],
	 *   mode?: string,
	 *   customFrom?: string,
	 *   customTo?: string,
	 *   amount?: string,
	 *   amountTo?: string,
	 *   unit?: string
	 * }>>}
	 */
	let attrFilters = {};
	const ATTR_DURATION_UNITS = ['minute', 'hour', 'day', 'week', 'month', 'year'];
	const ATTR_DT_MODES = [
		{ id: 'any', label: 'Any' },
		{ id: 'today', label: 'Today' },
		{ id: 'before_today', label: 'Before today' },
		{ id: 'after_today', label: 'After today' },
		{ id: 'before', label: 'Before…' },
		{ id: 'after', label: 'After…' },
		{ id: 'between', label: 'Between…' }
	];
	const ATTR_DUR_MODES = [
		{ id: 'any', label: 'Any' },
		{ id: 'eq', label: 'Equals' },
		{ id: 'lt', label: 'Less than' },
		{ id: 'gt', label: 'Greater than' },
		{ id: 'between', label: 'Between' }
	];
	/** @type {string[]} */
	let allTags = [];
	/** @type {{ tag: string, count: number }[]} */
	let tagCounts = [];
	/** @type {{ id: string, label: string, count?: number }[]} */
	let relationTypes = [];
	/** @type {{ id: string, name: string }[]} */
	let tagGraphs = [];
	let selectedTagGraphId = '';
	let tagSuggestTrip = 0;
	let tagSugTimer = null;
	let relTagSuggestTrip = 0;
	let relTagSugTimer = null;
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
	/** @type {Map<string, Set<string>>} relation type → selected tags (multi-relation) */
	const selectedRelations = new Map();
	/** Currently editing relation type in the dropdown (does not clear other types). */
	let selectedRelationType = '';

	/** @returns {{ type: string, tags: string[] }[]} */
	function getSelectedRelationFilters() {
		/** @type {{ type: string, tags: string[] }[]} */
		const out = [];
		for (const [type, tags] of selectedRelations) {
			if (!type || !tags || !tags.size) continue;
			out.push({ type, tags: [...tags].sort() });
		}
		out.sort((a, b) => a.type.localeCompare(b.type));
		return out;
	}

	function relationFiltersActive() {
		for (const tags of selectedRelations.values()) {
			if (tags && tags.size) return true;
		}
		return false;
	}

	function totalSelectedRelationTagCount() {
		let n = 0;
		for (const tags of selectedRelations.values()) n += tags ? tags.size : 0;
		return n;
	}

	function ensureRelationTagSet(type) {
		const t = String(type || '')
			.trim()
			.toLowerCase();
		if (!t) return null;
		if (!selectedRelations.has(t)) selectedRelations.set(t, new Set());
		return selectedRelations.get(t);
	}

	/** Session-only custom paths (not persisted). */
	/** @type {{ path: string, kind: 'file'|'folder', name: string }[]} */
	let customCorpusPaths = [];
	/** @type {{ path: string, kind: 'file'|'folder', name: string }[] | null} */
	let customCorpusDraft = null;
	let customCorpusEditorOpen = false;
	/** Corpus select value before opening the custom-path editor (`working` | `entire` | `custom`). */
	let corpusBeforeCustomEdit = 'working';
	/** Last committed corpus select value (for Cancel restore). */
	let lastCorpusValue = 'working';

	/** @returns {{ scopeFiles: boolean, scopeHeadings: boolean, corpus: 'working'|'entire'|'custom', scope: 'files'|'headings', customCorpusPaths: { path: string, kind: 'file'|'folder', name: string }[] }} */
	function readScopeFromUi() {
		const filesRadio = /** @type {HTMLInputElement | null} */ ($('rz-scope-files'));
		const c = /** @type {HTMLSelectElement | null} */ ($('rz-corpus'));
		const isFiles = !!(filesRadio && filesRadio.checked);
		let corpus = /** @type {'working'|'entire'|'custom'} */ ('working');
		if (c) {
			const v = String(c.value || '');
			if (v === 'entire') corpus = 'entire';
			else if (v === 'custom') corpus = 'custom';
		}
		return {
			scope: isFiles ? 'files' : 'headings',
			scopeFiles: isFiles,
			scopeHeadings: !isFiles,
			corpus,
			customCorpusPaths: corpus === 'custom' ? getActiveCustomCorpusEntries() : []
		};
	}

	function getActiveCustomCorpusEntries() {
		if (customCorpusEditorOpen && Array.isArray(customCorpusDraft)) {
			return customCorpusDraft.slice();
		}
		return customCorpusPaths.slice();
	}

	function syncCustomCorpusEditBtn() {
		const editBtn = $('rz-corpus-edit');
		const sel = /** @type {HTMLSelectElement | null} */ ($('rz-corpus'));
		if (!editBtn || !sel) return;
		editBtn.classList.toggle(
			'hidden',
			String(sel.value || '') !== 'custom' || !customCorpusPaths.length
		);
	}

	function renderCustomCorpusEntries() {
		const list = $('rz-custom-entries');
		const empty = $('rz-custom-empty');
		if (!list) return;
		const entries = Array.isArray(customCorpusDraft) ? customCorpusDraft : [];
		list.innerHTML = entries
			.map(
				(e, i) =>
					`<li class="rz-custom-entry" data-idx="${i}">` +
					`<span class="rz-custom-entry-kind">${esc(e.kind === 'folder' ? 'folder' : 'file')}</span>` +
					`<span class="rz-custom-entry-body">` +
					`<div class="rz-custom-entry-name">${esc(e.name || e.path)}</div>` +
					`<div class="rz-custom-entry-path">${esc(e.path)}</div>` +
					`</span>` +
					`<button type="button" class="rz-custom-entry-remove" data-idx="${i}" aria-label="Remove">×</button>` +
					`</li>`
			)
			.join('');
		if (empty) {
			empty.textContent = 'No paths yet — drop or add at least one file or folder.';
			empty.classList.toggle('hidden', entries.length > 0);
		}
	}

	function setCustomCorpusEditorOpen(open) {
		customCorpusEditorOpen = !!open;
		const panel = $('rz-custom-corpus');
		const scopeStrip = document.querySelector('.rz-scope-strip');
		const filterBar = document.querySelector('.filter-bar');
		const viewport = document.querySelector('.viewport');
		const footer = document.querySelector('.rz-footer-wrap');
		const toolbar = document.querySelector('.toolbar');
		if (panel) {
			panel.hidden = !open;
			panel.classList.toggle('hidden', !open);
		}
		if (scopeStrip) scopeStrip.classList.toggle('hidden', open);
		if (filterBar) filterBar.classList.toggle('hidden', open);
		if (viewport) viewport.classList.toggle('hidden', open);
		if (footer) footer.classList.toggle('hidden', open);
		if (toolbar) toolbar.classList.toggle('hidden', open);
	}

	function openCustomCorpusEditor(fromCorpus) {
		const from = String(fromCorpus || lastCorpusValue || 'working');
		corpusBeforeCustomEdit =
			from === 'custom' && customCorpusPaths.length
				? 'custom'
				: from === 'entire'
					? 'entire'
					: 'working';
		customCorpusDraft = customCorpusPaths.map(e => ({ ...e }));
		renderCustomCorpusEntries();
		setCustomCorpusEditorOpen(true);
	}

	function mergePickedCustomEntries(entries) {
		if (!Array.isArray(customCorpusDraft)) customCorpusDraft = [];
		const seen = new Set(customCorpusDraft.map(e => String(e.path || '').toLowerCase()));
		for (const e of entries || []) {
			const p = String((e && e.path) || '')
				.replace(/\\/g, '/')
				.replace(/\/+$/, '')
				.trim();
			if (!p || seen.has(p.toLowerCase())) continue;
			seen.add(p.toLowerCase());
			customCorpusDraft.push({
				path: p,
				kind: e.kind === 'folder' ? 'folder' : 'file',
				name:
					String((e && e.name) || '').trim() ||
					(p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p)
			});
		}
		renderCustomCorpusEntries();
	}

	function finishCustomCorpusDone() {
		const entries = Array.isArray(customCorpusDraft) ? customCorpusDraft : [];
		if (!entries.length) {
			const empty = $('rz-custom-empty');
			if (empty) {
				empty.textContent = 'Add at least one file or folder before Done.';
				empty.classList.remove('hidden');
			}
			return;
		}
		customCorpusPaths = entries.map(e => ({ ...e }));
		customCorpusDraft = null;
		setCustomCorpusEditorOpen(false);
		const sel = /** @type {HTMLSelectElement | null} */ ($('rz-corpus'));
		if (sel) sel.value = 'custom';
		lastCorpusValue = 'custom';
		syncCustomCorpusEditBtn();
		persistUiSoon();
		scheduleQueryImmediate({ skipSuggest: true });
	}

	function cancelCustomCorpusEditor() {
		customCorpusDraft = null;
		setCustomCorpusEditorOpen(false);
		const sel = /** @type {HTMLSelectElement | null} */ ($('rz-corpus'));
		if (sel) {
			if (customCorpusPaths.length) {
				sel.value = 'custom';
				lastCorpusValue = 'custom';
			} else if (corpusBeforeCustomEdit === 'entire') {
				sel.value = 'entire';
				lastCorpusValue = 'entire';
			} else {
				sel.value = 'working';
				lastCorpusValue = 'working';
			}
		}
		syncCustomCorpusEditBtn();
		persistUiSoon();
		if (customCorpusPaths.length) scheduleQueryImmediate({ skipSuggest: true });
	}

	function clearCustomCorpusSession() {
		customCorpusPaths = [];
		customCorpusDraft = null;
		setCustomCorpusEditorOpen(false);
		syncCustomCorpusEditBtn();
	}

	function syncGroupByForScope() {
		const { scope } = readScopeFromUi();
		const groupSel = /** @type {HTMLSelectElement | null} */ ($('rz-group-by'));
		const hint = $('rz-group-files-hint');
		if (scope === 'files') {
			if (groupSel) {
				groupSel.value = 'none';
				groupSel.disabled = true;
			}
			groupBy = 'none';
			if (hint) hint.classList.remove('hidden');
		} else {
			if (groupSel) groupSel.disabled = false;
			if (hint) hint.classList.add('hidden');
		}
	}

	let viewMode = 'list';
	let groupBy = 'none';
	/** @type {'recommended'|'semantic'|'word'} */
	let searchEngine = 'recommended';
	/** Tags/relations always soft-rank by overlap (Exact/Relevant UI removed). */
	const tagMode = 'relevant';
	const relationMode = 'relevant';
	let showBreadcrumbs = true;
	let showPathLine = true;
	let showTypeStrip = true;
	let showRowTags = true;
	let showRowRelations = true;

	const $ = id => document.getElementById(id);
	/** First page size; subsequent “Load more” uses LOAD_MORE_SIZE. */
	const QUERY_PAGE_SIZE = 100;
	const LOAD_MORE_SIZE = 100;
	/** @type {Set<string>} expanded note `relPath` keys for file-group accordion */
	const expandedFileGroupPaths = new Set();
	/** Paths already seen in the current Files-scope result session (so Load more can expand only new files). */
	const fileGroupKnownPaths = new Set();
	/** Invalidates auto-expand when scope/query/view changes. */
	let fileGroupExpandSessionKey = '';
	/** @type {Set<string>} expanded group keys for folder/file/type grouping */
	const expandedGroupKeys = new Set();
	const NONE_TYPE_ID = '__none__';

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
	/** Guard so viewport keydown is bound once. */
	let viewportKeyNavBound = false;

	let persistTimer = null;
	function getPersistPayload() {
		const { scopeFiles, scopeHeadings, corpus, scope } = readScopeFromUi();
		return {
			v: 11,
			q: ($('rz-heading-search') && $('rz-heading-search').value) || '',
			selectedTypeIds: [...selectedTypes],
			selectedTags: [...selectedTags],
			tagMode,
			relationType: selectedRelationType,
			selectedRelationTags: selectedRelationType
				? [...(selectedRelations.get(selectedRelationType) || [])]
				: [],
			selectedRelations: getSelectedRelationFilters(),
			relationMode,
			scope,
			scopeFiles,
			scopeHeadings,
			// Custom paths are session-only — never persist; store working/entire only.
			corpus: corpus === 'custom' ? 'working' : corpus,
			viewMode,
			groupBy,
			searchEngine,
			sortBy: 'relevance',
			showBreadcrumbs: !!( $('rz-show-bc') && $('rz-show-bc').checked ),
			showPathLine: !!( $('rz-show-path') && $('rz-show-path').checked ),
			showTypeStrip: !!( $('rz-show-type') && $('rz-show-type').checked ),
			showRowTags: !!( $('rz-show-tags') && $('rz-show-tags').checked ),
			showRowRelations: !!( $('rz-show-relations') && $('rz-show-relations').checked ),
			attrFilters: JSON.parse(JSON.stringify(attrFilters))
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
		selectedRelationType = String(p.relationType || '')
			.trim()
			.toLowerCase();
		if (selectedRelationType === 'tags') selectedRelationType = '';
		selectedRelations.clear();
		if (Array.isArray(p.selectedRelations)) {
			for (const raw of p.selectedRelations) {
				if (!raw || typeof raw !== 'object') continue;
				const rec = /** @type {Record<string, unknown>} */ (raw);
				const type = String(rec.type || '')
					.trim()
					.toLowerCase();
				if (!type || type === 'tags') continue;
				const set = ensureRelationTagSet(type);
				if (!set) continue;
				for (const x of Array.isArray(rec.tags) ? rec.tags : []) {
					const id = String(x != null ? x : '')
						.trim()
						.toLowerCase();
					if (id) set.add(id);
				}
				if (!set.size) selectedRelations.delete(type);
			}
		} else if (Array.isArray(p.selectedRelationTags) && selectedRelationType) {
			const set = ensureRelationTagSet(selectedRelationType);
			if (set) {
				for (const x of p.selectedRelationTags) {
					const id = String(x != null ? x : '')
						.trim()
						.toLowerCase();
					if (id) set.add(id);
				}
			}
		}
		if (!selectedRelationType) {
			const first = getSelectedRelationFilters()[0];
			if (first) selectedRelationType = first.type;
		}
		// tagMode / relationMode fixed to relevant — ignore persisted exact toggles.
		attrFilters = {};
		if (p.attrFilters && typeof p.attrFilters === 'object') {
			try {
				attrFilters = JSON.parse(JSON.stringify(p.attrFilters));
			} catch {
				attrFilters = {};
			}
		}
		const sf = /** @type {HTMLInputElement | null} */ ($('rz-scope-files'));
		const sh = /** @type {HTMLInputElement | null} */ ($('rz-scope-headings'));
		if (sf && sh) {
			const v = typeof p.v === 'number' ? p.v : 0;
			const scopeRaw = String(p.scope || '').toLowerCase();
			if (scopeRaw === 'files' || (v >= 7 && p.scopeFiles === true && p.scopeHeadings === false)) {
				sf.checked = true;
				sh.checked = false;
			} else if (scopeRaw === 'headings' || v >= 7) {
				sf.checked = false;
				sh.checked = true;
			} else if (v >= 4 && typeof p.scopeFiles === 'boolean' && typeof p.scopeHeadings === 'boolean') {
				if (p.scopeFiles && !p.scopeHeadings) {
					sf.checked = true;
					sh.checked = false;
				} else {
					sf.checked = false;
				sh.checked = true;
			}
			} else {
				sf.checked = false;
				sh.checked = true;
			}
		}
		syncGroupByForScope();
		// Custom paths are session-only — never restore from persist; default Working set.
		clearCustomCorpusSession();
		const corpusSel = /** @type {HTMLSelectElement | null} */ ($('rz-corpus'));
		if (corpusSel) {
			corpusSel.value = p.corpus === 'entire' ? 'entire' : 'working';
			lastCorpusValue = corpusSel.value;
			syncCustomCorpusEditBtn();
		}
		viewMode = p.viewMode === 'board' ? 'board' : 'list';
		groupBy =
			p.groupBy === 'folder'
				? 'folder'
				: p.groupBy === 'file'
					? 'file'
					: p.groupBy === 'type'
						? 'type'
						: 'none';
		const engRaw = String(p.searchEngine || '').toLowerCase();
		if (engRaw === 'semantic' || engRaw === 'word') searchEngine = engRaw;
		else searchEngine = 'recommended';
		const sel = id => /** @type {HTMLSelectElement | null} */ ($(id));
		const vs = sel('rz-view-mode');
		if (vs) vs.value = viewMode;
		const gs = sel('rz-group-by');
		if (gs) gs.value = groupBy;
		const es = sel('rz-search-engine');
		if (es) es.value = searchEngine;
		function setCk(id, defVal, key) {
			const el = /** @type {HTMLInputElement | null} */ ($(id));
			if (!el) return;
			const v = p[key];
			el.checked = typeof v === 'boolean' ? v : defVal;
		}
		setCk('rz-show-bc', true, 'showBreadcrumbs');
		setCk('rz-show-path', true, 'showPathLine');
		setCk('rz-show-type', true, 'showTypeStrip');
		setCk('rz-show-tags', true, 'showRowTags');
		setCk('rz-show-relations', true, 'showRowRelations');
		showBreadcrumbs = !!( $('rz-show-bc') && $('rz-show-bc').checked );
		showPathLine = !!( $('rz-show-path') && $('rz-show-path').checked );
		showTypeStrip = !!( $('rz-show-type') && $('rz-show-type').checked );
		showRowTags = !!( $('rz-show-tags') && $('rz-show-tags').checked );
		showRowRelations = !!( $('rz-show-relations') && $('rz-show-relations').checked );
		syncRelationTypeSelect();
		renderSelectedRelationTagChips();
		syncRelationTagInputEnabled();
	}

	/**
	 * @param {number} offset
	 */
	function queryPayload(offset) {
		const { scopeFiles, scopeHeadings, corpus, scope, customCorpusPaths } = readScopeFromUi();
		const off = Number(offset) || 0;
		return {
			q: ($('rz-heading-search') && $('rz-heading-search').value) || '',
			selectedTypeIds: [...selectedTypes],
			selectedTags: [...selectedTags],
			tagMode,
			relationType: selectedRelationType,
			selectedRelationTags: selectedRelationType
				? [...(selectedRelations.get(selectedRelationType) || [])]
				: [],
			selectedRelations: getSelectedRelationFilters(),
			relationMode,
			selectedScopeIds: [],
			scope,
			scopeFiles,
			scopeHeadings,
			corpus,
			customCorpusPaths,
			respectDripignore: corpus === 'working',
			searchEngine,
			sortBy: 'relevance',
			groupBy: scope === 'files' ? 'none' : groupBy,
			viewMode,
			offset: off,
			limit: off === 0 ? QUERY_PAGE_SIZE : LOAD_MORE_SIZE
		};
	}

	let flushTimer = null;
	function scheduleQuery() {
		clearTimeout(flushTimer);
		flushTimer = setTimeout(() => {
			vscode.postMessage({ type: 'retrieverQuery', payload: queryPayload(0) });
			persistUiSoon();
			// Suggest only while the search box is focused — never steal focus on filter/sort.
			if (document.activeElement === $('rz-heading-search')) scheduleSuggest();
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
		// Filters / sort / group never open the suggest dropdown or steal focus.
		const allowSuggest = opts && opts.skipSuggest === false;
		clearTimeout(flushTimer);
		vscode.postMessage({ type: 'retrieverQuery', payload: queryPayload(0) });
		persistUiSoon();
		if (allowSuggest && document.activeElement === $('rz-heading-search')) scheduleSuggest();
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
			if (id === NONE_TYPE_ID) continue;
			if (!okTypes.has(id)) selectedTypes.delete(id);
		}
		// Do not drop typed-in tags that are absent from the current chip list —
		// soft-rank still queries the index for them.
		for (const t of [...selectedTags]) {
			if (!t) selectedTags.delete(t);
		}
		for (const typeId of Object.keys(attrFilters)) {
			if (!okTypes.has(typeId) || !selectedTypes.has(typeId)) {
				delete attrFilters[typeId];
				continue;
			}
			const t = metadataTypes.find(
				x =>
					String((x && x.id) || '')
						.trim()
						.toLowerCase() === typeId
			);
			const okKeys = new Set(
				(Array.isArray(t && t.attributes) ? t.attributes : [])
					.map(a => String((a && a.key) || '').toLowerCase())
					.filter(Boolean)
			);
			for (const key of Object.keys(attrFilters[typeId] || {})) {
				if (!okKeys.has(key)) delete attrFilters[typeId][key];
			}
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
		const scopeRaw = String(p.scope || '').toLowerCase();
		if (scopeRaw === 'files' || (p.v >= 7 && p.scopeFiles === true && p.scopeHeadings === false)) {
			sf.checked = true;
			sh.checked = false;
		} else if (p.v >= 7 || scopeRaw === 'headings') {
			sf.checked = false;
			sh.checked = true;
		} else if (p.scopeFiles === true && p.scopeHeadings === false) {
			sf.checked = true;
			sh.checked = false;
		} else {
			sf.checked = false;
			sh.checked = true;
		}
		syncGroupByForScope();
		const corpusSel = /** @type {HTMLSelectElement | null} */ ($('rz-corpus'));
		if (corpusSel && typeof p.v === 'number' && p.v >= 5) {
			// Never restore custom paths from disk — Working set is the durable default.
			if (customCorpusPaths.length) {
				corpusSel.value = 'custom';
			} else {
				corpusSel.value = p.corpus === 'entire' ? 'entire' : 'working';
			}
			lastCorpusValue = String(corpusSel.value || 'working');
			syncCustomCorpusEditBtn();
		}
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
			if (!inp || document.activeElement !== inp) {
				hideSuggestPanel();
				return;
			}
			if (kbMissing) {
				hideSuggestPanel();
				return;
			}
			const trip = ++suggestTrip;
			const { scopeFiles, scopeHeadings, corpus, scope, customCorpusPaths } = readScopeFromUi();
			vscode.postMessage({
				type: 'retrieverSuggest',
				payload: {
					q: inp.value || '',
					selectedTypeIds: [...selectedTypes],
					selectedTags: [...selectedTags],
					tagMode,
					relationType: selectedRelationType,
					selectedRelationTags: selectedRelationType
						? [...(selectedRelations.get(selectedRelationType) || [])]
						: [],
					selectedRelations: getSelectedRelationFilters(),
					relationMode,
					selectedScopeIds: [],
					scope,
					scopeFiles,
					scopeHeadings,
					corpus,
					customCorpusPaths,
					respectDripignore: corpus === 'working',
					searchEngine,
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

		function appendTypeChip(id, face, longName, on) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'rz-meta-type-chip' + (on ? ' rz-meta-type--selected' : '');
			b.dataset.typeId = id;
			b.setAttribute('aria-pressed', on ? 'true' : 'false');
			b.setAttribute('aria-label', `${longName}${on ? ', selected' : ', not selected'}`);
			b.textContent = face;
			if (on) b.dataset.selected = 'true';
			else delete b.dataset.selected;
			b.title = `${longName}. Click to filter (OR across types).`;
			host.appendChild(b);
		}

		appendTypeChip(
			NONE_TYPE_ID,
			'None',
			'None — headings with no metadata type',
			selectedTypes.has(NONE_TYPE_ID)
		);

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
			const count = Number(t && t.count);
			const longName = [String(t.label || '').trim(), (t.marker || '').trim()].filter(Boolean).join(' — ') || face;
			b.setAttribute('aria-label', `${longName}${on ? ', selected' : ', not selected'}`);
			b.textContent = Number.isFinite(count) && count > 0 ? `${face} (${count})` : face;
			if (on) b.dataset.selected = 'true';
			else delete b.dataset.selected;
			b.title =
				`${longName}${Number.isFinite(count) ? ` · ${count} headings in index` : ''}. Click to filter (OR across types).`;
			const chipColor = colorForMetadataType(id, t.marker);
			if (chipColor) applyElementAccentColor(b, chipColor);
			else applyThemeTypeAccent(b);
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
			if (metaUiColors.tagsColor) {
				applyElementAccentColor(span, metaUiColors.tagsColor);
			}
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

	function syncRelationTypeSelect() {
		const sel = /** @type {HTMLSelectElement | null} */ ($('rz-relation-type'));
		if (!sel) return;
		const keep = selectedRelationType;
		sel.innerHTML = '';
		const none = document.createElement('option');
		none.value = '';
		none.textContent = 'Choose type…';
		sel.appendChild(none);
		const known = new Set();
		for (const rt of relationTypes) {
			const id = String((rt && rt.id) || '')
				.trim()
				.toLowerCase();
			if (!id || id === 'tags') continue;
			known.add(id);
			const opt = document.createElement('option');
			opt.value = id;
			opt.textContent = id;
			sel.appendChild(opt);
		}
		// Drop filters whose relation type no longer exists in the catalog.
		for (const type of [...selectedRelations.keys()]) {
			if (!known.has(type)) selectedRelations.delete(type);
		}
		if (keep && [...sel.options].some(o => o.value === keep)) {
			sel.value = keep;
			selectedRelationType = keep;
		} else {
			sel.value = '';
			selectedRelationType = '';
		}
	}

	function syncRelationTagInputEnabled() {
		const inp = /** @type {HTMLInputElement | null} */ ($('rz-rel-tag-input'));
		if (inp) inp.disabled = !selectedRelationType;
	}

	function renderSelectedRelationTagChips() {
		const host = $('rz-rel-tag-chips');
		if (!host) return;
		host.innerHTML = '';
		const filters = getSelectedRelationFilters();
		for (const f of filters) {
			for (const tag of f.tags) {
				const span = document.createElement('span');
				span.className = 'rz-chip rz-chip-tag rz-chip-rel-tag';
				span.dataset.relType = f.type;
				span.dataset.tag = tag;
				if (metaUiColors.tagsColor) {
					applyElementAccentColor(span, metaUiColors.tagsColor);
				}
				const x = document.createElement('button');
				x.type = 'button';
				x.className = 'rz-chip-remove';
				x.setAttribute('aria-label', `Remove ${f.type}:${tag}`);
				x.textContent = '×';
				span.appendChild(document.createTextNode(`${f.type}:${tag}`));
				span.appendChild(x);
				host.appendChild(span);
			}
		}
	}

	/**
	 * Apply Settings metadata / type / tag colors (same sources as editor decorations).
	 * @param {{
	 *   useCustom?: boolean,
	 *   keyColor?: string,
	 *   valueColor?: string,
	 *   tagsColor?: string,
	 *   typeColors?: Record<string, string>,
	 *   markerColors?: Record<string, string>
	 * } | null | undefined} colors
	 */
	function applyMetadataUiColors(colors) {
		const root = document.documentElement;
		metaUiColors = {
			useCustom: Boolean(colors && colors.useCustom),
			keyColor: opaqueCssColor(String((colors && colors.keyColor) || '').trim()),
			valueColor: opaqueCssColor(String((colors && colors.valueColor) || '').trim()),
			tagsColor: opaqueCssColor(String((colors && colors.tagsColor) || '').trim()),
			typeColors: {},
			markerColors: {}
		};
		if (colors && colors.typeColors && typeof colors.typeColors === 'object') {
			for (const [k, v] of Object.entries(colors.typeColors)) {
				const key = String(k || '')
					.trim()
					.toLowerCase();
				const oc = opaqueCssColor(String(v || ''));
				if (key && oc) metaUiColors.typeColors[key] = oc;
			}
		}
		if (colors && colors.markerColors && typeof colors.markerColors === 'object') {
			for (const [k, v] of Object.entries(colors.markerColors)) {
				const key = String(k || '')
					.trim()
					.toLowerCase();
				const oc = opaqueCssColor(String(v || ''));
				if (key && oc) metaUiColors.markerColors[key] = oc;
			}
		}
		// Keep catalog type chips / pills in sync with Settings Type Color.
		for (const t of metadataTypes) {
			const id = String((t && t.id) || '')
				.trim()
				.toLowerCase();
			if (!id) continue;
			const fromMap = metaUiColors.typeColors[id] || '';
			if (fromMap) t.color = fromMap;
			else if (t.color) {
				const oc = opaqueCssColor(String(t.color));
				if (oc) metaUiColors.typeColors[id] = oc;
			}
		}
		const useCustom = metaUiColors.useCustom;
		const key = useCustom ? metaUiColors.keyColor : '';
		const val = useCustom ? metaUiColors.valueColor : '';
		const tags = metaUiColors.tagsColor;
		if (key) {
			root.style.setProperty('--rz-meta-key', key);
			root.style.setProperty('--rz-meta-key-bg', tintCssBackground(key, 0.16));
		} else {
			root.style.removeProperty('--rz-meta-key');
			root.style.removeProperty('--rz-meta-key-bg');
		}
		if (val) {
			root.style.setProperty('--rz-meta-value', val);
			root.style.setProperty('--rz-meta-value-bg', tintCssBackground(val, 0.12));
		} else {
			root.style.removeProperty('--rz-meta-value');
			root.style.removeProperty('--rz-meta-value-bg');
		}
		if (tags) {
			root.style.setProperty('--rz-tags-color', tags);
			root.style.setProperty('--rz-tags-bg', tintCssBackground(tags, 0.22));
		} else {
			root.style.removeProperty('--rz-tags-color');
			root.style.removeProperty('--rz-tags-bg');
		}
		syncEditorThemeFallbackColors();
	}

	/** @param {string} varName @param {string} [fallback] */
	function readVscodeThemeColor(varName, fallback) {
		const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
		return v || fallback || '';
	}

	/** Theme defaults when Settings type / metadata colors are blank (matches .d.txt semantic / TextMate). */
	function syncEditorThemeFallbackColors() {
		const root = document.documentElement;
		const typeFg =
			readVscodeThemeColor('--vscode-symbolIcon-classForeground', '') ||
			readVscodeThemeColor('--vscode-debugTokenExpression-type', '#4ec9b0');
		const keyFg =
			readVscodeThemeColor('--vscode-symbolIcon-keywordForeground', '') ||
			readVscodeThemeColor('--vscode-debugTokenExpression-name', '');
		const valFg =
			readVscodeThemeColor('--vscode-debugTokenExpression-string', '') ||
			readVscodeThemeColor('--vscode-symbolIcon-stringForeground', '');

		if (typeFg) {
			root.style.setProperty('--rz-type-theme-fg', typeFg);
			const typeBg = tintCssBackground(typeFg, 0.32);
			if (typeBg) root.style.setProperty('--rz-type-theme-bg', typeBg);
		}

		const useCustom = metaUiColors.useCustom;
		const hasKey = Boolean(metaUiColors.keyColor);
		const hasVal = Boolean(metaUiColors.valueColor);

		if ((!useCustom || !hasKey) && keyFg) {
			root.style.setProperty('--rz-meta-key', keyFg);
			const kb = tintCssBackground(keyFg, 0.18);
			if (kb) root.style.setProperty('--rz-meta-key-bg', kb);
		}
		if ((!useCustom || !hasVal) && valFg) {
			root.style.setProperty('--rz-meta-value', valFg);
			const vb = tintCssBackground(valFg, 0.12);
			if (vb) root.style.setProperty('--rz-meta-value-bg', vb);
		}
		if (!useCustom || (!hasKey && !hasVal)) {
			const kvBg = tintCssBackground(keyFg || typeFg, 0.14);
			if (kvBg) root.style.setProperty('--rz-meta-kv-bg', kvBg);
		} else {
			root.style.removeProperty('--rz-meta-kv-bg');
		}
	}

	/**
	 * @param {string} [typeId]
	 * @param {string} [marker]
	 * @returns {string}
	 */
	function colorForMetadataType(typeId, marker) {
		const id = String(typeId || '')
			.trim()
			.toLowerCase();
		const mk = String(marker || '')
			.trim()
			.toLowerCase();
		const bare = mk.replace(/^\./, '');
		const fromCatalog = metadataTypes.find(
			t =>
				String(t.id || '')
					.trim()
					.toLowerCase() === id ||
				String(t.marker || '')
					.trim()
					.toLowerCase()
					.replace(/^\./, '') === bare
		);
		if (fromCatalog && fromCatalog.color) {
			const oc = opaqueCssColor(expandHexColor(String(fromCatalog.color).trim()));
			if (oc) return oc;
		}
		if (id && metaUiColors.typeColors[id]) {
			return opaqueCssColor(expandHexColor(metaUiColors.typeColors[id]));
		}
		if (mk && metaUiColors.typeColors[mk]) return opaqueCssColor(metaUiColors.typeColors[mk]);
		if (bare && metaUiColors.typeColors[bare]) return opaqueCssColor(metaUiColors.typeColors[bare]);
		if (!mk && !bare) return '';
		if (metaUiColors.markerColors[mk]) return opaqueCssColor(metaUiColors.markerColors[mk]);
		if (metaUiColors.markerColors[bare]) return opaqueCssColor(metaUiColors.markerColors[bare]);
		if (metaUiColors.markerColors[`.${bare}`]) {
			return opaqueCssColor(metaUiColors.markerColors[`.${bare}`]);
		}
		return '';
	}

	/**
	 * Drop near-zero alpha so Settings colors stay readable on cards.
	 * @param {string} input
	 * @returns {string}
	 */
	function opaqueCssColor(input) {
		const c = String(input || '').trim();
		if (!c || /^transparent$/i.test(c)) return '';
		const hex8 = c.match(/^#([0-9a-f]{8})$/i);
		if (hex8) {
			const a = parseInt(hex8[1].slice(6, 8), 16);
			if (a < 40) return '';
			return `#${hex8[1].slice(0, 6)}`;
		}
		const hex4 = c.match(/^#([0-9a-f]{4})$/i);
		if (hex4) {
			const h = hex4[1];
			const a = parseInt(h[3] + h[3], 16);
			if (a < 40) return '';
			return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
		}
		const rgba = c.match(
			/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*[/,]\s*([\d.]+%?))?\s*\)$/i
		);
		if (rgba) {
			const aRaw = rgba[4];
			let a = 1;
			if (aRaw != null) {
				a = String(aRaw).endsWith('%') ? Number(aRaw) / 100 : Number(aRaw);
			}
			if (!(a >= 0.15)) return '';
			return `rgb(${Number(rgba[1])}, ${Number(rgba[2])}, ${Number(rgba[3])})`;
		}
		return c;
	}

	/**
	 * Soft fill behind colored text (opaque enough to read on transparent cards).
	 * @param {string} opaque
	 * @param {number} [alpha]
	 * @returns {string}
	 */
	function expandHexColor(input) {
		const c = String(input || '').trim();
		const short = c.match(/^#([0-9a-f]{3})$/i);
		if (short) {
			const h = short[1];
			return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
		}
		return c;
	}

	function tintCssBackground(opaque, alpha) {
		const c = opaqueCssColor(expandHexColor(opaque));
		if (!c) return '';
		const a = typeof alpha === 'number' ? alpha : 0.22;
		const hex = c.match(/^#([0-9a-f]{6})$/i);
		if (hex) {
			const n = parseInt(hex[1], 16);
			const r = (n >> 16) & 255;
			const g = (n >> 8) & 255;
			const b = n & 255;
			return `rgba(${r}, ${g}, ${b}, ${a})`;
		}
		const rgb = c.match(/^rgb\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i);
		if (rgb) return `rgba(${Number(rgb[1])}, ${Number(rgb[2])}, ${Number(rgb[3])}, ${a})`;
		return `color-mix(in srgb, ${c} ${Math.round(a * 100)}%, transparent)`;
	}

	/**
	 * @param {string} color
	 * @returns {string}
	 */
	function styleColorAttr(color, alpha) {
		const c = opaqueCssColor(expandHexColor(color));
		if (!c) return '';
		const fillAlpha = typeof alpha === 'number' ? alpha : 0.22;
		const bg = tintCssBackground(c, fillAlpha);
		const bgPart = bg ? `;background-color:${esc(bg)}` : '';
		return ` style="color:${esc(c)};border-color:${esc(c)}${bgPart}"`;
	}

	/** Type marker pill — Settings color or theme default (semantic `type` in .d.txt). */
	function typePillHtml(typeId, marker) {
		const tid = String(typeId || '').trim();
		const mk = String(marker || '').trim();
		if (!tid && !mk) {
			return `<span class="rz-type-pill rz-type-pill--theme rz-type-pill--muted">none</span>`;
		}
		const label = esc(mk ? mk : '.' + tid);
		const c = colorForMetadataType(tid, mk);
		if (c) {
			return `<span class="rz-type-pill rz-type-pill--settings"${styleColorAttr(c, 0.32)}>${label}</span>`;
		}
		return `<span class="rz-type-pill rz-type-pill--theme">${label}</span>`;
	}

	function applyThemeTypeAccent(el) {
		if (!el) return;
		const fg = getComputedStyle(document.documentElement).getPropertyValue('--rz-type-theme-fg').trim();
		if (fg) applyElementAccentColor(el, fg);
	}

	/**
	 * @param {HTMLElement} el
	 * @param {string} color
	 */
	function applyElementAccentColor(el, color) {
		if (!el) return;
		const c = opaqueCssColor(color);
		if (!c) {
			el.style.color = '';
			el.style.borderColor = '';
			el.style.backgroundColor = '';
			return;
		}
		el.style.color = c;
		el.style.borderColor = c;
		el.style.backgroundColor = tintCssBackground(c, 0.22) || '';
	}

	function hideTagSuggest() {
		const box = $('rz-tag-suggest');
		const inp = $('rz-tag-input');
		if (box) {
			box.classList.add('hidden');
			box.innerHTML = '';
		}
		if (inp) inp.setAttribute('aria-expanded', 'false');
	}

	function orderedTagCatalog() {
		const seen = new Set();
		/** @type {string[]} */
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
		return ordered;
	}

	/** Keep for catalog-init call sites; tag UI uses the in-panel suggest list. */
	function populateTagDatalist() {
		hideTagSuggest();
	}

	/**
	 * Ask host for hybrid tag suggest (3 letter + 5 embedding).
	 * @param {string} [q]
	 */
	function scheduleTagSuggest(q) {
		clearTimeout(tagSugTimer);
		tagSugTimer = setTimeout(() => {
			const inp = $('rz-tag-input');
			if (!inp || document.activeElement !== inp) {
				hideTagSuggest();
				return;
			}
			const trip = ++tagSuggestTrip;
			vscode.postMessage({
				type: 'retrieverTagSuggest',
				payload: {
					q: q != null ? q : inp.value || '',
					exclude: [...selectedTags],
					_seq: trip
				}
			});
		}, 90);
	}

	/**
	 * @param {{ prefix?: string[], semantic?: string[], _seq?: number }} payload
	 */
	function renderTagSuggestFromHost(payload) {
		const box = $('rz-tag-suggest');
		const inp = $('rz-tag-input');
		if (!box || !inp) return;
		if (payload && typeof payload._seq === 'number' && payload._seq !== tagSuggestTrip) {
			return;
		}
		if (document.activeElement !== inp) {
			hideTagSuggest();
			return;
		}
		const prefix = Array.isArray(payload && payload.prefix) ? payload.prefix : [];
		const semantic = Array.isArray(payload && payload.semantic) ? payload.semantic : [];
		const parts = [];
		if (prefix.length) {
			parts.push(`<div class="rz-tag-suggest-hdr">Letter match</div>`);
			for (const t of prefix) {
				parts.push(
					`<button type="button" role="option" class="rz-tag-suggest-item" data-tag="${esc(t)}">${esc(t)}</button>`
				);
			}
		}
		if (semantic.length) {
			parts.push(`<div class="rz-tag-suggest-hdr">Similar (embedding)</div>`);
			for (const t of semantic) {
				parts.push(
					`<button type="button" role="option" class="rz-tag-suggest-item rz-tag-suggest-sem" data-tag="${esc(t)}">${esc(t)}</button>`
				);
			}
		}
		if (!parts.length) {
			hideTagSuggest();
			return;
		}
		box.innerHTML = parts.join('');
		box.classList.remove('hidden');
		inp.setAttribute('aria-expanded', 'true');
	}

	/** @deprecated local-only path — prefer scheduleTagSuggest */
	function renderTagSuggest(q) {
		scheduleTagSuggest(q);
	}

	function populateTagGraphSelect() {
		const sel = /** @type {HTMLSelectElement | null} */ ($('rz-tag-graph'));
		if (!sel) return;
		const prev = selectedTagGraphId || sel.value || '';
		sel.innerHTML = '';
		const none = document.createElement('option');
		none.value = '';
		none.textContent = 'None';
		sel.appendChild(none);
		for (const g of tagGraphs) {
			const o = document.createElement('option');
			o.value = String(g.id);
			o.textContent = String(g.name || g.id);
			sel.appendChild(o);
		}
		sel.value = [...sel.options].some(o => o.value === prev) ? prev : '';
		selectedTagGraphId = sel.value || '';
	}

	function addSelectedTag(raw) {
		const tag = String(raw || '')
			.trim()
			.toLowerCase();
		if (!tag) return;
		selectedTags.add(tag);
		const inp = $('rz-tag-input');
		if (inp) inp.value = '';
		hideTagSuggest();
		renderSelectedTagChips();
		renderResults(lastResultPayload);
		scheduleQueryImmediate({ skipSuggest: true });
		persistUiSoon();
	}

	function hideRelTagSuggest() {
		const box = $('rz-rel-tag-suggest');
		const inp = $('rz-rel-tag-input');
		if (box) {
			box.classList.add('hidden');
			box.innerHTML = '';
		}
		if (inp) inp.setAttribute('aria-expanded', 'false');
	}

	function scheduleRelTagSuggest(rawQ) {
		clearTimeout(relTagSugTimer);
		relTagSugTimer = setTimeout(() => {
			const inp = $('rz-rel-tag-input');
			if (!inp || document.activeElement !== inp || !selectedRelationType) {
				hideRelTagSuggest();
				return;
			}
			const q = String(rawQ || '')
				.trim()
				.toLowerCase();
			const trip = ++relTagSuggestTrip;
			const matches = (allTags || [])
				.filter(t => {
					const tag = String(t || '')
						.trim()
						.toLowerCase();
					const activeSet = selectedRelations.get(selectedRelationType);
					if (!tag || (activeSet && activeSet.has(tag))) return false;
					return !q || tag.includes(q);
				})
				.slice(0, 24);
			if (trip !== relTagSuggestTrip) return;
			const box = $('rz-rel-tag-suggest');
			if (!box) return;
			if (!matches.length) {
				hideRelTagSuggest();
				return;
			}
			box.innerHTML = matches
				.map(
					t =>
						`<button type="button" role="option" class="rz-tag-suggest-item" data-tag="${esc(t)}">${esc(t)}</button>`
				)
				.join('');
			box.classList.remove('hidden');
			inp.setAttribute('aria-expanded', 'true');
		}, 90);
	}

	function addSelectedRelationTag(raw) {
		if (!selectedRelationType) return;
		const tag = String(raw || '')
			.trim()
			.toLowerCase();
		if (!tag) return;
		const set = ensureRelationTagSet(selectedRelationType);
		if (!set) return;
		set.add(tag);
		const inp = $('rz-rel-tag-input');
		if (inp) inp.value = '';
		hideRelTagSuggest();
		renderSelectedRelationTagChips();
		renderResults(lastResultPayload);
		scheduleQueryImmediate({ skipSuggest: true });
		persistUiSoon();
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

	/** @param {unknown[]} rows */
	function dedupeRowsOnePerFile(rows) {
		const seen = new Set();
		/** @type {unknown[]} */
		const out = [];
		for (const row of rows || []) {
			const rel = String((row && row.relPath) || '');
			if (seen.has(rel)) continue;
			seen.add(rel);
			out.push(row);
		}
		return out;
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
		const tagStyle = styleColorAttr(metaUiColors.tagsColor);
		return (
			`<div class="rz-tags-row">` +
			shown.map(t => `<span class="rz-tag-pill"${tagStyle}>${esc(t)}</span>`).join('') +
			(more ? `<span class="rz-tag-more">${esc(more)}</span>` : '') +
			`</div>`
		);
	}

	/**
	 * Relations breadcrumb: when any relation filter is active and Display → Relations is on.
	 * Shows each selected relation type's matching tags on the row.
	 */
	function relationsRowHtml(row) {
		const filters = getSelectedRelationFilters();
		if (!showRowRelations || !filters.length) return '';
		const tagStyle = styleColorAttr(metaUiColors.tagsColor);
		/** @type {string[]} */
		const parts = [];
		for (const f of filters) {
			const bag =
				row && row.relations && typeof row.relations === 'object' ? row.relations[f.type] : null;
			let list = Array.isArray(bag)
				? bag.map(t => String(t || '').trim().toLowerCase()).filter(Boolean)
				: [];
			if (f.tags.length) list = list.filter(t => f.tags.includes(t));
			if (!list.length) continue;
			const shown = list.slice(0, 8);
			const more = list.length > shown.length ? ` +${list.length - shown.length}` : '';
			parts.push(
				`<div class="rz-tags-row rz-relations-row" title="${esc(f.type)}">` +
					`<span class="rz-rel-key">${esc(f.type)}:</span>` +
					shown.map(t => `<span class="rz-tag-pill"${tagStyle}>${esc(t)}</span>`).join('') +
					(more ? `<span class="rz-tag-more">${esc(more)}</span>` : '') +
					`</div>`
			);
		}
		return parts.join('');
	}

	function scorePillHtml(row) {
		const overlap = Number(row && row._tagOverlap);
		const relOverlap = Number(row && row._relationOverlap);
		const score =
			Number(row && row._relevanceScore) ||
			Number(row && row._embeddingScore);
		const bits = [];
		if (selectedTags.size && Number.isFinite(overlap) && overlap > 0) {
			bits.push(
				`<span class="rz-score-pill" title="Selected tags matched">${overlap}/${selectedTags.size} tags</span>`
			);
		}
		const relNeed = totalSelectedRelationTagCount();
		if (relNeed && Number.isFinite(relOverlap) && relOverlap > 0) {
			bits.push(
				`<span class="rz-score-pill" title="Relation tags matched across selected types">${relOverlap}/${relNeed} relations</span>`
			);
		}
		if (Number.isFinite(score) && score > 0) {
			const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
			const label =
				searchEngine === 'word'
					? 'Word match'
					: searchEngine === 'semantic'
						? 'Semantic relevance'
						: 'Recommended relevance (92% semantic / 8% word)';
			bits.push(`<span class="rz-score-pill" title="${esc(label)}">${pct}%</span>`);
		}
		return bits.join('');
	}

	function rowHtml(row) {
		let bc = '';
		if (showBreadcrumbs) {
			const kv = row && row.metadataKv && typeof row.metadataKv === 'object' ? row.metadataKv : null;
			const kvEntries = kv
				? Object.keys(kv)
						.filter(k => String(kv[k] || '').trim())
						.slice(0, 8)
						.map(k => `${k}: ${String(kv[k])}`)
				: [];
			if (kvEntries.length) {
				bc =
					`<div class="rz-bc rz-bc-kv">` +
					kvEntries
						.map(s => {
							const i = s.indexOf(':');
							const k = i >= 0 ? s.slice(0, i) : s;
							const v = i >= 0 ? s.slice(i + 1).trim() : '';
							return (
								`<span class="rz-bc-kv-item">` +
								`<span class="rz-bc-k">${esc(k)}</span>` +
								(v ? `<span class="rz-bc-colon">:</span> <span class="rz-bc-v">${esc(v)}</span>` : '') +
								`</span>`
							);
						})
						.join('') +
					`</div>`;
			} else if (row.breadcrumbs && row.breadcrumbs.length > 1) {
				bc = `<div class="rz-bc">${esc(row.breadcrumbs.slice(0, -1).join(' › '))}</div>`;
			}
		}
		const pathLine =
			showPathLine
				? `<div class="rz-meta">${esc(formatRelPath(row.relPath, row.line))}</div>`
				: '';
		let typeHtml = '';
		if (showTypeStrip) {
			typeHtml = typePillHtml(row.typeId, row.marker);
		}
		const invalid = row.validHeading === false;
		const titleClass = invalid ? 'rz-title is-invalid-heading' : 'rz-title';
		const tagsHtml = tagsRowHtml(row);
		const relHtml = relationsRowHtml(row);
		const scoreHtml = scorePillHtml(row);
		const rp = esc(row.relPath || '');
		const fid = esc(row.fileId || '');
		const hid = Number(row.headingId) || 0;
		const titleAttr = esc(String(row.title || ''));
		// Breadcrumb stack order: type → metadata KV → search tags → relations (if filtered) → path
		return (
			`<button type="button" class="rz-row" role="option" tabindex="-1" data-uri="${esc(row.uri)}" data-line="${Number(row.line) || 1}" data-rel="${rp}" data-fileid="${fid}" data-headingid="${hid}" data-title="${titleAttr}">` +
			`<span class="rz-row-head"><span class="${titleClass}">${esc(row.title)}</span>${scoreHtml}</span>` +
			typeHtml +
			bc +
			tagsHtml +
			relHtml +
			pathLine +
			`</button>`
		);
	}

	function postRetrieverOpenFromEl(el) {
		if (!el) return;
		const uri = el.getAttribute('data-uri');
		if (!uri) return;
		vscode.postMessage({
			type: 'retrieverOpen',
			uri,
			line: Number(el.getAttribute('data-line')) || 1,
			title: el.getAttribute('data-title') || '',
			headingId: Number(el.getAttribute('data-headingid')) || 0
		});
	}

	function bindRowClicks(scope) {
		const root = scope || document;
		root.querySelectorAll('.rz-row, .rz-card').forEach(btn => {
			btn.addEventListener('click', () => postRetrieverOpenFromEl(btn));
		});
	}

	function focusRowsOrCards(items, idx) {
		items.forEach((r, i) => r.setAttribute('tabindex', i === idx ? '0' : '-1'));
		if (items[idx]) items[idx].focus();
	}

	/**
	 * File buckets: always when Scope = Files (ranked by file/h0 embeddings).
	 * Headings scope uses Group dropdown + buildGroupedListParts instead.
	 */
	function useFileHeadingGroupLayout() {
		if (viewMode !== 'list') return false;
		return readScopeFromUi().scope === 'files';
	}

	/**
	 * Client-side safety net (host already filters from index.drip).
	 * Types = OR. Tags = at least one overlap. Attribute filters AND within type.
	 * @param {unknown[]} rows
	 */
	function filterRowsByChips(rows) {
		const list = Array.isArray(rows) ? rows : [];
		const hasAttr = attrFiltersActive();
		if (
			!selectedTypes.size &&
			!selectedTags.size &&
			!relationFiltersActive() &&
			!hasAttr
		) {
			return list;
		}
		return list.filter(row => {
			if (selectedTypes.size) {
				const tid = String((row && row.typeId) || '')
					.trim()
					.toLowerCase();
				const wantsNone = selectedTypes.has(NONE_TYPE_ID);
				const typed = [...selectedTypes].filter(x => x !== NONE_TYPE_ID);
				let ok = false;
				if (wantsNone && !tid) ok = true;
				if (typed.length && tid && selectedTypes.has(tid)) ok = true;
				if (!ok) return false;
			}
			if (!rowMatchesAttrFilters(row)) return false;
			if (selectedTags.size) {
				// Soft rank only — never drop rows for missing tags.
			}
			return true;
		});
	}

	function attrFiltersActive() {
		for (const typeId of Object.keys(attrFilters)) {
			const byKey = attrFilters[typeId];
			if (!byKey) continue;
			for (const key of Object.keys(byKey)) {
				const f = byKey[key];
				if (!f) continue;
				if (f.kind === 'enum' && Array.isArray(f.values) && f.values.length) return true;
				if (f.kind === 'datetime' && f.mode && f.mode !== 'any') return true;
				if (f.kind === 'duration' && f.mode && f.mode !== 'any') return true;
			}
		}
		return false;
	}

	function parseAttrDate(raw) {
		const s = String(raw || '').trim();
		if (!s) return null;
		const abs = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
		if (abs) {
			const d = new Date(
				Number(abs[1]),
				Number(abs[2]) - 1,
				Number(abs[3]),
				Number(abs[4] || 0),
				Number(abs[5] || 0),
				Number(abs[6] || 0),
				0
			);
			return Number.isNaN(d.getTime()) ? null : d;
		}
		const t = Date.parse(s);
		return Number.isNaN(t) ? null : new Date(t);
	}

	function startOfLocalDay(d) {
		return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
	}

	function durationToMinutes(amount, unit) {
		const a = Number(amount);
		if (!Number.isFinite(a)) return null;
		const u = String(unit || '').toLowerCase();
		const map = {
			minute: 1,
			minutes: 1,
			hour: 60,
			hours: 60,
			day: 1440,
			days: 1440,
			week: 10080,
			weeks: 10080,
			month: 43200,
			months: 43200,
			year: 525600,
			years: 525600
		};
		const m = map[u];
		return m == null ? null : a * m;
	}

	function parseDurationMinutes(raw) {
		const s = String(raw || '').trim();
		const m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+))\s+([a-z]+)$/i);
		if (!m) return null;
		return durationToMinutes(m[1], m[2]);
	}

	function matchDatetimeFilter(rawValue, f) {
		const mode = String((f && f.mode) || 'any');
		if (mode === 'any') return true;
		const valueDate = parseAttrDate(rawValue);
		if (!valueDate) return false;
		const now = new Date();
		const today0 = startOfLocalDay(now);
		const tomorrow0 = new Date(today0.getTime() + 86400000);
		if (mode === 'today') return valueDate >= today0 && valueDate < tomorrow0;
		if (mode === 'before_today') return valueDate < today0;
		if (mode === 'after_today') return valueDate >= tomorrow0;
		if (mode === 'before') {
			const bound = parseAttrDate(f.customFrom);
			return bound ? valueDate < bound : true;
		}
		if (mode === 'after') {
			const bound = parseAttrDate(f.customFrom);
			return bound ? valueDate > bound : true;
		}
		if (mode === 'between') {
			const from = parseAttrDate(f.customFrom);
			const to = parseAttrDate(f.customTo);
			if (from && valueDate < from) return false;
			if (to && valueDate > to) return false;
			return !!(from || to);
		}
		return true;
	}

	function matchDurationFilter(rawValue, f) {
		const mode = String((f && f.mode) || 'any');
		if (mode === 'any') return true;
		const valueMin = parseDurationMinutes(rawValue);
		if (valueMin == null) return false;
		const unit = f.unit || 'hour';
		const a = durationToMinutes(f.amount, unit);
		const b = durationToMinutes(f.amountTo, unit);
		if (mode === 'eq') return a != null && Math.abs(valueMin - a) < 1e-6;
		if (mode === 'lt') return a != null && valueMin < a;
		if (mode === 'gt') return a != null && valueMin > a;
		if (mode === 'between') {
			if (a != null && valueMin < a) return false;
			if (b != null && valueMin > b) return false;
			return a != null || b != null;
		}
		return true;
	}

	function rowMatchesAttrFilters(row) {
		const tid = String((row && row.typeId) || '')
			.trim()
			.toLowerCase();
		if (!tid) return true;
		const byKey = attrFilters[tid];
		if (!byKey) return true;
		const kv =
			row && row.metadataKv && typeof row.metadataKv === 'object' ? row.metadataKv : {};
		for (const key of Object.keys(byKey)) {
			const f = byKey[key];
			if (!f) continue;
			const raw = String(kv[key] != null ? kv[key] : kv[String(key).toLowerCase()] || '').trim();
			if (f.kind === 'enum') {
				const want = Array.isArray(f.values) ? f.values.map(v => String(v).toLowerCase()) : [];
				if (!want.length) continue;
				if (!raw || !want.includes(raw.toLowerCase())) return false;
				continue;
			}
			if (f.kind === 'datetime') {
				if (!matchDatetimeFilter(raw, f)) return false;
				continue;
			}
			if (f.kind === 'duration') {
				if (!matchDurationFilter(raw, f)) return false;
			}
		}
		return true;
	}

	function pruneAttrFiltersToSelectedTypes() {
		const keep = new Set(
			[...selectedTypes].filter(id => id && id !== NONE_TYPE_ID)
		);
		for (const typeId of Object.keys(attrFilters)) {
			if (!keep.has(typeId)) delete attrFilters[typeId];
		}
	}

	function ensureAttrFilterState(typeId, attr) {
		const tid = String(typeId || '').toLowerCase();
		const key = String((attr && attr.key) || '').toLowerCase();
		if (!tid || !key) return null;
		if (!attrFilters[tid]) attrFilters[tid] = {};
		if (!attrFilters[tid][key]) {
			const kind = String((attr && attr.kind) || 'enum').toLowerCase();
			if (kind === 'datetime') {
				attrFilters[tid][key] = { kind: 'datetime', mode: 'any', customFrom: '', customTo: '' };
			} else if (kind === 'duration') {
				attrFilters[tid][key] = {
					kind: 'duration',
					mode: 'any',
					amount: '',
					amountTo: '',
					unit: 'hour'
				};
			} else {
				attrFilters[tid][key] = { kind: 'enum', values: [] };
			}
		}
		return attrFilters[tid][key];
	}

	function enumFilterSummary(values) {
		const list = Array.isArray(values) ? values.map(v => String(v || '').trim()).filter(Boolean) : [];
		if (!list.length) return '—';
		if (list.length <= 2) return list.join(' · ');
		return list.slice(0, 2).join(' · ') + ` +${list.length - 2}`;
	}

	function datetimeFilterSummary(st) {
		const mode = String((st && st.mode) || 'any');
		if (mode === 'any') return '—';
		const hit = ATTR_DT_MODES.find(m => m.id === mode);
		return (hit && hit.label) || mode;
	}

	function durationFilterSummary(st) {
		const mode = String((st && st.mode) || 'any');
		if (mode === 'any') return '—';
		const hit = ATTR_DUR_MODES.find(m => m.id === mode);
		const label = (hit && hit.label) || mode;
		const unit = (st && st.unit) || 'hour';
		const a = String((st && st.amount) || '').trim();
		const b = String((st && st.amountTo) || '').trim();
		if (mode === 'between' && (a || b)) return `${label} ${a || '…'}–${b || '…'} ${unit}`;
		if (a) return `${label} ${a} ${unit}`;
		return label;
	}

	function closeAllAttrMenus(exceptEl) {
		document.querySelectorAll('.rz-attr-menu.is-open').forEach(menu => {
			if (exceptEl && menu === exceptEl) return;
			menu.classList.remove('is-open');
			menu.hidden = true;
			const row = menu.closest('.rz-attr-key');
			const btn = row && row.querySelector('.rz-attr-box');
			if (btn) btn.setAttribute('aria-expanded', 'false');
		});
	}

	function renderAttrFilters() {
		const panel = $('rz-attr-filter-panel');
		const body = $('rz-attr-filter-body');
		const emptyHint = $('rz-attr-filter-empty');
		if (!panel || !body) return;
		pruneAttrFiltersToSelectedTypes();
		const typedIds = [...selectedTypes].filter(id => id && id !== NONE_TYPE_ID);
		if (!typedIds.length) {
			panel.hidden = true;
			panel.classList.add('hidden');
			body.innerHTML = '';
			return;
		}
		panel.hidden = false;
		panel.classList.remove('hidden');
		const parts = [];
		let anyAttrs = false;
		for (const typeId of typedIds) {
			const t = metadataTypes.find(
				x =>
					String((x && x.id) || '')
						.trim()
						.toLowerCase() === typeId
			);
			const attrs = Array.isArray(t && t.attributes) ? t.attributes : [];
			if (!attrs.length) continue;
			anyAttrs = true;
			const face = (t && t.marker) || typeId;
			parts.push(`<section class="rz-attr-type" data-type-id="${esc(typeId)}">`);
			parts.push(`<div class="rz-attr-type-hdr">${esc(face)}</div>`);
			for (const attr of attrs) {
				const key = String((attr && attr.key) || '')
					.trim()
					.toLowerCase();
				if (!key) continue;
				const kind = String((attr && attr.kind) || 'enum').toLowerCase();
				const st = ensureAttrFilterState(typeId, { key, kind });
				parts.push(
					`<div class="rz-attr-key" data-type-id="${esc(typeId)}" data-key="${esc(key)}" data-kind="${esc(kind)}">`
				);
				parts.push(`<span class="rz-attr-key-label">${esc(key)}</span>`);
				parts.push(`<div class="rz-attr-box-wrap">`);

				if (kind === 'enum') {
					const catalogVals = Array.isArray(attr.values) ? attr.values : [];
					const selected = Array.isArray(st && st.values) ? st.values : [];
					const selectedSet = new Set(selected.map(v => String(v).toLowerCase()));
					const summary = enumFilterSummary(selected);
					const active = selected.length > 0;
					parts.push(
						`<button type="button" class="rz-attr-box${active ? ' is-active' : ''}" aria-haspopup="listbox" aria-expanded="false" title="Filter ${esc(key)} (OR)">` +
							`<span class="rz-attr-box-text">${esc(summary)}</span>` +
							`<span class="rz-attr-box-caret" aria-hidden="true">▾</span>` +
							`</button>`
					);
					parts.push(`<div class="rz-attr-menu" role="listbox" aria-label="${esc(key)} options" hidden>`);
					parts.push(
						`<button type="button" class="rz-attr-opt rz-attr-opt-clear${active ? '' : ' is-selected'}" data-act="clear" role="option">—</button>`
					);
					if (catalogVals.length > 1) {
						parts.push(`<div class="rz-attr-menu-hint">Select one or more (OR)</div>`);
					}
					for (const v of catalogVals) {
						const vv = String(v || '').trim();
						if (!vv) continue;
						const on = selectedSet.has(vv.toLowerCase());
						parts.push(
							`<label class="rz-attr-opt rz-attr-opt-check${on ? ' is-selected' : ''}">` +
								`<input type="checkbox" value="${esc(vv)}"${on ? ' checked' : ''} />` +
								`<span>${esc(vv)}</span>` +
								`</label>`
						);
					}
					parts.push(`</div>`);
				} else if (kind === 'datetime') {
					const mode = (st && st.mode) || 'any';
					const summary = datetimeFilterSummary(st);
					const active = mode !== 'any';
					parts.push(
						`<button type="button" class="rz-attr-box${active ? ' is-active' : ''}" aria-haspopup="listbox" aria-expanded="false" title="Filter ${esc(key)}">` +
							`<span class="rz-attr-box-text">${esc(summary)}</span>` +
							`<span class="rz-attr-box-caret" aria-hidden="true">▾</span>` +
							`</button>`
					);
					parts.push(`<div class="rz-attr-menu" role="listbox" aria-label="${esc(key)} date options" hidden>`);
					for (const m of ATTR_DT_MODES) {
						const label = m.id === 'any' ? '—' : m.label;
						parts.push(
							`<button type="button" class="rz-attr-opt${mode === m.id ? ' is-selected' : ''}" data-act="dt-mode" data-mode="${m.id}" role="option">${esc(label)}</button>`
						);
					}
					parts.push(`</div>`);
					const needCustom = mode === 'before' || mode === 'after' || mode === 'between';
					const needTo = mode === 'between';
					if (needCustom) {
						parts.push(
							`<div class="rz-attr-extra">` +
								`<input type="datetime-local" class="rz-attr-dt-from" value="${esc((st && st.customFrom) || '')}" aria-label="${esc(key)} from" />` +
								(needTo
									? `<input type="datetime-local" class="rz-attr-dt-to" value="${esc((st && st.customTo) || '')}" aria-label="${esc(key)} to" />`
									: '') +
								`</div>`
						);
					}
				} else if (kind === 'duration') {
					const mode = (st && st.mode) || 'any';
					const summary = durationFilterSummary(st);
					const active = mode !== 'any';
					parts.push(
						`<button type="button" class="rz-attr-box${active ? ' is-active' : ''}" aria-haspopup="listbox" aria-expanded="false" title="Filter ${esc(key)}">` +
							`<span class="rz-attr-box-text">${esc(summary)}</span>` +
							`<span class="rz-attr-box-caret" aria-hidden="true">▾</span>` +
							`</button>`
					);
					parts.push(`<div class="rz-attr-menu" role="listbox" aria-label="${esc(key)} duration options" hidden>`);
					for (const m of ATTR_DUR_MODES) {
						const label = m.id === 'any' ? '—' : m.label;
						parts.push(
							`<button type="button" class="rz-attr-opt${mode === m.id ? ' is-selected' : ''}" data-act="dur-mode" data-mode="${m.id}" role="option">${esc(label)}</button>`
						);
					}
					parts.push(`</div>`);
					if (mode !== 'any') {
						const needTo = mode === 'between';
						const unit = (st && st.unit) || 'hour';
						parts.push(`<div class="rz-attr-extra rz-attr-extra-dur">`);
						parts.push(
							`<input type="number" min="0" step="any" class="rz-attr-dur-amount" value="${esc((st && st.amount) || '')}" placeholder="amount" aria-label="${esc(key)} amount" />`
						);
						if (needTo) {
							parts.push(
								`<input type="number" min="0" step="any" class="rz-attr-dur-amount-to" value="${esc((st && st.amountTo) || '')}" placeholder="to" aria-label="${esc(key)} amount to" />`
							);
						}
						parts.push(`<select class="rz-select rz-attr-dur-unit" aria-label="${esc(key)} unit">`);
						for (const u of ATTR_DURATION_UNITS) {
							parts.push(`<option value="${u}"${unit === u ? ' selected' : ''}>${u}</option>`);
						}
						parts.push(`</select></div>`);
					}
				}

				parts.push(`</div></div>`);
			}
			parts.push(`</section>`);
		}
		if (emptyHint) emptyHint.classList.toggle('hidden', anyAttrs);
		body.innerHTML = anyAttrs ? parts.join('') : '';
		if (!anyAttrs && emptyHint) {
			emptyHint.classList.remove('hidden');
			emptyHint.textContent = 'Selected types have no metadata keys in Settings.';
		}
	}

	function commitAttrFilterChange() {
		renderAttrFilters();
		renderResults(lastResultPayload);
		persistUiSoon();
	}

	function clearMetadataAttrFiltersOnly() {
		attrFilters = {};
		commitAttrFilterChange();
	}

	function onAttrFilterPanelClick(e) {
		const t = e && e.target;
		if (!t || !t.closest) return;
		const keyEl = t.closest('.rz-attr-key');
		if (!keyEl) return;
		const typeId = String(keyEl.getAttribute('data-type-id') || '').toLowerCase();
		const key = String(keyEl.getAttribute('data-key') || '').toLowerCase();
		const kind = String(keyEl.getAttribute('data-kind') || 'enum').toLowerCase();
		if (!typeId || !key) return;
		if (!attrFilters[typeId]) attrFilters[typeId] = {};

		const boxBtn = t.closest('.rz-attr-box');
		if (boxBtn && keyEl.contains(boxBtn)) {
			e.preventDefault();
			const menu = keyEl.querySelector('.rz-attr-menu');
			if (!menu) return;
			const open = !menu.classList.contains('is-open');
			closeAllAttrMenus(open ? menu : null);
			menu.classList.toggle('is-open', open);
			menu.hidden = !open;
			boxBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
			return;
		}

		const clearBtn = t.closest('.rz-attr-opt-clear');
		if (clearBtn && keyEl.contains(clearBtn)) {
			e.preventDefault();
			if (kind === 'enum') attrFilters[typeId][key] = { kind: 'enum', values: [] };
			else if (kind === 'datetime') {
				attrFilters[typeId][key] = { kind: 'datetime', mode: 'any', customFrom: '', customTo: '' };
			} else if (kind === 'duration') {
				attrFilters[typeId][key] = {
					kind: 'duration',
					mode: 'any',
					amount: '',
					amountTo: '',
					unit: 'hour'
				};
			}
			commitAttrFilterChange();
			return;
		}

		const dtOpt = t.closest('[data-act="dt-mode"]');
		if (dtOpt && keyEl.contains(dtOpt)) {
			e.preventDefault();
			const mode = String(dtOpt.getAttribute('data-mode') || 'any');
			const prev = attrFilters[typeId][key] || {};
			attrFilters[typeId][key] = {
				kind: 'datetime',
				mode,
				customFrom: prev.customFrom || '',
				customTo: prev.customTo || ''
			};
			commitAttrFilterChange();
			return;
		}

		const durOpt = t.closest('[data-act="dur-mode"]');
		if (durOpt && keyEl.contains(durOpt)) {
			e.preventDefault();
			const mode = String(durOpt.getAttribute('data-mode') || 'any');
			const prev = attrFilters[typeId][key] || {};
			attrFilters[typeId][key] = {
				kind: 'duration',
				mode,
				amount: prev.amount || '',
				amountTo: prev.amountTo || '',
				unit: prev.unit || 'hour'
			};
			commitAttrFilterChange();
		}
	}

	function onAttrFilterPanelChange(e) {
		const t = e && e.target;
		if (!t || !t.closest) return;
		const keyEl = t.closest('.rz-attr-key');
		if (!keyEl) return;
		const typeId = String(keyEl.getAttribute('data-type-id') || '').toLowerCase();
		const key = String(keyEl.getAttribute('data-key') || '').toLowerCase();
		const kind = String(keyEl.getAttribute('data-kind') || 'enum').toLowerCase();
		if (!typeId || !key) return;
		if (!attrFilters[typeId]) attrFilters[typeId] = {};

		if (kind === 'enum' && t.type === 'checkbox') {
			const boxes = [...keyEl.querySelectorAll('.rz-attr-opt-check input[type="checkbox"]')];
			const values = boxes
				.filter(c => c.checked)
				.map(c => String(c.value || '').trim())
				.filter(Boolean);
			attrFilters[typeId][key] = { kind: 'enum', values };
			// Keep menu open while multi-selecting; refresh summary on the box only
			const boxText = keyEl.querySelector('.rz-attr-box-text');
			const box = keyEl.querySelector('.rz-attr-box');
			if (boxText) boxText.textContent = enumFilterSummary(values);
			if (box) box.classList.toggle('is-active', values.length > 0);
			keyEl.querySelectorAll('.rz-attr-opt-check').forEach(lab => {
				const inp = lab.querySelector('input');
				lab.classList.toggle('is-selected', !!(inp && inp.checked));
			});
			const clearOpt = keyEl.querySelector('.rz-attr-opt-clear');
			if (clearOpt) clearOpt.classList.toggle('is-selected', values.length === 0);
			renderResults(lastResultPayload);
			persistUiSoon();
			return;
		}

		if (kind === 'datetime') {
			const prev = attrFilters[typeId][key] || { kind: 'datetime', mode: 'any' };
			const fromEl = /** @type {HTMLInputElement | null} */ (keyEl.querySelector('.rz-attr-dt-from'));
			const toEl = /** @type {HTMLInputElement | null} */ (keyEl.querySelector('.rz-attr-dt-to'));
			attrFilters[typeId][key] = {
				kind: 'datetime',
				mode: prev.mode || 'any',
				customFrom: (fromEl && fromEl.value) || '',
				customTo: (toEl && toEl.value) || ''
			};
			renderResults(lastResultPayload);
			persistUiSoon();
			return;
		}

		if (kind === 'duration') {
			const prev = attrFilters[typeId][key] || { kind: 'duration', mode: 'any' };
			const amtEl = /** @type {HTMLInputElement | null} */ (keyEl.querySelector('.rz-attr-dur-amount'));
			const amtToEl = /** @type {HTMLInputElement | null} */ (keyEl.querySelector('.rz-attr-dur-amount-to'));
			const unitEl = /** @type {HTMLSelectElement | null} */ (keyEl.querySelector('.rz-attr-dur-unit'));
			attrFilters[typeId][key] = {
				kind: 'duration',
				mode: prev.mode || 'any',
				amount: (amtEl && amtEl.value) || '',
				amountTo: (amtToEl && amtToEl.value) || '',
				unit: (unitEl && unitEl.value) || 'hour'
			};
			const boxText = keyEl.querySelector('.rz-attr-box-text');
			if (boxText) boxText.textContent = durationFilterSummary(attrFilters[typeId][key]);
			renderResults(lastResultPayload);
			persistUiSoon();
		}
	}

	/**
	 * Prefer host order (already ranked). Re-apply tag overlap + Title locally if needed.
	 * @param {unknown[]} rows
	 */
	function sortRowsForDisplay(rows) {
		const list = Array.isArray(rows) ? rows.slice() : [];
		const tagList = [...selectedTags];
		const overlap = row => {
			if (!tagList.length) return Number(row && row._tagOverlap) || 0;
			const tags = Array.isArray(row && row.tags)
				? row.tags.map(t => String(t || '').trim().toLowerCase())
				: [];
			let n = 0;
			for (const need of tagList) {
				if (tags.includes(need)) n += 1;
			}
			return n;
		};
		list.sort((a, b) => {
			if (tagList.length) {
				const ia = overlap(a);
				const ib = overlap(b);
				if (ia !== ib) return ib - ia;
			}
			// Preserve host search-engine order.
			return 0;
		});
		return list;
	}

	/**
	 * @param {unknown[]} rows
	 */
	function prepareRowsForDisplay(rows) {
		return sortRowsForDisplay(filterRowsByChips(rows));
	}

	/**
	 * Order file buckets by best (first) hit rank.
	 * First paint / new query: expand all; user can collapse. Load more: expand only new files.
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
		/** Best-first file order = order of first appearance in ranked list. */
		const fileOrder = [];
		const seen = new Set();
		for (const row of list) {
			const rel = String((row && row.relPath) || '');
			if (!seen.has(rel)) {
				seen.add(rel);
				fileOrder.push(rel);
			}
		}
		const sessionKey = `${readScopeFromUi().scope}|${retrieverTrimmedSearchQuery()}|${viewMode}`;
		if (sessionKey !== fileGroupExpandSessionKey) {
			fileGroupExpandSessionKey = sessionKey;
			expandedFileGroupPaths.clear();
			fileGroupKnownPaths.clear();
			for (const rel of fileOrder) {
				expandedFileGroupPaths.add(rel);
				fileGroupKnownPaths.add(rel);
			}
		} else {
			for (const rel of fileOrder) {
				if (!fileGroupKnownPaths.has(rel)) {
					fileGroupKnownPaths.add(rel);
					expandedFileGroupPaths.add(rel);
				}
			}
		}
		const chevronSvg =
			'<svg class="rz-chevron-ic" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.5 3.5L11 8l-4.5 4.5V3.5z"/></svg>';
		const parts = [];
		for (const rel of fileOrder) {
			const groupRows = byRel.get(rel) || [];
			const baseName =
				rel && rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel || '(note)';
			const topTitle = String((groupRows[0] && groupRows[0].title) || '').trim();
			const fileScore = Number(groupRows[0] && groupRows[0]._fileEmbeddingScore);
			const fileScoreHtml =
				Number.isFinite(fileScore) && fileScore > 0
					? `<span class="rz-score-pill" title="File relevance">${Math.round(
							Math.max(0, Math.min(1, fileScore)) * 100
						)}%</span>`
					: '';
			const expanded = expandedFileGroupPaths.has(rel);
			const rowCount = groupRows.length;
			parts.push(`<section class="rz-file-group" role="group">`);
			parts.push(
				`<button type="button" class="rz-file-group-header" aria-expanded="${expanded ? 'true' : 'false'}" aria-label="${esc(
					expanded ? 'Collapse' : 'Expand'
				)} ${esc(baseName)}, ${rowCount} matching heading${rowCount === 1 ? '' : 's'}" data-file-rel="${relToFileGroupDataAttr(rel)}">` +
					`<span class="rz-file-group-chevron${expanded ? ' is-open' : ''}" aria-hidden="true">${chevronSvg}</span>` +
					`<span class="rz-file-group-title">${esc(baseName)}</span>` +
					fileScoreHtml +
					`<span class="rz-file-group-meta">${esc(rel)} · ${rowCount} heading${rowCount === 1 ? '' : 's'}${
						topTitle ? ` · ${esc(topTitle)}` : ''
					}</span>` +
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
			return rows.map(rowHtml);
		}
		const chevronSvg =
			'<svg class="rz-chevron-ic" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.5 3.5L11 8l-4.5 4.5V3.5z"/></svg>';
		/** @type {Map<string, { label: string, rows: unknown[] }>} */
		const groups = new Map();
		const order = [];
		for (const row of rows) {
			let key;
			let labelKind = 'folder';
			if (groupBy === 'folder') {
				key = folderKeyFromRel(row.relPath);
				labelKind = 'folder';
			} else if (groupBy === 'file') {
				key = String((row && row.relPath) || '(note)');
				labelKind = 'file';
			} else {
				key = (row.typeId || '').trim().toLowerCase() || '__untyped__';
				labelKind = 'type';
			}
			if (!groups.has(key)) {
				const displayKey = groupBy === 'type' && key === '__untyped__' ? '' : key;
				const label =
					labelKind === 'file'
						? key.includes('/')
							? key.slice(key.lastIndexOf('/') + 1)
							: key
						: formatGroupHeading(displayKey, labelKind === 'file' ? 'folder' : labelKind);
				groups.set(key, { label, rows: [] });
				order.push(key);
			}
			groups.get(key).rows.push(row);
		}
		const parts = [];
		for (const key of order) {
			const g = groups.get(key);
			const expanded = expandedGroupKeys.has(key);
			const n = g.rows.length;
			parts.push(`<section class="rz-group-section" role="group">`);
			parts.push(
				`<button type="button" class="rz-group-toggle" aria-expanded="${expanded ? 'true' : 'false'}" data-group-key="${esc(key)}">` +
					`<span class="rz-group-toggle-chevron${expanded ? ' is-open' : ''}" aria-hidden="true">${chevronSvg}</span>` +
					`<span>${esc(g.label)} · ${n}</span>` +
					`</button>`
			);
			parts.push(`<div class="rz-group-body" ${expanded ? '' : 'hidden'}>`);
			for (const row of g.rows) parts.push(rowHtml(row));
			parts.push(`</div></section>`);
		}
		return parts;
	}

	/** Compact board slot — fewer KV/tags than list so two columns stay short. */
	function cardParts(r) {
		let typeHtml = '';
		if (showTypeStrip) {
			typeHtml = typePillHtml(r.typeId, r.marker);
		}
		let bc = '';
		if (showBreadcrumbs) {
			const kv = r && r.metadataKv && typeof r.metadataKv === 'object' ? r.metadataKv : null;
			const kvEntries = kv
				? Object.keys(kv)
						.filter(k => String(kv[k] || '').trim())
						.slice(0, 2)
						.map(k => `${k}: ${String(kv[k])}`)
				: [];
			if (kvEntries.length) {
				bc =
					`<div class="rz-bc rz-bc-kv">` +
					kvEntries
						.map(s => {
							const i = s.indexOf(':');
							const k = i >= 0 ? s.slice(0, i) : s;
							const v = i >= 0 ? s.slice(i + 1).trim() : '';
							return (
								`<span class="rz-bc-kv-item">` +
								`<span class="rz-bc-k">${esc(k)}</span>` +
								(v ? `<span class="rz-bc-colon">:</span> <span class="rz-bc-v">${esc(v)}</span>` : '') +
								`</span>`
							);
						})
						.join('') +
					`</div>`;
			}
		}
		const tagsHtml = showRowTags && r.tags && r.tags.length
			? `<div class="rz-card-tags">${r.tags
					.slice(0, 3)
					.map(t => `<span class="rz-tag-pill"${styleColorAttr(metaUiColors.tagsColor)}>${esc(t)}</span>`)
					.join('')}</div>`
			: '';
		const relHtml = relationsRowHtml(r);
		const scoreHtml = scorePillHtml(r);
		const rp = esc(r.relPath || '');
		const fid = esc(r.fileId || '');
		const pathLine = showPathLine
			? `<span class="rz-card-path">${esc(formatRelPath(r.relPath, r.line))}</span>`
			: '';
		const titleText = String(r.title || '');
		const titleEsc = esc(titleText);
		const hid = Number(r.headingId) || 0;
		/* Native tooltip shows full heading when CSS ellipsis truncates the card title */
		return (
			`<button type="button" class="rz-card" tabindex="-1" data-uri="${esc(r.uri)}" data-line="${Number(r.line) || 1}" data-rel="${rp}" data-fileid="${fid}" data-headingid="${hid}" data-title="${titleEsc}" title="${titleEsc}">` +
			`<span class="rz-row-head"><span class="rz-card-title">${titleEsc}</span>${scoreHtml}</span>` +
			typeHtml +
			bc +
			tagsHtml +
			relHtml +
			pathLine +
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
		const { scope, corpus } = readScopeFromUi();
		return scope !== 'headings' || corpus !== 'working';
	}

	function filtersOrSearchActive() {
		return (
			selectedTypes.size > 0 ||
			selectedTags.size > 0 ||
			relationFiltersActive() ||
			attrFiltersActive() ||
			scopeDiffersFromDefault() ||
			retrieverTrimmedSearchQuery().length > 0
		);
	}

	function clearAllRetrieverFilters() {
		selectedTypes.clear();
		selectedTags.clear();
		selectedRelationType = '';
		selectedRelations.clear();
		attrFilters = {};
		expandedFileGroupPaths.clear();
		fileGroupKnownPaths.clear();
		fileGroupExpandSessionKey = '';
		const inp = $('rz-heading-search');
		if (inp) inp.value = '';
		const sf = /** @type {HTMLInputElement | null} */ ($('rz-scope-files'));
		const sh = /** @type {HTMLInputElement | null} */ ($('rz-scope-headings'));
		if (sf) sf.checked = false;
		if (sh) sh.checked = true;
		syncGroupByForScope();
		const corpusSel = /** @type {HTMLSelectElement | null} */ ($('rz-corpus'));
		if (corpusSel) corpusSel.value = 'working';
		lastCorpusValue = 'working';
		clearCustomCorpusSession();
		const relSel = /** @type {HTMLSelectElement | null} */ ($('rz-relation-type'));
		if (relSel) relSel.value = '';
		renderTypeChips();
		renderAttrFilters();
		renderSelectedTagChips();
		renderSelectedRelationTagChips();
		syncRelationTagInputEnabled();
		hideSuggestPanel();
		scheduleQueryImmediate();
		persistUiSoon();
	}

	function renderSuggestDropdown(payload) {
		const inp = $('rz-heading-search');
		const pnl = $('rz-suggest-panel');
		if (!inp || !pnl || kbMissing) return;
		if (document.activeElement !== inp) {
			hideSuggestPanel();
			return;
		}
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
			.map(r => {
				const score = Number(r && r._embeddingScore);
				const scoreBit =
					Number.isFinite(score) && score > 0
						? `<span class="rz-suggest-score">${Math.round(Math.max(0, Math.min(1, score)) * 100)}%</span>`
						: '';
				return (
					`<button type="button" role="option" tabindex="0" class="rz-suggest-item" data-uri="${esc(
						r.uri
					)}" data-line="${Number(r.line) || 1}" data-headingid="${Number(r.headingId) || 0}" data-title="${esc(
						String(r.title || '')
					)}">` +
					`<span class="rz-suggest-title">${esc(r.title)}</span>` +
					scoreBit +
					`<span class="rz-suggest-meta">${esc(String(r.relPath || ''))}</span>` +
					`</button>`
				);
			})
			.join('');
		pnl.classList.remove('hidden');
		inp.setAttribute('aria-expanded', 'true');
		inp.setAttribute('aria-label', 'Search headings (dropdown shows top embedding matches)');
	}

	function renderResults(payload) {
		lastResultPayload = payload || lastResultPayload;
		const empty = $('rz-empty');
		const listEl = $('rz-list');
		const boardEl = $('rz-board');
		const foot = $('rz-footer');
		const loadBtn = $('rz-load-more');
		if (!empty || !listEl || !boardEl) return;

		const hostRows = (lastResultPayload && lastResultPayload.rows) || [];
		const rows = prepareRowsForDisplay(hostRows);
		const truncated = lastResultPayload && lastResultPayload.truncated;
		const hostTotal =
			typeof (lastResultPayload && lastResultPayload.totalMatched) === 'number'
				? lastResultPayload.totalMatched
				: hostRows.length;
		const searchMethod =
			typeof (lastResultPayload && lastResultPayload.searchMethod) === 'string'
				? lastResultPayload.searchMethod
				: '';
		const qActive = retrieverTrimmedSearchQuery().length > 0;
		const clientFiltered = rows.length !== hostRows.length;
		const totalMatched = clientFiltered ? rows.length : hostTotal;

		if (loadBtn) {
			loadBtn.classList.toggle('hidden', !(truncated && hostRows.length > 0));
		}

		const copyMdBtn = $('rz-copy-md');
		if (copyMdBtn) {
			copyMdBtn.disabled = !rows.length || kbMissing;
		}

		if (foot) {
			const isEmbeddingRank =
				searchMethod === 'exact' || String(searchMethod).startsWith('recommended:');
			const methodHint =
				qActive && isEmbeddingRank
					? ' · ranked by embedding (' + searchMethod + ')'
					: qActive && searchMethod && searchMethod !== 'index-browse'
						? ' · ' + searchMethod
						: '';
			const filterHint = clientFiltered
				? ' · ' + rows.length + ' after type/tag filter'
				: '';
			if (!hostRows.length) {
				if (catalogShellOnly && !kbMissing && !filtersOrSearchActive()) {
					foot.textContent =
						'KB is ready — search to rank headings from index.drip embeddings.';
				} else if (!kbMissing && headingsInCatalog > 0 && !filtersOrSearchActive()) {
					foot.textContent =
						headingsInCatalog +
						' headings indexed — no matches loaded. Try Refresh if this persists.';
				} else {
					foot.textContent = kbMissing
						? 'Choose a knowledge base folder first (DRIP Storage).'
						: 'No headings match this search / filters.';
				}
			} else if (!rows.length) {
				foot.textContent =
					'No headings left after type/tag filters (' +
					hostRows.length +
					' embedding hits hidden).';
			} else if (truncated) {
				foot.textContent = useFileHeadingGroupLayout()
					? 'Showing ' +
						rows.length +
						' of ' +
						hostTotal +
						' heading matches — file groups auto-expand while searching. Load more for additional pages.' +
						methodHint +
						filterHint
					: 'Showing ' +
						rows.length +
						' of ' +
						hostTotal +
						' matches' +
						methodHint +
						filterHint +
						'.';
			} else {
				foot.textContent = useFileHeadingGroupLayout()
					? totalMatched +
						' heading matches in file groups — click a file row to collapse.' +
						methodHint +
						filterHint
					: totalMatched === 1
						? '1 heading' + methodHint + filterHint + '.'
						: totalMatched + ' headings' + methodHint + filterHint + '.';
			}
		}

		if (!rows.length) {
			listEl.innerHTML = '';
			boardEl.innerHTML = '';
			empty.hidden = false;
			listEl.hidden = true;
			boardEl.hidden = true;
			listEl.classList.add('hidden');
			boardEl.classList.add('hidden');
			empty.classList.remove('hidden');
			const sub = empty.querySelector('p');
			if (sub) {
				if (kbMissing) {
					sub.textContent =
						'Open a folder in VS Code or use DRIP sidebar → Select Knowledge Base Folder, then Refresh.';
				} else if (hostRows.length && clientFiltered) {
					sub.textContent =
						'Embedding hits were found, but none match the selected type/tag filters. Clear filters or broaden them.';
				} else if (catalogShellOnly && !filtersOrSearchActive()) {
					sub.textContent =
						'Type in the search box to rank headings by embedding similarity (index.drip only). Closing VS Code clears the Retriever session cache.';
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
					sub.textContent =
						'Nothing matched (' +
						headingsInCatalog +
						' headings indexed). Use Clear filters or change search / type / tag picks. Metadata type chips are below the search bar.';
				} else {
					sub.textContent =
						'Indexed headings returned no rows. Click Refresh — if it keeps happening, report a DRIP bug.';
				}
			}
			return;
		}

		empty.hidden = true;
		empty.classList.add('hidden');
		const showList = viewMode === 'list';
		listEl.hidden = !showList;
		boardEl.hidden = showList;
		listEl.classList.toggle('hidden', !showList);
		boardEl.classList.toggle('hidden', showList);

		if (showList) {
			boardEl.innerHTML = '';
			listEl.innerHTML = useFileHeadingGroupLayout()
				? buildFileHeadingGroupsHtml(rows)
				: buildGroupedListParts(rows).join('');
			bindRowClicks(listEl);
			setupListRovingFocus(listEl);
		} else {
			listEl.innerHTML = '';
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
					relationTypes = Array.isArray(p.relationTypes) ? p.relationTypes : [];
					tagGraphs = Array.isArray(p.tagGraphs) ? p.tagGraphs : [];
					kbMissing = Boolean(p.kbMissing);
					headingsInCatalog = Number(p.headingsIndexed);
					headingsInCatalog = Number.isFinite(headingsInCatalog) ? headingsInCatalog : 0;
					noteFilesVisited = Number(p.noteFilesVisited);
					noteFilesVisited = Number.isFinite(noteFilesVisited) ? noteFilesVisited : 0;
					kbRootPath = typeof p.kbRootPath === 'string' ? p.kbRootPath : '';
					usedWorkspaceFallback = Boolean(p.usedWorkspaceFallback);
					catalogShellOnly = Boolean(p.shellOnly);
					applyMetadataUiColors(p.metadataColors);
					setKbBanner();
					accumulatedRows = [];
					populateTagDatalist();
					populateTagGraphSelect();
					if (!retrieverPersistHydrated) {
						applyPersistedUi(p.persistedUi);
						retrieverPersistHydrated = true;
					} else if (!p.shellOnly) {
						restorePersistedScopeCheckboxes(p.persistedUi);
					}
					pruneStalePersistedFilters();
					syncRelationTypeSelect();
					renderTypeChips();
					renderAttrFilters();
					renderSelectedTagChips();
					renderSelectedRelationTagChips();
					syncRelationTagInputEnabled();
					// One query after catalog paint — never chain catalog↔query loops here.
					runAfterNextPaint(() => scheduleQueryImmediate({ skipSuggest: true }));
					break;
				}
				case 'retrieverMetadataColors':
					applyMetadataUiColors(msg.payload || {});
					renderTypeChips();
					renderAttrFilters();
					renderSelectedTagChips();
					renderSelectedRelationTagChips();
					renderResults(lastResultPayload);
					break;
				case 'retrieverSuggestResult':
					renderSuggestDropdown(msg.payload || {});
					break;
				case 'retrieverTagSuggestResult':
					renderTagSuggestFromHost(msg.payload || {});
					break;
				case 'retrieverApplyTagGraphResult': {
					const p = msg.payload || {};
					selectedTags.clear();
					for (const t of Array.isArray(p.tags) ? p.tags : []) {
						const tag = String(t || '')
							.trim()
							.toLowerCase();
						if (tag) selectedTags.add(tag);
					}
					selectedTagGraphId = String(p.graphId || '');
					const gsel = /** @type {HTMLSelectElement | null} */ ($('rz-tag-graph'));
					if (gsel) gsel.value = selectedTagGraphId;
					hideTagSuggest();
					renderSelectedTagChips();
					renderResults(lastResultPayload);
					scheduleQueryImmediate({ skipSuggest: true });
					persistUiSoon();
					break;
				}
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
				case 'retrieverCustomPathsPicked': {
					const entries =
						msg.payload && Array.isArray(msg.payload.entries) ? msg.payload.entries : [];
					if (!customCorpusEditorOpen) openCustomCorpusEditor();
					mergePickedCustomEntries(entries);
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
			hideSuggestPanel();
			postRetrieverOpenFromEl(b);
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

	/** @type {{ uri: string, line: string, rel: string, fileId?: string, title?: string, headingId?: string } | null} */
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
				rel: row.getAttribute('data-rel') || '',
				fileId: row.getAttribute('data-fileid') || '',
				title: row.getAttribute('data-title') || '',
				headingId: row.getAttribute('data-headingid') || '0'
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
				vscode.postMessage({
					type: 'retrieverOpen',
					uri: ctxPinned.uri,
					line: lineNum,
					title: ctxPinned.title || '',
					headingId: Number(ctxPinned.headingId) || 0
				});
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

	(function wireScopeRadios() {
		const f = /** @type {HTMLInputElement | null} */ ($('rz-scope-files'));
		const h = /** @type {HTMLInputElement | null} */ ($('rz-scope-headings'));
		if (!f || !h) return;
		const onChange = () => {
			syncGroupByForScope();
			expandedFileGroupPaths.clear();
			fileGroupKnownPaths.clear();
			fileGroupExpandSessionKey = '';
			persistUiSoon();
			scheduleQueryImmediate();
		};
		f.addEventListener('change', onChange);
		h.addEventListener('change', onChange);
		syncGroupByForScope();
	})();

	(function wireCorpusSelect() {
		const c = /** @type {HTMLSelectElement | null} */ ($('rz-corpus'));
		if (!c) return;
		lastCorpusValue = String(c.value || 'working');
		c.addEventListener('change', () => {
			const prev = lastCorpusValue;
			const v = String(c.value || 'working');
			expandedFileGroupPaths.clear();
			fileGroupKnownPaths.clear();
			fileGroupExpandSessionKey = '';
			if (v === 'custom') {
				openCustomCorpusEditor(prev);
				return;
			}
			lastCorpusValue = v;
			customCorpusPaths = [];
			customCorpusDraft = null;
			syncCustomCorpusEditBtn();
			persistUiSoon();
			scheduleQueryImmediate({ skipSuggest: true });
		});
	})();

	(function wireCustomCorpusEditor() {
		const editBtn = $('rz-corpus-edit');
		if (editBtn) {
			editBtn.addEventListener('click', () => openCustomCorpusEditor('custom'));
		}
		const drop = $('rz-custom-drop');
		if (drop) {
			drop.addEventListener('dragover', e => {
				e.preventDefault();
				drop.classList.add('is-dragover');
			});
			drop.addEventListener('dragleave', () => drop.classList.remove('is-dragover'));
			drop.addEventListener('drop', e => {
				e.preventDefault();
				drop.classList.remove('is-dragover');
				const dt = e.dataTransfer;
				/** @type {string[]} */
				const uris = [];
				if (dt) {
					const uriList =
						dt.getData('text/uri-list') ||
						dt.getData('application/vnd.code.uri-list') ||
						'';
					for (const line of String(uriList).split(/\r?\n/)) {
						const t = line.trim();
						if (t && !t.startsWith('#')) uris.push(t);
					}
					if (!uris.length) {
						const plain = String(dt.getData('text/plain') || dt.getData('text') || '').trim();
						if (plain) {
							for (const line of plain.split(/\r?\n/)) {
								const t = line.trim();
								if (t && !t.startsWith('#')) uris.push(t);
							}
						}
					}
					if (!uris.length && dt.files && dt.files.length) {
						for (const f of dt.files) {
							const fp = /** @type {{ path?: string }} */ (f).path;
							if (fp) {
								const norm = String(fp).replace(/\\/g, '/');
								uris.push(/^[a-zA-Z]:\//.test(norm) ? 'file:///' + norm : 'file://' + norm);
							}
						}
					}
				}
				if (uris.length) {
					vscode.postMessage({ type: 'retrieverResolveDroppedPaths', payload: { uris } });
				}
			});
		}
		const addBtn = $('rz-custom-add');
		if (addBtn) {
			addBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'retrieverPickCustomPaths', payload: { mode: 'both' } });
			});
		}
		const entriesHost = $('rz-custom-entries');
		if (entriesHost) {
			entriesHost.addEventListener('click', e => {
				const t = /** @type {HTMLElement} */ (e.target);
				const btn = t && t.closest ? t.closest('.rz-custom-entry-remove') : null;
				if (!btn || !Array.isArray(customCorpusDraft)) return;
				const idx = Number(btn.getAttribute('data-idx'));
				if (!Number.isFinite(idx)) return;
				customCorpusDraft.splice(idx, 1);
				renderCustomCorpusEntries();
			});
		}
		const done = $('rz-custom-done');
		if (done) done.addEventListener('click', finishCustomCorpusDone);
		const cancel = $('rz-custom-cancel');
		if (cancel) cancel.addEventListener('click', cancelCustomCorpusEditor);
	})();

	/** Expand/collapse file bucket (must not depend on `list.hidden` — Electron/webview can disagree with hit-testing). */
	function toggleFileGroupFromHeader(/** @type {Element} */ hdr) {
		const rel = relFromFileGroupDataAttr(hdr.getAttribute('data-file-rel'));
		if (!rel) return;
		if (expandedFileGroupPaths.has(rel)) expandedFileGroupPaths.delete(rel);
		else expandedFileGroupPaths.add(rel);
		renderResults(lastResultPayload);
	}

	function toggleGroupedSectionFromHeader(/** @type {Element} */ hdr) {
		const key = String(hdr.getAttribute('data-group-key') || '');
		if (!key) return;
		if (expandedGroupKeys.has(key)) expandedGroupKeys.delete(key);
		else expandedGroupKeys.add(key);
		renderResults(lastResultPayload);
	}

	const rzListFileToggle = $('rz-list');
	if (rzListFileToggle && rzListFileToggle.dataset.rzFileGroupDelegation !== '1') {
		rzListFileToggle.dataset.rzFileGroupDelegation = '1';
		rzListFileToggle.addEventListener('click', e => {
			const el = elementFromPointerEvent(e);
			const groupToggle = el && el.closest ? el.closest('.rz-group-toggle') : null;
			if (groupToggle && rzListFileToggle.contains(groupToggle)) {
				e.preventDefault();
				e.stopPropagation();
				toggleGroupedSectionFromHeader(groupToggle);
				return;
			}
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
			renderAttrFilters();
			renderResults(lastResultPayload);
			scheduleQueryImmediate();
			persistUiSoon();
		});
	}

	const attrPanel = $('rz-attr-filter-panel');
	if (attrPanel) {
		attrPanel.addEventListener('click', onAttrFilterPanelClick);
		attrPanel.addEventListener('change', onAttrFilterPanelChange);
		attrPanel.addEventListener('input', onAttrFilterPanelChange);
	}

	const clearAttrBtn = $('rz-clear-attr-filters');
	if (clearAttrBtn) {
		clearAttrBtn.addEventListener('click', () => {
			clearMetadataAttrFiltersOnly();
		});
	}

	document.addEventListener('click', e => {
		const t = e && e.target;
		if (t && t.closest && t.closest('.rz-attr-box-wrap')) return;
		closeAllAttrMenus(null);
	});

	const tagInput = $('rz-tag-input');
	if (tagInput) {
		tagInput.addEventListener('input', () => {
			scheduleTagSuggest(tagInput.value);
		});
		tagInput.addEventListener('focus', () => {
			scheduleTagSuggest(tagInput.value);
		});
		tagInput.addEventListener('blur', () => {
			setTimeout(() => hideTagSuggest(), 180);
		});
		tagInput.addEventListener('keydown', e => {
			if (e.key === 'Escape') {
				hideTagSuggest();
				return;
			}
			if (e.key !== 'Enter') return;
			e.preventDefault();
			addSelectedTag(tagInput.value);
		});
	}

	const tagGraphSel = $('rz-tag-graph');
	if (tagGraphSel) {
		tagGraphSel.addEventListener('change', () => {
			selectedTagGraphId = String(tagGraphSel.value || '');
			vscode.postMessage({
				type: 'retrieverApplyTagGraph',
				payload: { graphId: selectedTagGraphId }
			});
		});
	}

	const tagSuggestBox = $('rz-tag-suggest');
	if (tagSuggestBox) {
		tagSuggestBox.addEventListener('mousedown', e => {
			const b = e.target && e.target.closest && e.target.closest('.rz-tag-suggest-item');
			if (b) e.preventDefault();
		});
		tagSuggestBox.addEventListener('click', e => {
			const b = e.target && e.target.closest && e.target.closest('.rz-tag-suggest-item');
			if (!b) return;
			addSelectedTag(b.getAttribute('data-tag'));
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
			renderResults(lastResultPayload);
			scheduleQueryImmediate({ skipSuggest: true });
			persistUiSoon();
		});
	}

	const relationTypeSel = $('rz-relation-type');
	if (relationTypeSel) {
		relationTypeSel.addEventListener('change', () => {
			selectedRelationType = String(relationTypeSel.value || '')
				.trim()
				.toLowerCase();
			if (selectedRelationType === 'tags') selectedRelationType = '';
			// Keep other relation types' tags; only switch which type new tags apply to.
			renderSelectedRelationTagChips();
			syncRelationTagInputEnabled();
			hideRelTagSuggest();
			persistUiSoon();
		});
	}

	const relTagInput = $('rz-rel-tag-input');
	if (relTagInput) {
		relTagInput.addEventListener('input', () => {
			scheduleRelTagSuggest(relTagInput.value);
		});
		relTagInput.addEventListener('focus', () => {
			scheduleRelTagSuggest(relTagInput.value);
		});
		relTagInput.addEventListener('blur', () => {
			setTimeout(() => hideRelTagSuggest(), 180);
		});
		relTagInput.addEventListener('keydown', e => {
			if (e.key === 'Escape') {
				hideRelTagSuggest();
				return;
			}
			if (e.key !== 'Enter') return;
			e.preventDefault();
			addSelectedRelationTag(relTagInput.value);
		});
	}

	const relTagSuggestBox = $('rz-rel-tag-suggest');
	if (relTagSuggestBox) {
		relTagSuggestBox.addEventListener('mousedown', e => {
			const b = e.target && e.target.closest && e.target.closest('.rz-tag-suggest-item');
			if (b) e.preventDefault();
		});
		relTagSuggestBox.addEventListener('click', e => {
			const b = e.target && e.target.closest && e.target.closest('.rz-tag-suggest-item');
			if (!b) return;
			addSelectedRelationTag(b.getAttribute('data-tag'));
		});
	}

	const relTagChipsHost = $('rz-rel-tag-chips');
	if (relTagChipsHost) {
		relTagChipsHost.addEventListener('click', e => {
			const rm = e.target && e.target.closest && e.target.closest('.rz-chip-remove');
			const wrap = rm && rm.closest('.rz-chip-tag');
			const tag = wrap && wrap.dataset && wrap.dataset.tag;
			const relType = wrap && wrap.dataset && wrap.dataset.relType;
			if (!tag || !relType) return;
			const set = selectedRelations.get(relType);
			if (set) {
				set.delete(tag);
				if (!set.size) selectedRelations.delete(relType);
			}
			renderSelectedRelationTagChips();
			renderResults(lastResultPayload);
			scheduleQueryImmediate({ skipSuggest: true });
			persistUiSoon();
		});
	}

	function wireSelect(id, field, needsServerRoundTrip) {
		const el = $(id);
		if (!el) return;
		el.addEventListener('change', () => {
			const v = el.value;
			if (field === 'view') viewMode = v;
			else if (field === 'group') {
				groupBy = v === 'folder' || v === 'file' || v === 'type' ? v : 'none';
				expandedGroupKeys.clear();
			} else if (field === 'searchEngine') {
				searchEngine =
					v === 'semantic' || v === 'word' ? v : 'recommended';
			}
			if (needsServerRoundTrip) scheduleQueryImmediate({ skipSuggest: true });
			else renderResults(lastResultPayload);
			persistUiSoon();
		});
	}

	wireSelect('rz-view-mode', 'view', false);
	// Group is display-only over the current page.
	wireSelect('rz-group-by', 'group', false);
	wireSelect('rz-search-engine', 'searchEngine', true);

	['rz-show-bc', 'rz-show-path', 'rz-show-type', 'rz-show-tags', 'rz-show-relations'].forEach(id => {
		const el = $(id);
		if (!el) return;
		el.addEventListener('change', () => {
			showBreadcrumbs = !!( $('rz-show-bc') && $('rz-show-bc').checked );
			showPathLine = !!( $('rz-show-path') && $('rz-show-path').checked );
			showTypeStrip = !!( $('rz-show-type') && $('rz-show-type').checked );
			showRowTags = !!( $('rz-show-tags') && $('rz-show-tags').checked );
			showRowRelations = !!( $('rz-show-relations') && $('rz-show-relations').checked );
			renderResults(lastResultPayload);
			persistUiSoon();
		});
	});

	vscode.postMessage({ type: 'retrieverPanelReady' });
})();
