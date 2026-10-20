(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	let currentDraftId = '';
	let noteDebounce = null;
	let schema = { types: [], allowedRelations: [] };
	let currentTypeId = '';
	let currentFields = [];
	let currentSourceFormat = '';

	// Tags dropdown state, mirroring the `.d.md` editor: known tags are fetched from
	// the host, and typing drives a debounced semantic search against the tag embeddings.
	let cachedTags = [];
	let tagsSearchQuery = '';
	let tagsSemantic = [];
	let tagsSearchTimer = null;
	let tagsListRerender = null;

	const titleEl = document.getElementById('heading-title');
	const chipsEl = document.getElementById('chips');
	const bodyEl = document.getElementById('body');
	const statusEl = document.getElementById('status');
	const errorEl = document.getElementById('error');
	const selectKbBtn = document.getElementById('select-kb');
	const newNoteBtn = document.getElementById('new-note');
	const deleteDraftBtn = document.getElementById('delete-draft');
	const kbRootEl = document.getElementById('kb-root');

	// A single floating menu, reused across the type chip and every field chip.
	let activePopover = null;

	function closePopover() {
		if (activePopover) {
			activePopover.remove();
			activePopover = null;
		}
		tagsListRerender = null;
		tagsSearchQuery = '';
		tagsSemantic = [];
		if (tagsSearchTimer !== null) {
			clearTimeout(tagsSearchTimer);
			tagsSearchTimer = null;
		}
	}

	function openPopover(anchor, build) {
		closePopover();
		const pop = document.createElement('div');
		pop.className = 'composer-popover';
		document.body.appendChild(pop);
		const r = anchor.getBoundingClientRect();
		pop.style.left = r.left + 'px';
		pop.style.top = (r.bottom + 4) + 'px';
		build(pop);
		activePopover = pop;
	}

	function popoverItem(pop, label, onPick, danger) {
		const it = document.createElement('div');
		it.className = 'composer-popover-item' + (danger ? ' is-danger' : '');
		it.textContent = label;
		it.addEventListener('mousedown', function (e) { e.preventDefault(); });
		it.addEventListener('click', function (e) {
			e.preventDefault();
			e.stopPropagation();
			closePopover();
			onPick();
		});
		pop.appendChild(it);
		return it;
	}

	function popoverValueItem(pop, label, isSelected, onPick) {
		const it = document.createElement('div');
		it.className = 'composer-popover-item composer-popover-value' + (isSelected ? ' is-selected' : '');
		const name = document.createElement('span');
		name.textContent = label;
		it.appendChild(name);
		const tick = document.createElement('span');
		tick.className = 'composer-popover-tick';
		tick.textContent = isSelected ? '✓' : '';
		it.appendChild(tick);
		it.addEventListener('mousedown', function (e) { e.preventDefault(); });
		it.addEventListener('click', function (e) {
			e.preventDefault();
			e.stopPropagation();
			closePopover();
			onPick();
		});
		pop.appendChild(it);
		return it;
	}

	function popoverInput(pop, value, onCommit, placeholder) {
		const input = document.createElement('input');
		input.className = 'composer-popover-input';
		input.value = value;
		if (placeholder) input.placeholder = placeholder;
		input.addEventListener('mousedown', function (e) { e.stopPropagation(); });
		pop.appendChild(input);
		const commit = function () {
			closePopover();
			onCommit(input.value.trim());
		};
		input.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') {
				e.preventDefault();
				commit();
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				closePopover();
			}
		});
		requestAnimationFrame(function () { input.focus(); });
		return input;
	}

	function updateDeleteVisibility() {
		deleteDraftBtn.hidden = !currentDraftId;
	}

	function typeById(id) {
		return (schema.types || []).find(function (t) { return String(t.id) === String(id || ''); }) || null;
	}

	function isRelation(key) {
		return (schema.allowedRelations || []).indexOf(String(key || '').toLowerCase()) >= 0;
	}

	/** List values (tags / relations) are edited comma-separated and stored bracketed. */
	function displayValue(key, value) {
		const v = String(value || '');
		return isRelation(key) ? v.replace(/^\[|\]$/g, '').trim() : v;
	}

	function storeValue(key, display) {
		const d = String(display || '').trim();
		if (isRelation(key)) {
			const items = d.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
			return '[' + items.join(', ') + ']';
		}
		return d;
	}

	/** Parse a `[a, b, c]` list value into its trimmed, non-empty items. */
	function parseListField(value) {
		return String(value || '')
			.replace(/^\[|\]$/g, '')
			.split(',')
			.map(function (s) { return s.trim(); })
			.filter(Boolean);
	}

	/** Order tags by how well they match a query: exact, then starts-with, then contains. */
	function rankTagsByQuery(tags, query) {
		const q = String(query || '').trim().toLowerCase();
		if (!q) return tags.slice();
		const scored = [];
		for (const t of tags) {
			const low = t.toLowerCase();
			if (low === q) scored.push({ t: t, score: 0 });
			else if (low.startsWith(q)) scored.push({ t: t, score: 1 });
			else if (low.includes(q)) scored.push({ t: t, score: 2 });
		}
		scored.sort(function (a, b) { return a.score - b.score || a.t.localeCompare(b.t); });
		return scored.map(function (s) { return s.t; });
	}

	/** Debounced request to the host for semantic tag matches on the current query. */
	function requestTagSearch() {
		if (tagsSearchTimer !== null) clearTimeout(tagsSearchTimer);
		const q = tagsSearchQuery.trim();
		if (!q) {
			tagsSemantic = [];
			return;
		}
		tagsSearchTimer = setTimeout(function () {
			vscode.postMessage({ type: 'tags-search', query: q });
		}, 250);
	}

	/** Clean title: strip any markdown `#` and `.d.txt` type shortcut the user may have typed. */
	function ingestTitleFromField() {
		const raw = String(titleEl.value || '').trim();
		const m = raw.match(/^#{1,6}\s+(.*)$/);
		return m ? String(m[1] || '').trim() : raw;
	}

	/** The neutral draft shape the host serializes back into the target file's format. */
	function notePayload() {
		const ingestTitle = ingestTitleFromField();
		return {
			id: currentDraftId,
			title: ingestTitle,
			headings: ingestTitle,
			typeId: currentTypeId,
			fields: currentFields,
			content: String(bodyEl.value || ''),
			metadataFilename: ingestTitle,
			sourceFormat: currentSourceFormat
		};
	}

	function pushNoteSnapshot() {
		clearTimeout(noteDebounce);
		noteDebounce = setTimeout(function () {
			vscode.postMessage({ type: 'noteSnapshot', note: notePayload() });
		}, 300);
	}

	/**
	 * The selectable heading types: the untyped `persistent` marker plus every KB type in
	 * the schema (concept / task — matching `.d.md`, where persistent is always offered).
	 */
	function typeOptions() {
		const out = [{ id: 'persistent', label: 'persistent' }];
		for (const t of (schema.types || [])) out.push({ id: t.id, label: t.id });
		return out;
	}

	/** The type as displayed on the chip: an untyped draft is shown as `persistent`. */
	function effectiveTypeId() {
		return currentTypeId || 'persistent';
	}

	function setType(typeId) {
		if (String(typeId) === String(currentTypeId)) return;
		currentTypeId = typeId;
		// A heading carries exactly one type, so switching types (including to
		// `persistent`) drops the previous type's heading attributes. Relations (tags /
		// pre-req) live on their own line and stay.
		currentFields = currentFields.filter(function (f) { return isRelation(f.key); });
		renderMetadata();
		pushNoteSnapshot();
	}

	function setField(key, value) {
		const idx = currentFields.findIndex(function (f) { return String(f.key) === String(key); });
		if (idx >= 0) currentFields[idx].value = value;
		else currentFields.push({ key: key, value: value });
		renderMetadata();
		pushNoteSnapshot();
	}

	function removeField(key) {
		currentFields = currentFields.filter(function (f) { return String(f.key) !== String(key); });
		renderMetadata();
		pushNoteSnapshot();
	}

	/** Add a tag if missing, or remove it if already present (case-insensitive). */
	function toggleTag(field, tag) {
		const current = parseListField(field.value);
		const idx = current.findIndex(function (t) { return t.toLowerCase() === tag.toLowerCase(); });
		if (idx >= 0) current.splice(idx, 1);
		else current.push(tag);
		setField(field.key, current.length ? '[' + current.join(', ') + ']' : '');
	}

	function openTypePicker(anchor) {
		openPopover(anchor, function (pop) {
			const header = document.createElement('div');
			header.className = 'composer-popover-title';
			header.textContent = 'Heading type';
			pop.appendChild(header);

			for (const opt of typeOptions()) {
				const isSelected = String(opt.id) === effectiveTypeId();
				const it = document.createElement('div');
				it.className = 'composer-popover-item composer-type-option' + (isSelected ? ' is-selected' : '');
				const dot = document.createElement('span');
				dot.className = 'composer-type-dot';
				dot.textContent = '●';
				it.appendChild(dot);
				it.appendChild(document.createTextNode(opt.label));
				const tick = document.createElement('span');
				tick.className = 'composer-popover-tick';
				tick.textContent = isSelected ? '✓' : '';
				it.appendChild(tick);
				it.addEventListener('mousedown', function (e) { e.preventDefault(); });
				it.addEventListener('click', function (e) {
					e.preventDefault();
					e.stopPropagation();
					closePopover();
					setType(opt.id);
				});
				pop.appendChild(it);
			}
		});
	}

	function fieldChip(field, attr, relation) {
		const chip = document.createElement('span');
		chip.className = 'composer-chip';

		const key = document.createElement('span');
		key.className = 'composer-chip-key';
		key.textContent = field.key;
		chip.appendChild(key);

		const val = document.createElement('span');
		val.className = 'composer-chip-value';
		val.textContent = field.value;
		chip.appendChild(val);

		// Unknown fields (not an attribute nor a relation) are shown read-only.
		if (!attr && !relation) {
			chip.classList.add('composer-chip-static');
			return chip;
		}

		chip.classList.add('composer-chip-editable');
		chip.title = 'Edit ' + field.key;
		chip.addEventListener('click', function (e) {
			e.preventDefault();
			e.stopPropagation();
			openFieldEditor(chip, field, attr);
		});
		return chip;
	}

	function addChip(key, attr, relation, required) {
		const chip = document.createElement('span');
		chip.className = 'composer-chip composer-chip-add' + (required ? ' composer-chip-required' : '');
		chip.textContent = '+ ' + key;
		chip.title = 'Add ' + key;
		chip.addEventListener('click', function (e) {
			e.preventDefault();
			e.stopPropagation();
			openFieldEditor(chip, { key: key, value: '' }, attr);
		});
		return chip;
	}

	function openFieldEditor(anchor, field, attr) {
		const relation = !attr && isRelation(field.key);

		openPopover(anchor, function (pop) {
			const remove = function () {
				popoverItem(pop, 'Remove', function () { removeField(field.key); }, true);
			};

			if (relation) {
				// Relations (`tags`, `pre-req`, …) all reference tags, so every relation
				// edits through the same searchable tag dropdown (word + semantic matches,
				// plus a "create new tag" input at the bottom).
				buildTagsPicker(pop, field);
				vscode.postMessage({ type: 'tags-list' });
			} else if (attr && attr.kind === 'enum' && Array.isArray(attr.values) && attr.values.length) {
				// Tick the current value; re-clicking it deselects (removes the field).
				for (const v of attr.values) {
					const isSelected = v === field.value;
					popoverValueItem(pop, v, isSelected, function () {
						if (isSelected) removeField(field.key);
						else setField(field.key, v);
					});
				}
			} else {
				// Free text (datetime / duration / ref / free-form enum).
				popoverInput(pop, displayValue(field.key, field.value), function (v) {
					if (v) setField(field.key, storeValue(field.key, v));
					else removeField(field.key);
				}, 'value');
				remove();
			}
		});
	}

	/**
	 * Build the tag dropdown used by every relation (`tags`, `pre-req`, …): a search box,
	 * then the current values (ticked) and the tags already in the KB graph (fetched from
	 * the host into `cachedTags`), plus a "create new tag" input at the bottom. The list
	 * narrows as you type — word matches first, then semantic (embedding) matches from the
	 * host — and clicking a tag toggles it.
	 */
	function buildTagsPicker(pop, field) {
		const header = document.createElement('div');
		header.className = 'composer-popover-title';
		header.textContent = field.key.charAt(0).toUpperCase() + field.key.slice(1);
		pop.appendChild(header);

		const search = document.createElement('input');
		search.className = 'composer-popover-input';
		search.placeholder = 'Search tags…';
		search.value = tagsSearchQuery;
		search.addEventListener('mousedown', function (e) { e.stopPropagation(); });
		pop.appendChild(search);

		const list = document.createElement('div');
		list.className = 'composer-tags-list';
		pop.appendChild(list);

		// Create a new tag (created in the KB graph by the host). A labelled row with its
		// own input and a "+ Create" button, separate from the search box.
		const createWrap = document.createElement('div');
		createWrap.className = 'composer-popover-create';
		const createLabel = document.createElement('div');
		createLabel.className = 'composer-popover-title';
		createLabel.textContent = 'Create new tag';
		createWrap.appendChild(createLabel);
		const createRow = document.createElement('div');
		createRow.className = 'composer-popover-create-row';
		const createInput = document.createElement('input');
		createInput.className = 'composer-popover-input';
		createInput.placeholder = 'New tag name…';
		createInput.value = tagsSearchQuery;
		createInput.addEventListener('mousedown', function (e) { e.stopPropagation(); });
		const createTag = function () {
			const name = createInput.value.trim();
			if (!name) return;
			closePopover();
			vscode.postMessage({ type: 'create-tag', tag: name });
			toggleTag(field, name);
		};
		createInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') {
				e.preventDefault();
				createTag();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				closePopover();
			}
		});
		createRow.appendChild(createInput);
		const createButton = document.createElement('button');
		createButton.className = 'composer-popover-create-btn';
		createButton.textContent = '+ Create';
		createButton.addEventListener('mousedown', function (e) { e.stopPropagation(); });
		createButton.addEventListener('click', function (e) {
			e.preventDefault();
			e.stopPropagation();
			createTag();
		});
		createRow.appendChild(createButton);
		createWrap.appendChild(createRow);
		pop.appendChild(createWrap);

		const renderList = function () {
			list.textContent = '';
			const cachedLower = new Set(cachedTags.map(function (t) { return t.toLowerCase(); }));
			const current = parseListField(field.value);
			const currentLower = new Set(current.map(function (t) { return t.toLowerCase(); }));
			const query = tagsSearchQuery.trim();

			if (!query) {
				// Empty query: the current tags plus a small slice of the graph's tags.
				for (const t of current) {
					popoverValueItem(list, t, true, function () { toggleTag(field, t); });
				}
				let shown = 0;
				for (const t of cachedTags) {
					if (currentLower.has(t.toLowerCase())) continue;
					if (shown >= 8) break;
					popoverValueItem(list, t, false, function () { toggleTag(field, t); });
					shown++;
				}
			} else {
				const ql = query.toLowerCase();
				const shown = new Set(currentLower);
				// Matching current tags first (ticked), so they can be removed.
				for (const t of current) {
					if (!t.toLowerCase().includes(ql)) continue;
					popoverValueItem(list, t, true, function () { toggleTag(field, t); });
				}
				// Word matches (up to 3), then semantic matches (up to 3), no overlap.
				for (const t of rankTagsByQuery(cachedTags, query)) {
					if (shown.has(t.toLowerCase())) continue;
					shown.add(t.toLowerCase());
					popoverValueItem(list, t, false, function () { toggleTag(field, t); });
					if (shown.size - currentLower.size >= 3) break;
				}
				for (const t of tagsSemantic) {
					if (shown.has(t.toLowerCase())) continue;
					if (!cachedLower.has(t.toLowerCase())) continue; // keep it graph-scoped
					shown.add(t.toLowerCase());
					popoverValueItem(list, t, false, function () { toggleTag(field, t); });
					if (shown.size - currentLower.size >= 6) break;
				}
			}
		};

		tagsListRerender = renderList;

		search.addEventListener('input', function () {
			tagsSearchQuery = search.value;
			createInput.value = tagsSearchQuery;
			renderList();
			requestTagSearch();
		});

		renderList();
		requestAnimationFrame(function () { search.focus(); });
	}

	function renderMetadata() {
		chipsEl.innerHTML = '';

		const t = typeById(currentTypeId);
		const attrList = t ? (t.attributes || []) : [];
		const present = new Set(currentFields.map(function (f) { return String(f.key).toLowerCase(); }));

		// Top row: the type chip + heading attributes (the heading-level metadata).
		const topRow = document.createElement('div');
		topRow.className = 'chip-row';

		const typeChip = document.createElement('span');
		typeChip.className = 'composer-chip composer-chip-type';
		typeChip.textContent = effectiveTypeId();
		typeChip.title = 'Change heading type';
		typeChip.addEventListener('click', function (e) {
			e.preventDefault();
			e.stopPropagation();
			openTypePicker(typeChip);
		});
		topRow.appendChild(typeChip);

		for (const field of currentFields) {
			if (isRelation(field.key)) continue; // relations live on the bottom row
			const attr = attrList.find(function (a) { return String(a.key) === String(field.key).toLowerCase(); }) || null;
			topRow.appendChild(fieldChip(field, attr, false));
		}
		for (const attr of attrList) {
			if (present.has(String(attr.key).toLowerCase())) continue;
			topRow.appendChild(addChip(attr.key, attr, false, !!attr.required));
		}
		chipsEl.appendChild(topRow);

		// Bottom row: tags + other relations.
		const bottomRow = document.createElement('div');
		bottomRow.className = 'chip-row';
		for (const field of currentFields) {
			if (!isRelation(field.key)) continue;
			bottomRow.appendChild(fieldChip(field, null, true));
		}
		for (const rel of (schema.allowedRelations || [])) {
			if (present.has(String(rel).toLowerCase())) continue;
			bottomRow.appendChild(addChip(rel, null, true, false));
		}
		chipsEl.appendChild(bottomRow);
	}

	function applyDraft(title, typeId, fields, content, sourceFormat) {
		titleEl.value = title || '';
		currentTypeId = typeId || '';
		currentFields = (Array.isArray(fields) ? fields : []).slice();
		bodyEl.value = content || '';
		currentSourceFormat = sourceFormat || '';
		renderMetadata();
	}

	function resetForm() {
		currentDraftId = '';
		closePopover();
		applyDraft('', '', [], '', '');
		statusEl.textContent = '';
		errorEl.textContent = '';
		updateDeleteVisibility();
	}

	titleEl.addEventListener('input', pushNoteSnapshot);
	bodyEl.addEventListener('input', pushNoteSnapshot);

	// Close any open chip popover as soon as the user clicks back in the document.
	document.addEventListener('click', function (e) {
		if (activePopover && !activePopover.contains(e.target)) closePopover();
	});
	document.addEventListener('keydown', function (e) {
		if (e.key === 'Escape') closePopover();
	});

	document.getElementById('save-draft').addEventListener('click', function () {
		statusEl.textContent = '';
		errorEl.textContent = '';
		vscode.postMessage({ type: 'saveDraft', note: notePayload() });
	});

	newNoteBtn.addEventListener('click', function () {
		resetForm();
		vscode.postMessage({ type: 'composerNewNote' });
		vscode.postMessage({ type: 'noteSnapshot', note: notePayload() });
	});

	deleteDraftBtn.addEventListener('click', function () {
		if (!currentDraftId) return;
		statusEl.textContent = '';
		errorEl.textContent = '';
		vscode.postMessage({ type: 'deleteDraft', draftId: currentDraftId });
	});

	document.getElementById('ingest-note').addEventListener('click', function () {
		statusEl.textContent = '';
		errorEl.textContent = '';
		vscode.postMessage({ type: 'ingestNote', note: notePayload() });
	});

	document.getElementById('select-kb').addEventListener('click', function () {
		statusEl.textContent = '';
		errorEl.textContent = '';
		vscode.postMessage({ type: 'selectKnowledgeBase', noteId: currentDraftId });
	});

	window.addEventListener('message', function (event) {
		const message = event.data;

		if (message.type === 'composerState') {
			const state = message.state;
			if (state.metadataSchema) schema = state.metadataSchema;
			currentDraftId = state.draft.id || '';
			updateDeleteVisibility();
			kbRootEl.textContent = state.kbRootPath
				? 'Knowledge base: ' + state.kbRootPath
				: 'Knowledge base: not selected';
			selectKbBtn.textContent = state.kbRootPath ? 'Change Knowledge Base' : 'Select Knowledge Base Folder';
			statusEl.textContent = state.statusMessage || '';
			errorEl.textContent = '';

			if (state.capture) {
				currentDraftId = '';
				updateDeleteVisibility();
				applyDraft(
					state.capture.title,
					state.capture.typeId,
					state.capture.fields,
					state.capture.content,
					state.capture.sourceFormat
				);
				if (!statusEl.textContent) statusEl.textContent = 'Selection captured.';
			} else {
				applyDraft(
					state.draft.title || '',
					state.draft.typeId || '',
					state.draft.fields || [],
					state.draft.content || '',
					state.draft.sourceFormat || ''
				);
			}
			pushNoteSnapshot();
		}

		if (message.type === 'capturedSelection') {
			currentDraftId = '';
			updateDeleteVisibility();
			applyDraft(message.title, message.typeId, message.fields, message.content, message.sourceFormat);
			errorEl.textContent = '';
			statusEl.textContent = message.multipleRoots
				? 'Selection has multiple top-level headings — kept as a draft.'
				: 'Selection captured.';
			pushNoteSnapshot();
		}

		if (message.type === 'tags-list') {
			cachedTags = Array.isArray(message.tags) ? message.tags.map(function (t) { return String(t); }) : [];
			if (tagsListRerender) tagsListRerender();
		}

		if (message.type === 'tags-search') {
			// Semantic matches for the current query arrived — ignore stale responses.
			if (String(message.query || '') !== tagsSearchQuery) return;
			tagsSemantic = Array.isArray(message.semantic) ? message.semantic.map(function (t) { return String(t); }) : [];
			if (tagsListRerender) tagsListRerender();
		}

		if (message.type === 'operationError') {
			errorEl.textContent = message.message || 'Unknown error';
		}
	});

	updateDeleteVisibility();
	vscode.postMessage({ type: 'requestState' });
})();
