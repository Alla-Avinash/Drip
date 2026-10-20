'use strict';

// Tags graph webview panels and message routing. Owns the DRIP Tags panel, the
// per-node sub-graph editor, and every tag-graph mutation (links, groups, sub-tags,
// layouts, stored-graph management). Composer/Storage routes tag-graph messages here
// too, since the Storage webview doubles as a tag-graph surface.

const vscode = require('vscode');
const {
	DRIP_TAGS_GRAPH_PANEL_ID,
	DRIP_SUBGRAPH_PANEL_ID
} = require('../../shared/constants');
const { getTagsWebviewHtml, getSubGraphPanelHtml } = require('../../graph/tagsWebview');
const { exportActiveTagGraphToFile, runTagGraphNew, runTagGraphImport } = require('../../graph/tagGraphCommands');

/** Hides the secondary side bar where DRIP Storage lives (user-requested when using the tags graph). */
async function closeSecondarySideBarIfVisible() {
	try {
		const { resetRhsViewVisibility } = require('../rhs/revealStorageOnly');
		await resetRhsViewVisibility();
	} catch {
		/* ignore */
	}
	try {
		await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
	} catch {
		// Bar already hidden or command unavailable
	}
}

const tagGraphListenerWebviews = new Set();
/** @type {WeakMap<import('vscode').Webview, { subGraphParentId?: string }>} */
const tagGraphWebviewMeta = new WeakMap();

function registerTagGraphWebview(w, meta) {
	tagGraphListenerWebviews.add(w);
	if (meta && meta.subGraphParentId) {
		tagGraphWebviewMeta.set(w, { subGraphParentId: String(meta.subGraphParentId) });
	} else {
		tagGraphWebviewMeta.delete(w);
	}
}

function unregisterTagGraphWebview(w) {
	tagGraphListenerWebviews.delete(w);
	tagGraphWebviewMeta.delete(w);
}

/**
 * Returns the project folder prefix when `webview` is in Projects mode with a project
 * selected; otherwise returns an empty string (meaning "use the global KB tag graph").
 * @param {import('vscode').Webview} webview
 * @returns {string}
 */
function projectsScopeFor(webview) {
	const m = tagGraphWebviewMeta.get(webview);
	if (m && m.projectsMode && m.projectPrefix) return String(m.projectPrefix);
	return '';
}

function setProjectsScope(webview, prefix) {
	const m = tagGraphWebviewMeta.get(webview) || {};
	tagGraphWebviewMeta.set(webview, { ...m, projectsMode: true, projectPrefix: String(prefix || '') });
}

function clearProjectsScope(webview) {
	const m = tagGraphWebviewMeta.get(webview);
	if (!m) return;
	if (m.subGraphParentId) {
		tagGraphWebviewMeta.set(webview, { subGraphParentId: m.subGraphParentId });
	} else {
		tagGraphWebviewMeta.delete(webview);
	}
}

/**
 * Apply a graph mutation to the right graph: the per-project graph when the webview is in
 * Projects mode, otherwise the global KB tag graph. Re-posts graph state to all listeners.
 * @param {import('../../state/state').DripState} state
 * @param {import('vscode').Webview} webview
 * @param {string} projectScope
 * @param {(g: any) => void} mutator
 * @param {{ recordHistory?: boolean }} [options]
 */
async function applyGraphMutation(state, webview, projectScope, mutator, options) {
	if (projectScope) {
		const kbRoot = state.getVerifiedKnowledgeBaseRoot && state.getVerifiedKnowledgeBaseRoot();
		if (kbRoot) {
			const { loadProjectGraph, saveProjectGraph } = require('../../graph/projectTagStore');
			const graph = await loadProjectGraph(kbRoot, projectScope);
			mutator(graph);
			await saveProjectGraph(kbRoot, projectScope, graph);
		}
	} else {
		await state.mutateTagGraph(mutator, options);
	}
	await postTagGraphStateToAll(state, webview);
}

/**
 * Read the graph the webview is currently editing (project graph in Projects mode,
 * otherwise the global KB graph).
 * @param {import('../../state/state').DripState} state
 * @param {string} projectScope
 */
async function loadCurrentTagGraph(state, projectScope) {
	if (projectScope) {
		const kbRoot = state.getVerifiedKnowledgeBaseRoot && state.getVerifiedKnowledgeBaseRoot();
		if (kbRoot) {
			const { loadProjectGraph } = require('../../graph/projectTagStore');
			return loadProjectGraph(kbRoot, projectScope);
		}
	}
	return state.getTagGraph();
}

async function postTagGraphStateToAll(state, originatingWebview, extra) {
	pruneSubGraphPanels(state);
	const tagGraphStore = require('../../graph/tagGraphStore');
	const meta = tagGraphStore.getActiveStoredTagGraphMeta(state.context);
	const storedGraphs = tagGraphStore.listStoredTagGraphs(state.context);
	const graphFolder = tagGraphStore.getTagGraphsStorageDirectoryUri(state.context);
	const globalGraph = state.getTagGraph();
	const kbRoot = state.getVerifiedKnowledgeBaseRoot && state.getVerifiedKnowledgeBaseRoot();
	const tasks = [];
	for (const w of tagGraphListenerWebviews) {
		const wmeta = tagGraphWebviewMeta.get(w);
		let graph = globalGraph;
		let activeGraphId = meta.id;
		let activeGraphName = meta.name;
		// In Projects mode this webview shows its project's own flat tag list as a graph,
		// isolated from the global KB tag graph.
		const prefix = wmeta && wmeta.projectsMode ? String(wmeta.projectPrefix || '') : '';
		if (prefix && kbRoot) {
			try {
				const { loadProjectGraph } = require('../../graph/projectTagStore');
				graph = await loadProjectGraph(kbRoot, prefix);
				activeGraphId = '';
				activeGraphName = '';
			} catch (err) {
				console.error('[DRIP] load project tag graph', err);
			}
		}
		const payload = {
			type: 'tagGraphState',
			graph,
			activeGraphId,
			activeGraphName,
			storedGraphs,
			graphFolderPath: graphFolder && typeof graphFolder.fsPath === 'string' ? graphFolder.fsPath : ''
		};
		if (extra && w === originatingWebview) {
			Object.assign(payload, extra);
		}
		if (wmeta && wmeta.subGraphParentId) {
			payload.subGraphEditorParentId = wmeta.subGraphParentId;
		}
		tasks.push(w.postMessage(payload));
	}
	await Promise.all(tasks);
}

