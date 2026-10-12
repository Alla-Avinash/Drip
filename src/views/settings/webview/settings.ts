// Browser client for the DRIP Settings webview. Bundled by esbuild (scripts/build-webview.mjs)
// into dist/. Runs inside the sandboxed webview; bootstrap values arrive via window.__dripSettingsInit.

interface Window {
	__dripSettingsInit: any;
}


		const vscode = acquireVsCodeApi();
		const navButtons = Array.prototype.slice.call(document.querySelectorAll('.navBtn'));
		const panels = {
			kb: document.getElementById('panel-kb'),
			editor: document.getElementById('panel-editor'),
			update: document.getElementById('panel-update'),
			types: document.getElementById('panel-types'),
			relations: document.getElementById('panel-relations'),
			metadata: document.getElementById('panel-metadata'),
			doccoloring: document.getElementById('panel-doccoloring'),
			embedding: document.getElementById('panel-embedding'),
			llm: document.getElementById('panel-llm'),
			'github-backup': document.getElementById('panel-github-backup'),
			mcp: document.getElementById('panel-mcp'),
			'saved-settings': document.getElementById('panel-saved-settings'),
			shortcuts: document.getElementById('panel-shortcuts')
		};
		const optEditHeadingsRhs = document.getElementById('opt-edit-headings-rhs');
		const optEditHeadingsFile = document.getElementById('opt-edit-headings-file');
		const llmEnabledEl = document.getElementById('llm-enabled');
		const llmBaseUrlEl = document.getElementById('llm-base-url');
		const llmModelEl = document.getElementById('llm-model');
		const autoOpenEl = document.getElementById('opt-auto-open');
		const kbExtDtxt = document.getElementById('kb-ext-dtxt');
		const kbExtMd = document.getElementById('kb-ext-md');
		const kbDefaultExt = document.getElementById('kb-default-ext');
		const metadataTypesListEl = document.getElementById('metadata-types-list');
		const fileLevelTypesListEl = document.getElementById('file-level-types-list');
		const optTemplateEnabled = document.getElementById('opt-template-enabled');
		const optTemplateAuto = document.getElementById('opt-template-auto');
		const optTemplateStrict = document.getElementById('opt-template-strict');
		const optTemplateIgnore = document.getElementById('opt-template-ignore');
		const optTemplateIndentErrors = document.getElementById('opt-template-indent-errors');
		const optHeadingHierarchyIndent = document.getElementById('opt-heading-hierarchy-indent');
		const relationsListEl = document.getElementById('relations-list');
		const metadataMarksListEl = document.getElementById('metadata-marks-list');
		const docColoringSampleEl = document.getElementById('doc-coloring-sample');
		const docColoringRowsEl = document.getElementById('doc-coloring-rows');
		const savedSettingsPathEl = document.getElementById('saved-settings-path');
		const defaultMetadataTypes = window.__dripSettingsInit.defaultMetadataTypes;
		const defaultFileLevelMetadataTypes = window.__dripSettingsInit.defaultFileLevelMetadataTypes;
		/** Extensions set only via settings JSON; preserved when toggling .d.txt / .md here. */
		var preservedOtherExts = [];
		var metadataTypesState = [];
		var fileLevelTypesState = [];
		var relationsState = [];
		var metadataMarksState = [];
		var docColorsState = { color1: '', color2: '', color3: '', color4: '', color5: '', color6: '', color7: '', color8: '', color9: '' };
		// Resolved from the active theme in the extension host (theme tokenColors + token/semantic customizations).
		var docThemeColors = null;

		function showPanel(id) {
			for (var key in panels) {
				if (!Object.prototype.hasOwnProperty.call(panels, key)) continue;
				panels[key].classList.toggle('active', key === id);
			}
			for (var i = 0; i < navButtons.length; i++) {
				var b = navButtons[i];
				b.classList.toggle('active', b.getAttribute('data-panel') === id);
			}
		}

		function escapeHtml(value) {
			return String(value || '')
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#39;');
		}

		function normalizeHexColor(v) {
			var s = String(v || '').trim();
			return /^#([0-9a-f]{6})$/i.test(s) ? s.toLowerCase() : '';
		}
		function syncColorPickerFromText(textEl, pickerEl) {
			if (!textEl || !pickerEl) return;
			pickerEl.value = normalizeHexColor(textEl.value) || '#808080';
		}
		function syncColorTextFromPicker(textEl, pickerEl) {
			if (!textEl || !pickerEl) return;
			textEl.value = normalizeHexColor(pickerEl.value) || '';
		}

		function cloneJson(v) {
			try { return JSON.parse(JSON.stringify(v)); } catch { return []; }
		}

		function normalizeAttributeKind(kind) {
			var k = String(kind || 'enum').trim().toLowerCase();
			if (k === 'free' || k === 'range') return 'enum';
			if (k === 'enum' || k === 'datetime' || k === 'duration') return k;
			if (k === 'parent' || k === 'issue_parent') return 'issue_parent';
			return 'enum';
		}

		// Fixed kind for the issue parent key — a special link, not an enum/datetime/duration.
		var SPECIAL_PARENT_KIND = 'issue_parent';

		var FIXED_DURATION_UNITS_LABEL = 'minute, hour, day, week, month, year';
		var FIXED_DATETIME_FORMAT_LABEL = 'datetime (YYYY-MM-DD HH:mm)';

		function normalizeAttributes(rawAttrs) {
			var attrs = [];
			if (Array.isArray(rawAttrs)) {
				for (var i = 0; i < rawAttrs.length; i++) {
					var a = rawAttrs[i] || {};
					var kind = normalizeAttributeKind(a.kind || a.type);
					attrs.push({
						key: String(a.key || '').trim(),
						kind: kind,
						values: kind === 'enum' && Array.isArray(a.values)
							? a.values.map(function (x) { return String(x || '').trim(); }).filter(Boolean)
							: [],
						default: String(a.default != null ? a.default : '').trim(),
						required: !!a.required
					});
				}
				return attrs;
			}
			var src = rawAttrs && typeof rawAttrs === 'object' ? rawAttrs : {};
			var keys = Object.keys(src);
			for (var j = 0; j < keys.length; j++) {
				var key = String(keys[j] || '').trim();
				if (!key) continue;
				var r = src[key] || {};
				var kindObj = normalizeAttributeKind(r.kind);
				attrs.push({
					key: key,
					kind: kindObj,
					values: kindObj === 'enum' && Array.isArray(r.values)
						? r.values.map(function (x) { return String(x || '').trim(); }).filter(Boolean)
						: [],
					default: String(r.default != null ? r.default : '').trim(),
					required: !!r.required
				});
			}
			return attrs;
		}

		function normalizeTypesFromSettings(rawTypes) {
			var arr = Array.isArray(rawTypes) && rawTypes.length ? rawTypes : cloneJson(defaultMetadataTypes);
			var out = [];
			for (var i = 0; i < arr.length; i++) {
				var t = arr[i] || {};
				var id = String(t.id || '').trim().toLowerCase();
				var markerRaw = String(t.marker || (id ? ('.' + id) : '')).trim();
				var marker = markerRaw ? (markerRaw.startsWith('.') ? markerRaw : '.' + markerRaw) : '';
				var shortcut = String(t.shortcut != null ? t.shortcut : '').trim();
				out.push({
					id: id,
					marker: marker,
					shortcut: shortcut,
					displayTemplate: t.displayTemplate !== false,
					attributes: (function () {
						var attrs = normalizeAttributes(t.attributes);
						for (var ai = 0; ai < attrs.length; ai++) {
							sanitizeEnumDefault(attrs[ai]);
						}
						return attrs;
					})()
				});
			}
			return out;
		}
		function normalizeAttrByKind(attr) {
			if (!attr) return;
			attr.kind = normalizeAttributeKind(attr.kind);
			if (attr.kind === 'datetime') {
				attr.values = [];
			} else if (attr.kind === 'duration') {
				attr.values = [];
			} else if (attr.kind !== 'enum') {
				attr.values = [];
			}
			if (attr.kind !== 'enum') {
				attr.default = '';
			} else {
				sanitizeEnumDefault(attr);
			}
		}

		function sanitizeEnumDefault(attr) {
			if (!attr || normalizeAttributeKind(attr.kind) !== 'enum') return;
			var def = String(attr.default || '').trim();
			if (!def) {
				attr.default = '';
				return;
			}
			var vals = (Array.isArray(attr.values) ? attr.values : []).map(function (x) {
				return String(x || '').trim().toLowerCase();
			});
			if (vals.indexOf(def.toLowerCase()) < 0) {
				attr.default = '';
			}
		}

		function renderAttrValuesCell(a) {
			var kind = normalizeAttributeKind(a.kind);
			if (kind === 'datetime') {
				return '<input type="text" data-role="attr-values" disabled value="' + escapeHtml(FIXED_DATETIME_FORMAT_LABEL) + '" title="Fixed datetime format in DRIP">';
			}
			if (kind === 'duration') {
				return '<input type="text" data-role="attr-values" disabled value="' + escapeHtml(FIXED_DURATION_UNITS_LABEL) + '" title="Fixed duration units in DRIP">';
			}
			if (kind === SPECIAL_PARENT_KIND) {
				return '<input type="text" data-role="attr-values" disabled value="parent issue (i-N)" title="Fixed special key">';
			}
			return '<input type="text" data-role="attr-values" value="' + escapeHtml((a.values || []).join(', ')) + '" placeholder="comma values (enum)">';
		}

		function renderAttrKindCell(a, builtIn) {
			var kind = normalizeAttributeKind(a.kind);
			var disabled = builtIn ? ' disabled' : '';
			if (kind === SPECIAL_PARENT_KIND) {
				return '<select data-role="attr-kind" disabled title="Fixed special key"><option value="issue_parent" selected>parent</option></select>';
			}
			return '<select data-role="attr-kind"' + disabled + '>' +
				'<option value="enum"' + (kind === 'enum' ? ' selected' : '') + '>enum</option>' +
				'<option value="datetime"' + (kind === 'datetime' ? ' selected' : '') + '>datetime</option>' +
				'<option value="duration"' + (kind === 'duration' ? ' selected' : '') + '>duration</option>' +
			'</select>';
		}

		var LOCKED_METADATA_TYPE_IDS = { concept: true, task: true, issue: true };
		var LOCKED_FILE_LEVEL_TYPE_IDS = { project: true, feature: true };

		// Built-in template keys per type: fixed by the product, editable but never deletable.
		var BUILTIN_ATTRIBUTE_KEYS = {
			concept: ['domain', 'status'],
			task: ['status', 'priority', 'deadline', 'category'],
			issue: ['status', 'priority', 'deadline', 'category', 'parent'],
			project: ['status', 'priority', 'deadline'],
			feature: ['category']
		};

		function isBuiltInAttributeKey(typeId, key) {
			var list = BUILTIN_ATTRIBUTE_KEYS[String(typeId || '').trim().toLowerCase()];
			return !!list && list.indexOf(String(key || '').trim().toLowerCase()) >= 0;
		}

		function isLockedMetadataType(t) {
			var id = String((t && t.id) || '').trim().toLowerCase();
			return !!LOCKED_METADATA_TYPE_IDS[id];
		}

		function isLockedFileLevelType(t) {
			var id = String((t && t.id) || '').trim().toLowerCase();
			return !!LOCKED_FILE_LEVEL_TYPE_IDS[id];
		}

		function findDocumentTypeIndex(id) {
			var want = String(id || '').trim().toLowerCase();
			for (var i = 0; i < metadataTypesState.length; i++) {
				if (String((metadataTypesState[i] || {}).id || '').trim().toLowerCase() === want) return i;
			}
			return -1;
		}

		function resetIssueType() {
			var def = null;
			for (var i = 0; i < defaultMetadataTypes.length; i++) {
				if (String((defaultMetadataTypes[i] || {}).id || '').toLowerCase() === 'issue') {
					def = defaultMetadataTypes[i];
					break;
				}
			}
			if (!def) return;
			var idx = findDocumentTypeIndex('issue');
			var normalized = normalizeTypesFromSettings([def]);
			if (normalized.length) {
				if (idx >= 0) metadataTypesState[idx] = normalized[0];
				else metadataTypesState.push(normalized[0]);
			}
		}

		function addNewType() {
			metadataTypesState.push({
				id: 'new-type',
				marker: '.new-type',
				shortcut: '',
				displayTemplate: true,
				attributes: []
			});
			renderMetadataTypes();
		}

		function renderMetadataTypes() {
			var html = '';
			for (var i = 0; i < metadataTypesState.length; i++) {
				var t = metadataTypesState[i] || {};
				// Issue is shown in the Projects card, not the document list.
				if (String(t.id || '').trim().toLowerCase() === 'issue') continue;
				var attrs = Array.isArray(t.attributes) ? t.attributes : [];
				var rows = '';
				for (var j = 0; j < attrs.length; j++) {
					var a = attrs[j] || {};
					var builtIn = isBuiltInAttributeKey(t.id, a.key);
					rows += '<tr data-type-index="' + i + '" data-attr-index="' + j + '">' +
						'<td><input type="text" data-role="attr-key" value="' + escapeHtml(a.key) + '" placeholder="key"' + (builtIn ? ' disabled' : '') + '></td>' +
						'<td>' + renderAttrKindCell(a, builtIn) + '</td>' +
						'<td>' + renderAttrValuesCell(a) + '</td>' +
						'<td><label class="row" style="margin:0;"><input type="checkbox" data-role="attr-required"' + (a.required ? ' checked' : '') + '><span>required</span></label></td>' +
						'<td>' + (builtIn ? '<span class="meta">built-in</span>' : '<button class="iconBtn deleteIcon" data-role="remove-attr" title="Delete Attribute">🗑</button>') + '</td>' +
					'</tr>';
				}
				var locked = isLockedMetadataType(t);
				var deleteTypeBtn = locked
					? ''
					: '<button class="iconBtn deleteIcon" data-role="remove-type" title="Delete Metadata Type">🗑</button>';
				html +=
					'<details class="typeDetails" data-type-index="' + i + '" open>' +
						'<summary class="typeSummary">' +
							'<span>' + escapeHtml(t.marker || '.type') + ' (' + escapeHtml(t.id || 'type') + ')</span>' +
							'<span class="summaryRight">' + deleteTypeBtn + '<span class="chev">⌃</span></span>' +
						'</summary>' +
						'<div class="typeBody" data-type-index="' + i + '">' +
							'<div class="typeGrid">' +
								'<label class="row" style="display:block;margin:0;"><span>Type Id</span><input type="text" data-role="type-id" value="' + escapeHtml(t.id) + '"></label>' +
								'<label class="row" style="display:block;margin:0;"><span>Marker (must start with .)</span><input type="text" data-role="type-marker" value="' + escapeHtml(t.marker) + '"></label>' +
								'<label class="row" style="display:block;margin:0;"><span>Heading shortcut</span><input type="text" data-role="type-shortcut" value="' + escapeHtml(t.shortcut) + '" placeholder="t"></label>' +
								'<label class="row" style="display:block;margin:0;"><input type="checkbox" data-role="type-display-template"' + (t.displayTemplate !== false ? ' checked' : '') + '><span>Display template for this type</span></label>' +
							'</div>' +
							'<table class="attrTable">' +
								'<thead><tr><th>Key</th><th>Kind</th><th>Values</th><th>Required</th><th>Action</th></tr></thead>' +
								'<tbody>' + rows + '</tbody>' +
							'</table>' +
							'<div class="inlineActions">' +
								'<button class="iconBtn" data-role="add-attr" title="Add Attribute">+</button>' +
							'</div>' +
						'</div>' +
					'</details>';
			}
			metadataTypesListEl.innerHTML = html;
		}

		function renderFileLevelTypes() {
			var html = '';
			for (var i = 0; i < fileLevelTypesState.length; i++) {
				var t = fileLevelTypesState[i] || {};
				var typeId = String(t.id || '').trim().toLowerCase();
				var attrs = Array.isArray(t.attributes) ? t.attributes : [];
				var rows = '';
				for (var j = 0; j < attrs.length; j++) {
					var a = attrs[j] || {};
					var builtIn = isBuiltInAttributeKey(typeId, a.key);
					rows += '<tr data-type-index="' + i + '" data-attr-index="' + j + '">' +
						'<td><input type="text" data-role="attr-key" value="' + escapeHtml(a.key) + '" placeholder="key"' + (builtIn ? ' disabled' : '') + '></td>' +
						'<td>' + renderAttrKindCell(a, builtIn) + '</td>' +
						'<td>' + renderAttrValuesCell(a) + '</td>' +
						'<td><label class="row" style="margin:0;"><input type="checkbox" data-role="attr-required"' + (a.required ? ' checked' : '') + '><span>required</span></label></td>' +
						'<td>' + (builtIn ? '<span class="meta">built-in</span>' : '<button class="iconBtn deleteIcon" data-role="remove-attr" title="Delete Attribute">🗑</button>') + '</td>' +
					'</tr>';
				}
				var shortcutLabel = typeId === 'project' ? '.p' : typeId === 'feature' ? '.f' : '';
				html +=
					'<details class="typeDetails" data-type-index="' + i + '" open>' +
						'<summary class="typeSummary">' +
							'<span>' + escapeHtml(t.id || 'type') + ' (special)</span>' +
							'<span class="summaryRight"><span class="chev">⌃</span></span>' +
						'</summary>' +
						'<div class="typeBody" data-type-index="' + i + '">' +
							'<div class="typeGrid">' +
								'<label class="row" style="display:block;margin:0;"><span>Type Id</span><input type="text" data-role="type-id" value="' + escapeHtml(t.id) + '" disabled></label>' +
								'<label class="row" style="display:block;margin:0;"><span>Shortcut</span><input type="text" value="' + escapeHtml(shortcutLabel) + '" disabled></label>' +
							'</div>' +
							'<table class="attrTable">' +
								'<thead><tr><th>Key</th><th>Kind</th><th>Values</th><th>Required</th><th>Action</th></tr></thead>' +
								'<tbody>' + rows + '</tbody>' +
							'</table>' +
							'<div class="inlineActions">' +
								'<button class="iconBtn" data-role="add-attr" title="Add Attribute">+</button>' +
							'</div>' +
						'</div>' +
					'</details>';
			}

			// Issue is a document/heading type (stored in metadataTypes) but belongs to
			// Projects, so it is rendered here. Mark the block so edits route back to
			// metadataTypesState instead of fileLevelTypesState.
			var issueIndex = findDocumentTypeIndex('issue');
			if (issueIndex >= 0) {
				var it = metadataTypesState[issueIndex] || {};
				var iAttrs = Array.isArray(it.attributes) ? it.attributes : [];
				var iRows = '';
				for (var j = 0; j < iAttrs.length; j++) {
					var ia = iAttrs[j] || {};
					var builtIn = isBuiltInAttributeKey('issue', ia.key);
					iRows += '<tr data-attr-index="' + j + '">' +
						'<td><input type="text" data-role="attr-key" value="' + escapeHtml(ia.key) + '" placeholder="key"' + (builtIn ? ' disabled' : '') + '></td>' +
						'<td>' + renderAttrKindCell(ia, builtIn) + '</td>' +
						'<td>' + renderAttrValuesCell(ia) + '</td>' +
						'<td><label class="row" style="margin:0;"><input type="checkbox" data-role="attr-required"' + (ia.required ? ' checked' : '') + '><span>required</span></label></td>' +
						'<td>' + (builtIn ? '<span class="meta">built-in</span>' : '<button class="iconBtn deleteIcon" data-role="remove-attr" title="Delete Attribute">🗑</button>') + '</td>' +
					'</tr>';
				}
				html +=
					'<details class="typeDetails" data-type-index="' + issueIndex + '" data-source="document" open>' +
						'<summary class="typeSummary">' +
							'<span>' + escapeHtml(it.marker || '.issue') + ' (issue)</span>' +
							'<span class="summaryRight"><span class="chev">⌃</span></span>' +
						'</summary>' +
						'<div class="typeBody" data-type-index="' + issueIndex + '" data-source="document">' +
							'<div class="typeGrid">' +
								'<label class="row" style="display:block;margin:0;"><span>Type Id</span><input type="text" data-role="type-id" value="issue" disabled></label>' +
								'<label class="row" style="display:block;margin:0;"><span>Shortcut</span><input type="text" value="i" disabled></label>' +
							'</div>' +
							'<table class="attrTable">' +
								'<thead><tr><th>Key</th><th>Kind</th><th>Values</th><th>Required</th><th>Action</th></tr></thead>' +
								'<tbody>' + iRows + '</tbody>' +
							'</table>' +
							'<div class="inlineActions">' +
								'<button class="iconBtn" data-role="add-attr" title="Add Attribute">+</button>' +
							'</div>' +
						'</div>' +
					'</details>';
			}

			fileLevelTypesListEl.innerHTML = html;
		}

		function collectFileLevelTypesForSave() {
			var out = [];
			for (var i = 0; i < fileLevelTypesState.length; i++) {
				var t = fileLevelTypesState[i] || {};
				var id = String(t.id || '').trim().toLowerCase();
				if (!id || !LOCKED_FILE_LEVEL_TYPE_IDS[id]) continue;
				var marker = '.' + id;
				var attrsObj = {};
				var attrs = Array.isArray(t.attributes) ? t.attributes : [];
				for (var j = 0; j < attrs.length; j++) {
					var a = attrs[j] || {};
					var k = String(a.key || '').trim().toLowerCase();
					if (!k) continue;
					var kind = normalizeAttributeKind(a.kind);
					var values = kind === 'enum' && Array.isArray(a.values)
						? a.values.map(function (x) { return String(x || '').trim().toLowerCase(); }).filter(Boolean)
						: [];
					var entry = {
						kind: kind,
						default: kind === 'enum' ? String(a.default != null ? a.default : '').trim() : '',
						required: !!a.required
					};
					if (kind === 'enum') entry.values = values;
					attrsObj[k] = entry;
				}
				out.push({
					id: id,
					marker: marker,
					shortcut: id === 'project' ? 'p' : id === 'feature' ? 'f' : '',
					displayTemplate: true,
					attributes: attrsObj
				});
			}
			return out.length ? out : cloneJson(defaultFileLevelMetadataTypes);
		}

		function renderRelations() {
			var html = '';
			for (var i = 0; i < relationsState.length; i++) {
				var r = relationsState[i] || {};
				var locked = !!r.locked || String(r.name || '').toLowerCase() === 'tags';
				html += '<div class="typeDetails"><div class="typeBody" data-rel-index="' + i + '">' +
					'<div class="typeGrid">' +
						'<label class="row" style="display:block;margin:0;"><span>Relation Name</span><input type="text" data-role="rel-name" value="' + escapeHtml(r.name || '') + '"' + (locked ? ' disabled' : '') + '></label>' +
						'<label class="row" style="display:block;margin:0;"><span>Description</span><input type="text" data-role="rel-desc" value="' + escapeHtml(r.description || '') + '"></label>' +
					'</div>' +
					'<div class="inlineActions">' + (locked ? '<span class="meta">Locked default relation</span>' : '<button class="iconBtn secondary deleteIcon" data-role="remove-rel" title="Delete Relation">🗑</button>') + '</div>' +
				'</div></div>';
			}
			relationsListEl.innerHTML = html;
		}

		function renderMetadataMarks() {
			var html = '';
			for (var i = 0; i < metadataMarksState.length; i++) {
				var m = metadataMarksState[i] || {};
				var locked = !!m.locked || String(m.name || '') === 'L';
				html += '<div class="typeDetails"><div class="typeBody" data-mark-index="' + i + '">' +
					'<div class="typeGrid">' +
						'<label class="row" style="display:block;margin:0;"><span>Mark</span><input type="text" data-role="mark-name" value="' + escapeHtml(m.name || '') + '"' + (locked ? ' disabled' : '') + '></label>' +
						'<label class="row" style="display:block;margin:0;"><span>Description</span><input type="text" data-role="mark-desc" value="' + escapeHtml(m.description || '') + '"' + (locked ? ' disabled' : '') + '></label>' +
						'<label class="row" style="display:block;margin:0;"><span>Mark letter color</span><div class="colorRow"><input type="text" data-role="mark-color" value="' + escapeHtml(m.markColor || m.color || '') + '" placeholder="no color (plain text)"><input type="color" class="colorPatch" data-role="mark-color-picker" value="' + escapeHtml(/^#([0-9a-f]{6})$/i.test(String(m.markColor || m.color || '')) ? String(m.markColor || m.color || '') : '#808080') + '"></div></label>' +
						'<label class="row" style="display:block;margin:0;"><span>Text color</span><div class="colorRow"><input type="text" data-role="mark-text-color" value="' + escapeHtml(m.textColor || '') + '" placeholder="no color (plain text)"><input type="color" class="colorPatch" data-role="mark-text-color-picker" value="' + escapeHtml(/^#([0-9a-f]{6})$/i.test(String(m.textColor || '')) ? String(m.textColor || '') : '#808080') + '"></div></label>' +
					'</div>' +
					'<div class="inlineActions">' + (locked ? '<span class="meta">Locked default mark</span>' : '<button class="iconBtn secondary deleteIcon" data-role="remove-mark" title="Delete Mark">🗑</button>') + '</div>' +
				'</div></div>';
			}
			metadataMarksListEl.innerHTML = html;
		}

		var DOC_COLOR_SLOTS = [
			{ key: 'color1', title: 'Color 1 — Metadata type / shortcut', desc: 'e.g. .concept, .c, c', proxies: ['--vscode-debugTokenExpression-type'], fallback: '#4ec9b0' },
			{ key: 'color2', title: 'Color 2 — Heading line (bold)', desc: 'the whole heading, e.g. # .c My title', proxies: ['--vscode-debugTokenExpression-boolean'], fallback: '#569cd6' },
			{ key: 'color3', title: 'Color 3 — Metadata keys', desc: 'e.g. status, deadline, parent', proxies: ['--vscode-debugTokenExpression-name'], fallback: '#c586c0' },
			{ key: 'color4', title: 'Color 4 — Tag / relation keys', desc: 'e.g. tags, pre-req', proxies: ['--vscode-debugTokenExpression-boolean'], fallback: '#569cd6' },
			{ key: 'color5', title: 'Color 5 — Separators & heading values', desc: '--- section separator, parent/workflow values', proxies: ['--vscode-debugTokenExpression-string'], fallback: '#ce9178' },
			{ key: 'color6', title: 'Color 6 — File identity keys', desc: 'filename, fileid, headings', proxies: ['--vscode-symbolIcon-fieldForeground', '--vscode-debugTokenExpression-boolean'], fallback: '#4fc1ff' },
			{ key: 'color7', title: 'Color 7 — File identity values', desc: 'filename/fileid/headings values, e.g. my-note, @abc123def4, 3', proxies: ['--vscode-debugTokenExpression-string'], fallback: '#ce9178' },
			{ key: 'color8', title: 'Color 8 — Metadata type values', desc: 'status/deadline values, e.g. active, 2026-12-31', proxies: ['--vscode-debugTokenExpression-string'], fallback: '#ce9178' },
			{ key: 'color9', title: 'Color 9 — Tag list values', desc: 'tags/pre-req list values, e.g. [drip, notes]', proxies: ['--vscode-debugTokenExpression-string'], fallback: '#ce9178' }
		];

		function normalizeDocColors(raw) {
			var out = { color1: '', color2: '', color3: '', color4: '', color5: '', color6: '', color7: '', color8: '', color9: '' };
			raw = raw || {};
			for (var i = 1; i <= 9; i++) {
				var key = 'color' + i;
				var v = String(raw[key] || '').trim();
				out[key] = /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : '';
			}
			return out;
		}

		function docColorCss(key) {
			return docColorHex(key);
		}

		function docSpan(color, bold, text) {
			return '<span class="' + (bold ? 'bold' : '') + '" style="color:' + color + '">' + escapeHtml(text) + '</span>';
		}

		function cssColorToHex(colorStr) {
			var m = String(colorStr || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
			if (!m) return '';
			var r = parseInt(m[1], 10);
			var g = parseInt(m[2], 10);
			var b = parseInt(m[3], 10);
			var a = m[4] != null ? parseFloat(m[4]) : 1;
			if (a < 1) {
				r = Math.round(r * a + 255 * (1 - a));
				g = Math.round(g * a + 255 * (1 - a));
				b = Math.round(b * a + 255 * (1 - a));
			}
			function hx(n) { var h = n.toString(16); return h.length === 1 ? '0' + h : h; }
			return '#' + hx(r) + hx(g) + hx(b);
		}

		function readThemeVar(name) {
			var v = getComputedStyle(document.documentElement).getPropertyValue(name);
			return (v && String(v).trim()) ? String(v).trim() : '';
		}

		function themeVarToHex(name) {
			var raw = readThemeVar(name);
			if (!raw) return '';
			return normalizeHexColor(raw) || cssColorToHex(raw);
		}

		function docColorHex(key) {
			var val = String(docColorsState[key] || '').trim();
			if (/^#[0-9a-f]{6}$/i.test(val)) return val;
			// Prefer the real color the editor shows (resolved in the extension host).
			if (docThemeColors && /^#[0-9a-f]{6}$/i.test(String(docThemeColors[key] || ''))) {
				return String(docThemeColors[key]).toLowerCase();
			}
			for (var i = 0; i < DOC_COLOR_SLOTS.length; i++) {
				var slot = DOC_COLOR_SLOTS[i];
				if (slot.key !== key) continue;
				for (var p = 0; p < slot.proxies.length; p++) {
					var hex = themeVarToHex(slot.proxies[p]);
					if (hex) return hex;
				}
				return slot.fallback;
			}
			return '#808080';
		}

		function renderDocColoringRows() {
			var rowsHtml = '';
			for (var i = 0; i < DOC_COLOR_SLOTS.length; i++) {
				var slot = DOC_COLOR_SLOTS[i];
				var pickerVal = docColorHex(slot.key);
				rowsHtml += '<div class="docColorRow" data-slot="' + slot.key + '">' +
					'<div class="lbl"><span class="t">' + escapeHtml(slot.title) + '</span><span class="d">' + escapeHtml(slot.desc) + '</span></div>' +
					'<input type="color" class="swatch" data-role="doc-color-picker" value="' + escapeHtml(pickerVal) + '">' +
					'</div>';
			}
			docColoringRowsEl.innerHTML = rowsHtml;
		}

		function renderDocColoringSample() {
			var c = {};
			for (var k = 1; k <= 9; k++) c['color' + k] = docColorCss('color' + k);
			var plain = 'var(--vscode-foreground)';
			var s = '';
			s += docSpan(c.color6, false, 'filename') + docSpan(plain, false, ': ') + docSpan(c.color7, false, 'my-note') + '\n';
			s += docSpan(c.color6, false, 'fileid') + docSpan(plain, false, ': ') + docSpan(c.color7, false, '@abc123def4') + '\n';
			s += docSpan(c.color6, false, 'headings') + docSpan(plain, false, ': ') + docSpan(c.color7, false, '3') + '\n';
			s += docSpan(c.color5, false, '---') + '\n';
			s += docSpan(c.color2, true, '# ') + docSpan(c.color1, true, '.c') + docSpan(c.color2, true, ' My Concept') + '\n';
			s += docSpan(c.color3, false, 'status') + docSpan(plain, false, ': ') + docSpan(c.color8, false, 'active') + '\n';
			s += docSpan(c.color3, false, 'deadline') + docSpan(plain, false, ': ') + docSpan(c.color8, false, '2026-12-31') + '\n';
			s += docSpan(c.color4, false, 'tags') + docSpan(plain, false, ': ') + docSpan(c.color9, false, '[drip, notes]') + '\n';
			s += docSpan(c.color4, false, 'pre-req') + docSpan(plain, false, ': ') + docSpan(c.color9, false, '[setup]') + '\n';
			docColoringSampleEl.innerHTML = s;
		}

		function renderDocColoring() {
			renderDocColoringRows();
			renderDocColoringSample();
		}

		function collectTypesForSave() {
			var out = [];
			for (var i = 0; i < metadataTypesState.length; i++) {
				var t = metadataTypesState[i] || {};
				var id = String(t.id || '').trim().toLowerCase();
				var marker = String(t.marker || '').trim().toLowerCase();
				if (marker && !marker.startsWith('.')) marker = '.' + marker;
				if (!id || !marker) continue;
				var attrsObj = {};
				var attrs = Array.isArray(t.attributes) ? t.attributes : [];
				for (var j = 0; j < attrs.length; j++) {
					var a = attrs[j] || {};
					var k = String(a.key || '').trim().toLowerCase();
					if (!k) continue;
					var kind = normalizeAttributeKind(a.kind);
					var values = kind === 'enum' && Array.isArray(a.values)
						? a.values.map(function (x) { return String(x || '').trim().toLowerCase(); }).filter(Boolean)
						: [];
					var entry = {
						kind: kind,
						default: kind === 'enum' ? String(a.default != null ? a.default : '').trim() : '',
						required: !!a.required
					};
					if (kind === 'enum') entry.values = values;
					attrsObj[k] = entry;
				}
				out.push({
					id: id,
					marker: marker,
					shortcut: String(t.shortcut != null ? t.shortcut : '').trim(),
					displayTemplate: t.displayTemplate !== false,
					attributes: attrsObj
				});
			}
			return out;
		}

		for (var iNav = 0; iNav < navButtons.length; iNav++) {
			(function (btn) {
				btn.addEventListener('click', function () {
					var panelId = btn.getAttribute('data-panel');
					showPanel(panelId);
					if (panelId === 'saved-settings') {
						vscode.postMessage({ type: 'requestSettings' });
					}
					if (panelId === 'shortcuts') {
						vscode.postMessage({ type: 'requestShortcuts' });
					}
				});
			})(navButtons[iNav]);
		}

		function lowerList(arr) {
			return (arr || []).map(function (x) { return String(x).trim().toLowerCase(); });
		}

		function normalizeExtEntry(s) {
			var t = String(s || '').trim().toLowerCase();
			return t.indexOf('.') === 0 ? t : (t ? '.' + t : '');
		}

		function mergeKbExtensionsList() {
			var seen = {};
			var out = [];
			function add(x) {
				var n = normalizeExtEntry(x);
				if (n && !seen[n]) {
					seen[n] = true;
					out.push(n);
				}
			}
			for (var i = 0; i < preservedOtherExts.length; i++) {
				add(preservedOtherExts[i]);
			}
			if (kbExtDtxt.checked) add('.d.txt');
			if (kbExtMd.checked) add('.md');
			if (!out.length) add('.d.txt');
			return out;
		}

		function rebuildDefaultSelect(exts, selected) {
			kbDefaultExt.innerHTML = '';
			var list = exts && exts.length ? exts : ['.d.txt', '.md'];
			for (var i = 0; i < list.length; i++) {
				var opt = document.createElement('option');
				opt.value = list[i];
				opt.textContent = list[i];
				kbDefaultExt.appendChild(opt);
			}
			var want = String(selected || list[0] || '.d.txt').toLowerCase();
			var found = null;
			for (var j = 0; j < list.length; j++) {
				if (String(list[j]).toLowerCase() === want) {
					found = list[j];
					break;
				}
			}
			kbDefaultExt.value = found || list[0];
		}

		function pushKbExtensionSettings() {
			var exts = mergeKbExtensionsList();
			vscode.postMessage({ type: 'updateSetting', key: 'knowledgeBaseFileExtensions', value: exts });
			rebuildDefaultSelect(exts, kbDefaultExt.value);
			var cur = String(kbDefaultExt.value).toLowerCase();
			var ok = false;
			for (var i = 0; i < exts.length; i++) {
				if (String(exts[i]).toLowerCase() === cur) {
					ok = true;
					break;
				}
			}
			if (!ok) {
				kbDefaultExt.value = exts[0];
			}
			vscode.postMessage({ type: 'updateSetting', key: 'defaultNewNoteExtension', value: kbDefaultExt.value });
		}

		window.addEventListener('message', function (event) {
			var message = event.data;
			if (message.type !== 'settingsValues') return;
			autoOpenEl.checked = !!message.autoOpenComposerOnSidebarReveal;
			var raw = message.knowledgeBaseFileExtensions || [];
			var low = lowerList(raw);
			preservedOtherExts = raw.filter(function (e) {
				var l = String(e).trim().toLowerCase();
				return l !== '.d.txt' && l !== '.md';
			});
			kbExtDtxt.checked = low.indexOf('.d.txt') >= 0;
			kbExtMd.checked = low.indexOf('.md') >= 0;
			if (!kbExtDtxt.checked && !kbExtMd.checked && preservedOtherExts.length === 0) {
				kbExtDtxt.checked = true;
			}
			rebuildDefaultSelect(mergeKbExtensionsList(), message.defaultNewNoteExtension || '.d.txt');
			optTemplateEnabled.checked = !!message.metadataTemplatesEnabled;
			optTemplateAuto.checked = !!message.metadataAutoInsertTemplate;
			optTemplateStrict.checked = !!message.metadataStrictValidation;
			optTemplateIgnore.checked = !!message.metadataIgnoreErrors;
			optTemplateIndentErrors.checked = !!message.metadataShowIndentErrors;
			optHeadingHierarchyIndent.checked = !!message.showHeadingHierarchyIndentErrors;
			metadataTypesState = normalizeTypesFromSettings(message.metadataTypes);
			renderMetadataTypes();
			fileLevelTypesState = normalizeTypesFromSettings(
				message.fileLevelMetadataTypes && message.fileLevelMetadataTypes.length
					? message.fileLevelMetadataTypes
					: defaultFileLevelMetadataTypes
			);
			renderFileLevelTypes();
			var tr = message.tagsRelationsConfig || {};
			relationsState = Array.isArray(tr.relations) && tr.relations.length ? tr.relations : [
				{ name: 'tags', description: 'Special default relation for tags.', locked: true },
				{ name: 'pre-req', description: 'Prerequisite relation.', locked: false }
			];
			if (!relationsState.some(function (x) { return String((x && x.name) || '').toLowerCase() === 'tags'; })) {
				relationsState.unshift({ name: 'tags', description: 'Special default relation for tags.', locked: true });
			}
			metadataMarksState = (message.dripMetadataMarks && Array.isArray(message.dripMetadataMarks.marks) && message.dripMetadataMarks.marks.length)
				? message.dripMetadataMarks.marks
				: [
					{ name: 'L', description: 'Link marker. Example: L: ![file-name - @fileid](rel/path/to/file)', markColor: '', textColor: '', locked: true },
					{ name: 'Q', description: 'Question marker.', markColor: '', textColor: '', locked: false },
					{ name: 'R', description: 'Reference marker.', markColor: '', textColor: '', locked: false }
				];
			renderRelations();
			renderMetadataMarks();
			docColorsState = normalizeDocColors(message.dripnoteDocColors);
			docThemeColors = message.dripnoteDocThemeColors || null;
			renderDocColoring();
			if (optEditHeadingsRhs) optEditHeadingsRhs.checked = message.editHeadingsViaRhs !== false;
			if (optEditHeadingsFile) optEditHeadingsFile.checked = !!message.editHeadingsInFile && message.editHeadingsViaRhs === false;
			if (savedSettingsPathEl) {
				var p = String(message.kbSettingsFilePath || '').trim();
				savedSettingsPathEl.textContent = p || '(no knowledge base selected — bind a .driplock folder first)';
			}
			applyGithubBackupStatus(message.githubBackupStatus || null);
			applyMcpStatus(message.mcpStatus || null);
			applyLlmStatus(message.llmStatus || null);
		});

		window.addEventListener('message', function (event) {
			var message = event.data;
			if (message.type === 'githubBackupStatus') {
				applyGithubBackupStatus(message.status || null);
			} else if (message.type === 'mcpStatus') {
				applyMcpStatus(message.status || null);
			} else if (message.type === 'showPanel' && panels[message.panel]) {
				showPanel(message.panel);
			} else if (message.type === 'docThemeColors') {
				docThemeColors = message.colors || null;
				renderDocColoring();
			}
		});

		function setText(id, value) {
			var el = document.getElementById(id);
			if (el) el.textContent = value == null ? '' : String(value);
		}

		function applyMcpStatus(st) {
			if (!st) return;
			var enabledEl = document.getElementById('mcp-enabled');
			var portEl = document.getElementById('mcp-port');
			var dot = document.getElementById('mcp-dot');
			if (enabledEl) enabledEl.checked = !!st.enabled;
			if (portEl && document.activeElement !== portEl) portEl.value = String(st.port || '');
			var line = !st.enabled
				? 'Off — turn it on to let AI apps connect.'
				: st.running
					? 'Running at ' + st.url
					: 'Turned on, but not running.';
			setText('mcp-status-line', line);
			setText('mcp-error', st.enabled && st.error ? st.error : '');
			if (dot) {
				dot.classList.toggle('on', !!(st.enabled && st.running));
				dot.classList.toggle('err', !!(st.enabled && !st.running));
			}
			setText('mcp-name', st.serverName);
			setText('mcp-url', st.url);
			setText('mcp-transport', st.transport);
			setText('mcp-header', st.authHeader);
			setText('mcp-token', st.hasToken ? st.tokenPreview : 'created when the server first starts');
			setText('mcp-tools', 'search_tools + call_tool (' + st.toolCount + ' DRIP tools behind them)');
			setText('mcp-http-config', st.httpConfigPreview);
			setText('mcp-stdio-config', st.stdioConfigPreview);
		}

		function applyLlmStatus(st) {
			if (!st) return;
			if (llmEnabledEl) llmEnabledEl.checked = !!st.enabled;
			if (llmBaseUrlEl && document.activeElement !== llmBaseUrlEl) llmBaseUrlEl.value = String(st.baseUrl || '');
			if (llmModelEl && document.activeElement !== llmModelEl) llmModelEl.value = String(st.model || '');
			setText('llm-key-status', st.hasKey ? 'API key: saved (Secret Storage)' : 'API key: not set');
		}

		function fmtTime(iso) {
			if (!iso) return 'never';
			try {
				return new Date(iso).toLocaleString();
			} catch (e) {
				return String(iso);
			}
		}

		function applyGithubBackupStatus(st) {
			var statusLine = document.getElementById('gh-status-line');
			var statusDetail = document.getElementById('gh-status-detail');
			var statusError = document.getElementById('gh-status-error');
			var remoteEl = document.getElementById('gh-remote-url');
			var branchEl = document.getElementById('gh-branch');
			var patStatus = document.getElementById('gh-pat-status');
			if (!statusLine) return;
			if (!st) {
				statusLine.textContent = 'Select a knowledge base to configure backup.';
				if (statusDetail) statusDetail.textContent = '';
				if (statusError) statusError.textContent = '';
				if (patStatus) patStatus.textContent = 'Token: not set';
				return;
			}
			if (!st.gitAvailable) {
				statusLine.textContent = 'Git not found on PATH — install Git, then reload.';
			} else if (st.connected) {
				statusLine.textContent = 'Connected — ready to push / pull.';
			} else if (st.isRepo && st.remoteUrl) {
				statusLine.textContent = 'Repo ready — save remote and Initialize if origin is missing.';
			} else if (st.remoteUrl) {
				statusLine.textContent = 'Remote saved — run Initialize backup.';
			} else {
				statusLine.textContent = 'Not connected — enter a remote URL.';
			}
			var bits = [];
			if (st.branch) bits.push('branch: ' + st.branch);
			bits.push('last push: ' + fmtTime(st.lastPushAt));
			bits.push('last pull: ' + fmtTime(st.lastPullAt));
			if (st.dirty) bits.push('uncommitted changes');
			if (statusDetail) statusDetail.textContent = bits.join(' · ');
			if (statusError) statusError.textContent = st.lastError ? String(st.lastError) : '';
			if (remoteEl && document.activeElement !== remoteEl) {
				remoteEl.value = String(st.remoteUrl || '');
			}
			if (branchEl && document.activeElement !== branchEl) {
				branchEl.value = String(st.branch || 'main');
			}
			if (patStatus) {
				patStatus.textContent = st.hasPat ? 'Token: saved (Secret Storage)' : 'Token: not set';
			}
		}

		vscode.postMessage({ type: 'requestSettings' });

		autoOpenEl.addEventListener('change', function () {
			vscode.postMessage({ type: 'updateSetting', key: 'autoOpenComposerOnSidebarReveal', value: autoOpenEl.checked });
		});
		kbExtDtxt.addEventListener('change', function () {
			if (!kbExtDtxt.checked && !kbExtMd.checked) kbExtMd.checked = true;
			pushKbExtensionSettings();
		});
		kbExtMd.addEventListener('change', function () {
			if (!kbExtDtxt.checked && !kbExtMd.checked) kbExtDtxt.checked = true;
			pushKbExtensionSettings();
		});
		kbDefaultExt.addEventListener('change', function () {
			vscode.postMessage({ type: 'updateSetting', key: 'defaultNewNoteExtension', value: kbDefaultExt.value });
		});
		function postBool(el, key) { vscode.postMessage({ type: 'updateSetting', key: key, value: !!el.checked }); }
		optTemplateEnabled.addEventListener('change', function(){ postBool(optTemplateEnabled, 'metadataTemplatesEnabled'); });
		optTemplateAuto.addEventListener('change', function(){ postBool(optTemplateAuto, 'metadataAutoInsertTemplate'); });
		optTemplateStrict.addEventListener('change', function(){ postBool(optTemplateStrict, 'metadataStrictValidation'); });
		optTemplateIgnore.addEventListener('change', function(){ postBool(optTemplateIgnore, 'metadataIgnoreErrors'); });
		optTemplateIndentErrors.addEventListener('change', function(){ postBool(optTemplateIndentErrors, 'metadataShowIndentErrors'); });
		optHeadingHierarchyIndent.addEventListener('change', function(){ postBool(optHeadingHierarchyIndent, 'showHeadingHierarchyIndentErrors'); });
		function parseJsonArea(el, fallback) {
			try { return JSON.parse(String(el.value || '')); } catch { return fallback; }
		}
		document.getElementById('btn-add-type').addEventListener('click', function () {
			addNewType();
		});
		metadataTypesListEl.addEventListener('input', function (ev) {
			var target = ev.target;
			if (!target) return;
			var body = target.closest('[data-type-index]');
			if (!body) return;
			var typeIndex = Number(body.getAttribute('data-type-index'));
			if (!Number.isFinite(typeIndex) || !metadataTypesState[typeIndex]) return;
			var role = target.getAttribute('data-role');
			var typeRef = metadataTypesState[typeIndex];
			if (role === 'type-id') typeRef.id = String(target.value || '').trim().toLowerCase();
			if (role === 'type-marker') {
				var markerVal = String(target.value || '').trim().toLowerCase();
				typeRef.marker = markerVal ? (markerVal.startsWith('.') ? markerVal : '.' + markerVal) : '';
				target.value = typeRef.marker;
			}
			if (role === 'type-shortcut') {
				typeRef.shortcut = String(target.value != null ? target.value : '').trim();
				return;
			}
			if (role === 'type-display-template') typeRef.displayTemplate = !!target.checked;
			var row = target.closest('tr[data-attr-index]');
			if (row) {
				var attrIndex = Number(row.getAttribute('data-attr-index'));
				if (Number.isFinite(attrIndex) && typeRef.attributes && typeRef.attributes[attrIndex]) {
					var attr = typeRef.attributes[attrIndex];
					if (role === 'attr-key') attr.key = String(target.value || '').trim().toLowerCase();
					if (role === 'attr-kind') {
						attr.kind = normalizeAttributeKind(target.value);
						normalizeAttrByKind(attr);
						renderMetadataTypes();
						return;
					}
					if (role === 'attr-values') {
						if (normalizeAttributeKind(attr.kind) !== 'enum') return;
						attr.values = String(target.value || '')
							.split(',')
							.map(function (x) { return String(x || '').trim(); })
							.filter(Boolean);
						return;
					}
					if (role === 'attr-required') attr.required = !!target.checked;
				}
			}
		});
		metadataTypesListEl.addEventListener('change', function (ev) {
			var target = ev.target;
			if (!target) return;
			var role = target.getAttribute('data-role');
			if (role !== 'attr-values') return;
			var row = target.closest('tr[data-attr-index]');
			if (!row) return;
			var scope = target.closest('[data-type-index]');
			if (!scope) return;
			var typeIndex = Number(scope.getAttribute('data-type-index'));
			var attrIndex = Number(row.getAttribute('data-attr-index'));
			if (!Number.isFinite(typeIndex) || !Number.isFinite(attrIndex)) return;
			var typeRef = metadataTypesState[typeIndex];
			if (!typeRef || !typeRef.attributes || !typeRef.attributes[attrIndex]) return;
			var attr = typeRef.attributes[attrIndex];
			if (normalizeAttributeKind(attr.kind) !== 'enum') return;
			attr.values = String(target.value || '')
				.split(',')
				.map(function (x) { return String(x || '').trim(); })
				.filter(Boolean);
			sanitizeEnumDefault(attr);
			renderMetadataTypes();
		});
		metadataTypesListEl.addEventListener('click', function (ev) {
			var target = ev.target;
			if (!target) return;
			var role = target.getAttribute('data-role');
			if (!role) return;
			var scope = target.closest('[data-type-index]');
			if (!scope) return;
			var typeIndex = Number(scope.getAttribute('data-type-index'));
			if (!Number.isFinite(typeIndex) || !metadataTypesState[typeIndex]) return;
			if (role === 'remove-type') {
				if (isLockedMetadataType(metadataTypesState[typeIndex])) return;
				ev.preventDefault();
				ev.stopPropagation();
				metadataTypesState.splice(typeIndex, 1);
				renderMetadataTypes();
				return;
			}
			if (role === 'add-attr') {
				ev.preventDefault();
				ev.stopPropagation();
				if (!Array.isArray(metadataTypesState[typeIndex].attributes)) metadataTypesState[typeIndex].attributes = [];
				metadataTypesState[typeIndex].attributes.push({ key: '', kind: 'enum', values: [], default: '', required: false });
				renderMetadataTypes();
				return;
			}
			if (role === 'remove-attr') {
				ev.preventDefault();
				ev.stopPropagation();
				var row = target.closest('tr[data-attr-index]');
				if (!row) return;
				var attrIndex = Number(row.getAttribute('data-attr-index'));
				if (!Number.isFinite(attrIndex)) return;
				var attrKey = metadataTypesState[typeIndex].attributes[attrIndex] && metadataTypesState[typeIndex].attributes[attrIndex].key;
				if (isBuiltInAttributeKey(metadataTypesState[typeIndex].id, attrKey)) return;
				metadataTypesState[typeIndex].attributes.splice(attrIndex, 1);
				renderMetadataTypes();
			}
		});
		fileLevelTypesListEl.addEventListener('input', function (ev) {
			var target = ev.target;
			if (!target) return;
			var body = target.closest('[data-type-index]');
			if (!body) return;
			var typeIndex = Number(body.getAttribute('data-type-index'));
			var stateArr = body.getAttribute('data-source') === 'document' ? metadataTypesState : fileLevelTypesState;
			if (!Number.isFinite(typeIndex) || !stateArr[typeIndex]) return;
			var role = target.getAttribute('data-role');
			var typeRef = stateArr[typeIndex];
			var row = target.closest('tr[data-attr-index]');
			if (row) {
				var attrIndex = Number(row.getAttribute('data-attr-index'));
				if (Number.isFinite(attrIndex) && typeRef.attributes && typeRef.attributes[attrIndex]) {
					var attr = typeRef.attributes[attrIndex];
					if (role === 'attr-key') attr.key = String(target.value || '').trim().toLowerCase();
					if (role === 'attr-kind') {
						attr.kind = normalizeAttributeKind(target.value);
						normalizeAttrByKind(attr);
						renderFileLevelTypes();
						return;
					}
					if (role === 'attr-values') {
						if (normalizeAttributeKind(attr.kind) !== 'enum') return;
						attr.values = String(target.value || '')
							.split(',')
							.map(function (x) { return String(x || '').trim(); })
							.filter(Boolean);
						return;
					}
					if (role === 'attr-required') attr.required = !!target.checked;
				}
			}
		});
		fileLevelTypesListEl.addEventListener('click', function (ev) {
			var target = ev.target;
			if (!target) return;
			var role = target.getAttribute('data-role');
			if (!role) return;
			var scope = target.closest('[data-type-index]');
			if (!scope) return;
			var typeIndex = Number(scope.getAttribute('data-type-index'));
			var stateArr = scope.getAttribute('data-source') === 'document' ? metadataTypesState : fileLevelTypesState;
			if (!Number.isFinite(typeIndex) || !stateArr[typeIndex]) return;
			if (role === 'add-attr') {
				ev.preventDefault();
				ev.stopPropagation();
				if (!Array.isArray(stateArr[typeIndex].attributes)) stateArr[typeIndex].attributes = [];
				stateArr[typeIndex].attributes.push({ key: '', kind: 'enum', values: [], default: '', required: false });
				renderFileLevelTypes();
				return;
			}
			if (role === 'remove-attr') {
				ev.preventDefault();
				ev.stopPropagation();
				var row = target.closest('tr[data-attr-index]');
				if (!row) return;
				var attrIndex = Number(row.getAttribute('data-attr-index'));
				if (!Number.isFinite(attrIndex)) return;
				var attrKey = stateArr[typeIndex].attributes[attrIndex] && stateArr[typeIndex].attributes[attrIndex].key;
				if (isBuiltInAttributeKey(stateArr[typeIndex].id, attrKey)) return;
				stateArr[typeIndex].attributes.splice(attrIndex, 1);
				renderFileLevelTypes();
			}
		});
		document.getElementById('btn-save-types').addEventListener('click', function () {
			var types = collectTypesForSave();
			vscode.postMessage({ type: 'updateSetting', key: 'metadataTypes', value: types.length ? types : defaultMetadataTypes });
		});
		document.getElementById('btn-reset-types').addEventListener('click', function () {
			metadataTypesState = normalizeTypesFromSettings(defaultMetadataTypes);
			renderMetadataTypes();
			renderFileLevelTypes();
			vscode.postMessage({ type: 'updateSetting', key: 'metadataTypes', value: defaultMetadataTypes });
		});
		document.getElementById('btn-save-file-types').addEventListener('click', function () {
			// The Projects card edits issue too, and issue lives in metadataTypes — save both.
			var types = collectTypesForSave();
			vscode.postMessage({
				type: 'updateSetting',
				key: 'fileLevelMetadataTypes',
				value: collectFileLevelTypesForSave()
			});
			vscode.postMessage({ type: 'updateSetting', key: 'metadataTypes', value: types.length ? types : defaultMetadataTypes });
		});
		document.getElementById('btn-reset-file-types').addEventListener('click', function () {
			fileLevelTypesState = normalizeTypesFromSettings(defaultFileLevelMetadataTypes);
			resetIssueType();
			renderFileLevelTypes();
			vscode.postMessage({
				type: 'updateSetting',
				key: 'fileLevelMetadataTypes',
				value: defaultFileLevelMetadataTypes
			});
			var types = collectTypesForSave();
			vscode.postMessage({ type: 'updateSetting', key: 'metadataTypes', value: types.length ? types : defaultMetadataTypes });
		});
		document.getElementById('btn-save-metadata-panel').addEventListener('click', function () {
			postBool(optTemplateEnabled, 'metadataTemplatesEnabled');
			postBool(optTemplateAuto, 'metadataAutoInsertTemplate');
			postBool(optTemplateStrict, 'metadataStrictValidation');
			postBool(optTemplateIgnore, 'metadataIgnoreErrors');
			postBool(optTemplateIndentErrors, 'metadataShowIndentErrors');
			postBool(optHeadingHierarchyIndent, 'showHeadingHierarchyIndentErrors');
			var types = collectTypesForSave();
			vscode.postMessage({ type: 'updateSetting', key: 'metadataTypes', value: types.length ? types : defaultMetadataTypes });
			vscode.postMessage({
				type: 'updateSetting',
				key: 'fileLevelMetadataTypes',
				value: collectFileLevelTypesForSave()
			});
		});
		document.getElementById('btn-add-relation').addEventListener('click', function () {
			relationsState.push({ name: 'new-relation', description: '', locked: false });
			renderRelations();
		});
		relationsListEl.addEventListener('input', function (ev) {
			var target = ev.target;
			if (!target) return;
			var body = target.closest('[data-rel-index]');
			if (!body) return;
			var idx = Number(body.getAttribute('data-rel-index'));
			if (!Number.isFinite(idx) || !relationsState[idx]) return;
			var role = target.getAttribute('data-role');
			if (role === 'rel-name') relationsState[idx].name = String(target.value || '').trim();
			if (role === 'rel-desc') relationsState[idx].description = String(target.value || '');
		});
		relationsListEl.addEventListener('click', function (ev) {
			var target = ev.target;
			if (!target || target.getAttribute('data-role') !== 'remove-rel') return;
			ev.preventDefault();
			var body = target.closest('[data-rel-index]');
			if (!body) return;
			var idx = Number(body.getAttribute('data-rel-index'));
			if (!Number.isFinite(idx) || !relationsState[idx]) return;
			if (String(relationsState[idx].name || '').toLowerCase() === 'tags' || relationsState[idx].locked) return;
			relationsState.splice(idx, 1);
			renderRelations();
		});
		document.getElementById('btn-save-relations').addEventListener('click', function () {
			var rows = relationsState
				.map(function (r) {
					return {
						name: String((r && r.name) || '').trim(),
						description: String((r && r.description) || ''),
						locked: !!(r && r.locked) || String((r && r.name) || '').toLowerCase() === 'tags'
					};
				})
				.filter(function (r) { return !!r.name; });
			if (!rows.some(function (x) { return String(x.name || '').toLowerCase() === 'tags'; })) {
				rows.unshift({ name: 'tags', description: 'Special default relation for tags.', locked: true });
			}
			var allowed = rows.map(function (x) { return String(x.name || '').toLowerCase(); }).filter(Boolean);
			vscode.postMessage({
				type: 'updateSetting',
				key: 'tagsRelationsConfig',
				value: {
					relations: rows,
					allowed: allowed
				}
			});
		});
		document.getElementById('btn-add-metadata-mark').addEventListener('click', function () {
			metadataMarksState.push({ name: 'X', description: '', color: '', locked: false });
			renderMetadataMarks();
		});
		metadataMarksListEl.addEventListener('input', function (ev) {
			var target = ev.target;
			if (!target) return;
			var body = target.closest('[data-mark-index]');
			if (!body) return;
			var idx = Number(body.getAttribute('data-mark-index'));
			if (!Number.isFinite(idx) || !metadataMarksState[idx]) return;
			var role = target.getAttribute('data-role');
			if (role === 'mark-name') metadataMarksState[idx].name = String(target.value || '').trim();
			if (role === 'mark-desc') metadataMarksState[idx].description = String(target.value || '');
			if (role === 'mark-color') {
				metadataMarksState[idx].markColor = String(target.value || '').trim();
				var markPicker = body.querySelector('input[data-role="mark-color-picker"]');
				syncColorPickerFromText(target, markPicker);
			}
			if (role === 'mark-text-color') {
				metadataMarksState[idx].textColor = String(target.value || '').trim();
				var textPicker = body.querySelector('input[data-role="mark-text-color-picker"]');
				syncColorPickerFromText(target, textPicker);
			}
			if (role === 'mark-color-picker') {
				metadataMarksState[idx].markColor = String(target.value || '').trim().toLowerCase();
				var markText = body.querySelector('input[data-role="mark-color"]');
				if (markText) markText.value = metadataMarksState[idx].markColor;
			}
			if (role === 'mark-text-color-picker') {
				metadataMarksState[idx].textColor = String(target.value || '').trim().toLowerCase();
				var textColorText = body.querySelector('input[data-role="mark-text-color"]');
				if (textColorText) textColorText.value = metadataMarksState[idx].textColor;
			}
		});
		metadataMarksListEl.addEventListener('click', function (ev) {
			var target = ev.target;
			if (!target) return;
			var role = target.getAttribute('data-role');
			if (!role) return;
			if (role !== 'remove-mark') return;
			ev.preventDefault();
			var body = target.closest('[data-mark-index]');
			if (!body) return;
			var idx = Number(body.getAttribute('data-mark-index'));
			if (!Number.isFinite(idx) || !metadataMarksState[idx]) return;
			if (String(metadataMarksState[idx].name || '') === 'L' || metadataMarksState[idx].locked) return;
			metadataMarksState.splice(idx, 1);
			renderMetadataMarks();
		});
		document.getElementById('btn-save-metadata-marks').addEventListener('click', function () {
			var marks = metadataMarksState
				.map(function (m) {
					return {
						name: String((m && m.name) || '').trim(),
						description: String((m && m.description) || ''),
						markColor: String((m && (m.markColor || m.color)) || '').trim(),
						textColor: String((m && m.textColor) || '').trim(),
						locked: !!(m && m.locked) || String((m && m.name) || '') === 'L'
					};
				})
				.filter(function (m) { return !!m.name; });
			if (!marks.some(function (m) { return m.name === 'L'; })) {
				marks.unshift({ name: 'L', description: 'Link marker. Example: L: ![file-name - @fileid](rel/path/to/file)', markColor: '', textColor: '', locked: true });
			}
			vscode.postMessage({ type: 'updateSetting', key: 'dripMetadataMarks', value: { marks: marks } });
		});
		docColoringRowsEl.addEventListener('input', function (ev) {
			var target = ev.target;
			if (!target || target.getAttribute('data-role') !== 'doc-color-picker') return;
			var row = target.closest('[data-slot]');
			if (!row) return;
			var slot = row.getAttribute('data-slot');
			if (!slot || !(slot in docColorsState)) return;
			docColorsState[slot] = String(target.value || '').trim().toLowerCase();
			renderDocColoringSample();
		});
		document.getElementById('btn-save-doc-colors').addEventListener('click', function () {
			vscode.postMessage({ type: 'updateSetting', key: 'dripnoteDocColors', value: docColorsState });
		});
		document.getElementById('btn-revert-doc-colors').addEventListener('click', function () {
			docColorsState = { color1: '', color2: '', color3: '', color4: '', color5: '', color6: '', color7: '', color8: '', color9: '' };
			renderDocColoring();
			vscode.postMessage({ type: 'updateSetting', key: 'dripnoteDocColors', value: docColorsState });
		});
		document.getElementById('btn-keys').addEventListener('click', function () {
			vscode.postMessage({ type: 'openKeyboardShortcuts' });
		});
		document.getElementById('btn-keys-file').addEventListener('click', function () {
			vscode.postMessage({ type: 'openKeybindingsFile' });
		});

		var shortcutRowsEl = document.getElementById('shortcut-rows');
		var IS_MAC = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
		var CODE_TO_KEY = {
			Space: 'space', Enter: 'enter', Tab: 'tab', Backspace: 'backspace', Delete: 'delete', Insert: 'insert',
			Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
			ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
			Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
			Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`'
		};
		function keyFromEvent(e) {
			var code = e.code || '';
			var base = '';
			if (/^Key[A-Z]$/.test(code)) base = code.slice(3).toLowerCase();
			else if (/^Digit[0-9]$/.test(code)) base = code.slice(5);
			else if (/^Numpad[0-9]$/.test(code)) base = 'numpad' + code.slice(6);
			else if (/^F([1-9]|1[0-9])$/.test(code)) base = code.toLowerCase();
			else if (CODE_TO_KEY[code]) base = CODE_TO_KEY[code];
			if (!base) return '';
			var parts = [];
			if (e.ctrlKey) parts.push('ctrl');
			if (e.shiftKey) parts.push('shift');
			if (e.altKey) parts.push('alt');
			if (e.metaKey) parts.push(IS_MAC ? 'cmd' : 'win');
			parts.push(base);
			return parts.join('+');
		}
		function prettyKey(k) {
			return String(k || '').split(' ').map(function (chord) {
				return chord.split('+').map(function (p) {
					return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
				}).join('+');
			}).join(' ');
		}
		function renderShortcuts(data) {
			var rows = (data && data.rows) || [];
			setText('shortcut-error', data && data.error ? data.error : '');
			if (!rows.length) {
				shortcutRowsEl.innerHTML = '<tr><td colspan="4" class="meta">No DRIP commands found.</td></tr>';
				return;
			}
			var html = '';
			for (var i = 0; i < rows.length; i++) {
				var r = rows[i];
				var current = r.keys.length
					? r.keys.map(function (k) { return '<kbd>' + escapeHtml(prettyKey(k)) + '</kbd>'; }).join('')
					: '<span class="meta">(none)</span>';
				var def = r.defaultKey ? 'Default: ' + prettyKey(r.defaultKey) : 'No default';
				var conflict = r.conflicts && r.conflicts.length
					? '<div class="sc-conflict">Also bound: ' + escapeHtml(r.conflicts.map(prettyKey).join(', ')) + '</div>'
					: '';
				html += '<tr data-command="' + escapeHtml(r.id) + '">' +
					'<td>' + escapeHtml(r.title) + '<div class="meta"><code>' + escapeHtml(r.id) + '</code></div></td>' +
					'<td>' + current + conflict + '</td>' +
					'<td><input type="text" class="sc-record" readonly placeholder="Click, then press keys" title="' + escapeHtml(def) + '"></td>' +
					'<td><div class="sc-actions">' +
						'<button type="button" data-sc="set">Save</button>' +
						'<button type="button" class="secondary" data-sc="reset"' + (r.customized ? '' : ' disabled') + ' title="' + escapeHtml(def) + '">Reset</button>' +
						'<button type="button" class="secondary" data-sc="remove"' + (r.keys.length ? '' : ' disabled') + '>Remove</button>' +
					'</div></td>' +
				'</tr>';
			}
			shortcutRowsEl.innerHTML = html;
		}
		shortcutRowsEl.addEventListener('keydown', function (e) {
			var input = e.target;
			if (!input || !input.classList || !input.classList.contains('sc-record')) return;
			// Keep the keystroke inside this box so VS Code does not also run the shortcut.
			e.preventDefault();
			e.stopPropagation();
			if (e.key === 'Escape') {
				input.value = '';
				input.blur();
				return;
			}
			if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && input.value) {
				input.value = '';
				return;
			}
			var k = keyFromEvent(e);
			if (!k) return;
			input.dataset.key = k;
			input.value = prettyKey(k);
		});
		shortcutRowsEl.addEventListener('click', function (e) {
			var btn = e.target && e.target.closest ? e.target.closest('button[data-sc]') : null;
			if (!btn) return;
			var row = btn.closest('tr[data-command]');
			if (!row) return;
			var mode = btn.getAttribute('data-sc');
			var input = row.querySelector('input.sc-record');
			var key = input && input.value ? String(input.dataset.key || '') : '';
			if (mode === 'set' && !key) {
				setText('shortcut-error', 'Click the "New shortcut" box and press a key combination first.');
				if (input) input.focus();
				return;
			}
			setText('shortcut-error', '');
			vscode.postMessage({ type: 'updateShortcut', command: row.getAttribute('data-command'), mode: mode, key: key });
		});
		window.addEventListener('message', function (event) {
			if (event.data && event.data.type === 'shortcutsData') renderShortcuts(event.data);
		});
		vscode.postMessage({ type: 'requestShortcuts' });
		document.getElementById('btn-select-kb').addEventListener('click', function () {
			vscode.postMessage({ type: 'selectKnowledgeBase' });
		});
		document.getElementById('btn-reindex-workspace').addEventListener('click', function () {
			vscode.postMessage({ type: 'reindexCurrentKbWorkspace' });
		});
		document.getElementById('btn-reset-reindex-entire').addEventListener('click', function () {
			vscode.postMessage({ type: 'resetReindexEntireKb' });
		});
		document.getElementById('btn-user-settings').addEventListener('click', function () {
			vscode.postMessage({ type: 'openDripUserSettings' });
		});
		function pushHeadingEditMode(mode) {
			var viaRhs = mode === 'rhs';
			vscode.postMessage({ type: 'updateSetting', key: 'editHeadingsViaRhs', value: viaRhs });
			vscode.postMessage({ type: 'updateSetting', key: 'editHeadingsInFile', value: !viaRhs });
		}
		if (optEditHeadingsRhs) {
			optEditHeadingsRhs.addEventListener('change', function () {
				if (optEditHeadingsRhs.checked) pushHeadingEditMode('rhs');
			});
		}
		if (optEditHeadingsFile) {
			optEditHeadingsFile.addEventListener('change', function () {
				if (optEditHeadingsFile.checked) pushHeadingEditMode('file');
			});
		}
		document.getElementById('btn-embedding-benchmark').addEventListener('click', function () {
			vscode.postMessage({ type: 'runEmbeddingBenchmark' });
		});
		document.getElementById('btn-import-settings').addEventListener('click', function () {
			vscode.postMessage({ type: 'importKbSettings' });
		});
		document.getElementById('btn-export-settings').addEventListener('click', function () {
			vscode.postMessage({ type: 'exportKbSettings' });
		});
		var btnGhSave = document.getElementById('btn-gh-save-remote');
		if (btnGhSave) {
			btnGhSave.addEventListener('click', function () {
				vscode.postMessage({
					type: 'githubBackupSaveRemote',
					remoteUrl: String((document.getElementById('gh-remote-url') || {}).value || '').trim(),
					branch: String((document.getElementById('gh-branch') || {}).value || 'main').trim() || 'main'
				});
			});
		}
		var btnGhOpen = document.getElementById('btn-gh-open');
		if (btnGhOpen) {
			btnGhOpen.addEventListener('click', function () {
				vscode.postMessage({ type: 'githubBackupOpen' });
			});
		}
		var btnGhInit = document.getElementById('btn-gh-init');
		if (btnGhInit) {
			btnGhInit.addEventListener('click', function () {
				vscode.postMessage({ type: 'githubBackupInit' });
			});
		}
		var btnGhPush = document.getElementById('btn-gh-push');
		if (btnGhPush) {
			btnGhPush.addEventListener('click', function () {
				vscode.postMessage({ type: 'githubBackupPush' });
			});
		}
		var btnGhPull = document.getElementById('btn-gh-pull');
		if (btnGhPull) {
			btnGhPull.addEventListener('click', function () {
				vscode.postMessage({ type: 'githubBackupPull' });
			});
		}
		var btnGhSetPat = document.getElementById('btn-gh-set-pat');
		if (btnGhSetPat) {
			btnGhSetPat.addEventListener('click', function () {
				vscode.postMessage({ type: 'githubBackupSetPat' });
			});
		}
		var btnGhClearPat = document.getElementById('btn-gh-clear-pat');
		if (btnGhClearPat) {
			btnGhClearPat.addEventListener('click', function () {
				vscode.postMessage({ type: 'githubBackupClearPat' });
			});
		}
		var mcpEnabledEl = document.getElementById('mcp-enabled');
		if (mcpEnabledEl) {
			mcpEnabledEl.addEventListener('change', function () {
				vscode.postMessage({ type: 'mcpSetEnabled', value: !!mcpEnabledEl.checked });
			});
		}
		var btnMcpSavePort = document.getElementById('btn-mcp-save-port');
		if (btnMcpSavePort) {
			btnMcpSavePort.addEventListener('click', function () {
				var portEl = document.getElementById('mcp-port');
				vscode.postMessage({ type: 'mcpSetPort', value: Number(String((portEl && portEl.value) || '').trim()) });
			});
		}
		var btnMcpRestart = document.getElementById('btn-mcp-restart');
		if (btnMcpRestart) {
			btnMcpRestart.addEventListener('click', function () {
				vscode.postMessage({ type: 'mcpRestart' });
			});
		}
		var btnMcpRegenerate = document.getElementById('btn-mcp-regenerate');
		if (btnMcpRegenerate) {
			btnMcpRegenerate.addEventListener('click', function () {
				vscode.postMessage({ type: 'mcpRegenerateToken' });
			});
		}
		var btnMcpHealth = document.getElementById('btn-mcp-health');
		if (btnMcpHealth) {
			btnMcpHealth.addEventListener('click', function () {
				vscode.postMessage({ type: 'mcpOpenHealth' });
			});
		}
		Array.prototype.forEach.call(document.querySelectorAll('[data-mcp-copy]'), function (btn) {
			btn.addEventListener('click', function () {
				vscode.postMessage({ type: 'mcpCopy', kind: btn.getAttribute('data-mcp-copy') });
			});
		});
		var btnLlmSave = document.getElementById('btn-llm-save');
		if (btnLlmSave) {
			btnLlmSave.addEventListener('click', function () {
				vscode.postMessage({ type: 'updateSetting', key: 'llm.enabled', value: !!llmEnabledEl.checked });
				vscode.postMessage({ type: 'updateSetting', key: 'llm.baseUrl', value: String((llmBaseUrlEl && llmBaseUrlEl.value) || '').trim() });
				vscode.postMessage({ type: 'updateSetting', key: 'llm.model', value: String((llmModelEl && llmModelEl.value) || '').trim() });
			});
		}
		var btnLlmSetKey = document.getElementById('btn-llm-set-key');
		if (btnLlmSetKey) {
			btnLlmSetKey.addEventListener('click', function () {
				var keyEl = document.getElementById('llm-api-key');
				var key = keyEl ? String(keyEl.value || '').trim() : '';
				if (!key) return;
				vscode.postMessage({ type: 'llmSetApiKey', value: key });
				if (keyEl) keyEl.value = '';
			});
		}
		var btnLlmClearKey = document.getElementById('btn-llm-clear-key');
		if (btnLlmClearKey) {
			btnLlmClearKey.addEventListener('click', function () {
				vscode.postMessage({ type: 'llmClearApiKey' });
				var keyEl = document.getElementById('llm-api-key');
				if (keyEl) keyEl.value = '';
			});
		}
		showPanel(window.__dripSettingsInit.initialPanel);
	