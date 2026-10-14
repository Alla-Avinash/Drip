// @ts-check
(function () {
	const vscode = acquireVsCodeApi();
	const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('archCanvas'));
	const wrap = document.getElementById('archCanvasWrap');
	const hint = document.getElementById('archHint');
	const hoverLabel = /** @type {HTMLElement} */ (document.getElementById('archHoverLabel'));
	const sidebar = document.getElementById('archSidebar');
	const projectEl = document.getElementById('archProject');
	const backEl = document.getElementById('archBack');
	const ctxMenu = document.getElementById('archContextMenu');
	const wfBar = document.getElementById('archWorkflowBar');

	if (!canvas || !wrap || !hint || !hoverLabel || !sidebar || !projectEl) return;
	const ctx = canvas.getContext('2d');
	if (!ctx) return;

	/** @type {any[]} */
	let nodes = [];
	/** @type {any[]} */
	let links = [];

	/** @type {Map<string, {x: number, y: number}>} */
	let nodePos = new Map();

	let selectedId = '';
	let hoverId = '';
	// The link source for the click→double-click link gesture. Armed immediately on a
	// single click (same model the tags graph uses), then a double-click on another
	// node completes the link.
	let linkSourceId = '';
	let createMode = ''; // '' | 'component' | 'subcomponent' | 'implementation'
	let loadedOnce = false;
	/** @type {{ parentId: string | null, featureId: string | null }} */
	let createOpts = { parentId: null, featureId: null };

	let panX = 0;
	let panY = 0;
	let zoom = 1;

	let dragNodeId = '';
	let dragOffsetX = 0;
	let dragOffsetY = 0;
	let panning = false;
	let panStartX = 0;
	let panStartY = 0;
	let panStartPanX = 0;
	let panStartPanY = 0;
	let downX = 0;
	let downY = 0;
	let pointerMoved = false;
	let playClickId = '';
	// The free link (source → target) that was right-clicked, for edge actions.
	let linkContext = null;
	// Where the context menu was opened — used for inline name entry at the click point.
	let ctxPos = { x: 0, y: 0 };
	// Inline creation type when the name box is open at the right-click point ('' = hidden).
	let inlineCreateMode = '';

	// ---- workflow state --------------------------------------------------
	let workflowMode = ''; // '' | 'build' | 'play'
	let pickWorkflowImpl = false; // "Make workflow" → next implementation click picks it
	/** @type {{ workflowId: string, name: string, steps: any[], current: number, drawArrow: boolean, arrowSource: string } | null} */
	let builder = null;
	/** @type {{ workflowId: string, name: string, steps: any[], current: number, playing: boolean, timer: any, speed: number } | null} */
	let playback = null;
	/** All node ids across every step of the active workflow. */
	let workflowIds = new Set();
	/** Node ids lit in the current step. */
	let activeIds = new Set();
	/** Flows drawn in the current step. */
	let activeFlows = [];

	// One color for the whole component hierarchy (components and sub-components).
	const NODE_COLORS = {
		feature: '--arch-feature',
		component: '--arch-component',
		subcomponent: '--arch-component',
		implementation: '--arch-implementation'
	};
	const EDGE_COLOR = '--arch-edge';
	const STRUCTURAL_COLOR = '--arch-structural';
	const PARALLEL_COLOR = '#6a9955';
	const ASYNC_COLOR = '#d7ba7d';

	function cssVar(name) {
		const s = getComputedStyle(document.body).getPropertyValue(name).trim();
		return s || '#888888';
	}

	function nodeColor(n) {
		return cssVar(NODE_COLORS[n.type] || '--arch-component');
	}

	/** @param {any} n */
	function nodeRadius(n) {
		if (n.type === 'feature') return 24;
		if (n.type === 'subcomponent') return 13;
		if (n.type === 'implementation') return 19;
		return 21;
	}

	function isFeature(n) { return n.type === 'feature'; }
	function isComponent(n) { return n.type === 'component'; }
	function isSubcomponent(n) { return n.type === 'subcomponent'; }
	function isImplementation(n) { return n.type === 'implementation'; }
	function isComponentHierarchy(n) { return isComponent(n) || isSubcomponent(n); }

	function nodeById(id) {
		return nodes.find(n => n.id === id);
	}

	function nodeName(id) {
		const n = nodeById(id);
		return n ? n.name : id;
	}

	// ---- layout ---------------------------------------------------------

	/** Deterministic initial layout: stored positions win; the rest cluster around their feature. */
	function layoutPass() {
		const pos = new Map();
		/** @type {Set<string>} */
		const auto = new Set();
		nodes.forEach(n => {
			if (typeof n.x === 'number' && Number.isFinite(n.x) && typeof n.y === 'number' && Number.isFinite(n.y)) {
				pos.set(n.id, { x: n.x, y: n.y });
			}
		});

		const features = nodes.filter(isFeature);
		let fi = 0;
		features.forEach(f => {
			let p = pos.get(f.id);
			if (!p) {
				p = { x: (fi - (features.length - 1) / 2) * 300, y: -240 };
				pos.set(f.id, p);
				auto.add(f.id);
			}
			fi += 1;
		});

		const others = nodes.filter(n => !isFeature(n) && !pos.has(n.id));
		/** @type {Map<string, any[]>} */
		const byFeature = new Map();
		const orphans = [];
		others.forEach(n => {
			if (n.featureId && pos.has(n.featureId)) {
				if (!byFeature.has(n.featureId)) byFeature.set(n.featureId, []);
				byFeature.get(n.featureId).push(n);
			} else {
				orphans.push(n);
			}
		});
		byFeature.forEach((members, fid) => {
			const center = pos.get(fid);
			members.forEach((m, i) => {
				const ang = (2 * Math.PI * i) / Math.max(members.length, 1) - Math.PI / 2;
				pos.set(m.id, { x: center.x + Math.cos(ang) * 190, y: center.y + 120 + Math.sin(ang) * 80 });
				auto.add(m.id);
			});
		});
		orphans.forEach((n, i) => {
			const ang = (2 * Math.PI * i) / Math.max(orphans.length, 1);
			pos.set(n.id, { x: Math.cos(ang) * 160, y: 130 + Math.sin(ang) * 60 });
			auto.add(n.id);
		});

		// Nodes with a parent (sub-components, implementations) tuck near it.
		/** @type {Map<string, number>} */
		const subIdx = new Map();
		nodes.forEach(n => {
			if ((isSubcomponent(n) || isImplementation(n)) && auto.has(n.id) && n.parentId) {
				const pp = pos.get(n.parentId);
				const k = subIdx.get(n.parentId) || 0;
				subIdx.set(n.parentId, k + 1);
				if (pp) {
					const ang = (2 * Math.PI * k) / 8;
					pos.set(n.id, { x: pp.x + Math.cos(ang) * 120, y: pp.y + Math.sin(ang) * 120 + 60 });
				}
			}
		});

		return pos;
	}

	function resetView() {
		nodePos = layoutPass();
		const rect = wrap.getBoundingClientRect();
		panX = rect.width / 2;
		panY = rect.height / 2;
		zoom = 1;
		draw();
	}

	// ---- transforms -----------------------------------------------------

	function toWorld(sx, sy) {
		return { x: (sx - panX) / zoom, y: (sy - panY) / zoom };
	}
	function toScreen(wx, wy) {
		return { x: wx * zoom + panX, y: wy * zoom + panY };
	}
	function posOf(id) {
		return nodePos.get(id) || { x: 0, y: 0 };
	}

	// ---- drawing --------------------------------------------------------

	function resizeCanvas() {
		const rect = wrap.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.max(1, Math.floor(rect.width * dpr));
		canvas.height = Math.max(1, Math.floor(rect.height * dpr));
		canvas.style.width = rect.width + 'px';
		canvas.style.height = rect.height + 'px';
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		draw();
	}

	function drawArrow(from, to, size) {
		const dx = to.x - from.x;
		const dy = to.y - from.y;
		const len = Math.hypot(dx, dy) || 1;
		const ux = dx / len;
		const uy = dy / len;
		const head = size || 8;
		const a1x = to.x - ux * head;
		const a1y = to.y - uy * head;
		ctx.beginPath();
		ctx.moveTo(to.x, to.y);
		ctx.lineTo(a1x - uy * head * 0.5, a1y + ux * head * 0.5);
		ctx.lineTo(a1x + uy * head * 0.5, a1y - ux * head * 0.5);
		ctx.closePath();
		ctx.fill();
	}

	function edgeEndpoints(fromId, toId) {
		const from = posOf(fromId);
		const to = posOf(toId);
		const r1 = nodeRadius(nodeById(fromId) || { type: 'component' });
		const r2 = nodeRadius(nodeById(toId) || { type: 'component' });
		// Nodes are drawn in screen space (drawNode calls toScreen) with a fixed
		// on-screen radius, so edge boundaries must be computed in screen space too.
		// Computing them from raw world coordinates misplaces every edge by the pan
		// offset — the "stale line" drifting away from the nodes.
		const a = toScreen(from.x, from.y);
		const b = toScreen(to.x, to.y);
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = Math.hypot(dx, dy) || 1;
		const ux = dx / len;
		const uy = dy / len;
		return {
			from: { x: a.x + ux * r1, y: a.y + uy * r1 },
			to: { x: b.x - ux * r2, y: b.y - uy * r2 }
		};
	}

	function drawNode(n) {
		const p = posOf(n.id);
		const s = toScreen(p.x, p.y);
		const color = nodeColor(n);
		const r = nodeRadius(n);

		ctx.save();
		if (n.id === selectedId && workflowMode === '') {
			ctx.strokeStyle = cssVar('--arch-accent');
			ctx.lineWidth = 3;
			ctx.beginPath();
			ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
			ctx.stroke();
		}
		if (workflowMode !== '' && activeIds.has(n.id)) {
			ctx.strokeStyle = cssVar('--arch-accent');
			ctx.lineWidth = 3;
			ctx.beginPath();
			ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
			ctx.stroke();
		}
		if (workflowMode === 'build' && builder && builder.drawArrow && builder.arrowSource === n.id) {
			ctx.strokeStyle = '#ffffff';
			ctx.setLineDash([4, 3]);
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.arc(s.x, s.y, r + 8, 0, Math.PI * 2);
			ctx.stroke();
			ctx.setLineDash([]);
		}
		if (workflowMode === '' && n.id === linkSourceId) {
			ctx.strokeStyle = cssVar('--arch-accent');
			ctx.setLineDash([3, 3]);
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.arc(s.x, s.y, r + 8, 0, Math.PI * 2);
			ctx.stroke();
			ctx.setLineDash([]);
		}

		ctx.fillStyle = color;
		ctx.strokeStyle = 'rgba(0,0,0,0.4)';
		ctx.lineWidth = 1;
		if (isFeature(n)) {
			ctx.beginPath();
			ctx.moveTo(s.x, s.y - r);
			ctx.lineTo(s.x + r, s.y);
			ctx.lineTo(s.x, s.y + r);
			ctx.lineTo(s.x - r, s.y);
			ctx.closePath();
			ctx.fill();
			ctx.stroke();
		} else if (isImplementation(n)) {
			ctx.beginPath();
			for (let i = 0; i < 6; i++) {
				const ang = (Math.PI / 3) * i - Math.PI / 6;
				const x = s.x + r * Math.cos(ang);
				const y = s.y + r * Math.sin(ang);
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.closePath();
			ctx.fill();
			ctx.stroke();
		} else {
			ctx.beginPath();
			ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
			ctx.fill();
			ctx.stroke();
		}
		ctx.restore();

		ctx.fillStyle = cssVar('--vscode-foreground');
		ctx.font = '12px ' + cssVar('--vscode-font-family');
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		ctx.fillText(truncate(n.name, 18), s.x, s.y + r + 3);
	}

	function truncate(text, max) {
		const s = String(text || '');
		return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
	}

	function drawStructuralEdges() {
		ctx.strokeStyle = cssVar(STRUCTURAL_COLOR);
		ctx.fillStyle = cssVar(STRUCTURAL_COLOR);
		ctx.lineWidth = 1.5;
		nodes.forEach(n => {
			if (n.parentId && nodePos.has(n.parentId) && nodePos.has(n.id)) {
				const e = edgeEndpoints(n.id, n.parentId);
				ctx.beginPath();
				ctx.moveTo(e.from.x, e.from.y);
				ctx.lineTo(e.to.x, e.to.y);
				ctx.stroke();
				drawArrow(e.from, e.to, 8);
			}
			if (n.featureId && nodePos.has(n.featureId) && nodePos.has(n.id) && !isFeature(n)) {
				const e = edgeEndpoints(n.id, n.featureId);
				ctx.beginPath();
				ctx.moveTo(e.from.x, e.from.y);
				ctx.lineTo(e.to.x, e.to.y);
				ctx.stroke();
				drawArrow(e.from, e.to, 8);
			}
		});
	}

	function drawFreeLinks() {
		ctx.strokeStyle = cssVar(EDGE_COLOR);
		ctx.fillStyle = cssVar(EDGE_COLOR);
		ctx.lineWidth = 2;
		links.forEach(l => {
			if (!nodePos.has(l.source) || !nodePos.has(l.target)) return;
			const e = edgeEndpoints(l.source, l.target);
			ctx.beginPath();
			ctx.moveTo(e.from.x, e.from.y);
			ctx.lineTo(e.to.x, e.to.y);
			ctx.stroke();
			drawArrow(e.from, e.to, 9);
		});
	}

	function flowColor(type) {
		if (type === 'parallel') return PARALLEL_COLOR;
		if (type === 'async') return ASYNC_COLOR;
		return cssVar(EDGE_COLOR);
	}

	function drawFlow(f) {
		if (!nodePos.has(f.source) || !nodePos.has(f.target)) return;
		const e = edgeEndpoints(f.source, f.target);
		const color = flowColor(f.executionType);
		ctx.strokeStyle = color;
		ctx.fillStyle = color;
		ctx.lineWidth = 1.8;
		if (f.executionType === 'async') ctx.setLineDash([6, 4]);
		ctx.beginPath();
		ctx.moveTo(e.from.x, e.from.y);
		ctx.lineTo(e.to.x, e.to.y);
		ctx.stroke();
		ctx.setLineDash([]);
		drawArrow(e.from, e.to, 9);

		const mx = (e.from.x + e.to.x) / 2;
		const my = (e.from.y + e.to.y) / 2;

		// Nested implementation badge on the arrow's middle.
		if (f.nestedWorkflowId) {
			const nested = nodeById(f.nestedWorkflowId);
			const label = nested ? truncate(nested.name, 14) : 'nested';
			ctx.fillStyle = cssVar('--arch-implementation');
			ctx.strokeStyle = 'rgba(0,0,0,0.4)';
			ctx.beginPath();
			for (let i = 0; i < 6; i++) {
				const ang = (Math.PI / 3) * i - Math.PI / 6;
				const x = mx + 9 * Math.cos(ang);
				const y = my + 9 * Math.sin(ang);
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.closePath();
			ctx.fill();
			ctx.stroke();
			ctx.fillStyle = cssVar('--vscode-foreground');
			ctx.font = '11px ' + cssVar('--vscode-font-family');
			ctx.textAlign = 'center';
			ctx.textBaseline = 'top';
			ctx.fillText(label, mx, my + 13);
		}
		// Label above the line.
		if (f.label) {
			ctx.fillStyle = cssVar('--vscode-foreground');
			ctx.font = '11px ' + cssVar('--vscode-font-family');
			ctx.textAlign = 'center';
			ctx.textBaseline = 'bottom';
			ctx.fillText(f.label, mx, my - 9);
		}
	}

	function draw() {
		const rect = wrap.getBoundingClientRect();
		ctx.clearRect(0, 0, rect.width, rect.height);
		const inWorkflow = workflowMode === 'build' || workflowMode === 'play';

		ctx.globalAlpha = inWorkflow ? 0.2 : 1;
		drawStructuralEdges();
		drawFreeLinks();
		ctx.globalAlpha = 1;

		if (inWorkflow) {
			activeFlows.forEach(drawFlow);
		}

		nodes.forEach(n => {
			if (inWorkflow) {
				if (!workflowIds.has(n.id)) ctx.globalAlpha = 0.12;
				else if (!activeIds.has(n.id)) ctx.globalAlpha = 0.45;
			}
			drawNode(n);
			ctx.globalAlpha = 1;
		});
	}

	// ---- hit testing ----------------------------------------------------

	function hitTest(sx, sy) {
		for (let i = nodes.length - 1; i >= 0; i--) {
			const n = nodes[i];
			const p = posOf(n.id);
			const s = toScreen(p.x, p.y);
			const r = nodeRadius(n);
			if (isFeature(n)) {
				if (Math.abs(sx - s.x) + Math.abs(sy - s.y) <= r + 6) return n.id;
			} else {
				if (Math.hypot(sx - s.x, sy - s.y) <= r + 4) return n.id;
			}
		}
		return '';
	}

	/** Perpendicular distance from a point to a segment. */
	function distToSegment(px, py, x1, y1, x2, y2) {
		const dx = x2 - x1;
		const dy = y2 - y1;
		const len2 = dx * dx + dy * dy;
		let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
		t = Math.max(0, Math.min(1, t));
		return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
	}

	/** Nearest free link (manual arrow) within a small grab distance, if any. */
	function hitTestLink(sx, sy) {
		let best = null;
		let bestDist = 9;
		links.forEach(l => {
			if (!nodePos.has(l.source) || !nodePos.has(l.target)) return;
			const e = edgeEndpoints(l.source, l.target);
			const d = distToSegment(sx, sy, e.from.x, e.from.y, e.to.x, e.to.y);
			if (d < bestDist) { bestDist = d; best = l; }
		});
		return best;
	}

	// ---- sidebar --------------------------------------------------------

	function featureOptions(selected) {
		let html = '<option value="">(none)</option>';
		nodes.filter(isFeature).forEach(f => {
			html += '<option value="' + esc(f.id) + '"' + (selected === f.id ? ' selected' : '') + '>' + esc(f.name) + '</option>';
		});
		return html;
	}

	function componentOptions(selected) {
		let html = '<option value="">(none)</option>';
		nodes.filter(isComponentHierarchy).forEach(c => {
			html += '<option value="' + esc(c.id) + '"' + (selected === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
		});
		return html;
	}

	function implementationOptions(selected) {
		let html = '<option value="">(none)</option>';
		nodes.filter(isImplementation).forEach(n => {
			html += '<option value="' + esc(n.id) + '"' + (selected === n.id ? ' selected' : '') + '>' + esc(n.name) + '</option>';
		});
		return html;
	}

	function esc(s) {
		return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function renderSidebar() {
		if (workflowMode === 'build') {
			renderBuilderSidebar();
			return;
		}
		if (workflowMode === 'play') {
			sidebar.innerHTML = '<div class="muted">Workflow playback is active. Use the controls at the bottom; click Exit to return to editing.</div>';
			return;
		}

		let html = '<div class="arch-legend">';
		[['feature', 'Feature'], ['component', 'Component'], ['implementation', 'Implementation']].forEach(function (pair) {
			html += '<span class="item"><span class="arch-swatch" style="background:' + cssVar(NODE_COLORS[pair[0]]) + '"></span>' + pair[1] + '</span>';
		});
		html += '</div>';

		if (createMode) {
			html += '<h3>New ' + createMode + '</h3>';
			html += '<input type="text" id="createName" class="arch-field" placeholder="Name" autocomplete="off" />';
			if (createMode === 'subcomponent' || createMode === 'implementation') {
				html += '<label class="muted">Parent component</label>';
				html += '<select id="createParent" class="arch-field">' + componentOptions(createOpts.parentId) + '</select>';
			}
			html += '<label class="muted">Feature</label>';
			html += '<select id="createFeature" class="arch-field">' + featureOptions(createOpts.featureId) + '</select>';
			html += '<div class="arch-row"><button type="button" class="arch-btn" id="createConfirm">Create</button><button type="button" class="arch-btn" id="createCancel">Cancel</button></div>';
			sidebar.innerHTML = html;
			bindCreateForm();
			return;
		}

		const sel = selectedId ? nodeById(selectedId) : null;
		if (sel) {
			html += '<h3>' + esc(typeLabel(sel.type)) + '</h3>';
			html += '<input type="text" id="renameInput" class="arch-field" value="' + esc(sel.name) + '" autocomplete="off" />';
			html += '<div class="arch-row"><button type="button" class="arch-btn" id="renameBtn">Rename</button></div>';

			if (!isFeature(sel)) {
				html += '<label class="muted">Feature</label>';
				html += '<select id="featureSelect" class="arch-field">' + featureOptions(sel.featureId || '') + '</select>';
			}
			if (isSubcomponent(sel) || isImplementation(sel)) {
				html += '<label class="muted">Parent component</label>';
				html += '<select id="parentSelect" class="arch-field">' + componentOptions(sel.parentId || '') + '</select>';
			}
			if (sel.descriptionFile) {
				html += '<div class="arch-chip">' + esc(sel.descriptionFile) + '</div>';
			}

			html += '<div class="arch-actions">';
			if (sel.descriptionFile) {
				html += '<button type="button" class="arch-btn" id="openBtn">Open description (.d.md)</button>';
			}
			if (isImplementation(sel)) {
				if (sel.hasWorkflow) {
					html += '<button type="button" class="arch-btn" id="playWorkflowBtn">Play workflow</button>';
					html += '<button type="button" class="arch-btn" id="editWorkflowBtn">Edit workflow</button>';
				} else {
					html += '<button type="button" class="arch-btn" id="makeWorkflowBtn">Create workflow</button>';
				}
			}
			if (!isFeature(sel)) {
				html += '<button type="button" class="arch-btn arch-btn-danger" id="deleteBtn">Delete</button>';
			}
			html += '</div>';
			sidebar.innerHTML = html;
			bindSelectionForm(sel);
			return;
		}

		html += '<div class="muted">Click a node to select it; click empty space to clear. Double-click a node (with another selected) to link them; double-click alone opens it. Right-click a node or the canvas for actions.</div>';
		sidebar.innerHTML = html;
	}

	function typeLabel(type) {
		return { feature: 'Feature', component: 'Component', subcomponent: 'Component', implementation: 'Implementation' }[type] || type;
	}

	function bindCreateForm() {
		const name = document.getElementById('createName');
		const confirm = document.getElementById('createConfirm');
		const cancel = document.getElementById('createCancel');
		const parentSel = document.getElementById('createParent');
		const featureSel = document.getElementById('createFeature');
		if (cancel) cancel.addEventListener('click', function () { createMode = ''; renderSidebar(); });
		if (name) name.focus();
		function submit() {
			if (!name) return;
			const nm = name.value.trim();
			if (!nm) { name.focus(); return; }
			vscode.postMessage({
				type: 'createEntity',
				entityType: createMode,
				name: nm,
				parentId: parentSel ? (parentSel.value || null) : null,
				featureId: featureSel ? (featureSel.value || null) : null
			});
			createMode = '';
			renderSidebar();
		}
		if (confirm) confirm.addEventListener('click', submit);
		if (name) name.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') { e.preventDefault(); submit(); }
			else if (e.key === 'Escape') { createMode = ''; renderSidebar(); }
		});
	}

	function bindSelectionForm(sel) {
		const renameInput = document.getElementById('renameInput');
		const renameBtn = document.getElementById('renameBtn');
		if (renameBtn && renameInput) {
			renameBtn.addEventListener('click', function () {
				const v = renameInput.value.trim();
				if (v && v !== sel.name) vscode.postMessage({ type: 'renameEntity', id: sel.id, name: v });
			});
		}
		const featureSel = document.getElementById('featureSelect');
		if (featureSel) {
			featureSel.addEventListener('change', function () {
				vscode.postMessage({ type: 'setFeature', id: sel.id, featureId: featureSel.value || null });
			});
		}
		const parentSel = document.getElementById('parentSelect');
		if (parentSel) {
			parentSel.addEventListener('change', function () {
				vscode.postMessage({ type: 'setParent', id: sel.id, parentId: parentSel.value || null });
			});
		}
		const openBtn = document.getElementById('openBtn');
		if (openBtn) openBtn.addEventListener('click', function () {
			vscode.postMessage({ type: 'openDescription', id: sel.id });
		});
		const makeWorkflowBtn = document.getElementById('makeWorkflowBtn');
		if (makeWorkflowBtn) makeWorkflowBtn.addEventListener('click', function () {
			vscode.postMessage({ type: 'buildWorkflow', id: sel.id });
		});
		const playWorkflowBtn = document.getElementById('playWorkflowBtn');
		if (playWorkflowBtn) playWorkflowBtn.addEventListener('click', function () {
			vscode.postMessage({ type: 'playWorkflow', id: sel.id });
		});
		const editWorkflowBtn = document.getElementById('editWorkflowBtn');
		if (editWorkflowBtn) editWorkflowBtn.addEventListener('click', function () {
			vscode.postMessage({ type: 'buildWorkflow', id: sel.id });
		});
		const deleteBtn = document.getElementById('deleteBtn');
		if (deleteBtn) deleteBtn.addEventListener('click', function () {
			vscode.postMessage({ type: 'deleteEntity', id: sel.id });
			selectedId = '';
			renderSidebar();
		});
	}

	// ---- workflow highlight state ---------------------------------------

	function syncWorkflowHighlight() {
		workflowIds = new Set();
		activeIds = new Set();
		activeFlows = [];
		let steps = [];
		let current = -1;
		if (workflowMode === 'build' && builder) {
			steps = builder.steps;
			current = builder.current;
		} else if (workflowMode === 'play' && playback) {
			steps = playback.steps;
			current = playback.current;
		}
		steps.forEach(s => (s.nodes || []).forEach(id => workflowIds.add(String(id))));
		if (current >= 0 && current < steps.length) {
			const step = steps[current];
			(step.nodes || []).forEach(id => activeIds.add(String(id)));
			activeFlows = step.flows || [];
		}
	}

	// ---- builder ---------------------------------------------------------

	function currentBuilderStep() {
		if (!builder) return null;
		return builder.steps[builder.current] || null;
	}

	function toggleStepNode(id) {
		const step = currentBuilderStep();
		if (!step) return;
		const i = step.nodes.indexOf(id);
		if (i >= 0) step.nodes.splice(i, 1);
		else step.nodes.push(id);
		syncWorkflowHighlight();
		renderBuilderSidebar();
		draw();
	}

	function addFlowToStep(source, target) {
		const step = currentBuilderStep();
		if (!step) return;
		step.flows.push({ source, target, label: '', executionType: 'sync', nestedWorkflowId: '' });
		syncWorkflowHighlight();
		renderBuilderSidebar();
		draw();
	}

	function renderBuilderSidebar() {
		if (!builder) return;
		const step = currentBuilderStep();
		const n = builder.steps.length;
		let html = '<h3>Workflow: ' + esc(builder.name) + '</h3>';
		html += '<div class="muted">Step ' + (builder.current + 1) + ' of ' + n + '</div>';

		html += '<h4>Nodes in this step</h4>';
		if (!step || step.nodes.length === 0) {
			html += '<div class="muted">Click nodes on the canvas to add them.</div>';
		} else {
			html += '<ul class="arch-tag-list">';
			step.nodes.forEach(id => {
				html += '<li><span>' + esc(nodeName(id)) + '</span><span class="rm" data-rm="' + esc(id) + '" title="Remove">&#10005;</span></li>';
			});
			html += '</ul>';
		}

		html += '<h4>Flows (arrows)</h4>';
		if (!step || step.flows.length === 0) {
			html += '<div class="muted">Turn on "Draw arrow", then click source then target.</div>';
		} else {
			step.flows.forEach((f, fi) => {
				html += '<div class="arch-flow-row" data-fi="' + fi + '">';
				html += '<span class="flow-path">' + esc(nodeName(f.source)) + ' &#8594; ' + esc(nodeName(f.target)) + '</span>';
				html += '<input type="text" class="arch-field" data-fl-label="' + fi + '" placeholder="label" value="' + esc(f.label) + '" />';
				html += '<select class="arch-field" data-fl-type="' + fi + '">'
					+ '<option value="sync"' + (f.executionType === 'sync' ? ' selected' : '') + '>sync</option>'
					+ '<option value="parallel"' + (f.executionType === 'parallel' ? ' selected' : '') + '>parallel</option>'
					+ '<option value="async"' + (f.executionType === 'async' ? ' selected' : '') + '>async</option>'
					+ '</select>';
				html += '<select class="arch-field" data-fl-nested="' + fi + '">' + implementationOptions(f.nestedWorkflowId) + '</select>';
				html += '<span class="rm" data-fl-rm="' + fi + '" title="Delete flow">&#10005;</span>';
				html += '</div>';
			});
		}

		html += '<div class="arch-row">';
		html += '<button type="button" class="arch-btn' + (builder.drawArrow ? ' active' : '') + '" id="bldDrawArrow">Draw arrow</button>';
		html += '</div>';
		html += '<div class="arch-row">';
		html += '<button type="button" class="arch-btn" id="bldPrev">&#8592; Prev</button>';
		html += '<button type="button" class="arch-btn" id="bldNext">Next &#8594;</button>';
		html += '</div>';
		html += '<div class="arch-row">';
		html += '<button type="button" class="arch-btn" id="bldAddStep">+ Step</button>';
		html += '<button type="button" class="arch-btn arch-btn-danger" id="bldDelStep">Remove step</button>';
		html += '</div>';
		html += '<div class="arch-actions">';
		html += '<button type="button" class="arch-btn" id="bldSave">Save workflow</button>';
		html += '<button type="button" class="arch-btn" id="bldCancel">Cancel</button>';
		html += '</div>';

		sidebar.innerHTML = html;
		bindBuilderSidebar();
	}

	function bindBuilderSidebar() {
		const drawArrowBtn = document.getElementById('bldDrawArrow');
		if (drawArrowBtn) drawArrowBtn.addEventListener('click', function () {
			if (!builder) return;
			builder.drawArrow = !builder.drawArrow;
			builder.arrowSource = '';
			renderBuilderSidebar();
			draw();
		});
		document.querySelectorAll('.arch-tag-list .rm').forEach(el => {
			el.addEventListener('click', function () {
				const id = el.getAttribute('data-rm');
				toggleStepNode(id);
			});
		});
		document.querySelectorAll('.arch-flow-row').forEach(row => {
			const fi = Number(row.getAttribute('data-fi'));
			const labelEl = row.querySelector('[data-fl-label]');
			if (labelEl) labelEl.addEventListener('input', function () {
				const step = currentBuilderStep();
				if (step && step.flows[fi]) { step.flows[fi].label = labelEl.value; draw(); }
			});
			const typeEl = row.querySelector('[data-fl-type]');
			if (typeEl) typeEl.addEventListener('change', function () {
				const step = currentBuilderStep();
				if (step && step.flows[fi]) { step.flows[fi].executionType = typeEl.value; draw(); }
			});
			const nestedEl = row.querySelector('[data-fl-nested]');
			if (nestedEl) nestedEl.addEventListener('change', function () {
				const step = currentBuilderStep();
				if (step && step.flows[fi]) { step.flows[fi].nestedWorkflowId = nestedEl.value; draw(); }
			});
			const rmEl = row.querySelector('[data-fl-rm]');
			if (rmEl) rmEl.addEventListener('click', function () {
				const step = currentBuilderStep();
				if (step) { step.flows.splice(fi, 1); syncWorkflowHighlight(); renderBuilderSidebar(); draw(); }
			});
		});
		const prev = document.getElementById('bldPrev');
		if (prev) prev.addEventListener('click', function () { if (builder) { builder.current = Math.max(0, builder.current - 1); syncWorkflowHighlight(); renderBuilderSidebar(); draw(); } });
		const next = document.getElementById('bldNext');
		if (next) next.addEventListener('click', function () {
			if (!builder) return;
			// "Next" always advances: at the last step it starts a fresh one.
			if (builder.current >= builder.steps.length - 1) {
				builder.steps.push({ nodes: [], flows: [] });
			}
			builder.current += 1;
			syncWorkflowHighlight();
			renderBuilderSidebar();
			draw();
		});
		const addStep = document.getElementById('bldAddStep');
		if (addStep) addStep.addEventListener('click', function () {
			if (!builder) return;
			builder.steps.push({ nodes: [], flows: [] });
			builder.current = builder.steps.length - 1;
			syncWorkflowHighlight();
			renderBuilderSidebar();
			draw();
		});
		const delStep = document.getElementById('bldDelStep');
		if (delStep) delStep.addEventListener('click', function () {
			if (!builder) return;
			if (builder.steps.length <= 1) { setHint('Keep at least one step.'); return; }
			builder.steps.splice(builder.current, 1);
			builder.current = Math.max(0, builder.current - 1);
			syncWorkflowHighlight();
			renderBuilderSidebar();
			draw();
		});
		const save = document.getElementById('bldSave');
		if (save) save.addEventListener('click', finishBuild);
		const cancel = document.getElementById('bldCancel');
		if (cancel) cancel.addEventListener('click', exitWorkflowMode);
	}

	function finishBuild() {
		if (!builder) return;
		vscode.postMessage({
			type: 'saveWorkflow',
			workflowId: builder.workflowId,
			steps: builder.steps.map(s => ({ nodes: s.nodes, flows: s.flows }))
		});
	}

	// ---- playback --------------------------------------------------------

	function updatePlayButton() {
		const btn = document.getElementById('wfBtnPlay');
		if (btn) {
			btn.textContent = playback && playback.playing ? '\u23F8' : '\u25B6';
			btn.classList.toggle('playing', !!(playback && playback.playing));
		}
	}

	function stopPlayTimer() {
		if (playback && playback.timer) { clearInterval(playback.timer); playback.timer = null; }
		if (playback) playback.playing = false;
		updatePlayButton();
	}

	function tickDelay() {
		return 1200 / (playback ? playback.speed : 1);
	}

	function advancePlayback() {
		if (!playback) return;
		if (playback.current < playback.steps.length) {
			playback.current += 1;
			syncWorkflowHighlight();
			renderPlaybackStatus();
			draw();
		}
		if (playback.current >= playback.steps.length) {
			stopPlayTimer();
			renderPlaybackStatus();
		}
	}

	function playPlayback() {
		if (!playback || playback.steps.length === 0) return;
		if (playback.current >= playback.steps.length) playback.current = -1;
		stopPlayTimer();
		playback.playing = true;
		updatePlayButton();
		advancePlayback();
		playback.timer = setInterval(function () {
			advancePlayback();
			if (playback.current >= playback.steps.length) stopPlayTimer();
		}, tickDelay());
	}

	function renderPlaybackStatus() {
		const el = document.getElementById('wfStatus');
		if (!playback || !el) return;
		const n = playback.steps.length;
		if (playback.current < 0) el.textContent = n + ' step(s)';
		else if (playback.current >= n) el.textContent = 'Complete';
		else el.textContent = 'Step ' + (playback.current + 1) + ' of ' + n;
		setHint('Playing "' + playback.name + '" — step-by-step on the graph.');
	}

	// ---- workflow mode entry / exit -------------------------------------

	function enterBuildMode(workflowId, name, steps) {
		workflowMode = 'build';
		pickWorkflowImpl = false;
		createMode = '';
		selectedId = '';
		const mapped = (steps && steps.length ? steps : [{ nodes: [], flows: [] }]).map(s => ({
			nodes: (s.nodes || []).map(String),
			flows: (s.flows || []).map(f => ({ source: String(f.source), target: String(f.target), label: String(f.label || ''), executionType: String(f.executionType || 'sync'), nestedWorkflowId: f.nestedWorkflowId ? String(f.nestedWorkflowId) : '' }))
		}));
		builder = { workflowId, name, steps: mapped, current: 0, drawArrow: false, arrowSource: '' };
		playback = null;
		syncWorkflowHighlight();
		renderBuilderSidebar();
		setHint('Building workflow "' + name + '" — click nodes to add them to this step; use Draw arrow to connect. Save when done.');
		draw();
	}

	function enterPlayMode(workflowId, name, steps) {
		if (!steps || steps.length === 0) {
			setHint('"' + name + '" has no workflow yet. Right-click it and choose "Create workflow".');
			return;
		}
		workflowMode = 'play';
		pickWorkflowImpl = false;
		createMode = '';
		selectedId = '';
		playback = {
			workflowId,
			name,
			steps: steps.map(s => ({ nodes: (s.nodes || []).map(String), flows: s.flows || [] })),
			current: -1,
			playing: false,
			timer: null,
			speed: 1
		};
		builder = null;
		syncWorkflowHighlight();
		if (wfBar) wfBar.hidden = false;
		renderPlaybackStatus();
		updatePlayButton();
		renderSidebar();
		draw();
	}

	function exitWorkflowMode() {
		workflowMode = '';
		pickWorkflowImpl = false;
		builder = null;
		stopPlayTimer();
		playback = null;
		workflowIds = new Set();
		activeIds = new Set();
		activeFlows = [];
		if (wfBar) wfBar.hidden = true;
		renderSidebar();
		draw();
	}

	// ---- header / toolbar ----------------------------------------------

	function setHint(text) {
		hint.textContent = text;
	}

	function bindHeader() {
		if (backEl) backEl.addEventListener('click', function () {
			vscode.postMessage({ type: 'back' });
		});
		document.getElementById('archBtnComponent').addEventListener('click', function () {
			enterCreate('component');
		});
		document.getElementById('archBtnSubcomponent').addEventListener('click', function () {
			enterCreate('subcomponent');
		});
		document.getElementById('archBtnImplementation').addEventListener('click', function () {
			enterCreate('implementation');
		});
		document.getElementById('archBtnMakeWorkflow').addEventListener('click', function () {
			if (workflowMode !== '') exitWorkflowMode();
			pickWorkflowImpl = true;
			setHint('Click the implementation node you want to build a workflow for.');
		});
		document.getElementById('archBtnReset').addEventListener('click', function () {
			resetView();
		});
	}

	function bindWorkflowBar() {
		if (!wfBar) return;
		const restart = document.getElementById('wfBtnRestart');
		const stepBack = document.getElementById('wfBtnStepBack');
		const play = document.getElementById('wfBtnPlay');
		const stepFwd = document.getElementById('wfBtnStepFwd');
		const speed = document.getElementById('wfSpeed');
		const exit = document.getElementById('wfBtnExit');
		if (restart) restart.addEventListener('click', function () { if (playback) { stopPlayTimer(); playback.current = -1; syncWorkflowHighlight(); renderPlaybackStatus(); draw(); } });
		if (stepBack) stepBack.addEventListener('click', function () { if (playback) { stopPlayTimer(); playback.current = Math.max(-1, playback.current - 1); syncWorkflowHighlight(); renderPlaybackStatus(); draw(); } });
		if (play) play.addEventListener('click', function () { if (playback && playback.playing) stopPlayTimer(); else playPlayback(); });
		if (stepFwd) stepFwd.addEventListener('click', function () { if (playback) { stopPlayTimer(); advancePlayback(); } });
		if (speed) speed.addEventListener('change', function () { if (playback) { playback.speed = Number(speed.value) || 1; } });
		if (exit) exit.addEventListener('click', exitWorkflowMode);
	}

	function enterCreate(mode) {
		let parentId = null;
		let featureId = null;
		const sel = selectedId ? nodeById(selectedId) : null;
		if (sel) {
			if (isComponentHierarchy(sel)) parentId = sel.id;
			if (sel.type === 'feature') featureId = sel.id;
			else if (sel.featureId) featureId = sel.featureId;
		}
		createOpts = { parentId, featureId };
		createMode = mode;
		renderSidebar();
	}

	function bindInlineCreate() {
		const input = document.getElementById('archInlineInput');
		if (!input) return;
		input.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') {
				e.preventDefault();
				const nm = input.value.trim();
				if (nm && inlineCreateMode) {
					vscode.postMessage({
						type: 'createEntity',
						entityType: inlineCreateMode,
						name: nm,
						parentId: null,
						featureId: null
					});
				}
				hideInlineCreate();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				hideInlineCreate();
			}
		});
	}

	// ---- context menu ---------------------------------------------------

	function showContextMenu(items, x, y) {
		if (!ctxMenu) return;
		ctxMenu.innerHTML = items.map(function (it) {
			return '<div class="arch-context-item' + (it.danger ? ' danger' : '') + '" data-action="' + esc(it.action) + '">' + esc(it.label) + '</div>';
		}).join('');
		ctxMenu.hidden = false;
		const mw = 200;
		ctxMenu.style.left = Math.max(4, Math.min(x, wrap.clientWidth - mw)) + 'px';
		ctxMenu.style.top = Math.max(4, Math.min(y, wrap.clientHeight - items.length * 28 - 12)) + 'px';
	}

	function hideContextMenu() {
		if (ctxMenu) ctxMenu.hidden = true;
	}

	// Inline name entry: a text box at the right-click point for creating a node.
	function beginInlineCreate(mode) {
		const el = document.getElementById('archInlineEdit');
		const input = document.getElementById('archInlineInput');
		if (!el || !input) return;
		inlineCreateMode = mode;
		el.hidden = false;
		el.style.left = Math.max(4, Math.min(ctxPos.x, wrap.clientWidth - 176)) + 'px';
		el.style.top = Math.max(4, Math.min(ctxPos.y, wrap.clientHeight - 40)) + 'px';
		input.value = '';
		input.placeholder = mode === 'implementation' ? 'Implementation name' : 'Component name';
		input.focus();
	}

	function hideInlineCreate() {
		const el = document.getElementById('archInlineEdit');
		if (el) el.hidden = true;
		inlineCreateMode = '';
	}

	function runContextAction(action) {
		if (action === 'rename') {
			const input = document.getElementById('renameInput');
			if (input) { input.focus(); input.select(); }
		} else if (action === 'delete') {
			if (selectedId && !isFeature(nodeById(selectedId))) {
				vscode.postMessage({ type: 'deleteEntity', id: selectedId });
				selectedId = '';
				renderSidebar();
			}
		} else if (action === 'newComponent') {
			beginInlineCreate('component');
		} else if (action === 'newImplementation') {
			beginInlineCreate('implementation');
		} else if (action === 'buildWorkflow') {
			vscode.postMessage({ type: 'buildWorkflow', id: selectedId });
		} else if (action === 'playWorkflow') {
			vscode.postMessage({ type: 'playWorkflow', id: selectedId });
		} else if (action === 'deleteLink') {
			if (linkContext) {
				vscode.postMessage({ type: 'removeLink', from: linkContext.source, to: linkContext.target, relation: linkContext.relation });
				linkContext = null;
			}
		} else if (action === 'reverseLink') {
			if (linkContext) {
				vscode.postMessage({ type: 'addLink', from: linkContext.target, to: linkContext.source, relation: linkContext.relation });
				linkContext = null;
			}
		}
	}

	if (ctxMenu) {
		ctxMenu.addEventListener('click', function (e) {
			const item = e.target.closest('.arch-context-item');
			if (!item) return;
			const action = item.getAttribute('data-action');
			hideContextMenu();
			runContextAction(action);
		});
	}

	// ---- pointer events -------------------------------------------------

	function canvasPos(e) {
		const rect = canvas.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	function beginPan(e, p) {
		panning = true;
		panStartX = p.x;
		panStartY = p.y;
		panStartPanX = panX;
		panStartPanY = panY;
		canvas.classList.add('dragging');
		canvas.setPointerCapture(e.pointerId);
	}

	canvas.addEventListener('pointerdown', function (e) {
		hideContextMenu();
		hideInlineCreate();
		const p = canvasPos(e);
		downX = p.x;
		downY = p.y;
		pointerMoved = false;
		const hit = hitTest(p.x, p.y);

		// "Make workflow" picker: next implementation click chooses the workflow owner.
		if (pickWorkflowImpl && hit) {
			if (isImplementation(nodeById(hit))) {
				pickWorkflowImpl = false;
				vscode.postMessage({ type: 'buildWorkflow', id: hit });
			} else {
				setHint('Pick an implementation node.');
			}
			return;
		}

		if (workflowMode === 'build') {
			if (hit) {
				handleBuilderNodeClick(hit);
				return;
			}
			if (builder && builder.drawArrow && builder.arrowSource) {
				builder.arrowSource = '';
				setHint('Arrow cancelled.');
				draw();
			}
			beginPan(e, p);
			return;
		}
		if (workflowMode === 'play') {
			if (hit) {
				// allow opening a description during playback via a plain click
				dragNodeId = ''; // no drag in play mode
				playClickId = hit;
				beginPan(e, p);
				return;
			}
			beginPan(e, p);
			return;
		}

		// Normal mode.
		if (hit) {
			// Arm the link source on a single click (detail === 1), like the tags
			// graph. A double-click on a different node then completes the link.
			if ((e.detail || 1) === 1) {
				if (!linkSourceId || linkSourceId === hit) {
					linkSourceId = hit;
				}
			}
			dragNodeId = hit;
			const np = posOf(hit);
			const s = toScreen(np.x, np.y);
			dragOffsetX = s.x - p.x;
			dragOffsetY = s.y - p.y;
			canvas.classList.add('dragging');
			canvas.setPointerCapture(e.pointerId);
			selectedId = hit;
			renderSidebar();
			draw();
			return;
		}
		if (selectedId) {
			selectedId = '';
			renderSidebar();
		}
		if (linkSourceId) {
			linkSourceId = '';
			draw();
		}
		beginPan(e, p);
	});

	function handleBuilderNodeClick(id) {
		if (!builder) return;
		if (builder.drawArrow) {
			if (!builder.arrowSource) {
				builder.arrowSource = id;
				setHint('Arrow from "' + nodeName(id) + '" — click the target node.');
				draw();
			} else if (builder.arrowSource !== id) {
				addFlowToStep(builder.arrowSource, id);
				builder.arrowSource = '';
				setHint('Flow added. Set its label / type / nested workflow in the panel.');
			} else {
				builder.arrowSource = '';
				setHint('Arrow cancelled.');
				draw();
			}
			return;
		}
		toggleStepNode(id);
	}

	canvas.addEventListener('pointermove', function (e) {
		const p = canvasPos(e);
		if (dragNodeId && workflowMode === '') {
			if (Math.abs(p.x - downX) + Math.abs(p.y - downY) > 3) {
				const wx = (p.x + dragOffsetX - panX) / zoom;
				const wy = (p.y + dragOffsetY - panY) / zoom;
				nodePos.set(dragNodeId, { x: wx, y: wy });
				pointerMoved = true;
				draw();
			}
			return;
		}
		if (panning) {
			panX = panStartPanX + (p.x - panStartX);
			panY = panStartPanY + (p.y - panStartY);
			if (Math.abs(p.x - downX) + Math.abs(p.y - downY) > 3) pointerMoved = true;
			draw();
			return;
		}
		const hit = hitTest(p.x, p.y);
		if (hit !== hoverId) {
			hoverId = hit;
			if (hit) {
				const n = nodeById(hit);
				hoverLabel.textContent = n ? typeLabel(n.type) + ': ' + n.name : '';
				hoverLabel.hidden = false;
				hoverLabel.style.left = Math.min(p.x + 12, wrap.clientWidth - 200) + 'px';
				hoverLabel.style.top = Math.min(p.y + 12, wrap.clientHeight - 40) + 'px';
			} else {
				hoverLabel.hidden = true;
			}
		}
	});

	canvas.addEventListener('pointerup', function (e) {
		if (dragNodeId && workflowMode === '') {
			const np = nodePos.get(dragNodeId);
			if (np && pointerMoved) {
				vscode.postMessage({ type: 'moveEntity', id: dragNodeId, x: np.x, y: np.y });
			}
			dragNodeId = '';
			canvas.classList.remove('dragging');
			return;
		}
		if (playClickId && !pointerMoved && workflowMode === 'play') {
			vscode.postMessage({ type: 'openDescription', id: playClickId });
		}
		playClickId = '';
		panning = false;
		canvas.classList.remove('dragging');
	});

	canvas.addEventListener('pointerleave', function () {
		if (!dragNodeId && !panning) {
			hoverId = '';
			hoverLabel.hidden = true;
		}
	});

	canvas.addEventListener('dblclick', function (e) {
		if (workflowMode !== '') return; // no dblclick actions in workflow modes
		const p = canvasPos(e);
		const hit = hitTest(p.x, p.y);
		if (!hit) return;
		// A node is armed as the link source → double-click completes the link.
		if (linkSourceId && linkSourceId !== hit) {
			vscode.postMessage({ type: 'addLink', from: linkSourceId, to: hit });
			setHint('Linked ' + nodeName(linkSourceId) + ' \u2192 ' + nodeName(hit) + '.');
			linkSourceId = '';
			selectedId = hit;
			draw();
			return;
		}
		// No source → double-click alone opens the node.
		const n = nodeById(hit);
		if (n && n.type === 'implementation') {
			vscode.postMessage({ type: 'playWorkflow', id: hit });
		} else {
			vscode.postMessage({ type: 'openDescription', id: hit });
		}
	});

	canvas.addEventListener('contextmenu', function (e) {
		e.preventDefault();
		if (workflowMode !== '') return; // no context menu while building/playing
		const p = canvasPos(e);
		ctxPos = { x: p.x, y: p.y };
		const hit = hitTest(p.x, p.y);
		if (hit) {
			const n = nodeById(hit);
			selectedId = hit;
			linkContext = null;
			renderSidebar();
			draw();
			if (isFeature(n)) {
				hideContextMenu();
				return;
			}
			const items = [];
			if (isImplementation(n)) {
				items.push({ label: 'Rename', action: 'rename' });
				if (n.hasWorkflow) {
					items.push({ label: 'Play workflow', action: 'playWorkflow' });
					items.push({ label: 'Edit workflow', action: 'buildWorkflow' });
				} else {
					items.push({ label: 'Create workflow', action: 'buildWorkflow' });
				}
				items.push({ label: 'Delete', action: 'delete', danger: true });
			} else {
				items.push({ label: 'Rename', action: 'rename' });
				items.push({ label: 'Delete', action: 'delete', danger: true });
			}
			showContextMenu(items, p.x, p.y);
			return;
		}
		// Free link (arrow) hit → edge actions.
		const linkHit = hitTestLink(p.x, p.y);
		if (linkHit) {
			linkContext = { source: linkHit.source, relation: linkHit.relation, target: linkHit.target };
			showContextMenu([
				{ label: 'Delete this link', action: 'deleteLink', danger: true },
				{ label: 'Add reverse link', action: 'reverseLink' }
			], p.x, p.y);
			return;
		}
		linkContext = null;
		showContextMenu([
			{ label: 'New component', action: 'newComponent' },
			{ label: 'New implementation', action: 'newImplementation' }
		], p.x, p.y);
	});

	canvas.addEventListener('wheel', function (e) {
		e.preventDefault();
		const p = canvasPos(e);
		const before = toWorld(p.x, p.y);
		const factor = e.deltaY < 0 ? 1.1 : 0.9;
		zoom = Math.max(0.3, Math.min(3, zoom * factor));
		panX = p.x - before.x * zoom;
		panY = p.y - before.y * zoom;
		draw();
	}, { passive: false });

	document.addEventListener('pointerdown', function (e) {
		const t = e.target;
		if (t === canvas) return;
		const inlineEl = document.getElementById('archInlineEdit');
		if (inlineEl && inlineEl.contains(t)) return;
		if (ctxMenu && ctxMenu.contains(t)) return; // the item's click handler acts
		// Any click outside the canvas and context menu dismisses the menu and inline box.
		hideContextMenu();
		hideInlineCreate();
		if (sidebar.contains(t)) return; // keep selection while using the sidebar
		if (workflowMode === '') {
			if (selectedId) {
				selectedId = '';
				renderSidebar();
			}
			if (linkSourceId) {
				linkSourceId = '';
				draw();
			}
		}
	});

	window.addEventListener('keydown', function (e) {
		if (e.key === 'Escape') {
			if (workflowMode === 'build') {
				exitWorkflowMode();
				return;
			}
			if (workflowMode === 'play') {
				exitWorkflowMode();
				return;
			}
			if (createMode) {
				createMode = '';
				renderSidebar();
			}
		} else if (e.key === 'Delete' && selectedId && workflowMode === '' && !isFeature(nodeById(selectedId))) {
			vscode.postMessage({ type: 'deleteEntity', id: selectedId });
			selectedId = '';
			renderSidebar();
		}
	});

	// ---- messages -------------------------------------------------------

	window.addEventListener('message', function (event) {
		const msg = event.data || {};
		if (msg.type === 'graph') {
			nodes = (msg.nodes || []).map(n => ({ id: String(n.id), type: String(n.type), name: String(n.name), parentId: n.parentId || null, featureId: n.featureId || null, descriptionFile: n.descriptionFile || '', hasWorkflow: !!n.hasWorkflow, x: n.x, y: n.y }));
			links = (msg.links || []).map(l => ({ source: String(l.source), relation: String(l.relation || 'uses'), target: String(l.target) }));
			projectEl.textContent = msg.projectTitle || '';
			const firstLoad = !loadedOnce;
			if (!nodes.some(n => n.id === selectedId)) selectedId = '';
			createMode = '';
			nodePos = layoutPass();
			if (firstLoad) {
				loadedOnce = true;
				panX = wrap.clientWidth / 2;
				panY = wrap.clientHeight / 2;
				zoom = 1;
			}
			const count = nodes.length;
			setHint(count ? count + ' node(s) — click to select, drag to move, double-click to link/open, wheel to zoom.' : 'No architecture yet. Use the toolbar or right-click the canvas to add components and implementations.');
			renderSidebar();
			draw();
		}
		if (msg.type === 'workflowData') {
			const name = String(msg.name || 'Untitled');
			if (msg.mode === 'play') enterPlayMode(String(msg.workflowId || ''), name, msg.steps || []);
			else enterBuildMode(String(msg.workflowId || ''), name, msg.steps || []);
		}
		if (msg.type === 'workflowSaved') {
			setHint('Workflow saved.');
			exitWorkflowMode();
		}
		if (msg.type === 'error') {
			setHint('Error: ' + (msg.message || 'unknown'));
		}
	});

	window.addEventListener('resize', resizeCanvas);
	resizeCanvas();
	bindHeader();
	bindWorkflowBar();
	bindInlineCreate();
	renderSidebar();
	vscode.postMessage({ type: 'ready' });
})();
