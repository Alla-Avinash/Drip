const vscode = acquireVsCodeApi();
	let currentDraftId = '';
	let remoteNote = { id: '', title: '', headings: '', content: '', metadataFilename: '' };

	const errorEl = document.getElementById('error');
	const suggestedFoldersEl = document.getElementById('suggested-folders');
	const suggestedFilesWrap = document.getElementById('suggested-files-wrap');
	const suggestedFilesEl = document.getElementById('suggested-files');
	const suggestedHeadingsWrap = document.getElementById('suggested-headings-wrap');
	const headingTreeEl = document.getElementById('heading-tree');
	const storageStatusEl = document.getElementById('storage-status');
	const btnCustomSelect = document.getElementById('btn-custom-select');
	const customPickerEl = document.getElementById('custom-picker');
	const pickerBreadcrumbEl = document.getElementById('picker-breadcrumb');
	const pickerFilterEl = document.getElementById('picker-filter');
	const pickerListEl = document.getElementById('picker-list');
	const pickerHeadingWrap = document.getElementById('picker-heading-wrap');
	const pickerHeadingTreeEl = document.getElementById('picker-heading-tree');
	const pickerExploreBodyEl = document.getElementById('picker-explore-body');
	const suggestionsHintEl = document.getElementById('suggestions-hint');
	const suggestionsFlowEl = document.getElementById('suggestions-flow');
	const aiPathsPanelEl = document.getElementById('ai-paths-panel');
	const aiPathsListEl = document.getElementById('ai-paths-list');
	const llmPlanPanelEl = document.getElementById('llm-plan-panel');
	/** Active LLM ingest proposal; its extras ride on the selection only while its target stays selected. */
	let llmProposal = null;
	/** Tree path of the file's own top row: anchoring it places a new heading at the file's top level. */
	const FILE_ROOT_PATH = '::file-root::';
	/** Note without a heading, file target: 'append' to the chosen heading's text, or 'new_heading' with a typed title. */
	let noTitleMode = 'append';
	let noTitleHeading = '';
	/** Heading trees show only persistent (`# .…`) headings; children of hidden headings move up to the nearest shown one. */
	let persistentOnly = !!(vscode.getState() || {}).persistentOnly;
	const sharedFolderActionsEl = document.getElementById('shared-folder-actions');
	const sharedNewFolderNameEl = document.getElementById('shared-new-folder-name');
	const sharedNewFileNameEl = document.getElementById('shared-new-file-name');
	const sharedCreateFolderBtn = document.getElementById('shared-create-folder');
	const sharedCreateFileBtn = document.getElementById('shared-create-file');
	const headingTreeResizeGripEl = document.getElementById('heading-tree-resize-grip');
	const pickerHeadingTreeResizeGripEl = document.getElementById('picker-heading-tree-resize-grip');
	const corpusSel = /** @type {HTMLSelectElement | null} */ (document.getElementById('st-corpus'));
	const corpusEditBtn = document.getElementById('st-corpus-edit');
	const customCorpusPanel = document.getElementById('st-custom-corpus');
	const customEntriesEl = document.getElementById('st-custom-entries');
	const customEmptyEl = document.getElementById('st-custom-empty');
	const customAddBtn = document.getElementById('st-custom-add');
	const customDoneBtn = document.getElementById('st-custom-done');
	const customCancelBtn = document.getElementById('st-custom-cancel');

	/** @type {'working'|'entire'|'custom'} */
	let storageCorpus = 'working';
	/** @type {{ path: string, kind: 'file'|'folder', name: string }[]} */
	let customCorpusPaths = [];
	/** @type {{ path: string, kind: 'file'|'folder', name: string }[] | null} */
	let customCorpusDraft = null;
	let customCorpusEditorOpen = false;
	/** @type {'working'|'entire'|'custom'} */
	let corpusBeforeCustomEdit = 'working';

	function corpusPayload() {
		return {
			corpus: storageCorpus,
			customCorpusPaths: storageCorpus === 'custom' ? customCorpusPaths.slice() : []
		};
	}

	function syncCorpusEditBtn() {
		if (!corpusEditBtn || !corpusSel) return;
		const show = storageCorpus === 'custom' && customCorpusPaths.length > 0 && !customCorpusEditorOpen;
		corpusEditBtn.hidden = !show;
		corpusEditBtn.classList.toggle('hidden', !show);
	}

	function renderCustomCorpusEntries() {
		if (!customEntriesEl || !customEmptyEl) return;
		const entries = Array.isArray(customCorpusDraft) ? customCorpusDraft : [];
		customEntriesEl.innerHTML = entries
			.map(
				(e, i) =>
					`<li class="storage-custom-entry" data-idx="${i}">` +
					`<span class="storage-custom-entry-kind">${e.kind === 'folder' ? 'folder' : 'file'}</span>` +
					`<span class="storage-custom-entry-body">` +
					`<div class="storage-custom-entry-name">${escHtml(e.name || e.path)}</div>` +
					`<div class="storage-custom-entry-path">${escHtml(e.path)}</div>` +
					`</span>` +
					`<button type="button" class="storage-custom-entry-remove" data-idx="${i}" aria-label="Remove">×</button>` +
					`</li>`
			)
			.join('');
		customEmptyEl.hidden = entries.length > 0;
		customEntriesEl.querySelectorAll('.storage-custom-entry-remove').forEach(btn => {
			btn.addEventListener('click', () => {
				const idx = Number(btn.getAttribute('data-idx'));
				if (!Array.isArray(customCorpusDraft) || !Number.isFinite(idx)) return;
				customCorpusDraft.splice(idx, 1);
				renderCustomCorpusEntries();
			});
		});
	}

	function setCustomCorpusEditorOpen(open) {
		customCorpusEditorOpen = !!open;
		if (customCorpusPanel) customCorpusPanel.hidden = !open;
		syncCorpusEditBtn();
	}

	function openCustomCorpusEditor(fromCorpus) {
		const from = String(fromCorpus || storageCorpus || 'working');
		corpusBeforeCustomEdit =
			from === 'custom' && customCorpusPaths.length
				? 'custom'
				: from === 'entire'
					? 'entire'
					: 'working';
		customCorpusDraft = customCorpusPaths.map(e => ({ ...e }));
		renderCustomCorpusEntries();
		setCustomCorpusEditorOpen(true);
		if (corpusSel) corpusSel.value = 'custom';
		storageCorpus = 'custom';
	}

	function finishCustomCorpusDone() {
		const entries = Array.isArray(customCorpusDraft) ? customCorpusDraft : [];
		if (!entries.length) {
			cancelCustomCorpusEditor();
			return;
		}
		customCorpusPaths = entries.map(e => ({ ...e }));
		customCorpusDraft = null;
		storageCorpus = 'custom';
		if (corpusSel) corpusSel.value = 'custom';
		setCustomCorpusEditorOpen(false);
		syncCorpusEditBtn();
	}

	function cancelCustomCorpusEditor() {
		customCorpusDraft = null;
		setCustomCorpusEditorOpen(false);
		if (corpusBeforeCustomEdit === 'custom' && customCorpusPaths.length) {
			storageCorpus = 'custom';
			if (corpusSel) corpusSel.value = 'custom';
		} else if (corpusBeforeCustomEdit === 'entire') {
			storageCorpus = 'entire';
			if (corpusSel) corpusSel.value = 'entire';
		} else {
			storageCorpus = 'working';
			if (corpusSel) corpusSel.value = 'working';
		}
		syncCorpusEditBtn();
	}

	function mergePickedCustomEntries(entries) {
		if (!Array.isArray(customCorpusDraft)) customCorpusDraft = [];
		const seen = new Set(customCorpusDraft.map(e => String(e.path || '').toLowerCase()));
		for (const e of entries || []) {
			const p = String(e.path || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
			if (!p || seen.has(p.toLowerCase())) continue;
			seen.add(p.toLowerCase());
			customCorpusDraft.push({
				path: p,
				kind: e.kind === 'folder' ? 'folder' : 'file',
				name: String(e.name || p)
			});
		}
		renderCustomCorpusEntries();
	}

	function escHtml(s) {
		return String(s || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	const HT_TREE_HEIGHT_KEY_FLOW = 'drip.storageWebview.headingTreeHeight.flow';
	const HT_TREE_HEIGHT_KEY_PICKER = 'drip.storageWebview.headingTreeHeight.picker';
	const HT_TREE_HEIGHT_MIN = 80;
	const HT_TREE_HEIGHT_DEFAULT = 220;

	function clampHeadingTreeHeight(h) {
		const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
		const max = Math.min(1200, Math.floor(vh * 0.92));
		const cap = Math.max(HT_TREE_HEIGHT_MIN + 40, max);
		return Math.max(HT_TREE_HEIGHT_MIN, Math.min(cap, Math.round(h)));
	}

	function readStoredHeadingTreeHeight(key) {
		try {
			const v = localStorage.getItem(key);
			if (v == null) {
				return HT_TREE_HEIGHT_DEFAULT;
			}
			const n = parseInt(v, 10);
			if (!Number.isFinite(n)) {
				return HT_TREE_HEIGHT_DEFAULT;
			}
			return clampHeadingTreeHeight(n);
		} catch (e) {
			return HT_TREE_HEIGHT_DEFAULT;
		}
	}

	function applyHeadingTreeHeight(treeEl, px) {
		if (!treeEl) {
			return;
		}
		treeEl.style.height = clampHeadingTreeHeight(px) + 'px';
	}

	function wireHeadingTreeVerticalResize(treeEl, gripEl, storageKey) {
		if (!treeEl || !gripEl) {
			return;
		}
		applyHeadingTreeHeight(treeEl, readStoredHeadingTreeHeight(storageKey));
		let dragging = false;
		let startY = 0;
		let startH = 0;
		function finish(e) {
			if (!dragging) {
				return;
			}
			dragging = false;
			gripEl.classList.remove('ht-resize-active');
			if (e && e.pointerId != null) {
				try {
					gripEl.releasePointerCapture(e.pointerId);
				} catch (err) {}
			}
			try {
				const h = clampHeadingTreeHeight(Math.round(treeEl.getBoundingClientRect().height));
				treeEl.style.height = h + 'px';
				localStorage.setItem(storageKey, String(h));
			} catch (err) {}
		}
		gripEl.addEventListener('pointerdown', function (e) {
			if (e.button !== 0) {
				return;
			}
			e.preventDefault();
			dragging = true;
			startY = e.clientY;
			startH = treeEl.getBoundingClientRect().height;
			gripEl.classList.add('ht-resize-active');
			try {
				gripEl.setPointerCapture(e.pointerId);
			} catch (err) {}
		});
		gripEl.addEventListener('pointermove', function (e) {
			if (!dragging) {
				return;
			}
			e.preventDefault();
			const dy = e.clientY - startY;
			applyHeadingTreeHeight(treeEl, startH + dy);
		});
		gripEl.addEventListener('pointerup', finish);
		gripEl.addEventListener('pointercancel', finish);
		gripEl.addEventListener('lostpointercapture', function () {
			if (dragging) {
				dragging = false;
				gripEl.classList.remove('ht-resize-active');
			}
		});
	}

	const selectionControlsEl = document.getElementById('selection-controls');
	let storageStageBeforeBrowse = 'idle';

	let selectedTarget = null;
	const collapsedHeadingPaths = new Set();
	let lastFlowTreeContext = null;
	let lastPickerTreeContext = null;
	let selectionControlsChangeWired = false;
	let ingestDropRefPath = '';
	let ingestPosition = '';

	function findHeadingRowInTree(tree, pathStr) {
		if (!tree || pathStr === undefined || pathStr === null) {
			return null;
		}
		const want = String(pathStr);
		const rows = tree.querySelectorAll('.ht-row[data-path]');
		for (let i = 0; i < rows.length; i++) {
			if (rows[i].dataset.path === want) {
				return rows[i];
			}
		}
		return null;
	}

	function hideIngestPreviewLine(container) {
		const stack = container && container.querySelector('.ht-ingest-stack');
		if (!stack) {
			return;
		}
		const preview = stack.querySelector('.ht-ingest-preview');
		if (preview) {
			preview.hidden = true;
			preview.style.left = '';
			preview.style.top = '';
			preview.style.width = '';
		}
	}

	function hideCommittedIngestLine(container) {
		const stack = container && container.querySelector('.ht-ingest-stack');
		if (!stack) {
			return;
		}
		const committed = stack.querySelector('.ht-ingest-committed');
		if (committed) {
			committed.hidden = true;
			committed.style.left = '';
			committed.style.top = '';
			committed.style.width = '';
		}
	}

	function hideIngestDropLineAll() {
		[headingTreeEl, pickerHeadingTreeEl].forEach(function (tree) {
			if (!tree) {
				return;
			}
			hideIngestPreviewLine(tree);
			hideCommittedIngestLine(tree);
		});
	}

	/**
	 * When a selected path is under a collapsed section, only ancestor rows exist in the DOM.
	 * Highlight the deepest visible prefix row; after expanding, the full target row appears and gets the highlight.
	 */
	function visibleHighlightPathForCollapse(targetPath, collapsedSet) {
		if (!targetPath || !collapsedSet) {
			return targetPath || '';
		}
		const segs = String(targetPath).split('/').filter(Boolean);
		if (!segs.length) {
			return targetPath;
		}
		const acc = [];
		for (let i = 0; i < segs.length; i++) {
			acc.push(segs[i]);
			const P = acc.join('/');
			if (i < segs.length - 1 && collapsedSet.has(P)) {
				return P;
			}
		}
		return targetPath;
	}

	function ensureIngestLineLayer(container) {
		if (!container || container.querySelector('.ht-ingest-stack')) {
			return;
		}
		const stack = document.createElement('div');
		stack.className = 'ht-ingest-stack';
		function makeLine(kind) {
			const line = document.createElement('div');
			line.className = 'ht-ingest-line ht-ingest-' + kind;
			line.hidden = true;
			const rail = document.createElement('div');
			rail.className = 'ht-ingest-line-rail';
			const label = document.createElement('div');
			label.className = 'ht-ingest-line-label';
			line.appendChild(rail);
			line.appendChild(label);
			return line;
		}
		stack.appendChild(makeLine('committed'));
		stack.appendChild(makeLine('preview'));
		container.appendChild(stack);
	}

	function getHeadingLabelRect(row) {
		const labelEl = row && row.querySelector ? row.querySelector('.ht-label') : null;
		if (labelEl) {
			return labelEl.getBoundingClientRect();
		}
		return row ? row.getBoundingClientRect() : { left: 0, top: 0, width: 0, bottom: 0 };
	}

	function positionIngestLine(lineEl, container, row, zone) {
		if (!lineEl || !container || !row) {
			return;
		}
		const path = row.dataset.path || '';
		const li = row.closest('.ht-li');
		const treeRect = container.getBoundingClientRect();
		const rowRect = row.getBoundingClientRect();
		const textRect = getHeadingLabelRect(row);
		const hasSub = row.dataset.hasKids === '1';
		let topPx;
		if (zone === 'before') {
			topPx = textRect.top - treeRect.top + container.scrollTop - 5;
		} else if (zone === 'childFirst') {
			topPx = textRect.bottom - treeRect.top + container.scrollTop + 2;
		} else {
			let bottomRef = rowRect.bottom;
			if (hasSub === '1' && li && !collapsedHeadingPaths.has(path)) {
				const nested = li.querySelector('ul.ht-tree-nested');
				if (nested) {
					const nr = nested.getBoundingClientRect();
					bottomRef = nr.bottom;
				}
			}
			topPx = bottomRef - treeRect.top + container.scrollTop + 2;
		}
		const leftPx = textRect.left - treeRect.left + container.scrollLeft;
		const railW = Math.max(28, textRect.width);
		lineEl.style.left = leftPx + 'px';
		lineEl.style.width = railW + 'px';
		lineEl.style.top = topPx + 'px';
		lineEl.hidden = false;
		const rail = lineEl.querySelector('.ht-ingest-line-rail');
		if (rail) {
			rail.style.width = '100%';
		}
	}

	function updateIngestPreviewLine(container, row, zone) {
		const stack = container && container.querySelector('.ht-ingest-stack');
		if (!stack) {
			return;
		}
		const preview = stack.querySelector('.ht-ingest-preview');
		if (!preview) {
			return;
		}
		positionIngestLine(preview, container, row, zone);
	}

	function setCommittedIngestLine(container, row, zone) {
		const stack = container && container.querySelector('.ht-ingest-stack');
		if (!stack) {
			return;
		}
		hideIngestPreviewLine(container);
		const committed = stack.querySelector('.ht-ingest-committed');
		if (!committed) {
			return;
		}
		positionIngestLine(committed, container, row, zone);
	}

	function syncCommittedIngestLines() {
		/* Insert position is set via stacked placeholder row; no horizontal rules. */
	}

	function findHeadingTreeNodeByPath(nodes, pathStr) {
		if (!nodes || !pathStr) {
			return null;
		}
		for (let i = 0; i < nodes.length; i++) {
			const n = nodes[i];
			if (n.path === pathStr) {
				return n;
			}
			if (n.children && n.children.length) {
				const f = findHeadingTreeNodeByPath(n.children, pathStr);
				if (f) {
					return f;
				}
			}
		}
		return null;
	}

	function isFileRoot(p) {
		return p === FILE_ROOT_PATH;
	}

	/** Nodes as displayed: with "Persistent only", hidden headings are dropped and their children promoted. Paths stay real. */
	function visibleHeadingNodes(nodes) {
		if (!persistentOnly) return nodes || [];
		const out = [];
		(nodes || []).forEach(function (n) {
			const kids = visibleHeadingNodes(n.children);
			if (String(n.title || '').trim().startsWith('.')) out.push(Object.assign({}, n, { children: kids }));
			else out.push.apply(out, kids);
		});
		return out;
	}

	function visibleTreeRoots() {
		const raw =
			(lastFlowTreeContext && lastFlowTreeContext.nodes) ||
			(lastPickerTreeContext && lastPickerTreeContext.nodes) ||
			[];
		return visibleHeadingNodes(raw);
	}

	/** Heading path as the host expects it ('' for the file's top level). */
	function realHeadingPath(p) {
		return isFileRoot(p) ? '' : String(p || '');
	}

	function setDefaultIngestToBottomOfAnchor() {
		const anchor = placementAnchorPath;
		if (!anchor) {
			return;
		}
		const roots = visibleTreeRoots();
		const anchorNode = isFileRoot(anchor) ? { children: roots } : findHeadingTreeNodeByPath(roots, anchor);
		if (!anchorNode || !anchorNode.children || !anchorNode.children.length) {
			ingestDropRefPath = anchor;
			ingestPosition = 'sectionEnd';
			return;
		}
		const last = anchorNode.children[anchorNode.children.length - 1];
		ingestDropRefPath = last.path;
		ingestPosition = 'afterSection';
	}

	function computeSlotIndexFromIngest(anchorPath, childNodes, refPath, zone) {
		const childPaths = (childNodes || []).map(function (n) {
			return n.path;
		});
		const n = childPaths.length;
		if (n === 0) {
			return 0;
		}
		if (!refPath || !zone) {
			return n;
		}
		if (refPath === anchorPath && zone === 'childFirst') {
			return 0;
		}
		if (refPath === anchorPath && zone === 'sectionEnd') {
			return n;
		}
		const i = childPaths.indexOf(refPath);
		if (i < 0) {
			return n;
		}
		if (zone === 'before') {
			return i;
		}
		if (zone === 'afterSection') {
			return i + 1;
		}
		return n;
	}

	function applyIngestFromPlaceholderOrder(anchorPath, parentUl) {
		if (!parentUl || anchorPath !== placementAnchorPath) {
			return;
		}
		const lis = Array.from(parentUl.querySelectorAll(':scope > li'));
		const slotLi = parentUl.querySelector(':scope > li.ht-ingest-slot-li');
		if (!slotLi) {
			return;
		}
		const idx = lis.indexOf(slotLi);
		if (idx < 0) {
			return;
		}
		const childPaths = lis
			.filter(function (li) {
				return !li.classList.contains('ht-ingest-slot-li');
			})
			.map(function (li) {
				const r = li.querySelector('.ht-row[data-path]');
				return r ? r.dataset.path : '';
			})
			.filter(Boolean);
		const n = childPaths.length;
		if (n === 0) {
			ingestDropRefPath = anchorPath;
			ingestPosition = 'sectionEnd';
		} else if (idx === 0) {
			ingestDropRefPath = anchorPath;
			ingestPosition = 'childFirst';
		} else if (idx >= lis.length - 1) {
			ingestDropRefPath = childPaths[n - 1];
			ingestPosition = 'afterSection';
		} else {
			const realsBefore = lis.slice(0, idx).filter(function (li) {
				return !li.classList.contains('ht-ingest-slot-li');
			}).length;
			if (realsBefore === 0) {
				ingestDropRefPath = anchorPath;
				ingestPosition = 'childFirst';
			} else {
				ingestDropRefPath = childPaths[realsBefore - 1];
				ingestPosition = 'afterSection';
			}
		}
		if (selectedTarget && selectedTarget.targetType === 'file') {
			selectedTarget.headingPath = ingestDropRefPath;
		}
		const tree = parentUl.closest('.heading-tree');
		if (lastFlowTreeContext && tree && lastFlowTreeContext.container === tree) {
			lastFlowTreeContext.selectedPath = ingestDropRefPath;
		}
		if (lastPickerTreeContext && tree && lastPickerTreeContext.container === tree) {
			lastPickerTreeContext.selectedPath = ingestDropRefPath;
		}
		const hs = document.getElementById('heading-select');
		if (hs) {
			hs.value = ingestDropRefPath;
		}
	}

	function getDragAfterLi(container, y) {
		const lis = Array.from(container.querySelectorAll(':scope > li:not(.ht-ingest-dragging)'));
		let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
		for (let i = 0; i < lis.length; i++) {
			const child = lis[i];
			const box = child.getBoundingClientRect();
			const offset = y - box.top - box.height / 2;
			if (offset < 0 && offset > closest.offset) {
				closest = { offset: offset, element: child };
			}
		}
		return closest.element;
	}

	function wireIngestSlotList(parentUl, anchorPath) {
		if (!parentUl || parentUl.dataset.ingestSlotWired === '1') {
			return;
		}
		parentUl.dataset.ingestSlotWired = '1';
		parentUl.addEventListener('dragover', function (e) {
			const ph = parentUl.querySelector(':scope > li.ht-ingest-slot-li.ht-ingest-dragging');
			if (!ph) {
				return;
			}
			e.preventDefault();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'move';
			}
			const after = getDragAfterLi(parentUl, e.clientY);
			if (after == null) {
				parentUl.appendChild(ph);
			} else {
				parentUl.insertBefore(ph, after);
			}
			applyIngestFromPlaceholderOrder(anchorPath, parentUl);
		});
		parentUl.addEventListener('drop', function (e) {
			e.preventDefault();
		});
	}

	function createIngestPlaceholderLi(parentUl, anchorPath) {
		const li = document.createElement('li');
		li.className = 'ht-li ht-ingest-slot-li';
		const row = document.createElement('div');
		row.className = 'ht-row ht-ingest-placeholder-row';
		const chev = document.createElement('span');
		chev.className = 'ht-chev';
		chev.setAttribute('aria-hidden', 'true');
		chev.style.visibility = 'hidden';
		chev.style.width = '1.35em';
		chev.style.flexShrink = '0';
		const label = document.createElement('span');
		label.className = 'ht-label';
		const rawTitle = (remoteNote.title || '').trim() || noTitleHeadingValue() || 'New note';
		label.textContent = rawTitle.length > 50 ? rawTitle.slice(0, 50) + '...' : rawTitle;
		label.title = rawTitle + ' — drag up or down to choose position in this section';
		row.appendChild(chev);
		row.appendChild(label);
		li.appendChild(row);
		li.draggable = true;
		li.addEventListener('dragstart', function (e) {
			if (!e.dataTransfer) {
				return;
			}
			e.dataTransfer.setData('text/plain', 'drip-ingest-slot');
			e.dataTransfer.effectAllowed = 'move';
			li.classList.add('ht-ingest-dragging');
		});
		li.addEventListener('dragend', function () {
			li.classList.remove('ht-ingest-dragging');
			postSelection();
		});
		wireIngestSlotList(parentUl, anchorPath);
		return li;
	}

	function resetIngestDropTarget() {
		ingestDropRefPath = '';
		ingestPosition = '';
		hideIngestDropLineAll();
	}

	/** Rows with no sub-headings in the tree: only before/after (two bands) so sibling insert between peers is easy. */
	function ingestZoneFromPointer(relY, rowHeight, hasSubHeadingsInTree) {
		const h = rowHeight || 1;
		const y = Math.max(0, Math.min(relY, h));
		if (!hasSubHeadingsInTree) {
			return y < h / 2 ? 'before' : 'afterSection';
		}
		if (y < h / 3) {
			return 'before';
		}
		if (y < (2 * h) / 3) {
			return 'childFirst';
		}
		return 'afterSection';
	}

	let placementAnchorPath = '';
	let anchorLabelClearTimer = null;

	function clearHeadingTreeDynamic(container) {
		if (!container) {
			return;
		}
		container.innerHTML = '';
	}

	function expandAncestorsForPath(pathStr) {
		const segs = String(pathStr || '').split('/').filter(Boolean);
		if (segs.length <= 1) {
			return;
		}
		const acc = [];
		for (let i = 0; i < segs.length - 1; i++) {
			acc.push(segs[i]);
			collapsedHeadingPaths.delete(acc.join('/'));
		}
	}

	function isDirectChildOfAnchorPath(path, anchorPath) {
		if (!anchorPath || !path || path === anchorPath) {
			return false;
		}
		if (persistentOnly) {
			const roots = visibleTreeRoots();
			const anchor = isFileRoot(anchorPath) ? { children: roots } : findHeadingTreeNodeByPath(roots, anchorPath);
			return !!(anchor && (anchor.children || []).some(function (c) { return c.path === path; }));
		}
		if (isFileRoot(anchorPath)) {
			return !path.includes('/');
		}
		const prefix = anchorPath + '/';
		if (!path.startsWith(prefix)) {
			return false;
		}
		return !path.slice(prefix.length).includes('/');
	}

	/**
	 * Canonical row + zone for insert preview/confirm: merges sibling boundary duplicates
	 * (after previous ≡ before current) and maps first-child "before" to anchor childFirst.
	 * Disallows "before" on the anchor row (no insert above the selected section).
	 */
	function resolvePlacementRowAndZone(row, relY, tree) {
		if (!row) {
			return null;
		}
		const labelEl = row.querySelector('.ht-label');
		if (!labelEl) {
			return null;
		}
		const path = row.dataset.path || '';
		const h = labelEl.getBoundingClientRect().height || 1;
		const y = Math.max(0, Math.min(relY, h));
		const hasSub = row.dataset.hasKids === '1';
		let zone = ingestZoneFromPointer(y, h, hasSub);
		const siblingIndex = parseInt(row.dataset.siblingIndex || '0', 10);

		if (path === placementAnchorPath && zone === 'before') {
			return null;
		}

		if (zone === 'before' && siblingIndex > 0) {
			const li = row.closest('.ht-li');
			const prevLi = li && li.previousElementSibling;
			const prevRow = prevLi && prevLi.querySelector('.ht-row');
			if (prevRow && tree && tree.contains(prevRow)) {
				return { row: prevRow, zone: 'afterSection' };
			}
		}

		if (
			zone === 'before' &&
			siblingIndex === 0 &&
			path !== placementAnchorPath &&
			isDirectChildOfAnchorPath(path, placementAnchorPath)
		) {
			const anchorRow = tree ? findHeadingRowInTree(tree, placementAnchorPath) : null;
			if (anchorRow) {
				return { row: anchorRow, zone: 'childFirst' };
			}
		}

		return { row: row, zone: zone };
	}

	function exitPlacementAnchor() {
		placementAnchorPath = '';
		if (anchorLabelClearTimer) {
			clearTimeout(anchorLabelClearTimer);
			anchorLabelClearTimer = null;
		}
		document.querySelectorAll('.heading-tree').forEach(function (el) {
			el.classList.remove('ht-placement-mode');
		});
	}

	function syncComposerPlacementHeadings() {
		const t = (remoteNote.title || '').trim() || 'Untitled note';
		let placement = t;
		if (
			selectedTarget &&
			selectedTarget.targetType === 'file' &&
			storageFlowStage === 'heading' &&
			realHeadingPath(selectedTarget.headingPath)
		) {
			const trail = realHeadingPath(selectedTarget.headingPath).split('/').filter(Boolean).join(' › ');
			placement = trail + ' › ' + t;
		}
		remoteNote.headings = placement;
	}

	function wireHeadingTreeIngestLinePointer() {
		/* Placeholder row reorder only; no separate line UI. */
	}
	wireHeadingTreeIngestLinePointer();
	syncComposerPlacementHeadings();

	document.addEventListener('keydown', function (e) {
		if (e.key !== 'Escape' || !placementAnchorPath) {
			return;
		}
		e.preventDefault();
		exitPlacementAnchor();
		resetIngestDropTarget();
		rerenderHeadingTrees();
		postSelection();
	});
	let suggestedFolderIdx = null;
	let suggestedFileIdx = null;
	let suggestedItemIdx = null;
	let cachedTopFolders = [];
	/** @type {{ type: string, uri: string, label: string, score?: string, headingPaths?: string[], suggestedHeadingPath?: string, headingTree?: unknown[] }[]} */
	let cachedSuggestions = [];
	let pickedFlowFolder = null;
	let pickerCurrentFolderUri = '';
	/** @type {{ label: string, folderUri: string }[]} */
	let cachedPathSegments = [];
	/** @type {'idle'|'folders'|'files'|'heading'|'folder-new'|'browse'} */
	let storageFlowStage = 'idle';
	let aiListMode = false;

	function displayFileLabel(filename) {
		return String(filename || '').replace(/\.d\.txt$/i, '');
	}

	let storageStatusDismissTimer = null;

	function clearStorageStatusTimer() {
		if (storageStatusDismissTimer) {
			clearTimeout(storageStatusDismissTimer);
			storageStatusDismissTimer = null;
		}
	}

	function showStorageStatusMessage(text) {
		clearStorageStatusTimer();
		if (storageStatusEl) {
			storageStatusEl.textContent = text || '';
		}
		if (!text) {
			return;
		}
		storageStatusDismissTimer = setTimeout(function () {
			if (storageStatusEl) {
				storageStatusEl.textContent = '';
			}
			storageStatusDismissTimer = null;
		}, 5000);
	}

	function resetStorageSuggestionsToEmpty(summaryText) {
		clearStorageStatusTimer();
		if (storageStatusEl) {
			storageStatusEl.textContent = '';
		}
		resetIngestDropTarget();
		exitPlacementAnchor();
		selectedTarget = null;
		suggestedFolderIdx = null;
		suggestedFileIdx = null;
		suggestedItemIdx = null;
		cachedTopFolders = [];
		cachedSuggestions = [];
		pickedFlowFolder = null;
		storageFlowStage = 'idle';
		selectionControlsEl.innerHTML = '';
		if (suggestedFoldersEl) {
			suggestedFoldersEl.innerHTML = '';
			suggestedFoldersEl.hidden = false;
		}
		if (suggestedFilesWrap) suggestedFilesWrap.hidden = true;
		if (suggestedFilesEl) suggestedFilesEl.innerHTML = '';
		if (suggestedHeadingsWrap) suggestedHeadingsWrap.hidden = true;
		if (headingTreeEl) clearHeadingTreeDynamic(headingTreeEl);
		if (customPickerEl) customPickerEl.hidden = true;
		if (pickerHeadingWrap) pickerHeadingWrap.hidden = true;
		if (pickerFilterEl) pickerFilterEl.value = '';
		setPickerExploreBodyVisible(true);
		lastBrowseListing = null;
		cachedPathSegments = [];
		storageStageBeforeBrowse = 'idle';
		aiListMode = false;
		if (aiPathsPanelEl) {
			aiPathsPanelEl.hidden = true;
		}
		if (aiPathsListEl) {
			aiPathsListEl.innerHTML = '';
		}
		renderStoragePathBar();
	}

	function browsePickerOpen() {
		return customPickerEl && !customPickerEl.hidden;
	}

	function setPickerExploreBodyVisible(visible) {
		if (pickerExploreBodyEl) {
			pickerExploreBodyEl.hidden = !visible;
		}
	}

	function updateExplorerPanels() {
		if (!suggestedFoldersEl || !suggestedFilesWrap || !suggestedHeadingsWrap) {
			return;
		}
		if (suggestionsFlowEl) {
			suggestionsFlowEl.hidden = browsePickerOpen() || aiListMode;
		}
		if (aiPathsPanelEl) {
			aiPathsPanelEl.hidden = browsePickerOpen() || !aiListMode;
		}
		if (browsePickerOpen()) {
			suggestedFoldersEl.hidden = true;
			suggestedFilesWrap.hidden = true;
			suggestedHeadingsWrap.hidden = true;
			if (suggestionsHintEl) {
				suggestionsHintEl.hidden = true;
			}
		} else {
			if (suggestionsHintEl) {
				suggestionsHintEl.hidden = true;
			}
			suggestedFoldersEl.hidden = !(storageFlowStage === 'folders' && cachedTopFolders.length > 0);
			const showFiles =
				storageFlowStage === 'files' && !(selectedTarget && selectedTarget.targetType === 'file');
			suggestedFilesWrap.hidden = !showFiles;
			const showHeadings =
				storageFlowStage === 'heading' &&
				selectedTarget &&
				selectedTarget.targetType === 'file' &&
				!browsePickerOpen();
			suggestedHeadingsWrap.hidden = !showHeadings;
		}
	}

	function renderSharedFolderActions() {
		if (!sharedFolderActionsEl) {
			return;
		}
		const uri = (pickerCurrentFolderUri || (pickedFlowFolder && pickedFlowFolder.uri) || '').trim();
		const inFolderList =
			!!uri &&
			(browsePickerOpen() || storageFlowStage === 'files' || storageFlowStage === 'browse');
		const hideForTarget =
			(selectedTarget && selectedTarget.targetType === 'file') ||
			(selectedTarget && selectedTarget.targetType === 'folder');
		const show = inFolderList && !hideForTarget && storageFlowStage !== 'folders';
		sharedFolderActionsEl.hidden = !show;
		if (!show) {
			if (sharedNewFolderNameEl) {
				sharedNewFolderNameEl.value = '';
			}
			if (sharedNewFileNameEl) {
				sharedNewFileNameEl.value = '';
			}
		}
	}

	function navigateToFolderUri(folderUri) {
		if (!folderUri) {
			return;
		}
		selectedTarget = null;
		suggestedFileIdx = null;
		suggestedItemIdx = null;
		if (pickerHeadingWrap) {
			pickerHeadingWrap.hidden = true;
		}
		if (suggestedHeadingsWrap) {
			suggestedHeadingsWrap.hidden = true;
		}
		if (headingTreeEl) {
			clearHeadingTreeDynamic(headingTreeEl);
		}
		if (pickerHeadingTreeEl) {
			clearHeadingTreeDynamic(pickerHeadingTreeEl);
		}
		setPickerExploreBodyVisible(true);
		postSelection();
		if (browsePickerOpen()) {
			storageFlowStage = 'browse';
			vscode.postMessage({ type: 'browseKbList', folderUri, ...corpusPayload() });
		} else {
			storageFlowStage = 'files';
			vscode.postMessage({
				type: 'previewFolderFiles',
				note: notePayload(),
				folderUri,
				...corpusPayload()
			});
		}
	}

	function renderFolderBreadcrumbSegments(el, addSep, segments) {
		if (!segments || !segments.length) {
			return;
		}
		const list = segments.length > 1 ? segments.slice(1) : segments;
		for (let i = 0; i < list.length; i++) {
			const seg = list[i];
			addSep();
			const span = document.createElement('span');
			span.className = 'path-seg clickable path-kind-folder';
			span.textContent = seg.label;
			span.title = 'Open this folder';
			(function (uri) {
				span.addEventListener('click', function () {
					navigateToFolderUri(uri);
				});
			})(seg.folderUri);
			el.appendChild(span);
		}
	}

	function onStorageRootClick() {
		if (browsePickerOpen()) {
			selectedTarget = null;
			suggestedFileIdx = null;
			suggestedItemIdx = null;
			storageFlowStage = 'browse';
			setPickerExploreBodyVisible(true);
			if (pickerHeadingWrap) {
				pickerHeadingWrap.hidden = true;
			}
			if (suggestedHeadingsWrap) {
				suggestedHeadingsWrap.hidden = true;
			}
			if (headingTreeEl) {
				clearHeadingTreeDynamic(headingTreeEl);
			}
			if (pickerHeadingTreeEl) {
				clearHeadingTreeDynamic(pickerHeadingTreeEl);
			}
			postSelection();
			vscode.postMessage({ type: 'browseKbList', folderUri: '' , ...corpusPayload() });
		} else {
			goBackToFolderSelection();
		}
	}

	function scrollHeadingTreeIntoView() {
		if (browsePickerOpen() && pickerHeadingWrap) {
			pickerHeadingWrap.hidden = false;
			if (pickerHeadingTreeEl) {
				pickerHeadingTreeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			}
		} else if (suggestedHeadingsWrap) {
			suggestedHeadingsWrap.hidden = false;
			if (headingTreeEl) {
				headingTreeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			}
		}
	}

	function headingPathLeafTitle(pathStr) {
		const parts = String(pathStr || '').split('/').filter(Boolean);
		return parts.length ? parts[parts.length - 1] : '';
	}

	function appendHeadingPathSegments(el, addSepFn) {
		if (!(selectedTarget && selectedTarget.targetType === 'file' && storageFlowStage === 'heading')) {
			return;
		}
		const pathForBar = realHeadingPath(placementAnchorPath || selectedTarget.headingPath || '');
		const leaf = isFileRoot(placementAnchorPath) ? 'top level' : headingPathLeafTitle(pathForBar);
		const hasAnyHeadingList = (selectedTarget.headingPaths || []).length > 0;
		if (!leaf && !hasAnyHeadingList) {
			return;
		}
		addSepFn();
		const hSpan = document.createElement('span');
		hSpan.className = 'path-seg clickable path-kind-heading';
		hSpan.title = pathForBar
			? 'Heading: ' + pathForBar.split('/').filter(Boolean).join(' › ')
			: 'Heading';
		hSpan.textContent = leaf || 'heading';
		hSpan.addEventListener('click', scrollHeadingTreeIntoView);
		el.appendChild(hSpan);
	}

	function renderStoragePathBar() {
		const el = document.getElementById('storage-path-bar');
		if (!el) {
			return;
		}
		try {
		el.innerHTML = '';

		function addSep() {
			const s = document.createElement('span');
			s.className = 'path-sep';
			s.textContent = '›';
			el.appendChild(s);
		}

		const root = document.createElement('span');
		root.className = 'path-root';
		root.textContent = 'Storage';
		if (
			browsePickerOpen() ||
			cachedPathSegments.length > 0 ||
			storageFlowStage === 'files' ||
			storageFlowStage === 'heading' ||
			storageFlowStage === 'browse' ||
			storageFlowStage === 'folder-new'
		) {
			root.classList.add('clickable');
			root.title = browsePickerOpen()
				? 'Knowledge base root'
				: 'Back to top folder suggestions';
			root.addEventListener('click', onStorageRootClick);
		}
		el.appendChild(root);

		const atIdleNoContext =
			!cachedTopFolders.length &&
			!selectedTarget &&
			storageFlowStage === 'idle' &&
			!cachedPathSegments.length &&
			!browsePickerOpen();
		if (atIdleNoContext) {
			return;
		}

		if (storageFlowStage === 'folders' && cachedTopFolders.length) {
			addSep();
			const h = document.createElement('span');
			h.className = 'path-muted';
			h.textContent = 'top folders';
			el.appendChild(h);
			return;
		}

		const folderSegments =
			cachedPathSegments && cachedPathSegments.length
				? cachedPathSegments
				: pickedFlowFolder && pickedFlowFolder.uri
					? [
							{
								label: pickedFlowFolder.label || '(folder)',
								folderUri: pickedFlowFolder.uri
							}
						]
					: [];

		const showFolderCrumbs =
			folderSegments.length &&
			(browsePickerOpen() ||
				storageFlowStage === 'files' ||
				storageFlowStage === 'heading' ||
				storageFlowStage === 'browse' ||
				storageFlowStage === 'folder-new');
		if (showFolderCrumbs) {
			renderFolderBreadcrumbSegments(el, addSep, folderSegments);
		}

		if (selectedTarget && selectedTarget.targetType === 'file') {
			addSep();
			const fn = document.createElement('span');
			fn.className = 'path-seg path-kind-file';
			fn.textContent = displayFileLabel(selectedTarget.label);
			if (storageFlowStage === 'heading') {
				fn.classList.add('clickable');
				fn.title = 'Back to notes in this folder';
				fn.addEventListener('click', goBackToFileSelectionSmart);
			}
			el.appendChild(fn);
		}

		appendHeadingPathSegments(el, addSep);

		if (selectedTarget && selectedTarget.targetType === 'folder') {
			addSep();
			const n = document.createElement('span');
			n.className = 'path-muted';
			n.textContent = 'new note';
			el.appendChild(n);
		}
		} finally {
			updateExplorerPanels();
			renderSharedFolderActions();
		}
	}

	function goBackToFolderSelection() {
		exitPlacementAnchor();
		resetIngestDropTarget();
		selectedTarget = null;
		suggestedFolderIdx = null;
		suggestedFileIdx = null;
		suggestedItemIdx = null;
		aiListMode = false;
		if (aiPathsPanelEl) {
			aiPathsPanelEl.hidden = true;
		}
		if (aiPathsListEl) {
			aiPathsListEl.innerHTML = '';
		}
		pickedFlowFolder = null;
		cachedSuggestions = [];
		storageFlowStage = 'folders';
		if (customPickerEl) {
			customPickerEl.hidden = true;
		}
		lastBrowseListing = null;
		cachedPathSegments = [];
		pickerCurrentFolderUri = '';
		if (pickerHeadingWrap) {
			pickerHeadingWrap.hidden = true;
		}
		if (suggestedFilesWrap) {
			suggestedFilesWrap.hidden = true;
		}
		if (suggestedHeadingsWrap) {
			suggestedHeadingsWrap.hidden = true;
		}
		if (headingTreeEl) {
			clearHeadingTreeDynamic(headingTreeEl);
		}
		if (pickerHeadingTreeEl) {
			clearHeadingTreeDynamic(pickerHeadingTreeEl);
		}
		if (suggestedFoldersEl) {
			suggestedFoldersEl.hidden = false;
		}
		renderSuggestedFolderCards();
		renderStoragePathBar();
		renderSelectionUI();
		renderCardHighlight();
	}

	function goBackToFileSelection() {
		exitPlacementAnchor();
		resetIngestDropTarget();
		selectedTarget = null;
		suggestedFileIdx = null;
		suggestedItemIdx = null;
		storageFlowStage = 'files';
		if (suggestedHeadingsWrap) {
			suggestedHeadingsWrap.hidden = true;
		}
		if (headingTreeEl) {
			clearHeadingTreeDynamic(headingTreeEl);
		}
		if (suggestedFilesWrap) {
			suggestedFilesWrap.hidden = false;
		}
		if (cachedSuggestions.length && pickedFlowFolder) {
			renderSuggestionCards();
		} else if (pickedFlowFolder) {
			vscode.postMessage({
				type: 'previewFolderFiles',
				note: notePayload(),
				folderUri: pickedFlowFolder.uri,
				...corpusPayload()
			});
		}
		renderStoragePathBar();
		renderSelectionUI();
		renderCardHighlight();
	}

	function goBackToFileSelectionFromBrowse() {
		exitPlacementAnchor();
		resetIngestDropTarget();
		selectedTarget = null;
		storageFlowStage = 'browse';
		suggestedFileIdx = null;
		suggestedItemIdx = null;
		setPickerExploreBodyVisible(true);
		if (pickerHeadingWrap) {
			pickerHeadingWrap.hidden = true;
		}
		if (suggestedHeadingsWrap) {
			suggestedHeadingsWrap.hidden = true;
		}
		if (headingTreeEl) {
			clearHeadingTreeDynamic(headingTreeEl);
		}
		if (pickerHeadingTreeEl) {
			clearHeadingTreeDynamic(pickerHeadingTreeEl);
		}
		renderStoragePathBar();
		renderSelectionUI();
		postSelection();
		renderCardHighlight();
	}

	function goBackToFileSelectionSmart() {
		if (browsePickerOpen() && lastBrowseListing) {
			goBackToFileSelectionFromBrowse();
		} else {
			goBackToFileSelection();
		}
	}

	function renderSuggestedFolderCards() {
		if (!suggestedFoldersEl) {
			return;
		}
		if (!cachedTopFolders.length) {
			suggestedFoldersEl.innerHTML = '<p class="meta">No suggestions.</p>';
			return;
		}
		suggestedFoldersEl.innerHTML = cachedTopFolders
				.map(function (f, idx) {
					return (
						'<div class="target-item selectable sf-row" data-sf="' +
						idx +
						'" title="Choose this folder">' +
						'<span class="sf-score">' +
						escapeHtml(f.score) +
						'</span>' +
						'<span class="sf-icon" aria-hidden="true">📁</span>' +
						'<span class="sf-name">' +
						escapeHtml(f.label) +
						'</span>' +
						'</div>'
					);
				})
				.join('');

		for (const row of suggestedFoldersEl.querySelectorAll('[data-sf]')) {
			row.addEventListener('click', function () {
				const idx = Number(row.getAttribute('data-sf'));
				suggestedFolderIdx = idx;
				suggestedItemIdx = null;
				pickedFlowFolder = cachedTopFolders[idx];
				storageFlowStage = 'files';
				suggestedFileIdx = null;
				selectedTarget = null;
				cachedSuggestions = [];
				suggestedFoldersEl.innerHTML = '';
				if (suggestedFilesWrap) {
					suggestedFilesWrap.hidden = true;
				}
				if (suggestedHeadingsWrap) {
					suggestedHeadingsWrap.hidden = true;
				}
				if (headingTreeEl) {
					clearHeadingTreeDynamic(headingTreeEl);
				}
				pickerCurrentFolderUri = pickedFlowFolder.uri;
				renderStoragePathBar();
				renderSelectionUI();
				renderCardHighlight();
				vscode.postMessage({
					type: 'previewFolderFiles',
					note: notePayload(),
					folderUri: pickedFlowFolder.uri,
					...corpusPayload()
				});
			});
		}
	}

	function renderSuggestionCards() {
		if (!suggestedFilesEl) {
			return;
		}
		suggestedFilesEl.innerHTML = '';
		if (!cachedSuggestions.length) {
			suggestedFilesEl.innerHTML = '<p class="meta">No matching folders or notes here.</p>';
			return;
		}

		for (let idx = 0; idx < cachedSuggestions.length; idx++) {
			const item = cachedSuggestions[idx];
			const row = document.createElement('div');
			row.className = 'target-item selectable sf-row';
			row.setAttribute('data-sitem', String(idx));
			const isFolder = item.type === 'folder';
			row.title = isFolder ? 'Open this folder' : 'Choose this note';
			const sc = document.createElement('span');
			sc.className = 'sf-score';
			sc.textContent = item.score || '';
			const ic = document.createElement('span');
			ic.className = 'sf-icon';
			ic.setAttribute('aria-hidden', 'true');
			ic.textContent = isFolder ? '📁' : '📄';
			const nm = document.createElement('span');
			nm.className = 'sf-name';
			nm.textContent = isFolder ? item.label : displayFileLabel(item.label);
			row.appendChild(sc);
			row.appendChild(ic);
			row.appendChild(nm);
			row.addEventListener('click', function () {
				suggestedItemIdx = idx;
				suggestedFileIdx = null;
				if (isFolder) {
					pickedFlowFolder = { uri: item.uri, label: item.label };
					storageFlowStage = 'files';
					selectedTarget = null;
					cachedSuggestions = [];
					suggestedFilesEl.innerHTML = '';
					if (suggestedHeadingsWrap) {
						suggestedHeadingsWrap.hidden = true;
					}
					if (headingTreeEl) {
						clearHeadingTreeDynamic(headingTreeEl);
					}
					pickerCurrentFolderUri = pickedFlowFolder.uri;
					renderStoragePathBar();
					renderSelectionUI();
					renderCardHighlight();
					vscode.postMessage({
						type: 'previewFolderFiles',
						note: notePayload(),
						folderUri: item.uri,
						...corpusPayload()
					});
				} else {
				storageFlowStage = 'heading';
					suggestedFilesEl.innerHTML = '';
				renderCardHighlight();
					applySuggestedFile(item);
				}
			});
			suggestedFilesEl.appendChild(row);
		}
	}

	function collectPathsWithChildren(nodes, out) {
		if (!nodes) return;
		for (let i = 0; i < nodes.length; i++) {
			const n = nodes[i];
			if (n.children && n.children.length) {
				out.push(n.path);
				collectPathsWithChildren(n.children, out);
			}
		}
	}

	function rerenderHeadingTrees() {
		if (lastFlowTreeContext) {
			const c = lastFlowTreeContext;
			renderHeadingTreeInto(c.container, c.nodes, c.selectedPath, c.onPick);
		}
		if (lastPickerTreeContext) {
			const c = lastPickerTreeContext;
			renderHeadingTreeInto(c.container, c.nodes, c.selectedPath, c.onPick);
		}
		requestAnimationFrame(function () {
			syncCommittedIngestLines();
		});
	}

	function appendHeadingTreeNodes(parentUl, nodes, parentPath, selectedPath, onPick) {
		const treeHost =
			parentUl.closest('.heading-tree') ||
			(lastFlowTreeContext && lastFlowTreeContext.container) ||
			(lastPickerTreeContext && lastPickerTreeContext.container);
		const canReorder =
			!persistentOnly &&
			selectedTarget &&
			selectedTarget.targetType === 'file' &&
			nodes &&
			nodes.length > 1;
		const reorderThisRow =
			canReorder &&
			!(
				placementAnchorPath &&
				parentPath === placementAnchorPath &&
				selectedTarget &&
				selectedTarget.fromTreeFlow
			);
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			const li = document.createElement('li');
			li.className = 'ht-li';
			const row = document.createElement('div');
			row.className = 'ht-row';
			row.dataset.path = node.path;
			const depthSegs = (node.path || '').split('/').filter(Boolean).length;
			row.dataset.depth = String(Math.max(0, depthSegs - 1));
			row.dataset.siblingIndex = String(i);
			let rawTarget = '';
			if (ingestDropRefPath && ingestPosition) {
				if (!(selectedTarget && selectedTarget.fromTreeFlow)) {
					rawTarget = ingestDropRefPath;
				}
			} else if (selectedTarget && !selectedTarget.fromTreeFlow) {
				rawTarget = selectedPath || '';
			}
			/* Tree-flow section placement: drive selection highlight from anchor so when an
			 * ancestor is collapsed, visibleHighlightPathForCollapse picks the visible parent. */
			if (selectedTarget && selectedTarget.fromTreeFlow && placementAnchorPath) {
				rawTarget = placementAnchorPath;
			}
			const highlightPath = rawTarget
				? visibleHighlightPathForCollapse(rawTarget, collapsedHeadingPaths)
				: '';
			if (highlightPath && node.path === highlightPath) {
				row.classList.add('ht-selected');
			}
			const hasKids = node.children && node.children.length > 0;
			row.dataset.hasKids = hasKids ? '1' : '0';
			if (placementAnchorPath && node.path === placementAnchorPath) {
				row.classList.add('ht-anchor');
			}
			const chev = document.createElement('button');
			chev.type = 'button';
			chev.className = 'ht-chev';
			chev.setAttribute('aria-expanded', hasKids && !collapsedHeadingPaths.has(node.path) ? 'true' : 'false');
			if (!hasKids) {
				chev.disabled = true;
			} else {
				chev.textContent = collapsedHeadingPaths.has(node.path) ? '▸' : '▾';
				chev.addEventListener('click', function (e) {
				e.stopPropagation();
					e.preventDefault();
					if (collapsedHeadingPaths.has(node.path)) {
						collapsedHeadingPaths.delete(node.path);
					} else {
						collapsedHeadingPaths.add(node.path);
					}
					rerenderHeadingTrees();
				});
			}
			const label = document.createElement('span');
			label.className = 'ht-label';
			const fullTitle = String(node.title || '');
			label.textContent = fullTitle.length > 50 ? fullTitle.slice(0, 50) + '...' : fullTitle;
			label.title = fullTitle;
			if (isFileRoot(node.path)) {
				row.classList.add('ht-file-root');
				label.title = fullTitle + ' — double-click to place the note at the top level of this file';
			}
			row.appendChild(chev);
			row.appendChild(label);

			row.addEventListener('dblclick', function (e) {
				if (e.target.closest('.ht-chev')) {
					return;
				}
				e.preventDefault();
				if (anchorLabelClearTimer) {
					clearTimeout(anchorLabelClearTimer);
					anchorLabelClearTimer = null;
				}
				if (placementAnchorPath === node.path) {
					exitPlacementAnchor();
					resetIngestDropTarget();
					if (selectedTarget && selectedTarget.targetType === 'file') {
						const paths = selectedTarget.headingPaths || [];
						selectedTarget.headingPath =
							paths[0] || selectedTarget.suggestedHeadingPath || '';
					}
					rerenderHeadingTrees();
					renderStoragePathBar();
					renderSelectionUI();
					return;
				}
				expandAncestorsForPath(node.path);
				if (hasKids) {
					collapsedHeadingPaths.delete(node.path);
				}
				placementAnchorPath = node.path;
				if (selectedTarget && selectedTarget.targetType === 'file') {
					selectedTarget.headingPath = node.path;
				}
				setDefaultIngestToBottomOfAnchor();
				document.querySelectorAll('.heading-tree').forEach(function (el) {
					el.classList.add('ht-placement-mode');
				});
				const treeEl = row.closest('.heading-tree');
				if (lastFlowTreeContext && treeEl && lastFlowTreeContext.container === treeEl) {
					lastFlowTreeContext.selectedPath = node.path;
				}
				if (lastPickerTreeContext && treeEl && lastPickerTreeContext.container === treeEl) {
					lastPickerTreeContext.selectedPath = node.path;
				}
				rerenderHeadingTrees();
				renderStoragePathBar();
				renderSelectionUI();
			});

			row.addEventListener('click', function (e) {
				if (e.target.closest('.ht-chev')) {
					return;
				}
				if (e.detail === 2) {
					return;
				}
				if (hasKids) {
					e.preventDefault();
					if (collapsedHeadingPaths.has(node.path)) {
						collapsedHeadingPaths.delete(node.path);
					} else {
						collapsedHeadingPaths.add(node.path);
					}
					rerenderHeadingTrees();
				}
			});

			row.addEventListener('dragover', function (e) {
				const dt = e.dataTransfer;
				if (reorderThisRow) {
					e.preventDefault();
					if (dt) {
						dt.dropEffect = 'move';
					}
				}
			});
			row.addEventListener('drop', function (e) {
				const dt = e.dataTransfer;
				if (!reorderThisRow) {
					return;
				}
				e.preventDefault();
				const fromPath = e.dataTransfer ? e.dataTransfer.getData('application/x-drip-heading') : '';
				const fromParent = e.dataTransfer ? e.dataTransfer.getData('application/x-drip-parent') : '';
				if ((fromParent || '') !== (parentPath || '')) {
					return;
				}
				if (!selectedTarget || selectedTarget.targetType !== 'file') {
					return;
				}
				const paths = nodes.map(function (n) {
					return n.path;
				});
				const fromI = paths.indexOf(fromPath);
				const toI = paths.indexOf(node.path);
				if (fromI < 0 || toI < 0 || fromI === toI) {
					return;
				}
				const next = paths.slice();
				const moved = next.splice(fromI, 1)[0];
				next.splice(toI, 0, moved);
				vscode.postMessage({
					type: 'reorderHeadingSiblings',
					fileUri: selectedTarget.uri,
					parentPath: realHeadingPath(parentPath),
					orderedPaths: next,
					note: notePayload()
				});
			});
			if (reorderThisRow) {
				row.draggable = true;
				row.addEventListener('dragstart', function (e) {
					if (!e.dataTransfer) return;
					e.dataTransfer.setData('application/x-drip-heading', node.path);
					e.dataTransfer.setData('application/x-drip-parent', parentPath || '');
					e.dataTransfer.effectAllowed = 'move';
					row.classList.add('ht-drag');
				});
				row.addEventListener('dragend', function () {
					row.classList.remove('ht-drag');
				});
			}
			if (placementAnchorPath && node.path === placementAnchorPath) {
				const wrap = document.createElement('div');
				wrap.className = 'ht-placement-section-wrap';
				wrap.appendChild(row);
				if (hasKids && !collapsedHeadingPaths.has(node.path)) {
					const sub = document.createElement('ul');
					sub.className = 'ht-tree ht-tree-nested';
					appendHeadingTreeNodes(sub, node.children, node.path, selectedPath, onPick);
					wrap.appendChild(sub);
				} else if (selectedTarget && selectedTarget.fromTreeFlow && !hasKids) {
					const sub = document.createElement('ul');
					sub.className = 'ht-tree ht-tree-nested';
					appendHeadingTreeNodes(sub, [], node.path, selectedPath, onPick);
					wrap.appendChild(sub);
				}
				li.appendChild(wrap);
			} else {
			li.appendChild(row);
				if (hasKids && !collapsedHeadingPaths.has(node.path)) {
				const sub = document.createElement('ul');
					sub.className = 'ht-tree ht-tree-nested';
					appendHeadingTreeNodes(sub, node.children, node.path, selectedPath, onPick);
				li.appendChild(sub);
				}
			}
			parentUl.appendChild(li);
		}
		if (
			placementAnchorPath &&
			parentPath === placementAnchorPath &&
			selectedTarget &&
			selectedTarget.fromTreeFlow &&
			!noTitleAppendActive()
		) {
			const slotIdx = computeSlotIndexFromIngest(
				placementAnchorPath,
				nodes,
				ingestDropRefPath,
				ingestPosition
			);
			const phLi = createIngestPlaceholderLi(parentUl, placementAnchorPath);
			if (slotIdx >= parentUl.children.length) {
				parentUl.appendChild(phLi);
			} else {
				parentUl.insertBefore(phLi, parentUl.children[slotIdx]);
			}
		}
	}

	function renderHeadingTreeInto(container, nodes, selectedPath, onPick) {
		if (!container) {
			return;
		}
		const ctx = { container: container, nodes: nodes, selectedPath: selectedPath, onPick: onPick };
		if (container === headingTreeEl) {
			lastFlowTreeContext = ctx;
		} else if (container === pickerHeadingTreeEl) {
			lastPickerTreeContext = ctx;
		}
		clearHeadingTreeDynamic(container);
		ensureIngestLineLayer(container);
		const treeNodes =
			selectedTarget && selectedTarget.targetType === 'file'
				? [{ path: FILE_ROOT_PATH, title: displayFileLabel(selectedTarget.label), children: visibleHeadingNodes(nodes) }]
				: visibleHeadingNodes(nodes);
		if (!treeNodes || !treeNodes.length) {
			const empty = document.createElement('p');
			empty.className = 'meta';
			empty.textContent = 'No headings in this file.';
			container.appendChild(empty);
			requestAnimationFrame(function () {
				syncCommittedIngestLines();
			});
			return;
		}
		const ul = document.createElement('ul');
		ul.className = 'ht-tree ht-tree-root';
		appendHeadingTreeNodes(ul, treeNodes, '', selectedPath, onPick);
		container.appendChild(ul);
		requestAnimationFrame(function () {
			syncCommittedIngestLines();
		});
	}

	(function wireHeadingTreeToolbarButtons() {
		function bindExpandCollapse(expandId, collapseId, getRootNodes) {
			const ex = document.getElementById(expandId);
			const cl = document.getElementById(collapseId);
			if (ex) {
				ex.addEventListener('click', function () {
					collapsedHeadingPaths.clear();
					rerenderHeadingTrees();
				});
			}
			if (cl) {
				cl.addEventListener('click', function () {
					const roots = getRootNodes();
					const all = [];
					collectPathsWithChildren(roots, all);
					all.forEach(function (p) {
						collapsedHeadingPaths.add(p);
					});
					rerenderHeadingTrees();
				});
			}
		}
		bindExpandCollapse('ht-expand-flow', 'ht-collapse-flow', function () {
			return visibleHeadingNodes(lastFlowTreeContext && lastFlowTreeContext.nodes);
		});
		bindExpandCollapse('ht-expand-picker', 'ht-collapse-picker', function () {
			return visibleHeadingNodes(lastPickerTreeContext && lastPickerTreeContext.nodes);
		});
		const persistentBoxes = Array.from(document.querySelectorAll('.ht-persistent-only'));
		persistentBoxes.forEach(function (box) {
			box.checked = persistentOnly;
			box.addEventListener('change', function () {
				persistentOnly = box.checked;
				persistentBoxes.forEach(function (b) { b.checked = persistentOnly; });
				vscode.setState(Object.assign({}, vscode.getState() || {}, { persistentOnly: persistentOnly }));
				if (placementAnchorPath && !isFileRoot(placementAnchorPath) && !findHeadingTreeNodeByPath(visibleTreeRoots(), placementAnchorPath)) {
					exitPlacementAnchor();
				}
				resetIngestDropTarget();
				if (placementAnchorPath) setDefaultIngestToBottomOfAnchor();
				rerenderHeadingTrees();
				postSelection();
			});
		});
		function bindRefresh(refreshId) {
			const btn = document.getElementById(refreshId);
			if (!btn) {
					return;
				}
			btn.addEventListener('click', function () {
				if (!selectedTarget || selectedTarget.targetType !== 'file' || !selectedTarget.uri) {
					return;
				}
				vscode.postMessage({
					type: 'getFileHeadingMeta',
					fileUri: selectedTarget.uri,
					note: notePayload()
				});
			});
		}
		bindRefresh('ht-refresh-flow');
		bindRefresh('ht-refresh-picker');
	})();

	function wireCustomPicker() {
		if (!btnCustomSelect) return;
		btnCustomSelect.addEventListener('click', function () {
			if (!customPickerEl.hidden) {
				return;
			}
			hideLlmPlan();
			aiListMode = false;
			if (aiPathsPanelEl) {
				aiPathsPanelEl.hidden = true;
			}
			if (aiPathsListEl) {
				aiPathsListEl.innerHTML = '';
			}
			storageStageBeforeBrowse = storageFlowStage;
			customPickerEl.hidden = false;
			storageFlowStage = 'browse';
			vscode.postMessage({ type: 'browseKbList', folderUri: '' , ...corpusPayload() });
			renderStoragePathBar();
		});
		pickerFilterEl.addEventListener('input', function () {
			renderPickerListFiltered();
		});
	}

	let lastBrowseListing = null;

	function renderPickerListFiltered() {
		if (!lastBrowseListing || !pickerListEl) return;
		const q = (pickerFilterEl.value || '').toLowerCase().trim();
		const folders = (lastBrowseListing.folders || []).filter(function (f) {
			return !q || f.name.toLowerCase().indexOf(q) >= 0;
		});
		const files = (lastBrowseListing.files || []).filter(function (f) {
			return !q || f.name.toLowerCase().indexOf(q) >= 0;
		});
		pickerListEl.innerHTML = '';
		folders.forEach(function (f) {
			const div = document.createElement('div');
			div.className = 'picker-item';
			div.innerHTML = '<span class="sym">📁</span><span>' + escapeHtml(f.name) + '</span>';
			div.addEventListener('click', function () {
				vscode.postMessage({ type: 'browseKbList', folderUri: f.uri, ...corpusPayload() });
			});
			pickerListEl.appendChild(div);
		});
		files.forEach(function (f) {
			const div = document.createElement('div');
			div.className = 'picker-item';
			div.innerHTML = '<span class="sym">📄</span><span>' + escapeHtml(f.name) + '</span>';
			div.addEventListener('click', function () {
				vscode.postMessage({ type: 'getFileHeadingMeta', fileUri: f.uri, note: notePayload() });
			});
			pickerListEl.appendChild(div);
		});
		if (!folders.length && !files.length) {
			pickerListEl.innerHTML = '<p class="meta">No matches.</p>';
		}
	}

	wireCustomPicker();

	function wireSharedFolderActions() {
		if (sharedCreateFolderBtn) {
			sharedCreateFolderBtn.addEventListener('click', function () {
				const name = sharedNewFolderNameEl ? sharedNewFolderNameEl.value.trim() : '';
				if (!name || !pickerCurrentFolderUri) {
				return;
			}
				vscode.postMessage({
					type: 'createSubfolderFromPicker',
					parentUri: pickerCurrentFolderUri,
					name,
					...corpusPayload()
				});
				if (sharedNewFolderNameEl) {
					sharedNewFolderNameEl.value = '';
				}
			});
		}
		if (sharedCreateFileBtn) {
			sharedCreateFileBtn.addEventListener('click', function () {
				const title = sharedNewFileNameEl ? sharedNewFileNameEl.value.trim() : '';
				if (!title || !pickerCurrentFolderUri) {
					return;
				}
				vscode.postMessage({
					type: 'createNoteInFolderFromPicker',
					folderUri: pickerCurrentFolderUri,
					title,
					...corpusPayload()
				});
				if (sharedNewFileNameEl) {
					sharedNewFileNameEl.value = '';
				}
			});
		}
		function bindEnter(inputEl, buttonEl) {
			if (!inputEl || !buttonEl) {
				return;
			}
			inputEl.addEventListener('keydown', function (e) {
				if (e.key === 'Enter') {
					e.preventDefault();
					buttonEl.click();
				}
			});
		}
		bindEnter(sharedNewFolderNameEl, sharedCreateFolderBtn);
		bindEnter(sharedNewFileNameEl, sharedCreateFileBtn);
	}

	wireSharedFolderActions();
	wireHeadingTreeVerticalResize(headingTreeEl, headingTreeResizeGripEl, HT_TREE_HEIGHT_KEY_FLOW);
	wireHeadingTreeVerticalResize(pickerHeadingTreeEl, pickerHeadingTreeResizeGripEl, HT_TREE_HEIGHT_KEY_PICKER);

	function applyAiPathSuggestion(p) {
		aiListMode = false;
		exitPlacementAnchor();
		resetIngestDropTarget();
		cachedPathSegments = Array.isArray(p.pathSegments) ? p.pathSegments : [];
		if (p.targetType === 'folder') {
			pickedFlowFolder = { uri: p.uri, label: p.displayPath || p.label };
			pickerCurrentFolderUri = p.uri;
			selectedTarget = {
				targetType: 'folder',
				uri: p.uri,
				label: p.label,
				fileNameDefault: draftTitle()
			};
			storageFlowStage = 'folder-new';
		} else {
			pickedFlowFolder = { uri: p.parentFolderUri, label: p.parentDisplayPath || '(folder)' };
			pickerCurrentFolderUri = p.parentFolderUri;
			selectedTarget = {
				targetType: 'file',
				uri: p.uri,
				label: p.label,
				headingPaths: p.headingPaths || [],
				headingPath: p.headingPath || '',
				suggestedHeadingPath: p.headingPath || '',
				headingTree: p.headingTree || [],
				fromTreeFlow: true
			};
			storageFlowStage = 'heading';
			if (suggestedHeadingsWrap) {
				suggestedHeadingsWrap.hidden = false;
			}
			if (suggestedFilesWrap) {
				suggestedFilesWrap.hidden = true;
			}
			const initial = selectedTarget.headingPath;
			function onPickFlow(path) {
				selectedTarget.headingPath = path;
				renderHeadingTreeInto(
					headingTreeEl,
					selectedTarget.headingTree || [],
					path,
					onPickFlow
				);
				renderSelectionUI();
				renderStoragePathBar();
			}
			renderHeadingTreeInto(headingTreeEl, selectedTarget.headingTree || [], initial, onPickFlow);
			if (p.kind === 'file') {
				// File suggestion: open placement at the file's top level (new heading, not nested).
				placementAnchorPath = FILE_ROOT_PATH;
				selectedTarget.headingPath = FILE_ROOT_PATH;
				setDefaultIngestToBottomOfAnchor();
				document.querySelectorAll('.heading-tree').forEach(function (el) {
					el.classList.add('ht-placement-mode');
				});
				rerenderHeadingTrees();
			}
		}
		renderSelectionUI();
		renderStoragePathBar();
		updateExplorerPanels();
		renderSharedFolderActions();
		postSelection();
	}

	function hideLlmPlan() {
		llmProposal = null;
		if (llmPlanPanelEl) {
			llmPlanPanelEl.hidden = true;
			llmPlanPanelEl.innerHTML = '';
			llmPlanPanelEl.className = 'llm-plan-panel';
		}
	}

	function showLlmPlanStatus(text, isError) {
		if (!llmPlanPanelEl) return;
		llmPlanPanelEl.hidden = false;
		llmPlanPanelEl.className = 'llm-plan-panel';
		llmPlanPanelEl.innerHTML =
			'<p class="' + (isError ? 'error' : 'meta') + '" style="margin:0">' + escHtml(text) + '</p>';
	}

	const LLM_ICONS = {
		append: '<path d="M2 3.5h9M2 6.5h9M2 9.5h5"/><path d="M11.5 8.5v6M9 12l2.5 2.5L14 12"/>',
		heading: '<path d="M5.5 2l-1 12M10.5 2l-1 12M2.5 5.5h11M2 10.5h11"/>',
		file: '<path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/>',
		folder: '<path d="M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z"/>'
	};

	/** Per action: card colour class, icon, headline, and what Ingest will do. */
	const LLM_ACTIONS = {
		append: { cls: 'append', icon: 'append', title: 'Append to an existing heading', hint: 'Ingest adds the note text to the end of this heading. No new heading is created.' },
		new_heading: { cls: 'heading', icon: 'heading', title: 'Create a new heading', hint: 'Ingest creates the new heading here with the note inside it.' },
		new_file: { cls: 'file', icon: 'file', title: 'Create a new file', hint: 'Ingest creates the new file here. You can rename it in Name below.' },
		new_folder: { cls: 'folder', icon: 'folder', title: 'Create a new folder', hint: 'Ingest creates the new folder and a file inside it. You can rename the file in Name below.' }
	};

	function llmIcon(name) {
		return (
			'<svg class="llm-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
			(LLM_ICONS[name] || '') +
			'</svg>'
		);
	}

	/** Destination as a small tree: existing places, then the new item(s) Ingest will create. */
	function llmDestinationHtml(p) {
		const crumbs = Array.isArray(p.crumbs) ? p.crumbs : [];
		const newItems = Array.isArray(p.newItems) ? p.newItems : [];
		const bindFor = { heading: 'title', folder: 'folder', file: 'file' };
		let html = '<div class="llm-dest"><div class="llm-dest-row llm-dest-root" style="padding-left:0">' + llmIcon('folder') + '<span>Knowledge base</span></div>';
		let depth = 1;
		crumbs.forEach(function (c, i) {
			const isTarget = p.extras.mode === 'append' && i === crumbs.length - 1;
			html +=
				'<div class="llm-dest-row' + (isTarget ? ' llm-dest-target' : '') + '" style="padding-left:' + depth * 12 + 'px">' +
				llmIcon(c.kind) + '<span>' + escHtml(c.label) + '</span>' +
				(isTarget ? '<span class="llm-dest-tag">text goes here</span>' : '') +
				'</div>';
			depth += 1;
		});
		newItems.forEach(function (n) {
			html +=
				'<div class="llm-dest-row llm-dest-new" style="padding-left:' + depth * 12 + 'px">' +
				llmIcon(n.kind) + '<span data-llm-bind="' + (bindFor[n.kind] || '') + '">' + escHtml(n.label) + '</span>' +
				'<span class="llm-dest-tag">new</span></div>';
			depth += 1;
		});
		return html + '</div>';
	}

	/** Keep the "new" items in the tree in step with the title / folder / file name inputs. */
	function syncLlmDestinationLabels() {
		if (!llmProposal || !llmPlanPanelEl) return;
		const sources = { title: 'llm-note-title', folder: 'llm-folder-name', file: 'new-file-name' };
		llmPlanPanelEl.querySelectorAll('[data-llm-bind]').forEach(function (el) {
			const input = document.getElementById(sources[el.getAttribute('data-llm-bind')] || '');
			if (input && input.value.trim()) el.textContent = input.value.trim();
		});
	}

	document.addEventListener('input', function (e) {
		const id = e.target && e.target.id;
		if (id === 'llm-note-title' || id === 'llm-folder-name' || id === 'new-file-name') syncLlmDestinationLabels();
	});

	function formatSeconds(ms) {
		return (Math.max(0, Number(ms) || 0) / 1000).toFixed(1) + ' s';
	}

	function llmTimingHtml(result) {
		const t = result.timings;
		if (!t) return '';
		const local = (t.syncMs || 0) + (t.encodeMs || 0) + (t.searchMs || 0);
		let text = 'Local search ' + formatSeconds(local) + ' · LLM' + (result.model ? ' (' + result.model + ')' : '') + ' ' + formatSeconds(t.llmMs);
		if (t.syncMs > 1000) text += ' · first run indexed file paths in ' + formatSeconds(t.syncMs);
		return '<p class="llm-plan-timing">' + escHtml(text) + '</p>';
	}

	/** Proposal card: target is pre-selected below; the normal Ingest button applies it. */
	function renderLlmPlan(result) {
		if (!llmPlanPanelEl) return;
		if (!result || !result.ok) {
			llmProposal = null;
			showLlmPlanStatus((result && result.message) || 'The LLM could not suggest a place.', true);
			return;
		}
		const p = result.proposal;
		applyAiPathSuggestion(p.path);
		if (p.path.targetType === 'folder' && selectedTarget) {
			selectedTarget.fileNameDefault = p.title;
			renderSelectionUI();
		}
		llmProposal = {
			extras: p.extras,
			targetUri: p.path.uri,
			headingPath: p.path.headingPath || ''
		};
		const mode = p.extras.mode;
		const act = LLM_ACTIONS[mode] || LLM_ACTIONS.append;
		let html =
			'<div class="llm-plan-head">' +
			'<span class="llm-act-icon">' + llmIcon(act.icon) + '</span>' +
			'<span class="llm-act-title">' + escHtml(act.title) + '</span>' +
			'<span class="llm-badge">LLM</span></div>';
		html += llmDestinationHtml(p);
		if (p.reason) html += '<p class="llm-plan-reason">' + escHtml(p.reason) + '</p>';
		if (mode === 'new_heading') {
			html +=
				'<div class="llm-plan-field"><label for="llm-note-title">New heading title</label>' +
				'<input id="llm-note-title" value="' + escHtml(p.title) + '" /></div>';
		}
		if (mode === 'new_folder') {
			html +=
				'<div class="llm-plan-field"><label for="llm-folder-name">New folder name</label>' +
				'<input id="llm-folder-name" value="' + escHtml(p.folderName) + '" /></div>';
		}
		html += '<p class="meta">' + escHtml(act.hint) + ' Click Ingest to apply; choosing another target cancels this suggestion.</p>';
		const split = Array.isArray(result.split) ? result.split : [];
		if (split.length >= 2) {
			html +=
				'<div class="llm-plan-split"><p><strong>This note looks like ' + split.length + ' separate topics:</strong></p><ol>' +
				split
					.map(function (s) {
						const preview = String(s.text || '').replace(/\s+/g, ' ');
						return (
							'<li><strong>' + escHtml(s.title || 'Untitled') + '</strong> — <span class="llm-plan-preview">' +
							escHtml(preview.length > 90 ? preview.slice(0, 90) + '…' : preview) + '</span></li>'
						);
					})
					.join('') +
				'</ol><div class="llm-plan-actions">' +
				'<button type="button" id="llm-split-yes">Split into ' + split.length + ' notes</button>' +
				'<button type="button" class="secondary" id="llm-split-no">Keep as one note</button></div></div>';
		}
		html += '<div class="llm-plan-actions"><button type="button" class="secondary" id="llm-dismiss">Dismiss</button></div>';
		html += llmTimingHtml(result);
		llmPlanPanelEl.hidden = false;
		llmPlanPanelEl.className = 'llm-plan-panel llm-act-' + act.cls;
		llmPlanPanelEl.innerHTML = html;

		for (const id of ['llm-note-title', 'llm-folder-name']) {
			const el = document.getElementById(id);
			if (el) el.addEventListener('input', postSelection);
		}
		const dismiss = document.getElementById('llm-dismiss');
		if (dismiss) {
			dismiss.addEventListener('click', function () {
				hideLlmPlan();
				postSelection();
			});
		}
		const splitNo = document.getElementById('llm-split-no');
		if (splitNo) {
			splitNo.addEventListener('click', function () {
				const box = llmPlanPanelEl.querySelector('.llm-plan-split');
				if (box) box.remove();
			});
		}
		const splitYes = document.getElementById('llm-split-yes');
		if (splitYes) {
			splitYes.addEventListener('click', function () {
				const parts = split.map(function (s) {
					return { title: s.title, text: s.text };
				});
				showLlmPlanStatus('Splitting the note and finding a place for part 1…', false);
				vscode.postMessage(Object.assign({ type: 'llmIngestSplit', note: notePayload(), parts: parts }, corpusPayload()));
			});
		}
		renderSelectionUI();
	}

	/** LLM extras for the selection payload — only while the proposal's own target is selected. */
	function llmSelectionExtras(payload) {
		if (!llmProposal || !payload || payload.uri !== llmProposal.targetUri) return {};
		const ex = llmProposal.extras || {};
		if (payload.targetType === 'file') {
			if (ex.mode === 'append' && payload.headingPath === llmProposal.headingPath) {
				return { appendTo: { fileId: ex.fileId, headingId: ex.headingId } };
			}
			if (ex.mode === 'new_heading') {
				const t = document.getElementById('llm-note-title');
				return { noteTitle: t ? t.value.trim() : ex.noteTitle || '' };
			}
			return {};
		}
		if (payload.targetType === 'folder' && (ex.mode === 'new_file' || ex.mode === 'new_folder')) {
			const out = { noteTitle: String(payload.fileName || '').trim() };
			if (ex.mode === 'new_folder') {
				const f = document.getElementById('llm-folder-name');
				out.newFolderName = f ? f.value.trim() : ex.newFolderName || '';
			}
			return out;
		}
		return {};
	}

	document.getElementById('llm-suggest-btn').addEventListener('click', () => {
		clearMessages();
		llmProposal = null;
		resetStorageSuggestionsToEmpty();
		updateExplorerPanels();
		showLlmPlanStatus('Finding related folders, files and headings, then asking the LLM…', false);
		vscode.postMessage(Object.assign({ type: 'llmIngestPlan', note: notePayload() }, corpusPayload()));
	});

	function renderAiPathResults(paths) {
		if (!aiPathsListEl) {
			return;
		}
		aiPathsListEl.innerHTML = '';
		if (!paths || !paths.length) {
			aiPathsListEl.innerHTML = '<p class="meta">No paths found.</p>';
			return;
		}
		for (let idx = 0; idx < paths.length; idx++) {
			const p = paths[idx];
			const row = document.createElement('div');
			row.className = 'target-item selectable sf-row ai-path-row';
			row.setAttribute('data-ai-idx', String(idx));
			const sc = document.createElement('span');
			sc.className = 'sf-score';
			sc.textContent = p.score || '';
			const kind = p.kind || (p.targetType === 'folder' ? 'folder' : p.headingPath ? 'heading' : 'file');
			const ic = document.createElement('span');
			ic.className = 'sf-icon';
			ic.setAttribute('aria-hidden', 'true');
			ic.textContent = kind === 'folder' ? '📁' : kind === 'file' ? '📄' : '#';
			const nm = document.createElement('span');
			nm.className = 'sf-name';
			if (kind === 'folder') {
				nm.textContent = 'Folder · ' + (p.displayPath || p.label) + ' (new note)';
			} else if (kind === 'file') {
				nm.textContent = 'File · ' + p.displayPath + ' (top level)';
			} else {
				nm.textContent = p.displayPath + ' → ' + String(p.headingPath).split('/').join(' › ');
			}
			row.appendChild(sc);
			row.appendChild(ic);
			row.appendChild(nm);
			(function (payload) {
				row.addEventListener('click', function () {
					applyAiPathSuggestion(payload);
				});
			})(p);
			aiPathsListEl.appendChild(row);
		}
	}

	function applySuggestedFile(file) {
		selectedTarget = {
			targetType: 'file',
			uri: file.uri,
			label: file.label,
			headingPaths: file.headingPaths || [],
			headingPath: file.suggestedHeadingPath || '',
			suggestedHeadingPath: file.suggestedHeadingPath,
			headingTree: file.headingTree || [],
			fromTreeFlow: true
		};
		if (suggestedHeadingsWrap) {
			suggestedHeadingsWrap.hidden = false;
		}
		if (suggestedFilesWrap) {
			suggestedFilesWrap.hidden = true;
		}
		const initial = selectedTarget.headingPath;
		function onPickFlow(path) {
			selectedTarget.headingPath = path;
			renderHeadingTreeInto(
				headingTreeEl,
				selectedTarget.headingTree || [],
				path,
				onPickFlow
			);
			renderSelectionUI();
			renderStoragePathBar();
		}
		renderHeadingTreeInto(headingTreeEl, selectedTarget.headingTree || [], initial, onPickFlow);
		renderSelectionUI();
		renderStoragePathBar();
	}

	function notePayload() {
		return {
			id: currentDraftId,
			title: remoteNote.title || '',
			headings: remoteNote.headings || '',
			content: remoteNote.content || '',
			metadataFilename: remoteNote.metadataFilename || ''
		};
	}

	function draftTitle() {
		const t = (remoteNote.title || '').trim();
		return t || 'new-note';
	}

	function noteHasTitle() {
		return !!(remoteNote.title || '').trim();
	}

	/** Suggested title for "New heading" when the note has none: its first line, shortened. */
	function defaultNoTitleHeading() {
		const first = String(remoteNote.content || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean)[0] || '';
		return first.length > 60 ? first.slice(0, 60).trim() : first;
	}

	function noTitleHeadingValue() {
		if (noteHasTitle()) return '';
		const el = document.getElementById('no-title-heading');
		return ((el ? el.value : noTitleHeading) || defaultNoTitleHeading()).trim();
	}

	/** Heading the "Append" choice writes into: the double-clicked section, else the selected heading. */
	function appendHeadingTarget() {
		if (!selectedTarget || selectedTarget.targetType !== 'file') return '';
		return realHeadingPath(placementAnchorPath || selectedTarget.headingPath || '');
	}

	/** An LLM proposal for the selected target decides append / new heading itself (see its card). */
	function llmOwnsTarget() {
		return !!(llmProposal && selectedTarget && selectedTarget.uri === llmProposal.targetUri);
	}

	function noTitleAppendActive() {
		return !noteHasTitle() && !llmOwnsTarget() && noTitleMode === 'append' && !!appendHeadingTarget();
	}

	/** Append vs New heading choice, shown only for file targets when the note has no heading. */
	function noTitleChoiceHtml() {
		if (noteHasTitle() || llmOwnsTarget()) return '';
		const target = appendHeadingTarget();
		const mode = target ? noTitleMode : 'new_heading';
		const leaf = target ? headingPathLeafTitle(target).replace(/^\.\S*\s+/, '') : '';
		return (
			'<div class="no-title-choice">' +
			'<label class="ntc-opt' + (target ? '' : ' ntc-disabled') + '" title="' +
			escapeHtml(target ? 'Append to: ' + leaf : 'Pick a heading first') + '">' +
			'<input type="radio" name="no-title-mode" value="append"' +
			(mode === 'append' ? ' checked' : '') + (target ? '' : ' disabled') + ' /> Append</label>' +
			'<label class="ntc-opt"><input type="radio" name="no-title-mode" value="new_heading"' +
			(mode === 'new_heading' ? ' checked' : '') + ' /> New heading</label>' +
			(mode === 'new_heading'
				? '<input id="no-title-heading" placeholder="Heading title" value="' + escapeHtml(noTitleHeading || defaultNoTitleHeading()) + '" />'
				: '') +
			'</div>'
		);
	}

	function postSelection() {
		vscode.postMessage({ type: 'selectionChanged', selection: buildSelectionPayload() });
		syncComposerPlacementHeadings();
	}

	document.getElementById('suggestions-btn').addEventListener('click', () => {
		clearMessages();
		hideLlmPlan();
		aiListMode = false;
		if (aiPathsPanelEl) {
			aiPathsPanelEl.hidden = true;
		}
		vscode.postMessage({ type: 'previewTargets', note: notePayload(), ...corpusPayload() });
	});

	document.getElementById('ai-paths-btn').addEventListener('click', () => {
		clearMessages();
		hideLlmPlan();
		aiListMode = true;
		selectedTarget = null;
		suggestedFolderIdx = null;
		suggestedFileIdx = null;
		suggestedItemIdx = null;
		storageFlowStage = 'idle';
		cachedTopFolders = [];
		cachedSuggestions = [];
		cachedPathSegments = [];
		pickedFlowFolder = null;
		pickerCurrentFolderUri = '';
		if (customPickerEl) {
			customPickerEl.hidden = true;
		}
		if (suggestedFoldersEl) {
			suggestedFoldersEl.innerHTML = '';
		}
		if (suggestedFilesEl) {
			suggestedFilesEl.innerHTML = '';
		}
		if (suggestedHeadingsWrap) {
			suggestedHeadingsWrap.hidden = true;
		}
		if (headingTreeEl) {
			clearHeadingTreeDynamic(headingTreeEl);
		}
		if (aiPathsListEl) {
			aiPathsListEl.innerHTML = '<p class="meta">Searching the knowledge base…</p>';
		}
		if (aiPathsPanelEl) {
			aiPathsPanelEl.hidden = false;
		}
		renderStoragePathBar();
		postSelection();
		vscode.postMessage({ type: 'deepAiSuggestions', note: notePayload(), ...corpusPayload() });
	});

	document.getElementById('save-draft-storage').addEventListener('click', () => {
		clearMessages();
		clearStorageStatusTimer();
		if (storageStatusEl) {
			storageStatusEl.textContent = '';
		}
		vscode.postMessage({ type: 'saveDraft', note: notePayload() });
	});

	document.getElementById('ingest-note-storage').addEventListener('click', () => {
		clearMessages();
		clearStorageStatusTimer();
		if (storageStatusEl) {
			storageStatusEl.textContent = '';
		}
		vscode.postMessage({ type: 'ingestNote', note: notePayload() });
	});

	window.addEventListener('message', event => {
		const message = event.data;

		if (message.type === 'storageCustomPathsPicked') {
			const entries = (message.payload && message.payload.entries) || [];
			if (!customCorpusEditorOpen) openCustomCorpusEditor();
			mergePickedCustomEntries(entries);
			return;
		}

		if (message.type === 'kbNoteSettings' && sharedNewFileNameEl) {
			const ext = message.defaultNewNoteExtension || '.d.txt';
			sharedNewFileNameEl.placeholder = 'Note title (new files: *' + ext + ')';
		}

		if (message.type === 'composerNote') {
			const n = message.note || {};
			const hadTitle = noteHasTitle();
			currentDraftId = n.id || '';
			remoteNote = {
				id: n.id || '',
				title: n.title || '',
				headings: n.headings || '',
				content: n.content || '',
				metadataFilename: n.metadataFilename || ''
			};
			syncComposerPlacementHeadings();
			if (hadTitle !== noteHasTitle() && selectedTarget && selectedTarget.targetType === 'file') {
				renderSelectionUI();
				rerenderHeadingTrees();
			}
		}

		if (message.type === 'storageReset') {
			hideLlmPlan();
			noTitleMode = 'append';
			noTitleHeading = '';
			resetStorageSuggestionsToEmpty(message.summaryText || 'No target selected. Use Suggestions.');
			errorEl.textContent = '';
		}

		if (message.type === 'llmIngestPlanResult') {
			renderLlmPlan(message);
		}

		if (message.type === 'storageActionStatus') {
			showStorageStatusMessage(message.message || '');
		}

		if (message.type === 'deepAiSuggestionsResult') {
			aiListMode = true;
			if (message.warning) {
				errorEl.textContent = message.warning;
			} else {
			errorEl.textContent = '';
			}
			renderAiPathResults(message.paths || []);
			renderStoragePathBar();
			updateExplorerPanels();
		}

		if (message.type === 'previewTargetsResult') {
			const preview = message.preview;

			if (preview.warning) {
				errorEl.textContent = preview.warning;
			} else {
				errorEl.textContent = '';
			}

			aiListMode = false;
			if (aiPathsPanelEl) {
				aiPathsPanelEl.hidden = true;
			}
			if (aiPathsListEl) {
				aiPathsListEl.innerHTML = '';
			}

			selectedTarget = null;
			suggestedFolderIdx = null;
			suggestedFileIdx = null;
			suggestedItemIdx = null;
			pickedFlowFolder = null;
			cachedSuggestions = [];
			lastBrowseListing = null;
			cachedPathSegments = [];
			storageFlowStage = 'folders';
			selectionControlsEl.innerHTML = '';

			cachedTopFolders = preview.topFolders || [];
			if (suggestedFilesWrap) {
				suggestedFilesWrap.hidden = true;
			}
			if (suggestedHeadingsWrap) {
				suggestedHeadingsWrap.hidden = true;
			}
			if (headingTreeEl) {
				clearHeadingTreeDynamic(headingTreeEl);
			}
			if (suggestedFoldersEl) {
				suggestedFoldersEl.hidden = false;
			}

			if (!cachedTopFolders.length) {
				if (suggestedFoldersEl) {
					suggestedFoldersEl.innerHTML = '<p class="meta">No folder suggestions. Try Browse.</p>';
				}
			} else {
				renderSuggestedFolderCards();
			}
			if (customPickerEl) {
				customPickerEl.hidden = true;
			}
			if (pickerHeadingWrap) {
				pickerHeadingWrap.hidden = true;
			}
			storageStageBeforeBrowse = 'folders';
			renderStoragePathBar();
			postSelection();
		}

		if (message.type === 'previewFolderFilesResult') {
			cachedSuggestions = message.suggestions || message.files || [];
			if (message.folderUri) {
				pickedFlowFolder = {
					uri: message.folderUri,
					label: message.displayPath || '(folder)'
				};
				pickerCurrentFolderUri = message.folderUri;
			} else if (pickedFlowFolder && pickedFlowFolder.uri) {
				pickerCurrentFolderUri = pickedFlowFolder.uri;
			}
			cachedPathSegments = Array.isArray(message.pathSegments) ? message.pathSegments : [];
			renderSuggestionCards();
			if (suggestedFilesWrap) {
				suggestedFilesWrap.hidden = false;
			}
			renderStoragePathBar();
		}

		if (message.type === 'browseKbListResult') {
			const navigateToFileUri = message.navigateToFileUri;
			lastBrowseListing = Object.assign({}, message);
			delete lastBrowseListing.navigateToFileUri;
			delete lastBrowseListing.pathSegments;
			pickerCurrentFolderUri = message.folderUri || '';
			pickedFlowFolder = {
				uri: message.folderUri,
				label: message.displayPath || '(root)'
			};
			cachedPathSegments = Array.isArray(message.pathSegments) ? message.pathSegments : [];
			setPickerExploreBodyVisible(true);
			if (pickerBreadcrumbEl) {
				pickerBreadcrumbEl.textContent = '';
			}
			renderPickerListFiltered();
			renderStoragePathBar();
			if (
				!browsePickerOpen() &&
				storageFlowStage === 'files' &&
				pickedFlowFolder &&
				!navigateToFileUri
			) {
				vscode.postMessage({
					type: 'previewFolderFiles',
					note: notePayload(),
					folderUri: pickedFlowFolder.uri,
					...corpusPayload()
				});
			}
			if (navigateToFileUri) {
				vscode.postMessage({
					type: 'getFileHeadingMeta',
					fileUri: navigateToFileUri,
					note: notePayload()
				});
			}
		}

		if (message.type === 'fileHeadingMetaResult') {
			const meta = message.meta;
			if (!meta) {
				return;
			}
			exitPlacementAnchor();
			resetIngestDropTarget();
			selectedTarget = {
				targetType: 'file',
				uri: meta.uri,
				label: meta.label,
				headingPaths: meta.headingPaths || [],
				headingPath: meta.suggestedHeadingPath || '',
				suggestedHeadingPath: meta.suggestedHeadingPath,
				headingTree: meta.headingTree || [],
				fromTreeFlow: true
			};
			if (lastBrowseListing && lastBrowseListing.folderUri) {
				pickedFlowFolder = {
					uri: lastBrowseListing.folderUri,
					label: lastBrowseListing.displayPath || 'folder'
				};
			}
			storageFlowStage = 'heading';
			suggestedFileIdx = null;
			const initial = selectedTarget.headingPath;
			const useBrowseChrome = browsePickerOpen();
			if (useBrowseChrome) {
				setPickerExploreBodyVisible(false);
			if (pickerHeadingWrap) {
				pickerHeadingWrap.hidden = false;
			}
				if (suggestedHeadingsWrap) {
					suggestedHeadingsWrap.hidden = true;
				}
			function onPickPicker(path) {
				selectedTarget.headingPath = path;
					renderHeadingTreeInto(
						pickerHeadingTreeEl,
						selectedTarget.headingTree || [],
						path,
						onPickPicker
					);
				renderSelectionUI();
				renderStoragePathBar();
			}
				renderHeadingTreeInto(
					pickerHeadingTreeEl,
					selectedTarget.headingTree || [],
					initial,
					onPickPicker
				);
			if (customPickerEl) {
				customPickerEl.hidden = false;
				}
			} else {
				if (pickerHeadingWrap) {
					pickerHeadingWrap.hidden = true;
				}
				if (suggestedHeadingsWrap) {
					suggestedHeadingsWrap.hidden = false;
				}
				if (suggestedFilesWrap) {
					suggestedFilesWrap.hidden = true;
				}
				function onPickFlow(path) {
					selectedTarget.headingPath = path;
					renderHeadingTreeInto(
						headingTreeEl,
						selectedTarget.headingTree || [],
						path,
						onPickFlow
					);
					renderSelectionUI();
					renderStoragePathBar();
				}
				renderHeadingTreeInto(headingTreeEl, selectedTarget.headingTree || [], initial, onPickFlow);
			}
			renderSelectionUI();
			renderStoragePathBar();
		}

		if (message.type === 'fileHeadingsRefreshed') {
			const m = message.meta;
			if (!m || !selectedTarget || selectedTarget.targetType !== 'file' || selectedTarget.uri !== m.uri) {
				return;
			}
			resetIngestDropTarget();
			selectedTarget.headingPaths = m.headingPaths || [];
			selectedTarget.headingTree = m.headingTree || [];
			const paths = selectedTarget.headingPaths;
			if (placementAnchorPath && !isFileRoot(placementAnchorPath) && paths.indexOf(placementAnchorPath) < 0) {
				exitPlacementAnchor();
			}
			if (selectedTarget.headingPath && !isFileRoot(selectedTarget.headingPath) && paths.indexOf(selectedTarget.headingPath) < 0) {
				selectedTarget.headingPath = m.suggestedHeadingPath || paths[0] || '';
			}
			const initial = selectedTarget.headingPath || '';
			if (lastFlowTreeContext && headingTreeEl && lastFlowTreeContext.container === headingTreeEl) {
				function onPickFlowRef(path) {
					selectedTarget.headingPath = path;
					renderHeadingTreeInto(
						headingTreeEl,
						selectedTarget.headingTree || [],
						path,
						onPickFlowRef
					);
					renderSelectionUI();
					renderStoragePathBar();
				}
				renderHeadingTreeInto(
					headingTreeEl,
					selectedTarget.headingTree || [],
					initial,
					onPickFlowRef
				);
			}
			if (lastPickerTreeContext && pickerHeadingTreeEl && lastPickerTreeContext.container === pickerHeadingTreeEl) {
				function onPickPickerRef(path) {
					selectedTarget.headingPath = path;
					renderHeadingTreeInto(
						pickerHeadingTreeEl,
						selectedTarget.headingTree || [],
						path,
						onPickPickerRef
					);
					renderSelectionUI();
					renderStoragePathBar();
				}
				renderHeadingTreeInto(
					pickerHeadingTreeEl,
					selectedTarget.headingTree || [],
					initial,
					onPickPickerRef
				);
			}
			renderSelectionUI();
			renderStoragePathBar();
			if (storageStatusEl) {
				storageStatusEl.textContent = 'Headings reordered.';
			}
		}

		if (message.type === 'operationError') {
			errorEl.textContent = message.message || 'Unknown error';
		}
	});

	function clearMessages() {
		errorEl.textContent = '';
	}

	// Custom line-number/outline UI removed to keep drafts loading stable.

	function renderCardHighlight() {
		if (suggestedFoldersEl) {
			for (const el of suggestedFoldersEl.querySelectorAll('[data-sf]')) {
				const idx = Number(el.getAttribute('data-sf'));
				el.classList.toggle('selected-card', idx === suggestedFolderIdx);
			}
		}
		if (suggestedFilesEl) {
			for (const el of suggestedFilesEl.querySelectorAll('[data-sitem]')) {
				const idx = Number(el.getAttribute('data-sitem'));
				el.classList.toggle('selected-card', idx === suggestedItemIdx);
			}
		}
	}

	function selectFileTarget(file, headingPath, idx) {
		suggestedItemIdx = idx ?? null;
		suggestedFileIdx = idx ?? null;
		suggestedFolderIdx = null;

		selectedTarget = {
			targetType: 'file',
			uri: file.uri,
			label: file.label,
			headingPaths: file.headingPaths || [],
			headingPath: headingPath || file.suggestedHeadingPath || (file.headingPaths?.[0] || ''),
			headingTree: file.headingTree || []
		};
		storageFlowStage = 'heading';
		renderSelectionUI();
		renderStoragePathBar();
		renderCardHighlight();
	}

	function selectFolderTarget(folder, fileName, idx) {
		suggestedFolderIdx = idx ?? null;
		suggestedFileIdx = null;
		pickedFlowFolder = { uri: folder.uri, label: folder.label };

		selectedTarget = {
			targetType: 'folder',
			uri: folder.uri,
			label: folder.label,
			fileNameDefault: fileName || draftTitle()
		};
		storageFlowStage = 'folder-new';
		renderSelectionUI();
		renderStoragePathBar();
		renderCardHighlight();
	}

	function renderSelectionUI() {
		selectionControlsEl.innerHTML = '';

		if (!selectionControlsChangeWired) {
			selectionControlsChangeWired = true;
			selectionControlsEl.addEventListener('change', function (e) {
				const t = e.target;
				if (t && t.name === 'no-title-mode') {
					noTitleMode = t.value === 'new_heading' ? 'new_heading' : 'append';
					renderSelectionUI();
					rerenderHeadingTrees();
					return;
				}
				if (!t || !t.id) {
					return;
				}
				if (t.id === 'heading-select' && selectedTarget && selectedTarget.targetType === 'file') {
					resetIngestDropTarget();
					selectedTarget.headingPath = t.value;
					if (lastFlowTreeContext && lastFlowTreeContext.container) {
						renderHeadingTreeInto(
							lastFlowTreeContext.container,
							lastFlowTreeContext.nodes,
							t.value,
							lastFlowTreeContext.onPick
						);
					}
					if (lastPickerTreeContext && lastPickerTreeContext.container) {
						renderHeadingTreeInto(
							lastPickerTreeContext.container,
							lastPickerTreeContext.nodes,
							t.value,
							lastPickerTreeContext.onPick
						);
					}
					renderStoragePathBar();
					postSelection();
				}
			});
		}

		if (!selectedTarget) {
			postSelection();
			return;
		}

		if (selectedTarget.targetType === 'file') {
			const headingPaths = selectedTarget.headingPaths || [];
			if (selectedTarget.fromTreeFlow) {
				selectionControlsEl.innerHTML =
					'<p class="meta" style="margin:0;font-size:11px;line-height:1.45">' +
					(placementAnchorPath
						? noTitleAppendActive()
							? 'The note text goes at the end of this heading.'
							: 'Drag the note row to set position.'
						: 'Double-click a heading, or the file name for the top level, to choose the section.') +
					'</p>' +
					noTitleChoiceHtml();
				postSelection();
				return;
			}

			if (!headingPaths.length) {
				selectionControlsEl.innerHTML = noTitleChoiceHtml();
				postSelection();
				return;
			}

			const currentHeadingPath = selectedTarget.headingPath || headingPaths[0] || '';

			const optionsHtml = headingPaths
				.map(p => {
					const segments = p.split('/').filter(Boolean);
					const depth = Math.max(1, segments.length);
					const leaf = segments[segments.length - 1] || p;
					const indent = ' '.repeat((depth - 1) * 2);
					const selectedAttr = p === currentHeadingPath ? ' selected="selected"' : '';
					return '<option value="' + escapeHtml(p) + '"' + selectedAttr + '>' +
						escapeHtml(indent + leaf) +
						'</option>';
				})
				.join('');

			selectionControlsEl.innerHTML =
				'<label for="heading-select">Heading</label>' +
				'<select id="heading-select">' +
				(optionsHtml || '<option value="">—</option>') +
				'</select>' +
				'<p class="meta" style="margin-top:8px;font-size:11px;line-height:1.45">' +
				(placementAnchorPath
					? 'Drag the note row to set position.'
					: 'Double-click a heading to choose the section.') +
				'</p>' +
				noTitleChoiceHtml();
		} else if (selectedTarget.targetType === 'folder') {
			selectionControlsEl.innerHTML =
				'<label for="new-file-name">Name</label>' +
				'<input id="new-file-name" value="' + escapeHtml(selectedTarget.fileNameDefault || '') + '" placeholder="note-title" />';
		}
		postSelection();
	}

	function buildSelectionPayload() {
		if (!selectedTarget) {
			return undefined;
		}

		if (selectedTarget.targetType === 'file') {
			const headingSelect = document.getElementById('heading-select');
			const headingPath = realHeadingPath(headingSelect ? headingSelect.value : selectedTarget.headingPath || '');
			let ref = ingestDropRefPath || '';
			let pos = ingestPosition || '';
			if (isFileRoot(ref)) {
				// Top level of the file = before the first / after the last top-level heading.
				const tops = selectedTarget.headingTree || [];
				if (!tops.length) {
					ref = '';
					pos = '';
				} else if (pos === 'childFirst') {
					ref = tops[0].path;
					pos = 'before';
				} else {
					ref = tops[tops.length - 1].path;
					pos = 'afterSection';
				}
			}
			const filePayload = {
				targetType: 'file',
				uri: selectedTarget.uri,
				headingPath,
				ingestDropRefPath: ref,
				ingestPosition: pos
			};
			if (!noteHasTitle() && !llmOwnsTarget()) {
				if (noTitleAppendActive()) {
					filePayload.headingPath = appendHeadingTarget();
					filePayload.ingestDropRefPath = '';
					filePayload.ingestPosition = '';
				} else {
					filePayload.noteTitle = noTitleHeadingValue();
				}
			}
			return Object.assign(filePayload, llmSelectionExtras(filePayload));
		}

		if (selectedTarget.targetType === 'folder') {
			const nameEl = document.getElementById('new-file-name');
			const folderPayload = {
				targetType: 'folder',
				uri: selectedTarget.uri,
				fileName: nameEl ? nameEl.value : selectedTarget.fileNameDefault
			};
			return Object.assign(folderPayload, llmSelectionExtras(folderPayload));
		}

		return undefined;
	}

	function escapeHtml(value) {
		return String(value)
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#39;');
	}

	selectionControlsEl.addEventListener('change', postSelection);
	selectionControlsEl.addEventListener('input', postSelection);
	selectionControlsEl.addEventListener('input', function (e) {
		if (!e.target || e.target.id !== 'no-title-heading') return;
		noTitleHeading = e.target.value;
		const ph = document.querySelector('.ht-ingest-placeholder-row .ht-label');
		if (ph) ph.textContent = noTitleHeadingValue() || 'New note';
	});

	if (corpusSel) {
		corpusSel.addEventListener('change', () => {
			const v = String(corpusSel.value || 'working');
			if (v === 'custom') {
				openCustomCorpusEditor(storageCorpus);
				return;
			}
			storageCorpus = v === 'entire' ? 'entire' : 'working';
			setCustomCorpusEditorOpen(false);
			syncCorpusEditBtn();
		});
	}
	if (corpusEditBtn) {
		corpusEditBtn.addEventListener('click', () => openCustomCorpusEditor('custom'));
	}
	if (customAddBtn) {
		customAddBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'storagePickCustomPaths' });
		});
	}
	if (customDoneBtn) {
		customDoneBtn.addEventListener('click', finishCustomCorpusDone);
	}
	if (customCancelBtn) {
		customCancelBtn.addEventListener('click', cancelCustomCorpusEditor);
	}
	syncCorpusEditBtn();

	vscode.postMessage({ type: 'requestState' });

