'use strict';

/**
 * Client script for the tag graph (DRIP Tags editor panel or legacy embed).
 * Uses window.__dripVscodeApi from a prior script when acquireVsCodeApi was already called.
 * Expects DOM ids prefixed with stag-. No template interpolation — safe to inject.
 */
function getTagsGraphEmbedRuntime() {
	return `(function () {
	var vscode = window.__dripVscodeApi;
	if (!vscode) return;
	var canvas = document.getElementById('stag-graph');
	if (!canvas) return;
	var ctx = canvas.getContext('2d');
	var wrap = document.getElementById('stag-canvas-wrap');
	var hoverLabelEl = document.getElementById('stag-hover-label');
	var errEl = document.getElementById('stag-err');
	var newLabelEl = document.getElementById('stag-new-label');
	var selFromEl = document.getElementById('stag-sel-from');
	var selToEl = document.getElementById('stag-sel-to');
	var selInfoEl = document.getElementById('stag-sel-info');
	var linksListEl = document.getElementById('stag-links-list');
	var ctxMenuEl = document.getElementById('stag-ctx-menu');
	var ctxLinkIndex = -1;
	var ctxCanvasWorld = null;
	var ctxEdgeEndpoints = null;
	var linkSourceId = '';
	var subTagFlyout = document.getElementById('stag-subtag-flyout');
	var subTagTitle = document.getElementById('stag-subtag-title');
	var subTagClose = document.getElementById('stag-subtag-close');
	var subTagNew = document.getElementById('stag-subtag-new');
	var subTagAdd = document.getElementById('stag-subtag-add');
	var subGraphWrap = document.getElementById('stag-subgraph-wrap');
	var subCanvas = document.getElementById('stag-subgraph');
	var subCtx = subCanvas && subCanvas.getContext ? subCanvas.getContext('2d') : null;
	var subCtxMenuEl = document.getElementById('stag-sub-ctx-menu');
	var openSubtagPanelId = '';
	var subNodes = [];
	var subScale = 1;
	var subPanX = 0, subPanY = 0;
	var subDragNode = null;
	var subDragOffX = 0, subDragOffY = 0;
	var subPanning = false, subPanSX = 0, subPanSY = 0, subPanStartX = 0, subPanStartY = 0;
var subDownX = 0, subDownY = 0, subPointerMoved = false;
	var subSelectedId = '';
	var subLinkSourceId = '';
	var subShiftHeld = false;
	var subCtxLinkIndex = -1;
	var subCtxEdgeEndpoints = null;
	var subCtxCanvasWorld = null;
	var SUB_NODE_R = 9;
	var FLYOUT_W = 300;
	var FLYOUT_H = 300;
	var TAG_SUBGRAPH_POPOVER_MAX = 5;

	var graph = { version: 2, nodes: [], links: [] };
	var nodes = [];
	var selectedId = '';
	var hoverId = '';
	var TAG_GRAPH_ZOOM_MIN = 0.25;
	var TAG_GRAPH_ZOOM_MAX = 3;
	/** Main graph non-hover tag label size at maximum zoom. */
	var TAG_GRAPH_NODE_LABEL_PX_AT_MAX_ZOOM = 24;
	/** Embedded sub-graph non-hover tag label size at maximum zoom. */
	var TAG_SUBGRAPH_NODE_LABEL_PX_AT_MAX_ZOOM = 24;
	/** Hover title (DOM overlay only). Unrelated to under-node canvas text. */
	var HOVER_LABEL_FONT_PX = 24;
	var scale = 1;
	var panX = 0, panY = 0;
	var running = true;
	var canvasFontFamily = '';
	var dragNode = null;
	var dragOffX = 0, dragOffY = 0;
	var panning = false, panSX = 0, panSY = 0, panStartX = 0, panStartY = 0;
var mainDownX = 0, mainDownY = 0, mainPointerMoved = false;
	var NODE_R = 11;
	var graphSelectEl = document.getElementById('stag-graph-select');
	var graphNameEl = document.getElementById('stag-graph-name');
	var btnRenameGraph = document.getElementById('stag-btn-rename-graph');
	var btnDeleteGraph = document.getElementById('stag-btn-delete-graph');
	var btnCombineGraph = document.getElementById('stag-btn-combine-graph');
	var combinePanelEl = document.getElementById('stag-combine-panel');
	var combineListEl = document.getElementById('stag-combine-list');
	var btnCombineAddEl = document.getElementById('stag-btn-combine-add');
	var btnCombineCreateEl = document.getElementById('stag-btn-combine-create');
	var btnCombineCancelEl = document.getElementById('stag-btn-combine-cancel');
	var optShowOrphansEl = document.getElementById('stag-opt-show-orphans');
	var optShowArrowsEl = document.getElementById('stag-opt-show-arrows');
	var optRigidEl = document.getElementById('stag-opt-rigid');
	var optCenterEl = document.getElementById('stag-opt-force-center');
	var optRepelEl = document.getElementById('stag-opt-force-repel');
	var optLinkEl = document.getElementById('stag-opt-force-link');
	var optLinkDistanceEl = document.getElementById('stag-opt-link-distance');
	var optNodeSizeEl = document.getElementById('stag-opt-node-size');
	var optEdgeThicknessEl = document.getElementById('stag-opt-edge-thickness');
	var optTextFadeEl = document.getElementById('stag-opt-text-fade');
	var btnDeleteModeEl = document.getElementById('stag-btn-delete-mode');
	var deletePanelEl = document.getElementById('stag-delete-panel');
	var optDeleteIncludeChildrenEl = document.getElementById('stag-opt-delete-include-children');
	var deleteToolsEl = document.getElementById('stag-delete-tools');
	var deleteIncludeWrapEl = document.getElementById('stag-delete-include-wrap');
	var btnDeleteConfirmEl = document.getElementById('stag-btn-delete-confirm');
	var btnDeleteCancelEl = document.getElementById('stag-btn-delete-cancel');
	var optShowGroupsEl = document.getElementById('stag-opt-show-groups');
	var groupsWrapEl = document.getElementById('stag-groups-wrap');
	var groupManageEl = document.getElementById('stag-group-manage');
	var groupEditorNameEl = document.getElementById('stag-group-editor-name');
	var groupEditorColorEl = document.getElementById('stag-group-editor-color');
	var btnRenameGroupEl = document.getElementById('stag-btn-rename-group');
	var btnDeleteGroupEl = document.getElementById('stag-btn-delete-group');
	var btnGroupEditorSaveEl = document.getElementById('stag-btn-group-editor-save');
	var btnGroupEditorCancelEl = document.getElementById('stag-btn-group-editor-cancel');
	var btnSelectGroupNodesEl = document.getElementById('stag-btn-select-group-nodes');
	var optGroupIncludeChildrenEl = document.getElementById('stag-opt-group-include-children');
	var groupsLegendEl = document.getElementById('stag-groups-legend');
	var selectionNoteEl = document.getElementById('stag-selection-note');
	var statusNoteEl = document.getElementById('stag-status-note');
	var selectionStopNoticeTimer = 0;
	var statusNoteTimer = 0;
	var optCenterValEl = document.getElementById('stag-opt-force-center-val');
	var optRepelValEl = document.getElementById('stag-opt-force-repel-val');
	var optLinkValEl = document.getElementById('stag-opt-force-link-val');
	var optLinkDistanceValEl = document.getElementById('stag-opt-link-distance-val');
	var optNodeSizeValEl = document.getElementById('stag-opt-node-size-val');
	var optEdgeThicknessValEl = document.getElementById('stag-opt-edge-thickness-val');
	var optTextFadeValEl = document.getElementById('stag-opt-text-fade-val');
	var btnToggleSettings = document.getElementById('stag-btn-toggle-settings');
	var settingsWrapEl = document.getElementById('stag-settings-wrap');
	var lastActiveGraphId = '';
	var syncingGraphSelect = false;
	var isRenamingGraph = false;
	var isCombineMode = false;
	var combineSourceIds = [];
	var storedGraphsCache = [];
	var groupEditorMode = '';
	var groupEditorTargetId = '';
	var isGroupNodeSelectMode = false;
	var isDeleteNodeSelectMode = false;
	var pendingDeleteIdSet = {};
	var graphOpts = {
		rigid: false,
		showOrphans: true,
		forceCenter: 0.03,
		forceRepel: 10,
		forceLink: 0.75,
		linkDistance: 80,
		nodeSize: 8,
		edgeThickness: 1.50,
		textFadeThreshold: -2.5,
		showArrows: true
	};
	var lastSimulationKickAt = Date.now();

	function kickSimulation() {
		lastSimulationKickAt = Date.now();
	}

	function setGraphRenameMode(on) {
		isRenamingGraph = !!on;
		if (isCombineMode) return;
		if (graphSelectEl) graphSelectEl.classList.toggle('is-hidden', isRenamingGraph);
		if (graphNameEl) graphNameEl.classList.toggle('is-hidden', !isRenamingGraph);
		if (btnRenameGraph) btnRenameGraph.textContent = isRenamingGraph ? 'Save' : 'Rename';
		if (isRenamingGraph && graphNameEl) {
			graphNameEl.focus();
			graphNameEl.select();
		}
	}

	function ensureUniqueCombineSourceIds(ids) {
		var seen = {};
		var out = [];
		for (var i = 0; i < ids.length; i++) {
			var id = String(ids[i] || '');
			if (!id || seen[id]) continue;
			seen[id] = true;
			out.push(id);
		}
		return out;
	}

	function renderCombineList() {
		if (!combineListEl) return;
		combineListEl.innerHTML = '';
		for (var i = 0; i < combineSourceIds.length; i++) {
			(function (idx) {
				var row = document.createElement('div');
				row.className = 'stag-combine-row';
				row.draggable = true;
				row.setAttribute('data-idx', String(idx));
				row.addEventListener('dragstart', function () {
					row.classList.add('dragging');
					row.setAttribute('data-dragging', '1');
				});
				row.addEventListener('dragend', function () {
					row.classList.remove('dragging');
					row.removeAttribute('data-dragging');
				});
				row.addEventListener('dragover', function (ev) { ev.preventDefault(); });
				row.addEventListener('drop', function (ev) {
					ev.preventDefault();
					var dragEl = combineListEl.querySelector('[data-dragging="1"]');
					if (!dragEl) return;
					var from = Number(dragEl.getAttribute('data-idx'));
					var to = idx;
					if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return;
					var moved = combineSourceIds.splice(from, 1)[0];
					combineSourceIds.splice(to, 0, moved);
					renderCombineList();
					requestCombinePreview();
				});
				var grip = document.createElement('span');
				grip.className = 'stag-combine-grip';
				grip.textContent = '≡';
				var sel = document.createElement('select');
				sel.className = 'sel';
				sel.style.flex = '1';
				for (var g = 0; g < storedGraphsCache.length; g++) {
					var opt = document.createElement('option');
					opt.value = String(storedGraphsCache[g].id);
					opt.textContent = String(storedGraphsCache[g].name);
					sel.appendChild(opt);
				}
				sel.value = String(combineSourceIds[idx] || '');
				sel.addEventListener('change', function () {
					combineSourceIds[idx] = String(sel.value || '');
					combineSourceIds = ensureUniqueCombineSourceIds(combineSourceIds);
					renderCombineList();
					requestCombinePreview();
				});
				var rem = document.createElement('button');
				rem.type = 'button';
				rem.textContent = 'x';
				rem.addEventListener('click', function () {
					combineSourceIds.splice(idx, 1);
					renderCombineList();
					requestCombinePreview();
				});
				row.appendChild(grip);
				row.appendChild(sel);
				row.appendChild(rem);
				combineListEl.appendChild(row);
			})(i);
		}
	}

	function requestCombinePreview() {
		if (!isCombineMode) return;
		var ids = ensureUniqueCombineSourceIds(combineSourceIds);
		if (ids.length < 1) return;
		var name = graphNameEl ? String(graphNameEl.value || '').trim() : '';
		if (!name) name = 'Combined graph';
		vscode.postMessage({ type: 'createCombinedGraphPreview', name: name, sourceGraphIds: ids });
	}

	function setCombineMode(on) {
		isCombineMode = !!on;
		if (combinePanelEl) combinePanelEl.hidden = !isCombineMode;
		if (graphSelectEl) graphSelectEl.classList.toggle('is-hidden', isCombineMode || isRenamingGraph);
		if (graphNameEl) {
			graphNameEl.classList.toggle('is-hidden', !isCombineMode);
			if (isCombineMode) {
				if (!String(graphNameEl.value || '').trim()) graphNameEl.value = 'Combined graph';
			} else {
				graphNameEl.value = '';
			}
		}
		if (btnRenameGraph) btnRenameGraph.disabled = false;
		if (btnDeleteGraph) btnDeleteGraph.disabled = false;
		if (btnCombineGraph) btnCombineGraph.disabled = false;
		if (isCombineMode) {
			combineSourceIds = ensureUniqueCombineSourceIds([lastActiveGraphId || '']);
			combineSourceIds = combineSourceIds.filter(Boolean);
			renderCombineList();
			requestCombinePreview();
		} else {
			combineSourceIds = [];
			renderCombineList();
			vscode.postMessage({ type: 'requestTagGraph' });
		}
	}

	function nodeById(id) {
		for (var i = 0; i < graph.nodes.length; i++) {
			if (graph.nodes[i].id === id) return graph.nodes[i];
		}
		return null;
	}
	function tagById(id) { return nodeById(id); }
	function labelFor(id) { var t = nodeById(id); return t ? t.label : id; }
	function rootNodes() {
		var out = [];
		for (var i = 0; i < graph.nodes.length; i++) {
			var n = graph.nodes[i];
			if (n._hiddenOrphan) continue;
			if (n.parentId == null || n.parentId === '') out.push(n);
		}
		return out;
	}
	function rootIdSet() {
		var s = {};
		var r = rootNodes();
		for (var i = 0; i < r.length; i++) s[r[i].id] = true;
		return s;
	}
function isRootLink(L) {
	var s = rootIdSet();
	return s[L.from] && s[L.to];
}
	function childCount(parentId) {
		var c = 0;
		for (var i = 0; i < graph.nodes.length; i++) {
			if (graph.nodes[i].parentId === parentId) c++;
		}
		return c;
	}
	function subFocusIdSet(focusId) {
		var s = {};
		s[focusId] = true;
		for (var i = 0; i < graph.nodes.length; i++) {
			if (graph.nodes[i].parentId === focusId) s[graph.nodes[i].id] = true;
		}
		return s;
	}
function isSubFocusLink(L, focusId) {
	var s = subFocusIdSet(focusId);
	return s[L.from] && s[L.to];
}
	function rootDegreeMap() {
		var m = {};
		for (var i = 0; i < graph.links.length; i++) {
			var L = graph.links[i];
			if (!isRootLink(L)) continue;
			m[L.from] = (m[L.from] || 0) + 1;
			m[L.to] = (m[L.to] || 0) + 1;
		}
		return m;
	}
	function nodeRadiusByDegree(nodeId, degreeMap) {
		var base = Math.max(1, Number(graphOpts.nodeSize) || 8);
		var d = degreeMap && degreeMap[nodeId] ? degreeMap[nodeId] : 0;
		var boost = Math.min(1.2, Math.log(1 + d) * 0.35);
		return base * (1 + boost);
	}
	function groupById(id) {
		var gid = String(id || '');
		if (!gid) return null;
		var gs = Array.isArray(graph.groups) ? graph.groups : [];
		for (var i = 0; i < gs.length; i++) {
			if (String(gs[i].id || '') === gid) return gs[i];
		}
		return null;
	}
	function updateGroupsUi() {
		if (groupsWrapEl && optShowGroupsEl) groupsWrapEl.hidden = !optShowGroupsEl.checked;
		var gs = Array.isArray(graph.groups) ? graph.groups : [];
		if (groupManageEl) {
			var v = groupManageEl.value;
			groupManageEl.innerHTML = '<option value="">No group</option>';
			for (var i = 0; i < gs.length; i++) {
				var o = document.createElement('option');
				o.value = String(gs[i].id);
				o.textContent = String(gs[i].name);
				groupManageEl.appendChild(o);
			}
			var oNew = document.createElement('option');
			oNew.value = '__create_new__';
			oNew.textContent = '+ Create new group';
			groupManageEl.appendChild(oNew);
			if (v && gs.some(function (g) { return String(g.id) === v; })) groupManageEl.value = v;
			else groupManageEl.value = '';
		}
		if (btnDeleteGroupEl) {
			var selected = groupManageEl ? String(groupManageEl.value || '') : '';
			btnDeleteGroupEl.disabled = !selected || selected === '__create_new__';
		}
		if (btnRenameGroupEl) {
			var selected2 = groupManageEl ? String(groupManageEl.value || '') : '';
			btnRenameGroupEl.disabled = !selected2 || selected2 === '__create_new__';
		}
		if (groupsLegendEl) {
			groupsLegendEl.innerHTML = '';
			for (var j = 0; j < gs.length; j++) {
				var row = document.createElement('div');
				row.className = 'stag-legend-item';
				var sw = document.createElement('span');
				sw.className = 'stag-legend-swatch';
				sw.style.background = String(gs[j].color || '#7aa2ff');
				var txt = document.createElement('span');
				txt.textContent = String(gs[j].name || gs[j].id);
				row.appendChild(sw);
				row.appendChild(txt);
				groupsLegendEl.appendChild(row);
			}
		}
	}

	function activeGroupAssignmentTargetId() {
		if (selectedId && tagById(selectedId)) return selectedId;
		if (subSelectedId && tagById(subSelectedId)) return subSelectedId;
		if (openSubtagPanelId && tagById(openSubtagPanelId)) return openSubtagPanelId;
		return '';
	}

	function setGroupEditorMode(mode, groupId) {
		groupEditorMode = String(mode || '');
		groupEditorTargetId = String(groupId || '');
		var on = groupEditorMode === 'create' || groupEditorMode === 'rename';
		if (groupManageEl) groupManageEl.hidden = on;
		if (groupEditorNameEl) groupEditorNameEl.hidden = !on;
		if (groupEditorColorEl) groupEditorColorEl.hidden = !on;
		if (btnRenameGroupEl) btnRenameGroupEl.hidden = on;
		if (btnDeleteGroupEl) btnDeleteGroupEl.hidden = on;
		if (btnGroupEditorSaveEl) btnGroupEditorSaveEl.hidden = !on;
		if (btnGroupEditorCancelEl) btnGroupEditorCancelEl.hidden = !on;
		if (!on) return;
		var groups = Array.isArray(graph.groups) ? graph.groups : [];
		if (groupEditorMode === 'rename') {
			var g = groups.find(function (x) { return String(x.id || '') === groupEditorTargetId; });
			if (groupEditorNameEl) groupEditorNameEl.value = g ? String(g.name || '') : '';
			if (groupEditorColorEl) groupEditorColorEl.value = g && g.color ? String(g.color) : '#7aa2ff';
		} else {
			if (groupEditorNameEl) groupEditorNameEl.value = '';
			if (groupEditorColorEl) groupEditorColorEl.value = '#7aa2ff';
		}
		if (groupEditorNameEl) {
			groupEditorNameEl.focus();
			groupEditorNameEl.select();
		}
	}

	function setGroupNodeSelectMode(on) {
		var wasOn = isGroupNodeSelectMode;
		isGroupNodeSelectMode = !!on;
		if (btnSelectGroupNodesEl) {
			btnSelectGroupNodesEl.textContent = isGroupNodeSelectMode ? 'Stop selecting' : 'Select nodes';
		}
		if (wrap) wrap.classList.toggle('stag-selecting', isGroupNodeSelectMode);
		if (selectionNoteEl) {
			if (selectionStopNoticeTimer) {
				clearTimeout(selectionStopNoticeTimer);
				selectionStopNoticeTimer = 0;
			}
			if (isGroupNodeSelectMode) {
				selectionNoteEl.textContent = 'Node group selection in progress. Click tags to assign. Click empty canvas or press Esc to stop.';
				selectionNoteEl.hidden = false;
			} else if (wasOn) {
				selectionNoteEl.textContent = 'Selection mode stopped. Current progress is saved.';
				selectionNoteEl.hidden = false;
				selectionStopNoticeTimer = setTimeout(function () {
					if (!isGroupNodeSelectMode && selectionNoteEl) selectionNoteEl.hidden = true;
				}, 1800);
			} else {
				selectionNoteEl.hidden = true;
			}
		}
		if (statusNoteEl) {
			if (statusNoteTimer) {
				clearTimeout(statusNoteTimer);
				statusNoteTimer = 0;
			}
			if (isGroupNodeSelectMode) {
				statusNoteEl.textContent = 'Selection mode started. Click nodes to apply group.';
				statusNoteEl.hidden = false;
			} else if (wasOn) {
				statusNoteEl.textContent = 'Selection mode stopped. Current progress is saved.';
				statusNoteEl.hidden = false;
			} else {
				statusNoteEl.hidden = true;
			}
			if (!isGroupNodeSelectMode || wasOn) {
				statusNoteTimer = setTimeout(function () {
					if (statusNoteEl) statusNoteEl.hidden = true;
				}, 4500);
			}
		}
		if (isGroupNodeSelectMode !== wasOn) {
			vscode.postMessage({ type: 'groupSelectionStatus', active: isGroupNodeSelectMode });
		}
	}

	function subtreeIdsFor(id) {
		var rid = String(id || '');
		if (!rid) return [];
		var set = {};
		set[rid] = true;
		var expanded = true;
		while (expanded) {
			expanded = false;
			for (var i = 0; i < graph.nodes.length; i++) {
				var n = graph.nodes[i];
				var nid = String(n.id || '');
				var pid = n.parentId == null ? '' : String(n.parentId || '');
				if (!nid || !pid) continue;
				if (set[nid]) continue;
				if (!set[pid]) continue;
				set[nid] = true;
				expanded = true;
			}
		}
		// Expand downward through outgoing links, then include structural descendants.
		var expandedLinks = true;
		while (expandedLinks) {
			expandedLinks = false;
			for (var li = 0; li < graph.links.length; li++) {
				var L = graph.links[li];
				var from = String(L.from || '');
				var to = String(L.to || '');
				if (!from || !to) continue;
				if (!set[from] || set[to]) continue;
				set[to] = true;
				expandedLinks = true;
			}
			var expandedStruct = true;
			while (expandedStruct) {
				expandedStruct = false;
				for (var ii = 0; ii < graph.nodes.length; ii++) {
					var nn = graph.nodes[ii];
					var nid2 = String(nn.id || '');
					var pid2 = nn.parentId == null ? '' : String(nn.parentId || '');
					if (!nid2 || !pid2) continue;
					if (set[nid2]) continue;
					if (!set[pid2]) continue;
					set[nid2] = true;
					expandedStruct = true;
				}
			}
		}
		return Object.keys(set);
	}

	function toggleDeleteMarkByNodeId(nodeId) {
		var id = String(nodeId || '');
		if (!id) return;
		var ids = !!(optDeleteIncludeChildrenEl && optDeleteIncludeChildrenEl.checked) ? subtreeIdsFor(id) : [id];
		var allMarked = true;
		for (var i = 0; i < ids.length; i++) {
			if (!pendingDeleteIdSet[ids[i]]) {
				allMarked = false;
				break;
			}
		}
		for (var j = 0; j < ids.length; j++) {
			if (allMarked) delete pendingDeleteIdSet[ids[j]];
			else pendingDeleteIdSet[ids[j]] = true;
		}
		updateDeleteActionUi();
	}

	function clearDeleteSelection() {
		pendingDeleteIdSet = {};
		updateDeleteActionUi();
	}

	function markedDeleteCount() {
		return Object.keys(pendingDeleteIdSet).length;
	}

	function updateDeleteActionUi() {
		if (!btnDeleteConfirmEl) return;
		var n = markedDeleteCount();
		btnDeleteConfirmEl.disabled = n <= 0;
		btnDeleteConfirmEl.textContent = n > 0 ? ('Delete (' + n + ')') : 'Delete';
	}

	function setDeleteNodeSelectMode(on) {
		isDeleteNodeSelectMode = !!on;
		if (!isDeleteNodeSelectMode) clearDeleteSelection();
		if (deletePanelEl) deletePanelEl.classList.toggle('is-active', isDeleteNodeSelectMode);
		if (btnDeleteModeEl) btnDeleteModeEl.hidden = isDeleteNodeSelectMode;
		if (deleteToolsEl) {
			deleteToolsEl.hidden = !isDeleteNodeSelectMode;
			deleteToolsEl.style.display = isDeleteNodeSelectMode ? 'flex' : 'none';
		}
		if (deleteIncludeWrapEl) deleteIncludeWrapEl.hidden = !isDeleteNodeSelectMode;
		if (btnDeleteConfirmEl) btnDeleteConfirmEl.hidden = !isDeleteNodeSelectMode;
		if (btnDeleteCancelEl) btnDeleteCancelEl.hidden = !isDeleteNodeSelectMode;
		updateDeleteActionUi();
	}

	function syncNodesFromGraph() {
		var rootsAll = [];
		for (var i2 = 0; i2 < graph.nodes.length; i2++) {
			var n2 = graph.nodes[i2];
			if (n2.parentId == null || n2.parentId === '') rootsAll.push(n2);
		}
		var degree = {};
		for (var li = 0; li < graph.links.length; li++) {
			var lk = graph.links[li];
			if (!lk) continue;
			degree[lk.from] = (degree[lk.from] || 0) + 1;
			degree[lk.to] = (degree[lk.to] || 0) + 1;
		}
		for (var rj = 0; rj < rootsAll.length; rj++) {
			var rr = rootsAll[rj];
			rr._hiddenOrphan = !graphOpts.showOrphans && !degree[rr.id];
		}
		var map = {};
		for (var i = 0; i < nodes.length; i++) { map[nodes[i].id] = nodes[i]; }
		var next = [];
		var roots = rootNodes();
		var total = roots.length;
		for (var j = 0; j < total; j++) {
			var tg = roots[j];
			var old = map[tg.id];
			var x, y;
			if (old) {
				x = old.x;
			} else {
				var ang = (2 * Math.PI * j) / Math.max(total, 1);
				x = Math.cos(ang) * 140;
			}
			if (old) {
				y = old.y;
			} else {
				var ang2 = (2 * Math.PI * j) / Math.max(total, 1);
				y = Math.sin(ang2) * 140;
			}
			next.push({
				id: tg.id,
				label: tg.label,
				groupId: String(tg.groupId || ''),
				x: x,
				y: y,
				vx: old ? old.vx : 0,
				vy: old ? old.vy : 0
			});
		}
		nodes = next;
		kickSimulation();
	}

	function hideGraphHoverLabel() {
		if (!hoverLabelEl) return;
		hoverLabelEl.hidden = true;
		hoverLabelEl.textContent = '';
		hoverLabelEl.setAttribute('aria-hidden', 'true');
	}

	function ensureGraphHoverLabelEl() {
		if (hoverLabelEl || !wrap) return null;
		var el = document.createElement('div');
		el.id = 'stag-hover-label';
		el.className = 'stag-hover-label';
		el.setAttribute('aria-hidden', 'true');
		el.hidden = true;
		wrap.appendChild(el);
		hoverLabelEl = el;
		return hoverLabelEl;
	}

	function resizeCanvas() {
		if (!wrap) return;
		var dpr = window.devicePixelRatio || 1;
		var w = wrap.clientWidth || 400;
		var h = wrap.clientHeight || 360;
		canvas.width = Math.floor(w * dpr);
		canvas.height = Math.floor(h * dpr);
		canvas.style.width = w + 'px';
		canvas.style.height = h + 'px';
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	function getCanvasFontFamily() {
		if (canvasFontFamily) return canvasFontFamily;
		var cssFamily = (getComputedStyle(document.body).getPropertyValue('--vscode-font-family') || '').trim();
		canvasFontFamily = cssFamily || 'sans-serif';
		return canvasFontFamily;
	}

	function worldToScreen(wx, wy) {
		var cx = wrap.clientWidth / 2;
		var cy = wrap.clientHeight / 2;
		return { x: (wx + panX) * scale + cx, y: (wy + panY) * scale + cy };
	}

	function screenToWorld(sx, sy) {
		var cx = wrap.clientWidth / 2;
		var cy = wrap.clientHeight / 2;
		return { x: (sx - cx) / scale - panX, y: (sy - cy) / scale - panY };
	}

	function pickNode(wx, wy) {
		var degree = rootDegreeMap();
		for (var i = nodes.length - 1; i >= 0; i--) {
			var n = nodes[i];
			var nr = nodeRadiusByDegree(n.id, degree);
			var dx = n.x - wx, dy = n.y - wy;
			if (dx * dx + dy * dy <= nr * nr * 1.35) return n;
		}
		return null;
	}

	function distPointToSegment(px, py, ax, ay, bx, by) {
		var abx = bx - ax, aby = by - ay;
		var apx = px - ax, apy = py - ay;
		var ab2 = abx * abx + aby * aby;
		var t = ab2 < 1e-10 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));
		var qx = ax + abx * t, qy = ay + aby * t;
		var ddx = px - qx, ddy = py - qy;
		return Math.sqrt(ddx * ddx + ddy * ddy);
	}

	function linkGeometryForIndex(li) {
		var L = graph.links[li];
		if (!L || !isRootLink(L)) return null;
		var na = nodes.find(function (n) { return n.id === L.from; });
		var nb = nodes.find(function (n) { return n.id === L.to; });
		if (!na || !nb) return null;
		var degree = rootDegreeMap();
		var ra = nodeRadiusByDegree(na.id, degree);
		var rb = nodeRadiusByDegree(nb.id, degree);
		var off = linkOffsetIndex(li) * 14;
		if (na.id === nb.id) {
			return { type: 'loop', na: na, off: linkOffsetIndex(li), li: li };
		}
		var dx = nb.x - na.x, dy = nb.y - na.y;
		var len = Math.sqrt(dx * dx + dy * dy);
		if (len < 0.01) return null;
		var ux = dx / len, uy = dy / len;
		var px = -uy * off, py = ux * off;
		return {
			type: 'seg',
			sx: na.x + ux * ra + px,
			sy: na.y + uy * ra + py,
			ex: nb.x - ux * rb + px,
			ey: nb.y - uy * rb + py,
			li: li
		};
	}

	function pickLink(wx, wy) {
		var thr = 11 / Math.max(scale, 0.3);
		var bestLi = -1;
		var bestD = 1e9;
		var li, g, d, k, ta, qx, qy, dd, dmin, loopR, cx, cy;
		for (li = graph.links.length - 1; li >= 0; li--) {
			if (!isRootLink(graph.links[li])) continue;
			g = linkGeometryForIndex(li);
			if (!g) continue;
			if (g.type === 'loop') {
				var nx = g.na.x, ny = g.na.y;
				var offset = g.off;
				loopR = 14 + offset * 5;
				cx = nx + NODE_R + loopR * 0.62;
				cy = ny;
				dmin = 1e9;
				for (k = 0; k <= 24; k++) {
					ta = Math.PI * (0.65 + (1.85 - 0.65) * k / 24);
					qx = cx + loopR * Math.cos(ta);
					qy = cy + loopR * Math.sin(ta);
					dd = Math.sqrt((wx - qx) * (wx - qx) + (wy - qy) * (wy - qy));
					if (dd < dmin) dmin = dd;
				}
				d = dmin;
				if (d < bestD) {
					bestD = d;
					bestLi = li;
				}
			} else {
				d = distPointToSegment(wx, wy, g.sx, g.sy, g.ex, g.ey);
				if (d < bestD) {
					bestD = d;
					bestLi = li;
				}
			}
		}
		var thrEff = bestLi >= 0 && graph.links[bestLi] && graph.links[bestLi].from === graph.links[bestLi].to ? thr * 2 : thr;
		if (bestLi < 0 || bestD > thrEff) return null;
		return { index: bestLi };
	}

	function linkOffsetIndex(idx) {
		var L = graph.links[idx];
		if (!L || !isRootLink(L)) return 0;
		var c = 0;
		for (var j = 0; j < idx; j++) {
			var M = graph.links[j];
			if (!isRootLink(M)) continue;
			if (M.from === L.from && M.to === L.to) c++;
		}
		return c;
	}

	function drawArrowHeadOn(c, x0, y0, x1, y1, ah) {
		var ang = Math.atan2(y1 - y0, x1 - x0);
		c.beginPath();
		c.moveTo(x1, y1);
		c.lineTo(x1 - ah * Math.cos(ang - 0.5), y1 - ah * Math.sin(ang - 0.5));
		c.lineTo(x1 - ah * Math.cos(ang + 0.5), y1 - ah * Math.sin(ang + 0.5));
		c.closePath();
		c.fillStyle = c.strokeStyle;
		c.fill();
	}

	function drawDirectedEdgeOn(c, sc, nodeR, ax, ay, bx, by, offset) {
		var dx = bx - ax, dy = by - ay;
		var len = Math.sqrt(dx * dx + dy * dy);
		if (len < 0.01) return;
		var ux = dx / len, uy = dy / len;
		var px = -uy * offset, py = ux * offset;
		var sx = ax + ux * nodeR + px;
		var sy = ay + uy * nodeR + py;
		var ex = bx - ux * nodeR + px;
		var ey = by - uy * nodeR + py;
		c.beginPath();
		c.moveTo(sx, sy);
		c.lineTo(ex, ey);
		c.stroke();
		if (!graphOpts.showArrows) return;
		var ah = 8 / sc;
		drawArrowHeadOn(c, sx, sy, ex, ey, ah);
	}

	function drawSelfLoopOn(c, sc, nodeR, nx, ny, offset) {
		var loopR = 14 + offset * 5;
		var cx = nx + nodeR + loopR * 0.62;
		var cy = ny;
		c.beginPath();
		c.arc(cx, cy, loopR, Math.PI * 0.65, Math.PI * 1.85);
		c.stroke();
		if (!graphOpts.showArrows) return;
		var endAng = Math.PI * 1.85;
		var x1 = cx + loopR * Math.cos(endAng);
		var y1 = cy + loopR * Math.sin(endAng);
		var tang = endAng + Math.PI / 2;
		var ah = 7 / sc;
		c.beginPath();
		c.moveTo(x1, y1);
		c.lineTo(x1 - ah * Math.cos(tang - 0.45), y1 - ah * Math.sin(tang - 0.45));
		c.lineTo(x1 - ah * Math.cos(tang + 0.45), y1 - ah * Math.sin(tang + 0.45));
		c.closePath();
		c.fillStyle = c.strokeStyle;
		c.fill();
	}

	function draw() {
		NODE_R = Math.max(0.1, Number(graphOpts.nodeSize) || 2.1);
		var w = wrap.clientWidth;
		var h = wrap.clientHeight;
		ctx.save();
		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background') || '#1e1e1e';
		ctx.fillRect(0, 0, w, h);
		var cx = w / 2, cy = h / 2;
		ctx.translate(cx, cy);
		ctx.scale(scale, scale);
		ctx.translate(panX, panY);
		var focusId = hoverId || selectedId;
		var degree = rootDegreeMap();
		var connectedSet = {};
		if (focusId) {
			connectedSet[focusId] = true;
			for (var ci = 0; ci < graph.links.length; ci++) {
				var CL = graph.links[ci];
				if (!isRootLink(CL)) continue;
				if (CL.from === focusId) connectedSet[CL.to] = true;
				if (CL.to === focusId) connectedSet[CL.from] = true;
			}
		}

		ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--vscode-textLink-foreground') || '#3794ff';
		ctx.lineWidth = (Math.max(0.75, Number(graphOpts.edgeThickness) || 1.25)) / scale;
		ctx.globalAlpha = 0.85;
		for (var li = 0; li < graph.links.length; li++) {
			var L = graph.links[li];
			if (!isRootLink(L)) continue;
			var na = nodes.find(function (n) { return n.id === L.from; });
			var nb = nodes.find(function (n) { return n.id === L.to; });
			if (!na || !nb) continue;
			var connectedToHover = !!focusId && (L.from === focusId || L.to === focusId);
			ctx.strokeStyle = connectedToHover
				? '#00d4ff'
				: (getComputedStyle(document.body).getPropertyValue('--vscode-textLink-foreground') || '#3794ff');
			ctx.globalAlpha = !focusId ? 0.85 : (connectedToHover ? 1 : 0.2);
			var off = linkOffsetIndex(li) * 14;
			if (na.id === nb.id) {
				drawSelfLoopOn(ctx, scale, nodeRadiusByDegree(na.id, degree), na.x, na.y, linkOffsetIndex(li));
			} else {
				drawDirectedEdgeOn(ctx, scale, nodeRadiusByDegree(na.id, degree), na.x, na.y, nb.x, nb.y, off);
			}
		}
		ctx.globalAlpha = 1;

		var fg = getComputedStyle(document.body).getPropertyValue('--vscode-descriptionForeground') || '#a8a8a8';
		var accent = getComputedStyle(document.body).getPropertyValue('--vscode-focusBorder') || '#3794ff';
		for (var j = 0; j < nodes.length; j++) {
			var n = nodes[j];
			var nr = nodeRadiusByDegree(n.id, degree);
			ctx.beginPath();
			ctx.arc(n.x, n.y, nr, 0, Math.PI * 2);
			var isHover = n.id === hoverId;
			var isConnected = !!connectedSet[n.id];
			var isMarkedDelete = !!pendingDeleteIdSet[String(n.id || '')];
			ctx.globalAlpha = !focusId ? 1 : (isConnected ? 1 : 0.22);
			var useGroupColors = !!(optShowGroupsEl && optShowGroupsEl.checked);
			var gmeta = useGroupColors ? groupById(n.groupId) : null;
			var groupFill = gmeta ? String(gmeta.color || '') : '';
			if (groupFill) ctx.globalAlpha = 1;
			ctx.fillStyle = isMarkedDelete
				? '#ff4d4f'
				: (groupFill || getComputedStyle(document.body).getPropertyValue('--vscode-button-secondaryBackground') || '#3c3c3c');
			if (isHover && !groupFill) ctx.fillStyle = accent;
			ctx.fill();
			ctx.strokeStyle = groupFill ? groupFill : ((n.id === selectedId || isHover) ? accent : fg);
			ctx.lineWidth = (groupFill ? 2.6 : ((n.id === selectedId || isHover) ? 2.2 : 1)) / scale;
			ctx.stroke();
			ctx.fillStyle = fg;
			ctx.font = (TAG_GRAPH_NODE_LABEL_PX_AT_MAX_ZOOM / TAG_GRAPH_ZOOM_MAX) + 'px ' + getCanvasFontFamily();
			ctx.textAlign = 'center';
			ctx.textBaseline = 'top';
			var text = n.label.length > 28 ? n.label.slice(0, 26) + '...' : n.label;
			var t = Number(graphOpts.textFadeThreshold) || 0;
			var fadeStart = Math.max(0.2, 0.9 + t * 0.2);
			var alpha = (scale - fadeStart) / 0.6;
			alpha = Math.max(0, Math.min(1, alpha));
			if (!isHover && alpha > 0.01) {
				ctx.globalAlpha = alpha;
				ctx.fillText(text, n.x, n.y + nr + 5 / scale);
				ctx.globalAlpha = 1;
			}
		}
		ctx.restore();
		var hEl = hoverLabelEl || ensureGraphHoverLabelEl();
		if (hEl) {
			if (hoverId) {
				var hn = nodes.find(function (n) { return n.id === hoverId; });
				if (hn) {
					var hs = worldToScreen(hn.x, hn.y);
					var hoverText = hn.label.length > 120 ? hn.label.slice(0, 118) + '...' : hn.label;
					var degH2 = rootDegreeMap();
					var hoverNrScreen = nodeRadiusByDegree(hn.id, degH2) * scale;
					hEl.textContent = hoverText;
					hEl.style.fontSize = HOVER_LABEL_FONT_PX + 'px';
					hEl.style.left = Math.round(hs.x) + 'px';
					hEl.style.top = Math.round(hs.y + hoverNrScreen + 8) + 'px';
					hEl.hidden = false;
					hEl.setAttribute('aria-hidden', 'false');
				} else {
					hideGraphHoverLabel();
				}
			} else {
				hideGraphHoverLabel();
			}
		}
	}

	function simulateForces() {
		if (!nodes.length) return;
		if (graphOpts.rigid) {
			for (var rz = 0; rz < nodes.length; rz++) {
				nodes[rz].vx = 0;
				nodes[rz].vy = 0;
			}
			return;
		}
		if (Date.now() - lastSimulationKickAt > 5000) {
			for (var z = 0; z < nodes.length; z++) {
				nodes[z].vx = 0;
				nodes[z].vy = 0;
			}
			return;
		}
		var i, j;
		var centerK = Number(graphOpts.forceCenter) || 0;
		var repelK = Number(graphOpts.forceRepel) || 0;
		var linkK = Number(graphOpts.forceLink) || 0;
		var linkDist = Math.max(20, Number(graphOpts.linkDistance) || 140);
		for (i = 0; i < nodes.length; i++) {
			var n = nodes[i];
			if (dragNode && dragNode.id === n.id) continue;
			n.vx += (-n.x * centerK) * 0.01;
			n.vy += (-n.y * centerK) * 0.01;
		}
		for (i = 0; i < nodes.length; i++) {
			for (j = i + 1; j < nodes.length; j++) {
				var a = nodes[i], b = nodes[j];
				var dx = b.x - a.x, dy = b.y - a.y;
				var d2 = dx * dx + dy * dy + 0.01;
				var d = Math.sqrt(d2);
				var f = (repelK * 1200) / d2;
				var ux = dx / d, uy = dy / d;
				if (!(dragNode && dragNode.id === a.id)) { a.vx -= ux * f * 0.02; a.vy -= uy * f * 0.02; }
				if (!(dragNode && dragNode.id === b.id)) { b.vx += ux * f * 0.02; b.vy += uy * f * 0.02; }
			}
		}
		for (i = 0; i < graph.links.length; i++) {
			var L = graph.links[i];
			if (!isRootLink(L)) continue;
			var na = null, nb = null;
			for (j = 0; j < nodes.length; j++) {
				if (nodes[j].id === L.from) na = nodes[j];
				if (nodes[j].id === L.to) nb = nodes[j];
			}
			if (!na || !nb || na === nb) continue;
			var lx = nb.x - na.x, ly = nb.y - na.y;
			var ld = Math.sqrt(lx * lx + ly * ly) || 0.001;
			var diff = ld - linkDist;
			var sf = diff * linkK * 0.0025;
			var ux2 = lx / ld, uy2 = ly / ld;
			if (!(dragNode && dragNode.id === na.id)) { na.vx += ux2 * sf; na.vy += uy2 * sf; }
			if (!(dragNode && dragNode.id === nb.id)) { nb.vx -= ux2 * sf; nb.vy -= uy2 * sf; }
		}
		for (i = 0; i < nodes.length; i++) {
			var n2 = nodes[i];
			if (dragNode && dragNode.id === n2.id) continue;
			n2.vx *= 0.92;
			n2.vy *= 0.92;
			n2.x += n2.vx;
			n2.y += n2.vy;
		}
		// Collision pass: enforce minimum separation so nodes don't overlap.
		var degree = rootDegreeMap();
		for (i = 0; i < nodes.length; i++) {
			for (j = i + 1; j < nodes.length; j++) {
				var c1 = nodes[i], c2 = nodes[j];
				var minDist = nodeRadiusByDegree(c1.id, degree) + nodeRadiusByDegree(c2.id, degree) + 8;
				var cdx = c2.x - c1.x, cdy = c2.y - c1.y;
				var cd = Math.sqrt(cdx * cdx + cdy * cdy) || 0.001;
				if (cd >= minDist) continue;
				var push = (minDist - cd) * 0.5;
				var pux = cdx / cd, puy = cdy / cd;
				if (!(dragNode && dragNode.id === c1.id)) {
					c1.x -= pux * push;
					c1.y -= puy * push;
				}
				if (!(dragNode && dragNode.id === c2.id)) {
					c2.x += pux * push;
					c2.y += puy * push;
				}
			}
		}
	}

	function loop() {
		if (!running) return;
		var tp = document.getElementById('tags-main-panel');
		if (tp && tp.hidden) {
			hideGraphHoverLabel();
			requestAnimationFrame(loop);
			return;
		}
		simulateForces();
		draw();
		if (openSubtagPanelId && subCtx && subGraphWrap) {
			positionSubtagFlyout();
			drawSubGraph();
		}
		requestAnimationFrame(loop);
	}

	function fillSelects() {
		function fill(sel) {
			var v = sel.value;
			sel.innerHTML = '<option value="">\u2014</option>';
			var roots = rootNodes();
			for (var i = 0; i < roots.length; i++) {
				var t = roots[i];
				var o = document.createElement('option');
				o.value = t.id;
				o.textContent = t.label;
				sel.appendChild(o);
			}
			if (v && tagById(v)) sel.value = v;
		}
		fill(selFromEl);
		fill(selToEl);
	}

	function renderLinksList() {
		if (!linksListEl) return;
		linksListEl.innerHTML = '';
		for (var i = 0; i < graph.links.length; i++) {
			var L = graph.links[i];
			if (!isRootLink(L)) continue;
			var li = document.createElement('li');
			var span = document.createElement('span');
			span.textContent = labelFor(L.from) + ' \u2192 ' + labelFor(L.to);
			var btn = document.createElement('button');
			btn.type = 'button';
			btn.textContent = 'Remove';
			btn.setAttribute('data-idx', String(i));
			btn.addEventListener('click', function () {
				vscode.postMessage({ type: 'removeLink', index: parseInt(this.getAttribute('data-idx'), 10) });
			});
			li.appendChild(span);
			li.appendChild(btn);
			linksListEl.appendChild(li);
		}
	}

	function updateSidebar() {
		fillSelects();
		updateGroupsUi();
		renderLinksList();
		if (selInfoEl) {
			if (selectedId && tagById(selectedId)) {
				var s = tagById(selectedId);
				var parent = s.parentId ? tagById(s.parentId) : null;
				var children = [];
				var parents = [];
				var connections = [];
				for (var i = 0; i < graph.links.length; i++) {
					var L = graph.links[i];
					if (L.from === s.id) children.push(labelFor(L.to));
					if (L.to === s.id) parents.push(labelFor(L.from));
				}
				var pair = {};
				for (var j = 0; j < graph.links.length; j++) {
					var D = graph.links[j];
					pair[D.from + '->' + D.to] = true;
				}
				for (var k = 0; k < graph.links.length; k++) {
					var B = graph.links[k];
					if (B.from !== s.id || B.to === s.id) continue;
					if (pair[B.to + '->' + B.from]) connections.push(labelFor(B.to));
				}
				function fmt(arr) { return arr.length ? arr.join(', ') : '\u2014'; }
				function esc(v) {
					return String(v)
						.replace(/&/g, '&amp;')
						.replace(/</g, '&lt;')
						.replace(/>/g, '&gt;')
						.replace(/"/g, '&quot;')
						.replace(/'/g, '&#39;');
				}
				var sg = groupById(s.groupId);
				selInfoEl.innerHTML =
					'<div><strong>Tag name:</strong> ' + esc(s.label) + '</div>' +
					'<div><strong>Group:</strong> ' + esc(sg ? sg.name : '\u2014') + '</div>' +
					'<div><strong>Parents:</strong> ' + esc(parents.length ? fmt(parents) : (parent ? parent.label : '\u2014')) + '</div>' +
					'<div><strong>Children:</strong> ' + esc(fmt(children)) + '</div>' +
					'<div><strong>Connection:</strong> ' + esc(fmt(connections)) + '</div>';
			} else {
				selInfoEl.innerHTML = '';
			}
		}
	}

	function syncSubNodesFromGraph() {
		var focus = openSubtagPanelId;
		var t = nodeById(focus);
		if (!t) {
			subNodes = [];
			return;
		}
		var map = {};
		for (var i = 0; i < subNodes.length; i++) map[subNodes[i].id] = subNodes[i];
		var nx = t.nest && typeof t.nest.x === 'number' && Number.isFinite(t.nest.x) ? t.nest.x : 0;
		var ny = t.nest && typeof t.nest.y === 'number' && Number.isFinite(t.nest.y) ? t.nest.y : 0;
		var po = map[t.id];
		var px = po ? po.x : nx;
		var py = po ? po.y : ny;
		var next = [{ id: t.id, label: t.label, x: px, y: py, groupId: String(t.groupId || ''), isParentAnchor: true }];
		var children = [];
		for (var j = 0; j < graph.nodes.length; j++) {
			if (graph.nodes[j].parentId === focus) children.push(graph.nodes[j]);
		}
		var total = children.length;
		for (var k = 0; k < total; k++) {
			var tg = children[k];
			var old = map[tg.id];
			var x, y;
			if (typeof tg.x === 'number' && Number.isFinite(tg.x)) {
				x = tg.x;
			} else if (old) {
				x = old.x;
			} else {
				var ang = (2 * Math.PI * k) / Math.max(total, 1);
				x = Math.cos(ang) * 50;
			}
			if (typeof tg.y === 'number' && Number.isFinite(tg.y)) {
				y = tg.y;
			} else if (old) {
				y = old.y;
			} else {
				var ang2 = (2 * Math.PI * k) / Math.max(total, 1);
				y = Math.sin(ang2) * 50;
			}
			next.push({ id: tg.id, label: tg.label, x: x, y: y, groupId: String(tg.groupId || ''), isParentAnchor: false });
		}
		subNodes = next;
	}

	function resizeSubCanvas() {
		if (!subGraphWrap || !subCanvas || !subCtx) return;
		var dpr = window.devicePixelRatio || 1;
		var w = subGraphWrap.clientWidth || 260;
		var h = subGraphWrap.clientHeight || 160;
		subCanvas.width = Math.floor(w * dpr);
		subCanvas.height = Math.floor(h * dpr);
		subCanvas.style.width = w + 'px';
		subCanvas.style.height = h + 'px';
		subCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	function positionSubtagFlyout() {
		if (!subTagFlyout || !wrap || !openSubtagPanelId) return;
		var anchor = nodes.find(function (n) { return n.id === openSubtagPanelId; });
		var scr;
		if (anchor) {
			scr = worldToScreen(anchor.x, anchor.y + NODE_R + 8);
		} else {
			scr = { x: 16, y: 16 };
		}
		var ww = wrap.clientWidth;
		var wh = wrap.clientHeight;
		var fw = Math.min(FLYOUT_W, ww - 12);
		var fh = Math.min(FLYOUT_H, wh - 12);
		subTagFlyout.style.width = fw + 'px';
		subTagFlyout.style.maxHeight = fh + 'px';
		var left = Math.round(scr.x + 14);
		var top = Math.round(scr.y);
		if (left + fw > ww - 6) left = Math.max(6, ww - fw - 6);
		if (top + fh > wh - 6) top = Math.max(6, wh - fh - 6);
		if (left < 6) left = 6;
		if (top < 6) top = 6;
		subTagFlyout.style.left = left + 'px';
		subTagFlyout.style.top = top + 'px';
	}

	function subWorldToScreen(wx, wy) {
		var cw = subGraphWrap.clientWidth / 2;
		var ch = subGraphWrap.clientHeight / 2;
		return { x: (wx + subPanX) * subScale + cw, y: (wy + subPanY) * subScale + ch };
	}

	function subScreenToWorld(sx, sy) {
		var cw = subGraphWrap.clientWidth / 2;
		var ch = subGraphWrap.clientHeight / 2;
		return { x: (sx - cw) / subScale - subPanX, y: (sy - ch) / subScale - subPanY };
	}

	function subLabelFor(id) {
		var n = subNodes.find(function (x) { return x.id === id; });
		return n ? n.label : id;
	}

	function subLinkOffsetIndex(idx) {
		var focus = openSubtagPanelId;
		if (!focus) return 0;
		var L = graph.links[idx];
		if (!L || !isSubFocusLink(L, focus)) return 0;
		var c = 0;
		for (var j = 0; j < idx; j++) {
			var M = graph.links[j];
			if (!isSubFocusLink(M, focus)) continue;
			if (M.from === L.from && M.to === L.to) c++;
		}
		return c;
	}

	function subLinkGeometryForIndex(li) {
		var focus = openSubtagPanelId;
		if (!focus || li < 0 || li >= graph.links.length) return null;
		var L = graph.links[li];
		if (!L || !isSubFocusLink(L, focus)) return null;
		var na = subNodes.find(function (n) { return n.id === L.from; });
		var nb = subNodes.find(function (n) { return n.id === L.to; });
		if (!na || !nb) return null;
		var off = subLinkOffsetIndex(li) * 12;
		if (na.id === nb.id) {
			return { type: 'loop', na: na, off: subLinkOffsetIndex(li), li: li };
		}
		var dx = nb.x - na.x, dy = nb.y - na.y;
		var len = Math.sqrt(dx * dx + dy * dy);
		if (len < 0.01) return null;
		var ux = dx / len, uy = dy / len;
		var px = -uy * off, py = ux * off;
		return {
			type: 'seg',
			sx: na.x + ux * SUB_NODE_R + px,
			sy: na.y + uy * SUB_NODE_R + py,
			ex: nb.x - ux * SUB_NODE_R + px,
			ey: nb.y - uy * SUB_NODE_R + py,
			li: li
		};
	}

	function subPickNode(wx, wy) {
		for (var i = subNodes.length - 1; i >= 0; i--) {
			var n = subNodes[i];
			var dx = n.x - wx, dy = n.y - wy;
			if (dx * dx + dy * dy <= SUB_NODE_R * SUB_NODE_R * 1.35) return n;
		}
		return null;
	}

	function subPickLink(wx, wy) {
		var focus = openSubtagPanelId;
		if (!focus) return null;
		var thr = 9 / Math.max(subScale, 0.3);
		var bestLi = -1;
		var bestD = 1e9;
		var li, g, d, k, ta, qx, qy, dd, dmin, loopR, cx, cy;
		for (li = graph.links.length - 1; li >= 0; li--) {
			if (!isSubFocusLink(graph.links[li], focus)) continue;
			g = subLinkGeometryForIndex(li);
			if (!g) continue;
			if (g.type === 'loop') {
				var nx = g.na.x, ny = g.na.y;
				var offset = g.off;
				loopR = 12 + offset * 4;
				cx = nx + SUB_NODE_R + loopR * 0.62;
				cy = ny;
				dmin = 1e9;
				for (k = 0; k <= 24; k++) {
					ta = Math.PI * (0.65 + (1.85 - 0.65) * k / 24);
					qx = cx + loopR * Math.cos(ta);
					qy = cy + loopR * Math.sin(ta);
					dd = Math.sqrt((wx - qx) * (wx - qx) + (wy - qy) * (wy - qy));
					if (dd < dmin) dmin = dd;
				}
				d = dmin;
				if (d < bestD) {
					bestD = d;
					bestLi = li;
				}
			} else {
				d = distPointToSegment(wx, wy, g.sx, g.sy, g.ex, g.ey);
				if (d < bestD) {
					bestD = d;
					bestLi = li;
				}
			}
		}
		var L0 = bestLi >= 0 ? graph.links[bestLi] : null;
		var thrEff = L0 && L0.from === L0.to ? thr * 2 : thr;
		if (bestLi < 0 || bestD > thrEff) return null;
		return { index: bestLi };
	}

	function drawSubGraph() {
		if (!subCtx || !subGraphWrap || !openSubtagPanelId) return;
		var focus = openSubtagPanelId;
		var w = subGraphWrap.clientWidth;
		var h = subGraphWrap.clientHeight;
		var c = subCtx;
		c.save();
		c.clearRect(0, 0, w, h);
		c.fillStyle = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background') || '#1e1e1e';
		c.fillRect(0, 0, w, h);
		var cx = w / 2, cy = h / 2;
		c.translate(cx, cy);
		c.scale(subScale, subScale);
		c.translate(subPanX, subPanY);

		c.strokeStyle = getComputedStyle(document.body).getPropertyValue('--vscode-textLink-foreground') || '#3794ff';
		c.lineWidth = 1.15 / subScale;
		c.globalAlpha = 0.88;
		for (var li = 0; li < graph.links.length; li++) {
			var L = graph.links[li];
			if (!isSubFocusLink(L, focus)) continue;
			var na = subNodes.find(function (n) { return n.id === L.from; });
			var nb = subNodes.find(function (n) { return n.id === L.to; });
			if (!na || !nb) continue;
			var off = subLinkOffsetIndex(li) * 12;
			if (na.id === nb.id) {
				drawSelfLoopOn(c, subScale, SUB_NODE_R, na.x, na.y, subLinkOffsetIndex(li));
			} else {
				drawDirectedEdgeOn(c, subScale, SUB_NODE_R, na.x, na.y, nb.x, nb.y, off);
			}
		}
		c.globalAlpha = 1;

		var fg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground') || '#ccc';
		var accent = getComputedStyle(document.body).getPropertyValue('--vscode-focusBorder') || '#3794ff';
		var parentAccent = getComputedStyle(document.body).getPropertyValue('--vscode-symbolIcon-classForeground') || accent;
		for (var j = 0; j < subNodes.length; j++) {
			var n = subNodes[j];
			var isP = n.isParentAnchor === true;
			c.beginPath();
			c.arc(n.x, n.y, SUB_NODE_R, 0, Math.PI * 2);
			var useGroupColorsSub = !!(optShowGroupsEl && optShowGroupsEl.checked);
			var subGroup = useGroupColorsSub ? groupById(n.groupId) : null;
			var subGroupFill = subGroup ? String(subGroup.color || '') : '';
			var isMarkedDeleteSub = !!pendingDeleteIdSet[String(n.id || '')];
			if (subGroupFill) c.globalAlpha = 1;
			c.fillStyle = isMarkedDeleteSub
				? '#ff4d4f'
				: (subGroupFill || (isP ? getComputedStyle(document.body).getPropertyValue('--vscode-inputOption-activeBackground') || '#3c3c3c' : getComputedStyle(document.body).getPropertyValue('--vscode-button-secondaryBackground') || '#3c3c3c'));
			if (n.id === subSelectedId && !subGroupFill) c.fillStyle = accent;
			c.fill();
			c.strokeStyle = subGroupFill ? subGroupFill : (n.id === subSelectedId ? accent : (isP ? parentAccent : fg));
			c.lineWidth = (subGroupFill ? 2.3 : (n.id === subSelectedId ? 2 : isP ? 1.8 : 1)) / subScale;
			c.stroke();
			c.fillStyle = fg;
			c.font = (TAG_SUBGRAPH_NODE_LABEL_PX_AT_MAX_ZOOM / 2.5) + 'px ' + getCanvasFontFamily();
			c.textAlign = 'center';
			c.textBaseline = 'top';
			var text = n.label.length > 22 ? n.label.slice(0, 20) + '...' : n.label;
			c.fillText(isP ? '\u2191 ' + text : text, n.x, n.y + SUB_NODE_R + 4 / subScale);
		}
		c.restore();
	}

	function hideSubCtxMenu() {
		subCtxLinkIndex = -1;
		subCtxEdgeEndpoints = null;
		subCtxCanvasWorld = null;
		if (subCtxMenuEl) subCtxMenuEl.hidden = true;
	}

	function openSubCtxMenu(ev, items) {
		if (!subCtxMenuEl || !subGraphWrap) return;
		subCtxMenuEl.innerHTML = '';
		for (var i = 0; i < items.length; i++) {
			var it = items[i];
			var b = document.createElement('button');
			b.type = 'button';
			b.setAttribute('role', 'menuitem');
			b.setAttribute('data-act', it.act);
			if (it.which) b.setAttribute('data-which', it.which);
			b.textContent = it.label;
			if (it.danger) b.className = 'stag-ctx-danger';
			subCtxMenuEl.appendChild(b);
		}
		var r = subGraphWrap.getBoundingClientRect();
		subCtxMenuEl.style.left = (ev.clientX - r.left) + 'px';
		subCtxMenuEl.style.top = (ev.clientY - r.top) + 'px';
		subCtxMenuEl.hidden = false;
	}

	function saveSubGraphLayoutDebounced() {
		if (saveSubGraphLayoutDebounced._t) clearTimeout(saveSubGraphLayoutDebounced._t);
		saveSubGraphLayoutDebounced._t = setTimeout(function () {
			if (!openSubtagPanelId) return;
			var pos = {};
			for (var i = 0; i < subNodes.length; i++) {
				pos[subNodes[i].id] = { x: subNodes[i].x, y: subNodes[i].y };
			}
			vscode.postMessage({ type: 'saveSubGraphLayout', parentTagId: openSubtagPanelId, positions: pos });
		}, 400);
	}

	function hideSubtagPanel() {
		openSubtagPanelId = '';
		subNodes = [];
		subSelectedId = '';
		subLinkSourceId = '';
		hideSubCtxMenu();
		if (subTagFlyout) subTagFlyout.hidden = true;
		if (subTagNew) subTagNew.value = '';
		subPanning = false;
		subDragNode = null;
		if (subGraphWrap) subGraphWrap.classList.remove('stag-panning', 'stag-drag-node');
		resizeCanvas();
	}

	function showSubtagPanel(tagId) {
		if (!subTagFlyout || !tagById(tagId) || !subCanvas || !subCtx) return;
		openSubtagPanelId = tagId;
		subScale = 1;
		subPanX = 0;
		subPanY = 0;
		subSelectedId = '';
		subLinkSourceId = '';
		syncSubNodesFromGraph();
		subTagFlyout.hidden = false;
		if (subTagTitle) {
			var tg = tagById(tagId);
			subTagTitle.textContent = tg ? 'Sub-tags: ' + tg.label : 'Sub-tags';
		}
		resizeSubCanvas();
		positionSubtagFlyout();
		resizeCanvas();
	}

	function toggleSubtagPanel(tagId) {
		if (!subTagFlyout) return;
		if (openSubtagPanelId === tagId) {
			hideSubtagPanel();
		} else {
			showSubtagPanel(tagId);
		}
	}

	function hideCtxMenu() {
		ctxLinkIndex = -1;
		ctxCanvasWorld = null;
		ctxEdgeEndpoints = null;
		if (ctxMenuEl) ctxMenuEl.hidden = true;
	}

	function openCtxMenu(ev, items) {
		if (!ctxMenuEl || !wrap) return;
		ctxMenuEl.innerHTML = '';
		for (var i = 0; i < items.length; i++) {
			var it = items[i];
			var b = document.createElement('button');
			b.type = 'button';
			b.setAttribute('role', 'menuitem');
			b.setAttribute('data-act', it.act);
			if (it.which) b.setAttribute('data-which', it.which);
			b.textContent = it.label;
			if (it.danger) b.className = 'stag-ctx-danger';
			ctxMenuEl.appendChild(b);
		}
		var r = wrap.getBoundingClientRect();
		ctxMenuEl.style.left = (ev.clientX - r.left) + 'px';
		ctxMenuEl.style.top = (ev.clientY - r.top) + 'px';
		ctxMenuEl.hidden = false;
	}

	var inlineRenameWrap = null;
	var inlineRenameInput = null;
	var inlineRenameTagId = '';
	var inlineRenameOriginal = '';

	function isInlineRenameOpen() {
		return inlineRenameWrap && !inlineRenameWrap.hidden;
	}

	function removeInlineRename() {
		if (inlineRenameInput) {
			inlineRenameInput.removeEventListener('keydown', inlineRenameKeydown);
		}
		if (inlineRenameWrap) {
			inlineRenameWrap.hidden = true;
			inlineRenameWrap.style.display = 'none';
		}
		inlineRenameTagId = '';
		inlineRenameOriginal = '';
	}

	function inlineRenameKeydown(ev) {
		if (ev.key === 'Enter') {
			ev.preventDefault();
			commitInlineRename();
		} else if (ev.key === 'Escape') {
			ev.preventDefault();
			removeInlineRename();
		}
	}

	function commitInlineRename() {
		if (!inlineRenameTagId || !inlineRenameInput) return;
		var v = String(inlineRenameInput.value || '').trim();
		var id = inlineRenameTagId;
		var orig = inlineRenameOriginal;
		removeInlineRename();
		if (!v || v === orig) return;
		vscode.postMessage({ type: 'renameTag', id: id, label: v });
	}

	function showInlineRename() {
		if (!selectedId || !tagById(selectedId)) return;
		var n = nodes.find(function (x) { return x.id === selectedId; });
		if (!n) return;
		if (inlineRenameInput) {
			inlineRenameInput.removeEventListener('keydown', inlineRenameKeydown);
		}
		if (!inlineRenameWrap) {
			inlineRenameWrap = document.createElement('div');
			inlineRenameWrap.id = 'stag-inline-rename-wrap';
			inlineRenameWrap.setAttribute('role', 'dialog');
			inlineRenameWrap.setAttribute('aria-label', 'Rename tag');
			inlineRenameWrap.style.cssText = 'position:absolute;z-index:70;display:none;box-sizing:border-box;padding:4px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-focusBorder);border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.25);';
			inlineRenameInput = document.createElement('input');
			inlineRenameInput.type = 'text';
			inlineRenameInput.setAttribute('autocomplete', 'off');
			inlineRenameInput.style.cssText = 'width:100%;box-sizing:border-box;margin:0;border:1px solid var(--vscode-input-border);border-radius:3px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:5px 8px;font-size:13px;font-family:var(--vscode-font-family);';
			inlineRenameWrap.appendChild(inlineRenameInput);
			wrap.appendChild(inlineRenameWrap);
		}
		inlineRenameTagId = selectedId;
		inlineRenameOriginal = tagById(selectedId).label;
		var scr = worldToScreen(n.x, n.y + NODE_R + 18 / Math.max(scale, 0.4));
		var iw = Math.min(280, Math.max(120, wrap.clientWidth - 16));
		var left = Math.round(scr.x - iw / 2);
		left = Math.max(8, Math.min(left, wrap.clientWidth - iw - 8));
		var top = Math.round(scr.y);
		top = Math.max(8, Math.min(top, wrap.clientHeight - 52));
		inlineRenameWrap.style.width = iw + 'px';
		inlineRenameWrap.style.left = left + 'px';
		inlineRenameWrap.style.top = top + 'px';
		inlineRenameWrap.hidden = false;
		inlineRenameWrap.style.display = 'block';
		inlineRenameInput.value = inlineRenameOriginal;
		inlineRenameInput.addEventListener('keydown', inlineRenameKeydown);
		inlineRenameInput.focus();
		inlineRenameInput.select();
	}

	var subFlyRenameWrap = null;
	var subFlyRenameInput = null;
	var subFlyRenameId = '';
	var subFlyRenameIsParent = false;
	var subFlyRenameOriginal = '';

	function isSubFlyRenameOpen() {
		return subFlyRenameWrap && !subFlyRenameWrap.hidden;
	}

	function removeSubFlyRename() {
		if (subFlyRenameInput) subFlyRenameInput.removeEventListener('keydown', subFlyRenameKeydownSub);
		if (subFlyRenameWrap) {
			subFlyRenameWrap.hidden = true;
			subFlyRenameWrap.style.display = 'none';
		}
		subFlyRenameId = '';
		subFlyRenameIsParent = false;
		subFlyRenameOriginal = '';
	}

	function subFlyRenameKeydownSub(ev) {
		if (ev.key === 'Enter') {
			ev.preventDefault();
			commitSubFlyRename();
		} else if (ev.key === 'Escape') {
			ev.preventDefault();
			removeSubFlyRename();
		}
	}

	function commitSubFlyRename() {
		if (!subFlyRenameId || !subFlyRenameInput) return;
		var v = String(subFlyRenameInput.value || '').trim();
		var sid = subFlyRenameId;
		var orig = subFlyRenameOriginal;
		removeSubFlyRename();
		if (!v || v === orig) return;
		vscode.postMessage({ type: 'renameTag', id: sid, label: v });
	}

	function showSubFlyRename(node) {
		if (!node || !subGraphWrap) return;
		if (subFlyRenameInput) subFlyRenameInput.removeEventListener('keydown', subFlyRenameKeydownSub);
		if (!subFlyRenameWrap) {
			subFlyRenameWrap = document.createElement('div');
			subFlyRenameWrap.id = 'stag-sub-fly-rename-wrap';
			subFlyRenameWrap.setAttribute('role', 'dialog');
			subFlyRenameWrap.setAttribute('aria-label', 'Rename sub-tag');
			subFlyRenameWrap.style.cssText = 'position:fixed;z-index:100000;display:none;box-sizing:border-box;padding:4px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-focusBorder);border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.25);';
			subFlyRenameInput = document.createElement('input');
			subFlyRenameInput.type = 'text';
			subFlyRenameInput.setAttribute('autocomplete', 'off');
			subFlyRenameInput.style.cssText = 'width:100%;box-sizing:border-box;margin:0;border:1px solid var(--vscode-input-border);border-radius:3px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:5px 8px;font-size:12px;font-family:var(--vscode-font-family);';
			subFlyRenameWrap.appendChild(subFlyRenameInput);
			document.body.appendChild(subFlyRenameWrap);
		}
		subFlyRenameId = node.id;
		subFlyRenameIsParent = node.isParentAnchor === true;
		subFlyRenameOriginal = node.label || '';
		var scr = subWorldToScreen(node.x, node.y);
		var br = subGraphWrap.getBoundingClientRect();
		var iw = Math.min(260, Math.max(120, Math.min(subGraphWrap.clientWidth - 16, window.innerWidth - 24)));
		var cx = br.left + scr.x;
		var cy = br.top + scr.y + SUB_NODE_R * subScale + 10;
		var left = Math.round(cx - iw / 2);
		var top = Math.round(cy);
		var vw = window.innerWidth;
		var vh = window.innerHeight;
		left = Math.max(8, Math.min(left, vw - iw - 8));
		top = Math.max(8, Math.min(top, vh - 52));
		subFlyRenameWrap.style.width = iw + 'px';
		subFlyRenameWrap.style.left = left + 'px';
		subFlyRenameWrap.style.top = top + 'px';
		subFlyRenameWrap.hidden = false;
		subFlyRenameWrap.style.display = 'block';
		subFlyRenameInput.value = subFlyRenameOriginal;
		subFlyRenameInput.addEventListener('keydown', subFlyRenameKeydownSub);
		subFlyRenameInput.focus();
		subFlyRenameInput.select();
	}

	function applyGraph(g) {
		if (g && g.version >= 2 && Array.isArray(g.nodes)) {
			graph = {
				version: g.version,
				nodes: g.nodes,
				links: g.links || [],
				groups: Array.isArray(g.groups) ? g.groups : []
			};
		} else {
			graph = { version: 2, nodes: [], links: [], groups: [] };
		}
		syncNodesFromGraph();
		if (selectedId && !tagById(selectedId)) {
			selectedId = '';
		}
		if (linkSourceId && !tagById(linkSourceId)) {
			linkSourceId = '';
		}
		if (openSubtagPanelId && !tagById(openSubtagPanelId)) {
			hideSubtagPanel();
		} else if (openSubtagPanelId) {
			syncSubNodesFromGraph();
			if (subSelectedId && !subNodes.some(function (n) { return n.id === subSelectedId; })) {
				subSelectedId = '';
			}
			if (subLinkSourceId && !subNodes.some(function (n) { return n.id === subLinkSourceId; })) {
				subLinkSourceId = '';
			}
			resizeSubCanvas();
		}
		updateSidebar();
		if (errEl) errEl.textContent = '';
	}

	function applyGraphSelectFromState(m) {
		if (!graphSelectEl) return;
		var graphs = m.storedGraphs || [];
		storedGraphsCache = graphs.slice();
		var activeId = m.activeGraphId || '';
		var activeName = m.activeGraphName || '';
		lastActiveGraphId = activeId;
		syncingGraphSelect = true;
		graphSelectEl.innerHTML = '';
		var i;
		for (i = 0; i < graphs.length; i++) {
			var sg = graphs[i];
			var opt = document.createElement('option');
			opt.value = sg.id;
			opt.textContent = sg.name;
			graphSelectEl.appendChild(opt);
		}
		var oNew = document.createElement('option');
		oNew.value = '__new__';
		oNew.textContent = '+ New graph…';
		graphSelectEl.appendChild(oNew);
		var oImp = document.createElement('option');
		oImp.value = '__import__';
		oImp.textContent = 'Import from JSON…';
		graphSelectEl.appendChild(oImp);
		var hasActive = false;
		for (i = 0; i < graphSelectEl.options.length; i++) {
			if (graphSelectEl.options[i].value === activeId) {
				hasActive = true;
				break;
			}
		}
		if (hasActive) {
			graphSelectEl.value = activeId;
		} else if (graphs.length) {
			graphSelectEl.value = graphs[0].id;
			lastActiveGraphId = graphs[0].id;
		}
		if (graphNameEl) {
			graphNameEl.value = activeName;
		}
		if (isRenamingGraph) {
			setGraphRenameMode(false);
		}
		if (isCombineMode) {
			combineSourceIds = ensureUniqueCombineSourceIds(combineSourceIds.filter(function (id) {
				return graphs.some(function (g) { return String(g.id) === String(id); });
			}));
			if (!combineSourceIds.length && activeId) combineSourceIds.push(String(activeId));
			renderCombineList();
		}
		syncingGraphSelect = false;
	}

	function saveLayoutDebounced() {
		// Intentionally disabled: main graph uses force-directed fluid layout.
	}

	function setViewMode(mode) {
		var sp = document.getElementById('storage-main-panel');
		var tp = document.getElementById('tags-main-panel');
		var bs = document.getElementById('vm-storage');
		var bt = document.getElementById('vm-tags');
		if (!sp || !tp) return;
		var tags = mode === 'tags';
		sp.hidden = tags;
		sp.classList.toggle('panel-hidden', tags);
		tp.hidden = !tags;
		tp.classList.toggle('panel-hidden', !tags);
		if (bs) {
			bs.classList.toggle('vm-active', !tags);
			bs.setAttribute('aria-selected', tags ? 'false' : 'true');
		}
		if (bt) {
			bt.classList.toggle('vm-active', tags);
			bt.setAttribute('aria-selected', tags ? 'true' : 'false');
		}
		if (tags) resizeCanvas();
	}

	window.addEventListener('message', function (event) {
		var m = event.data;
		if (m.type === 'dripViewMode') {
			setViewMode(m.mode === 'tags' ? 'tags' : 'storage');
			if (m.mode === 'tags') {
				vscode.postMessage({ type: 'requestTagGraph' });
			}
			return;
		}
		if (m.type === 'tagGraphState') {
			applyGraph(m.graph);
			applyGraphSelectFromState(m);
			if (m.focusRenameTagId) {
				selectedId = m.focusRenameTagId;
				updateSidebar();
				setTimeout(function () {
					showInlineRename();
				}, 0);
			}
		}
		if (m.type === 'tagGraphCombinePreview') {
			if (isCombineMode && m.graph) {
				applyGraph(m.graph);
			}
			return;
		}
		if (m.type === 'tagGraphError') {
			if (errEl) errEl.textContent = m.message || 'Error';
		}
	});

	function isTypingTarget(el) {
		if (!el) return false;
		var tag = (el.tagName || '').toLowerCase();
		if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
		if (el.isContentEditable) return true;
		return false;
	}

	window.addEventListener('keydown', function (ev) {
		if (ev.key === 'Escape' && isDeleteNodeSelectMode) {
			ev.preventDefault();
			setDeleteNodeSelectMode(false);
			return;
		}
		if (ev.key === 'Delete' && isDeleteNodeSelectMode) {
			ev.preventDefault();
			var delIds = Object.keys(pendingDeleteIdSet);
			if (!delIds.length) {
				setDeleteNodeSelectMode(false);
				return;
			}
			vscode.postMessage({ type: 'requestRemoveTagsDialog', ids: delIds });
			setDeleteNodeSelectMode(false);
			return;
		}
		if (ev.key === 'Escape' && isGroupNodeSelectMode) {
			ev.preventDefault();
			setGroupNodeSelectMode(false);
			return;
		}
		// Ctrl+Z / Ctrl+Y for graph undo/redo (don't steal from text inputs).
		if (isTypingTarget(document.activeElement)) return;
		if (ev.key === 'Delete') {
			// Delete selected node (main tag or currently selected sub-tag).
			if (openSubtagPanelId && subSelectedId) {
				var subSel = subNodes.find(function (n) { return n.id === subSelectedId; });
				if (subSel && !subSel.isParentAnchor) {
					ev.preventDefault();
					vscode.postMessage({
						type: 'requestRemoveSubGraphTagDialog',
						parentTagId: openSubtagPanelId,
						subTagId: subSelectedId
					});
					return;
				}
			}
			if (selectedId && tagById(selectedId)) {
				ev.preventDefault();
				vscode.postMessage({ type: 'requestRemoveTagDialog', id: selectedId });
			}
			return;
		}
		if (!(ev.ctrlKey || ev.metaKey)) return;
		var k = String(ev.key || '').toLowerCase();
		if (k === 'z') {
			ev.preventDefault();
			if (ev.shiftKey) vscode.postMessage({ type: 'redoTagGraph' });
			else vscode.postMessage({ type: 'undoTagGraph' });
		} else if (k === 'y') {
			ev.preventDefault();
			vscode.postMessage({ type: 'redoTagGraph' });
		}
	}, true);

	function clientXY(ev) {
		var r = canvas.getBoundingClientRect();
		return { x: ev.clientX - r.left, y: ev.clientY - r.top };
	}

	window.addEventListener('mousedown', function (ev) {
		if (ev.button !== 0) return;
		if (isInlineRenameOpen()) {
			if (inlineRenameWrap && !inlineRenameWrap.contains(ev.target)) {
				commitInlineRename();
				ev.stopPropagation();
				ev.preventDefault();
			}
			return;
		}
		if (isSubFlyRenameOpen()) {
			if (subFlyRenameWrap && !subFlyRenameWrap.contains(ev.target)) {
				commitSubFlyRename();
				ev.stopPropagation();
				ev.preventDefault();
			}
			return;
		}
		if (ctxMenuEl && !ctxMenuEl.hidden && !ctxMenuEl.contains(ev.target)) hideCtxMenu();
		if (subCtxMenuEl && !subCtxMenuEl.hidden && !subCtxMenuEl.contains(ev.target)) hideSubCtxMenu();
	}, true);

	window.addEventListener('keydown', function (ev) {
		if (ev.key === 'Shift') subShiftHeld = true;
	}, true);
	window.addEventListener('keyup', function (ev) {
		if (ev.key === 'Shift') subShiftHeld = false;
	}, true);

	canvas.addEventListener('contextmenu', function (ev) {
		ev.preventDefault();
		vscode.postMessage({ type: 'tagsPanelUiActivated' });
		var p = clientXY(ev);
		var w = screenToWorld(p.x, p.y);
		ctxLinkIndex = -1;
		ctxCanvasWorld = null;
		var nodeHit = pickNode(w.x, w.y);
		if (nodeHit) {
			selectedId = nodeHit.id;
			linkSourceId = nodeHit.id;
			updateSidebar();
			openCtxMenu(ev, [
				{ act: 'node-rename', label: 'Rename…' },
				{ act: 'node-split-graph', label: 'Create graph from this node…' },
				{ act: 'node-delete', label: 'Delete…', danger: true }
			]);
			return;
		}
		var linkHit = pickLink(w.x, w.y);
		if (linkHit) {
			selectedId = '';
			ctxLinkIndex = linkHit.index;
			var L = graph.links[linkHit.index];
			ctxEdgeEndpoints = L.from === L.to ? null : { from: L.from, to: L.to };
			updateSidebar();
			var a = labelFor(L.from);
			var b = labelFor(L.to);
			if (L.from === L.to) {
				openCtxMenu(ev, [
					{ act: 'link-delete', label: 'Delete self-loop', danger: true }
				]);
			} else {
				var hasRev = graph.links.some(function (l) {
					return l.from === L.to && l.to === L.from;
				});
				if (hasRev) {
					openCtxMenu(ev, [
						{ act: 'link-remove-between', which: 'forward', label: 'Remove all ' + a + ' \u2192 ' + b },
						{ act: 'link-remove-between', which: 'reverse', label: 'Remove all ' + b + ' \u2192 ' + a },
						{ act: 'link-remove-between', which: 'both', label: 'Remove both directions', danger: true }
					]);
				} else {
					openCtxMenu(ev, [
						{ act: 'link-delete', label: 'Delete this link (' + a + ' \u2192 ' + b + ')', danger: true },
						{ act: 'link-reverse', label: 'Reverse to (' + b + ' \u2192 ' + a + ')' },
						{ act: 'link-add-reverse', label: 'Add reverse link (' + b + ' \u2192 ' + a + ')' }
					]);
				}
			}
			return;
		}
		selectedId = '';
		linkSourceId = '';
		ctxCanvasWorld = { x: w.x, y: w.y };
		updateSidebar();
		openCtxMenu(ev, [
			{ act: 'canvas-new', label: 'New tag here…' }
		]);
	});

	canvas.addEventListener('mousedown', function (ev) {
		if (ev.button === 0) {
			hideCtxMenu();
			vscode.postMessage({ type: 'tagsPanelUiActivated' });
		}
		if (ev.button !== 0) return;
		mainDownX = ev.clientX;
		mainDownY = ev.clientY;
		mainPointerMoved = false;
		var p = clientXY(ev);
		var w = screenToWorld(p.x, p.y);
		var hit = pickNode(w.x, w.y);
		if (isGroupNodeSelectMode) {
			if (!hit) {
				panning = true;
				panSX = ev.clientX; panSY = ev.clientY;
				panStartX = panX; panStartY = panY;
				wrap.classList.add('stag-panning');
				return;
			}
			var gid = groupManageEl ? String(groupManageEl.value || '') : '';
			if (gid === '__create_new__') {
				if (errEl) errEl.textContent = 'Choose a group before selecting nodes.';
				return;
			}
			vscode.postMessage({
				type: 'assignTagToGroup',
				tagId: hit.id,
				groupId: gid,
				includeChildren: !!(optGroupIncludeChildrenEl && optGroupIncludeChildrenEl.checked)
			});
			selectedId = hit.id;
			updateSidebar();
			return;
		}
		if (isDeleteNodeSelectMode) {
			if (!hit) {
				panning = true;
				panSX = ev.clientX; panSY = ev.clientY;
				panStartX = panX; panStartY = panY;
				wrap.classList.add('stag-panning');
				return;
			}
			toggleDeleteMarkByNodeId(hit.id);
			selectedId = hit.id;
			updateSidebar();
			return;
		}
		if (hit) {
			if (ev.detail === 1) {
				if (!linkSourceId || linkSourceId === hit.id) {
					linkSourceId = hit.id;
				}
			}
			dragNode = hit;
			dragOffX = w.x - hit.x;
			dragOffY = w.y - hit.y;
			selectedId = hit.id;
			wrap.classList.add('stag-drag-node');
			updateSidebar();
		} else {
			selectedId = '';
			linkSourceId = '';
			updateSidebar();
			panning = true;
			panSX = ev.clientX; panSY = ev.clientY;
			panStartX = panX; panStartY = panY;
			wrap.classList.add('stag-panning');
		}
	});

	canvas.addEventListener('dblclick', function (ev) {
		ev.preventDefault();
		var p = clientXY(ev);
		var w = screenToWorld(p.x, p.y);
		var hit = pickNode(w.x, w.y);
		if (!hit) return;
		vscode.postMessage({ type: 'tagsPanelUiActivated' });
		// Another node is "armed" (link source / prior click); double-click completes a link instead of opening sub-tags.
		if (linkSourceId && linkSourceId !== hit.id) {
			vscode.postMessage({
				type: 'addLink',
				fromId: linkSourceId,
				toId: hit.id
			});
			linkSourceId = '';
			selectedId = hit.id;
			updateSidebar();
			return;
		}
		if (ev.shiftKey) {
			selectedId = hit.id;
			updateSidebar();
			return;
		}
		var nSub = childCount(hit.id);
		if (nSub > TAG_SUBGRAPH_POPOVER_MAX) {
			vscode.postMessage({ type: 'openSubGraphEditorWindow', parentTagId: hit.id });
			selectedId = hit.id;
			updateSidebar();
			return;
		}
		toggleSubtagPanel(hit.id);
		selectedId = hit.id;
		updateSidebar();
	});

	function subClientXY(ev) {
		var r = subCanvas.getBoundingClientRect();
		return { x: ev.clientX - r.left, y: ev.clientY - r.top };
	}

	window.addEventListener('mousemove', function (ev) {
		// Detect pointer movement regardless of active drag branch.
		if ((ev.buttons & 1) === 1) {
			if (Math.abs(ev.clientX - mainDownX) + Math.abs(ev.clientY - mainDownY) > 3) mainPointerMoved = true;
			if (Math.abs(ev.clientX - subDownX) + Math.abs(ev.clientY - subDownY) > 3) subPointerMoved = true;
		}
		if (subDragNode && subCanvas) {
			if (Math.abs(ev.clientX - subDownX) + Math.abs(ev.clientY - subDownY) > 3) subPointerMoved = true;
			var ps = subClientXY(ev);
			var ws = subScreenToWorld(ps.x, ps.y);
			subDragNode.x = ws.x - subDragOffX;
			subDragNode.y = ws.y - subDragOffY;
			saveSubGraphLayoutDebounced();
		} else if (subPanning) {
			if (Math.abs(ev.clientX - subDownX) + Math.abs(ev.clientY - subDownY) > 3) subPointerMoved = true;
			subPanX = subPanStartX + (ev.clientX - subPanSX) / subScale;
			subPanY = subPanStartY + (ev.clientY - subPanSY) / subScale;
		} else if (dragNode) {
			if (Math.abs(ev.clientX - mainDownX) + Math.abs(ev.clientY - mainDownY) > 3) mainPointerMoved = true;
			var p = clientXY(ev);
			var w = screenToWorld(p.x, p.y);
			dragNode.x = w.x - dragOffX;
			dragNode.y = w.y - dragOffY;
			saveLayoutDebounced();
		} else if (panning) {
			if (Math.abs(ev.clientX - mainDownX) + Math.abs(ev.clientY - mainDownY) > 3) mainPointerMoved = true;
			panX = panStartX + (ev.clientX - panSX) / scale;
			panY = panStartY + (ev.clientY - panSY) / scale;
		} else {
			var hp = clientXY(ev);
			var hw = screenToWorld(hp.x, hp.y);
			var hnode = pickNode(hw.x, hw.y);
			hoverId = hnode ? hnode.id : '';
		}
	});

	window.addEventListener('mouseup', function () {
		if (dragNode || subDragNode) {
			kickSimulation();
		}
		dragNode = null;
		panning = false;
		subDragNode = null;
		subPanning = false;
		if (wrap) wrap.classList.remove('stag-panning', 'stag-drag-node');
		if (subGraphWrap) subGraphWrap.classList.remove('stag-panning', 'stag-drag-node');
	});
	canvas.addEventListener('mouseleave', function () { hoverId = ''; });

	canvas.addEventListener('wheel', function (ev) {
		ev.preventDefault();
		var p = clientXY(ev);
		var before = screenToWorld(p.x, p.y);
		var factor = ev.deltaY > 0 ? 0.98 : 1.02;
		scale = Math.min(TAG_GRAPH_ZOOM_MAX, Math.max(TAG_GRAPH_ZOOM_MIN, scale * factor));
		var after = screenToWorld(p.x, p.y);
		panX += before.x - after.x;
		panY += before.y - after.y;
	}, { passive: false });

	if (subCanvas && subGraphWrap && subCtx) {
		subCanvas.addEventListener('contextmenu', function (ev) {
			ev.preventDefault();
			ev.stopPropagation();
			vscode.postMessage({ type: 'tagsPanelUiActivated' });
			var ps = subClientXY(ev);
			var w = subScreenToWorld(ps.x, ps.y);
			subCtxLinkIndex = -1;
			subCtxEdgeEndpoints = null;
			subCtxCanvasWorld = null;
			var nodeHit = subPickNode(w.x, w.y);
			if (nodeHit) {
				subSelectedId = nodeHit.id;
				var flyNodeItems = [];
				if (subLinkSourceId && subLinkSourceId !== nodeHit.id) {
					flyNodeItems.push({ act: 'sub-link-from-armed', label: 'Complete link → this node' });
				}
				flyNodeItems.push({ act: 'sub-node-arm-link', label: 'Arm as link source' });
				if (nodeHit.isParentAnchor) {
					flyNodeItems.push({ act: 'sub-node-rename', label: 'Rename…' });
				} else {
					flyNodeItems.push({ act: 'sub-node-rename', label: 'Rename…' });
					flyNodeItems.push({ act: 'sub-node-delete', label: 'Delete…', danger: true });
				}
				openSubCtxMenu(ev, flyNodeItems);
				return;
			}
			var focus = openSubtagPanelId;
			var linkHit = subPickLink(w.x, w.y);
			if (linkHit && focus) {
				subSelectedId = '';
				subCtxLinkIndex = linkHit.index;
				var L = graph.links[linkHit.index];
				subCtxEdgeEndpoints = L.from === L.to ? null : { from: L.from, to: L.to };
				var a = subLabelFor(L.from);
				var b = subLabelFor(L.to);
				if (L.from === L.to) {
					openSubCtxMenu(ev, [{ act: 'sub-link-delete', label: 'Delete self-loop', danger: true }]);
				} else {
					var hasRev = graph.links.some(function (l) {
						if (!isSubFocusLink(l, focus)) return false;
						return l.from === L.to && l.to === L.from;
					});
					if (hasRev) {
						openSubCtxMenu(ev, [
							{ act: 'sub-link-remove-between', which: 'forward', label: 'Remove all ' + a + ' \u2192 ' + b },
							{ act: 'sub-link-remove-between', which: 'reverse', label: 'Remove all ' + b + ' \u2192 ' + a },
							{ act: 'sub-link-remove-between', which: 'both', label: 'Remove both directions', danger: true }
						]);
					} else {
						openSubCtxMenu(ev, [
							{ act: 'sub-link-delete', label: 'Delete link (' + a + ' \u2192 ' + b + ')', danger: true },
							{ act: 'sub-link-reverse', label: 'Reverse' },
							{ act: 'sub-link-add-reverse', label: 'Add reverse' }
						]);
					}
				}
				return;
			}
			subSelectedId = '';
			subLinkSourceId = '';
			subCtxCanvasWorld = { x: w.x, y: w.y };
			openSubCtxMenu(ev, [{ act: 'sub-canvas-new', label: 'New sub-tag here…' }]);
		});

		subCanvas.addEventListener('mousedown', function (ev) {
			if (ev.button === 0) hideSubCtxMenu();
			if (ev.button !== 0) return;
			ev.stopPropagation();
			vscode.postMessage({ type: 'tagsPanelUiActivated' });
			subDownX = ev.clientX;
			subDownY = ev.clientY;
			subPointerMoved = false;
			var ps = subClientXY(ev);
			var w = subScreenToWorld(ps.x, ps.y);
			var hit = subPickNode(w.x, w.y);
			if (isGroupNodeSelectMode) {
				if (!hit) {
					subPanning = true;
					subPanSX = ev.clientX;
					subPanSY = ev.clientY;
					subPanStartX = subPanX;
					subPanStartY = subPanY;
					subGraphWrap.classList.add('stag-panning');
					return;
				}
				var gidSel = groupManageEl ? String(groupManageEl.value || '') : '';
				if (gidSel === '__create_new__') {
					if (errEl) errEl.textContent = 'Choose a group before selecting nodes.';
					return;
				}
				vscode.postMessage({
					type: 'assignTagToGroup',
					tagId: hit.id,
					groupId: gidSel,
					includeChildren: !!(optGroupIncludeChildrenEl && optGroupIncludeChildrenEl.checked)
				});
				subSelectedId = hit.id;
				selectedId = hit.id;
				updateSidebar();
				return;
			}
			if (isDeleteNodeSelectMode) {
				if (!hit) {
					subPanning = true;
					subPanSX = ev.clientX;
					subPanSY = ev.clientY;
					subPanStartX = subPanX;
					subPanStartY = subPanY;
					subGraphWrap.classList.add('stag-panning');
					return;
				}
				toggleDeleteMarkByNodeId(hit.id);
				subSelectedId = hit.id;
				selectedId = hit.id;
				updateSidebar();
				return;
			}
			if (hit) {
				if (ev.detail === 1) {
					if (!subLinkSourceId || subLinkSourceId === hit.id) {
						subLinkSourceId = hit.id;
					}
				}
				subDragNode = hit;
				subDragOffX = w.x - hit.x;
				subDragOffY = w.y - hit.y;
				subSelectedId = hit.id;
				subGraphWrap.classList.add('stag-drag-node');
			} else {
				subSelectedId = '';
				subLinkSourceId = '';
				subPanning = true;
				subPanSX = ev.clientX;
				subPanSY = ev.clientY;
				subPanStartX = subPanX;
				subPanStartY = subPanY;
				subGraphWrap.classList.add('stag-panning');
			}
		});

		// Stop selection mode only on an actual empty click (not drag/pan).
		subCanvas.addEventListener('click', function (ev) {
			if (!isGroupNodeSelectMode) return;
			if (subPointerMoved) {
				subPointerMoved = false;
				return;
			}
			var ps = subClientXY(ev);
			var w = subScreenToWorld(ps.x, ps.y);
			var hit = subPickNode(w.x, w.y);
			if (!hit) setGroupNodeSelectMode(false);
		});

		subCanvas.addEventListener('dblclick', function (ev) {
			ev.preventDefault();
			ev.stopPropagation();
			var ps = subClientXY(ev);
			var w = subScreenToWorld(ps.x, ps.y);
			var hit = subPickNode(w.x, w.y);
			if (!hit) return;
			vscode.postMessage({ type: 'tagsPanelUiActivated' });
			if (subLinkSourceId && subLinkSourceId !== hit.id && openSubtagPanelId) {
				vscode.postMessage({
					type: 'addSubGraphLink',
					parentTagId: openSubtagPanelId,
					fromId: subLinkSourceId,
					toId: hit.id
				});
				subLinkSourceId = '';
				subSelectedId = hit.id;
				return;
			}
			var nChild = childCount(hit.id);
			if (nChild > TAG_SUBGRAPH_POPOVER_MAX) {
				vscode.postMessage({ type: 'openSubGraphEditorWindow', parentTagId: hit.id });
				subSelectedId = hit.id;
				return;
			}
			if (nChild > 0) {
				showSubtagPanel(hit.id);
				subSelectedId = hit.id;
				return;
			}
			subSelectedId = hit.id;
		});

		subCanvas.addEventListener('wheel', function (ev) {
			ev.preventDefault();
			ev.stopPropagation();
			var ps = subClientXY(ev);
			var before = subScreenToWorld(ps.x, ps.y);
			var factor = ev.deltaY > 0 ? 0.98 : 1.02;
			subScale = Math.min(2.5, Math.max(0.35, subScale * factor));
			var after = subScreenToWorld(ps.x, ps.y);
			subPanX += before.x - after.x;
			subPanY += before.y - after.y;
		}, { passive: false });
	}

	if (subCtxMenuEl) {
		subCtxMenuEl.addEventListener('click', function (ev) {
			var btn = ev.target.closest('button');
			if (!btn || !subCtxMenuEl.contains(btn)) return;
			var act = btn.getAttribute('data-act');
			var savedIdx = subCtxLinkIndex;
			var savedEdge = subCtxEdgeEndpoints;
			var removeWhich = btn.getAttribute('data-which');
			var savedWorld = subCtxCanvasWorld;
			hideSubCtxMenu();
			if (act === 'sub-link-from-armed' && openSubtagPanelId && subSelectedId && subLinkSourceId && subLinkSourceId !== subSelectedId) {
				vscode.postMessage({
					type: 'addSubGraphLink',
					parentTagId: openSubtagPanelId,
					fromId: subLinkSourceId,
					toId: subSelectedId
				});
				subLinkSourceId = '';
			} else if (act === 'sub-node-arm-link' && subSelectedId) {
				subLinkSourceId = subSelectedId;
			} else if (act === 'sub-node-rename' && openSubtagPanelId && subSelectedId) {
				var rn = subNodes.find(function (x) { return x.id === subSelectedId; });
				if (rn) showSubFlyRename(rn);
			} else if (act === 'sub-node-delete' && openSubtagPanelId && subSelectedId) {
				var dn = subNodes.find(function (x) { return x.id === subSelectedId; });
				if (dn && !dn.isParentAnchor) {
					vscode.postMessage({
						type: 'requestRemoveSubGraphTagDialog',
						parentTagId: openSubtagPanelId,
						subTagId: subSelectedId
					});
				}
			} else if (act === 'sub-link-delete' && openSubtagPanelId && savedIdx >= 0) {
				vscode.postMessage({
					type: 'removeSubGraphLink',
					parentTagId: openSubtagPanelId,
					index: savedIdx
				});
			} else if (act === 'sub-link-reverse' && openSubtagPanelId && savedIdx >= 0) {
				vscode.postMessage({
					type: 'reverseSubGraphLinkAtIndex',
					parentTagId: openSubtagPanelId,
					index: savedIdx
				});
			} else if (act === 'sub-link-add-reverse' && openSubtagPanelId && savedIdx >= 0) {
				var Lk = graph.links[savedIdx];
				if (Lk) {
					vscode.postMessage({
						type: 'addSubGraphLink',
						parentTagId: openSubtagPanelId,
						fromId: Lk.to,
						toId: Lk.from
					});
				}
			} else if (act === 'sub-link-remove-between' && openSubtagPanelId && savedEdge && removeWhich) {
				vscode.postMessage({
					type: 'removeSubGraphLinksBetween',
					parentTagId: openSubtagPanelId,
					fromId: savedEdge.from,
					toId: savedEdge.to,
					which: removeWhich
				});
			} else if (act === 'sub-canvas-new' && openSubtagPanelId && savedWorld) {
				vscode.postMessage({
					type: 'addSubGraphTag',
					parentTagId: openSubtagPanelId,
					label: 'untitled',
					x: savedWorld.x,
					y: savedWorld.y
				});
			}
		});
	}

	function submitNewTagFromSidebar() {
		if (!newLabelEl) return;
		var t = (newLabelEl.value || '').trim();
		if (!t) return;
		vscode.postMessage({ type: 'addTag', label: t });
		newLabelEl.value = '';
	}
	var btnAdd = document.getElementById('stag-btn-add');
	if (btnAdd) btnAdd.addEventListener('click', submitNewTagFromSidebar);

	// Stop selection mode only on an actual empty click (not drag/pan).
	canvas.addEventListener('click', function (ev) {
		if (!isGroupNodeSelectMode) return;
		if (mainPointerMoved) {
			mainPointerMoved = false;
			return;
		}
		var p = clientXY(ev);
		var w = screenToWorld(p.x, p.y);
		var hit = pickNode(w.x, w.y);
		if (!hit) setGroupNodeSelectMode(false);
	});
	if (optShowGroupsEl) optShowGroupsEl.addEventListener('change', function () {
		updateGroupsUi();
		updateSidebar();
		kickSimulation();
	});
	if (groupManageEl) groupManageEl.addEventListener('change', function () {
		var selectedGroupId = String(groupManageEl.value || '');
		if (selectedGroupId === '__create_new__') {
			setGroupEditorMode('create', '');
			return;
		}
		// Apply directly to the currently selected node (and optionally full descendant hierarchy)
		// so users can assign from dropdown without entering select-nodes mode.
		var targetId = activeGroupAssignmentTargetId();
		if (targetId && selectedGroupId !== '__create_new__') {
			vscode.postMessage({
				type: 'assignTagToGroup',
				tagId: targetId,
				groupId: selectedGroupId,
				includeChildren: !!(optGroupIncludeChildrenEl && optGroupIncludeChildrenEl.checked)
			});
		} else if (selectedGroupId === '__create_new__') {
			// handled above
		}
		setGroupEditorMode('', '');
		updateGroupsUi();
	});
	if (btnRenameGroupEl) btnRenameGroupEl.addEventListener('click', function () {
		if (!groupManageEl) return;
		var gid = String(groupManageEl.value || '');
		if (!gid || gid === '__create_new__') return;
		setGroupEditorMode('rename', gid);
	});
	if (btnDeleteGroupEl) btnDeleteGroupEl.addEventListener('click', function () {
		if (!groupManageEl) return;
		var gid = String(groupManageEl.value || '');
		if (!gid) return;
		vscode.postMessage({ type: 'removeTagGroup', groupId: gid });
	});
	if (btnGroupEditorCancelEl) btnGroupEditorCancelEl.addEventListener('click', function () {
		setGroupEditorMode('', '');
		if (groupManageEl && String(groupManageEl.value || '') === '__create_new__') {
			groupManageEl.value = '';
			updateGroupsUi();
		}
	});
	if (btnGroupEditorSaveEl) btnGroupEditorSaveEl.addEventListener('click', function () {
		var name = groupEditorNameEl ? String(groupEditorNameEl.value || '').trim() : '';
		var color = groupEditorColorEl ? String(groupEditorColorEl.value || '').trim() : '';
		if (!name || !color) return;
		var groups = Array.isArray(graph.groups) ? graph.groups : [];
		var lowered = name.toLowerCase();
		for (var i = 0; i < groups.length; i++) {
			var gid = String(groups[i].id || '');
			if (groupEditorMode === 'rename' && gid === groupEditorTargetId) continue;
			if (String(groups[i].name || '').trim().toLowerCase() === lowered) {
				if (errEl) errEl.textContent = 'Group name already exists. Choose a unique name.';
				return;
			}
		}
		if (groupEditorMode === 'create') {
			vscode.postMessage({ type: 'addTagGroup', name: name, color: color });
		} else if (groupEditorMode === 'rename' && groupEditorTargetId) {
			vscode.postMessage({
				type: 'renameTagGroup',
				groupId: groupEditorTargetId,
				name: name,
				color: color
			});
		}
		setGroupEditorMode('', '');
	});
	if (groupEditorNameEl) groupEditorNameEl.addEventListener('keydown', function (ev) {
		if (ev.key === 'Enter') {
			ev.preventDefault();
			if (btnGroupEditorSaveEl) btnGroupEditorSaveEl.click();
		} else if (ev.key === 'Escape') {
			ev.preventDefault();
			if (btnGroupEditorCancelEl) btnGroupEditorCancelEl.click();
		}
	});
	if (btnSelectGroupNodesEl) btnSelectGroupNodesEl.addEventListener('click', function () {
		setGroupNodeSelectMode(!isGroupNodeSelectMode);
	});
	if (newLabelEl) newLabelEl.addEventListener('keydown', function (ev) {
		if (ev.key === 'Enter') {
			ev.preventDefault();
			submitNewTagFromSidebar();
		}
	});
	var btnLink = document.getElementById('stag-btn-link');
	if (btnLink) btnLink.addEventListener('click', function () {
		var a = selFromEl.value, b = selToEl.value;
		if (!a || !b) return;
		vscode.postMessage({
			type: 'addLink',
			fromId: a,
			toId: b
		});
	});
	if (ctxMenuEl) ctxMenuEl.addEventListener('click', function (ev) {
		var btn = ev.target.closest('button');
		if (!btn || !ctxMenuEl.contains(btn)) return;
		var act = btn.getAttribute('data-act');
		var savedLinkIdx = ctxLinkIndex;
		var savedCanvas = ctxCanvasWorld;
		var savedEdge = ctxEdgeEndpoints;
		var removeWhich = btn.getAttribute('data-which');
		hideCtxMenu();
		if (act === 'node-rename') {
			if (selectedId && tagById(selectedId)) showInlineRename();
		} else if (act === 'node-split-graph') {
			if (selectedId && tagById(selectedId)) {
				vscode.postMessage({ type: 'createGraphFromNodePrompt', nodeId: selectedId });
			}
		} else if (act === 'node-delete') {
			if (selectedId && tagById(selectedId)) {
				vscode.postMessage({ type: 'requestRemoveTagDialog', id: selectedId });
			}
		} else if (act === 'link-delete') {
			if (savedLinkIdx >= 0) vscode.postMessage({ type: 'removeLink', index: savedLinkIdx });
		} else if (act === 'link-reverse') {
			if (savedLinkIdx >= 0) vscode.postMessage({ type: 'reverseLinkAtIndex', index: savedLinkIdx });
		} else if (act === 'link-add-reverse') {
			if (savedLinkIdx >= 0) {
				var Lk = graph.links[savedLinkIdx];
				if (Lk) {
					vscode.postMessage({
						type: 'addLink',
						fromId: Lk.to,
						toId: Lk.from
					});
				}
			}
		} else if (act === 'link-remove-between') {
			if (savedEdge && removeWhich) {
				vscode.postMessage({
					type: 'removeLinksBetween',
					fromId: savedEdge.from,
					toId: savedEdge.to,
					which: removeWhich
				});
			}
		} else if (act === 'canvas-new') {
			if (savedCanvas) {
				vscode.postMessage({
					type: 'addTagAtPosition',
					x: savedCanvas.x,
					y: savedCanvas.y,
					label: 'untitled'
				});
			}
		}
	});
	var btnReset = document.getElementById('stag-btn-reset-view');
	if (btnReset) btnReset.addEventListener('click', function () {
		scale = 1; panX = 0; panY = 0;
	});
	if (btnDeleteModeEl) btnDeleteModeEl.addEventListener('click', function () {
		setDeleteNodeSelectMode(true);
	});
	if (btnDeleteCancelEl) btnDeleteCancelEl.addEventListener('click', function () {
		setDeleteNodeSelectMode(false);
	});
	if (btnDeleteConfirmEl) btnDeleteConfirmEl.addEventListener('click', function () {
		var ids = Object.keys(pendingDeleteIdSet);
		if (!ids.length) {
			setDeleteNodeSelectMode(false);
			return;
		}
		vscode.postMessage({ type: 'requestRemoveTagsDialog', ids: ids });
		setDeleteNodeSelectMode(false);
	});
	// Ensure startup UI is always collapsed to a single "Delete nodes" button.
	setDeleteNodeSelectMode(false);
	function readGraphOptsFromUi() {
		graphOpts.rigid = !!(optRigidEl && optRigidEl.checked);
		graphOpts.showOrphans = !(optShowOrphansEl && !optShowOrphansEl.checked);
		graphOpts.showArrows = !(optShowArrowsEl && !optShowArrowsEl.checked);
		graphOpts.forceCenter = optCenterEl ? Number(optCenterEl.value || 0.03) : 0.03;
		graphOpts.forceRepel = optRepelEl ? Number(optRepelEl.value || 10) : 10;
		graphOpts.forceLink = optLinkEl ? Number(optLinkEl.value || 0.75) : 0.75;
		graphOpts.linkDistance = optLinkDistanceEl ? Number(optLinkDistanceEl.value || 80) : 80;
		graphOpts.nodeSize = optNodeSizeEl ? Number(optNodeSizeEl.value || 8) : 8;
		graphOpts.edgeThickness = optEdgeThicknessEl ? Number(optEdgeThicknessEl.value || 1.50) : 1.50;
		graphOpts.textFadeThreshold = optTextFadeEl ? Number(optTextFadeEl.value || -2.5) : -2.5;
		if (optCenterValEl) optCenterValEl.textContent = graphOpts.forceCenter.toFixed(2);
		if (optRepelValEl) optRepelValEl.textContent = graphOpts.forceRepel.toFixed(2);
		if (optLinkValEl) optLinkValEl.textContent = graphOpts.forceLink.toFixed(2);
		if (optLinkDistanceValEl) optLinkDistanceValEl.textContent = String(Math.round(graphOpts.linkDistance));
		if (optNodeSizeValEl) optNodeSizeValEl.textContent = graphOpts.nodeSize.toFixed(1);
		if (optEdgeThicknessValEl) optEdgeThicknessValEl.textContent = graphOpts.edgeThickness.toFixed(2);
		if (optTextFadeValEl) optTextFadeValEl.textContent = graphOpts.textFadeThreshold.toFixed(1);
		syncNodesFromGraph();
		kickSimulation();
	}
	if (optRigidEl) optRigidEl.addEventListener('change', readGraphOptsFromUi);
	if (optShowOrphansEl) optShowOrphansEl.addEventListener('change', readGraphOptsFromUi);
	if (optShowArrowsEl) optShowArrowsEl.addEventListener('change', readGraphOptsFromUi);
	if (optCenterEl) optCenterEl.addEventListener('input', readGraphOptsFromUi);
	if (optRepelEl) optRepelEl.addEventListener('input', readGraphOptsFromUi);
	if (optLinkEl) optLinkEl.addEventListener('input', readGraphOptsFromUi);
	if (optLinkDistanceEl) optLinkDistanceEl.addEventListener('input', readGraphOptsFromUi);
	if (optNodeSizeEl) optNodeSizeEl.addEventListener('input', readGraphOptsFromUi);
	if (optEdgeThicknessEl) optEdgeThicknessEl.addEventListener('input', readGraphOptsFromUi);
	if (optTextFadeEl) optTextFadeEl.addEventListener('input', readGraphOptsFromUi);
	readGraphOptsFromUi();
	if (btnToggleSettings && settingsWrapEl) {
		btnToggleSettings.addEventListener('click', function () {
			settingsWrapEl.hidden = !settingsWrapEl.hidden;
			btnToggleSettings.textContent = settingsWrapEl.hidden ? 'Graph settings' : 'Hide graph settings';
		});
	}
	if (graphSelectEl) {
		graphSelectEl.addEventListener('change', function () {
			if (syncingGraphSelect) return;
			var v = graphSelectEl.value;
			if (v === '__new__') {
				syncingGraphSelect = true;
				graphSelectEl.value = lastActiveGraphId;
				syncingGraphSelect = false;
				vscode.postMessage({ type: 'requestNewTagGraph' });
				return;
			}
			if (v === '__import__') {
				syncingGraphSelect = true;
				graphSelectEl.value = lastActiveGraphId;
				syncingGraphSelect = false;
				vscode.postMessage({ type: 'requestImportTagGraph' });
				return;
			}
			if (v === lastActiveGraphId) return;
			if (graphNameEl) {
				var selectedOpt = graphSelectEl.options[graphSelectEl.selectedIndex];
				graphNameEl.value = selectedOpt ? selectedOpt.textContent : '';
			}
			vscode.postMessage({ type: 'activateTagGraph', graphId: v });
		});
	}
	if (btnRenameGraph) btnRenameGraph.addEventListener('click', function () {
		if (!lastActiveGraphId) return;
		if (!isRenamingGraph) {
			var currentName = '';
			if (graphSelectEl) {
				var currentOpt = graphSelectEl.options[graphSelectEl.selectedIndex];
				currentName = currentOpt ? currentOpt.textContent : '';
			}
			if (graphNameEl) graphNameEl.value = currentName;
			setGraphRenameMode(true);
			return;
		}
		var nextName = graphNameEl ? String(graphNameEl.value || '').trim() : '';
		vscode.postMessage({ type: 'renameActiveTagGraph', graphId: lastActiveGraphId, newName: nextName });
	});
	if (graphNameEl) {
		graphNameEl.addEventListener('keydown', function (ev) {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				if (btnRenameGraph) btnRenameGraph.click();
				return;
			}
			if (ev.key === 'Escape') {
				ev.preventDefault();
				setGraphRenameMode(false);
			}
		});
	}
	if (btnDeleteGraph) btnDeleteGraph.addEventListener('click', function () {
		if (!lastActiveGraphId) return;
		vscode.postMessage({ type: 'deleteTagGraph', graphId: lastActiveGraphId });
	});
	if (btnCombineGraph) btnCombineGraph.addEventListener('click', function () {
		setCombineMode(true);
	});
	if (btnCombineAddEl) btnCombineAddEl.addEventListener('click', function () {
		var active = '';
		for (var i = 0; i < storedGraphsCache.length; i++) {
			var id = String(storedGraphsCache[i].id || '');
			if (combineSourceIds.indexOf(id) < 0) { active = id; break; }
		}
		if (!active) active = String(lastActiveGraphId || '');
		if (active) combineSourceIds.push(active);
		combineSourceIds = ensureUniqueCombineSourceIds(combineSourceIds);
		renderCombineList();
		requestCombinePreview();
	});
	if (btnCombineCancelEl) btnCombineCancelEl.addEventListener('click', function () {
		setCombineMode(false);
	});
	if (btnCombineCreateEl) btnCombineCreateEl.addEventListener('click', function () {
		var name = graphNameEl ? String(graphNameEl.value || '').trim() : '';
		if (!name) name = 'Combined graph';
		var ids = ensureUniqueCombineSourceIds(combineSourceIds);
		if (ids.length < 2) {
			if (errEl) errEl.textContent = 'Select at least two graphs to combine.';
			return;
		}
		vscode.postMessage({ type: 'createCombinedGraph', name: name, sourceGraphIds: ids });
		setCombineMode(false);
	});
	if (graphNameEl) graphNameEl.addEventListener('input', function () {
		if (!isCombineMode) return;
		requestCombinePreview();
	});
	var btnExportGraph = document.getElementById('stag-btn-export-graph');
	if (btnExportGraph) btnExportGraph.addEventListener('click', function () {
		vscode.postMessage({ type: 'exportTagGraph' });
	});

	var vmS = document.getElementById('vm-storage');
	var vmT = document.getElementById('vm-tags');
	if (vmS) vmS.addEventListener('click', function () { setViewMode('storage'); });
	if (vmT) vmT.addEventListener('click', function () { setViewMode('tags'); vscode.postMessage({ type: 'requestTagGraph' }); });

	if (subTagClose) {
		subTagClose.addEventListener('click', function () {
			hideSubtagPanel();
			updateSidebar();
		});
	}
	if (subTagAdd) {
		subTagAdd.addEventListener('click', function () {
			if (!openSubtagPanelId) return;
			var lab = subTagNew ? String(subTagNew.value || '').trim() : '';
			if (!lab) return;
			vscode.postMessage({
				type: 'addSubGraphTag',
				parentTagId: openSubtagPanelId,
				label: lab
			});
			if (subTagNew) subTagNew.value = '';
		});
	}
	if (subTagNew) {
		subTagNew.addEventListener('keydown', function (ev) {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				if (subTagAdd) subTagAdd.click();
			}
		});
	}

	window.addEventListener('resize', function () {
		resizeCanvas();
		if (openSubtagPanelId) resizeSubCanvas();
	});

	resizeCanvas();
	loop();
})();`;
}

module.exports = getTagsGraphEmbedRuntime;
