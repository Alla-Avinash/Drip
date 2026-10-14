(function () {
	const vscode = acquireVsCodeApi();

	const emptyEl = document.getElementById('hf-empty');
	const formEl = document.getElementById('hf-form');
	const titleEl = document.getElementById('hf-title');
	const typeEl = document.getElementById('hf-type');
	const attrsEl = document.getElementById('hf-attrs');
	const tagsPickerHost = document.getElementById('hf-tags-picker');
	const relationsEl = document.getElementById('hf-relations');
	const addRelBtn = document.getElementById('hf-add-rel');
	const copyIdBtn = document.getElementById('hf-copy-id');
	const deleteBtn = document.getElementById('hf-delete');
	const issueIdEl = document.getElementById('hf-issue-id');

	/** @type {any} */
	let lastPayload = null;
	/** @type {any[]} */
	let typeDefs = [];
	/** @type {string[]} */
	let relationNames = [];
	/** @type {string[]} */
	let knownTags = [];
	let filling = false;
	/** @type {ReturnType<typeof setTimeout> | null} */
	let saveTimer = null;
	let lastSavedSig = '';
	/** @type {{ getTags: () => string[], setTags: (t: string[]) => void } | null} */
	let tagsPicker = null;

	function contentSig(model) {
		return JSON.stringify({
			typeId: model && model.typeId ? model.typeId : null,
			titleDisplay: model && model.titleDisplay ? model.titleDisplay : '',
			attributes: (model && model.attributes) || {},
			tags: (model && model.tags) || [],
			relations: (model && model.relations) || [],
			special: (model && model.special) || {}
		});
	}

	function copyableId(payload) {
		const raw = String((payload && payload.identityText) || '');
		const m = raw.match(/@f\d+:h\d+/i);
		return m ? m[0] : '';
	}

	function setEmpty() {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		lastPayload = null;
		lastSavedSig = '';
		formEl.hidden = true;
		emptyEl.hidden = true;
		emptyEl.textContent = '';
		if (copyIdBtn) copyIdBtn.disabled = true;
	}

	function currentTypeDef() {
		const id = String(typeEl.value || '').toLowerCase();
		return typeDefs.find(t => String(t.id || '').toLowerCase() === id) || null;
	}

	/** Shortcut written into the heading for the selected type (e.g. `.c`, or `.i-34` for issues). */
	function shortcutPrefixForTypeId(typeId) {
		const id = String(typeId || '').trim().toLowerCase();
		if (!id) return '.';
		if (id === 'issue' && lastPayload) {
			const existing = String(lastPayload.typePrefix || '').trim();
			if (/^\.i-\d+$/i.test(existing)) return existing;
			const ikey = String(lastPayload.issueEntityId || '').trim();
			if (/^i-\d+$/i.test(ikey)) return `.${ikey}`;
		}
		const t = typeDefs.find(x => String(x.id || '').toLowerCase() === id);
		if (!t) return `.${id}`;
		const sc = String(t.shortcut || '').trim();
		if (sc) return sc.startsWith('.') ? sc : `.${sc}`;
		const marker = String(t.marker || '').trim();
		return marker || `.${id}`;
	}

	function renderTypeOptions(selectedId, typeLocked) {
		typeEl.innerHTML = '';
		if (!typeLocked) {
			const none = document.createElement('option');
			none.value = '';
			none.textContent = '—';
			typeEl.appendChild(none);
		}
		for (const t of typeDefs) {
			const opt = document.createElement('option');
			opt.value = String(t.id || '');
			const sc = String(t.shortcut || '').trim();
			const label = sc ? `${t.id} (${sc.startsWith('.') ? sc : '.' + sc})` : String(t.id || '');
			opt.textContent = label;
			typeEl.appendChild(opt);
		}
		typeEl.value = selectedId ? String(selectedId) : '';
		typeEl.disabled = !!typeLocked;
		typeEl.title = typeLocked
			? 'Special type is fixed for this project/feature index note'
			: 'Metadata type';
	}

	function scheduleSave() {
		if (filling || !lastPayload) return;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			saveTimer = null;
			saveIfChanged();
		}, 500);
	}

	function saveIfChanged() {
		if (!lastPayload) return;
		const model = collectModel();
		const sig = contentSig(model);
		if (sig === lastSavedSig) return;
		lastSavedSig = sig;
		vscode.postMessage({ type: 'headingFormAutosave', model });
	}

	function wireSave(el) {
		if (!el) return;
		el.addEventListener('input', scheduleSave);
		el.addEventListener('change', scheduleSave);
	}

	function parseTagList(raw) {
		return String(raw || '')
			.split(',')
			.map(x => x.trim())
			.filter(Boolean);
	}

	/**
	 * Comma-separated tags with editor-like intellisense:
	 * suggestions only while typing the current token (prefix match), not a dump of all tags on focus.
	 * @param {HTMLElement} host
	 * @param {string[]} initial
	 * @param {{ onChange?: () => void, placeholder?: string }} [opts]
	 */
	function createTagPicker(host, initial, opts) {
		host.innerHTML = '';
		host.classList.add('hf-tag-picker');
		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'hf-tag-search';
		input.placeholder = (opts && opts.placeholder) || 'tag1, tag2';
		input.setAttribute('autocomplete', 'off');
		input.value = (initial || []).join(', ');
		const dd = document.createElement('div');
		dd.className = 'hf-dd';
		host.appendChild(input);
		host.appendChild(dd);

		let activeIdx = -1;

		function currentTokenInfo() {
			const val = String(input.value || '');
			const caret = typeof input.selectionStart === 'number' ? input.selectionStart : val.length;
			const before = val.slice(0, caret);
			const lastComma = before.lastIndexOf(',');
			const tokenStart = lastComma < 0 ? 0 : lastComma + 1;
			const lead = before.slice(tokenStart).match(/^\s*/)[0].length;
			const fragStart = tokenStart + lead;
			const fragment = before.slice(fragStart);
			return { fragment, fragStart, caret };
		}

		function filteredSuggestions() {
			const { fragment } = currentTokenInfo();
			const fragLower = fragment.toLowerCase();
			// Editor-like: only open suggestions after the user starts typing a token.
			if (!fragLower) return [];
			const selected = new Set(parseTagList(input.value).map(t => t.toLowerCase()));
			return knownTags
				.filter(t => {
					const low = String(t || '')
						.trim()
						.toLowerCase();
					if (!low || selected.has(low)) return false;
					return low.startsWith(fragLower);
				})
				.slice(0, 30);
		}

		function closeDd() {
			dd.classList.remove('open');
			dd.innerHTML = '';
			activeIdx = -1;
		}

		function openDd() {
			const items = filteredSuggestions();
			dd.innerHTML = '';
			if (!items.length) {
				closeDd();
				return;
			}
			items.forEach((t, i) => {
				const item = document.createElement('div');
				item.className = 'hf-dd-item' + (i === activeIdx ? ' active' : '');
				item.textContent = t;
				item.addEventListener('mousedown', e => {
					e.preventDefault();
					applySuggestion(t);
				});
				dd.appendChild(item);
			});
			dd.classList.add('open');
		}

		function applySuggestion(label) {
			const val = String(input.value || '');
			const { fragStart, caret } = currentTokenInfo();
			const after = val.slice(caret);
			const afterRest = after.replace(/^[^\s,]*/, '');
			const next = val.slice(0, fragStart) + label + afterRest;
			input.value = next;
			const pos = fragStart + label.length;
			input.setSelectionRange(pos, pos);
			closeDd();
			if (opts && opts.onChange) opts.onChange();
		}

		input.addEventListener('input', () => {
			activeIdx = 0;
			openDd();
			if (opts && opts.onChange) opts.onChange();
		});
		input.addEventListener('keydown', e => {
			const items = filteredSuggestions();
			if (e.key === 'ArrowDown' && items.length) {
				e.preventDefault();
				activeIdx = Math.min(items.length - 1, activeIdx < 0 ? 0 : activeIdx + 1);
				openDd();
			} else if (e.key === 'ArrowUp' && items.length) {
				e.preventDefault();
				activeIdx = Math.max(0, activeIdx - 1);
				openDd();
			} else if (e.key === 'Enter' && dd.classList.contains('open') && activeIdx >= 0 && items[activeIdx]) {
				e.preventDefault();
				applySuggestion(items[activeIdx]);
			} else if (e.key === 'Escape') {
				closeDd();
			}
		});
		input.addEventListener('blur', () => setTimeout(closeDd, 120));

		return {
			getTags: () => parseTagList(input.value),
			setTags: next => {
				input.value = (next || []).join(', ');
			}
		};
	}

	function renderAttrs(attrs) {
		attrsEl.innerHTML = '';
		const def = currentTypeDef();
		const keys = def && def.attributes ? Object.keys(def.attributes) : Object.keys(attrs || {});
		for (const key of keys) {
			const rule = def && def.attributes ? def.attributes[key] : null;
			if (rule && rule.kind === 'issue_parent' && issueParentInfo().locked) continue;
			const row = document.createElement('div');
			row.className = 'hf-row';
			const span = document.createElement('span');
			span.className = 'hf-key';
			span.textContent = (rule && rule.label) || key;
			const valWrap = document.createElement('div');
			valWrap.className = 'hf-val';
			const kind = rule && rule.kind ? rule.kind : 'enum';
			const val = attrs && attrs[key] != null ? String(attrs[key]) : '';
			if (kind === 'issue_parent') {
				renderIssueParentField(key, val, valWrap);
			} else if (kind === 'enum' && rule && Array.isArray(rule.values) && rule.values.length) {
				const sel = document.createElement('select');
				sel.dataset.key = key;
				const empty = document.createElement('option');
				empty.value = '';
				empty.textContent = '—';
				sel.appendChild(empty);
				for (const v of rule.values) {
					const o = document.createElement('option');
					o.value = String(v);
					o.textContent = String(v);
					sel.appendChild(o);
				}
				sel.value = val;
				wireSave(sel);
				valWrap.appendChild(sel);
			} else {
				const input = document.createElement('input');
				input.type = 'text';
				input.dataset.key = key;
				if (kind === 'datetime') input.dataset.kind = 'datetime';
				input.value = val;
				input.placeholder =
					(rule && rule.placeholder) ||
					(kind === 'datetime'
						? 'YYYY-MM-DD HH:mm or "2 days"'
						: kind === 'duration'
							? 'e.g. 2h'
							: kind === 'issue_parent'
								? 'i-N'
								: '');
				wireSave(input);
				if (kind === 'datetime') {
					input.addEventListener('blur', () => requestDatetimeNormalize(input));
					input.addEventListener('keydown', e => {
						if (e.key === 'Enter') input.blur();
					});
				}
				valWrap.appendChild(input);
			}
			row.appendChild(span);
			row.appendChild(valWrap);
			attrsEl.appendChild(row);
		}
	}

	/**
	 * Ask the extension to normalize a relative datetime ("2 days") into "YYYY-MM-DD HH:mm".
	 * Already-normalized absolute values are left alone (no round-trip churn).
	 * @param {HTMLInputElement} input
	 */
	function requestDatetimeNormalize(input) {
		const raw = String(input.value || '').trim();
		if (!raw || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)) return;
		const key = input.getAttribute('data-key');
		if (!key) return;
		vscode.postMessage({ type: 'headingFormNormalizeDatetime', key, value: raw });
	}

	/** `I-04` → `i-4`; returns '' for empty, null for malformed. */
	function normalizeIssueKey(raw) {
		const s = String(raw || '').trim();
		if (!s) return '';
		const m = s.match(/^i-(\d+)$/i);
		return m ? `i-${parseInt(m[1], 10)}` : null;
	}

	function issueParentInfo() {
		const ip = lastPayload && lastPayload.issueParent;
		return {
			locked: !!(ip && ip.locked),
			lockedParent: (ip && ip.lockedParent) || '',
			options: ip && Array.isArray(ip.options) ? ip.options : []
		};
	}

	function describeIssueOption(key) {
		const opt = issueParentInfo().options.find(o => o.key === key);
		if (!opt) return '';
		return opt.where ? `${opt.title || key} — ${opt.where}` : String(opt.title || key);
	}

	/**
	 * Optional parent issue field (only shown when the issue is not nested under another issue
	 * in this file): any project issue except self / own sub-issues. Invalid input is never saved.
	 */
	function renderIssueParentField(key, val, valWrap) {
		const info = issueParentInfo();
		const input = document.createElement('input');
		input.type = 'text';
		input.dataset.key = key;
		input.dataset.issueParent = '1';
		input.autocomplete = 'off';
		input.spellcheck = false;
		const hint = document.createElement('div');
		hint.className = 'hf-hint';
		// Custom dropdown: native <datalist> popups are mispositioned inside VS Code webviews.
		const anchor = document.createElement('div');
		anchor.className = 'hf-issue-parent';
		const dd = document.createElement('div');
		dd.className = 'hf-dd';
		let activeIdx = -1;

		const filtered = () => {
			const q = String(input.value || '').trim().toLowerCase();
			if (!q) return info.options;
			return info.options.filter(o =>
				[o.key, o.title, o.where].some(s => String(s || '').toLowerCase().includes(q))
			);
		};
		const closeDd = () => {
			dd.classList.remove('open');
			dd.innerHTML = '';
			activeIdx = -1;
		};
		const openDd = () => {
			const items = filtered();
			dd.innerHTML = '';
			if (!items.length) {
				closeDd();
				return;
			}
			if (activeIdx >= items.length) activeIdx = items.length - 1;
			items.forEach((o, i) => {
				const item = document.createElement('div');
				item.className = 'hf-dd-item hf-issue-opt' + (i === activeIdx ? ' active' : '');
				const k = document.createElement('span');
				k.className = 'hf-issue-opt-key';
				k.textContent = o.key;
				const t = document.createElement('span');
				t.className = 'hf-issue-opt-title';
				t.textContent = o.title || '';
				item.appendChild(k);
				item.appendChild(t);
				if (o.where) {
					const w = document.createElement('span');
					w.className = 'hf-issue-opt-where';
					w.textContent = o.where;
					item.appendChild(w);
				}
				item.addEventListener('mousedown', e => {
					e.preventDefault();
					pick(o.key);
				});
				dd.appendChild(item);
			});
			dd.classList.add('open');
			const act = dd.querySelector('.hf-dd-item.active');
			if (act && typeof act.scrollIntoView === 'function') act.scrollIntoView({ block: 'nearest' });
		};
		const pick = key => {
			input.value = key;
			closeDd();
			onEdit();
		};

		input.addEventListener('focus', () => {
			activeIdx = -1;
			openDd();
		});
		input.addEventListener('blur', () => setTimeout(closeDd, 120));
		input.addEventListener('keydown', e => {
			const items = filtered();
			if (e.key === 'ArrowDown' && items.length) {
				e.preventDefault();
				activeIdx = Math.min(items.length - 1, activeIdx + 1);
				openDd();
			} else if (e.key === 'ArrowUp' && items.length) {
				e.preventDefault();
				activeIdx = Math.max(0, activeIdx - 1);
				openDd();
			} else if (e.key === 'Enter' && dd.classList.contains('open') && items[activeIdx]) {
				e.preventDefault();
				pick(items[activeIdx].key);
			} else if (e.key === 'Escape') {
				closeDd();
			}
		});
		input.placeholder = info.options.length
			? 'Optional — i-N from this project'
			: 'No other issues in this project';

		const initial = normalizeIssueKey(val) || '';
		input.value = initial;
		input.dataset.lastValid = initial;

		const validate = () => {
			const norm = normalizeIssueKey(input.value);
			const allowed = norm === '' || (norm && info.options.some(o => o.key === norm));
			if (allowed) {
				input.classList.remove('hf-invalid');
				input.dataset.invalid = '';
				input.dataset.lastValid = norm;
				hint.classList.remove('hf-hint-error');
				hint.textContent = norm ? describeIssueOption(norm) : '';
				return true;
			}
			input.classList.add('hf-invalid');
			input.dataset.invalid = '1';
			hint.classList.add('hf-hint-error');
			hint.textContent =
				norm === null
					? 'Use an issue id like i-12.'
					: `${norm} can't be the parent. Pick another issue in this project (not this issue or one of its sub-issues).`;
			return false;
		};
		hint.textContent = initial ? describeIssueOption(initial) : '';
		function onEdit() {
			if (validate()) scheduleSave();
		}
		input.addEventListener('input', () => {
			activeIdx = 0;
			openDd();
			onEdit();
		});
		input.addEventListener('change', onEdit);
		anchor.appendChild(input);
		anchor.appendChild(dd);
		valWrap.appendChild(anchor);
		valWrap.appendChild(hint);
	}

	function readAttrs() {
		/** @type {Record<string, string>} */
		const out = {};
		attrsEl.querySelectorAll('[data-key]').forEach(el => {
			const key = el.getAttribute('data-key');
			if (!key) return;
			const input = /** @type {HTMLInputElement|HTMLSelectElement} */ (el);
			if (input.dataset.issueParent === '1') {
				out[key] =
					input.dataset.invalid === '1'
						? String(input.dataset.lastValid || '')
						: normalizeIssueKey(input.value) || '';
				return;
			}
			out[key] = String(input.value || '').trim();
		});
		return out;
	}

	function renderRelations(rels) {
		relationsEl.innerHTML = '';
		const list = Array.isArray(rels) ? rels : [];
		for (const r of list) addRelationRow(r && r.type, r && r.tags, true);
		refreshRelationTypeOptions();
		updateAddRelationButton();
	}

	/** Relation types already chosen on other rows (lowercase). */
	function usedRelationTypes(exceptSel) {
		/** @type {Set<string>} */
		const used = new Set();
		relationsEl.querySelectorAll('.hf-rel-type').forEach(el => {
			if (exceptSel && el === exceptSel) return;
			const v = String(/** @type {HTMLSelectElement} */ (el).value || '')
				.trim()
				.toLowerCase();
			if (v && v !== 'tags') used.add(v);
		});
		return used;
	}

	function availableRelationNames(exceptSel, keepType) {
		const used = usedRelationTypes(exceptSel);
		const keep = String(keepType || '')
			.trim()
			.toLowerCase();
		return relationNames.filter(name => {
			const low = String(name).toLowerCase();
			if (low === 'tags') return false;
			if (keep && low === keep) return true;
			return !used.has(low);
		});
	}

	function refreshRelationTypeOptions() {
		relationsEl.querySelectorAll('.hf-rel-inline').forEach(row => {
			const sel = /** @type {HTMLSelectElement | null} */ (row.querySelector('.hf-rel-type'));
			if (!sel) return;
			const current = String(sel.value || '').trim();
			const names = availableRelationNames(sel, current);
			sel.innerHTML = '';
			for (const name of names) {
				const o = document.createElement('option');
				o.value = name;
				o.textContent = name;
				sel.appendChild(o);
			}
			if (!sel.options.length && current) {
				const o = document.createElement('option');
				o.value = current;
				o.textContent = current;
				sel.appendChild(o);
			}
			if (current && [...sel.options].some(o => o.value === current)) {
				sel.value = current;
			} else if (sel.options.length) {
				sel.value = sel.options[0].value;
			}
		});
		updateAddRelationButton();
	}

	function updateAddRelationButton() {
		if (!addRelBtn) return;
		const used = usedRelationTypes(null);
		const remaining = relationNames.filter(n => {
			const low = String(n).toLowerCase();
			return low !== 'tags' && !used.has(low);
		});
		addRelBtn.disabled = remaining.length === 0;
		addRelBtn.style.opacity = remaining.length === 0 ? '0.45' : '';
		addRelBtn.title =
			remaining.length === 0 ? 'All relation types are already added' : 'Add relation';
	}

	function addRelationRow(type, tags, fromFill) {
		const preferred = String(type || '').trim();
		const names = availableRelationNames(null, fromFill ? preferred : '');
		if (!fromFill && !names.length) {
			updateAddRelationButton();
			return;
		}

		const row = document.createElement('div');
		row.className = 'hf-rel-inline';

		const sel = document.createElement('select');
		sel.className = 'hf-rel-type';
		const optionNames =
			names.length > 0
				? names
				: preferred
					? [preferred]
					: relationNames.filter(n => String(n).toLowerCase() !== 'tags');
		for (const name of optionNames) {
			const o = document.createElement('option');
			o.value = name;
			o.textContent = name;
			sel.appendChild(o);
		}
		if (!sel.options.length) {
			const o = document.createElement('option');
			o.value = 'pre-req';
			o.textContent = 'pre-req';
			sel.appendChild(o);
		}
		sel.value =
			preferred && [...sel.options].some(o => o.value === preferred)
				? preferred
				: sel.options[0].value;
		sel.addEventListener('change', () => {
			refreshRelationTypeOptions();
			scheduleSave();
		});

		const colon = document.createElement('span');
		colon.className = 'hf-rel-colon';
		colon.textContent = ':';

		const pickerHost = document.createElement('div');
		pickerHost.className = 'hf-rel-tags-host';

		const rm = document.createElement('button');
		rm.type = 'button';
		rm.className = 'hf-remove';
		rm.textContent = '×';
		rm.title = 'Remove relation';
		rm.addEventListener('click', () => {
			row.remove();
			refreshRelationTypeOptions();
			scheduleSave();
		});

		row.appendChild(sel);
		row.appendChild(colon);
		row.appendChild(pickerHost);
		row.appendChild(rm);
		relationsEl.appendChild(row);

		const picker = createTagPicker(pickerHost, Array.isArray(tags) ? tags : [], {
			onChange: scheduleSave,
			placeholder: 'tag1, tag2'
		});
		row._tagPicker = picker;

		refreshRelationTypeOptions();
		if (!fromFill && !filling) scheduleSave();
	}

	function readRelations() {
		/** @type {{ type: string, tags: string[] }[]} */
		const out = [];
		relationsEl.querySelectorAll('.hf-rel-inline').forEach(row => {
			const type = String((row.querySelector('.hf-rel-type') || {}).value || '').trim();
			const picker = row._tagPicker;
			const tags = picker && typeof picker.getTags === 'function' ? picker.getTags() : [];
			if (type && tags.length) out.push({ type, tags });
		});
		return out;
	}

	function fillForm(payload) {
		filling = true;
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		lastPayload = payload;
		typeDefs = Array.isArray(payload.types) ? payload.types : [];
		relationNames = Array.isArray(payload.relationNames) ? payload.relationNames : ['pre-req'];
		knownTags = Array.isArray(payload.knownTags) ? payload.knownTags.slice() : [];
		emptyEl.hidden = true;
		formEl.hidden = false;
		titleEl.value = String(payload.titleDisplay || '');
		renderTypeOptions(payload.typeId || '', !!payload.typeLocked);
		renderAttrs(payload.attributes || {});
		tagsPicker = createTagPicker(tagsPickerHost, Array.isArray(payload.tags) ? payload.tags : [], {
			onChange: scheduleSave,
			placeholder: 'tag1, tag2'
		});
		renderRelations(payload.relations || []);
		const id = copyableId(payload);
		if (copyIdBtn) {
			copyIdBtn.disabled = !id;
			copyIdBtn.title = id ? `Copy ${id}` : 'No identity yet';
		}
		// Issue id lives in the heading type prefix (`.i-34`), not a separate RHS badge.
		if (issueIdEl) {
			issueIdEl.hidden = true;
			issueIdEl.textContent = '';
		}
		filling = false;
		lastSavedSig = contentSig(collectModel());
	}

	function collectModel() {
		const typeId = String(typeEl.value || '').trim() || null;
		const tags = tagsPicker && typeof tagsPicker.getTags === 'function' ? tagsPicker.getTags() : [];
		const typePrefix = shortcutPrefixForTypeId(typeId);
		if (lastPayload) lastPayload.typePrefix = typePrefix;
		return {
			documentUri: lastPayload && lastPayload.documentUri,
			headingLine: lastPayload && lastPayload.headingLine,
			lockStart: lastPayload && lastPayload.lockStart,
			lockEndExclusive: lastPayload && lastPayload.lockEndExclusive,
			identityLine: lastPayload && lastPayload.identityLine,
			tabDepth: lastPayload && lastPayload.tabDepth,
			typePrefix,
			level:
				lastPayload && Number.isFinite(Number(lastPayload.level))
					? Number(lastPayload.level)
					: 0,
			typeId,
			titleDisplay: String(titleEl.value || '').trim(),
			issueEntityId: lastPayload && lastPayload.issueEntityId,
			attributes: readAttrs(),
			tags,
			relations: readRelations(),
			special: (lastPayload && lastPayload.special) || {}
		};
	}

	wireSave(titleEl);
	wireSave(typeEl);

	typeEl.addEventListener('change', () => {
		if (filling) return;
		const typeId = String(typeEl.value || '').trim() || null;
		if (lastPayload) {
			lastPayload.typeId = typeId;
			lastPayload.typePrefix = shortcutPrefixForTypeId(typeId);
		}
		renderAttrs(readAttrs());
		scheduleSave();
	});
	addRelBtn.addEventListener('click', () => addRelationRow('', [], false));

	if (copyIdBtn) {
		copyIdBtn.addEventListener('click', () => {
			const id = copyableId(lastPayload);
			if (!id) return;
			vscode.postMessage({ type: 'headingFormCopyId', id });
		});
	}

	if (deleteBtn) {
		deleteBtn.addEventListener('click', () => {
			if (!lastPayload) return;
			if (saveTimer) {
				clearTimeout(saveTimer);
				saveTimer = null;
			}
			vscode.postMessage({
				type: 'headingFormDelete',
				model: {
					documentUri: lastPayload.documentUri,
					lockStart: lastPayload.lockStart,
					lockEndExclusive: lastPayload.lockEndExclusive,
					headingLine: lastPayload.headingLine
				}
			});
		});
	}

	window.addEventListener('message', event => {
		const msg = event.data || {};
		if (msg.type === 'headingFormClear') {
			setEmpty();
			return;
		}
		if (msg.type === 'headingFormLoad') {
			fillForm(msg.payload || {});
			return;
		}
		if (msg.type === 'headingFormFlush') {
			if (saveTimer) {
				clearTimeout(saveTimer);
				saveTimer = null;
			}
			saveIfChanged();
		}
		if (msg.type === 'headingFormDatetimeNormalized') {
			const key = String(msg.key || '');
			const value = String(msg.value || '');
			if (!key || !value) return;
			const input = /** @type {HTMLInputElement|null} */ (
				attrsEl.querySelector('[data-key="' + key + '"]')
			);
			if (input && input.dataset.kind === 'datetime' && input.value !== value) {
				input.value = value;
				scheduleSave();
			}
			return;
		}
		if (msg.type === 'headingFormIssueParentError') {
			const input = /** @type {HTMLInputElement|null} */ (
				attrsEl.querySelector('[data-issue-parent="1"]')
			);
			if (input) {
				const value = String(msg.value || '');
				input.value = value;
				input.dataset.lastValid = value;
				input.dataset.invalid = '';
				input.classList.remove('hf-invalid');
				const wrap = input.closest('.hf-val');
				const hint = wrap && wrap.querySelector('.hf-hint');
				if (hint) {
					hint.classList.add('hf-hint-error');
					hint.textContent = String(msg.message || 'Invalid parent issue.');
				}
			}
			lastSavedSig = contentSig(collectModel());
			return;
		}
		if (msg.type === 'headingFormBoundUpdate' && lastPayload && msg.payload) {
			filling = true;
			lastPayload = { ...lastPayload, ...msg.payload };
			filling = false;
		}
	});

	vscode.postMessage({ type: 'headingFormReady' });
})();
