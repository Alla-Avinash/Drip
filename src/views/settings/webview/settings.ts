// Browser client for the DRIP Settings webview. Bundled by esbuild (scripts/build-webview.mjs)
// into dist/. Runs inside the sandboxed webview; bootstrap values arrive via window.__dripSettingsInit.

interface Window {
	__dripSettingsInit: any;
}


		const vscode = acquireVsCodeApi();
		const navButtons = Array.prototype.slice.call(document.querySelectorAll('.navBtn'));
		const panels = {
			about: document.getElementById('panel-about'),
			kb: document.getElementById('panel-kb'),
			editor: document.getElementById('panel-editor'),
			update: document.getElementById('panel-update'),
			'kb-types': document.getElementById('panel-kb-types'),
			'project-types': document.getElementById('panel-project-types'),
			account: document.getElementById('panel-account'),
			'join-project': document.getElementById('panel-join-project'),
			'project-sharing': document.getElementById('panel-project-sharing'),
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
		const llmProfilesEl = document.getElementById('llm-profiles');
		const btnLlmAddProfile = document.getElementById('btn-llm-add-profile');
		const autoOpenEl = document.getElementById('opt-auto-open');
		const kbExtDtxt = document.getElementById('kb-ext-dtxt');
		const kbExtDmd = document.getElementById('kb-ext-dmd');
		const kbDefaultExt = document.getElementById('kb-default-ext');
		const metadataTypesListEl = document.getElementById('metadata-types-list');
		const fileLevelTypesListEl = document.getElementById('file-level-types-list');
		const projectSelectEl = document.getElementById('project-select');
		const shareProjectSelectEl = document.getElementById('share-project-select');
		const shareProjectBodyEl = document.getElementById('share-project-body');
		const projectMetadataHintEl = document.getElementById('project-metadata-hint');
		const projectMetadataHeadingEl = document.getElementById('project-metadata-heading');
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
		/** Extensions set only via settings JSON; preserved when toggling .d.txt / .d.md here. */
		var preservedOtherExts = [];
		var metadataTypesState = [];
		var fileLevelTypesState = [];
		/** @type {{ folderPrefix: string, title: string }[]} */
		var projectsList = [];
		var projectOverrides = {};
		var selectedProjectKey = String(window.__dripSettingsInit.initialProject || '');
		var selectedProjectTitle = String(window.__dripSettingsInit.initialProjectTitle || '');
		var selectedShareProjectKey = String(window.__dripSettingsInit.initialProject || '');
		var selectedShareProjectTitle = String(window.__dripSettingsInit.initialProjectTitle || '');
		var currentShareState = null;
		var peerIdentity = { displayName: '', peerId: '', githubLogin: '', githubId: '' };
		var projectOverrideState = [];
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

		// Product tour: a self-contained guided walkthrough of DRIP's main areas.
		// Each step: title, a "where to find it" line, and a short plain-English body.
		var TOUR_STEPS = [
			{
				title: 'Welcome to DRIP',
				where: 'This tour — DRIP Settings → About',
				body: 'DRIP is a plain-text knowledge base plus a project tracker. Your notes stay as ordinary files on disk; DRIP indexes them so you can search, sort, and browse. Work is grouped into projects → features → issues.'
			},
			{
				title: 'Pick a note format',
				where: 'DRIP Settings → Knowledge Base',
				body: 'DRIP reads two formats: .d.txt (its native plain-text format) and .d.md (Markdown with a rich editor). Choose the default new-note type and which extensions appear in the knowledge base tree.'
			},
			{
				title: 'Knowledge Base tree',
				where: 'Left activity bar → DRIP → Knowledge Base',
				body: 'This sidebar shows your .driplock folder as a tree. Right-click a file or folder to create, rename, or delete notes. Changes save to disk and reindex automatically.'
			},
			{
				title: 'Note Composer (capture)',
				where: 'Command: Open Composer, or Ctrl+Shift+U to capture a selection',
				body: 'The Composer is a draft note. Type or paste text, or capture the current editor selection. From here you file the note into the knowledge base — merge into a matching heading, append, or start a new heading.'
			},
			{
				title: 'Chat inbox',
				where: 'Right sidebar → Chat',
				body: 'A quick capture inbox that talks to your LLM. Type a note and DRIP decides where it belongs, or asks you. It keeps short-term session context and long-term memory per knowledge base.'
			},
			{
				title: 'Storage and Heading Form',
				where: 'Right sidebar → Storage / Heading',
				body: 'Storage browses the knowledge base and its headings. Heading Form edits a persistent heading\u2019s metadata, tags, and relations in a form instead of typing them by hand.'
			},
			{
				title: 'Retriever (search)',
				where: 'Command: Open Retriever, or Ctrl+Shift+Alt+R',
				body: 'Search your notes by meaning (embeddings) or by keywords. Filter by tags, relations, and metadata, then jump straight to the matching heading.'
			},
			{
				title: 'Project View',
				where: 'Command: Open Project View',
				body: 'A board of projects, features, and issues. Browse what is done and what still needs work, and drill into any issue\u2019s details.'
			},
			{
				title: 'Account',
				where: 'DRIP Settings → Account',
				body: 'This PC has one identity. Sign in with GitHub and people see only that GitHub name. Sign out and they see the guest PC name. The unique id stays on this machine.'
			},
			{
				title: 'Join a Project',
				where: 'DRIP Settings → Join a Project',
				body: 'Paste a project invite to ask to join. The admin sees your name, admits you, and picks your role and teams.'
			},
			{
				title: 'Project Sharing',
				where: 'DRIP Settings → Project Sharing, or the gear on a project in Project View',
				body: 'A project starts solo. Share it to let other people in. Only admins see invite, rotate, teams, and mailbox settings.'
			},
			{
				title: 'Tags Graph',
				where: 'Command: Open Tags Graph',
				body: 'A visual graph of your tags and how they connect. Tags are the source of truth for what is valid in a note; unknown tags get flagged in the editor.'
			},
			{
				title: 'Lightweight LLM',
				where: 'DRIP Settings → Lightweight LLM',
				body: 'DRIP runs its own small LLM (separate from Copilot) to decide where a captured note belongs. Add provider profiles, set an API key, and use "Test connection" to verify each one.'
			},
			{
				title: 'MCP connection',
				where: 'DRIP Settings → MCP connection',
				body: 'Let AI apps (Cursor, Claude, Copilot, …) read and manage your projects and issues through a local MCP server. Turn it on, copy the URL, and connect your AI app.'
			},
			{
				title: 'GitHub backup',
				where: 'DRIP Settings → GitHub backup',
				body: 'One-click push and pull of your whole knowledge base to a GitHub remote, so your notes are safe and versioned.'
			},
			{
				title: "You're ready",
				where: 'Come back to this tour any time',
				body: 'Start by picking a knowledge base folder, then capture a note and file it. You can re-run this tour from About & Product Tour whenever you want a refresher.'
			}
		];
		var tourIndex = 0;
		var tourOverlay = document.getElementById('tour-overlay');
		var tourTitleEl = document.getElementById('tour-title');
		var tourWhereEl = document.getElementById('tour-where');
		var tourBodyEl = document.getElementById('tour-body');
		var tourCountEl = document.getElementById('tour-step-count');
		var tourDotsEl = document.getElementById('tour-dots');

		function renderTour() {
			var step = TOUR_STEPS[tourIndex];
			if (!step) return;
			if (tourTitleEl) tourTitleEl.textContent = step.title;
			if (tourWhereEl) tourWhereEl.innerHTML = '<strong>Where:</strong> ' + escapeHtml(step.where);
			if (tourBodyEl) tourBodyEl.textContent = step.body;
			if (tourCountEl) tourCountEl.textContent = 'Step ' + (tourIndex + 1) + ' of ' + TOUR_STEPS.length;
			var last = tourIndex === TOUR_STEPS.length - 1;
			var backBtn = document.getElementById('tour-back');
			var nextBtn = document.getElementById('tour-next');
			var skipBtn = document.getElementById('tour-skip');
			if (backBtn) backBtn.disabled = tourIndex === 0;
			if (nextBtn) nextBtn.textContent = last ? 'Finish' : 'Next';
			if (skipBtn) skipBtn.textContent = last ? '' : 'Skip tour';
			if (tourDotsEl) {
				var dots = '';
				for (var i = 0; i < TOUR_STEPS.length; i++) {
					dots += '<span class="tour-dot' + (i === tourIndex ? ' active' : '') + '"></span>';
				}
				tourDotsEl.innerHTML = dots;
			}
		}

		function startTour() {
			tourIndex = 0;
			renderTour();
			if (tourOverlay) tourOverlay.hidden = false;
		}

		function closeTour() {
			if (tourOverlay) tourOverlay.hidden = true;
		}

		function tourNext() {
			if (tourIndex < TOUR_STEPS.length - 1) {
				tourIndex++;
				renderTour();
			} else {
				closeTour();
			}
		}

		function tourBack() {
			if (tourIndex > 0) {
				tourIndex--;
				renderTour();
			}
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
			if (k === 'enum' || k === 'datetime' || k === 'duration' || k === 'ref') return k;
			// Legacy issue-parent kind folds into the generic reference kind.
			if (k === 'parent' || k === 'issue_parent') return 'ref';
			return 'enum';
		}

		// Reference kind for entity links (parent i-N, decision d-N, concept c-N).
		var SPECIAL_PARENT_KIND = 'ref';

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
				return '<input type="text" data-role="attr-values" disabled value="reference (x-N)" title="Fixed special key">';
			}
			return '<input type="text" data-role="attr-values" value="' + escapeHtml((a.values || []).join(', ')) + '" placeholder="comma values (enum)">';
		}

		function renderAttrKindCell(a, builtIn) {
			var kind = normalizeAttributeKind(a.kind);
			var disabled = builtIn ? ' disabled' : '';
			if (kind === SPECIAL_PARENT_KIND) {
				return '<select data-role="attr-kind" disabled title="Fixed special key"><option value="ref" selected>ref</option></select>';
			}
			return '<select data-role="attr-kind"' + disabled + '>' +
				'<option value="enum"' + (kind === 'enum' ? ' selected' : '') + '>enum</option>' +
				'<option value="datetime"' + (kind === 'datetime' ? ' selected' : '') + '>datetime</option>' +
				'<option value="duration"' + (kind === 'duration' ? ' selected' : '') + '>duration</option>' +
				'<option value="ref"' + (kind === 'ref' ? ' selected' : '') + '>ref</option>' +
			'</select>';
		}

		var LOCKED_FILE_LEVEL_TYPE_IDS = { project: true, feature: true };

		// Built-in template keys per type: fixed by the product, editable but never deletable.
		var BUILTIN_ATTRIBUTE_KEYS = {
			concept: ['domain', 'status'],
			task: ['status', 'priority', 'deadline', 'category'],
			issue: ['status', 'priority', 'deadline', 'completed', 'category', 'feature', 'team', 'parent', 'decision', 'concept'],
			decision: ['status', 'category', 'superseded-by', 'concept'],
			project: ['status', 'priority', 'deadline'],
			feature: ['category']
		};

		function isBuiltInAttributeKey(typeId, key) {
			var list = BUILTIN_ATTRIBUTE_KEYS[String(typeId || '').trim().toLowerCase()];
			return !!list && list.indexOf(String(key || '').trim().toLowerCase()) >= 0;
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

		function renderMetadataTypes() {
			var html = '';
			for (var i = 0; i < metadataTypesState.length; i++) {
				var t = metadataTypesState[i] || {};
				// Issue and decision are shown in the Projects card, not the document list.
				var docTypeId = String(t.id || '').trim().toLowerCase();
				if (docTypeId === 'issue' || docTypeId === 'decision') continue;
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
				html +=
					'<details class="typeDetails" data-type-index="' + i + '" open>' +
						'<summary class="typeSummary">' +
							'<span>' + escapeHtml(t.marker || '.type') + ' (' + escapeHtml(t.id || 'type') + ')</span>' +
							'<span class="summaryRight"><span class="chev">⌃</span></span>' +
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

			// Concept / issue / decision are document/heading types (stored in
			// metadataTypes) but belong to Projects, so they are rendered here too.
			// Mark each block so edits route back to metadataTypesState instead of
			// fileLevelTypesState.
			var projectHeadingTypeIds = ['issue', 'concept', 'decision'];
			for (var pi = 0; pi < projectHeadingTypeIds.length; pi++) {
				var ptypeId = projectHeadingTypeIds[pi];
				var pidx = findDocumentTypeIndex(ptypeId);
				if (pidx < 0) continue;
				var pt = metadataTypesState[pidx] || {};
				var pAttrs = Array.isArray(pt.attributes) ? pt.attributes : [];
				var pRows = '';
				for (var j = 0; j < pAttrs.length; j++) {
					var pa = pAttrs[j] || {};
					var builtIn = isBuiltInAttributeKey(ptypeId, pa.key);
					pRows += '<tr data-attr-index="' + j + '">' +
						'<td><input type="text" data-role="attr-key" value="' + escapeHtml(pa.key) + '" placeholder="key"' + (builtIn ? ' disabled' : '') + '></td>' +
						'<td>' + renderAttrKindCell(pa, builtIn) + '</td>' +
						'<td>' + renderAttrValuesCell(pa) + '</td>' +
						'<td><label class="row" style="margin:0;"><input type="checkbox" data-role="attr-required"' + (pa.required ? ' checked' : '') + '><span>required</span></label></td>' +
						'<td>' + (builtIn ? '<span class="meta">built-in</span>' : '<button class="iconBtn deleteIcon" data-role="remove-attr" title="Delete Attribute">🗑</button>') + '</td>' +
					'</tr>';
				}
				var pshortcut = ptypeId === 'issue' ? 'i' : ptypeId === 'concept' ? 'c' : ptypeId === 'decision' ? 'd' : '';
				html +=
					'<details class="typeDetails" data-type-index="' + pidx + '" data-source="document" open>' +
						'<summary class="typeSummary">' +
							'<span>' + escapeHtml(pt.marker || ('.' + ptypeId)) + ' (' + escapeHtml(ptypeId) + ')</span>' +
							'<span class="summaryRight"><span class="chev">⌃</span></span>' +
						'</summary>' +
						'<div class="typeBody" data-type-index="' + pidx + '" data-source="document">' +
							'<div class="typeGrid">' +
								'<label class="row" style="display:block;margin:0;"><span>Type Id</span><input type="text" data-role="type-id" value="' + escapeHtml(ptypeId) + '" disabled></label>' +
								'<label class="row" style="display:block;margin:0;"><span>Shortcut</span><input type="text" value="' + escapeHtml(pshortcut) + '" disabled></label>' +
							'</div>' +
							'<table class="attrTable">' +
								'<thead><tr><th>Key</th><th>Kind</th><th>Values</th><th>Required</th><th>Action</th></tr></thead>' +
								'<tbody>' + pRows + '</tbody>' +
							'</table>' +
							'<div class="inlineActions">' +
								'<button class="iconBtn" data-role="add-attr" title="Add Attribute">+</button>' +
							'</div>' +
						'</div>' +
					'</details>';
			}

			fileLevelTypesListEl.innerHTML = html;
		}

		function defaultTypeForId(typeId) {
			var inFileLevel = typeId === 'project' || typeId === 'feature';
			var src = inFileLevel ? defaultFileLevelMetadataTypes : defaultMetadataTypes;
			for (var i = 0; i < src.length; i++) {
				if (String((src[i] || {}).id || '').toLowerCase() === typeId) return src[i];
			}
			return null;
		}

		function defaultAttrMapForType(typeId) {
			var base = defaultTypeForId(typeId);
			var attrs = base ? normalizeAttributes(base.attributes) : [];
			var map = {};
			for (var i = 0; i < attrs.length; i++) {
				map[String(attrs[i].key || '').toLowerCase()] = attrs[i];
			}
			return map;
		}

		function attributeDiffersFromDefault(typeId, key, attr) {
			var def = defaultAttrMapForType(typeId)[String(key || '').toLowerCase()];
			if (!def) return true; // new key added by this project
			var kind = normalizeAttributeKind(attr.kind);
			var defKind = normalizeAttributeKind(def.kind);
			if (kind !== defKind) return true;
			if (kind === 'enum') {
				var aVals = (Array.isArray(attr.values) ? attr.values : [])
					.map(function (x) { return String(x || '').trim().toLowerCase(); }).filter(Boolean);
				var dVals = (Array.isArray(def.values) ? def.values : [])
					.map(function (x) { return String(x || '').trim().toLowerCase(); }).filter(Boolean);
				if (aVals.join('|') !== dVals.join('|')) return true;
				if (String(attr.default || '').trim().toLowerCase() !== String(def.default || '').trim().toLowerCase()) return true;
			}
			if (!!attr.required !== !!def.required) return true;
			return false;
		}

		// Build the editable type list for a selected project: default template for
		// project/feature/issue, with that project's stored overrides layered on top.
		function buildProjectOverrideState(projectKey) {
			var ovr = (projectOverrides && projectOverrides[projectKey]) || {};
			var typeIds = ['project', 'feature', 'issue', 'concept', 'decision'];
			var out = [];
			for (var i = 0; i < typeIds.length; i++) {
				var typeId = typeIds[i];
				var base = defaultTypeForId(typeId);
				if (!base) continue;
				var normalized = normalizeTypesFromSettings([base]);
				var t = normalized[0] || { id: typeId, marker: '.' + typeId, shortcut: '', attributes: [] };
				var typeOvr = ovr[typeId];
				var extraAttrs = (typeOvr && typeOvr.attributes && typeof typeOvr.attributes === 'object')
					? normalizeAttributes(typeOvr.attributes)
					: [];
				if (extraAttrs.length) {
					var merged = Array.isArray(t.attributes) ? t.attributes.slice() : [];
					for (var m = 0; m < extraAttrs.length; m++) {
						var ev = extraAttrs[m];
						var idx = -1;
						for (var a = 0; a < merged.length; a++) {
							if (String((merged[a] || {}).key || '').toLowerCase() === String(ev.key || '').toLowerCase()) { idx = a; break; }
						}
						if (idx >= 0) merged[idx] = ev;
						else merged.push(ev);
					}
					t.attributes = merged;
				}
				out.push(t);
			}
			return out;
		}

		function renderProjectOverrideTypes() {
			var html = '';
			for (var i = 0; i < projectOverrideState.length; i++) {
				var t = projectOverrideState[i] || {};
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
				var shortcutLabel = typeId === 'project' ? '.p' : typeId === 'feature' ? '.f' : typeId === 'issue' ? 'i' : typeId === 'concept' ? 'c' : typeId === 'decision' ? 'd' : '';
				html +=
					'<details class="typeDetails" data-type-index="' + i + '" open>' +
						'<summary class="typeSummary">' +
							'<span>' + escapeHtml(typeId) + ' (special)</span>' +
							'<span class="summaryRight"><span class="chev">⌃</span></span>' +
						'</summary>' +
						'<div class="typeBody" data-type-index="' + i + '">' +
							'<div class="typeGrid">' +
								'<label class="row" style="display:block;margin:0;"><span>Type Id</span><input type="text" data-role="type-id" value="' + escapeHtml(typeId) + '" disabled></label>' +
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
			fileLevelTypesListEl.innerHTML = html;
		}

		function reRenderProjectTypeList() {
			if (selectedProjectKey) renderProjectOverrideTypes();
			else renderFileLevelTypes();
		}

		function selectedProjectOptionTitle(value) {
			for (var i = 0; i < projectsList.length; i++) {
				if (String((projectsList[i] || {}).folderPrefix || '') === value) {
					return String((projectsList[i] || {}).title || '');
				}
			}
			return '';
		}

		function renderProjectMetadataPanel() {
			if (selectedProjectKey) {
				projectOverrideState = buildProjectOverrideState(selectedProjectKey);
				renderProjectOverrideTypes();
				var title = selectedProjectTitle || selectedProjectOptionTitle(selectedProjectKey) || selectedProjectKey;
				if (projectMetadataHeadingEl) projectMetadataHeadingEl.textContent = 'Project metadata — ' + title;
				if (projectMetadataHintEl) projectMetadataHintEl.textContent = 'Editing overrides for this project. Only changed or added keys are saved; everything else inherits the default template.';
			} else {
				renderFileLevelTypes();
				if (projectMetadataHeadingEl) projectMetadataHeadingEl.textContent = 'Default project template';
				if (projectMetadataHintEl) projectMetadataHintEl.textContent = 'The standard template shared by all projects. Select a project above to override it.';
			}
		}

		function rebuildProjectSelect() {
			if (!projectSelectEl) return;
			projectSelectEl.innerHTML = '';
			var optDefault = document.createElement('option');
			optDefault.value = '';
			optDefault.textContent = 'standard template';
			projectSelectEl.appendChild(optDefault);
			for (var i = 0; i < projectsList.length; i++) {
				var p = projectsList[i] || {};
				var o = document.createElement('option');
				o.value = String(p.folderPrefix || '');
				o.textContent = String(p.title || p.folderPrefix || '');
				projectSelectEl.appendChild(o);
			}
			var want = selectedProjectKey || '';
			var found = false;
			for (var j = 0; j < projectSelectEl.options.length; j++) {
				if (projectSelectEl.options[j].value === want) {
					projectSelectEl.selectedIndex = j;
					found = true;
					break;
				}
			}
			if (!found) {
				selectedProjectKey = '';
				selectedProjectTitle = '';
				projectSelectEl.selectedIndex = 0;
			}
			renderProjectMetadataPanel();
		}

		function fillProjectSelect(selectEl, includeDefault, wantKey) {
			if (!selectEl) return '';
			selectEl.innerHTML = '';
			if (includeDefault) {
				var optDefault = document.createElement('option');
				optDefault.value = '';
				optDefault.textContent = 'standard template';
				selectEl.appendChild(optDefault);
			} else {
				var optEmpty = document.createElement('option');
				optEmpty.value = '';
				optEmpty.textContent = 'select a project…';
				selectEl.appendChild(optEmpty);
			}
			for (var i = 0; i < projectsList.length; i++) {
				var p = projectsList[i] || {};
				var o = document.createElement('option');
				o.value = String(p.folderPrefix || '');
				o.textContent = String(p.title || p.folderPrefix || '');
				selectEl.appendChild(o);
			}
			var want = wantKey || '';
			var found = false;
			for (var j = 0; j < selectEl.options.length; j++) {
				if (selectEl.options[j].value === want) {
					selectEl.selectedIndex = j;
					found = true;
					break;
				}
			}
			if (!found) {
				selectEl.selectedIndex = 0;
				return '';
			}
			return want;
		}

		function renderShareIdentity() {
			var name = peerIdentity.displayName || '—';
			var id = String(peerIdentity.peerId || '');
			var linked = !!peerIdentity.githubLogin;
			var ghName = linked ? '@' + String(peerIdentity.githubLogin).replace(/^@/, '') : '';

			var shareLines = document.querySelectorAll('#share-identity-line');
			var shareHints = document.querySelectorAll('#share-identity-hint');
			var shareLineText = linked ? 'Signed in as ' + ghName : 'PC name: ' + name;
			var shareHintText = linked
				? 'Other people see only this GitHub name. Sign out in Account to use the guest PC name instead.'
				: 'Other people see this PC name. Sign in with GitHub in Account to use only that name.';
			for (var si = 0; si < shareLines.length; si++) shareLines[si].textContent = shareLineText;
			for (var hi = 0; hi < shareHints.length; hi++) shareHints[hi].textContent = shareHintText;

			var identityEl = document.getElementById('account-identity-line');
			var pcRow = document.getElementById('account-pc-row');
			var pcHint = document.getElementById('account-pc-hint');
			var pcActions = document.getElementById('account-pc-actions');
			var pcEl = document.getElementById('account-pc-name');
			var idEl = document.getElementById('account-peer-id');
			var ghEl = document.getElementById('account-github-status');
			var hintEl = document.getElementById('account-github-hint');
			var inBtn = document.getElementById('account-btn-github-in');
			var switchBtn = document.getElementById('account-btn-github-switch');
			var outBtn = document.getElementById('account-btn-github-out');
			if (identityEl) identityEl.textContent = linked ? 'Signed in as ' + ghName : 'Guest on this PC: ' + name;
			if (pcEl) pcEl.textContent = name;
			if (idEl) idEl.textContent = id || '—';
			if (pcRow) pcRow.style.display = linked ? 'none' : '';
			if (pcHint) pcHint.style.display = linked ? 'none' : '';
			if (pcActions) pcActions.style.display = linked ? 'none' : '';
			if (ghEl) ghEl.textContent = linked ? 'Signed in as ' + ghName : 'Not signed in';
			if (hintEl) {
				hintEl.textContent = linked
					? 'This GitHub name is what people see on every shared project. Sign out to show the guest PC name instead, or switch to another GitHub account.'
					: 'Sign in once with the DRIP GitHub app (profile only). After that, people see only the GitHub name — not the PC name.';
			}
			if (inBtn) inBtn.style.display = linked ? 'none' : '';
			if (switchBtn) switchBtn.style.display = linked ? '' : 'none';
			if (outBtn) outBtn.style.display = linked ? '' : 'none';

			// When the selected project is shared but this PC's identity is not
			// one of its members, this is likely a second computer: nudge the
			// user to import their identity (or sign in with the same GitHub).
			var mismatchEl = document.getElementById('share-identity-mismatch');
			if (mismatchEl) {
				var st = currentShareState;
				var members = (st && Array.isArray(st.members)) ? st.members : [];
				var isMember = !!(peerIdentity.peerId && members.some(function (m) {
					return m && String(m.peerId) === String(peerIdentity.peerId);
				}));
				var show = !!(st && st.shared && !st.waitingAdmit && peerIdentity.peerId && !isMember);
				mismatchEl.style.display = show ? '' : 'none';
			}
		}

		function requestShareState() {
			if (!selectedShareProjectKey) {
				currentShareState = null;
				renderProjectSharingPanel();
				return;
			}
			vscode.postMessage({ type: 'requestProjectShare', projectKey: selectedShareProjectKey });
		}

		function shareActionButton(action, label, secondary, peerId, extraAttr) {
			return '<button type="button"' + (secondary ? ' class="secondary"' : '') +
				' data-share-action="' + escapeHtml(action) + '"' +
				(peerId ? ' data-peer-id="' + escapeHtml(peerId) + '"' : '') +
				(extraAttr ? extraAttr : '') +
				'>' + escapeHtml(label) + '</button>';
		}

		var ROLE_ORDER = ['admin', 'member', 'updater', 'viewer'];

		function memberName(m) {
			return String((m && (m.displayName || m.peerId)) || '');
		}

		function memberInitial(m) {
			var n = memberName(m).trim();
			return n ? n.charAt(0).toUpperCase() : '?';
		}

		function teamIdsOf(m) {
			return Array.isArray(m && m.teamIds) ? m.teamIds.map(String) : [];
		}

		function renderTeamsCard(st) {
			var teams = Array.isArray(st.teams) ? st.teams : [];
			var members = Array.isArray(st.members) ? st.members : [];
			var html = '<div class="card"><h3 style="margin-top:0;">Teams</h3>';
			html += '<p class="meta">A team groups people for mentions and the Team filter — it is not a folder, and new issues can stay unassigned. Everyone is on at least one team; deleting a team removes people who are not on any other team.</p>';
			if (st.role === 'admin') {
				html += '<div class="team-create">';
				html += '<input id="share-team-name" type="text" placeholder="New team name" autocomplete="off" spellcheck="false" />';
				html += shareActionButton('createTeam', 'Create team', false, '');
				html += '</div>';
			}
			if (!teams.length) {
				html += '<p class="meta">No teams yet.</p>';
				html += '</div>';
				return html;
			}
			html += '<div class="team-list">';
			for (var ti = 0; ti < teams.length; ti++) {
				var t = teams[ti] || {};
				var tid = String(t.id);
				var onTeamMembers = members.filter(function (m) { return teamIdsOf(m).indexOf(tid) !== -1; });
				var lead = members.find(function (m) { return String(m.peerId) === String(t.leadPeerId); });
				html += '<div class="team-row">';
				html += '<div class="team-head">';
				html += '<div class="team-name">';
				html += '<span class="team-badge">' + escapeHtml((t.name || t.id || '?').charAt(0).toUpperCase()) + '</span>';
				html += '<div class="team-text"><div class="team-title">' + escapeHtml(t.name || t.id) + '</div>';
				html += '<div class="team-sub">' + onTeamMembers.length + ' member' + (onTeamMembers.length === 1 ? '' : 's') +
					(lead ? ' · Lead: ' + escapeHtml(memberName(lead)) : '') + '</div></div>';
				html += '</div>';
				if (st.role === 'admin') {
					html += '<div class="team-controls">';
					html += '<label class="team-lead"><span>Lead</span>';
					html += '<select data-share-change="setTeamLead" data-team-id="' + escapeHtml(t.id) + '">';
					html += '<option value="">No lead</option>';
					for (var li = 0; li < members.length; li++) {
						var lm = members[li] || {};
						html += '<option value="' + escapeHtml(lm.peerId || '') + '"' +
							(lm.peerId === t.leadPeerId ? ' selected' : '') + '>' +
							escapeHtml(memberName(lm)) + '</option>';
					}
					html += '</select></label>';
					html += shareActionButton('deleteTeam', 'Delete', true, '', ' data-team-id="' + escapeHtml(t.id) + '"');
					html += '</div>';
				} else {
					html += '<div class="team-names">' + (onTeamMembers.length ? onTeamMembers.map(function (m) { return memberName(m); }).map(escapeHtml).join(', ') : 'No one assigned yet') + '</div>';
				}
				html += '</div>';
				if (st.role === 'admin') {
					html += '<div class="team-members">';
					if (!onTeamMembers.length) html += '<span class="empty">No one on this team yet</span>';
					for (var mj = 0; mj < onTeamMembers.length; mj++) {
						var mm = onTeamMembers[mj] || {};
						html += '<span class="chip"><span class="chip-avatar">' + escapeHtml(memberInitial(mm)) + '</span>' + escapeHtml(memberName(mm)) +
							'<button type="button" class="chip-x" data-share-action="toggleMemberTeam" data-team-id="' + escapeHtml(t.id) + '" data-peer-id="' + escapeHtml(mm.peerId || '') + '" title="Remove from team">×</button></span>';
					}
					html += '<button type="button" class="add-btn" data-add-member-team="' + escapeHtml(t.id) + '" title="Add a member to this team">+</button>';
					html += '</div>';
				}
				html += '</div>';
			}
			html += '</div></div>';
			return html;
		}

		function renderPeopleCard(st) {
			var members = Array.isArray(st.members) ? st.members : [];
			var teams = Array.isArray(st.teams) ? st.teams : [];
			var html = '<div class="card"><h3 style="margin-top:0;">People &amp; access</h3>';
			html += '<p class="meta">Set each person’s role and which teams they belong to. A viewer cannot talk or change fields; an updater can change status and talk.</p>';
			if (!members.length) {
				html += '<p class="meta">No members listed yet.</p></div>';
				return html;
			}
			html += '<div class="people-list">';
			for (var mi = 0; mi < members.length; mi++) {
				var m = members[mi] || {};
				var isYou = peerIdentity.peerId && String(m.peerId) === String(peerIdentity.peerId);
				var online = !!m.online;
				var myTeams = teamIdsOf(m);
				html += '<div class="person-row">';
				html += '<div class="person-top">';
				html += '<div class="person-id">';
				html += '<span class="person-avatar">' + escapeHtml(memberInitial(m)) + '</span>';
				html += '<div class="person-name">';
				html += '<div class="p-title"><span class="n">' + escapeHtml(memberName(m)) + '</span>' +
					(isYou ? ' <span class="badge">you</span>' : '') +
					' <span class="badge">' + (m.isGuest ? 'guest' : 'GitHub') + '</span>' +
					' <span class="presence-dot ' + (online ? 'online' : 'offline') + '" title="' + (online ? 'online' : 'offline') + '"></span></div>';
				html += '<div class="person-sub">' + (online ? 'Online now' : 'Offline') + '</div>';
				html += '</div></div>';
				html += '<select class="role-select" data-share-change="setMemberRole" data-peer-id="' + escapeHtml(m.peerId || '') + '">';
				for (var rr = 0; rr < ROLE_ORDER.length; rr++) {
					html += '<option value="' + ROLE_ORDER[rr] + '"' + (m.role === ROLE_ORDER[rr] ? ' selected' : '') + '>' + ROLE_ORDER[rr] + '</option>';
				}
				html += '</select>';
				html += '</div>';
				html += '<div class="person-teams">';
				html += '<span class="teams-label">Teams</span>';
				var assigned = [];
				for (var ti = 0; ti < teams.length; ti++) {
					if (myTeams.indexOf(String(teams[ti].id)) !== -1) assigned.push(teams[ti]);
				}
				for (var ai = 0; ai < assigned.length; ai++) {
					var at = assigned[ai] || {};
					html += '<span class="chip">' + escapeHtml(at.name || at.id) +
						'<button type="button" class="chip-x" data-share-action="toggleMemberTeam" data-team-id="' + escapeHtml(at.id) + '" data-peer-id="' + escapeHtml(m.peerId || '') + '" title="Remove team">×</button></span>';
				}
				if (teams.length) {
					html += '<button type="button" class="add-btn" data-add-team-to-peer="' + escapeHtml(m.peerId || '') + '" title="Add to a team">+</button>';
				} else {
					html += '<span class="person-sub">No teams yet — create one above.</span>';
				}
				html += '</div></div>';
			}
			html += '</div></div>';
			return html;
		}

		// --- add-member / add-team pickers (a small searchable dropdown) ---

		function closePicker() {
			var p = document.getElementById('share-picker');
			if (p) p.remove();
		}

		function openPicker(anchor, items, onPick) {
			closePicker();
			var rect = anchor.getBoundingClientRect();
			var pop = document.createElement('div');
			pop.id = 'share-picker';
			pop.className = 'picker-popover';
			pop.innerHTML = '<input class="picker-search" type="text" placeholder="Search…" autocomplete="off" spellcheck="false">' +
				'<div class="picker-list"></div>';
			document.body.appendChild(pop);
			var input = pop.querySelector('.picker-search');
			var list = pop.querySelector('.picker-list');
			function render(q) {
				var needle = String(q || '').toLowerCase();
				list.innerHTML = '';
				var shown = 0;
				for (var i = 0; i < items.length; i++) {
					var it = items[i];
					if (needle && String(it.label).toLowerCase().indexOf(needle) === -1) continue;
					shown++;
					var row = document.createElement('button');
					row.type = 'button';
					row.className = 'picker-item';
					row.innerHTML = escapeHtml(it.label) + (it.sub ? ' <span class="picker-sub">' + escapeHtml(it.sub) + '</span>' : '');
					row.addEventListener('mousedown', function (e) {
						e.preventDefault();
						onPick(it);
						closePicker();
					});
					list.appendChild(row);
				}
				if (!shown) {
					var empty = document.createElement('div');
					empty.className = 'picker-empty';
					empty.textContent = 'No matches.';
					list.appendChild(empty);
				}
			}
			render('');
			input.addEventListener('input', function () { render(input.value); });
			input.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePicker(); });
			var popW = 240;
			var left = rect.left;
			if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
			pop.style.left = Math.max(8, left) + 'px';
			// Anchor directly to the button. Open below when it fits; otherwise
			// open above, measured from the real popover height (no hardcoded gap).
			var popH = pop.offsetHeight || 260;
			if (rect.bottom + popH + 8 <= window.innerHeight) {
				pop.style.top = (rect.bottom + 4) + 'px';
			} else {
				pop.style.top = Math.max(8, rect.top - popH - 4) + 'px';
			}
			input.focus();
		}

		function postToggleMemberTeam(peerId, teamId) {
			vscode.postMessage({
				type: 'projectShareAction',
				action: 'toggleMemberTeam',
				projectKey: selectedShareProjectKey,
				projectTitle: selectedShareProjectTitle,
				peerId: String(peerId || ''),
				teamId: String(teamId || '')
			});
		}

		function openMemberPicker(anchor, teamId) {
			var st = currentShareState;
			var members = Array.isArray(st && st.members) ? st.members : [];
			var onTeam = members.filter(function (x) { return teamIdsOf(x).indexOf(teamId) !== -1; }).map(function (x) { return String(x.peerId); });
			var items = [];
			for (var i = 0; i < members.length; i++) {
				var m = members[i] || {};
				if (onTeam.indexOf(String(m.peerId)) !== -1) continue;
				items.push({ label: memberName(m), sub: m.isGuest ? 'guest' : 'GitHub', peerId: String(m.peerId), teamId: teamId });
			}
			openPicker(anchor, items, function (it) { postToggleMemberTeam(it.peerId, it.teamId); });
		}

		function openTeamPicker(anchor, peerId) {
			var st = currentShareState;
			var teams = Array.isArray(st && st.teams) ? st.teams : [];
			var members = Array.isArray(st && st.members) ? st.members : [];
			var m = members.find(function (x) { return String(x.peerId) === String(peerId); });
			var have = teamIdsOf(m);
			var items = [];
			for (var i = 0; i < teams.length; i++) {
				var t = teams[i] || {};
				if (have.indexOf(String(t.id)) !== -1) continue;
				items.push({ label: String(t.name || t.id), sub: '', peerId: String(peerId), teamId: String(t.id) });
			}
			openPicker(anchor, items, function (it) { postToggleMemberTeam(it.peerId, it.teamId); });
		}

		function renderProjectSharingPanel() {
			renderShareIdentity();
			if (!shareProjectBodyEl) return;
			if (!selectedShareProjectKey) {
				shareProjectBodyEl.innerHTML = '<div class="card"><p class="meta">Select a project above to see its share settings.</p></div>';
				return;
			}
			if (!currentShareState) {
				shareProjectBodyEl.innerHTML = '<div class="card"><p class="meta">Loading share settings…</p></div>';
				return;
			}
			var st = currentShareState;
			var title = selectedShareProjectTitle || selectedProjectOptionTitle(selectedShareProjectKey) || selectedShareProjectKey;
			var html = '';
			html += '<div class="card">';
			html += '<h3 style="margin-top:0;">' + escapeHtml(title) + '</h3>';
			if (!st.shared) {
				html += '<p class="meta">This project is only on this machine. Sharing lets other people work in this folder. The rest of the knowledge base stays private.</p>';
				html += '<div class="actions">' + shareActionButton('share', 'Share this project', false, '') + '</div>';
			} else {
				html += '<p class="meta">Shared · ' + escapeHtml(st.status || 'waiting for a peer') + '</p>';
				if (st.ownerGithubLogin) {
					html += '<p class="meta">Owner: @' + escapeHtml(String(st.ownerGithubLogin).replace(/^@/, '')) + '</p>';
				}
				if (st.waitingAdmit) {
					html += '<p class="meta">Waiting for the admin to admit you. They pick your role and teams.</p>';
				} else if (st.role && st.role !== 'admin') {
					html += '<p class="meta">Your role: ' + escapeHtml(st.role) + '.</p>';
				}
				if (st.role === 'admin') {
					if (st.sharingActive) {
						html += '<p class="meta">Sharing is on. Other people can receive your changes. ' +
							escapeHtml(String(st.onlineCount || 0)) + ' online now.</p>';
						html += '<p class="meta">The project invite is only a request. You admit each person and pick their role and teams. Make a new invite if you are getting too many requests.</p>';
						html += '<div class="actions">' +
							shareActionButton('copyInvite', 'Copy invite', false, '') +
							shareActionButton('rotateInvite', 'Make a new invite', true, '') +
							shareActionButton('reconnect', 'Reconnect now', true, '') +
							shareActionButton('stopSharing', 'Stop sharing', true, '') +
							'</div>';
					} else {
						html += '<p class="meta">Sharing is stopped. You can keep working on this PC. Nothing is sent until you start sharing again.</p>';
						html += '<div class="actions">' + shareActionButton('startSharing', 'Start sharing', false, '') + '</div>';
					}
				} else if (st.canToggleSharing) {
					if (st.sharingActive) {
						html += '<p class="meta">' + escapeHtml(String(st.onlineCount || 0)) + ' online now.</p>';
						html += '<div class="actions">' +
							shareActionButton('reconnect', 'Reconnect now', true, '') +
							shareActionButton('stopSharing', 'Stop sharing', true, '') +
							'</div>';
					} else {
						html += '<p class="meta">Sharing is stopped. You can keep working on this PC. Nothing is sent until you start sharing again.</p>';
						html += '<div class="actions">' + shareActionButton('startSharing', 'Start sharing', false, '') + '</div>';
					}
				} else if (st.sharingActive) {
					html += '<p class="meta">' + escapeHtml(String(st.onlineCount || 0)) + ' online now.</p>';
				}
			}
			html += '</div>';

			if (st.shared) {
				var members = Array.isArray(st.members) ? st.members : [];
				var pending = Array.isArray(st.pendingJoiners) ? st.pendingJoiners : [];
				var allTeams = Array.isArray(st.teams) ? st.teams : [];
				if (st.role === 'admin') {
					html += '<div class="card"><h3 style="margin-top:0;">Waiting to join</h3>';
					html += '<p class="meta">These people used the project invite. Admit them and pick a role and at least one team. Make a new invite if you do not want more requests.</p>';
					if (!pending.length) {
						html += '<p class="meta">No one is waiting.</p>';
					}
					for (var pi = 0; pi < pending.length; pi++) {
						var p = pending[pi] || {};
						var kind = p.isGuest ? 'guest' : 'GitHub';
						html += '<div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--vscode-widget-border, #444);">';
						html += '<p style="margin:0 0 8px;"><strong>' + escapeHtml(p.displayName || p.peerId || 'someone') +
							'</strong> · ' + escapeHtml(kind) + '</p>';
						html += '<label class="row" style="align-items:center;margin:6px 0;"><span style="min-width:6em;">Role</span>';
						html += '<select data-admit-role="1" data-peer-id="' + escapeHtml(p.peerId || '') + '">';
						var admitRoles = ['viewer', 'updater', 'member', 'admin'];
						for (var rr = 0; rr < admitRoles.length; rr++) {
							html += '<option value="' + admitRoles[rr] + '"' + (admitRoles[rr] === 'member' ? ' selected' : '') + '>' +
								admitRoles[rr] + '</option>';
						}
						html += '</select></label>';
						html += '<p class="meta" style="margin-top:8px;">Teams</p>';
						for (var ti = 0; ti < allTeams.length; ti++) {
							var tm = allTeams[ti] || {};
							html += '<label style="display:block;margin:4px 0;"><input type="checkbox" data-admit-team="1" data-peer-id="' +
								escapeHtml(p.peerId || '') + '" value="' + escapeHtml(tm.id || '') + '" /> ' +
								escapeHtml(tm.name || tm.id || '') + '</label>';
						}
						html += '<div class="actions" style="margin-top:8px;">' +
							shareActionButton('admitJoiner', 'Admit', false, p.peerId || '') +
							shareActionButton('declineJoiner', 'Decline', true, p.peerId || '') +
							'</div></div>';
					}
					html += '</div>';

					html += '<div class="card"><h3 style="margin-top:0;">Members</h3>';
					if (!members.length) {
						html += '<p class="meta">No members listed yet.</p>';
					}
					for (var mi = 0; mi < members.length; mi++) {
						var m = members[mi] || {};
						var isYou = peerIdentity.peerId && m.peerId === peerIdentity.peerId;
						var mKind = m.isGuest ? 'guest' : 'GitHub';
						var label = (m.displayName || m.peerId || 'member') + (isYou ? ' (you)' : '');
						var live = m.online ? 'online' : 'offline';
						html += '<div class="row" style="align-items:center;margin-top:8px;">';
						html += '<span style="flex:1;">' + escapeHtml(label) + ' · ' + escapeHtml(mKind) +
							' · ' + escapeHtml(m.role || '') + ' · ' + escapeHtml(live) + '</span>';
						if (!isYou && m.peerId) {
							html += shareActionButton('passAdmin', 'Pass admin', true, m.peerId);
							html += shareActionButton('removeMember', 'Remove', true, m.peerId);
						}
						html += '</div>';
					}
					html += '<div class="actions" style="margin-top:12px;">' +
						shareActionButton('removeGuests', 'Remove all guests', true, '') +
						'</div>';
					html += '</div>';
				}

				html += renderTeamsCard(st);

				if (st.role === 'admin') {
					html += renderPeopleCard(st);
				}

				if (st.role === 'admin') {
					html += '<div class="card"><h3 style="margin-top:0;">Who can join</h3>';
					if (st.allowGuests === false) {
						html += '<p class="meta">Only people signed in with GitHub can ask to join. Existing guests stay until you remove them. You still admit each person.</p>';
						html += '<div class="actions">' + shareActionButton('allowGuestsOn', 'Also allow guests', true, '') + '</div>';
					} else {
						html += '<p class="meta">GitHub users and guests (PC name) can ask to join. You still admit each person and pick their role.</p>';
						html += '<div class="actions">' + shareActionButton('allowGuestsOff', 'GitHub users only', true, '') + '</div>';
					}
					html += '</div>';

					html += '<div class="card"><h3 style="margin-top:0;">GitHub mailbox (recommended)</h3>';
					html += '<p class="meta">Optional. A private GitHub repo that holds only this project’s signed change log — not the project files, and not a git merge. When it is set, DRIP pulls on open and pushes when you leave if you changed something, then asks anyone still online to pull. A few times a day stays well under GitHub limits.</p>';
					if (st.mailboxRepo) {
						html += '<p class="meta">This project uses <code>' + escapeHtml(st.mailboxRepo) + '</code>.</p>';
						html += '<div class="actions">' +
							shareActionButton('pullMailbox', 'Pull mailbox now', true, '') +
							shareActionButton('pushMailbox', 'Save mailbox now', true, '') +
							shareActionButton('clearMailboxRepo', 'Stop using mailbox', true, '') +
							'</div>';
					} else {
						html += '<p class="meta">Create an empty private repo, then paste <code>owner/repo</code>.</p>';
						html += '<input id="share-mailbox-repo" type="text" placeholder="my-team/shop-drip" autocomplete="off" spellcheck="false" />';
						html += '<div class="actions" style="margin-top:8px;">' + shareActionButton('setMailboxRepo', 'Use this repo', false, '') + '</div>';
					}
					html += '</div>';

					html += '<div class="card"><h3 style="margin-top:0;">Danger zone</h3>';
					html += '<p class="meta">Convert this shared project back to a solo project. Everyone keeps their own copy and stops looking for the others. Members who are online now are told right away; members who are offline are told when they reconnect, or the next time they pull the GitHub mailbox if one is set. Offline members without a mailbox see the project as unreachable and can leave it themselves.</p>';
					html += '<div class="actions">' + shareActionButton('unshareProject', 'Convert to solo project', true, '') + '</div>';
					html += '</div>';
				}

				if (st.role !== 'admin') {
					html += '<div class="card"><h3 style="margin-top:0;">Leave</h3>';
					html += '<p class="meta">You keep a local solo copy. You will not get updates. You can ask to join again later with a project invite.</p>';
					html += '<div class="actions">' + shareActionButton('leave', 'Leave this project', true, '') + '</div></div>';
				}

				var notices = Array.isArray(st.notices) ? st.notices : [];
				if (notices.length) {
					html += '<div class="card"><h3 style="margin-top:0;">Recent notices</h3>';
					for (var ni = 0; ni < notices.length; ni++) {
						var n = notices[ni];
						var text = typeof n === 'string' ? n : (n && (n.message || n.text)) || '';
						if (text) html += '<p class="meta">' + escapeHtml(text) + '</p>';
					}
					html += '</div>';
				}
			}
			shareProjectBodyEl.innerHTML = html;
		}

		function rebuildShareProjectSelect() {
			var next = fillProjectSelect(shareProjectSelectEl, false, selectedShareProjectKey);
			if (!next) {
				selectedShareProjectKey = '';
				selectedShareProjectTitle = '';
				currentShareState = null;
			} else {
				selectedShareProjectKey = next;
				if (!selectedShareProjectTitle) selectedShareProjectTitle = selectedProjectOptionTitle(next);
			}
			requestShareState();
		}

		function collectProjectOverrideForSave() {
			var override = {};
			for (var i = 0; i < projectOverrideState.length; i++) {
				var t = projectOverrideState[i] || {};
				var typeId = String(t.id || '').trim().toLowerCase();
				if (typeId !== 'project' && typeId !== 'feature' && typeId !== 'issue' && typeId !== 'concept' && typeId !== 'decision') continue;
				var attrs = Array.isArray(t.attributes) ? t.attributes : [];
				var attrsObj = {};
				for (var j = 0; j < attrs.length; j++) {
					var a = attrs[j] || {};
					var k = String(a.key || '').trim().toLowerCase();
					if (!k) continue;
					if (typeId === 'issue' && k === 'parent') continue; // fixed parent link is never overridden
					if (!attributeDiffersFromDefault(typeId, k, a)) continue;
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
				if (Object.keys(attrsObj).length) override[typeId] = { attributes: attrsObj };
			}
			return override;
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
					if (panelId === 'project-sharing') {
						requestShareState();
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
			if (kbExtDmd.checked) add('.d.md');
			if (!out.length) add('.d.txt');
			return out;
		}

		function rebuildDefaultSelect(exts, selected) {
			kbDefaultExt.innerHTML = '';
			// The "New note uses" dropdown is fixed to the two DRIP note formats.
			// Any extra configured extensions (e.g. `.md`) still appear in KB tree/scans
			// but are not valid new-note formats.
			var list = ['.d.txt', '.d.md'];
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
				return l !== '.d.txt' && l !== '.d.md';
			});
			kbExtDtxt.checked = low.indexOf('.d.txt') >= 0;
			kbExtDmd.checked = low.indexOf('.d.md') >= 0;
			if (!kbExtDtxt.checked && !kbExtDmd.checked && preservedOtherExts.length === 0) {
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
			projectsList = Array.isArray(message.projects) ? message.projects : [];
			projectOverrides = message.projectMetadataOverrides && typeof message.projectMetadataOverrides === 'object'
				? message.projectMetadataOverrides
				: {};
			peerIdentity = message.peerIdentity && typeof message.peerIdentity === 'object'
				? message.peerIdentity
				: { displayName: '', peerId: '' };
			renderShareIdentity();
			rebuildProjectSelect();
			rebuildShareProjectSelect();
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
			} else if (message.type === 'llmStatus') {
				applyLlmStatus(message.status || null);
			} else if (message.type === 'llmTestResult') {
				var card = llmProfilesEl && llmProfilesEl.querySelector('[data-profile-id="' + message.profileId + '"]');
				var statusEl = card && card.querySelector('[data-llm="status"]');
				if (statusEl) {
					statusEl.textContent = (message.ok ? '✓ ' : '✗ ') + (message.message || '');
				}
			} else if (message.type === 'showPanel' && panels[message.panel]) {
				if (message.projectKey != null) {
					selectedProjectKey = String(message.projectKey || '');
					selectedProjectTitle = String(message.projectTitle || '');
					selectedShareProjectKey = String(message.projectKey || '');
					selectedShareProjectTitle = String(message.projectTitle || '');
					if (projectsList.length) {
						rebuildProjectSelect();
						rebuildShareProjectSelect();
					}
				}
				showPanel(message.panel);
				if (message.panel === 'project-sharing') requestShareState();
			} else if (message.type === 'projectShareState') {
				if (String(message.projectKey || '') === selectedShareProjectKey) {
					currentShareState = message.shareState || null;
					renderProjectSharingPanel();
				}
			} else if (message.type === 'peerIdentity') {
				peerIdentity = message.peerIdentity && typeof message.peerIdentity === 'object'
					? message.peerIdentity
					: { displayName: '', peerId: '' };
				renderShareIdentity();
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

		function llmProfileCard(p, active) {
			var activeTag = active
				? '<span class="meta" style="margin-left:6px;">Active</span>'
				: '<button class="secondary" type="button" data-llm="set-active">Set active</button>';
			return '<div class="card llm-profile" data-profile-id="' + escapeHtml(p.id) + '">' +
				'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
					'<span style="font-weight:600;">' + escapeHtml(p.name || 'Provider') + '</span>' +
					activeTag +
				'</div>' +
				'<label class="row" style="display:block;margin-top:8px;"><span>Name</span><input type="text" data-llm="name" value="' + escapeHtml(p.name || '') + '" autocomplete="off" spellcheck="false" /></label>' +
				'<label class="row" style="display:block;margin-top:8px;"><span>Base URL (OpenAI-compatible)</span><input type="text" data-llm="base-url" value="' + escapeHtml(p.baseUrl || '') + '" placeholder="https://api.openai.com/v1" autocomplete="off" spellcheck="false" /></label>' +
				'<label class="row" style="display:block;margin-top:8px;"><span>Model</span><input type="text" data-llm="model" value="' + escapeHtml(p.model || '') + '" placeholder="gpt-4o-mini" autocomplete="off" spellcheck="false" /></label>' +
				'<label class="row" style="margin-top:8px;"><input type="checkbox" data-llm="enabled"' + (p.enabled ? ' checked' : '') + '><span>Enabled</span></label>' +
				'<p class="meta" style="margin:8px 0 0 0;">API key: ' + (p.hasKey ? 'saved (Secret Storage)' : 'not set') + '</p>' +
				'<p class="meta llm-test-status" data-llm="status" style="margin:4px 0 0 0;"></p>' +
				'<label class="row" style="display:block;margin-top:8px;"><span>API key</span><input type="password" data-llm="api-key" placeholder="sk-…" autocomplete="off" spellcheck="false" /></label>' +
				'<div class="actions">' +
					'<button type="button" data-llm="save">Save</button>' +
					'<button type="button" data-llm="test">Test connection</button>' +
					'<button type="button" data-llm="set-key">Save API key</button>' +
					'<button class="secondary" type="button" data-llm="clear-key">Clear API key</button>' +
					'<button class="secondary" type="button" data-llm="delete">Delete</button>' +
				'</div>' +
			'</div>';
		}

		function applyLlmStatus(st) {
			if (!st || !llmProfilesEl) return;
			var profiles = Array.isArray(st.profiles) ? st.profiles : [];
			var activeId = String(st.activeProfileId || '');
			var html = '';
			for (var i = 0; i < profiles.length; i++) {
				html += llmProfileCard(profiles[i], profiles[i].id === activeId);
			}
			if (!profiles.length) {
				html = '<p class="meta">No providers yet — add one below.</p>';
			}
			llmProfilesEl.innerHTML = html;
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
			if (!kbExtDtxt.checked && !kbExtDmd.checked) kbExtDmd.checked = true;
			pushKbExtensionSettings();
		});
		kbExtDmd.addEventListener('change', function () {
			if (!kbExtDtxt.checked && !kbExtDmd.checked) kbExtDtxt.checked = true;
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
			var stateArr = selectedProjectKey
				? projectOverrideState
				: body.getAttribute('data-source') === 'document' ? metadataTypesState : fileLevelTypesState;
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
						reRenderProjectTypeList();
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
			var stateArr = selectedProjectKey
				? projectOverrideState
				: scope.getAttribute('data-source') === 'document' ? metadataTypesState : fileLevelTypesState;
			if (!Number.isFinite(typeIndex) || !stateArr[typeIndex]) return;
			if (role === 'add-attr') {
				ev.preventDefault();
				ev.stopPropagation();
				if (!Array.isArray(stateArr[typeIndex].attributes)) stateArr[typeIndex].attributes = [];
				stateArr[typeIndex].attributes.push({ key: '', kind: 'enum', values: [], default: '', required: false });
				reRenderProjectTypeList();
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
				reRenderProjectTypeList();
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
		document.getElementById('btn-save-project-metadata').addEventListener('click', function () {
			if (selectedProjectKey) {
				vscode.postMessage({
					type: 'saveProjectMetadata',
					projectKey: selectedProjectKey,
					overrides: collectProjectOverrideForSave()
				});
			} else {
				// The default template edits project/feature (file-level) plus issue (document).
				var types = collectTypesForSave();
				vscode.postMessage({
					type: 'updateSetting',
					key: 'fileLevelMetadataTypes',
					value: collectFileLevelTypesForSave()
				});
				vscode.postMessage({ type: 'updateSetting', key: 'metadataTypes', value: types.length ? types : defaultMetadataTypes });
			}
		});
		document.getElementById('btn-reset-project-metadata').addEventListener('click', function () {
			if (selectedProjectKey) {
				projectOverrideState = buildProjectOverrideState(selectedProjectKey);
				renderProjectOverrideTypes();
			} else {
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
			}
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
		});
		if (projectSelectEl) {
			projectSelectEl.addEventListener('change', function () {
				selectedProjectKey = String(projectSelectEl.value || '');
				selectedProjectTitle = selectedProjectOptionTitle(selectedProjectKey);
				renderProjectMetadataPanel();
			});
		}
		if (shareProjectSelectEl) {
			shareProjectSelectEl.addEventListener('change', function () {
				selectedShareProjectKey = String(shareProjectSelectEl.value || '');
				selectedShareProjectTitle = selectedProjectOptionTitle(selectedShareProjectKey);
				currentShareState = null;
				requestShareState();
			});
		}
		function postShareAction(ev) {
			var btn = ev.target && ev.target.closest ? ev.target.closest('[data-share-action]') : null;
			if (!btn) return;
			var action = String(btn.getAttribute('data-share-action') || '');
			if (!action) return;
			var joinEl = document.getElementById('share-join-code');
			var inviteCode = joinEl ? String(joinEl.value || '') : '';
			if (action === 'joinProject' && joinEl) joinEl.value = '';
			var mailboxEl = document.getElementById('share-mailbox-repo');
			var teamNameEl = document.getElementById('share-team-name');
			var peerId = String(btn.getAttribute('data-peer-id') || '');
			var admitRole = '';
			var admitTeams = [];
			if (action === 'admitJoiner' && peerId) {
				var roleSels = document.querySelectorAll('[data-admit-role]');
				for (var rsi = 0; rsi < roleSels.length; rsi++) {
					if (String(roleSels[rsi].getAttribute('data-peer-id') || '') === peerId) {
						admitRole = String(roleSels[rsi].value || 'member');
						break;
					}
				}
				var teamBoxes = document.querySelectorAll('[data-admit-team]');
				for (var tbi = 0; tbi < teamBoxes.length; tbi++) {
					var box = teamBoxes[tbi];
					if (String(box.getAttribute('data-peer-id') || '') !== peerId) continue;
					if (box.checked || box.disabled) admitTeams.push(String(box.value || ''));
				}
			}
			vscode.postMessage({
				type: 'projectShareAction',
				action: action,
				projectKey: selectedShareProjectKey,
				projectTitle: selectedShareProjectTitle,
				peerId: peerId,
				inviteCode: inviteCode,
				mailboxRepo: mailboxEl ? String(mailboxEl.value || '') : '',
				teamName: teamNameEl ? String(teamNameEl.value || '') : '',
				teamId: String(btn.getAttribute('data-team-id') || ''),
				leadPeerId: String(btn.getAttribute('data-lead-peer-id') || ''),
				memberRole: admitRole || String(btn.getAttribute('data-member-role') || ''),
				guestName: String(btn.getAttribute('data-guest-name') || ''),
				teamIds: admitTeams
			});
		}
		function postShareChange(ev) {
			var el = ev.target && ev.target.closest ? ev.target.closest('[data-share-change]') : null;
			if (!el) return;
			var action = String(el.getAttribute('data-share-change') || '');
			if (!action) return;
			vscode.postMessage({
				type: 'projectShareAction',
				action: action,
				projectKey: selectedShareProjectKey,
				projectTitle: selectedShareProjectTitle,
				peerId: String(el.getAttribute('data-peer-id') || el.value || ''),
				teamId: String(el.getAttribute('data-team-id') || ''),
				leadPeerId: action === 'setTeamLead' ? String(el.value || '') : '',
				memberRole: action === 'setMemberRole' ? String(el.value || '') : ''
			});
		}
		var sharePanelEl = document.getElementById('panel-project-sharing');
		if (sharePanelEl) {
			sharePanelEl.addEventListener('click', postShareAction);
			sharePanelEl.addEventListener('change', postShareChange);
			sharePanelEl.addEventListener('click', function (ev) {
				var am = ev.target && ev.target.closest ? ev.target.closest('[data-add-member-team]') : null;
				if (am) { openMemberPicker(am, String(am.getAttribute('data-add-member-team') || '')); return; }
				var at = ev.target && ev.target.closest ? ev.target.closest('[data-add-team-to-peer]') : null;
				if (at) { openTeamPicker(at, String(at.getAttribute('data-add-team-to-peer') || '')); return; }
			});
		}
		document.addEventListener('mousedown', function (ev) {
			var p = document.getElementById('share-picker');
			if (p && !p.contains(ev.target)) closePicker();
		});
		var accountPanelEl = document.getElementById('panel-account');
		if (accountPanelEl) accountPanelEl.addEventListener('click', postShareAction);
		var joinProjectPanelEl = document.getElementById('panel-join-project');
		if (joinProjectPanelEl) joinProjectPanelEl.addEventListener('click', postShareAction);
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
		if (btnLlmAddProfile) {
			btnLlmAddProfile.addEventListener('click', function () {
				vscode.postMessage({ type: 'llmAddProfile', profile: { name: 'Provider', enabled: false } });
			});
		}
		if (llmProfilesEl) {
			// The "Enabled" checkbox carries data-llm="enabled", so a
			// click on it also lands here. Don't swallow the toggle — only buttons need
			// preventDefault; the checkbox is persisted by the change listener below.
			llmProfilesEl.addEventListener('click', function (ev) {
				var target = ev.target;
				if (!target || !target.getAttribute) return;
				var action = target.getAttribute('data-llm');
				var card = target.closest ? target.closest('[data-profile-id]') : null;
				if (!action || !card) return;
				var id = card.getAttribute('data-profile-id');
				if (target.type !== 'checkbox') ev.preventDefault();
				if (action === 'save') {
					vscode.postMessage({
						type: 'llmUpdateProfile',
						profileId: id,
						patch: {
							name: String((card.querySelector('[data-llm="name"]') || {}).value || '').trim(),
							baseUrl: String((card.querySelector('[data-llm="base-url"]') || {}).value || '').trim(),
							model: String((card.querySelector('[data-llm="model"]') || {}).value || '').trim(),
							enabled: !!(card.querySelector('[data-llm="enabled"]') && card.querySelector('[data-llm="enabled"]').checked)
						}
					});
				} else if (action === 'set-key') {
					var key = String((card.querySelector('[data-llm="api-key"]') || {}).value || '').trim();
					if (key) vscode.postMessage({ type: 'llmSetApiKey', profileId: id, value: key });
					var keyInput = card.querySelector('[data-llm="api-key"]');
					if (keyInput) keyInput.value = '';
				} else if (action === 'clear-key') {
					vscode.postMessage({ type: 'llmClearApiKey', profileId: id });
				} else if (action === 'delete') {
					vscode.postMessage({ type: 'llmDeleteProfile', profileId: id });
				} else if (action === 'set-active') {
					vscode.postMessage({ type: 'llmSetActiveProfile', profileId: id });
				} else if (action === 'test') {
					var statusEl = card.querySelector('[data-llm="status"]');
					if (statusEl) statusEl.textContent = 'Testing…';
					vscode.postMessage({ type: 'llmTestConnection', profileId: id });
				}
			});
			// Persist the enabled toggle immediately (the click handler leaves the
			// checkbox alone; a click alone would otherwise never update the profile).
			llmProfilesEl.addEventListener('change', function (ev) {
				var target = ev.target;
				if (!target || !target.getAttribute) return;
				if (target.getAttribute('data-llm') !== 'enabled') return;
				var card = target.closest ? target.closest('[data-profile-id]') : null;
				if (!card) return;
				vscode.postMessage({
					type: 'llmUpdateProfile',
					profileId: card.getAttribute('data-profile-id'),
					patch: { enabled: !!target.checked }
				});
			});
		}
		var btnStartTour = document.getElementById('btn-start-tour');
		if (btnStartTour) {
			btnStartTour.addEventListener('click', startTour);
		}
		var btnTourClose = document.getElementById('tour-close');
		var btnTourNext = document.getElementById('tour-next');
		var btnTourBack = document.getElementById('tour-back');
		var btnTourSkip = document.getElementById('tour-skip');
		if (btnTourClose) btnTourClose.addEventListener('click', closeTour);
		if (btnTourNext) btnTourNext.addEventListener('click', tourNext);
		if (btnTourBack) btnTourBack.addEventListener('click', tourBack);
		if (btnTourSkip) btnTourSkip.addEventListener('click', closeTour);
		if (tourOverlay) {
			tourOverlay.addEventListener('click', function (ev) {
				if (ev.target === tourOverlay) closeTour();
			});
		}
		showPanel(window.__dripSettingsInit.initialPanel);
	