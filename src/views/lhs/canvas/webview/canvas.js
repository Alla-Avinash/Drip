(function () {
	const vscode = acquireVsCodeApi();
	const _persisted = vscode.getState() || {};

	const CANVAS_VIEW_CLASSIC = 'classic';
	const CANVAS_VIEW_GRAPH = 'graph';
	const CANVAS_VIEW_TEARDROP = 'teardrop';
	const CANVAS_VIEW_NODE_GRAPH = 'nodegraph';

	const state = {
		types: [],
		visibleTypeIds: [],
		canvasShowUntyped: true,
		docs: [],
		highlightPath: '',
		mode: 'empty',
		canvasView: normalizeCanvasView(_persisted.canvasView),
		nodeGraphVisibleRelations: new Set(),
		nodeGraphKnownRelations: new Set()
	};

	/** File-local node graph — same force defaults as tags graph. */
	const NG = {
		NODE_W: 140,
		NODE_H: 64,
		ORIGIN: 450,
		forceCenter: 0.03,
		forceRepel: 10,
		forceLink: 0.75,
		linkDistance: 80,
		minSep: 78
	};
	/** @type {Map<string, { id: string, x: number, y: number, vx: number, vy: number, title: string, badge: string, root: boolean }>} */
	const nodeGraphSim = new Map();
	/** @type {any[]} */
	let nodeGraphEdges = [];
	let nodeGraphRaf = 0;
	let nodeGraphLastKick = 0;
	let nodeGraphDrag = null;

	/** @type {Set<string>} */
	const collapsedHeadingGids = new Set();
	/** Gids where ↑ “parent / siblings / ancestors” emphasis is toggled on. */
	const navParentActive = new Set();
	/** Gids where ↓ “this subtree” emphasis is toggled on. */
	const navChildActive = new Set();

	const BOX_W = 248;
	const BOX_H = 56;
	const COL_GAP = 280;
	const ROW_GAP = 72;
	const H_SIBLING_GAP = 40;
	const WORKFLOW_ROW_GAP = 96;
	/** Compact folder-tree indent per hierarchy level (vertical stack below parent). */
	const TREE_INDENT = 24;
	const TREE_ROW_GAP = 20;
	const DOC_PAD_X = 48;
	/** Top padding below file label strip */
	const DOC_BLOCK_TOP = 56;

	/** Graph view metrics (parent centered, L→R hierarchy). */
	const G_GRAPH = {
		BOX_W: 176,
		BOX_H: 34,
		COL_GAP: 268,
		ROW_GAP: 40,
		ROOT_GAP: 56,
		DOC_TOP: 56,
		EDGE_CTRL: 0.48
	};

	/** Tear drop: compact shortcut badges, denser L→R. */
	const G_TEAR = {
		BOX_W: 20,
		BOX_H: 20,
		COL_GAP: 72,
		ROW_GAP: 12,
		ROOT_GAP: 18,
		DOC_TOP: 56,
		EDGE_CTRL: 0.45
	};

	/** Active L→R layout metrics (mutated for graph vs tear drop). */
	const G = Object.assign({}, G_GRAPH);

	/**
	 * @param {string | undefined} v
	 * @returns {string}
	 */
	function normalizeCanvasView(v) {
		if (
			v === CANVAS_VIEW_GRAPH ||
			v === CANVAS_VIEW_TEARDROP ||
			v === CANVAS_VIEW_NODE_GRAPH ||
			v === CANVAS_VIEW_CLASSIC
		) return v;
		return CANVAS_VIEW_CLASSIC;
	}

	function isLtrCanvasView() {
		return (
			state.canvasView === CANVAS_VIEW_GRAPH || state.canvasView === CANVAS_VIEW_TEARDROP
		);
	}

	function syncLayoutMetrics() {
		const src = state.canvasView === CANVAS_VIEW_TEARDROP ? G_TEAR : G_GRAPH;
		Object.assign(G, src);
	}

	function activeBoxW() {
		if (state.canvasView === CANVAS_VIEW_TEARDROP) return G.BOX_W;
		if (state.canvasView === CANVAS_VIEW_GRAPH) return G.BOX_W;
		return BOX_W;
	}

	function activeBoxH() {
		if (state.canvasView === CANVAS_VIEW_TEARDROP) return G.BOX_H;
		if (state.canvasView === CANVAS_VIEW_GRAPH) return G.BOX_H;
		return BOX_H;
	}

	function applyCanvasViewBodyClass() {
		document.body.classList.toggle('view-graph', state.canvasView === CANVAS_VIEW_GRAPH);
		document.body.classList.toggle('view-teardrop', state.canvasView === CANVAS_VIEW_TEARDROP);
		document.body.classList.toggle('view-nodegraph', state.canvasView === CANVAS_VIEW_NODE_GRAPH);
		document.body.classList.toggle('view-classic', state.canvasView === CANVAS_VIEW_CLASSIC);
		const filter = $('node-graph-filter');
		if (filter) filter.classList.toggle('hidden', state.canvasView !== CANVAS_VIEW_NODE_GRAPH);
		if (state.canvasView !== CANVAS_VIEW_NODE_GRAPH) stopNodeGraphSim();
	}

	function persistCanvasView() {
		vscode.setState({ ...(vscode.getState() || {}), canvasView: state.canvasView });
	}

	/**
	 * Shortcut badge for tear drop: `.t2` / `.c` / `.p`, else `#`.
	 * @param {string} title
	 * @returns {string}
	 */
	function tearDropBadge(title) {
		const t = String(title || '').trim();
		const tid = t.match(/^(\.t\d+)\b/i);
		if (tid) return tid[1].toLowerCase();
		const sc = t.match(/^(\.[a-zA-Z][\w]*)\b/);
		if (sc) return sc[1].toLowerCase();
		return '#';
	}

	const view = {
		tx: 40,
		ty: 40,
		scale: 1,
		minScale: 0.25,
		maxScale: 2.5,
		panning: false,
		lastX: 0,
		lastY: 0
	};

	function $(id) {
		return document.getElementById(id);
	}

	function escapeHtml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function parseUriList(text) {
		const out = [];
		for (const line of String(text || '').split(/\r?\n/)) {
			const t = line.trim();
			if (!t || t.startsWith('#')) continue;
			out.push(...urisFromSingleUriString(t));
		}
		return out;
	}

	/** VS Code / Electron: real path for a dropped File (see vscode platform/dnd getPathForFile). */
	function getHostPathForFile(file) {
		if (!file) return '';
		try {
			const g = /** @type {*} */ (globalThis);
			const fn = g.vscode && g.vscode.webUtils && g.vscode.webUtils.getPathForFile;
			if (typeof fn === 'function') {
				const p = fn(file);
				if (p && typeof p === 'string') return p;
			}
		} catch (_) {
			/* ignore */
		}
		const legacy = /** @type {*} */ (file).path;
		return legacy && typeof legacy === 'string' ? legacy : '';
	}

	/**
	 * One URI string → local fs path if `file:`, else '' (caller may keep full URI for the host).
	 * @param {string} raw
	 * @returns {string}
	 */
	function fileUriToFsPath(raw) {
		const t = String(raw || '').trim();
		if (!t.toLowerCase().startsWith('file:')) return '';
		try {
			const u = new URL(t);
			let p = decodeURIComponent(u.pathname.replace(/\+/g, '%20'));
			if (/^\/[a-zA-Z]:\//.test(p)) {
				p = p.slice(1).replace(/\//g, '\\');
			}
			return p;
		} catch (_) {
			return '';
		}
	}

	/**
	 * @param {string} t
	 * @returns {string[]}
	 */
	function urisFromSingleUriString(t) {
		const s = String(t || '').trim();
		if (!s || s.startsWith('#')) return [];
		const lower = s.toLowerCase();
		if (!lower.endsWith('.d.txt')) return [];
		if (lower.startsWith('file:')) {
			const p = fileUriToFsPath(s);
			return p ? [p] : [];
		}
		/* vscode-remote, untitled, etc. — pass through for extension host */
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return [s];
		return [];
	}

	/**
	 * Explorer / tabs set `ResourceURLs` (JSON array of URI strings). See vscode DataTransfers.RESOURCES.
	 * @param {DataTransfer} dt
	 * @returns {string[]}
	 */
	function pathsFromResourceUrls(dt) {
		const raw =
			dt.getData('ResourceURLs') ||
			dt.getData('resourceurls') ||
			dt.getData('resourceUrls');
		if (!raw) return [];
		try {
			const arr = JSON.parse(raw);
			if (!Array.isArray(arr)) return [];
			const out = [];
			for (const s of arr) {
				if (typeof s !== 'string') continue;
				const local = fileUriToFsPath(s);
				if (local && local.toLowerCase().endsWith('.d.txt')) {
					out.push(local);
					continue;
				}
				if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && s.toLowerCase().endsWith('.d.txt')) {
					out.push(s);
				}
			}
			return out;
		} catch (_) {
			return [];
		}
	}

	/**
	 * Native OS paths from VS Code — `CodeFiles` is JSON string array of fs paths.
	 * @param {DataTransfer} dt
	 */
	function pathsFromCodeFiles(dt) {
		const raw = dt.getData('CodeFiles') || dt.getData('codefiles');
		if (!raw) return [];
		try {
			const arr = JSON.parse(raw);
			if (!Array.isArray(arr)) return [];
			return arr.filter(x => typeof x === 'string' && x.toLowerCase().endsWith('.d.txt'));
		} catch (_) {
			return [];
		}
	}

	function tryParseResourceUrlsJson(raw) {
		const out = [];
		if (!raw) return out;
		try {
			const arr = JSON.parse(raw);
			if (!Array.isArray(arr)) return out;
			for (const s of arr) {
				if (typeof s !== 'string') continue;
				const local = fileUriToFsPath(s);
				if (local && local.toLowerCase().endsWith('.d.txt')) {
					out.push(local);
					continue;
				}
				if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && s.toLowerCase().endsWith('.d.txt')) {
					out.push(s);
				}
			}
		} catch (_) {
			/* ignore */
		}
		return out;
	}

	function tryParseCodeFilesJson(raw) {
		if (!raw) return [];
		try {
			const arr = JSON.parse(raw);
			if (!Array.isArray(arr)) return [];
			return arr.filter(x => typeof x === 'string' && x.toLowerCase().endsWith('.d.txt'));
		} catch (_) {
			return [];
		}
	}

	/**
	 * VS Code / Chromium only populate some MIME data when `getData` is called with
	 * the exact type from `dataTransfer.types` (per entry in the spec).
	 * @param {DataTransfer} dt
	 * @returns {string[]}
	 */
	function pathsFromDeclaredMimeTypes(dt) {
		const out = [];
		const types = dt.types ? Array.from(dt.types) : [];
		for (const mime of types) {
			let data = '';
			try {
				data = dt.getData(mime);
			} catch (_) {
				continue;
			}
			if (!data) continue;
			const lower = String(mime).toLowerCase();
			if (lower === 'resourceurls') {
				out.push(...tryParseResourceUrlsJson(data));
			} else if (lower === 'codefiles') {
				out.push(...tryParseCodeFilesJson(data));
			} else if (
				lower.indexOf('uri') >= 0 ||
				lower === 'text/plain' ||
				lower.indexOf('vnd.code') >= 0
			) {
				out.push(...parseUriList(data));
			}
		}
		return out;
	}

	/**
	 * @param {DragEvent} e
	 * @returns {Promise<string[]>}
	 */
	async function pathsFromDropAsync(e) {
		const out = [];
		const dt = e.dataTransfer;
		if (!dt) return out;

		out.push(...pathsFromDeclaredMimeTypes(dt));
		out.push(...pathsFromResourceUrls(dt));
		out.push(...pathsFromCodeFiles(dt));

		const sync =
			dt.getData('application/vnd.code.uri-list') ||
			dt.getData('text/uri-list') ||
			dt.getData('text/plain') ||
			'';
		out.push(...parseUriList(sync));

		if (dt.files && dt.files.length) {
			for (let i = 0; i < dt.files.length; i++) {
				const f = dt.files[i];
				const p = getHostPathForFile(f);
				if (p && p.toLowerCase().endsWith('.d.txt')) out.push(p);
			}
		}

		if (dt.items && dt.items.length) {
			for (let i = 0; i < dt.items.length; i++) {
				const it = dt.items[i];
				if (it.kind === 'file') {
					try {
						const f = typeof it.getAsFile === 'function' ? it.getAsFile() : null;
						if (f) {
							const p = getHostPathForFile(f);
							if (p && p.toLowerCase().endsWith('.d.txt')) out.push(p);
						}
					} catch (_) {
						/* ignore */
					}
					continue;
				}
				if (it.kind === 'string') {
					const ty = it.type || '';
					const tyLower = ty.toLowerCase();
					if (
						ty.indexOf('uri') >= 0 ||
						ty === 'text/plain' ||
						tyLower === 'resourceurls' ||
						tyLower === 'codefiles'
					) {
						const s = await new Promise(res => {
							try {
								it.getAsString(str => res(str || ''));
							} catch (_) {
								res('');
							}
						});
						if (tyLower === 'resourceurls') {
							out.push(...tryParseResourceUrlsJson(s));
						} else if (tyLower === 'codefiles') {
							out.push(...tryParseCodeFilesJson(s));
						} else {
							out.push(...parseUriList(s));
						}
					}
				}
			}
		}

		const uniq = [];
		const seen = Object.create(null);
		for (const p of out) {
			const k = String(p).trim();
			if (!k || seen[k]) continue;
			seen[k] = true;
			uniq.push(k);
		}
		return uniq;
	}

	/**
	 * @param {any[]} nodes
	 * @param {number} docIdx
	 * @param {number} depth
	 * @param {string | null} parentGid
	 * @param {any[]} acc
	 * @param {Set<string>} collapsed
	 */
	function flattenHeadingsVisible(nodes, docIdx, depth, parentGid, acc, collapsed) {
		for (const n of nodes || []) {
			const gid = 'g-' + docIdx + '-' + n.lineIndex + '-' + n.tabDepth;
			const children = n.children || [];
			const hasChildren = children.length > 0;
			const lvl = Math.min(Math.max(Number(n.level) || 1, 1), 6);
			acc.push({
				gid,
				parentGid,
				title: n.title,
				level: lvl,
				depth,
				docIdx,
				hasChildren
			});
			if (!collapsed.has(gid)) {
				flattenHeadingsVisible(children, docIdx, depth + 1, gid, acc, collapsed);
			}
		}
	}

	function docLabelKeyFromDoc(doc) {
		const fl = String(doc.fileLabel || '');
		return fl.split(' (from heading)')[0].trim();
	}

	function tryFsNormKey(s) {
		const t = String(s || '').trim();
		if (/^file:/i.test(t)) {
			try {
				const u = new URL(t);
				let p = decodeURIComponent(u.pathname.replace(/\+/g, '%20'));
				if (/^\/[a-zA-Z]:\//.test(p)) {
					p = p.slice(1).replace(/\//g, '\\');
				}
				return p.toLowerCase();
			} catch (_) {
				/* ignore */
			}
		}
		return t.replace(/\//g, '\\').toLowerCase();
	}

	function docMatchesHighlight(doc, highlight) {
		if (!highlight) return false;
		const dl = docLabelKeyFromDoc(doc);
		return tryFsNormKey(dl) === tryFsNormKey(highlight);
	}

	function gidOf(docIdx, n) {
		return 'g-' + docIdx + '-' + n.lineIndex + '-' + n.tabDepth;
	}

	function docIdxFromGid(gid) {
		const m = String(gid).match(/^g-(\d+)-/);
		return m ? Number(m[1]) : -1;
	}

	function getRootsForDoc(docIdx) {
		const doc = state.docs[docIdx];
		return doc && doc.headingRoots ? doc.headingRoots : [];
	}

	function findHeadingNode(nodes, docIdx, gid) {
		for (const n of nodes || []) {
			if (gidOf(docIdx, n) === gid) return n;
			const f = findHeadingNode(n.children || [], docIdx, gid);
			if (f) return f;
		}
		return null;
	}

	/**
	 * @param {any[]} nodes
	 * @param {number} docIdx
	 * @param {string} targetGid
	 * @returns {string[] | null} chain from root to target
	 */
	function findPathToGid(nodes, docIdx, targetGid) {
		for (const n of nodes || []) {
			const g = gidOf(docIdx, n);
			if (g === targetGid) return [g];
			const sub = findPathToGid(n.children || [], docIdx, targetGid);
			if (sub) return [g].concat(sub);
		}
		return null;
	}

	/**
	 * Ancestors chain ∪ siblings at same level (same parent) ∪ anchor — “above + peers”.
	 * @param {any[]} roots
	 * @param {number} docIdx
	 * @param {string} anchorGid
	 */
	function parentNavHighlightSet(roots, docIdx, anchorGid) {
		const set = new Set();
		const path = findPathToGid(roots, docIdx, anchorGid);
		if (!path) return set;
		path.forEach(g => set.add(g));
		let level = roots || [];
		if (path.length >= 2) {
			const parentGid = path[path.length - 2];
			const parentNode = findHeadingNode(roots, docIdx, parentGid);
			level = parentNode && parentNode.children ? parentNode.children : [];
		}
		for (const n of level) {
			set.add(gidOf(docIdx, n));
		}
		return set;
	}

	/**
	 * Anchor ∪ all descendants.
	 * @param {any[]} roots
	 * @param {number} docIdx
	 * @param {string} anchorGid
	 */
	function childNavHighlightSet(roots, docIdx, anchorGid) {
		const node = findHeadingNode(roots, docIdx, anchorGid);
		const set = new Set();
		if (!node) return set;
		function walk(n) {
			set.add(gidOf(docIdx, n));
			for (const ch of n.children || []) walk(ch);
		}
		walk(node);
		return set;
	}

	function mergeNavHighlights() {
		const parentHl = new Set();
		const childHl = new Set();
		for (const anchor of navParentActive) {
			const di = docIdxFromGid(anchor);
			if (di < 0) continue;
			parentNavHighlightSet(getRootsForDoc(di), di, anchor).forEach(g => parentHl.add(g));
		}
		for (const anchor of navChildActive) {
			const di = docIdxFromGid(anchor);
			if (di < 0) continue;
			childNavHighlightSet(getRootsForDoc(di), di, anchor).forEach(g => childHl.add(g));
		}
		return { parentHl, childHl };
	}

	function taskIdInTitle(title) {
		const m = String(title || '')
			.trim()
			.match(/^\.t(\d+)\b/i);
		if (!m) return null;
		const n = parseInt(m[1], 10);
		return Number.isFinite(n) && n > 0 ? n : null;
	}

	/**
	 * @param {any[]} nodes
	 * @param {Map<number, any>} [map]
	 */
	function buildLineIndexMap(nodes, map) {
		const out = map || new Map();
		for (const n of nodes || []) {
			out.set(n.lineIndex, n);
			buildLineIndexMap(n.children || [], out);
		}
		return out;
	}

	/**
	 * @param {any[]} nodes
	 * @param {number} di
	 * @param {string} wfGid
	 * @returns {any | null}
	 */
	function findNodeByGid(nodes, di, wfGid) {
		for (const n of nodes || []) {
			if (gidOf(di, n) === wfGid) return n;
			const found = findNodeByGid(n.children || [], di, wfGid);
			if (found) return found;
		}
		return null;
	}

	/**
	 * True when the workflow root sits inside a larger heading tree (not wf-only canvas).
	 * @param {any[]} roots
	 * @param {string} wfGid
	 * @param {number} di
	 */
	function workflowIsEmbedded(roots, wfGid, di) {
		if (!wfGid || !roots || !roots.length) return false;
		if (roots.length === 1 && gidOf(di, roots[0]) === wfGid) return false;
		return !!findNodeByGid(roots, di, wfGid);
	}

	/**
	 * Tree flatten that skips workflow DAG task nodes (placed by embedded DAG layout).
	 * @param {any[]} nodes
	 * @param {number} di
	 * @param {number} depth
	 * @param {string | null} parentGid
	 * @param {any[]} acc
	 * @param {Set<string>} collapsed
	 * @param {string} wfGid
	 * @param {Set<number>} dagLineSet
	 */
	function flattenUnifiedTree(nodes, di, depth, parentGid, acc, collapsed, wfGid, dagLineSet) {
		for (const n of nodes || []) {
			const gid = gidOf(di, n);
			if (dagLineSet.has(n.lineIndex) && gid !== wfGid) continue;

			const isWfRoot = gid === wfGid;
			const children = n.children || [];
			const hasChildren =
				isWfRoot ||
				children.some(ch => {
					const cg = gidOf(di, ch);
					return cg === wfGid || !dagLineSet.has(ch.lineIndex);
				});
			const lvl = Math.min(Math.max(Number(n.level) || 1, 1), 6);

			acc.push({
				node: n,
				gid,
				parentGid,
				title: n.title,
				level: lvl,
				depth,
				docIdx: di,
				hasChildren,
				isWfRoot
			});

			if (!collapsed.has(gid) && !isWfRoot) {
				flattenUnifiedTree(children, di, depth + 1, gid, acc, collapsed, wfGid, dagLineSet);
			}
		}
	}

	/**
	 * One connected graph: document tree + workflow DAG embedded under the workflow heading.
	 * @returns {number} block width
	 */
	function layoutUnifiedDoc(di, doc, docBaseX, label, roots, cells, edgePairs, posByGid, groupFrames) {
		const wg = doc.workflowGraph;
		if (!wg || wg.mode !== 'workflow') return 0;

		const wfGid = wg.wfGid;
		const dagLineSet = new Set((wg.tasks || []).map(t => t.lineIndex));

		const flat = [];
		flattenUnifiedTree(roots, di, 0, null, flat, collapsedHeadingGids, wfGid, dagLineSet);
		if (!flat.length) return 0;

		let y = DOC_BLOCK_TOP;
		let maxDepth = 0;
		let maxRight = docBaseX + BOX_W;

		for (const f of flat) {
			const x = docBaseX + f.depth * COL_GAP;
			maxDepth = Math.max(maxDepth, f.depth);
			const cell = {
				gid: f.gid,
				parentGid: f.parentGid,
				x,
				y,
				depth: f.depth,
				title: f.title,
				level: f.level,
				docIdx: di,
				fileShort: label,
				hasChildren: !!f.hasChildren
			};
			cells.push(cell);
			posByGid[f.gid] = cell;

			if (f.parentGid && posByGid[f.parentGid]) {
				const pa = posByGid[f.parentGid];
				edgePairs.push({
					x1: pa.x + BOX_W,
					y1: pa.y + BOX_H / 2,
					x2: cell.x,
					y2: cell.y + BOX_H / 2
				});
			}

			let bottom = y + BOX_H;
			if (f.isWfRoot) {
				const dagExtent = layoutWorkflowDagUnderParent(
					cell,
					di,
					doc,
					label,
					cells,
					edgePairs,
					posByGid,
					groupFrames
				);
				bottom = Math.max(bottom, dagExtent.bottom);
				maxRight = Math.max(maxRight, dagExtent.maxRight);
			}

			y = bottom + ROW_GAP;
		}

		return Math.max((maxDepth + 1) * COL_GAP + BOX_W + DOC_PAD_X, maxRight - docBaseX + DOC_PAD_X);
	}

	/**
	 * DAG rows + doc hierarchy under an already-placed workflow root cell.
	 * @returns {{ bottom: number, maxRight: number }}
	 */
	function layoutWorkflowDagUnderParent(wfCell, di, doc, label, cells, edgePairs, posByGid, groupFrames) {
		const wg = doc.workflowGraph;
		if (!wg || wg.mode !== 'workflow') return { bottom: wfCell.y + BOX_H, maxRight: wfCell.x + BOX_W };

		const tasks = (wg.tasks || []).filter(t => t.taskId);
		const dagTaskIds = new Set(tasks.map(t => t.taskId));
		const nodeByLine = buildLineIndexMap(doc.headingRoots || []);

		const byId = new Map();
		for (const t of tasks) byId.set(t.taskId, t);

		const level = new Map();
		function taskLevel(id, visiting) {
			if (level.has(id)) return level.get(id);
			if (visiting.has(id)) return 0;
			visiting.add(id);
			const t = byId.get(id);
			if (!t || !t.parentTaskIds.length) {
				level.set(id, 0);
				visiting.delete(id);
				return 0;
			}
			let maxP = -1;
			for (const pid of t.parentTaskIds) maxP = Math.max(maxP, taskLevel(pid, visiting));
			const l = maxP + 1;
			level.set(id, l);
			visiting.delete(id);
			return l;
		}
		for (const t of tasks) taskLevel(t.taskId, new Set());

		const byLevel = new Map();
		for (const t of tasks) {
			const l = level.get(t.taskId) || 0;
			if (!byLevel.has(l)) byLevel.set(l, []);
			byLevel.get(l).push(t);
		}

		const levels = [...byLevel.keys()].sort((a, b) => a - b);
		const blockCenter = wfCell.x + BOX_W / 2;

		const wfNode = findNodeByGid(doc.headingRoots || [], di, wg.wfGid);
		const sideX = wfCell.x + TREE_INDENT;
		let sideBottom = layoutWfNonDagSiblings(
			wfNode,
			wfCell,
			di,
			label,
			dagTaskIds,
			sideX,
			cells,
			edgePairs,
			posByGid,
			groupFrames,
			nodeByLine
		);

		let maxRight = wfCell.x + BOX_W;
		if (!tasks.length) {
			return { bottom: Math.max(wfCell.y + BOX_H, sideBottom), maxRight };
		}

		let nextRowY = Math.max(wfCell.y + BOX_H + WORKFLOW_ROW_GAP, sideBottom + TREE_ROW_GAP);

		for (const lvl of levels) {
			const group = byLevel.get(lvl);
			assignCenteredRowX(group, blockCenter);
			const rowY = nextRowY;

			let rowBottom = rowY + BOX_H;
			for (const t of group) {
				const treeNode = nodeByLine.get(t.lineIndex);
				const hasDocChildren = !!treeNode && hasNestedDocChildren(treeNode, dagTaskIds);
				const cell = {
					gid: t.gid,
					parentGid: wg.wfGid,
					x: t._x,
					y: rowY,
					depth: (wfCell.depth || 0) + lvl + 1,
					title: t.title,
					level: 2,
					docIdx: di,
					fileShort: label,
					hasChildren: hasDocChildren,
					hierarchyDepth: hasDocChildren ? 0 : undefined
				};
				cells.push(cell);
				posByGid[t.gid] = cell;
				maxRight = Math.max(maxRight, cell.x + BOX_W);

				if (!t.parentTaskIds.length) {
					pushVerticalEdge(edgePairs, wfCell, cell);
				} else {
					for (const pid of t.parentTaskIds) {
						if (wg.rootTaskId && pid === wg.rootTaskId) {
							pushVerticalEdge(edgePairs, wfCell, cell);
							continue;
						}
						const parentTask = byId.get(pid);
						if (!parentTask || !posByGid[parentTask.gid]) continue;
						pushVerticalEdge(edgePairs, posByGid[parentTask.gid], cell);
					}
				}

				if (treeNode && hasDocChildren) {
					const subBottom = layoutDocSubtreeUnder(
						cell,
						treeNode,
						di,
						label,
						dagTaskIds,
						t.gid,
						null,
						nodeByLine,
						cells,
						edgePairs,
						posByGid,
						groupFrames
					);
					rowBottom = Math.max(rowBottom, subBottom);
					pushTaskGroupFrame(groupFrames, cell, cells);
					maxRight = Math.max(maxRight, cell.x + BOX_W + TREE_INDENT * 3);
				}
			}

			nextRowY = rowBottom + WORKFLOW_ROW_GAP;
		}

		for (const c of cells) {
			if (c.docIdx !== di) continue;
			maxRight = Math.max(maxRight, c.x + BOX_W);
		}
		for (const g of groupFrames) {
			maxRight = Math.max(maxRight, g.x + g.w);
		}

		return { bottom: nextRowY - WORKFLOW_ROW_GAP + BOX_H, maxRight };
	}

	/**
	 * Column layout for a heading forest (non-workflow or outside wf subtree).
	 * @returns {number} block width
	 */
	function layoutStandardTreeBlock(di, docBaseX, label, roots, cells, edgePairs, posByGid) {
		const flat = [];
		flattenHeadingsVisible(roots, di, 0, null, flat, collapsedHeadingGids);
		if (!flat.length) return 0;

		let maxDepth = 0;
		for (const f of flat) maxDepth = Math.max(maxDepth, f.depth);

		for (let i = 0; i < flat.length; i++) {
			const f = flat[i];
			const x = docBaseX + f.depth * COL_GAP;
			const y = DOC_BLOCK_TOP + i * ROW_GAP;
			const cell = {
				gid: f.gid,
				parentGid: f.parentGid,
				x,
				y,
				depth: f.depth,
				title: f.title,
				level: f.level,
				docIdx: di,
				fileShort: label,
				hasChildren: !!f.hasChildren
			};
			cells.push(cell);
			posByGid[f.gid] = cell;
		}

		for (const f of flat) {
			if (!f.parentGid || !posByGid[f.parentGid]) continue;
			const pa = posByGid[f.parentGid];
			const pb = posByGid[f.gid];
			edgePairs.push({
				x1: pa.x + BOX_W,
				y1: pa.y + BOX_H / 2,
				x2: pb.x,
				y2: pb.y + BOX_H / 2
			});
		}

		return (maxDepth + 1) * COL_GAP + BOX_W + DOC_PAD_X;
	}

	/**
	 * Non-DAG headings under the workflow root (concepts, plain tasks, doc hierarchy).
	 * Rendered in a left column; DAG tasks stay in centered rows.
	 * @returns {number} lowest y + BOX_H
	 */
	function layoutWfNonDagSiblings(
		wfNode,
		wfCell,
		di,
		label,
		dagTaskIds,
		docBaseX,
		cells,
		edgePairs,
		posByGid,
		groupFrames,
		nodeByLine
	) {
		if (!wfNode || collapsedHeadingGids.has(wfCell.gid)) return wfCell.y + BOX_H;

		let y = wfCell.y + BOX_H + TREE_ROW_GAP;
		let maxBottom = wfCell.y + BOX_H;
		const sideX = docBaseX;

		for (const ch of wfNode.children || []) {
			const tid = taskIdInTitle(ch.title);
			if (tid && dagTaskIds.has(tid)) continue;

			const gid = gidOf(di, ch);
			if (posByGid[gid]) continue;

			const treeChild = nodeByLine.get(ch.lineIndex) || ch;
			const hasKids = hasNestedDocChildren(treeChild, dagTaskIds);
			const cell = {
				gid,
				parentGid: wfCell.gid,
				taskGroupGid: wfCell.gid,
				isDocHierarchy: true,
				hierarchyDepth: 0,
				x: sideX,
				y,
				depth: 1,
				title: ch.title,
				level: Math.min(Math.max(Number(ch.level) || 2, 1), 6),
				docIdx: di,
				fileShort: label,
				hasChildren: hasKids
			};
			cells.push(cell);
			posByGid[gid] = cell;
			pushTreeEdge(edgePairs, wfCell, cell);

			let subBottom = y + BOX_H;
			if (!collapsedHeadingGids.has(gid) && hasKids) {
				subBottom = layoutDocSubtreeUnder(
					cell,
					treeChild,
					di,
					label,
					dagTaskIds,
					wfCell.gid,
					null,
					nodeByLine,
					cells,
					edgePairs,
					posByGid,
					groupFrames
				);
				pushNestGroupFrame(groupFrames, cell, cells);
			}
			maxBottom = Math.max(maxBottom, subBottom);
			y = subBottom + TREE_ROW_GAP;
		}
		return maxBottom;
	}

	/**
	 * @param {any[]} items
	 * @param {number} centerX
	 * @returns {number} row width
	 */
	function rowWidthForItems(items) {
		if (!items.length) return 0;
		return items.length * BOX_W + Math.max(0, items.length - 1) * H_SIBLING_GAP;
	}

	/**
	 * @param {any[]} items
	 * @param {number} centerX
	 */
	function assignCenteredRowX(items, centerX) {
		const w = rowWidthForItems(items);
		let x = centerX - w / 2;
		for (const item of items) {
			item._x = x;
			x += BOX_W + H_SIBLING_GAP;
		}
		return w;
	}

	/** Workflow DAG: parent above → child below (center). */
	function pushVerticalEdge(edgePairs, fromCell, toCell) {
		edgePairs.push({
			kind: 'dag',
			fromGid: fromCell.gid,
			x1: fromCell.x + BOX_W / 2,
			y1: fromCell.y + BOX_H,
			x2: toCell.x + BOX_W / 2,
			y2: toCell.y
		});
	}

	/** Short folder-tree elbow: down from parent, then into indented child below. */
	function pushTreeEdge(edgePairs, fromCell, toCell) {
		const branchX = fromCell.x + TREE_INDENT;
		edgePairs.push({
			kind: 'tree',
			x1: branchX,
			y1: fromCell.y + BOX_H,
			x2: toCell.x,
			y2: toCell.y + BOX_H / 2
		});
	}

	/** Task DAG edges leave from the bottom of an expanded task's dashed frame. */
	function adjustDagEdgesForFrames(edgePairs, groupFrames) {
		const frameByGid = new Map((groupFrames || []).map(f => [f.gid, f]));
		for (const e of edgePairs) {
			if (e.kind !== 'dag' || !e.fromGid) continue;
			const frame = frameByGid.get(e.fromGid);
			if (!frame) continue;
			if (Math.abs(e.x2 - e.x1) >= Math.abs(e.y2 - e.y1)) {
				e.x1 = frame.x + frame.w;
				e.y1 = frame.y + frame.h / 2;
			} else {
				e.x1 = frame.x + frame.w / 2;
				e.y1 = frame.y + frame.h;
			}
		}
	}

	/** Standard canvas bezier (wide columns). */
	function edgePathD(e) {
		const mx = (e.x1 + e.x2) / 2;
		return (
			'M ' +
			e.x1 +
			' ' +
			e.y1 +
			' C ' +
			mx +
			' ' +
			e.y1 +
			', ' +
			mx +
			' ' +
			e.y2 +
			', ' +
			e.x2 +
			' ' +
			e.y2 +
			' '
		);
	}

	/**
	 * vxplain-style fan: leave parent horizontally, arrive at child horizontally.
	 * Straight only when explicitly marked (odd count / single / middle child).
	 */
	function graphEdgePathD(e) {
		if (e.straight === true) {
			return 'M ' + e.x1 + ' ' + e.y1 + ' L ' + e.x2 + ' ' + e.y2 + ' ';
		}
		const span = Math.max(48, (e.x2 - e.x1) * G.EDGE_CTRL);
		const c1x = e.x1 + span;
		const c2x = e.x2 - span;
		return (
			'M ' +
			e.x1 +
			' ' +
			e.y1 +
			' C ' +
			c1x +
			' ' +
			e.y1 +
			', ' +
			c2x +
			' ' +
			e.y2 +
			', ' +
			e.x2 +
			' ' +
			e.y2 +
			' '
		);
	}

	/**
	 * Tear drop edges: solid vertical / short solid horizontal / dotted horizontal.
	 * @param {any} e
	 * @returns {string}
	 */
	function tearDropEdgePathD(e) {
		return (
			'M ' +
			e.x1 +
			' ' +
			e.y1 +
			' L ' +
			e.x2 +
			' ' +
			e.y2 +
			' '
		);
	}

	/**
	 * @param {any[]} usedXs
	 * @param {number} desired
	 * @param {number} nudge
	 * @returns {number}
	 */
	function allocUniqueVertX(usedXs, desired, nudge) {
		let x = desired;
		let guard = 0;
		while (guard++ < 64 && usedXs.some(u => Math.abs(u - x) < nudge * 0.9)) {
			x += nudge;
		}
		usedXs.push(x);
		return x;
	}

	/**
	 * Tear-drop layout (graph-first, numbered tasks only):
	 * - Unique X and Y for every task tear
	 * - Direct children (single parent): solid vertical through parent + solid stubs
	 * - Multi-parent children: dotted H through each parent + join vertical + stubs
	 * - Placement order: roots → direct children of placed → multi-parent when all parents placed
	 * @returns {{ cells: any[], edgePairs: any[], worldW: number, worldH: number, docLabels: any[], groupFrames: any[] }}
	 */
	function layoutDocsTearDrop() {
		const docs = state.docs || [];
		/** @type {any[]} */
		const cells = [];
		/** @type {any[]} */
		const edgePairs = [];
		const groupFrames = [];
		const posByGid = Object.create(null);

		const STUB = 28;
		const PITCH_X = Math.max(36, G.BOX_W + 16);
		const PITCH_Y = Math.max(28, G.BOX_H + 12);
		const BUS_NUDGE = 12;
		const JOIN_GAP = 64;
		const DOC_TOP = G.DOC_TOP;

		/** @type {number[]} */
		const usedTaskXs = [];
		/** @type {number[]} */
		const usedTaskYs = [];
		/** @type {number[]} */
		const usedVertXs = [];

		function allocUniqueVertX(desired) {
			let x = desired;
			let guard = 0;
			while (guard++ < 80 && usedVertXs.some(u => Math.abs(u - x) < BUS_NUDGE * 0.9)) {
				x += BUS_NUDGE;
			}
			usedVertXs.push(x);
			return x;
		}

		/**
		 * Absolutely unique (x,y) among all numbered-task tear cells.
		 * @param {number} dx
		 * @param {number} dy
		 */
		function allocUniqueTaskXY(dx, dy) {
			let x = dx;
			let y = dy;
			let guard = 0;
			while (guard++ < 120) {
				const xHit = usedTaskXs.some(u => Math.abs(u - x) < BUS_NUDGE * 0.9);
				const yHit = usedTaskYs.some(u => Math.abs(u - y) < BUS_NUDGE * 0.9);
				if (!xHit && !yHit) break;
				if (xHit) x += PITCH_X;
				if (yHit) y += PITCH_Y;
			}
			usedTaskXs.push(x);
			usedTaskYs.push(y);
			return { x, y };
		}

		let xColumn = DOC_PAD_X;
		/** @type {{ x: number, text: string, docIdx: number }[]} */
		const docLabels = [];

		/**
		 * @param {any} wg
		 * @param {number} di
		 * @param {string} label
		 */
		function layoutWorkflowTearGraph(wg, di, label) {
			/** @type {any[]} */
			const tasks = (wg.tasks || []).filter(t => t && t.taskId).map(t => ({
				...t,
				parentTaskIds: (t.parentTaskIds || []).slice()
			}));
			if (!tasks.length) return;

			/*
			 * Workflow root (unnumbered `.t`) is not in wg.tasks — inject it for layout
			 * so growth is S₀={root} → directs {t1,t2} → … Root uses synthetic id 0
			 * (real tasks are always ≥ 1).
			 */
			const rootTaskId = wg.rootTaskId || 0;
			if (!tasks.some(t => t.taskId === rootTaskId) && wg.wfGid) {
				tasks.unshift({
					gid: wg.wfGid,
					lineIndex: -1,
					tabDepth: 0,
					title: wg.wfTitle || '.t',
					taskId: rootTaskId,
					parentTaskIds: [],
					isTask: true
				});
				for (const t of tasks) {
					if (t.taskId === rootTaskId) continue;
					if (!(t.parentTaskIds || []).length) t.parentTaskIds = [rootTaskId];
				}
			}

			/** @type {Map<number, any>} */
			const byId = new Map();
			for (const t of tasks) byId.set(t.taskId, t);

			/** @param {any} t */
			function parentIds(t) {
				return (t.parentTaskIds || []).filter(id => byId.has(id));
			}

			/** @type {Map<number, any[]>} */
			const directsOf = new Map();
			/** @type {any[]} */
			const multis = [];
			/** @type {any[]} */
			const roots = [];

			for (const t of tasks) {
				const ps = parentIds(t);
				if (ps.length === 0) {
					roots.push(t);
				} else if (ps.length === 1) {
					const p = ps[0];
					if (!directsOf.has(p)) directsOf.set(p, []);
					directsOf.get(p).push(t);
				} else {
					multis.push(t);
				}
			}
			for (const [, arr] of directsOf) {
				arr.sort((a, b) => a.lineIndex - b.lineIndex);
			}
			multis.sort((a, b) => a.lineIndex - b.lineIndex);
			roots.sort((a, b) => a.lineIndex - b.lineIndex);

			/** @type {Set<number>} */
			const placed = new Set();
			/** @type {Map<number, { busX: number, childMids: number[] }>} */
			const directBus = new Map();
			/** @type {Map<number, number>} -1 grow up (upper half), +1 grow down (lower half) */
			const expandDir = new Map();
			/** @type {Map<number, number>} */
			const parentDotY = new Map();
			/** @type {Map<number, number>} */
			const parentDotRight = new Map();

			/** Mid-line through first workflow task when it has 2+ directs. */
			let midLineY = null;
			let midLineTaskId = null;
			let midLineLeft = null;
			let midLineRight = null;

			/**
			 * @param {any} t
			 * @param {number} x
			 * @param {number} y
			 */
			function placeCell(t, x, y) {
				const cell = {
					gid: t.gid,
					parentGid: null,
					x,
					y,
					depth: 0,
					title: t.title,
					level: 2,
					docIdx: di,
					fileShort: label,
					hasChildren: false,
					isWorkflowTask: true
				};
				cells.push(cell);
				posByGid[t.gid] = cell;
				placed.add(t.taskId);
				return cell;
			}

			/**
			 * Place all direct children of a parent on its vertical:
			 * - 1 child → only one side (follows expandDir, default below)
			 * - 2+ on mid-line root → split upper/lower (extra → lower); set expand dirs
			 * - 2+ elsewhere → stack in parent's expandDir
			 * @param {any} parent
			 * @param {any[]} children
			 */
			function placeDirectChildrenBalanced(parent, children) {
				const pc = posByGid[parent.gid];
				if (!pc || !children.length) return;
				const idealBus = pc.x + G.BOX_W / 2;
				if (!directBus.has(parent.taskId)) {
					directBus.set(parent.taskId, {
						busX: allocUniqueVertX(idealBus),
						childMids: []
					});
				}
				const bus = directBus.get(parent.taskId);
				const pMid = pc.y + G.BOX_H / 2;
				const n = children.length;
				const desiredX = bus.busX + STUB;
				const isMidRoot = midLineTaskId != null && parent.taskId === midLineTaskId;
				const parentDir = expandDir.has(parent.taskId) ? expandDir.get(parent.taskId) : 1;

				for (let i = 0; i < n; i++) {
					const child = children[i];
					if (placed.has(child.taskId)) continue;
					let midOff;
					let childDir = parentDir;

					if (isMidRoot && n >= 2) {
						/* Upper = floor(n/2), lower gets the remainder (odd extra → lower). */
						const above = Math.floor(n / 2);
						if (i < above) {
							midOff = -(above - i) * PITCH_Y;
							childDir = -1;
						} else {
							midOff = (i - above + 1) * PITCH_Y;
							childDir = 1;
						}
					} else if (n === 1 || !isMidRoot) {
						/* Grow toward upper (−) or lower (+) half only. */
						const step = n === 1 ? 1 : i + 1;
						midOff = parentDir * PITCH_Y * step;
						childDir = parentDir;
					} else {
						midOff = PITCH_Y * (i + 1);
						childDir = 1;
					}

					expandDir.set(child.taskId, childDir);
					const desiredY = pMid + midOff - G.BOX_H / 2;
					const { x, y } = allocUniqueTaskXY(desiredX, desiredY);
					const cell = placeCell(child, x, y);
					const midY = y + G.BOX_H / 2;
					bus.childMids.push(midY);
					edgePairs.push({
						kind: 'tear-h',
						x1: bus.busX,
						y1: midY,
						x2: cell.x,
						y2: midY
					});
					if (midLineY != null) {
						midLineRight = Math.max(
							midLineRight == null ? cell.x + G.BOX_W : midLineRight,
							cell.x + G.BOX_W
						);
					}
				}
			}

			function paintDirectVerticals() {
				for (const [pid, bus] of directBus) {
					const pt = byId.get(pid);
					const pc = pt && posByGid[pt.gid];
					if (!pc || !bus.childMids.length) continue;
					const pMid = pc.y + G.BOX_H / 2;
					const cMin = Math.min(...bus.childMids);
					const cMax = Math.max(...bus.childMids);
					edgePairs.push({
						kind: 'tear-v',
						x1: bus.busX,
						y1: Math.min(pMid, cMin),
						x2: bus.busX,
						y2: Math.max(pMid, cMax)
					});
					pc.hasChildren = true;
				}
			}

			/**
			 * Multi-parent children on one join: stubs to the right of the join,
			 * mids spaced equidistant along the vertical between parent dotted Ys.
			 * @param {any[]} group
			 */
			function placeMultiGroup(group) {
				group = group.slice().sort((a, b) => a.lineIndex - b.lineIndex);
				const ids = parentIds(group[0]).slice().sort((a, b) => a - b);
				/** @type {any[]} */
				const parentCells = [];
				/** @type {any[]} */
				const parentTasks = [];
				for (const pid of ids) {
					const pt = byId.get(pid);
					if (!pt || !posByGid[pt.gid]) continue;
					parentCells.push(posByGid[pt.gid]);
					parentTasks.push(pt);
				}
				if (parentCells.length < 1) return;

				parentCells.sort((a, b) => a.x - b.x);
				const parentRight = parentCells[parentCells.length - 1].x + G.BOX_W;
				const joinX = allocUniqueVertX(parentRight + JOIN_GAP);

				for (let i = 0; i < parentTasks.length; i++) {
					const t = parentTasks[i];
					const pc = posByGid[t.gid];
					if (!pc) continue;
					const midY = pc.y + G.BOX_H / 2;
					if (!parentDotY.has(t.taskId)) parentDotY.set(t.taskId, midY);
					const yDot = parentDotY.get(t.taskId);
					const fromX = pc.x + G.BOX_W;
					const prevR = parentDotRight.get(t.taskId);
					if (prevR == null) {
						edgePairs.push({
							kind: 'tear-h-dot',
							x1: fromX,
							y1: yDot,
							x2: joinX,
							y2: yDot,
							_tearParentId: t.taskId
						});
						parentDotRight.set(t.taskId, joinX);
					} else if (joinX > prevR) {
						for (const e of edgePairs) {
							if (e.kind === 'tear-h-dot' && e._tearParentId === t.taskId) {
								e.x2 = joinX;
							}
						}
						parentDotRight.set(t.taskId, joinX);
					}
				}

				const yDots = parentTasks
					.map(t => parentDotY.get(t.taskId))
					.filter(y => y != null);
				const yMin = Math.min(...yDots);
				const yMax = Math.max(...yDots);
				const n = group.length;
				const band = Math.max(1, yMax - yMin);
				const stubX = joinX + STUB;

				for (let i = 0; i < n; i++) {
					const t = group[i];
					/* 1 child → mid; 2 → ⅓ & ⅔; never all stacked at one Y. */
					const frac = (i + 1) / (n + 1);
					const midY = yMin + band * frac;
					const cellY = midY - G.BOX_H / 2;
					usedTaskXs.push(stubX);
					usedTaskYs.push(cellY);
					const cell = placeCell(t, stubX, cellY);
					if (midLineY != null) {
						expandDir.set(t.taskId, midY < midLineY ? -1 : 1);
						midLineRight = Math.max(
							midLineRight == null ? cell.x + G.BOX_W : midLineRight,
							cell.x + G.BOX_W
						);
					}
					edgePairs.push({
						kind: 'tear-h',
						x1: joinX,
						y1: midY,
						x2: cell.x,
						y2: midY
					});
				}

				/* Join vertical stays exactly between the parent dotted lines. */
				edgePairs.push({
					kind: 'tear-v',
					x1: joinX,
					y1: yMin,
					x2: joinX,
					y2: yMax
				});
			}

			/* Seed roots only (wave 0). */
			let seedY = DOC_TOP + Math.max(120, PITCH_Y * 4);
			for (const r of roots) {
				const { x, y } = allocUniqueTaskXY(xColumn, seedY);
				placeCell(r, x, y);
				seedY = y + PITCH_Y;
			}
			if (!roots.length && tasks.length) {
				const seed = tasks[0];
				if (!placed.has(seed.taskId)) {
					const { x, y } = allocUniqueTaskXY(xColumn, DOC_TOP + 120);
					placeCell(seed, x, y);
				}
			}

			/* Mid-line on first workflow task when it has 2+ direct children. */
			const midRoot = roots[0] || (tasks.length ? byId.get([...placed][0]) : null);
			if (midRoot) {
				const midKids = directsOf.get(midRoot.taskId) || [];
				if (midKids.length >= 2) {
					const rc = posByGid[midRoot.gid];
					if (rc) {
						midLineTaskId = midRoot.taskId;
						midLineY = rc.y + G.BOX_H / 2;
						midLineLeft = rc.x - STUB * 0.5;
						midLineRight = rc.x + G.BOX_W + STUB;
						expandDir.set(midRoot.taskId, 0);
					}
				}
			}

			/*
			 * Frozen-set waves:
			 *   1) all direct children whose single parent ∈ S
			 *   2) only then: all multi-parent tasks whose parents ⊆ S
			 * e.g. {t1} → {t1,t2,t5} → {t1,t2,t5,t3} → {t1,t2,t5,t3,t9}
			 */
			let guard = 0;
			while (placed.size < tasks.length && guard++ < tasks.length * 4) {
				const base = new Set(placed);
				let grew = false;

				/** @type {Map<number, any[]>} */
				const directsByParent = new Map();
				for (const t of tasks) {
					if (placed.has(t.taskId)) continue;
					const ps = parentIds(t);
					if (ps.length !== 1 || !base.has(ps[0])) continue;
					if (!directsByParent.has(ps[0])) directsByParent.set(ps[0], []);
					directsByParent.get(ps[0]).push(t);
				}
				for (const pid of [...base].sort((a, b) => a - b)) {
					const kids = directsByParent.get(pid);
					if (!kids || !kids.length) continue;
					const parent = byId.get(pid);
					if (!parent) continue;
					kids.sort((a, b) => a.lineIndex - b.lineIndex);
					placeDirectChildrenBalanced(parent, kids);
					grew = true;
				}
				if (grew) continue;

				/** @type {Map<string, any[]>} */
				const readyGroups = new Map();
				for (const m of multis) {
					if (placed.has(m.taskId)) continue;
					const ps = parentIds(m);
					if (ps.length < 2 || !ps.every(p => base.has(p))) continue;
					const key = ps.slice().sort((a, b) => a - b).join(',');
					if (!readyGroups.has(key)) readyGroups.set(key, []);
					readyGroups.get(key).push(m);
				}
				if (readyGroups.size) {
					for (const [, group] of readyGroups) {
						placeMultiGroup(group);
					}
					grew = true;
				}
				if (grew) continue;

				for (const t of tasks) {
					if (placed.has(t.taskId)) continue;
					const { x, y } = allocUniqueTaskXY(
						xColumn + PITCH_X,
						DOC_TOP + placed.size * PITCH_Y
					);
					placeCell(t, x, y);
					grew = true;
					break;
				}
				if (!grew) break;
			}

			paintDirectVerticals();

			if (midLineY != null && midLineLeft != null) {
				let right = midLineRight == null ? midLineLeft + STUB * 4 : midLineRight;
				for (const c of cells) {
					if (c.docIdx !== di) continue;
					right = Math.max(right, c.x + G.BOX_W + STUB);
				}
				edgePairs.push({
					kind: 'tear-h-mid',
					x1: midLineLeft,
					y1: midLineY,
					x2: right,
					y2: midLineY
				});
			}

			for (const e of edgePairs) {
				if (e._tearParentId != null) delete e._tearParentId;
			}
		}

		for (let di = 0; di < docs.length; di++) {
			const doc = docs[di];
			if (doc.error) continue;
			const wg = doc.workflowGraph;
			if (!wg || wg.mode !== 'workflow') continue;
			const numbered = (wg.tasks || []).filter(t => t && t.taskId);
			if (!numbered.length) continue;

			const label = shortPath(doc.fileLabel || doc.id || 'note');
			const docBaseX = xColumn;
			docLabels.push({ x: docBaseX, text: label, docIdx: di });

			const before = cells.length;
			layoutWorkflowTearGraph(wg, di, label);

			let maxX = docBaseX;
			for (let i = before; i < cells.length; i++) {
				maxX = Math.max(maxX, cells[i].x + G.BOX_W);
			}
			for (const e of edgePairs) {
				maxX = Math.max(maxX, e.x1, e.x2);
			}
			xColumn = Math.max(docBaseX, maxX) + DOC_PAD_X + 48;
		}

		const maxY =
			cells.length === 0
				? 400
				: Math.max(...cells.map(c => c.y + G.BOX_H), 200) + 48;
		const worldW = Math.max(xColumn + DOC_PAD_X, 640);
		const worldH = maxY;

		return { cells, edgePairs, worldW, worldH, docLabels, groupFrames };
	}

	function markGraphMiddleEdgesStraight(edgePairs) {
		/** @type {Map<string, any[]>} */
		const byFrom = new Map();
		for (const e of edgePairs) {
			if (e.kind !== 'graph' && e.kind !== 'dag') continue;
			const key = e.fromGid || e.x1 + ',' + e.y1;
			if (!byFrom.has(key)) byFrom.set(key, []);
			byFrom.get(key).push(e);
		}
		for (const group of byFrom.values()) {
			if (!group.length) continue;
			for (const e of group) e.straight = false;
			if (group.length % 2 === 0) {
				/* even fan: keep all curved */
				continue;
			}
			group.sort((a, b) => a.y2 - b.y2);
			const mid = group[Math.floor(group.length / 2)];
			mid.straight = true;
		}
	}

	/** Compact ├── style: vertical stub down, then horizontal into child. */
	function compactTreeEdgePathD(e) {
		const x1 = e.x1;
		const y1 = e.y1;
		const x2 = e.x2;
		const y2 = e.y2;
		if (Math.abs(x1 - x2) < 2) {
			return 'M ' + x1 + ' ' + y1 + ' L ' + x2 + ' ' + y2 + ' ';
		}
		const midY = y1 + Math.max(10, (y2 - y1) * 0.45);
		return 'M ' + x1 + ' ' + y1 + ' L ' + x1 + ' ' + midY + ' L ' + x2 + ' ' + midY + ' L ' + x2 + ' ' + y2 + ' ';
	}

	function dagEdgePathD(e) {
		const mx = (e.x1 + e.x2) / 2;
		return (
			'M ' +
			e.x1 +
			' ' +
			e.y1 +
			' C ' +
			mx +
			' ' +
			e.y1 +
			', ' +
			mx +
			' ' +
			e.y2 +
			', ' +
			e.x2 +
			' ' +
			e.y2 +
			' '
		);
	}

	function pushGroupFrame(frames, rootCell, cells, isMember, nested) {
		if (!rootCell.hasChildren) return;
		if (collapsedHeadingGids.has(rootCell.gid)) return;

		const pad = 14;
		let minX = rootCell.x;
		let maxX = rootCell.x + BOX_W;
		let minY = rootCell.y;
		let maxY = rootCell.y + BOX_H;

		for (const c of cells) {
			if (!isMember(c, rootCell)) continue;
			minX = Math.min(minX, c.x);
			maxX = Math.max(maxX, c.x + BOX_W);
			maxY = Math.max(maxY, c.y + BOX_H);
		}

		frames.push({
			gid: rootCell.gid,
			x: minX - pad,
			y: minY - pad,
			w: maxX - minX + pad * 2,
			h: maxY - minY + pad * 2,
			nested: !!nested
		});
	}

	function pushTaskGroupFrame(frames, taskCell, cells) {
		pushGroupFrame(frames, taskCell, cells, (c, root) => c.gid === root.gid || c.taskGroupGid === root.gid, false);
	}

	function pushNestGroupFrame(frames, nestCell, cells) {
		pushGroupFrame(frames, nestCell, cells, (c, root) => c.gid === root.gid || c.nestGid === root.gid, true);
	}

	function hasNestedDocChildren(node, dagTaskIds) {
		if (node && node.hasChildHeadings) return true;
		for (const ch of (node && node.children) || []) {
			const tid = taskIdInTitle(ch.title);
			if (tid && dagTaskIds.has(tid)) continue;
			return true;
		}
		return false;
	}

	function headingHasCollapseToggle(cell) {
		if (cell.hasChildren) return true;
		return !!cell.isDocHierarchy;
	}

	/**
	 * Non-DAG headings nested under a task (document hierarchy).
	 * @param {any} node
	 * @param {any} parentCell
	 * @param {number} di
	 * @param {string} label
	 * @param {Set<number>} dagTaskIds
	 * @param {string} taskGroupGid
	 * @param {string | null} activeNestGid innermost nest frame gid for descendants
	 * @param {any[]} cells
	 * @param {any[]} edgePairs
	 * @param {Record<string, any>} posByGid
	 * @param {Map<number, any>} nodeByLine
	 * @param {any[]} groupFrames
	 * @returns {number} lowest y + BOX_H
	 */
	function layoutDocSubtreeUnder(
		parentCell,
		node,
		di,
		label,
		dagTaskIds,
		taskGroupGid,
		activeNestGid,
		nodeByLine,
		cells,
		edgePairs,
		posByGid,
		groupFrames
	) {
		if (collapsedHeadingGids.has(parentCell.gid)) {
			return parentCell.y + BOX_H;
		}

		// Folder-tree: children stack below parent, each level indented (extension/ → ├── file).
		let y = parentCell.y + BOX_H + TREE_ROW_GAP;
		let maxBottom = parentCell.y + BOX_H;
		const childX = parentCell.x + TREE_INDENT;
		const childDepth = (parentCell.hierarchyDepth || 0) + 1;

		for (const ch of (node && node.children) || []) {
			const tid = taskIdInTitle(ch.title);
			if (tid && dagTaskIds.has(tid)) continue;

			const gid = gidOf(di, ch);
			const treeChild = nodeByLine.get(ch.lineIndex) || ch;
			const hasKids = hasNestedDocChildren(treeChild, dagTaskIds);
			const cell = {
				gid,
				parentGid: parentCell.gid,
				taskGroupGid,
				nestGid: activeNestGid,
				isDocHierarchy: true,
				hierarchyDepth: childDepth,
				x: childX,
				y,
				depth: (parentCell.depth || 0) + 1,
				title: ch.title,
				level: Math.min(Math.max(Number(ch.level) || 2, 1), 6),
				docIdx: di,
				fileShort: label,
				hasChildren: hasKids
			};
			cells.push(cell);
			posByGid[gid] = cell;
			pushTreeEdge(edgePairs, parentCell, cell);

			let subBottom = y + BOX_H;
			if (!collapsedHeadingGids.has(gid)) {
				const childNestGid = hasKids ? gid : activeNestGid;
				subBottom = layoutDocSubtreeUnder(
					cell,
					treeChild,
					di,
					label,
					dagTaskIds,
					taskGroupGid,
					childNestGid,
					nodeByLine,
					cells,
					edgePairs,
					posByGid,
					groupFrames
				);
			}
			if (hasKids) {
				pushNestGroupFrame(groupFrames, cell, cells);
			}
			maxBottom = Math.max(maxBottom, subBottom);
			y = subBottom + TREE_ROW_GAP;
		}
		return maxBottom;
	}

	/**
	 * DAG layout for workflow: true tasks — centered rows; nested non-task headings under each task.
	 * @param {number} di
	 * @param {any} doc
	 * @param {number} docBaseX
	 * @param {string} label
	 * @param {any[]} cells
	 * @param {any[]} edgePairs
	 * @param {Record<string, any>} posByGid
	 * @param {any[]} groupFrames
	 * @returns {number} block width
	 */
	function layoutWorkflowDoc(di, doc, docBaseX, label, cells, edgePairs, posByGid, groupFrames) {
		const wg = doc.workflowGraph;
		if (!wg || wg.mode !== 'workflow') return 0;

		const tasks = (wg.tasks || []).filter(t => t.taskId);
		let blockWidth = BOX_W;
		if (tasks.length) {
			const byLevel = new Map();
			const byId = new Map();
			for (const t of tasks) byId.set(t.taskId, t);
			const level = new Map();
			function taskLevel(id, visiting) {
				if (level.has(id)) return level.get(id);
				if (visiting.has(id)) return 0;
				visiting.add(id);
				const t = byId.get(id);
				if (!t || !t.parentTaskIds.length) {
					level.set(id, 0);
					visiting.delete(id);
					return 0;
				}
				let maxP = -1;
				for (const pid of t.parentTaskIds) maxP = Math.max(maxP, taskLevel(pid, visiting));
				const l = maxP + 1;
				level.set(id, l);
				visiting.delete(id);
				return l;
			}
			for (const t of tasks) taskLevel(t.taskId, new Set());
			for (const t of tasks) {
				const l = level.get(t.taskId) || 0;
				if (!byLevel.has(l)) byLevel.set(l, []);
				byLevel.get(l).push(t);
			}
			for (const lvl of [...byLevel.keys()].sort((a, b) => a - b)) {
				blockWidth = Math.max(blockWidth, rowWidthForItems(byLevel.get(lvl)));
			}
		}
		blockWidth += DOC_PAD_X * 2;
		const blockCenter = docBaseX + blockWidth / 2;

		const wfY = DOC_BLOCK_TOP;
		const wfCell = {
			gid: wg.wfGid,
			parentGid: null,
			x: blockCenter - BOX_W / 2,
			y: wfY,
			depth: 0,
			title: wg.wfTitle || 'Workflow',
			level: 1,
			docIdx: di,
			fileShort: label,
			hasChildren: tasks.length > 0
		};
		cells.push(wfCell);
		posByGid[wfCell.gid] = wfCell;

		const dagExtent = layoutWorkflowDagUnderParent(
			wfCell,
			di,
			doc,
			label,
			cells,
			edgePairs,
			posByGid,
			groupFrames
		);

		let maxRight = Math.max(docBaseX + blockWidth, dagExtent.maxRight + DOC_PAD_X);
		for (const g of groupFrames) {
			maxRight = Math.max(maxRight, g.x + g.w + DOC_PAD_X);
		}
		return Math.max(blockWidth, maxRight - docBaseX);
	}

	/**
	 * @param {any} wg
	 */
	function computeWorkflowLevels(wg) {
		const tasks = (wg.tasks || []).filter(t => t.taskId);
		const byId = new Map();
		for (const t of tasks) byId.set(t.taskId, t);
		const level = new Map();
		function taskLevel(id, visiting) {
			if (level.has(id)) return level.get(id);
			if (visiting.has(id)) return 0;
			visiting.add(id);
			const t = byId.get(id);
			if (!t || !t.parentTaskIds.length) {
				level.set(id, 0);
				visiting.delete(id);
				return 0;
			}
			let maxP = -1;
			for (const pid of t.parentTaskIds) maxP = Math.max(maxP, taskLevel(pid, visiting));
			const l = maxP + 1;
			level.set(id, l);
			visiting.delete(id);
			return l;
		}
		for (const t of tasks) taskLevel(t.taskId, new Set());
		const byLevel = new Map();
		for (const t of tasks) {
			const l = level.get(t.taskId) || 0;
			if (!byLevel.has(l)) byLevel.set(l, []);
			byLevel.get(l).push(t);
		}
		const levels = [...byLevel.keys()].sort((a, b) => a - b);
		return { tasks, byId, byLevel, levels, dagTaskIds: new Set(tasks.map(t => t.taskId)) };
	}

	/** Graph view: parent → child horizontal link (vxplain-style). */
	function pushGraphHorizEdge(edgePairs, fromCell, toCell) {
		edgePairs.push({
			kind: 'graph',
			fromGid: fromCell.gid,
			x1: fromCell.x + G.BOX_W,
			y1: fromCell.y + G.BOX_H / 2,
			x2: toCell.x,
			y2: toCell.y + G.BOX_H / 2
		});
	}

	/** Graph view: workflow DAG edge left → right between columns. */
	function pushGraphDagHorizEdge(edgePairs, fromCell, toCell) {
		edgePairs.push({
			kind: 'dag',
			fromGid: fromCell.gid,
			x1: fromCell.x + G.BOX_W,
			y1: fromCell.y + G.BOX_H / 2,
			x2: toCell.x,
			y2: toCell.y + G.BOX_H / 2
		});
	}

	/**
	 * Numbered workflow-task children are laid out by DAG — exclude them from doc-tree walks.
	 * @param {any[]} rawChildren
	 * @param {number} di
	 * @param {{ wfTaskByGid?: Map<string, any>, wfGid?: string | null }} opts
	 * @returns {any[]}
	 */
	function filterGraphTreeChildren(rawChildren, di, opts) {
		/** @type {any[]} */
		const out = [];
		for (const ch of rawChildren || []) {
			const cg = gidOf(di, ch);
			if (opts && opts.wfTaskByGid && opts.wfTaskByGid.has(cg) && cg !== opts.wfGid) continue;
			out.push(ch);
		}
		return out;
	}

	/**
	 * Shift parents toward their furthest DAG child, but keep them centered between
	 * their natural (left) column and one column left of that child (right bound).
	 * @param {any[]} tasks
	 * @param {Map<number, number>} baseLevel
	 * @returns {Map<number, number>}
	 */
	function graphPullParentsTowardChildren(tasks, baseLevel) {
		/** @type {Map<number, number>} */
		const col = new Map();
		for (const t of tasks) {
			if (t.taskId) col.set(t.taskId, baseLevel.get(t.taskId) || 0);
		}
		/** @type {Map<number, number>} */
		const base = new Map(col);
		let changed = true;
		let guard = 0;
		while (changed && guard++ < 32) {
			changed = false;
			for (const t of tasks) {
				if (!t.taskId) continue;
				let maxChild = -1;
				for (const o of tasks) {
					if (!(o.parentTaskIds || []).includes(t.taskId)) continue;
					if (!o.taskId) continue;
					maxChild = Math.max(maxChild, col.get(o.taskId) || 0);
				}
				if (maxChild < 0) continue;
				const left = base.get(t.taskId) || 0;
				const right = Math.max(left, maxChild - 1);
				const mid = Math.round((left + right) / 2);
				const cur = col.get(t.taskId) || 0;
				if (mid !== cur) {
					col.set(t.taskId, mid);
					changed = true;
				}
			}
		}
		return col;
	}

	/**
	 * Workflow `parent:` edges + default edges from workflow root when parent list is empty.
	 * @param {any} doc
	 * @param {Record<string, any>} posByGid
	 * @param {any[]} edgePairs
	 */
	function addGraphWorkflowParentEdges(doc, posByGid, edgePairs) {
		const wg = doc && doc.workflowGraph;
		if (!wg || wg.mode !== 'workflow') return;
		const wfCell = posByGid[wg.wfGid];
		const { tasks, byId } = computeWorkflowLevels(wg);
		for (const t of tasks) {
			const cell = posByGid[t.gid];
			if (!cell) continue;
			const parents = t.parentTaskIds && t.parentTaskIds.length ? t.parentTaskIds : [];
			if (!parents.length) {
				if (wfCell) pushGraphDagHorizEdge(edgePairs, wfCell, cell);
				continue;
			}
			for (const pid of parents) {
				const parentTask = byId.get(pid);
				if (!parentTask) continue;
				const fromCell = posByGid[parentTask.gid];
				if (!fromCell) continue;
				pushGraphDagHorizEdge(edgePairs, fromCell, cell);
			}
		}
	}

	/**
	 * Layout numbered workflow tasks: children (concepts + nested numbered tasks) stack
	 * top→bottom in the next column; parent is vertically centered on that stack.
	 * @returns {{ minY: number, maxY: number, maxX: number }}
	 */
	function layoutGraphWorkflowBlock(
		wfNode,
		di,
		label,
		x,
		yStart,
		parentGid,
		parentCell,
		opts,
		cells,
		edgePairs,
		posByGid,
		_groupFrames
	) {
		const wg = opts.doc && opts.doc.workflowGraph;
		const gid = opts.wfGid;
		const collapsedWhole = collapsedHeadingGids.has(gid);
		const { tasks, byId, byLevel } = computeWorkflowLevels(wg);
		const nodeByLine = buildLineIndexMap(opts.doc.headingRoots || []);
		/** @type {Map<number, any>} */
		const taskById = new Map();
		for (const t of tasks) {
			if (t.taskId) taskById.set(t.taskId, t);
		}

		/** @type {Map<number, number>} */
		const level = new Map();
		for (const [lvl, group] of byLevel) {
			for (const t of group) {
				if (t.taskId) level.set(t.taskId, lvl);
			}
		}
		const displayCol = graphPullParentsTowardChildren(tasks, level);

		const hasWfContent =
			tasks.length > 0 || filterGraphTreeChildren(wfNode.children || [], di, opts).length > 0;

		if (collapsedWhole || !hasWfContent) {
			const cell = {
				gid,
				parentGid,
				x,
				y: yStart,
				depth: 0,
				title: wfNode.title,
				level: Math.min(Math.max(Number(wfNode.level) || 1, 1), 6),
				docIdx: di,
				fileShort: label,
				hasChildren: hasWfContent,
				isWorkflowRoot: true
			};
			cells.push(cell);
			posByGid[gid] = cell;
			if (parentCell) pushGraphHorizEdge(edgePairs, parentCell, cell);
			return { minY: yStart, maxY: yStart + G.BOX_H, maxX: x + G.BOX_W };
		}

		/**
		 * Document-order visual children under a heading: non-numbered headings + nested numbered tasks.
		 * @param {any} treeNode
		 * @returns {{ kind: 'doc' | 'task', node?: any, task?: any }[]}
		 */
		function visualChildren(treeNode) {
			/** @type {{ kind: 'doc' | 'task', node?: any, task?: any }[]} */
			const out = [];
			for (const ch of (treeNode && treeNode.children) || []) {
				const cg = gidOf(di, ch);
				const wt = opts.wfTaskByGid && opts.wfTaskByGid.get(cg);
				if (wt && wt.taskId && cg !== opts.wfGid) {
					out.push({ kind: 'task', task: wt, node: ch });
				} else {
					out.push({ kind: 'doc', node: ch });
				}
			}
			return out;
		}

		/**
		 * @param {any} t
		 * @param {number} y0
		 * @returns {{ minY: number, maxY: number, maxX: number, cell: any }}
		 */
		function layoutNumberedTaskCentered(t, y0) {
			const c = displayCol.get(t.taskId) || 0;
			const colX = x + (c + 1) * G.COL_GAP;
			const treeNode = nodeByLine.get(t.lineIndex);
			const kids = visualChildren(treeNode);
			const docKidCount = kids.filter(k => k.kind === 'doc').length;
			const collapsedDocs = collapsedHeadingGids.has(t.gid);
			const showKids = kids.filter(k => {
				if (k.kind === 'doc' && collapsedDocs) return false;
				return true;
			});

			if (!showKids.length) {
				const cell = {
					gid: t.gid,
					parentGid: gid,
					x: colX,
					y: y0,
					depth: c + 1,
					title: t.title,
					level: 2,
					docIdx: di,
					fileShort: label,
					hasChildren: docKidCount > 0,
					isWorkflowTask: true,
					collapseDocOnly: true
				};
				cells.push(cell);
				posByGid[t.gid] = cell;
				return { minY: y0, maxY: y0 + G.BOX_H, maxX: colX + G.BOX_W, cell };
			}

			let y = y0;
			let maxX = colX + G.COL_GAP;
			let maxY = y0;
			/** @type {any[]} */
			const childCells = [];

			for (const item of showKids) {
				if (item.kind === 'task') {
					const ext = layoutNumberedTaskCentered(item.task, y);
					childCells.push(ext.cell);
					maxX = Math.max(maxX, ext.maxX);
					maxY = Math.max(maxY, ext.maxY);
					y = ext.maxY + G.ROW_GAP;
				} else {
					const ext = layoutGraphSubtree(
						item.node,
						di,
						label,
						colX + G.COL_GAP,
						y,
						t.gid,
						null,
						opts,
						cells,
						edgePairs,
						posByGid,
						_groupFrames,
						{ depth: c + 2 }
					);
					const cc = posByGid[gidOf(di, item.node)];
					if (cc) childCells.push(cc);
					maxX = Math.max(maxX, ext.maxX);
					maxY = Math.max(maxY, ext.maxY);
					y = ext.maxY + G.ROW_GAP;
				}
			}

			const blockTop = y0;
			const blockBottom = y - G.ROW_GAP;
			const blockH = Math.max(G.BOX_H, blockBottom - blockTop);
			const parentY = blockTop + (blockH - G.BOX_H) / 2;
			const cell = {
				gid: t.gid,
				parentGid: gid,
				x: colX,
				y: parentY,
				depth: c + 1,
				title: t.title,
				level: 2,
				docIdx: di,
				fileShort: label,
				hasChildren: docKidCount > 0,
				isWorkflowTask: true,
				collapseDocOnly: true
			};
			cells.push(cell);
			posByGid[t.gid] = cell;

			for (const cc of childCells) {
				if (opts.wfTaskByGid && opts.wfTaskByGid.has(cc.gid)) {
					/* numbered: edge via parent: / nesting in addGraphWorkflowParentEdges */
					continue;
				}
				pushGraphHorizEdge(edgePairs, cell, cc);
			}

			return {
				minY: blockTop,
				maxY: Math.max(blockTop + blockH, blockBottom),
				maxX: Math.max(maxX, colX + G.BOX_W),
				cell
			};
		}

		let maxX = x + G.BOX_W;
		let maxY = yStart + G.BOX_H;
		let y = yStart;
		/** @type {any[]} */
		const rootChildCells = [];

		// Non-numbered + numbered root tasks under the workflow, in document order
		for (const ch of wfNode.children || []) {
			const cg = gidOf(di, ch);
			const wt = opts.wfTaskByGid && opts.wfTaskByGid.get(cg);
			if (wt && wt.taskId) {
				// Skip nested tasks — they layout under their nesting parent
				if (wt.nestingParentId) continue;
				const ext = layoutNumberedTaskCentered(wt, y);
				rootChildCells.push(ext.cell);
				maxX = Math.max(maxX, ext.maxX);
				maxY = Math.max(maxY, ext.maxY);
				y = ext.maxY + G.ROW_GAP;
			} else {
				const ext = layoutGraphSubtree(
					ch,
					di,
					label,
					x + G.COL_GAP,
					y,
					gid,
					null,
					opts,
					cells,
					edgePairs,
					posByGid,
					_groupFrames,
					{ depth: 1 }
				);
				const cc = posByGid[gidOf(di, ch)];
				if (cc) rootChildCells.push(cc);
				maxX = Math.max(maxX, ext.maxX);
				maxY = Math.max(maxY, ext.maxY);
				y = ext.maxY + G.ROW_GAP;
			}
		}

		const blockH = Math.max(G.BOX_H, maxY - yStart);
		const wfY = yStart + (blockH - G.BOX_H) / 2;
		const wfCell = {
			gid,
			parentGid,
			x,
			y: wfY,
			depth: 0,
			title: wfNode.title,
			level: Math.min(Math.max(Number(wfNode.level) || 1, 1), 6),
			docIdx: di,
			fileShort: label,
			hasChildren: true,
			isWorkflowRoot: true
		};
		cells.push(wfCell);
		posByGid[gid] = wfCell;
		if (parentCell) pushGraphHorizEdge(edgePairs, parentCell, wfCell);

		for (const cc of rootChildCells) {
			if (opts.wfTaskByGid && opts.wfTaskByGid.has(cc.gid)) continue;
			pushGraphHorizEdge(edgePairs, wfCell, cc);
		}

		addGraphWorkflowParentEdges(opts.doc, posByGid, edgePairs);

		const midY = wfCell.y + G.BOX_H / 2;
		for (const e of edgePairs) {
			if (e.fromGid === gid) e.y1 = midY;
		}
		// Re-anchor parent→child graph edges after parent Y was centered
		for (const e of edgePairs) {
			if (e.kind !== 'graph' && e.kind !== 'dag') continue;
			if (!e.fromGid || !posByGid[e.fromGid]) continue;
			const from = posByGid[e.fromGid];
			e.y1 = from.y + G.BOX_H / 2;
			e.x1 = from.x + G.BOX_W;
		}

		void byId;
		void taskById;
		return { minY: yStart, maxY: Math.max(maxY, wfY + G.BOX_H), maxX };
	}

	/**
	 * Graph view: recursive L→R tree — numbered workflow tasks use DAG block instead of note hierarchy.
	 * @returns {{ minY: number, maxY: number, maxX: number }}
	 */
	function layoutGraphSubtree(
		node,
		di,
		label,
		x,
		yStart,
		parentGid,
		parentCell,
		opts,
		cells,
		edgePairs,
		posByGid,
		_groupFrames,
		cellExtra
	) {
		const gid = gidOf(di, node);
		const extra = cellExtra || {};

		if (opts && opts.wfGid && gid === opts.wfGid) {
			return layoutGraphWorkflowBlock(
				node,
				di,
				label,
				x,
				yStart,
				parentGid,
				parentCell,
				opts,
				cells,
				edgePairs,
				posByGid,
				_groupFrames
			);
		}

		const collapsed = collapsedHeadingGids.has(gid);
		const treeChildren = collapsed ? [] : filterGraphTreeChildren(node.children || [], di, opts);
		const rawKids = node.children || [];
		const hasChildren = rawKids.length > 0;
		const lvl = Math.min(Math.max(Number(node.level) || 1, 1), 6);

		if (!treeChildren.length) {
			const cell = {
				gid,
				parentGid,
				x,
				y: yStart,
				depth: extra.depth != null ? extra.depth : 0,
				title: node.title,
				level: lvl,
				docIdx: di,
				fileShort: label,
				hasChildren,
				...extra
			};
			cells.push(cell);
			posByGid[gid] = cell;
			if (parentCell) pushGraphHorizEdge(edgePairs, parentCell, cell);
			return { minY: yStart, maxY: yStart + G.BOX_H, maxX: x + G.BOX_W };
		}

		let y = yStart;
		let maxX = x + G.COL_GAP;
		/** @type {any[]} */
		const childCells = [];

		for (const ch of treeChildren) {
			const ext = layoutGraphSubtree(
				ch,
				di,
				label,
				x + G.COL_GAP,
				y,
				gid,
				null,
				opts,
				cells,
				edgePairs,
				posByGid,
				_groupFrames,
				{ depth: (extra.depth != null ? extra.depth : 0) + 1 }
			);
			const childGid = gidOf(di, ch);
			const cc = posByGid[childGid];
			if (cc) childCells.push(cc);
			maxX = Math.max(maxX, ext.maxX);
			y = ext.maxY + G.ROW_GAP;
		}

		const blockTop = yStart;
		const blockBottom = y - G.ROW_GAP;
		const blockH = Math.max(G.BOX_H, blockBottom - blockTop);
		const parentY = blockTop + (blockH - G.BOX_H) / 2;

		const cell = {
			gid,
			parentGid,
			x,
			y: parentY,
			depth: extra.depth != null ? extra.depth : 0,
			title: node.title,
			level: lvl,
			docIdx: di,
			fileShort: label,
			hasChildren,
			...extra
		};
		cells.push(cell);
		posByGid[gid] = cell;
		if (parentCell) pushGraphHorizEdge(edgePairs, parentCell, cell);
		for (const cc of childCells) pushGraphHorizEdge(edgePairs, cell, cc);

		return {
			minY: blockTop,
			maxY: Math.max(blockTop + blockH, blockBottom),
			maxX: Math.max(maxX, x + G.BOX_W)
		};
	}

	/**
	 * Graph view: one document — doc tree outside workflows; DAG columns inside.
	 * @returns {number} block width
	 */
	function layoutGraphDocBlock(di, doc, docBaseX, label, roots, cells, edgePairs, posByGid, groupFrames) {
		const wg = doc.workflowGraph;
		/** @type {Map<string, any>} */
		const wfTaskByGid = new Map();
		if (wg && wg.mode === 'workflow') {
			for (const t of wg.tasks || []) {
				if (t && t.gid) wfTaskByGid.set(t.gid, t);
			}
		}
		const opts = {
			wfGid: wg && wg.mode === 'workflow' ? wg.wfGid : null,
			wfTaskByGid,
			doc
		};

		let y = G.DOC_TOP;
		let maxX = docBaseX;
		for (const root of roots) {
			const ext = layoutGraphSubtree(
				root,
				di,
				label,
				docBaseX,
				y,
				null,
				null,
				opts,
				cells,
				edgePairs,
				posByGid,
				groupFrames,
				{ depth: 0 }
			);
			maxX = Math.max(maxX, ext.maxX);
			y = ext.maxY + G.ROOT_GAP;
		}
		return maxX - docBaseX + DOC_PAD_X;
	}

	function layoutDocsClassic() {
		const docs = state.docs || [];
		/** @type {{ gid: string, parentGid: string | null, x: number, y: number, title: string, level: number, docIdx: number, fileShort: string, hasChildren: boolean, depth: number, taskGroupGid?: string }[]} */
		const cells = [];
		/** @type {{ x1: number, y1: number, x2: number, y2: number }[]} */
		const edgePairs = [];
		/** @type {{ gid: string, x: number, y: number, w: number, h: number, collapsed: boolean, nested?: boolean }[]} */
		const groupFrames = [];
		const posByGid = Object.create(null);

		let xColumn = DOC_PAD_X;
		/** @type {{ x: number, text: string, docIdx: number }[]} */
		const docLabels = [];

		for (let di = 0; di < docs.length; di++) {
			const doc = docs[di];
			if (doc.error) continue;
			const roots = doc.headingRoots || [];
			if (!roots.length) continue;

			const label = shortPath(doc.fileLabel || doc.id || 'note');
			const docBaseX = xColumn;
			docLabels.push({ x: docBaseX, text: label, docIdx: di });

			if (doc.workflowGraph && doc.workflowGraph.mode === 'workflow') {
				const wg = doc.workflowGraph;
				if (workflowIsEmbedded(roots, wg.wfGid, di)) {
					const blockW = layoutUnifiedDoc(
						di,
						doc,
						docBaseX,
						label,
						roots,
						cells,
						edgePairs,
						posByGid,
						groupFrames
					);
					xColumn += blockW;
				} else {
					const wfW = layoutWorkflowDoc(
						di,
						doc,
						docBaseX,
						label,
						cells,
						edgePairs,
						posByGid,
						groupFrames
					);
					xColumn += wfW;
				}
				continue;
			}

			const blockW = layoutStandardTreeBlock(di, docBaseX, label, roots, cells, edgePairs, posByGid);
			xColumn += blockW;
		}

		const maxY =
			cells.length === 0
				? 400
				: Math.max(
						...cells.map(c => c.y + BOX_H),
						...groupFrames.map(g => g.y + g.h),
						200
				  ) + 48;
		const worldW = Math.max(xColumn + DOC_PAD_X, 640);
		const worldH = maxY;

		adjustDagEdgesForFrames(edgePairs, groupFrames);
		return { cells, edgePairs, worldW, worldH, docLabels, groupFrames };
	}

	function layoutDocsGraphView() {
		const docs = state.docs || [];
		/** @type {any[]} */
		const cells = [];
		/** @type {any[]} */
		const edgePairs = [];
		/** Graph view: no expansion frames */
		const groupFrames = [];
		const posByGid = Object.create(null);

		let xColumn = DOC_PAD_X;
		/** @type {{ x: number, text: string, docIdx: number }[]} */
		const docLabels = [];

		for (let di = 0; di < docs.length; di++) {
			const doc = docs[di];
			if (doc.error) continue;
			const roots = doc.headingRoots || [];
			if (!roots.length) continue;

			const label = shortPath(doc.fileLabel || doc.id || 'note');
			const docBaseX = xColumn;
			docLabels.push({ x: docBaseX, text: label, docIdx: di });

			const blockW = layoutGraphDocBlock(
				di,
				doc,
				docBaseX,
				label,
				roots,
				cells,
				edgePairs,
				posByGid,
				groupFrames
			);
			xColumn += blockW;
		}

		const maxY =
			cells.length === 0
				? 400
				: Math.max(...cells.map(c => c.y + G.BOX_H), 200) + 48;
		const worldW = Math.max(xColumn + DOC_PAD_X, 640);
		const worldH = maxY;

		return { cells, edgePairs, worldW, worldH, docLabels, groupFrames };
	}

	function layoutDocs() {
		syncLayoutMetrics();
		if (state.canvasView === CANVAS_VIEW_TEARDROP) return layoutDocsTearDrop();
		if (state.canvasView === CANVAS_VIEW_GRAPH) return layoutDocsGraphView();
		return layoutDocsClassic();
	}

	function shortPath(p) {
		const s = String(p || '');
		const parts = s.replace(/\\/g, '/').split('/');
		return parts[parts.length - 1] || s;
	}

	function applyWorldTransform() {
		const w = $('canvas-world');
		if (!w) return;
		w.style.transform =
			'translate(' + view.tx + 'px,' + view.ty + 'px) scale(' + view.scale + ')';
	}

	function collectNodeGraphRelationTypes() {
		const types = new Set();
		for (const doc of state.docs || []) {
			for (const type of doc.nodeGraph?.relationTypes || []) types.add(type);
		}
		return [...types].sort();
	}

	function populateNodeGraphFilter() {
		const host = $('node-graph-relation-types');
		if (!host) return;
		const types = collectNodeGraphRelationTypes();
		for (const type of types) {
			if (!state.nodeGraphKnownRelations.has(type)) {
				state.nodeGraphKnownRelations.add(type);
				state.nodeGraphVisibleRelations.add(type);
			}
		}
		host.innerHTML = types.length
			? types
					.map(
						type =>
							'<label><input type="checkbox" data-relation-type="' +
							escapeHtml(type) +
							'"' +
							(state.nodeGraphVisibleRelations.has(type) ? ' checked' : '') +
							'><span>' +
							escapeHtml(type) +
							'</span></label>'
					)
					.join('')
			: '<span class="node-graph-filter-empty">No relation edges</span>';
	}

	function kickNodeGraphSim() {
		nodeGraphLastKick = Date.now();
	}

	function stopNodeGraphSim() {
		if (nodeGraphRaf) {
			cancelAnimationFrame(nodeGraphRaf);
			nodeGraphRaf = 0;
		}
	}

	function syncNodeGraphSimFromDocs() {
		const live = new Set();
		const edges = [];
		for (const doc of state.docs || []) {
			const graph = doc.nodeGraph;
			if (!graph) continue;
			for (const node of graph.nodes || []) {
				live.add(node.id);
				const prev = nodeGraphSim.get(node.id);
				if (prev) {
					prev.title = node.title;
					prev.badge = node.badge || '#';
					prev.root = !!node.root;
					continue;
				}
				nodeGraphSim.set(node.id, {
					id: node.id,
					x: (Math.random() - 0.5) * 220,
					y: (Math.random() - 0.5) * 220,
					vx: 0,
					vy: 0,
					title: node.title,
					badge: node.badge || '#',
					root: !!node.root
				});
			}
			for (const edge of graph.edges || []) edges.push(edge);
		}
		for (const id of [...nodeGraphSim.keys()]) {
			if (!live.has(id)) nodeGraphSim.delete(id);
		}
		nodeGraphEdges = edges;
		kickNodeGraphSim();
	}

	function nodeGraphActiveLinks() {
		return nodeGraphEdges.filter(edge => {
			if (edge.kind === 'relation' && !state.nodeGraphVisibleRelations.has(edge.label)) {
				return false;
			}
			return nodeGraphSim.has(edge.source) && nodeGraphSim.has(edge.target);
		});
	}

	function simulateNodeGraphForces() {
		const nodes = [...nodeGraphSim.values()];
		if (!nodes.length) return;
		if (Date.now() - nodeGraphLastKick > 5000) {
			for (const n of nodes) {
				n.vx = 0;
				n.vy = 0;
			}
			return;
		}
		const dragId = nodeGraphDrag && nodeGraphDrag.id;
		const centerK = NG.forceCenter;
		const repelK = NG.forceRepel;
		const linkK = NG.forceLink;
		const linkDist = NG.linkDistance;

		for (const n of nodes) {
			if (dragId && dragId === n.id) continue;
			n.vx += -n.x * centerK * 0.01;
			n.vy += -n.y * centerK * 0.01;
		}
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				const a = nodes[i];
				const b = nodes[j];
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const d2 = dx * dx + dy * dy + 0.01;
				const d = Math.sqrt(d2);
				const f = (repelK * 1200) / d2;
				const ux = dx / d;
				const uy = dy / d;
				if (!(dragId && dragId === a.id)) {
					a.vx -= ux * f * 0.02;
					a.vy -= uy * f * 0.02;
				}
				if (!(dragId && dragId === b.id)) {
					b.vx += ux * f * 0.02;
					b.vy += uy * f * 0.02;
				}
			}
		}
		for (const edge of nodeGraphActiveLinks()) {
			const na = nodeGraphSim.get(edge.source);
			const nb = nodeGraphSim.get(edge.target);
			if (!na || !nb || na === nb) continue;
			const lx = nb.x - na.x;
			const ly = nb.y - na.y;
			const ld = Math.sqrt(lx * lx + ly * ly) || 0.001;
			const sf = (ld - linkDist) * linkK * 0.0025;
			const ux = lx / ld;
			const uy = ly / ld;
			if (!(dragId && dragId === na.id)) {
				na.vx += ux * sf;
				na.vy += uy * sf;
			}
			if (!(dragId && dragId === nb.id)) {
				nb.vx -= ux * sf;
				nb.vy -= uy * sf;
			}
		}
		for (const n of nodes) {
			if (dragId && dragId === n.id) continue;
			n.vx *= 0.92;
			n.vy *= 0.92;
			n.x += n.vx;
			n.y += n.vy;
		}
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				const c1 = nodes[i];
				const c2 = nodes[j];
				const cdx = c2.x - c1.x;
				const cdy = c2.y - c1.y;
				const cd = Math.sqrt(cdx * cdx + cdy * cdy) || 0.001;
				if (cd >= NG.minSep) continue;
				const push = (NG.minSep - cd) * 0.5;
				const pux = cdx / cd;
				const puy = cdy / cd;
				if (!(dragId && dragId === c1.id)) {
					c1.x -= pux * push;
					c1.y -= puy * push;
				}
				if (!(dragId && dragId === c2.id)) {
					c2.x += pux * push;
					c2.y += puy * push;
				}
			}
		}
	}

	function nodeGraphWorldPos(n) {
		return {
			left: NG.ORIGIN + n.x - NG.NODE_W / 2,
			top: NG.ORIGIN + n.y - NG.NODE_H / 2,
			cx: NG.ORIGIN + n.x,
			cy: NG.ORIGIN + n.y
		};
	}

	function nodeGraphLine(edge) {
		const source = nodeGraphSim.get(edge.source);
		const target = nodeGraphSim.get(edge.target);
		if (!source || !target) return '';
		const a = nodeGraphWorldPos(source);
		const b = nodeGraphWorldPos(target);
		const mx = (a.cx + b.cx) / 2;
		const my = (a.cy + b.cy) / 2;
		const relation = edge.kind === 'relation';
		const cls = relation
			? 'node-graph-edge node-graph-edge--relation'
			: 'node-graph-edge node-graph-edge--solid';
		return (
			'<line class="' +
			cls +
			'" x1="' +
			a.cx +
			'" y1="' +
			a.cy +
			'" x2="' +
			b.cx +
			'" y2="' +
			b.cy +
			'" marker-end="url(#node-graph-arrow)" />' +
			(edge.label
				? '<text class="node-graph-edge-label" x="' +
				  mx +
				  '" y="' +
				  (my - 5) +
				  '" text-anchor="middle">' +
				  escapeHtml(edge.label) +
				  '</text>'
				: '')
		);
	}

	function paintNodeGraphFrame() {
		const empty = $('canvas-empty');
		const nodesEl = $('canvas-nodes');
		const svg = $('canvas-edges');
		const treeSvg = $('canvas-tree-edges');
		const nodes = [...nodeGraphSim.values()];
		if (!nodes.length) {
			if (empty) empty.classList.remove('hidden');
			if (nodesEl) nodesEl.innerHTML = '';
			if (svg) svg.innerHTML = '';
			if (treeSvg) treeSvg.innerHTML = '';
			return;
		}
		if (empty) empty.classList.add('hidden');

		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of nodes) {
			const p = nodeGraphWorldPos(n);
			minX = Math.min(minX, p.left);
			minY = Math.min(minY, p.top);
			maxX = Math.max(maxX, p.left + NG.NODE_W);
			maxY = Math.max(maxY, p.top + NG.NODE_H);
		}
		const worldW = Math.max(900, maxX + 120);
		const worldH = Math.max(700, maxY + 120);

		let edgeHtml =
			'<defs><marker id="node-graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L8,4 L0,8 z" class="node-graph-arrow-head" /></marker></defs>';
		for (const edge of nodeGraphActiveLinks()) edgeHtml += nodeGraphLine(edge);
		if (svg) {
			svg.setAttribute('width', String(worldW));
			svg.setAttribute('height', String(worldH));
			svg.setAttribute('viewBox', '0 0 ' + worldW + ' ' + worldH);
			svg.innerHTML = edgeHtml;
		}
		if (treeSvg) treeSvg.innerHTML = '';

		if (nodesEl) {
			const existing = new Map();
			for (const el of nodesEl.querySelectorAll('.node-graph-node')) {
				existing.set(el.getAttribute('data-node-graph-id'), el);
			}
			const live = new Set();
			for (const n of nodes) {
				live.add(n.id);
				const p = nodeGraphWorldPos(n);
				let el = existing.get(n.id);
				if (!el) {
					el = document.createElement('div');
					el.className = 'node-graph-node' + (n.root ? ' node-graph-node--root' : '');
					el.setAttribute('data-node-graph-id', n.id);
					el.innerHTML =
						'<span class="node-graph-node-badge"></span><span class="node-graph-node-title"></span>';
					nodesEl.appendChild(el);
				} else {
					el.classList.toggle('node-graph-node--root', !!n.root);
				}
				el.style.left = p.left + 'px';
				el.style.top = p.top + 'px';
				const badge = el.querySelector('.node-graph-node-badge');
				const title = el.querySelector('.node-graph-node-title');
				if (badge) badge.textContent = n.badge || '#';
				if (title) title.textContent = n.title || '';
			}
			for (const [id, el] of existing) {
				if (!live.has(id)) el.remove();
			}
		}
		const world = $('canvas-world');
		if (world) {
			world.style.width = worldW + 'px';
			world.style.height = worldH + 'px';
			world.style.minWidth = worldW + 'px';
			world.style.minHeight = worldH + 'px';
		}
		applyWorldTransform();
	}

	function nodeGraphLoop() {
		if (state.canvasView !== CANVAS_VIEW_NODE_GRAPH) {
			nodeGraphRaf = 0;
			return;
		}
		simulateNodeGraphForces();
		paintNodeGraphFrame();
		nodeGraphRaf = requestAnimationFrame(nodeGraphLoop);
	}

	function startNodeGraphSim() {
		syncNodeGraphSimFromDocs();
		if (!nodeGraphRaf && state.canvasView === CANVAS_VIEW_NODE_GRAPH) {
			nodeGraphRaf = requestAnimationFrame(nodeGraphLoop);
		}
	}

	function renderNodeGraph() {
		startNodeGraphSim();
		if (!nodeGraphRaf) paintNodeGraphFrame();
	}

	function renderGraph() {
		applyCanvasViewBodyClass();
		if (state.canvasView === CANVAS_VIEW_NODE_GRAPH) {
			renderNodeGraph();
			return;
		}
		syncLayoutMetrics();
		const boxW = activeBoxW();
		const boxH = activeBoxH();
		const isGraph = state.canvasView === CANVAS_VIEW_GRAPH;
		const isTear = state.canvasView === CANVAS_VIEW_TEARDROP;
		const isLtr = isGraph || isTear;

		const vp = $('canvas-viewport');
		const empty = $('canvas-empty');
		const nodesEl = $('canvas-nodes');
		const svg = $('canvas-edges');
		const treeSvg = $('canvas-tree-edges');

		if (!state.docs.length) {
			if (empty) empty.classList.remove('hidden');
			if (nodesEl) nodesEl.innerHTML = '';
			if (svg) svg.innerHTML = '';
			if (treeSvg) treeSvg.innerHTML = '';
			return;
		}
		if (empty) empty.classList.add('hidden');

		const { cells, edgePairs, worldW, worldH, docLabels, groupFrames } = layoutDocs();
		const { parentHl, childHl } = mergeNavHighlights();

		if (isGraph) markGraphMiddleEdgesStraight(edgePairs);

		let graphPathD = '';
		let dagPathD = '';
		let treePathD = '';
		let tearSolidD = '';
		let tearDotD = '';
		let tearMidD = '';
		const ltrEdge = graphEdgePathD;
		for (const e of edgePairs) {
			if (isTear) {
				if (e.kind === 'tear-h-dot') tearDotD += tearDropEdgePathD(e);
				else if (e.kind === 'tear-h-mid') tearMidD += tearDropEdgePathD(e);
				else if (e.kind === 'tear-v' || e.kind === 'tear-h') tearSolidD += tearDropEdgePathD(e);
				else tearSolidD += tearDropEdgePathD(e);
				continue;
			}
			if (e.kind === 'tree') {
				treePathD += compactTreeEdgePathD(e);
			} else if (e.kind === 'dag') {
				dagPathD += isLtr ? ltrEdge(e) : dagEdgePathD(e);
			} else if (e.kind === 'graph') {
				graphPathD += ltrEdge(e);
			} else {
				graphPathD += isLtr ? ltrEdge(e) : edgePathD(e);
			}
		}

		if (svg) {
			svg.setAttribute('width', String(worldW));
			svg.setAttribute('height', String(worldH));
			svg.setAttribute('viewBox', '0 0 ' + worldW + ' ' + worldH);
			const edgeStroke = isTear ? '1.4' : isLtr ? '1.35' : '2';
			let inner = '';
			if (isTear) {
				if (tearMidD.length) {
					inner +=
						'<path class="canvas-edge-path canvas-edge-path--teardrop-mid" d="' +
						tearMidD +
						'" fill="none" stroke-width="1.1" vector-effect="non-scaling-stroke" />';
				}
				if (tearDotD.length) {
					inner +=
						'<path class="canvas-edge-path canvas-edge-path--teardrop-dot" d="' +
						tearDotD +
						'" fill="none" stroke-width="' +
						edgeStroke +
						'" vector-effect="non-scaling-stroke" />';
				}
				if (tearSolidD.length) {
					inner +=
						'<path class="canvas-edge-path canvas-edge-path--teardrop" d="' +
						tearSolidD +
						'" fill="none" stroke-width="' +
						edgeStroke +
						'" vector-effect="non-scaling-stroke" />';
				}
			} else {
				const edgeClass = isLtr ? ' canvas-edge-path--graph' : '';
				if (graphPathD.length) {
					inner +=
						'<path class="canvas-edge-path' +
						edgeClass +
						'" d="' +
						graphPathD +
						'" fill="none" stroke-width="' +
						edgeStroke +
						'" vector-effect="non-scaling-stroke" />';
				}
				if (dagPathD.length) {
					inner +=
						'<defs><marker id="canvas-dag-arrow" markerWidth="5" markerHeight="5" refX="4.2" refY="2.5" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L5,2.5 L0,5 z" class="canvas-dag-arrow-head" /></marker></defs>' +
						'<path class="canvas-edge-path canvas-edge-path--dag' +
						edgeClass +
						'" d="' +
						dagPathD +
						'" fill="none" stroke-width="' +
						edgeStroke +
						'" vector-effect="non-scaling-stroke" marker-end="' +
						(isLtr ? 'none' : 'url(#canvas-dag-arrow)') +
						'" />';
				}
			}
			svg.innerHTML = inner;
		}

		if (treeSvg) {
			treeSvg.setAttribute('width', String(worldW));
			treeSvg.setAttribute('height', String(worldH));
			treeSvg.setAttribute('viewBox', '0 0 ' + worldW + ' ' + worldH);
			treeSvg.innerHTML = treePathD.length
				? '<path class="canvas-edge-path canvas-edge-path--tree" d="' +
				  treePathD +
				  '" fill="none" stroke-width="2" vector-effect="non-scaling-stroke" />'
				: '';
		}

		if (nodesEl) {
			let html = '';
			for (const dl of docLabels) {
				const doc = state.docs[dl.docIdx];
				const dropHi = doc && docMatchesHighlight(doc, state.highlightPath);
				html +=
					'<div class="doc-cluster-label' +
					(dropHi ? ' doc-cluster-label--drop' : '') +
					'" style="left:' +
					dl.x +
					'px;top:12px">' +
					escapeHtml(dl.text) +
					'</div>';
			}
			const sortedFrames = isLtr
				? []
				: (groupFrames || []).slice().sort((a, b) => b.w * b.h - a.w * a.h);
			for (const g of sortedFrames) {
				html +=
					'<div class="task-group-frame' +
					(g.nested ? ' task-group-frame--nested' : '') +
					'" style="left:' +
					g.x +
					'px;top:' +
					g.y +
					'px;width:' +
					g.w +
					'px;height:' +
					g.h +
					'px" data-gid="' +
					escapeHtml(g.gid) +
					'"></div>';
			}
			for (const c of cells) {
				const showToggle = !isTear && headingHasCollapseToggle(c);
				const expanded = !collapsedHeadingGids.has(c.gid);
				const badge = isTear ? tearDropBadge(c.title) : '';
				const tip = String(c.title || '');
				const cls =
					'heading-box' +
					(isTear ? ' heading-box--teardrop' : '') +
					(isTear && c.hasChildren ? ' heading-box--teardrop-branch' : '') +
					(isTear && !expanded && c.hasChildren ? ' is-collapsed' : '') +
					(c.taskGroupGid ? ' heading-box--in-task-group' : '') +
					(c.isDocHierarchy ? ' heading-box--doc-hierarchy' : '') +
					(c.hierarchyDepth != null ? ' heading-box--h-depth-' + Math.min(c.hierarchyDepth, 6) : '') +
					(parentHl.has(c.gid) ? ' heading-box--hl-parent' : '') +
					(childHl.has(c.gid) ? ' heading-box--hl-child' : '');
				html +=
					'<div class="' +
					cls +
					'" style="left:' +
					c.x +
					'px;top:' +
					c.y +
					'px;width:' +
					boxW +
					'px;min-height:' +
					boxH +
					'px" data-gid="' +
					escapeHtml(c.gid) +
					'"' +
					(isTear ? ' title="' + escapeHtml(tip) + '"' : '') +
					'>';
				if (isTear) {
					html +=
						'<span class="hb-tear-badge' +
						(badge === '#' ? ' hb-tear-badge--hash' : '') +
						'">' +
						escapeHtml(badge) +
						'</span>';
				} else {
					if (showToggle) {
						html +=
							'<button type="button" class="heading-toggle" data-gid="' +
							escapeHtml(c.gid) +
							'" title="' +
							(c.collapseDocOnly
								? expanded
									? 'Collapse non-task headings under this task'
									: 'Expand non-task headings under this task'
								: c.isWorkflowRoot
									? expanded
										? 'Collapse entire workflow'
										: 'Expand entire workflow'
									: c.hasChildren
										? expanded
											? 'Collapse nested headings'
											: 'Expand nested headings'
										: expanded
											? 'Collapse'
											: 'Expand') +
							'" aria-expanded="' +
							(expanded ? 'true' : 'false') +
							'">' +
							(c.hasChildren ? (expanded ? '▼' : '▲') : expanded ? '▼' : '▲') +
							'</button>';
					}
					html +=
						'<button type="button" class="heading-nav heading-nav--parent' +
						(navParentActive.has(c.gid) ? ' is-active' : '') +
						'" data-gid="' +
						escapeHtml(c.gid) +
						'" data-nav="parent" title="Highlight ancestors and same-level siblings">\u2191</button>';
					html +=
						'<button type="button" class="heading-nav heading-nav--child' +
						(navChildActive.has(c.gid) ? ' is-active' : '') +
						'" data-gid="' +
						escapeHtml(c.gid) +
						'" data-nav="child" title="Highlight this heading and all below it">\u2193</button>';
					html += '<span class="hb-title">' + escapeHtml(c.title) + '</span>';
				}
				html += '</div>';
			}
			nodesEl.innerHTML = html;
		}

		const world = $('canvas-world');
		if (world) {
			world.style.width = worldW + 'px';
			world.style.height = worldH + 'px';
			world.style.minWidth = worldW + 'px';
			world.style.minHeight = worldH + 'px';
		}
		applyWorldTransform();
	}

	function render() {
		renderGraph();
	}

	function applyCanvasState(msg) {
		state.types = msg.types || [];
		state.visibleTypeIds = msg.visibleTypeIds || [];
		state.canvasShowUntyped = msg.canvasShowUntyped !== false;
		state.docs = msg.docs || [];
		state.highlightPath = msg.highlightPath || '';
		state.mode = msg.mode || 'empty';
		navParentActive.clear();
		navChildActive.clear();
		nodeGraphSim.clear();
		nodeGraphEdges = [];
		stopNodeGraphSim();
		view.tx = 40;
		view.ty = 40;
		view.scale = 1;
		render();
		openSettingsPopulate();
		populateNodeGraphFilter();
	}

	function openSettingsPopulate() {
		const box = $('type-checkboxes');
		if (!box) return;
		const untypedCb = $('cb-canvas-untyped');
		if (untypedCb) {
			untypedCb.checked = state.canvasShowUntyped !== false;
		}
		const visible = new Set(state.visibleTypeIds || []);
		let html = '';
		for (const t of state.types) {
			const checked =
				!state.visibleTypeIds.length || visible.has(t.id) ? ' checked' : '';
			html +=
				'<label><input type="checkbox" data-type-id="' +
				escapeHtml(t.id) +
				'"' +
				checked +
				'><span>' +
				escapeHtml(t.marker || t.label) +
				' — ' +
				escapeHtml(t.label) +
				'</span></label>';
		}
		if (!html) {
			html = '<p class="settings-meta">No metadata types in settings.</p>';
		}
		box.innerHTML = html;
	}

	function setupPanZoom() {
		const vp = $('canvas-viewport');
		if (!vp) return;

		vp.addEventListener(
			'wheel',
			e => {
				e.preventDefault();
				const delta = e.deltaY;
				const factor = Math.exp(-delta * 0.0012);
				let s = view.scale * factor;
				s = Math.max(view.minScale, Math.min(view.maxScale, s));
				view.scale = s;
				applyWorldTransform();
			},
			{ passive: false }
		);

		vp.addEventListener('mousedown', e => {
			if (e.button !== 0) return;
			if (/** @type {HTMLElement} */ (e.target).closest('.heading-toggle')) return;
			if (/** @type {HTMLElement} */ (e.target).closest('.heading-nav')) return;
			if (/** @type {HTMLElement} */ (e.target).closest('.heading-box')) return;
			if (/** @type {HTMLElement} */ (e.target).closest('.node-graph-node')) return;
			view.panning = true;
			view.lastX = e.clientX;
			view.lastY = e.clientY;
			vp.classList.add('is-panning');
		});

		window.addEventListener('mousemove', e => {
			if (nodeGraphDrag) {
				const n = nodeGraphSim.get(nodeGraphDrag.id);
				const vp = $('canvas-viewport');
				if (!n || !vp) return;
				const rect = vp.getBoundingClientRect();
				const worldX = (e.clientX - rect.left - view.tx) / view.scale;
				const worldY = (e.clientY - rect.top - view.ty) / view.scale;
				n.x = worldX - NG.ORIGIN;
				n.y = worldY - NG.ORIGIN;
				n.vx = 0;
				n.vy = 0;
				kickNodeGraphSim();
				return;
			}
			if (!view.panning) return;
			view.tx += e.clientX - view.lastX;
			view.ty += e.clientY - view.lastY;
			view.lastX = e.clientX;
			view.lastY = e.clientY;
			applyWorldTransform();
		});

		window.addEventListener('mouseup', () => {
			if (nodeGraphDrag) kickNodeGraphSim();
			nodeGraphDrag = null;
			view.panning = false;
			vp.classList.remove('is-panning');
		});

		function dragVisualActive(on) {
			if (on) vp.classList.add('drag-active');
			else vp.classList.remove('drag-active');
		}

		function onGlobalDragEnter(e) {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		}

		function onGlobalDragOver(e) {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			dragVisualActive(true);
		}

		function onGlobalDragEnd() {
			dragVisualActive(false);
		}

		function onGlobalDrop(e) {
			e.preventDefault();
			dragVisualActive(false);
			void (async () => {
				const paths = await pathsFromDropAsync(e);
				if (paths.length) vscode.postMessage({ type: 'loadPaths', paths });
			})();
		}

		document.addEventListener('dragenter', onGlobalDragEnter, true);
		document.addEventListener('dragover', onGlobalDragOver, true);
		document.addEventListener('drop', onGlobalDrop, true);
		document.addEventListener('dragend', onGlobalDragEnd, true);

		const nodesHost = $('canvas-nodes');
		if (nodesHost) {
			nodesHost.addEventListener('mousedown', e => {
				if (state.canvasView !== CANVAS_VIEW_NODE_GRAPH || e.button !== 0) return;
				const node = /** @type {HTMLElement} */ (e.target).closest('.node-graph-node');
				if (!node) return;
				const id = node.getAttribute('data-node-graph-id');
				const n = id ? nodeGraphSim.get(id) : null;
				if (!id || !n) return;
				e.preventDefault();
				e.stopPropagation();
				nodeGraphDrag = { id };
				n.vx = 0;
				n.vy = 0;
				kickNodeGraphSim();
			});
			nodesHost.addEventListener('click', e => {
				const tearNode = /** @type {HTMLElement} */ (e.target).closest(
					'.heading-box--teardrop[data-tear-toggle="1"]'
				);
				if (tearNode && state.canvasView === CANVAS_VIEW_TEARDROP) {
					e.preventDefault();
					e.stopPropagation();
					const gid = tearNode.getAttribute('data-gid');
					if (!gid) return;
					if (collapsedHeadingGids.has(gid)) collapsedHeadingGids.delete(gid);
					else collapsedHeadingGids.add(gid);
					renderGraph();
					return;
				}
				const nav = /** @type {HTMLElement} */ (e.target).closest('.heading-nav');
				if (nav) {
					e.preventDefault();
					e.stopPropagation();
					const gid = nav.getAttribute('data-gid');
					const kind = nav.getAttribute('data-nav');
					if (!gid || !kind) return;
					if (kind === 'parent') {
						if (navParentActive.has(gid)) navParentActive.delete(gid);
						else navParentActive.add(gid);
					} else if (kind === 'child') {
						if (navChildActive.has(gid)) navChildActive.delete(gid);
						else navChildActive.add(gid);
					}
					renderGraph();
					return;
				}
				const btn = /** @type {HTMLElement} */ (e.target).closest('.heading-toggle');
				if (!btn) return;
				e.preventDefault();
				e.stopPropagation();
				const gid = btn.getAttribute('data-gid');
				if (!gid) return;
				if (collapsedHeadingGids.has(gid)) {
					collapsedHeadingGids.delete(gid);
				} else {
					collapsedHeadingGids.add(gid);
				}
				renderGraph();
			});
		}
	}

	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.type === 'canvasState') applyCanvasState(msg);
	});

	const btnAdd = $('btn-add-files');
	if (btnAdd) btnAdd.addEventListener('click', () => vscode.postMessage({ type: 'pickFiles' }));

	const btnReset = $('btn-zoom-reset');
	if (btnReset)
		btnReset.addEventListener('click', () => {
			view.tx = 40;
			view.ty = 40;
			view.scale = 1;
			applyWorldTransform();
		});

	const btnClear = $('btn-clear');
	if (btnClear)
		btnClear.addEventListener('click', () => {
			vscode.postMessage({ type: 'clearSession' });
		});

	const btnSettings = $('btn-settings');
	if (btnSettings)
		btnSettings.addEventListener('click', () => {
			openSettingsPopulate();
			const sp = $('settings-panel');
			if (sp) sp.classList.remove('hidden');
		});
	const btnCloseSettings = $('btn-close-settings');
	if (btnCloseSettings)
		btnCloseSettings.addEventListener('click', () => {
			const sp = $('settings-panel');
			if (sp) sp.classList.add('hidden');
		});
	const btnSaveTypes = $('btn-save-types');
	if (btnSaveTypes)
		btnSaveTypes.addEventListener('click', () => {
			const boxes = document.querySelectorAll('#type-checkboxes input[type="checkbox"]');
			const ids = [];
			boxes.forEach(b => {
				if (b.checked) ids.push(b.getAttribute('data-type-id'));
			});
			const ut = $('cb-canvas-untyped');
			vscode.postMessage({
				type: 'saveCanvasSettings',
				visibleTypeIds: ids,
				showUntyped: ut ? !!ut.checked : true
			});
			const sp = $('settings-panel');
			if (sp) sp.classList.add('hidden');
		});

	const settingsPanel = $('settings-panel');
	if (settingsPanel)
		settingsPanel.addEventListener('click', ev => {
			if (ev.target && /** @type {HTMLElement} */ (ev.target).id === 'settings-panel') {
				settingsPanel.classList.add('hidden');
			}
		});

	const relationTypesHost = $('node-graph-relation-types');
	if (relationTypesHost)
		relationTypesHost.addEventListener('change', event => {
			const input = /** @type {HTMLInputElement} */ (event.target);
			const type = input?.getAttribute?.('data-relation-type');
			if (!type) return;
			if (input.checked) state.nodeGraphVisibleRelations.add(type);
			else state.nodeGraphVisibleRelations.delete(type);
			kickNodeGraphSim();
			if (state.canvasView === CANVAS_VIEW_NODE_GRAPH) renderNodeGraph();
		});

	const nodeFilterToggle = $('btn-node-filter-toggle');
	if (nodeFilterToggle)
		nodeFilterToggle.addEventListener('click', () => {
			const filter = $('node-graph-filter');
			if (!filter) return;
			const collapsed = filter.classList.toggle('is-collapsed');
			nodeFilterToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
			nodeFilterToggle.textContent = collapsed ? 'Relations ▸' : 'Relations ▾';
		});

	setupPanZoom();
	applyCanvasViewBodyClass();

	const selCanvasView = $('sel-canvas-view');
	if (selCanvasView) {
		selCanvasView.value = state.canvasView;
		selCanvasView.addEventListener('change', () => {
			state.canvasView = normalizeCanvasView(selCanvasView.value);
			persistCanvasView();
			renderGraph();
		});
	}
})();