/**
 * Push the per-project tags panel state (project list + selected project's tags).
 * @param {import('vscode').Webview} webview
 * @param {import('../../state/state').DripState} state
 * @param {string} [folderPrefix]
 * @returns {Promise<string>} the active project folder prefix that was resolved
 */
async function postProjectTagsPanelState(webview, state, folderPrefix) {
	const kbRoot = state.getVerifiedKnowledgeBaseRoot && state.getVerifiedKnowledgeBaseRoot();
	/** @type {any[]} */
	let projects = [];
	let tags = [];
	let activePrefix = String(folderPrefix || '');
	if (kbRoot) {
		try {
			const { listProjectsFromIndex } = require('../../indexing/projectViewQuery');
			const result = await listProjectsFromIndex(kbRoot);
			projects = result.projects || [];
		} catch (err) {
			console.error('[DRIP] list projects for tags panel', err);
		}
		if (!activePrefix && projects.length) activePrefix = String(projects[0].folderPrefix || '');
		if (activePrefix) {
			try {
				const { loadProjectTags } = require('../../graph/projectTagStore');
				tags = await loadProjectTags(kbRoot, activePrefix);
			} catch (err) {
				console.error('[DRIP] load project tags for panel', err);
			}
		}
	}
	await webview.postMessage({ type: 'projectTagsPanelState', projects, folderPrefix: activePrefix, tags });
	return activePrefix;
}

/**
 * @param {import('../../state/state').DripState} state
 * @param {'add' | 'rename' | 'description' | 'delete'} op
 * @param {{ folderPrefix?: string, tagId?: string, name?: string, description?: string }} message
 */
async function mutateProjectTagsInStore(state, op, message) {
	const kbRoot = state.getVerifiedKnowledgeBaseRoot && state.getVerifiedKnowledgeBaseRoot();
	const prefix = String(message.folderPrefix || '');
	if (!kbRoot || !prefix) return;
	const store = require('../../graph/projectTagStore');
	if (op === 'add') {
		await store.addProjectTag(kbRoot, prefix, String(message.name || ''), String(message.description || ''));
	} else if (op === 'rename') {
		await store.renameProjectTag(kbRoot, prefix, String(message.tagId || ''), String(message.name || ''));
	} else if (op === 'description') {
		await store.setProjectTagDescription(kbRoot, prefix, String(message.tagId || ''), String(message.description || ''));
	} else if (op === 'delete') {
		await store.deleteProjectTag(kbRoot, prefix, String(message.tagId || ''));
	}
}

/**
 * Build a split graph from a root node:
 * - include root and all structural descendants
 * - expand only downward through outgoing links (from included nodes)
 * - when an outgoing-linked node is included, include its structural descendants too
 * - keep only links whose endpoints are included
 * - keep only groups referenced by included nodes
 * @param {ReturnType<typeof tagGraphStore.normalizeGraph>} src
 * @param {string} rootId
 */
function buildSplitGraphFromNode(src, rootId) {
	const tagGraphStore = require('../../graph/tagGraphStore');
	const rid = String(rootId || '').trim();
	const root = tagGraphStore.findNode(src, rid);
	if (!root) return tagGraphStore.emptyGraph();
	const include = new Set(tagGraphStore.subtreeIdSet(src, rid));
	let expanded = true;
	while (expanded) {
		expanded = false;
		for (const l of src.links || []) {
			const from = String(l.from || '');
			const to = String(l.to || '');
			if (!from || !to) continue;
			// Downward-only expansion: do not climb into incoming-parent side.
			if (!include.has(from)) continue;
			if (!include.has(to)) {
				include.add(to);
				for (const d of tagGraphStore.subtreeIdSet(src, to)) include.add(d);
				expanded = true;
			}
		}
	}
	const nodes = (src.nodes || [])
		.filter(n => include.has(String(n.id || '')))
		.map(n => {
			const parentId = n.parentId != null && include.has(String(n.parentId)) ? String(n.parentId) : null;
			return {
				id: String(n.id),
				label: String(n.label || 'tag'),
				parentId,
				x: typeof n.x === 'number' ? n.x : undefined,
				y: typeof n.y === 'number' ? n.y : undefined,
				nest: n.nest && typeof n.nest === 'object'
					? {
						x: typeof n.nest.x === 'number' ? n.nest.x : 0,
						y: typeof n.nest.y === 'number' ? n.nest.y : 0
					}
					: { x: 0, y: 0 },
				groupId: String(n.groupId || '')
			};
		});
	const links = (src.links || []).filter(l => include.has(String(l.from || '')) && include.has(String(l.to || ''))).map(l => ({
		from: String(l.from),
		to: String(l.to)
	}));
	const usedGroupIds = new Set(nodes.map(n => String(n.groupId || '')).filter(Boolean));
	const groups = (src.groups || [])
		.filter(g => usedGroupIds.has(String(g.id || '')))
		.map(g => ({ id: String(g.id), name: String(g.name || ''), color: String(g.color || '#7aa2ff') }));
	return tagGraphStore.normalizeGraph({ version: 2, nodes, links, groups });
}

/**
 * @param {import('../../state/state').DripState} state
 * @param {string} requestedName
 */
