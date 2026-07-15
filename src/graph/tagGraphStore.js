'use strict';

const vscode = require('vscode');
const { KB_ROOT_KEY } = require('../shared/constants');

/**
 * Tag graph persistence (extension globalState).
 *
 * Canonical model (v2): one global directed multigraph + a tree of node ownership.
 * - nodes[]: every tag at every level; parentId === null → root (main canvas).
 * - links[]: directed edges; endpoints are node ids (any level, subject to mutation rules).
 * - nest: optional {x,y} — position of a node when it is the *focus* of a nested graph view
 *   (children workspace). Root nodes also use x,y for the main canvas layout.
 *
 * This shape is friendly for future features: subgraph views = filter by parentId / BFS from
 * a focus id, search = scan nodes, overview = project or sample the same store.
 *
 * Multiple graphs: registry in TAG_GRAPH_REGISTRY_KEY; each graph payload in drip.tagGraph.blob.<id>.
 * Legacy single-key TAG_GRAPH_KEY is migrated once on initializeMultiGraphStorage().
 */
const TAG_GRAPH_KEY = 'drip.tagGraph.v1';
const TAG_GRAPH_REGISTRY_KEY = 'drip.tagGraph.registry.v1';
const TAG_GRAPHS_SUBDIR = 'tag-graphs';
const TAG_GRAPHS_FOLDER_URI_KEY = 'drip.tagGraph.folderUri.v1';

/** @param {string} graphId */
function graphBlobKey(graphId) {
	return `drip.tagGraph.blob.${String(graphId)}`;
}

/** @param {string} raw */
function graphFileSlug(raw) {
	const base = String(raw || '')
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return base || 'graph';
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} label
 * @param {Set<string>} [taken]
 */
