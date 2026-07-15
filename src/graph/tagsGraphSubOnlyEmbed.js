'use strict';

/**
 * Client script for standalone sub-graph editor panel (many sub-tags).
 * Same interactions as the flyout mini graph; receives full graph via tagGraphState + subGraphEditorParentId.
 */
function getTagsGraphSubOnlyRuntime() {
	return `(function () {
	var vscode = window.__dripVscodeApi;
	if (!vscode) return;
	var subGraphWrap = document.getElementById('stag-subgraph-wrap');
	var subCanvas = document.getElementById('stag-subgraph');
	var subCtx = subCanvas && subCanvas.getContext ? subCanvas.getContext('2d') : null;
	var subCtxMenuEl = document.getElementById('stag-sub-ctx-menu');
	var errEl = document.getElementById('stag-err');
	var subTagNew = document.getElementById('stag-subtag-new');
	var subTagAdd = document.getElementById('stag-subtag-add');
	if (!subGraphWrap || !subCanvas || !subCtx) return;

	var graph = { version: 2, nodes: [], links: [] };
	var openSubtagPanelId = '';
	var lockedSubGraphParentId = '';
	var subShiftHeld = false;
	var subNodes = [];
	var subScale = 1;
	var subPanX = 0, subPanY = 0;
	var subDragNode = null;
	var subDragOffX = 0, subDragOffY = 0;
	var subPanning = false, subPanSX = 0, subPanSY = 0, subPanStartX = 0, subPanStartY = 0;
	var subSelectedId = '';
	var subLinkSourceId = '';
	var subCtxLinkIndex = -1;
	var subCtxEdgeEndpoints = null;
	var subCtxCanvasWorld = null;
	var SUB_NODE_R = 10;
	var SUBGRAPH_NODE_LABEL_PX_AT_MAX_ZOOM = 24;
	var running = true;
	var canvasFontFamily = '';

	var subInlineRenameWrap = null;
	var subInlineRenameInput = null;
	var subInlineRenameSubId = '';
	var subInlineRenameIsParent = false;
	var subInlineRenameOriginal = '';

	function nodeById(id) {
		for (var i = 0; i < graph.nodes.length; i++) {
			if (graph.nodes[i].id === id) return graph.nodes[i];
		}
		return null;
	}
	function tagById(id) { return nodeById(id); }
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
	function childCount(parentId) {
		var c = 0;
		for (var i = 0; i < graph.nodes.length; i++) {
			if (graph.nodes[i].parentId === parentId) c++;
		}
		return c;
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
		drawArrowHeadOn(c, sx, sy, ex, ey, 8 / sc);
	}

	function drawSelfLoopOn(c, sc, nodeR, nx, ny, offset) {
		var loopR = 14 + offset * 5;
		var cx = nx + nodeR + loopR * 0.62;
		var cy = ny;
		c.beginPath();
		c.arc(cx, cy, loopR, Math.PI * 0.65, Math.PI * 1.85);
		c.stroke();
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
		var next = [{ id: t.id, label: t.label, x: px, y: py, isParentAnchor: true }];
		var children = [];
		for (var j = 0; j < graph.nodes.length; j++) {
			if (graph.nodes[j].parentId === focus) children.push(graph.nodes[j]);
		}
		var total = children.length;
		for (var k = 0; k < total; k++) {
			var tg = children[k];
			var old = map[tg.id];
			var x, y;
			if (typeof tg.x === 'number' && Number.isFinite(tg.x)) x = tg.x;
			else if (old) x = old.x;
			else x = Math.cos(k) * 55;
			if (typeof tg.y === 'number' && Number.isFinite(tg.y)) y = tg.y;
			else if (old) y = old.y;
			else y = Math.sin(k) * 55;
			next.push({ id: tg.id, label: tg.label, x: x, y: y, isParentAnchor: false });
		}
		subNodes = next;
	}

	function resizeSubCanvas() {
		var dpr = window.devicePixelRatio || 1;
		var w = subGraphWrap.clientWidth || 400;
		var h = subGraphWrap.clientHeight || 320;
		subCanvas.width = Math.floor(w * dpr);
		subCanvas.height = Math.floor(h * dpr);
		subCanvas.style.width = w + 'px';
		subCanvas.style.height = h + 'px';
		subCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	function getCanvasFontFamily() {
		if (canvasFontFamily) return canvasFontFamily;
		var cssFamily = (getComputedStyle(document.body).getPropertyValue('--vscode-font-family') || '').trim();
		canvasFontFamily = cssFamily || 'sans-serif';
		return canvasFontFamily;
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
				if (d < bestD) { bestD = d; bestLi = li; }
			} else {
				d = distPointToSegment(wx, wy, g.sx, g.sy, g.ex, g.ey);
				if (d < bestD) { bestD = d; bestLi = li; }
			}
		}
		var L0 = bestLi >= 0 ? graph.links[bestLi] : null;
		var thrEff = L0 && L0.from === L0.to ? thr * 2 : thr;
		if (bestLi < 0 || bestD > thrEff) return null;
		return { index: bestLi };
	}

	function drawSubGraph() {
		var focus = openSubtagPanelId;
		if (!focus || !subCtx) return;
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
			c.beginPath();
			c.arc(n.x, n.y, SUB_NODE_R, 0, Math.PI * 2);
			var isP = n.isParentAnchor === true;
			c.fillStyle = n.id === subSelectedId ? accent : (isP ? getComputedStyle(document.body).getPropertyValue('--vscode-inputOption-activeBackground') || '#3c3c3c' : getComputedStyle(document.body).getPropertyValue('--vscode-button-secondaryBackground') || '#3c3c3c');
			c.fill();
			c.strokeStyle = n.id === subSelectedId ? accent : (isP ? parentAccent : fg);
			c.lineWidth = (n.id === subSelectedId ? 2.2 : isP ? 1.8 : 1) / subScale;
			c.stroke();
			c.fillStyle = fg;
			c.font = (SUBGRAPH_NODE_LABEL_PX_AT_MAX_ZOOM / 2.5) + 'px ' + getCanvasFontFamily();
			c.textAlign = 'center';
			c.textBaseline = 'top';
			var text = (n.label || '').length > 22 ? n.label.slice(0, 20) + '...' : n.label;
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

	function isSubInlineRenameOpen() {
		return subInlineRenameWrap && !subInlineRenameWrap.hidden;
	}

	function removeSubInlineRename() {
		if (subInlineRenameInput) subInlineRenameInput.removeEventListener('keydown', subInlineRenameKeydown);
		if (subInlineRenameWrap) {
			subInlineRenameWrap.hidden = true;
			subInlineRenameWrap.style.display = 'none';
		}
		subInlineRenameSubId = '';
		subInlineRenameIsParent = false;
		subInlineRenameOriginal = '';
	}

	function subInlineRenameKeydown(ev) {
		if (ev.key === 'Enter') {
			ev.preventDefault();
			commitSubInlineRename();
		} else if (ev.key === 'Escape') {
			ev.preventDefault();
			removeSubInlineRename();
		}
	}

	function commitSubInlineRename() {
		if (!subInlineRenameSubId || !subInlineRenameInput) return;
		var v = String(subInlineRenameInput.value || '').trim();
		var sid = subInlineRenameSubId;
		var orig = subInlineRenameOriginal;
		removeSubInlineRename();
		if (!v || v === orig) return;
		vscode.postMessage({ type: 'renameTag', id: sid, label: v });
	}

	function showSubInlineRename(node) {
		if (!node || !subGraphWrap) return;
		if (subInlineRenameInput) subInlineRenameInput.removeEventListener('keydown', subInlineRenameKeydown);
		if (!subInlineRenameWrap) {
			subInlineRenameWrap = document.createElement('div');
			subInlineRenameWrap.id = 'stag-sub-inline-rename-wrap';
			subInlineRenameWrap.setAttribute('role', 'dialog');
			subInlineRenameWrap.style.cssText = 'position:fixed;z-index:100000;display:none;box-sizing:border-box;padding:4px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-focusBorder);border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.25);';
			subInlineRenameInput = document.createElement('input');
			subInlineRenameInput.type = 'text';
			subInlineRenameInput.setAttribute('autocomplete', 'off');
			subInlineRenameInput.style.cssText = 'width:100%;box-sizing:border-box;margin:0;border:1px solid var(--vscode-input-border);border-radius:3px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:5px 8px;font-size:12px;font-family:var(--vscode-font-family);';
			subInlineRenameWrap.appendChild(subInlineRenameInput);
			document.body.appendChild(subInlineRenameWrap);
		}
		subInlineRenameSubId = node.id;
		subInlineRenameIsParent = node.isParentAnchor === true;
		subInlineRenameOriginal = node.label || '';
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
		subInlineRenameWrap.style.width = iw + 'px';
		subInlineRenameWrap.style.left = left + 'px';
		subInlineRenameWrap.style.top = top + 'px';
		subInlineRenameWrap.hidden = false;
		subInlineRenameWrap.style.display = 'block';
		subInlineRenameInput.value = subInlineRenameOriginal;
		subInlineRenameInput.addEventListener('keydown', subInlineRenameKeydown);
		subInlineRenameInput.focus();
		subInlineRenameInput.select();
	}

	function applyGraph(g, meta) {
		if (g && g.version >= 2 && Array.isArray(g.nodes)) {
			graph = { version: g.version, nodes: g.nodes, links: g.links || [] };
		} else {
			graph = { version: 2, nodes: [], links: [] };
		}
		if (meta && meta.subGraphEditorParentId) {
			lockedSubGraphParentId = String(meta.subGraphEditorParentId);
		}
		openSubtagPanelId = lockedSubGraphParentId;
		if (openSubtagPanelId && !tagById(openSubtagPanelId)) {
			openSubtagPanelId = '';
			lockedSubGraphParentId = '';
			subNodes = [];
			if (errEl) errEl.textContent = 'Parent tag was removed. You can close this panel.';
		} else if (openSubtagPanelId) {
			syncSubNodesFromGraph();
			if (subSelectedId && !subNodes.some(function (n) { return n.id === subSelectedId; })) subSelectedId = '';
			if (subLinkSourceId && !subNodes.some(function (n) { return n.id === subLinkSourceId; })) subLinkSourceId = '';
			resizeSubCanvas();
			if (errEl) errEl.textContent = '';
		}
	}

	function loop() {
		if (!running) return;
		drawSubGraph();
		requestAnimationFrame(loop);
	}

	function subClientXY(ev) {
		var r = subCanvas.getBoundingClientRect();
		return { x: ev.clientX - r.left, y: ev.clientY - r.top };
	}

	window.addEventListener('message', function (event) {
		var m = event.data;
		if (m.type === 'tagGraphState') {
			var meta = {};
			if (m.subGraphEditorParentId) meta.subGraphEditorParentId = m.subGraphEditorParentId;
			applyGraph(m.graph, meta);
		}
		if (m.type === 'tagGraphError' && errEl) errEl.textContent = m.message || 'Error';
	});

	function isTypingTarget(el) {
		if (!el) return false;
		var tag = (el.tagName || '').toLowerCase();
		if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
		if (el.isContentEditable) return true;
		return false;
	}

	window.addEventListener('keydown', function (ev) {
		// Ctrl+Z / Ctrl+Y for graph undo/redo (don't steal from text inputs).
		if (isTypingTarget(document.activeElement)) return;
		if (ev.key === 'Delete') {
			if (openSubtagPanelId && subSelectedId) {
				var subSel = subNodes.find(function (n) { return n.id === subSelectedId; });
				if (subSel && !subSel.isParentAnchor) {
					ev.preventDefault();
					vscode.postMessage({
						type: 'requestRemoveSubGraphTagDialog',
						parentTagId: openSubtagPanelId,
						subTagId: subSelectedId
					});
				}
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

	window.addEventListener('keydown', function (ev) {
		if (ev.key === 'Shift') subShiftHeld = true;
	}, true);
	window.addEventListener('keyup', function (ev) {
		if (ev.key === 'Shift') subShiftHeld = false;
	}, true);

	window.addEventListener('mousedown', function (ev) {
		if (ev.button !== 0) return;
		if (isSubInlineRenameOpen()) {
			if (subInlineRenameWrap && !subInlineRenameWrap.contains(ev.target)) {
				commitSubInlineRename();
				ev.stopPropagation();
			}
			return;
		}
		if (subCtxMenuEl && !subCtxMenuEl.hidden && !subCtxMenuEl.contains(ev.target)) hideSubCtxMenu();
	}, true);

	window.addEventListener('mousemove', function (ev) {
		if (subDragNode) {
			var ps = subClientXY(ev);
			var ws = subScreenToWorld(ps.x, ps.y);
			subDragNode.x = ws.x - subDragOffX;
			subDragNode.y = ws.y - subDragOffY;
			saveSubGraphLayoutDebounced();
		} else if (subPanning) {
			subPanX = subPanStartX + (ev.clientX - subPanSX) / subScale;
			subPanY = subPanStartY + (ev.clientY - subPanSY) / subScale;
		}
	});

	window.addEventListener('mouseup', function () {
		subDragNode = null;
		subPanning = false;
		subGraphWrap.classList.remove('stag-panning', 'stag-drag-node');
	});

	subCanvas.addEventListener('contextmenu', function (ev) {
		ev.preventDefault();
		vscode.postMessage({ type: 'tagsPanelUiActivated' });
		var ps = subClientXY(ev);
		var w = subScreenToWorld(ps.x, ps.y);
		subCtxLinkIndex = -1;
		subCtxEdgeEndpoints = null;
		subCtxCanvasWorld = null;
		var nodeHit = subPickNode(w.x, w.y);
		if (nodeHit) {
			subSelectedId = nodeHit.id;
			var nodeItems = [];
			if (subLinkSourceId && subLinkSourceId !== nodeHit.id) {
				nodeItems.push({ act: 'sub-link-from-armed', label: 'Complete link → this node' });
			}
			nodeItems.push({ act: 'sub-node-arm-link', label: 'Arm as link source' });
			if (nodeHit.isParentAnchor) {
				nodeItems.push({ act: 'sub-node-rename', label: 'Rename…' });
			} else {
				nodeItems.push({ act: 'sub-node-rename', label: 'Rename…' });
				nodeItems.push({ act: 'sub-node-delete', label: 'Delete…', danger: true });
			}
			openSubCtxMenu(ev, nodeItems);
			return;
		}
		var focusCm = openSubtagPanelId;
		var linkHit = subPickLink(w.x, w.y);
		if (linkHit && focusCm) {
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
					if (!isSubFocusLink(l, focusCm)) return false;
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
		vscode.postMessage({ type: 'tagsPanelUiActivated' });
		var ps = subClientXY(ev);
		var w = subScreenToWorld(ps.x, ps.y);
		var hit = subPickNode(w.x, w.y);
		if (hit) {
			if (ev.detail === 1) {
				if (!subLinkSourceId || subLinkSourceId === hit.id) subLinkSourceId = hit.id;
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

	subCanvas.addEventListener('dblclick', function (ev) {
		ev.preventDefault();
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
		if (childCount(hit.id) > 0) {
			vscode.postMessage({ type: 'openSubGraphEditorWindow', parentTagId: hit.id });
			subSelectedId = hit.id;
			return;
		}
		subSelectedId = hit.id;
	});

	subCanvas.addEventListener('wheel', function (ev) {
		ev.preventDefault();
		var ps = subClientXY(ev);
		var before = subScreenToWorld(ps.x, ps.y);
		var factor = ev.deltaY > 0 ? 0.92 : 1.09;
		subScale = Math.min(2.5, Math.max(0.35, subScale * factor));
		var after = subScreenToWorld(ps.x, ps.y);
		subPanX += before.x - after.x;
		subPanY += before.y - after.y;
	}, { passive: false });

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
				var n = subNodes.find(function (x) { return x.id === subSelectedId; });
				if (n) showSubInlineRename(n);
			} else if (act === 'sub-node-delete' && openSubtagPanelId && subSelectedId) {
				var nn = subNodes.find(function (x) { return x.id === subSelectedId; });
				if (nn && !nn.isParentAnchor) {
					vscode.postMessage({ type: 'requestRemoveSubGraphTagDialog', parentTagId: openSubtagPanelId, subTagId: subSelectedId });
				}
			} else if (act === 'sub-link-delete' && openSubtagPanelId && savedIdx >= 0) {
				vscode.postMessage({ type: 'removeSubGraphLink', parentTagId: openSubtagPanelId, index: savedIdx });
			} else if (act === 'sub-link-reverse' && openSubtagPanelId && savedIdx >= 0) {
				vscode.postMessage({ type: 'reverseSubGraphLinkAtIndex', parentTagId: openSubtagPanelId, index: savedIdx });
			} else if (act === 'sub-link-add-reverse' && openSubtagPanelId && savedIdx >= 0) {
				var Lk = graph.links[savedIdx];
				if (Lk) {
					vscode.postMessage({ type: 'addSubGraphLink', parentTagId: openSubtagPanelId, fromId: Lk.to, toId: Lk.from });
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

	if (subTagAdd) {
		subTagAdd.addEventListener('click', function () {
			if (!openSubtagPanelId) return;
			var lab = subTagNew ? String(subTagNew.value || '').trim() : '';
			if (!lab) return;
			vscode.postMessage({ type: 'addSubGraphTag', parentTagId: openSubtagPanelId, label: lab });
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

	window.addEventListener('resize', function () { resizeSubCanvas(); });

	vscode.postMessage({ type: 'requestTagGraph' });
	resizeSubCanvas();
	loop();
})();`;
}

module.exports = { getTagsGraphSubOnlyRuntime };