function resolveUniqueCombinedGraphName(state, requestedName) {
	const tagGraphStore = require('../../graph/tagGraphStore');
	const base = String(requestedName || '').trim() || 'Combined graph';
	const names = new Set(
		tagGraphStore
			.listStoredTagGraphs(state.context)
			.map(g => String(g.name || '').trim().toLowerCase())
			.filter(Boolean)
	);
	if (!names.has(base.toLowerCase())) return base;
	let i = 1;
	while (names.has(`${base} (${i})`.toLowerCase())) i++;
	return `${base} (${i})`;
}

/**
 * Merge graphs by label, links union, group priority by source order.
 * @param {ReturnType<typeof import('../../graph/tagGraphStore').loadStoredTagGraphById>[]} graphs
 */
function buildCombinedGraph(graphs) {
	const tagGraphStore = require('../../graph/tagGraphStore');
	/** @type {Map<string, any>} */
	const byLabel = new Map();
	/** @type {Map<string, string>} */
	const srcNodeToMergedId = new Map();
	/** @type {Set<string>} */
	const usedGroupIds = new Set();
	/** @type {{from:string,to:string}[]} */
	const links = [];
	/** @type {Set<string>} */
	const linkKeySet = new Set();
	/** @type {Map<string,{id:string,name:string,color:string}>} */
	const groupsById = new Map();
	let mergedCounter = 0;

	function labelKey(v) { return String(v || '').trim(); }
	function mergedIdForLabel(label) {
		return `m-${++mergedCounter}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'node'}`;
	}

	for (let gi = 0; gi < graphs.length; gi++) {
		const g = tagGraphStore.normalizeGraph(graphs[gi]);
		for (const gr of g.groups || []) {
			const gid = String(gr.id || '');
			if (!gid || groupsById.has(gid)) continue;
			groupsById.set(gid, { id: gid, name: String(gr.name || gid), color: String(gr.color || '#7aa2ff') });
		}
		for (const n of g.nodes || []) {
			const lbl = labelKey(n.label || '');
			if (!lbl) continue;
			const parentNode = n.parentId != null ? (g.nodes || []).find(x => String(x.id || '') === String(n.parentId || '')) : null;
			const parentLabel = parentNode ? labelKey(parentNode.label || '') : '';
			let merged = byLabel.get(lbl);
			if (!merged) {
				merged = {
					id: mergedIdForLabel(lbl),
					label: lbl,
					parentId: null,
					x: typeof n.x === 'number' ? n.x : undefined,
					y: typeof n.y === 'number' ? n.y : undefined,
					nest: n.nest && typeof n.nest === 'object'
						? { x: typeof n.nest.x === 'number' ? n.nest.x : 0, y: typeof n.nest.y === 'number' ? n.nest.y : 0 }
						: { x: 0, y: 0 },
					groupId: String(n.groupId || ''),
					parentLabel: parentLabel || '',
					_sourceGraphIndex: gi
				};
				byLabel.set(lbl, merged);
			} else {
				const incomingGroupId = String(n.groupId || '');
				if (incomingGroupId && (!String(merged.groupId || '') || gi < merged._sourceGraphIndex)) {
					merged.groupId = incomingGroupId;
					merged._sourceGraphIndex = gi;
				}
				if (parentLabel && !merged.parentLabel) {
					merged.parentLabel = parentLabel;
				}
			}
			srcNodeToMergedId.set(`${gi}:${String(n.id || '')}`, merged.id);
		}
		for (const l of g.links || []) {
			const fromNode = (g.nodes || []).find(n => String(n.id || '') === String(l.from || ''));
			const toNode = (g.nodes || []).find(n => String(n.id || '') === String(l.to || ''));
			if (!fromNode || !toNode) continue;
			const from = srcNodeToMergedId.get(`${gi}:${String(fromNode.id || '')}`) || '';
			const to = srcNodeToMergedId.get(`${gi}:${String(toNode.id || '')}`) || '';
			if (!from || !to) continue;
			const key = `${from}=>${to}`;
			if (linkKeySet.has(key)) continue;
			linkKeySet.add(key);
			links.push({ from, to });
		}
	}
	const nodes = Array.from(byLabel.values()).map(n => {
		if (n.groupId) usedGroupIds.add(String(n.groupId));
		var parentId = null;
		if (n.parentLabel && byLabel.has(n.parentLabel)) {
			var p = byLabel.get(n.parentLabel);
			parentId = p && p.id !== n.id ? String(p.id) : null;
		}
		return {
			id: n.id,
			label: n.label,
			parentId: parentId,
			x: n.x,
			y: n.y,
			nest: n.nest,
			groupId: n.groupId || ''
		};
	});
	const groups = Array.from(groupsById.values()).filter(g => usedGroupIds.has(String(g.id)));
	return tagGraphStore.normalizeGraph({ version: 2, nodes, links, groups });
}

/**
 * @param {import('../../state/state').DripState} state
 * @param {import('vscode').Webview | undefined} [originatingWebview]
 */
async function pushTagGraphUi(state, originatingWebview) {
	state.clearTagGraphHistory();
	await postTagGraphStateToAll(state, originatingWebview);
	state.syncTagGraphCheckpointFromStorage();
}

const subGraphPanelByParentId = new Map();

function pruneSubGraphPanels(state) {
	const graph = state.getTagGraph();
	const ids = new Set(graph.nodes.map(n => n.id));
	for (const key of [...subGraphPanelByParentId.keys()]) {
		if (!ids.has(key)) {
			disposeSubGraphPanelForParent(key);
		}
	}
}

function disposeSubGraphPanelForParent(parentTagId) {
	const id = String(parentTagId || '');
	const inst = subGraphPanelByParentId.get(id);
	if (inst) {
		inst.panel.dispose();
	}
}