async function uniqueGraphIdFromLabel(context, label, taken) {
	const dir = getTagGraphsStorageDirectoryUri(context);
	await vscode.workspace.fs.createDirectory(dir);
	const localTaken = new Set(taken || []);
	try {
		const entries = await vscode.workspace.fs.readDirectory(dir);
		for (const [name, kind] of entries) {
			if (kind !== vscode.FileType.File) continue;
			if (!name.toLowerCase().endsWith('.json')) continue;
			localTaken.add(String(name.slice(0, -5)));
		}
	} catch {
		// ignore
	}
	const root = graphFileSlug(label);
	if (!localTaken.has(root)) return root;
	let i = 2;
	while (localTaken.has(`${root}-${i}`)) i++;
	return `${root}-${i}`;
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @returns {import('vscode').Uri | undefined}
 */
function getKnowledgeBaseRootUri(context) {
	const raw = context.workspaceState.get(KB_ROOT_KEY);
	if (typeof raw !== 'string' || !raw.trim()) {
		return undefined;
	}
	try {
		return vscode.Uri.parse(raw);
	} catch {
		return undefined;
	}
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @returns {import('vscode').Uri | undefined}
 */
function getKbGraphsDirectoryUri(context) {
	const kbRoot = getKnowledgeBaseRootUri(context);
	if (!kbRoot) {
		return undefined;
	}
	return vscode.Uri.joinPath(kbRoot, '.dripindex', 'graphs.drip');
}

/**
 * Tag graphs are always stored under the active KB's `.dripindex/graphs.drip`.
 * @param {import('vscode').ExtensionContext} context
 * @returns {import('vscode').Uri}
 */
function getTagGraphsStorageDirectoryUri(context) {
	const kbGraphs = getKbGraphsDirectoryUri(context);
	if (kbGraphs) {
		return kbGraphs;
	}
	return vscode.Uri.joinPath(context.globalStorageUri, TAG_GRAPHS_SUBDIR);
}

/**
 * Reads all `*.json` graph files from the selected storage folder and ensures
 * DRIP registry/blobs reflect those files.
 * @param {import('vscode').ExtensionContext} context
 * @param {{ graphsDirUri?: import('vscode').Uri, preferredActiveGraphId?: string }} [options]
 */
async function syncStoredGraphsFromFolder(context, options) {
	const dir = (options && options.graphsDirUri) || getTagGraphsStorageDirectoryUri(context);
	await vscode.workspace.fs.createDirectory(dir);
	/** @type {{ version: number, activeGraphId: string, graphs: { id: string, name: string, updatedAt: number }[] }} */
	const prevReg = getRegistry(context);
	let reg = { version: 1, activeGraphId: 'default', graphs: [] };
	const preferredActive =
		options && typeof options.preferredActiveGraphId === 'string'
			? String(options.preferredActiveGraphId).trim()
			: '';
	const previousActiveId =
		preferredActive ||
		(prevReg && typeof prevReg.activeGraphId === 'string' && prevReg.activeGraphId.trim()
			? String(prevReg.activeGraphId)
			: '');
	const existing = new Map(
		prevReg && Array.isArray(prevReg.graphs)
			? prevReg.graphs.map(g => [String(g.id), g])
			: []
	);
	const entries = await vscode.workspace.fs.readDirectory(dir);
	const discoveredSet = new Set();
	for (const [name, kind] of entries) {
		if (kind !== vscode.FileType.File) continue;
		if (!name.toLowerCase().endsWith('.json')) continue;
		const graphId = String(name.slice(0, -5)).trim();
		if (!graphId) continue;
		const file = vscode.Uri.joinPath(dir, name);
		let rawText = '';
		try {
			const buf = await vscode.workspace.fs.readFile(file);
			rawText = Buffer.from(buf).toString('utf8');
		} catch {
			continue;
		}
		let rawParsed;
		try {
			rawParsed = JSON.parse(rawText);
		} catch {
			continue;
		}
		const hasEnvelope = rawParsed && typeof rawParsed === 'object' && rawParsed.dripTagGraphExport === true;
		let fileGraphId = graphId;
		if (hasEnvelope && rawParsed.graphId) {
			fileGraphId = String(rawParsed.graphId).trim() || graphId;
		}
		let norm;
		try {
			norm = parseImportedTagGraphJson(rawText);
		} catch {
			continue;
		}
		discoveredSet.add(fileGraphId);
		await context.globalState.update(graphBlobKey(fileGraphId), norm);
		const hit = existing.get(fileGraphId);
		const envelopeName = hasEnvelope && rawParsed.name ? String(rawParsed.name).trim() : '';
		reg.graphs.push({
			id: fileGraphId,
			name: envelopeName || (hit ? String(hit.name || fileGraphId) : fileGraphId),
			updatedAt: Date.now()
		});
	}
	if (prevReg && Array.isArray(prevReg.graphs)) {
		for (const g of prevReg.graphs) {
			const gid = String(g.id || '').trim();
			if (!gid || discoveredSet.has(gid)) continue;
			await context.globalState.update(graphBlobKey(gid), undefined);
		}
	}
	if (!reg.graphs.length) {
		const firstId = 'default';
		const initial = emptyGraph();
		reg.graphs = [{ id: firstId, name: 'Default', updatedAt: Date.now() }];
		reg.activeGraphId = firstId;
		await context.globalState.update(graphBlobKey(firstId), initial);
		await writeGraphMirrorToDisk(context, firstId, initial, 'Default');
	}
	if (previousActiveId && reg.graphs.some(g => g.id === previousActiveId)) {
		reg.activeGraphId = previousActiveId;
	} else {
		reg.activeGraphId = reg.graphs[0].id;
	}
	await context.globalState.update(TAG_GRAPH_REGISTRY_KEY, reg);
}

/**
 * Drop in-memory tag graphs from a previous KB and load this KB's `.dripindex/graphs.drip`.
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').Uri} kbRootUri
 */
async function reloadTagGraphsForKnowledgeBase(context, kbRootUri) {
	await context.globalState.update(TAG_GRAPHS_FOLDER_URI_KEY, undefined);

	const prevReg = getRegistry(context);
	if (prevReg && Array.isArray(prevReg.graphs)) {
		for (const g of prevReg.graphs) {
			const gid = String(g.id || '').trim();
			if (gid) {
				await context.globalState.update(graphBlobKey(gid), undefined);
			}
		}
	}

	const graphsDir = vscode.Uri.joinPath(kbRootUri, '.dripindex', 'graphs.drip');
	await syncStoredGraphsFromFolder(context, {
		graphsDirUri: graphsDir,
		preferredActiveGraphId: 'default'
	});
}

/**
 * @deprecated Custom graph folders are not supported; graphs live in the active KB only.
 */
async function setTagGraphsStorageDirectoryUri(context, _folderUri) {
	await context.globalState.update(TAG_GRAPHS_FOLDER_URI_KEY, undefined);
	const kbRoot = getKnowledgeBaseRootUri(context);
	if (kbRoot) {
		await reloadTagGraphsForKnowledgeBase(context, kbRoot);
	} else {
		await syncStoredGraphsFromFolder(context);
	}
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} graphId
 * @param {ReturnType<typeof normalizeGraph>} norm
 */
async function writeGraphMirrorToDisk(context, graphId, norm, graphName) {
	try {
		const dir = getTagGraphsStorageDirectoryUri(context);
		await vscode.workspace.fs.createDirectory(dir);
		const file = vscode.Uri.joinPath(dir, `${String(graphId)}.json`);
		const envelope = {
			dripTagGraphExport: true,
			exportFormat: 1,
			graphId: String(graphId),
			name: String(graphName || graphId),
			savedAt: new Date().toISOString(),
			graph: norm
		};
		const text = JSON.stringify(envelope, null, 2);
		await vscode.workspace.fs.writeFile(file, Buffer.from(text, 'utf8'));
	} catch (e) {
		console.error('[DRIP] tag graph disk mirror failed', e);
	}
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} graphId
 */
async function deleteGraphMirrorFromDisk(context, graphId) {
	try {
		const file = vscode.Uri.joinPath(getTagGraphsStorageDirectoryUri(context), `${String(graphId)}.json`);
		await vscode.workspace.fs.delete(file, { useTrash: false });
	} catch {
		// missing file is fine
	}
}

/** Ensures graph storage folder exists. */
async function ensureTagGraphMirrorFolder(context) {
	try {
		const dir = getTagGraphsStorageDirectoryUri(context);
		await vscode.workspace.fs.createDirectory(dir);
	} catch (e) {
		console.error('[DRIP] tag graph folder ensure failed', e);
	}
}

/**
 * @returns {{ version: number, activeGraphId: string, graphs: { id: string, name: string, updatedAt: number }[] } | null}
 */
function getRegistry(context) {
	const r = context.globalState.get(TAG_GRAPH_REGISTRY_KEY);
	if (!r || typeof r !== 'object') return null;
	return r;
}

/**
 * Call once from extension activate (await). Migrates legacy drip.tagGraph.v1 into blob `default`.
 * @param {import('vscode').ExtensionContext} context
 */
async function initializeMultiGraphStorage(context) {
	await context.globalState.update(TAG_GRAPHS_FOLDER_URI_KEY, undefined);
	const kbRoot = getKnowledgeBaseRootUri(context);
	if (kbRoot) {
		await reloadTagGraphsForKnowledgeBase(context, kbRoot);
		return;
	}

	let reg = getRegistry(context);
	if (
		reg &&
		reg.version === 1 &&
		Array.isArray(reg.graphs) &&
		reg.graphs.length > 0 &&
		String(reg.activeGraphId || '').trim()
	) {
		const bid = String(reg.activeGraphId);
		if (context.globalState.get(graphBlobKey(bid)) == null) {
			await context.globalState.update(graphBlobKey(bid), emptyGraph());
		}
		await syncStoredGraphsFromFolder(context);
		return;
	}
	const legacy = context.globalState.get(TAG_GRAPH_KEY);
	const firstId = 'default';
	reg = {
		version: 1,
		activeGraphId: firstId,
		graphs: [{ id: firstId, name: 'Default', updatedAt: Date.now() }]
	};
	await context.globalState.update(TAG_GRAPH_REGISTRY_KEY, reg);
	const initial = legacy != null ? normalizeGraph(legacy) : emptyGraph();
	await context.globalState.update(graphBlobKey(firstId), initial);
	if (legacy != null) {
		await context.globalState.update(TAG_GRAPH_KEY, undefined);
	}
	await writeGraphMirrorToDisk(context, firstId, initial, 'Default');
	void ensureTagGraphMirrorFolder(context);
	await syncStoredGraphsFromFolder(context);
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
function listStoredTagGraphs(context) {
	const reg = getRegistry(context);
	if (!reg || !Array.isArray(reg.graphs)) return [];
	return reg.graphs.map(g => ({
		id: String(g.id),
		name: String(g.name || g.id),
		updatedAt: typeof g.updatedAt === 'number' ? g.updatedAt : 0
	}));
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
function getActiveStoredTagGraphMeta(context) {
	const reg = getRegistry(context);
	if (!reg) return { id: 'default', name: 'Default' };
	const id = String(reg.activeGraphId || '');
	const entry = reg.graphs.find(g => g.id === id);
	return { id, name: entry ? String(entry.name) : id };
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} name
 * @param {{ activate?: boolean }} [options] When `activate` is false, the previously active graph stays selected.
 * @returns {Promise<string>} new graph id
 */
async function createStoredTagGraph(context, name, options) {
	const reg = getRegistry(context);
	if (!reg) {
		await initializeMultiGraphStorage(context);
	}
	const r2 = getRegistry(context);
	const activateNew = !(options && options.activate === false);
	const prevActive =
		r2 && r2.graphs.length
			? String(r2.activeGraphId || r2.graphs[0].id || '').trim()
			: '';
	const label = String(name || '').trim() || 'Untitled graph';
	const taken = new Set(r2.graphs.map(g => String(g.id)));
	const id = await uniqueGraphIdFromLabel(context, label, taken);
	r2.graphs.push({ id, name: label, updatedAt: Date.now() });
	if (activateNew) {
		r2.activeGraphId = id;
	} else if (prevActive && r2.graphs.some(g => g.id === prevActive)) {
		r2.activeGraphId = prevActive;
	} else {
		r2.activeGraphId = id;
	}
	await context.globalState.update(TAG_GRAPH_REGISTRY_KEY, r2);
	const empty = emptyGraph();
	await context.globalState.update(graphBlobKey(id), empty);
	await writeGraphMirrorToDisk(context, id, empty, label);
	return id;
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} graphId
 */
async function activateStoredTagGraph(context, graphId) {
	const gid = String(graphId || '').trim();
	const reg = getRegistry(context);
	if (!reg || !reg.graphs.some(g => g.id === gid)) {
		throw new Error('Unknown tags graph');
	}
	reg.activeGraphId = gid;
	await context.globalState.update(TAG_GRAPH_REGISTRY_KEY, reg);
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} graphId
 * @param {string} newName
 */
async function renameStoredTagGraph(context, graphId, newName) {
	const gid = String(graphId || '').trim();
	const reg = getRegistry(context);
	if (!reg) return;
	const entry = reg.graphs.find(g => g.id === gid);
	if (!entry) return;
	entry.name = String(newName || '').trim() || entry.name;
	entry.updatedAt = Date.now();
	await context.globalState.update(TAG_GRAPH_REGISTRY_KEY, reg);
	const payload = context.globalState.get(graphBlobKey(gid));
	if (payload != null) {
		await writeGraphMirrorToDisk(context, gid, normalizeGraph(payload), entry.name);
	}
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} graphId
 */
async function removeStoredTagGraph(context, graphId) {
	const gid = String(graphId || '').trim();
	const reg = getRegistry(context);
	if (!reg || reg.graphs.length <= 1) {
		throw new Error('Cannot remove the last tags graph');
	}
	const idx = reg.graphs.findIndex(g => g.id === gid);
	if (idx < 0) throw new Error('Unknown tags graph');
	reg.graphs.splice(idx, 1);
	await context.globalState.update(graphBlobKey(gid), undefined);
	await deleteGraphMirrorFromDisk(context, gid);
	if (reg.activeGraphId === gid) {
		reg.activeGraphId = reg.graphs[0].id;
	}
	await context.globalState.update(TAG_GRAPH_REGISTRY_KEY, reg);
}

/**
 * Replace active graph data with normalized graph (e.g. import).
 * @param {import('vscode').ExtensionContext} context
 * @param {unknown} rawGraph
 */
async function replaceActiveStoredTagGraphData(context, rawGraph) {
	const reg = getRegistry(context);
	if (!reg) await initializeMultiGraphStorage(context);
	const r2 = getRegistry(context);
	const id = String(r2.activeGraphId);
	const norm = normalizeGraph(rawGraph);
	await context.globalState.update(graphBlobKey(id), norm);
	const entryName = (r2.graphs.find(g => g.id === id) || {}).name || id;
	await writeGraphMirrorToDisk(context, id, norm, entryName);
	const entry = r2.graphs.find(g => g.id === id);
	if (entry) entry.updatedAt = Date.now();
	await context.globalState.update(TAG_GRAPH_REGISTRY_KEY, r2);
}

/**
 * Add a new stored graph with initial payload.
 * @param {import('vscode').ExtensionContext} context
 * @param {string} name
 * @param {unknown} rawGraph
 */
async function importStoredTagGraphAsNew(context, name, rawGraph) {
	const reg = getRegistry(context);
	if (!reg) await initializeMultiGraphStorage(context);
	const r2 = getRegistry(context);
	const label = String(name || '').trim() || 'Imported graph';
	const taken = new Set(r2.graphs.map(g => String(g.id)));
	const id = await uniqueGraphIdFromLabel(context, label, taken);
	r2.graphs.push({ id, name: label, updatedAt: Date.now() });
	r2.activeGraphId = id;
	await context.globalState.update(TAG_GRAPH_REGISTRY_KEY, r2);
	const norm = normalizeGraph(rawGraph);
	await context.globalState.update(graphBlobKey(id), norm);
	await writeGraphMirrorToDisk(context, id, norm, label);
	return id;
}

/**
 * @param {unknown} text
 * @returns {ReturnType<typeof normalizeGraph>}
 */
function parseImportedTagGraphJson(text) {
	let raw;
	try {
		raw = JSON.parse(String(text || ''));
	} catch {
		throw new Error('Invalid JSON');
	}
	if (raw && typeof raw === 'object' && raw.dripTagGraphExport === true && raw.graph != null) {
		raw = raw.graph;
	}
	return normalizeGraph(raw);
}

function emptyGraph() {
	return {
		version: 2,
		nodes: [],
		links: [],
		relationTypes: [{ id: 'main', name: 'Main' }],
		groups: []
	};
}

function newTagId() {
	return `t-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function newSubTagId() {
	return `st-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {unknown} raw
 * @returns {ReturnType<typeof emptyGraph>}
 */
function normalizeGraph(raw) {
	if (!raw || typeof raw !== 'object') {
		return emptyGraph();
	}
	if (Number(raw.version) >= 2 && Array.isArray(raw.nodes)) {
		return normalizeV2(raw);
	}
	return migrateV1ToV2(raw);
}

/**
 * @param {unknown} raw
 */
function migrateV1ToV2(raw) {
	const nodes = [];
	const links = [];
	const rootLinks = Array.isArray(raw.links) ? raw.links : [];
	for (const l of rootLinks) {
		if (!l || typeof l !== 'object') continue;
		const from = String(l.from || '').trim();
		const to = String(l.to || '').trim();
		if (from && to) links.push({ from, to });
	}
	const tags = Array.isArray(raw.tags) ? raw.tags : [];
	for (const t of tags) {
		if (!t || typeof t !== 'object') continue;
		const id = String(t.id || '').trim();
		if (!id) continue;
		const label = String(t.label || 'tag').trim() || 'tag';
		const x = typeof t.x === 'number' && Number.isFinite(t.x) ? t.x : undefined;
		const y = typeof t.y === 'number' && Number.isFinite(t.y) ? t.y : undefined;
		let sub = t.subGraph && typeof t.subGraph === 'object' ? t.subGraph : null;
		if (!sub && Array.isArray(t.subTags) && t.subTags.length > 0) {
			sub = migrateSubTagsTreeToSubGraph(t.subTags, id);
		}
		if (!sub) sub = { tags: [], links: [], anchor: { x: 0, y: 0 } };
		const ax = sub.anchor && typeof sub.anchor.x === 'number' && Number.isFinite(sub.anchor.x) ? sub.anchor.x : 0;
		const ay = sub.anchor && typeof sub.anchor.y === 'number' && Number.isFinite(sub.anchor.y) ? sub.anchor.y : 0;
		nodes.push({
			id,
			label,
			parentId: null,
			x,
			y,
			nest: { x: ax, y: ay }
		});
		const tagList = Array.isArray(sub.tags) ? sub.tags : [];
		for (const st of tagList) {
			if (!st || typeof st !== 'object') continue;
			const sid = String(st.id || '').trim() || newSubTagId();
			if (sid === id) continue;
			const slab = String(st.label || '').trim() || 'subtag';
			const sx = typeof st.x === 'number' && Number.isFinite(st.x) ? st.x : undefined;
			const sy = typeof st.y === 'number' && Number.isFinite(st.y) ? st.y : undefined;
			nodes.push({ id: sid, label: slab, parentId: id, x: sx, y: sy, nest: { x: 0, y: 0 } });
		}
		const slinks = Array.isArray(sub.links) ? sub.links : [];
		for (const l of slinks) {
			if (!l || typeof l !== 'object') continue;
			const from = String(l.from || '').trim();
			const to = String(l.to || '').trim();
			if (from && to) links.push({ from, to });
		}
	}
	return normalizeV2({ version: 2, nodes, links });
}

/**
 * Legacy tree subTags → mini graph (parent→child edges, default layout).
 * @param {unknown} rawTree
 * @param {string} parentGraphTagId
 */
function migrateSubTagsTreeToSubGraph(rawTree, parentGraphTagId) {
	const tags = [];
	const links = [];
	let i = 0;
	function walk(nodes, parentId) {
		if (!Array.isArray(nodes)) return;
		for (const n of nodes) {
			if (!n || typeof n !== 'object') continue;
			const id = String(n.id || '').trim() || newSubTagId();
			const label = String(n.label || '').trim() || 'subtag';
			const ang = (2 * Math.PI * i) / 16;
			i++;
			tags.push({ id, label, x: Math.cos(ang) * 72, y: Math.sin(ang) * 72 });
			if (parentId) links.push({ from: parentId, to: id });
			walk(Array.isArray(n.children) ? n.children : [], id);
		}
	}
	walk(rawTree, null);
	return { tags, links, anchor: { x: 0, y: 0 } };
}

/**
 * @param {unknown} raw
 */
function normalizeV2(raw) {
	const nodeList = Array.isArray(raw.nodes) ? raw.nodes : [];
	const nodes = [];
	for (const t of nodeList) {
		if (!t || typeof t !== 'object') continue;
		const id = String(t.id || '').trim();
		if (!id) continue;
		const label = String(t.label || 'tag').trim() || 'tag';
		let parentId = t.parentId == null || t.parentId === '' ? null : String(t.parentId).trim();
		if (parentId === id) parentId = null;
		const x = typeof t.x === 'number' && Number.isFinite(t.x) ? t.x : undefined;
		const y = typeof t.y === 'number' && Number.isFinite(t.y) ? t.y : undefined;
		let nest = { x: 0, y: 0 };
		if (t.nest && typeof t.nest === 'object') {
			const nx = t.nest.x;
			const ny = t.nest.y;
			if (typeof nx === 'number' && Number.isFinite(nx)) nest.x = nx;
			if (typeof ny === 'number' && Number.isFinite(ny)) nest.y = ny;
		}
		const groupId = String(t.groupId || '').trim();
		nodes.push({ id, label, parentId, x, y, nest, groupId });
	}
	const idSet = new Set(nodes.map(n => n.id));
	for (const n of nodes) {
		if (n.parentId != null && !idSet.has(n.parentId)) {
			n.parentId = null;
		}
	}
	const links = Array.isArray(raw.links)
		? raw.links
				.map(l => {
					if (!l || typeof l !== 'object') return null;
					const from = String(l.from || '').trim();
					const to = String(l.to || '').trim();
					if (!from || !to || !idSet.has(from) || !idSet.has(to)) return null;
					return { from, to, relationId: String(l.relationId || 'main') || 'main' };
				})
				.filter(Boolean)
		: [];
	const relationTypesRaw = Array.isArray(raw.relationTypes) ? raw.relationTypes : [{ id: 'main', name: 'Main' }];
	/** @type {{ id: string, name: string }[]} */
	const relationTypes = [];
	const relationSet = new Set();
	for (const r of relationTypesRaw) {
		if (!r || typeof r !== 'object') continue;
		const id = String(r.id || '').trim();
		const name = String(r.name || '').trim();
		if (!id || !name || relationSet.has(id)) continue;
		relationTypes.push({ id, name });
		relationSet.add(id);
	}
	if (!relationSet.has('main')) {
		relationTypes.unshift({ id: 'main', name: 'Main' });
		relationSet.add('main');
	}
	const groupsRaw = Array.isArray(raw.groups) ? raw.groups : [];
	/** @type {{ id: string, name: string, color: string }[]} */
	const groups = [];
	const groupSet = new Set();
	for (const g of groupsRaw) {
		if (!g || typeof g !== 'object') continue;
		const id = String(g.id || '').trim();
		const name = String(g.name || '').trim();
		const color = String(g.color || '').trim();
		if (!id || !name || !color || groupSet.has(id)) continue;
		groups.push({ id, name, color });
		groupSet.add(id);
	}
	for (const n of nodes) {
		const gid = String(n.groupId || '').trim();
		n.groupId = gid && groupSet.has(gid) ? gid : '';
	}
	for (const l of links) {
		const rid = String(l.relationId || '').trim();
		l.relationId = rid && relationSet.has(rid) ? rid : 'main';
	}
	return { version: 2, nodes, links, relationTypes, groups };
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
function loadTagGraph(context) {
	const reg = getRegistry(context);
	if (!reg || !String(reg.activeGraphId || '').trim()) {
		const legacy = context.globalState.get(TAG_GRAPH_KEY);
		return normalizeGraph(legacy);
	}
	const raw = context.globalState.get(graphBlobKey(reg.activeGraphId));
	if (raw == null) return emptyGraph();
	return normalizeGraph(raw);
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} graphId
 * @returns {ReturnType<typeof normalizeGraph>}
 */
function loadStoredTagGraphById(context, graphId) {
	const gid = String(graphId || '').trim();
	if (!gid) return emptyGraph();
	const raw = context.globalState.get(graphBlobKey(gid));
	if (raw == null) return emptyGraph();
	return normalizeGraph(raw);
}

/**
 * Persist a specific graph by id (mirrors to disk). Does not change the active graph.
 * @param {import('vscode').ExtensionContext} context
 * @param {string} graphId
 * @param {ReturnType<typeof normalizeGraph>} graph
 */
async function saveStoredTagGraphById(context, graphId, graph) {
	const gid = String(graphId || '').trim();
	if (!gid) {
		throw new Error('Missing tags graph id');
	}
	const norm = normalizeGraph(graph);
	const reg = getRegistry(context);
	if (!reg || !reg.graphs.some(g => g.id === gid)) {
		throw new Error('Unknown tags graph');
	}
	await context.globalState.update(graphBlobKey(gid), norm);
	const entry = reg.graphs.find(g => g.id === gid);
	if (entry) {
		entry.updatedAt = Date.now();
	}
	await context.globalState.update(TAG_GRAPH_REGISTRY_KEY, { ...reg });
	const entryName = entry ? String(entry.name || gid) : gid;
	await writeGraphMirrorToDisk(context, gid, norm, entryName);
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {ReturnType<typeof normalizeGraph>} graph
 */
async function saveTagGraph(context, graph) {
	const norm = normalizeGraph(graph);
	const reg = getRegistry(context);
	if (!reg || !String(reg.activeGraphId || '').trim()) {
		await context.globalState.update(TAG_GRAPH_KEY, norm);
		return;
	}
	const id = String(reg.activeGraphId);
	await context.globalState.update(graphBlobKey(id), norm);
	const entry = reg.graphs.find(g => g.id === id);
	if (entry) entry.updatedAt = Date.now();
	await context.globalState.update(TAG_GRAPH_REGISTRY_KEY, { ...reg });
	const entryName = (reg.graphs.find(g => g.id === id) || {}).name || id;
	await writeGraphMirrorToDisk(context, id, norm, entryName);
	void ensureTagGraphMirrorFolder(context);
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} id
 */
function findNode(graph, id) {
	const sid = String(id || '').trim();
	return graph.nodes.find(n => n.id === sid) || null;
}

function isRootNode(n) {
	return n && (n.parentId == null || n.parentId === '');
}

function rootIdSet(graph) {
	const s = new Set();
	for (const n of graph.nodes) {
		if (isRootNode(n)) s.add(n.id);
	}
	return s;
}

/** All descendant ids of `rootId` (including rootId). */
function subtreeIdSet(graph, rootId) {
	const rid = String(rootId || '').trim();
	const set = new Set([rid]);
	let added = true;
	while (added) {
		added = false;
		for (const n of graph.nodes) {
			if (!set.has(n.id) && n.parentId != null && set.has(n.parentId)) {
				set.add(n.id);
				added = true;
			}
		}
	}
	return set;
}

function focusClosureIdSet(graph, focusId) {
	const fid = String(focusId || '').trim();
	const set = new Set([fid]);
	for (const n of graph.nodes) {
		if (n.parentId === fid) set.add(n.id);
	}
	return set;
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} rootId
 */
function removeNodeCascade(graph, rootId) {
	const removeSet = subtreeIdSet(graph, rootId);
	graph.nodes = graph.nodes.filter(n => !removeSet.has(n.id));
	graph.links = graph.links.filter(l => !removeSet.has(l.from) && !removeSet.has(l.to));
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} label
 */
function addTag(graph, label) {
	const trimmed = String(label || '').trim() || 'untitled';
	const id = newTagId();
	graph.nodes.push({
		id,
		label: trimmed,
		parentId: null,
		nest: { x: 0, y: 0 }
	});
	return id;
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} id
 */
function removeTag(graph, id) {
	removeNodeCascade(graph, id);
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} id
 * @param {string} label
 */
function renameNode(graph, id, label) {
	const n = findNode(graph, id);
	if (!n) return;
	const s = String(label || '').trim();
	if (s) n.label = s;
}

/** @deprecated alias */
function renameTag(graph, id, label) {
	renameNode(graph, id, label);
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} fromId
 * @param {string} toId
 */
function addLink(graph, fromId, toId, relationId) {
	const a = String(fromId || '').trim();
	const b = String(toId || '').trim();
	if (!a || !b) return;
	const na = findNode(graph, a);
	const nb = findNode(graph, b);
	if (!na || !nb || !isRootNode(na) || !isRootNode(nb)) return;
	const rid = String(relationId || 'main').trim() || 'main';
	const known = new Set((graph.relationTypes || []).map(r => String(r.id || '')));
	graph.links.push({ from: a, to: b, relationId: known.has(rid) ? rid : 'main' });
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} fromId
 * @param {string} toId
 */
function removeLink(graph, fromId, toId) {
	const a = String(fromId || '').trim();
	const b = String(toId || '').trim();
	const idx = graph.links.findIndex(l => l.from === a && l.to === b);
	if (idx >= 0) graph.links.splice(idx, 1);
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {number} index
 */
function removeLinkAtIndex(graph, index) {
	const i = Number(index);
	if (!Number.isInteger(i) || i < 0 || i >= graph.links.length) return;
	graph.links.splice(i, 1);
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {number} index
 */
function reverseLinkDirectionAtIndex(graph, index) {
	const i = Number(index);
	if (!Number.isInteger(i) || i < 0 || i >= graph.links.length) return;
	const L = graph.links[i];
	const x = L.from;
	L.from = L.to;
	L.to = x;
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} a
 * @param {string} b
 * @param {'forward' | 'reverse' | 'both'} which
 */
function removeLinksBetween(graph, a, b, which, relationId) {
	const A = String(a || '').trim();
	const B = String(b || '').trim();
	if (!A || !B) return;
	const w = String(which || 'both');
	const rid = String(relationId || '').trim();
	if (w === 'forward' || w === 'both') {
		graph.links = graph.links.filter(l => {
			if (!(l.from === A && l.to === B)) return true;
			if (!rid) return false;
			return String(l.relationId || 'main') !== rid;
		});
	}
	if (w === 'reverse' || w === 'both') {
		graph.links = graph.links.filter(l => {
			if (!(l.from === B && l.to === A)) return true;
			if (!rid) return false;
			return String(l.relationId || 'main') !== rid;
		});
	}
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} graphTagId
 * @param {string} label
 * @param {number} [x]
 * @param {number} [y]
 */
function addSubGraphTag(graph, graphTagId, label, x, y) {
	const tid = String(graphTagId || '').trim();
	const parent = findNode(graph, tid);
	if (!parent) return;
	const trimmed = String(label || '').trim() || 'subtag';
	const children = graph.nodes.filter(n => n.parentId === tid);
	const n = children.length;
	const ang = (2 * Math.PI * Math.max(n, 1)) / Math.max(n + 1, 1);
	const nx = typeof x === 'number' && Number.isFinite(x) ? x : Math.cos(ang + n) * 55;
	const ny = typeof y === 'number' && Number.isFinite(y) ? y : Math.sin(ang + n) * 55;
	graph.nodes.push({
		id: newSubTagId(),
		label: trimmed,
		parentId: tid,
		x: nx,
		y: ny,
		nest: { x: 0, y: 0 }
	});
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} graphTagId
 * @param {string} subId
 */
function removeSubGraphTag(graph, graphTagId, subId) {
	const sid = String(subId || '').trim();
	if (!sid || sid === String(graphTagId || '').trim()) return;
	removeNodeCascade(graph, sid);
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} graphTagId
 * @param {string} subId
 * @param {string} newLabel
 */
function renameSubGraphTag(graph, graphTagId, subId, newLabel) {
	const sid = String(subId || '').trim();
	const node = findNode(graph, sid);
	if (!node || node.parentId !== String(graphTagId || '').trim()) return;
	renameNode(graph, sid, newLabel);
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} graphTagId
 * @param {string} subId
 */
function findSubGraphTag(graph, graphTagId, subId) {
	const tid = String(graphTagId || '').trim();
	const sid = String(subId || '').trim();
	const node = findNode(graph, sid);
	if (!node || node.parentId !== tid) return null;
	return node;
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} graphTagId
 * @param {string} fromId
 * @param {string} toId
 */
function addSubGraphLink(graph, graphTagId, fromId, toId, relationId) {
	const tid = String(graphTagId || '').trim();
	const a = String(fromId || '').trim();
	const b = String(toId || '').trim();
	if (!findNode(graph, tid)) return;
	const allowed = focusClosureIdSet(graph, tid);
	if (!allowed.has(a) || !allowed.has(b)) return;
	const rid = String(relationId || 'main').trim() || 'main';
	const known = new Set((graph.relationTypes || []).map(r => String(r.id || '')));
	graph.links.push({ from: a, to: b, relationId: known.has(rid) ? rid : 'main' });
}

function addRelationType(graph, name, options) {
	const n = String(name || '').trim();
	if (!n) return '';
	if (!Array.isArray(graph.relationTypes)) graph.relationTypes = [{ id: 'main', name: 'Main' }];
	const lowered = n.toLowerCase();
	if (graph.relationTypes.some(r => String(r.name || '').trim().toLowerCase() === lowered)) return '';
	const base = n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'relation';
	const taken = new Set(graph.relationTypes.map(r => String(r.id || '')));
	let id = base;
	let i = 2;
	while (taken.has(id)) {
		id = `${base}-${i++}`;
	}
	graph.relationTypes.push({ id, name: n });
	const duplicateFromMain = !!(options && options.duplicateFromMain);
	if (duplicateFromMain) {
		const copied = new Set();
		for (const l of graph.links) {
			if (String(l.relationId || 'main') !== 'main') continue;
			const key = `${String(l.from || '')}->${String(l.to || '')}`;
			if (!key || copied.has(key)) continue;
			copied.add(key);
			graph.links.push({ from: l.from, to: l.to, relationId: id });
		}
	}
	return id;
}

function removeRelationType(graph, relationId) {
	const rid = String(relationId || '').trim();
	if (!rid || rid === 'main') return;
	if (!Array.isArray(graph.relationTypes)) return;
	graph.relationTypes = graph.relationTypes.filter(r => String(r.id || '') !== rid);
	for (const l of graph.links) {
		if (String(l.relationId || 'main') === rid) l.relationId = 'main';
	}
}

function renameRelationType(graph, relationId, name) {
	const rid = String(relationId || '').trim();
	const n = String(name || '').trim();
	if (!rid || !n || !Array.isArray(graph.relationTypes)) return false;
	const lowered = n.toLowerCase();
	for (const r of graph.relationTypes) {
		if (String(r.id || '') === rid) continue;
		if (String(r.name || '').trim().toLowerCase() === lowered) return false;
	}
	const rel = graph.relationTypes.find(r => String(r.id || '') === rid);
	if (!rel) return false;
	rel.name = n;
	return true;
}

function addGroup(graph, name, color) {
	const n = String(name || '').trim();
	const c = String(color || '').trim();
	if (!n || !c) return '';
	if (!Array.isArray(graph.groups)) graph.groups = [];
	const lowered = n.toLowerCase();
	if (graph.groups.some(g => String(g.name || '').trim().toLowerCase() === lowered)) return '';
	const base = n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
	const taken = new Set(graph.groups.map(g => String(g.id || '')));
	let id = base;
	let i = 2;
	while (taken.has(id)) {
		id = `${base}-${i++}`;
	}
	graph.groups.push({ id, name: n, color: c });
	return id;
}

function removeGroup(graph, groupId) {
	const gid = String(groupId || '').trim();
	if (!gid || !Array.isArray(graph.groups)) return;
	graph.groups = graph.groups.filter(g => String(g.id || '') !== gid);
	for (const n of graph.nodes) {
		if (String(n.groupId || '') === gid) n.groupId = '';
	}
}

function renameGroup(graph, groupId, name, color) {
	const gid = String(groupId || '').trim();
	const n = String(name || '').trim();
	const c = String(color || '').trim();
	if (!gid || !n || !c || !Array.isArray(graph.groups)) return false;
	const lowered = n.toLowerCase();
	for (const g of graph.groups) {
		if (String(g.id || '') === gid) continue;
		if (String(g.name || '').trim().toLowerCase() === lowered) return false;
	}
	const group = graph.groups.find(g => String(g.id || '') === gid);
	if (!group) return false;
	group.name = n;
	group.color = c;
	return true;
}

function assignNodeGroup(graph, nodeId, groupId) {
	const n = findNode(graph, nodeId);
	if (!n) return;
	const gid = String(groupId || '').trim();
	if (!gid) {
		n.groupId = '';
		return;
	}
	if (!Array.isArray(graph.groups) || !graph.groups.some(g => String(g.id) === gid)) return;
	n.groupId = gid;
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} graphTagId
 * @param {number} index
 */
function removeSubGraphLinkAtIndex(graph, graphTagId, index) {
	const tid = String(graphTagId || '').trim();
	const allowed = focusClosureIdSet(graph, tid);
	const i = Number(index);
	if (!Number.isInteger(i) || i < 0 || i >= graph.links.length) return;
	const L = graph.links[i];
	if (!allowed.has(L.from) || !allowed.has(L.to)) return;
	graph.links.splice(i, 1);
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} graphTagId
 * @param {number} index
 */
function reverseSubGraphLinkAtIndex(graph, graphTagId, index) {
	const tid = String(graphTagId || '').trim();
	const allowed = focusClosureIdSet(graph, tid);
	const i = Number(index);
	if (!Number.isInteger(i) || i < 0 || i >= graph.links.length) return;
	const L = graph.links[i];
	if (!allowed.has(L.from) || !allowed.has(L.to)) return;
	const x = L.from;
	L.from = L.to;
	L.to = x;
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} graphTagId
 * @param {string} a
 * @param {string} b
 * @param {'forward' | 'reverse' | 'both'} which
 */
function removeSubGraphLinksBetween(graph, graphTagId, a, b, which, relationId) {
	const tid = String(graphTagId || '').trim();
	const allowed = focusClosureIdSet(graph, tid);
	const A = String(a || '').trim();
	const B = String(b || '').trim();
	const w = String(which || 'both');
	const rid = String(relationId || '').trim();
	graph.links = graph.links.filter(l => {
		if (!allowed.has(l.from) || !allowed.has(l.to)) return true;
		if (w === 'forward' || w === 'both') {
			if (l.from === A && l.to === B) {
				if (!rid) return false;
				if (String(l.relationId || 'main') === rid) return false;
			}
		}
		if (w === 'reverse' || w === 'both') {
			if (l.from === B && l.to === A) {
				if (!rid) return false;
				if (String(l.relationId || 'main') === rid) return false;
			}
		}
		return true;
	});
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {string} graphTagId
 * @param {Record<string, { x?: number, y?: number }>} positions
 */
function applySubGraphLayout(graph, graphTagId, positions) {
	const tid = String(graphTagId || '').trim();
	const parent = findNode(graph, tid);
	if (!parent || !positions || typeof positions !== 'object') return;
	const pSelf = positions[tid];
	if (
		pSelf &&
		typeof pSelf.x === 'number' &&
		typeof pSelf.y === 'number' &&
		Number.isFinite(pSelf.x) &&
		Number.isFinite(pSelf.y)
	) {
		if (!parent.nest) parent.nest = { x: 0, y: 0 };
		parent.nest.x = pSelf.x;
		parent.nest.y = pSelf.y;
	}
	for (const n of graph.nodes) {
		if (n.parentId !== tid) continue;
		const p = positions[n.id];
		if (p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)) {
			n.x = p.x;
			n.y = p.y;
		}
	}
}

/**
 * @param {ReturnType<typeof normalizeGraph>} graph
 * @param {Record<string, { x?: number, y?: number }>} positions
 */
function applyNodePositions(graph, positions) {
	if (!positions || typeof positions !== 'object') return;
	for (const n of graph.nodes) {
		if (!isRootNode(n)) continue;
		const p = positions[n.id];
		if (p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)) {
			n.x = p.x;
			n.y = p.y;
		}
	}
}

module.exports = {
	TAG_GRAPH_KEY,
	TAG_GRAPH_REGISTRY_KEY,
	emptyGraph,
	normalizeGraph,
	initializeMultiGraphStorage,
	listStoredTagGraphs,
	getActiveStoredTagGraphMeta,
	createStoredTagGraph,
	activateStoredTagGraph,
	renameStoredTagGraph,
	removeStoredTagGraph,
	replaceActiveStoredTagGraphData,
	importStoredTagGraphAsNew,
	parseImportedTagGraphJson,
	getTagGraphsStorageDirectoryUri,
	getKbGraphsDirectoryUri,
	setTagGraphsStorageDirectoryUri,
	syncStoredGraphsFromFolder,
	reloadTagGraphsForKnowledgeBase,
	ensureTagGraphMirrorFolder,
	loadTagGraph,
	loadStoredTagGraphById,
	saveStoredTagGraphById,
	saveTagGraph,
	findNode,
	addTag,
	removeTag,
	renameTag,
	renameNode,
	addLink,
	removeLink,
	removeLinkAtIndex,
	reverseLinkDirectionAtIndex,
	removeLinksBetween,
	addSubGraphTag,
	removeSubGraphTag,
	renameSubGraphTag,
	findSubGraphTag,
	addSubGraphLink,
	addRelationType,
	removeRelationType,
	renameRelationType,
	addGroup,
	removeGroup,
	renameGroup,
	assignNodeGroup,
	removeSubGraphLinkAtIndex,
	reverseSubGraphLinkAtIndex,
	removeSubGraphLinksBetween,
	applySubGraphLayout,
	applyNodePositions,
	subtreeIdSet,
	focusClosureIdSet,
	rootIdSet
};