class DripSubGraphPanel {
	/**
	 * @param {import('vscode').Uri} extensionUri
	 * @param {*} state
	 * @param {string} parentTagId
	 */
	static createOrShow(extensionUri, state, parentTagId) {
		const id = String(parentTagId || '');
		const graph = state.getTagGraph();
		const tagGraphStore = require('../../graph/tagGraphStore');
		const t = tagGraphStore.findNode(graph, id);
		const title = t ? `Graph: ${t.label}` : 'DRIP Graph';
		const column =
			DripTagsPanel.currentPanel?.panel.viewColumn ??
			vscode.window.activeTextEditor?.viewColumn ??
			vscode.ViewColumn.One;
		const existing = subGraphPanelByParentId.get(id);
		if (existing) {
			existing.panel.reveal(column);
			void existing.pushGraphFromState();
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			DRIP_SUBGRAPH_PANEL_ID,
			title,
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extensionUri]
			}
		);
		const inst = new DripSubGraphPanel(panel, state, extensionUri, id);
		subGraphPanelByParentId.set(id, inst);
		panel.onDidDispose(() => {
			subGraphPanelByParentId.delete(id);
			unregisterTagGraphWebview(panel.webview);
		});
	}

	/**
	 * @param {import('vscode').WebviewPanel} panel
	 * @param {*} state
	 * @param {import('vscode').Uri} extensionUri
	 * @param {string} parentTagId
	 */
	constructor(panel, state, extensionUri, parentTagId) {
		this.panel = panel;
		this.state = state;
		this.extensionUri = extensionUri;
		this.parentTagId = parentTagId;
		registerTagGraphWebview(this.panel.webview, { subGraphParentId: parentTagId });
		this.panel.webview.html = getSubGraphPanelHtml(this.panel.webview, this.extensionUri);
		this.panel.webview.onDidReceiveMessage(async message => {
			try {
				if (message.type === 'tagsPanelUiActivated') {
					await closeSecondarySideBarIfVisible();
					return;
				}
				if (await handleTagGraphMessage(this.panel.webview, message, this.state, this.extensionUri)) {
					return;
				}
			} catch (error) {
				await this.panel.webview.postMessage({
					type: 'tagGraphError',
					message: error instanceof Error ? error.message : String(error)
				});
			}
		});
		void this.pushGraphFromState();
	}

	async pushGraphFromState() {
		await postTagGraphStateToAll(this.state, this.panel.webview);
	}
}

/**
 * Multi-graph management ops that don't apply to a per-project tag graph (each project
 * has one graph, and undo/redo is only tracked for the global KB graph). When the webview
 * is in Projects mode these are ignored so they never leak into the global KB tag graph.
 * Everything else (links, groups, relations, sub-tags, layout) is routed to the project's
 * own graph instead.
 */
const PROJECT_MODE_GRAPH_ONLY = new Set([
	'undoTagGraph',
	'redoTagGraph',
	'activateTagGraph',
	'requestNewTagGraph',
	'requestImportTagGraph',
	'exportTagGraph',
	'renameActiveTagGraph',
	'deleteTagGraph',
	'createGraphFromNode',
	'createGraphFromNodePrompt',
	'createCombinedGraph',
	'createCombinedGraphPreview',
	'openSubGraphEditorWindow'
]);

/**
 * @param {import('vscode').Webview} webview
 * @param {*} message
 * @param {*} state
 * @param {import('vscode').Uri} [extensionUri]
 * @returns {Promise<boolean>}
 */
async function handleTagGraphMessage(webview, message, state, extensionUri) {
	const tagGraphStore = require('../../graph/tagGraphStore');
	const projectScope = projectsScopeFor(webview);
	if (projectScope && PROJECT_MODE_GRAPH_ONLY.has(message.type)) {
		return true;
	}
	switch (message.type) {
		case 'undoTagGraph': {
			if (typeof state.undoTagGraph === 'function') {
				await state.undoTagGraph();
			}
			await postTagGraphStateToAll(state, webview);
			state.syncTagGraphCheckpointFromStorage();
			return true;
		}
		case 'redoTagGraph': {
			if (typeof state.redoTagGraph === 'function') {
				await state.redoTagGraph();
			}
			await postTagGraphStateToAll(state, webview);
			state.syncTagGraphCheckpointFromStorage();
			return true;
		}
		case 'requestTagGraph': {
			await postTagGraphStateToAll(state, webview);
			state.syncTagGraphCheckpointFromStorage();
			return true;
		}
		case 'tagsModeChanged': {
			const isProjects = String(message.mode || '') === 'projects';
			if (isProjects) {
				const prefix = await postProjectTagsPanelState(webview, state, '');
				setProjectsScope(webview, prefix);
				await postTagGraphStateToAll(state, webview);
			} else {
				clearProjectsScope(webview);
				await postTagGraphStateToAll(state, webview);
			}
			return true;
		}
		case 'requestProjectTagsPanel': {
			const prefix = await postProjectTagsPanelState(webview, state, '');
			setProjectsScope(webview, prefix);
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'projectTagsSelectProject': {
			const prefix = await postProjectTagsPanelState(webview, state, String(message.folderPrefix || ''));
			setProjectsScope(webview, prefix);
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'projectTagsAdd': {
			const prefix = String(message.folderPrefix || '');
			await mutateProjectTagsInStore(state, 'add', message);
			await postProjectTagsPanelState(webview, state, prefix);
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'projectTagsRename': {
			const prefix = String(message.folderPrefix || '');
			await mutateProjectTagsInStore(state, 'rename', message);
			await postProjectTagsPanelState(webview, state, prefix);
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'projectTagsDelete': {
			const prefix = String(message.folderPrefix || '');
			await mutateProjectTagsInStore(state, 'delete', message);
			await postProjectTagsPanelState(webview, state, prefix);
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'activateTagGraph': {
			const target = String(message.graphId || '').trim();
			if (!target) {
				return true;
			}
			const active = tagGraphStore.getActiveStoredTagGraphMeta(state.context);
			if (target === active.id) {
				return true;
			}
			if ((await state.promptTagGraphSwitchOrCancel()) === 'cancel') {
				await postTagGraphStateToAll(state, webview);
				return true;
			}
			await tagGraphStore.activateStoredTagGraph(state.context, target);
			await pushTagGraphUi(state, webview);
			return true;
		}
		case 'requestNewTagGraph': {
			await runTagGraphNew(state, () => pushTagGraphUi(state, webview));
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'requestImportTagGraph': {
			await runTagGraphImport(state, () => pushTagGraphUi(state, webview));
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'exportTagGraph': {
			await exportActiveTagGraphToFile(state);
			return true;
		}
		case 'renameActiveTagGraph': {
			const graphId = String(message.graphId || '').trim();
			if (!graphId) {
				return true;
			}
			const graphs = tagGraphStore.listStoredTagGraphs(state.context);
			const entry = graphs.find(g => g.id === graphId);
			if (!entry) {
				await postTagGraphStateToAll(state, webview);
				return true;
			}
			const next = String(message.newName || '').trim();
			if (!next) {
				void vscode.window.showWarningMessage('Please enter a graph name before renaming.');
				await postTagGraphStateToAll(state, webview);
				return true;
			}
			await tagGraphStore.renameStoredTagGraph(state.context, graphId, next);
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'deleteTagGraph': {
			const graphId = String(message.graphId || '').trim();
			if (!graphId) {
				return true;
			}
			const graphs = tagGraphStore.listStoredTagGraphs(state.context);
			if (graphs.length <= 1) {
				void vscode.window.showWarningMessage('Cannot delete the last tags graph.');
				await postTagGraphStateToAll(state, webview);
				return true;
			}
			const target = graphs.find(g => g.id === graphId);
			if (!target) {
				await postTagGraphStateToAll(state, webview);
				return true;
			}
			const active = tagGraphStore.getActiveStoredTagGraphMeta(state.context);
			if (active.id === graphId) {
				if ((await state.promptTagGraphSwitchOrCancel()) === 'cancel') {
					await postTagGraphStateToAll(state, webview);
					return true;
				}
			}
			const confirm = await vscode.window.showWarningMessage(
				`Delete tags graph "${target.name}" permanently from DRIP storage?`,
				{ modal: true },
				'Delete'
			);
			if (confirm !== 'Delete') {
				await postTagGraphStateToAll(state, webview);
				return true;
			}
			await tagGraphStore.removeStoredTagGraph(state.context, graphId);
			await pushTagGraphUi(state, webview);
			return true;
		}
		case 'openSubGraphEditorWindow': {
			if (!extensionUri) {
				return true;
			}
			const parentTagId = String(message.parentTagId || '');
			DripSubGraphPanel.createOrShow(extensionUri, state, parentTagId);
			return true;
		}
		case 'groupSelectionStatus': {
			const active = !!message.active;
			void vscode.window.showInformationMessage(
				active ? 'Group selection mode started.' : 'Group selection mode stopped.'
			);
			return true;
		}
		case 'addTag': {
			if (projectScope) {
				await mutateProjectTagsInStore(state, 'add', { folderPrefix: projectScope, name: String(message.label || '') });
				await postProjectTagsPanelState(webview, state, projectScope);
				await postTagGraphStateToAll(state, webview);
				return true;
			}
			await state.mutateTagGraph(g => {
				tagGraphStore.addTag(g, String(message.label || ''));
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'createGraphFromNode': {
			try {
				const nodeId = String(message.nodeId || '');
				const current = state.getTagGraph();
				const node = tagGraphStore.findNode(current, nodeId);
				if (!node) {
					await webview.postMessage({ type: 'tagGraphError', message: 'Selected node not found.' });
					return true;
				}
				const defaultName = String(node.label || 'Untitled graph').trim() || 'Untitled graph';
				const name = String(message.name || '').trim() || defaultName;
				const splitGraph = buildSplitGraphFromNode(current, nodeId);
				await tagGraphStore.createStoredTagGraph(state.context, name);
				await tagGraphStore.replaceActiveStoredTagGraphData(state.context, splitGraph);
				await pushTagGraphUi(state, webview);
				void vscode.window.showInformationMessage(`Created graph "${name}".`);
			} catch (err) {
				void vscode.window.showErrorMessage(`Failed to create graph from node: ${err instanceof Error ? err.message : String(err)}`);
			}
			return true;
		}
		case 'createGraphFromNodePrompt': {
			const nodeId = String(message.nodeId || '');
			const current = state.getTagGraph();
			const node = tagGraphStore.findNode(current, nodeId);
			if (!node) {
				await webview.postMessage({ type: 'tagGraphError', message: 'Selected node not found.' });
				return true;
			}
			const defaultName = String(node.label || 'Untitled graph').trim() || 'Untitled graph';
			const name = await vscode.window.showInputBox({
				title: 'Create graph from node',
				prompt: 'Enter new graph name',
				value: defaultName,
				validateInput: v => {
					const s = String(v || '').trim();
					if (!s) return 'Graph name cannot be empty';
					return undefined;
				}
			});
			if (name == null) return true;
			await handleTagGraphMessage(webview, { type: 'createGraphFromNode', nodeId, name: String(name).trim() }, state, extensionUri);
			return true;
		}
		case 'createCombinedGraph': {
			const srcIds = Array.isArray(message.sourceGraphIds)
				? Array.from(new Set(message.sourceGraphIds.map(x => String(x || '').trim()).filter(Boolean)))
				: [];
			if (srcIds.length < 2) {
				await webview.postMessage({ type: 'tagGraphError', message: 'Select at least two source graphs.' });
				return true;
			}
			const existing = tagGraphStore.listStoredTagGraphs(state.context);
			const known = new Set(existing.map(g => String(g.id)));
			for (const id of srcIds) {
				if (!known.has(id)) {
					await webview.postMessage({ type: 'tagGraphError', message: `Graph not found: ${id}` });
					return true;
				}
			}
			const payloads = srcIds.map(id => tagGraphStore.loadStoredTagGraphById(state.context, id));
			const combined = buildCombinedGraph(payloads);
			const finalName = resolveUniqueCombinedGraphName(state, String(message.name || 'Combined graph'));
			await tagGraphStore.importStoredTagGraphAsNew(state.context, finalName, combined);
			await pushTagGraphUi(state, webview);
			void vscode.window.showInformationMessage(`Created combined graph "${finalName}".`);
			return true;
		}
		case 'createCombinedGraphPreview': {
			const srcIds = Array.isArray(message.sourceGraphIds)
				? Array.from(new Set(message.sourceGraphIds.map(x => String(x || '').trim()).filter(Boolean)))
				: [];
			if (!srcIds.length) {
				await webview.postMessage({ type: 'tagGraphError', message: 'Select at least one source graph.' });
				return true;
			}
			const existing = tagGraphStore.listStoredTagGraphs(state.context);
			const known = new Set(existing.map(g => String(g.id)));
			for (const id of srcIds) {
				if (!known.has(id)) {
					await webview.postMessage({ type: 'tagGraphError', message: `Graph not found: ${id}` });
					return true;
				}
			}
			const payloads = srcIds.map(id => tagGraphStore.loadStoredTagGraphById(state.context, id));
			const combined = buildCombinedGraph(payloads);
			await webview.postMessage({ type: 'tagGraphCombinePreview', graph: combined });
			return true;
		}
		case 'removeTag': {
			if (projectScope) {
				await mutateProjectTagsInStore(state, 'delete', { folderPrefix: projectScope, tagId: String(message.id || '') });
				await postProjectTagsPanelState(webview, state, projectScope);
				await postTagGraphStateToAll(state, webview);
				return true;
			}
			await state.mutateTagGraph(g => {
				tagGraphStore.removeTag(g, String(message.id || ''));
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'renameTag': {
			if (projectScope) {
				await mutateProjectTagsInStore(state, 'rename', { folderPrefix: projectScope, tagId: String(message.id || ''), name: String(message.label || '') });
				await postProjectTagsPanelState(webview, state, projectScope);
				await postTagGraphStateToAll(state, webview);
				return true;
			}
			await state.mutateTagGraph(g => {
				tagGraphStore.renameTag(g, String(message.id || ''), String(message.label || ''));
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'requestRemoveTagDialog': {
			const id = String(message.id || '');
			if (projectScope) {
				const kbRoot = state.getVerifiedKnowledgeBaseRoot && state.getVerifiedKnowledgeBaseRoot();
				let label = id;
				if (kbRoot) {
					const { loadProjectTags } = require('../../graph/projectTagStore');
					const tags = await loadProjectTags(kbRoot, projectScope);
					const tag = (tags || []).find(t => String(t.id) === id);
					if (tag) label = String(tag.name || id);
				}
				const pick = await vscode.window.showWarningMessage(
					`Delete tag "${label}" from this project?`,
					{ modal: true },
					'Delete'
				);
				if (pick !== 'Delete') return true;
				await mutateProjectTagsInStore(state, 'delete', { folderPrefix: projectScope, tagId: id });
				await postProjectTagsPanelState(webview, state, projectScope);
				await postTagGraphStateToAll(state, webview);
				return true;
			}
			const graph = state.getTagGraph();
			const tag = tagGraphStore.findNode(graph, id);
			const label = tag ? tag.label : id;
			const pick = await vscode.window.showWarningMessage(
				`Delete "${label}" and all nested tags, subgraphs, and links involving them?`,
				{ modal: true },
				'Delete'
			);
			if (pick !== 'Delete') {
				return true;
			}
			await state.mutateTagGraph(g => {
				tagGraphStore.removeTag(g, id);
			});
			disposeSubGraphPanelForParent(id);
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'requestRemoveTagsDialog': {
			const ids = Array.isArray(message.ids) ? message.ids.map(x => String(x || '').trim()).filter(Boolean) : [];
			if (!ids.length) return true;
			if (projectScope) {
				const kbRoot = state.getVerifiedKnowledgeBaseRoot && state.getVerifiedKnowledgeBaseRoot();
				let known = new Set(ids);
				if (kbRoot) {
					const { loadProjectTags } = require('../../graph/projectTagStore');
					const tags = await loadProjectTags(kbRoot, projectScope);
					known = new Set((tags || []).map(t => String(t.id)));
				}
				const filtered = ids.filter(id => known.has(id));
				if (!filtered.length) return true;
				const pick = await vscode.window.showWarningMessage(
					`Delete ${filtered.length} selected tag(s) from this project?`,
					{ modal: true },
					'Delete'
				);
				if (pick !== 'Delete') return true;
				for (const id of filtered) {
					await mutateProjectTagsInStore(state, 'delete', { folderPrefix: projectScope, tagId: id });
				}
				await postProjectTagsPanelState(webview, state, projectScope);
				await postTagGraphStateToAll(state, webview);
				return true;
			}
			const graph = state.getTagGraph();
			const known = new Set(graph.nodes.map(n => String(n.id || '')));
			const filtered = ids.filter(id => known.has(id));
			if (!filtered.length) return true;
			const pick = await vscode.window.showWarningMessage(
				`Delete ${filtered.length} selected tag(s) and their nested tags, subgraphs, and links?`,
				{ modal: true },
				'Delete'
			);
			if (pick !== 'Delete') return true;
			await state.mutateTagGraph(g => {
				for (const id of filtered) tagGraphStore.removeTag(g, id);
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'addLink': {
			await applyGraphMutation(state, webview, projectScope, g => {
				tagGraphStore.addLink(
					g,
					String(message.fromId || ''),
					String(message.toId || '')
				);
			});
			return true;
		}
		case 'addTagGroup': {
			let groupId = '';
			await applyGraphMutation(state, webview, projectScope, g => {
				groupId = tagGraphStore.addGroup(g, String(message.name || ''), String(message.color || ''));
			});
			if (!groupId) {
				await webview.postMessage({
					type: 'tagGraphError',
					message: 'Group name already exists. Choose a unique name.'
				});
				return true;
			}
			return true;
		}
		case 'removeTagGroup': {
			await applyGraphMutation(state, webview, projectScope, g => {
				tagGraphStore.removeGroup(g, String(message.groupId || ''));
			});
			return true;
		}
		case 'renameTagGroup': {
			let ok = false;
			await applyGraphMutation(state, webview, projectScope, g => {
				ok = tagGraphStore.renameGroup(
					g,
					String(message.groupId || ''),
					String(message.name || ''),
					String(message.color || '')
				);
			});
			if (!ok) {
				await webview.postMessage({
					type: 'tagGraphError',
					message: 'Group rename failed. Name may already exist.'
				});
				return true;
			}
			return true;
		}
		case 'assignTagToGroup': {
			await applyGraphMutation(state, webview, projectScope, g => {
				const includeChildren = !!message.includeChildren;
				const tagId = String(message.tagId || '');
				const groupId = String(message.groupId || '');
				if (includeChildren) {
					// Include structural descendants (parentId tree)...
					const ids = tagGraphStore.subtreeIdSet(g, tagId);
					// ...and include full downstream link hierarchy from that subtree root set.
					let expanded = true;
					while (expanded) {
						expanded = false;
						for (const l of g.links) {
							const from = String(l.from || '');
							const to = String(l.to || '');
							if (!from || !to) continue;
							if (!ids.has(from) || ids.has(to)) continue;
							ids.add(to);
							expanded = true;
						}
					}
					for (const id of ids) {
						tagGraphStore.assignNodeGroup(g, id, groupId);
					}
				} else {
					tagGraphStore.assignNodeGroup(g, tagId, groupId);
				}
			});
			return true;
		}
		case 'removeLink': {
			const idx = Number(message.index);
			if (Number.isInteger(idx) && idx >= 0) {
				await applyGraphMutation(state, webview, projectScope, g => {
					tagGraphStore.removeLinkAtIndex(g, idx);
				});
			} else {
				await applyGraphMutation(state, webview, projectScope, g => {
					tagGraphStore.removeLink(g, String(message.fromId || ''), String(message.toId || ''));
				});
			}
			return true;
		}
		case 'reverseLinkAtIndex': {
			const idx = Number(message.index);
			if (Number.isInteger(idx) && idx >= 0) {
				await applyGraphMutation(state, webview, projectScope, g => {
					tagGraphStore.reverseLinkDirectionAtIndex(g, idx);
				});
			}
			return true;
		}
		case 'removeLinksBetween': {
			const a = String(message.fromId || '');
			const b = String(message.toId || '');
			const which = String(message.which || 'both');
			await applyGraphMutation(state, webview, projectScope, g => {
				tagGraphStore.removeLinksBetween(g, a, b, which);
			});
			return true;
		}
		case 'addSubGraphTag': {
			const parentTagId = String(message.parentTagId || '');
			const nx = Number(message.x);
			const ny = Number(message.y);
			await applyGraphMutation(state, webview, projectScope, g => {
				tagGraphStore.addSubGraphTag(
					g,
					parentTagId,
					String(message.label || ''),
					Number.isFinite(nx) ? nx : undefined,
					Number.isFinite(ny) ? ny : undefined
				);
			});
			return true;
		}
		case 'removeSubGraphTag': {
			const parentTagId = String(message.parentTagId || '');
			const subTagId = String(message.subTagId || '');
			await applyGraphMutation(state, webview, projectScope, g => {
				tagGraphStore.removeSubGraphTag(g, parentTagId, subTagId);
			});
			return true;
		}
		case 'renameSubGraphTag': {
			const parentTagId = String(message.parentTagId || '');
			const subTagId = String(message.subTagId || '');
			await applyGraphMutation(state, webview, projectScope, g => {
				tagGraphStore.renameSubGraphTag(g, parentTagId, subTagId, String(message.label || ''));
			});
			return true;
		}
		case 'requestRenameSubGraphTagDialog': {
			const parentTagId = String(message.parentTagId || '');
			const subTagId = String(message.subTagId || '');
			const graph = await loadCurrentTagGraph(state, projectScope);
			const node = tagGraphStore.findSubGraphTag(graph, parentTagId, subTagId);
			if (!node) {
				return true;
			}
			const value = await vscode.window.showInputBox({
				title: 'Rename sub-tag',
				value: node.label,
				validateInput: v => {
					const s = String(v || '').trim();
					if (!s) {
						return 'Name cannot be empty';
					}
					return undefined;
				}
			});
			if (value == null) {
				return true;
			}
			await applyGraphMutation(state, webview, projectScope, g => {
				tagGraphStore.renameSubGraphTag(g, parentTagId, subTagId, String(value).trim());
			});
			return true;
		}
		case 'addSubGraphLink': {
			const parentTagId = String(message.parentTagId || '');
			await applyGraphMutation(state, webview, projectScope, g => {
				tagGraphStore.addSubGraphLink(
					g,
					parentTagId,
					String(message.fromId || ''),
					String(message.toId || '')
				);
			});
			return true;
		}
		case 'removeSubGraphLink': {
			const parentTagId = String(message.parentTagId || '');
			const idx = Number(message.index);
			if (Number.isInteger(idx) && idx >= 0) {
				await applyGraphMutation(state, webview, projectScope, g => {
					tagGraphStore.removeSubGraphLinkAtIndex(g, parentTagId, idx);
				});
			}
			return true;
		}
		case 'reverseSubGraphLinkAtIndex': {
			const parentTagId = String(message.parentTagId || '');
			const idx = Number(message.index);
			if (Number.isInteger(idx) && idx >= 0) {
				await applyGraphMutation(state, webview, projectScope, g => {
					tagGraphStore.reverseSubGraphLinkAtIndex(g, parentTagId, idx);
				});
			}
			return true;
		}
		case 'removeSubGraphLinksBetween': {
			const parentTagId = String(message.parentTagId || '');
			const a = String(message.fromId || '');
			const b = String(message.toId || '');
			const which = String(message.which || 'both');
			await applyGraphMutation(state, webview, projectScope, g => {
				tagGraphStore.removeSubGraphLinksBetween(g, parentTagId, a, b, which);
			});
			return true;
		}
		case 'saveSubGraphLayout': {
			const parentTagId = String(message.parentTagId || '');
			await applyGraphMutation(state, webview, projectScope, g => {
				tagGraphStore.applySubGraphLayout(g, parentTagId, message.positions || {});
			}, { recordHistory: false });
			return true;
		}
		case 'requestRemoveSubGraphTagDialog': {
			const parentTagId = String(message.parentTagId || '');
			const subTagId = String(message.subTagId || '');
			const graph = await loadCurrentTagGraph(state, projectScope);
			const sub = tagGraphStore.findSubGraphTag(graph, parentTagId, subTagId);
			const subLabel = sub ? sub.label : subTagId;
			const pick = await vscode.window.showWarningMessage(
				`Delete sub-tag "${subLabel}" and all links to it in this mini graph?`,
				{ modal: true },
				'Delete'
			);
			if (pick !== 'Delete') {
				return true;
			}
			await applyGraphMutation(state, webview, projectScope, g => {
				tagGraphStore.removeSubGraphTag(g, parentTagId, subTagId);
			});
			return true;
		}
		case 'addTagAtPosition': {
			if (projectScope) {
				await mutateProjectTagsInStore(state, 'add', { folderPrefix: projectScope, name: String(message.label || '') });
				await postProjectTagsPanelState(webview, state, projectScope);
				await postTagGraphStateToAll(state, webview);
				return true;
			}
			const nx = Number(message.x);
			const ny = Number(message.y);
			let newId = '';
			await state.mutateTagGraph(g => {
				const label = String(message.label || '').trim() || 'untitled';
				newId = tagGraphStore.addTag(g, label);
				const t = tagGraphStore.findNode(g, newId);
				if (t && Number.isFinite(nx) && Number.isFinite(ny)) {
					t.x = nx;
					t.y = ny;
				}
			});
			await postTagGraphStateToAll(state, webview, { focusRenameTagId: newId });
			return true;
		}
		case 'saveLayout': {
			await applyGraphMutation(state, webview, projectScope, g => {
				tagGraphStore.applyNodePositions(g, message.positions || {});
			}, { recordHistory: false });
			return true;
		}
		default:
			return false;
	}
}

class DripTagsPanel {
	static currentPanel = undefined;

	/**
	 * @param {import('vscode').Uri} extensionUri
	 * @param {*} state
	 */
	static createOrShow(extensionUri, state) {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		if (DripTagsPanel.currentPanel) {
			try {
				DripTagsPanel.currentPanel.panel.reveal(column);
				void DripTagsPanel.currentPanel.pushGraphFromState();
				void closeSecondarySideBarIfVisible();
				return;
			} catch {
				// Stale/disposed panel reference can happen when command is triggered
				// from another UI surface (e.g. chat tab) while panel is closing.
				DripTagsPanel.currentPanel = undefined;
			}
		}

		const panel = vscode.window.createWebviewPanel(
			DRIP_TAGS_GRAPH_PANEL_ID,
			'DRIP Tags',
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extensionUri]
			}
		);

		DripTagsPanel.currentPanel = new DripTagsPanel(panel, state, extensionUri);
		void closeSecondarySideBarIfVisible();
	}

	/**
	 * @param {import('vscode').WebviewPanel} panel
	 * @param {*} state
	 * @param {import('vscode').Uri} extensionUri
	 */
	constructor(panel, state, extensionUri) {
		this.panel = panel;
		this.state = state;
		this.extensionUri = extensionUri;
		registerTagGraphWebview(this.panel.webview);
		this.panel.webview.html = getTagsWebviewHtml(this.panel.webview, this.extensionUri);

		this.panel.onDidDispose(() => {
			unregisterTagGraphWebview(this.panel.webview);
			DripTagsPanel.currentPanel = undefined;
		});

		this.panel.onDidChangeViewState(() => {
			if (this.panel.visible && this.panel.active) {
				void closeSecondarySideBarIfVisible();
			}
		});

		this.panel.webview.onDidReceiveMessage(async message => {
			try {
				if (message.type === 'tagsPanelUiActivated') {
					await closeSecondarySideBarIfVisible();
					return;
				}
				if (await handleTagGraphMessage(this.panel.webview, message, this.state, this.extensionUri)) {
					return;
				}
			} catch (error) {
				await this.panel.webview.postMessage({
					type: 'tagGraphError',
					message: error instanceof Error ? error.message : String(error)
				});
			}
		});
	}

	async pushGraphFromState() {
		await postTagGraphStateToAll(this.state, this.panel.webview);
	}
}

module.exports = {
	DripTagsPanel,
	postTagGraphStateToAll,
	handleTagGraphMessage,
	registerTagGraphWebview,
	unregisterTagGraphWebview
};
