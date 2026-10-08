'use strict';

const path = require('path');
const vscode = require('vscode');
const {
	DRIP_COMMAND_ID,
	DRIP_PANEL_ID,
	DRIP_TAGS_GRAPH_PANEL_ID,
	DRIP_SUBGRAPH_PANEL_ID,
	DRIP_SELECT_KB_COMMAND_ID,
	DRIP_VIEW_ID,
	DRIP_COMPONENTS_VIEW_ID,
	DRIP_KB_VIEW_ID,
	DRIP_DRAFTS_VIEW_ID,
	DRIP_STORAGE_VIEW_ID
} = require('../shared/constants');
const { getComposerHtml } = require('./composer/composerHtml');
const { getStorageWebviewHtml } = require('./rhs/storage/storageHtml');
const { getTagsWebviewHtml, getSubGraphPanelHtml } = require('../graph/tagsWebview');
const { createEmptyDraft, combineComposerSections } = require('../state/state');
const { exportActiveTagGraphToFile, runTagGraphNew, runTagGraphImport } = require('../graph/tagGraphCommands');
const { DripRetrieverPanel } = require('./lhs/retriever/panel');

/** @type {import('vscode').Webview | null} */
let storageWebviewRef = null;

/** @type {{ id: string, title: string, headings: string, metadata: string, content: string, metadataFilename: string } | null} */
let lastComposerNote = null;

/** @type {{ title: string, metadata: string, content: string } | null} */
let lastComposerCapture = null;

/** @type {unknown} */
let lastStorageSelection = undefined;

/**
 * RHS "move issue" mode context. Set while the user is moving an issue within a project
 * via the Storage sidebar. Non-null means the Storage webview shows the move panel.
 * @type {{ projectName: string, projectFolderPrefix: string, issueId: string, issueTitle: string } | null}
 */
let moveIssueContext = null;

function postToStorage(message) {
	if (storageWebviewRef) {
		void storageWebviewRef.postMessage(message);
	}
}

function postKbNoteSettingsToStorage() {
	const nt = require('../document/model/noteFileTypes');
	postToStorage({
		type: 'kbNoteSettings',
		knowledgeBaseFileExtensions: nt.getKbNoteExtensions(),
		defaultNewNoteExtension: nt.getDefaultNewNoteExtension()
	});
}

/** Hides the secondary side bar where DRIP Storage lives (user-requested when using the tags graph). */
async function closeSecondarySideBarIfVisible() {
	try {
		const { resetRhsViewVisibility } = require('./rhs/revealStorageOnly');
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

async function postTagGraphStateToAll(state, originatingWebview, extra) {
	pruneSubGraphPanels(state);
	const graph = state.getTagGraph();
	const tagGraphStore = require('../graph/tagGraphStore');
	const meta = tagGraphStore.getActiveStoredTagGraphMeta(state.context);
	const storedGraphs = tagGraphStore.listStoredTagGraphs(state.context);
	const graphFolder = tagGraphStore.getTagGraphsStorageDirectoryUri(state.context);
	const tasks = [];
	for (const w of tagGraphListenerWebviews) {
		const payload = {
			type: 'tagGraphState',
			graph,
			activeGraphId: meta.id,
			activeGraphName: meta.name,
			storedGraphs,
			graphFolderPath: graphFolder && typeof graphFolder.fsPath === 'string' ? graphFolder.fsPath : ''
		};
		if (extra && w === originatingWebview) {
			Object.assign(payload, extra);
		}
		const wmeta = tagGraphWebviewMeta.get(w);
		if (wmeta && wmeta.subGraphParentId) {
			payload.subGraphEditorParentId = wmeta.subGraphParentId;
		}
		tasks.push(w.postMessage(payload));
	}
	await Promise.all(tasks);
}

/**
 * Build a split graph from a root node:
 * - include root and all structural descendants
 * - expand only downward through outgoing links (from included nodes)
 * - when an outgoing-linked node is included, include its structural descendants too
 * - keep only links whose endpoints are included
 * - keep only groups referenced by included nodes
 * - keep only relation types referenced by included links (+ main default)
 * @param {ReturnType<typeof tagGraphStore.normalizeGraph>} src
 * @param {string} rootId
 */
function buildSplitGraphFromNode(src, rootId) {
	const tagGraphStore = require('../graph/tagGraphStore');
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
		to: String(l.to),
		relationId: String(l.relationId || 'main')
	}));
	const usedGroupIds = new Set(nodes.map(n => String(n.groupId || '')).filter(Boolean));
	const groups = (src.groups || [])
		.filter(g => usedGroupIds.has(String(g.id || '')))
		.map(g => ({ id: String(g.id), name: String(g.name || ''), color: String(g.color || '#7aa2ff') }));
	const usedRelationIds = new Set(links.map(l => String(l.relationId || 'main')));
	usedRelationIds.add('main');
	const relationTypes = (src.relationTypes || [])
		.filter(r => usedRelationIds.has(String(r.id || '')))
		.map(r => ({ id: String(r.id), name: String(r.name || r.id) }));
	if (!relationTypes.some(r => String(r.id) === 'main')) {
		relationTypes.unshift({ id: 'main', name: 'Main' });
	}
	return tagGraphStore.normalizeGraph({ version: 2, nodes, links, relationTypes, groups });
}

/**
 * @param {import('../state/state').DripState} state
 * @param {string} requestedName
 */
function resolveUniqueCombinedGraphName(state, requestedName) {
	const tagGraphStore = require('../graph/tagGraphStore');
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
 * @param {ReturnType<typeof import('../graph/tagGraphStore').loadStoredTagGraphById>[]} graphs
 */
function buildCombinedGraph(graphs) {
	const tagGraphStore = require('../graph/tagGraphStore');
	/** @type {Map<string, any>} */
	const byLabel = new Map();
	/** @type {Map<string, string>} */
	const srcNodeToMergedId = new Map();
	/** @type {Set<string>} */
	const usedGroupIds = new Set();
	/** @type {{from:string,to:string,relationId:string}[]} */
	const links = [];
	/** @type {Set<string>} */
	const linkKeySet = new Set();
	/** @type {Map<string,{id:string,name:string,color:string}>} */
	const groupsById = new Map();
	/** @type {Map<string,{id:string,name:string}>} */
	const relById = new Map();
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
		for (const rr of g.relationTypes || []) {
			const rid = String(rr.id || '');
			if (!rid || relById.has(rid)) continue;
			relById.set(rid, { id: rid, name: String(rr.name || rid) });
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
			const relationId = String(l.relationId || 'main') || 'main';
			const key = `${from}=>${to}::${relationId}`;
			if (linkKeySet.has(key)) continue;
			linkKeySet.add(key);
			links.push({ from, to, relationId });
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
	const relationTypes = Array.from(relById.values());
	if (!relationTypes.some(r => String(r.id) === 'main')) relationTypes.unshift({ id: 'main', name: 'Main' });
	return tagGraphStore.normalizeGraph({ version: 2, nodes, links, groups, relationTypes });
}

/**
 * @param {import('../state/state').DripState} state
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
		const tagGraphStore = require('../graph/tagGraphStore');
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
		this.panel.webview.html = getSubGraphPanelHtml(this.panel.webview);
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
 * @param {import('vscode').Webview} webview
 * @param {*} message
 * @param {*} state
 * @param {import('vscode').Uri} [extensionUri]
 * @returns {Promise<boolean>}
 */
async function handleTagGraphMessage(webview, message, state, extensionUri) {
	const tagGraphStore = require('../graph/tagGraphStore');
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
			await state.mutateTagGraph(g => {
				tagGraphStore.removeTag(g, String(message.id || ''));
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'renameTag': {
			await state.mutateTagGraph(g => {
				tagGraphStore.renameTag(g, String(message.id || ''), String(message.label || ''));
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'requestRemoveTagDialog': {
			const id = String(message.id || '');
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
			await state.mutateTagGraph(g => {
				tagGraphStore.addLink(
					g,
					String(message.fromId || ''),
					String(message.toId || ''),
					String(message.relationId || 'main')
				);
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'addRelationType': {
			let duplicateFromMain = !!message.duplicateFromMain;
			if (message.askDuplicateFromMain) {
				const choice = await vscode.window.showInformationMessage(
					`Create relation "${String(message.name || '').trim()}"`,
					{ modal: true, detail: 'Do you want to duplicate Main relation links into this new relation?' },
					'Duplicate Main Links',
					'Create Empty Relation'
				);
				if (!choice) {
					return true;
				}
				duplicateFromMain = choice === 'Duplicate Main Links';
			}
			let relationId = '';
			await state.mutateTagGraph(g => {
				relationId = tagGraphStore.addRelationType(g, String(message.name || ''), {
					duplicateFromMain
				});
			});
			if (!relationId) {
				await webview.postMessage({
					type: 'tagGraphError',
					message: 'Relation name already exists. Choose a unique name.'
				});
				return true;
			}
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'removeRelationType': {
			await state.mutateTagGraph(g => {
				tagGraphStore.removeRelationType(g, String(message.relationId || ''));
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'renameRelationType': {
			let ok = false;
			await state.mutateTagGraph(g => {
				ok = tagGraphStore.renameRelationType(
					g,
					String(message.relationId || ''),
					String(message.name || '')
				);
			});
			if (!ok) {
				await webview.postMessage({
					type: 'tagGraphError',
					message: 'Relation rename failed. Name may already exist.'
				});
				return true;
			}
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'addTagGroup': {
			let groupId = '';
			await state.mutateTagGraph(g => {
				groupId = tagGraphStore.addGroup(g, String(message.name || ''), String(message.color || ''));
			});
			if (!groupId) {
				await webview.postMessage({
					type: 'tagGraphError',
					message: 'Group name already exists. Choose a unique name.'
				});
				return true;
			}
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'removeTagGroup': {
			await state.mutateTagGraph(g => {
				tagGraphStore.removeGroup(g, String(message.groupId || ''));
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'renameTagGroup': {
			let ok = false;
			await state.mutateTagGraph(g => {
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
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'assignTagToGroup': {
			await state.mutateTagGraph(g => {
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
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'removeLink': {
			const idx = Number(message.index);
			if (Number.isInteger(idx) && idx >= 0) {
				await state.mutateTagGraph(g => {
					tagGraphStore.removeLinkAtIndex(g, idx);
				});
			} else {
				await state.mutateTagGraph(g => {
					tagGraphStore.removeLink(g, String(message.fromId || ''), String(message.toId || ''));
				});
			}
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'reverseLinkAtIndex': {
			const idx = Number(message.index);
			if (Number.isInteger(idx) && idx >= 0) {
				await state.mutateTagGraph(g => {
					tagGraphStore.reverseLinkDirectionAtIndex(g, idx);
				});
			}
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'removeLinksBetween': {
			const a = String(message.fromId || '');
			const b = String(message.toId || '');
			const which = String(message.which || 'both');
			const relationId = String(message.relationId || '');
			await state.mutateTagGraph(g => {
				tagGraphStore.removeLinksBetween(g, a, b, which, relationId);
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'addSubGraphTag': {
			const parentTagId = String(message.parentTagId || '');
			const nx = Number(message.x);
			const ny = Number(message.y);
			await state.mutateTagGraph(g => {
				tagGraphStore.addSubGraphTag(
					g,
					parentTagId,
					String(message.label || ''),
					Number.isFinite(nx) ? nx : undefined,
					Number.isFinite(ny) ? ny : undefined
				);
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'removeSubGraphTag': {
			const parentTagId = String(message.parentTagId || '');
			const subTagId = String(message.subTagId || '');
			await state.mutateTagGraph(g => {
				tagGraphStore.removeSubGraphTag(g, parentTagId, subTagId);
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'renameSubGraphTag': {
			const parentTagId = String(message.parentTagId || '');
			const subTagId = String(message.subTagId || '');
			await state.mutateTagGraph(g => {
				tagGraphStore.renameSubGraphTag(g, parentTagId, subTagId, String(message.label || ''));
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'requestRenameSubGraphTagDialog': {
			const parentTagId = String(message.parentTagId || '');
			const subTagId = String(message.subTagId || '');
			const graph = state.getTagGraph();
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
			await state.mutateTagGraph(g => {
				tagGraphStore.renameSubGraphTag(g, parentTagId, subTagId, String(value).trim());
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'addSubGraphLink': {
			const parentTagId = String(message.parentTagId || '');
			await state.mutateTagGraph(g => {
				tagGraphStore.addSubGraphLink(
					g,
					parentTagId,
					String(message.fromId || ''),
					String(message.toId || ''),
					String(message.relationId || 'main')
				);
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'removeSubGraphLink': {
			const parentTagId = String(message.parentTagId || '');
			const idx = Number(message.index);
			if (Number.isInteger(idx) && idx >= 0) {
				await state.mutateTagGraph(g => {
					tagGraphStore.removeSubGraphLinkAtIndex(g, parentTagId, idx);
				});
			}
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'reverseSubGraphLinkAtIndex': {
			const parentTagId = String(message.parentTagId || '');
			const idx = Number(message.index);
			if (Number.isInteger(idx) && idx >= 0) {
				await state.mutateTagGraph(g => {
					tagGraphStore.reverseSubGraphLinkAtIndex(g, parentTagId, idx);
				});
			}
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'removeSubGraphLinksBetween': {
			const parentTagId = String(message.parentTagId || '');
			const a = String(message.fromId || '');
			const b = String(message.toId || '');
			const which = String(message.which || 'both');
			const relationId = String(message.relationId || '');
			await state.mutateTagGraph(g => {
				tagGraphStore.removeSubGraphLinksBetween(g, parentTagId, a, b, which, relationId);
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'saveSubGraphLayout': {
			const parentTagId = String(message.parentTagId || '');
			await state.mutateTagGraph(g => {
				tagGraphStore.applySubGraphLayout(g, parentTagId, message.positions || {});
			}, { recordHistory: false });
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'requestRemoveSubGraphTagDialog': {
			const parentTagId = String(message.parentTagId || '');
			const subTagId = String(message.subTagId || '');
			const graph = state.getTagGraph();
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
			await state.mutateTagGraph(g => {
				tagGraphStore.removeSubGraphTag(g, parentTagId, subTagId);
			});
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		case 'addTagAtPosition': {
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
			await state.mutateTagGraph(g => {
				tagGraphStore.applyNodePositions(g, message.positions || {});
			}, { recordHistory: false });
			await postTagGraphStateToAll(state, webview);
			return true;
		}
		default:
			return false;
	}
}

/**
 * Opens the secondary (right) sidebar on Storage with Heading hidden —
 * used for Composer capture and Ingest.
 */
async function revealDripStorageView() {
	const { revealStorageOnly } = require('./rhs/revealStorageOnly');
	await revealStorageOnly();
}

/**
 * Open the RHS Storage sidebar in "move issue" mode: show the project name at the top and
 * let the user pick a destination (feature / project inbox / another issue) with the same
 * embedding-based suggestions. The move only happens when the user clicks Move.
 *
 * @param {{ projectName: string, projectFolderPrefix: string, issueId: string, issueTitle: string, hasParent?: boolean }} ctx
 */
async function beginIssueMove(ctx) {
	moveIssueContext = {
		projectName: String(ctx.projectName || ''),
		projectFolderPrefix: String(ctx.projectFolderPrefix || ''),
		issueId: String(ctx.issueId || ''),
		issueTitle: String(ctx.issueTitle || ''),
		hasParent: ctx.hasParent === true
	};
	await revealDripStorageView();
	postToStorage({ type: 'storageMoveMode', context: moveIssueContext });
}

/** @param {*} sidebarProvider */
async function notifyDraftSaved(sidebarProvider, draft, statusMessage) {
	await sidebarProvider.refresh();
	// The saved draft replaces any earlier capture, or the Composer would show the capture again.
	lastComposerCapture = null;
	if (DripComposerPanel.currentPanel) {
		await DripComposerPanel.currentPanel.loadState(draft.id, statusMessage);
	} else {
		lastComposerNote = {
			id: draft.id || '',
			title: draft.title || '',
			headings: draft.headings || '',
			metadata: draft.metadata || '',
			content: draft.content || '',
			metadataFilename: draft.metadataFilename || ''
		};
		postToStorage({
			type: 'composerNote',
			note: {
				...lastComposerNote,
				content: combineComposerSections(lastComposerNote.metadata, lastComposerNote.content)
			}
		});
	}
	postToStorage({ type: 'storageActionStatus', message: statusMessage || '' });
}

/** @param {*} sidebarProvider */
async function notifyAfterIngest(sidebarProvider, summary) {
	await sidebarProvider.refresh();
	lastStorageSelection = undefined;
	lastComposerNote = null;
	lastComposerCapture = null;
	postToStorage({
		type: 'storageReset',
		summaryText: 'No target selected. Use Suggestions.'
	});
	if (DripComposerPanel.currentPanel) {
		await DripComposerPanel.currentPanel.loadState(undefined, summary);
	} else {
		const empty = createEmptyDraft();
		lastComposerNote = {
			id: empty.id || '',
			title: empty.title || '',
			headings: empty.headings || '',
			metadata: empty.metadata || '',
			content: empty.content || '',
			metadataFilename: empty.metadataFilename || ''
		};
		postToStorage({ type: 'composerNote', note: lastComposerNote });
	}
	postToStorage({ type: 'storageActionStatus', message: summary });
}

class DripStorageWebviewProvider {
	constructor(extensionUri, state, sidebarProvider) {
		this.extensionUri = extensionUri;
		this.state = state;
		this.sidebarProvider = sidebarProvider;
	}

	/**
	 * @param {import('vscode').WebviewView} webviewView
	 */
	resolveWebviewView(webviewView) {
		const w = webviewView.webview;
		storageWebviewRef = w;
		w.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
		w.html = getStorageWebviewHtml(w, this.extensionUri);
		registerTagGraphWebview(w);
		webviewView.onDidDispose(() => {
			unregisterTagGraphWebview(w);
		});

		w.onDidReceiveMessage(async message => {
			try {
				if (await handleTagGraphMessage(w, message, this.state, this.extensionUri)) {
					return;
				}
				switch (message.type) {
					case 'openTagsEditor':
						DripTagsPanel.createOrShow(this.extensionUri, this.state);
						break;
					case 'openRetriever':
						DripRetrieverPanel.createOrShow(this.extensionUri, this.state);
						break;
					case 'requestState':
						postKbNoteSettingsToStorage();
						if (lastComposerNote) {
							await w.postMessage({ type: 'composerNote', note: lastComposerNote });
						}
						if (moveIssueContext) {
							await w.postMessage({ type: 'storageMoveMode', context: moveIssueContext });
						}
						break;
					case 'previewTargets': {
						const note = message.note || lastComposerNote;
						const preview = await this.state.previewTargets(note, {
							corpus: message.corpus,
							customCorpusPaths: message.customCorpusPaths
						});
						await w.postMessage({ type: 'previewTargetsResult', preview });
						break;
					}
					case 'deepAiSuggestions': {
						const note = message.note || lastComposerNote;
						const result = await this.state.deepAiSuggestions(note, {
							corpus: message.corpus,
							customCorpusPaths: message.customCorpusPaths
						});
						await w.postMessage({ type: 'deepAiSuggestionsResult', ...result });
						break;
					}
					case 'llmIngestPlan': {
						const note = message.note || lastComposerNote || {};
						await w.postMessage({ type: 'llmIngestPlanResult', ...(await this.runLlmIngestPlan(note, message)) });
						break;
					}
					case 'llmIngestSplit': {
						await this.splitNoteIntoDrafts(w, message);
						break;
					}
					case 'previewFolderFiles': {
						const note = message.note || lastComposerNote;
						const result = await this.state.previewFolderFiles(note, message.folderUri, {
							corpus: message.corpus,
							customCorpusPaths: message.customCorpusPaths
						});
						await w.postMessage({ type: 'previewFolderFilesResult', ...result });
						break;
					}
					case 'getFileHeadingMeta': {
						const note = message.note || lastComposerNote;
						const meta = await this.state.getFileHeadingMeta(message.fileUri, note);
						await w.postMessage({ type: 'fileHeadingMetaResult', meta });
						break;
					}
					case 'browseKbList': {
						const listing = await this.state.browseKbList(message.folderUri, {
							corpus: message.corpus,
							customCorpusPaths: message.customCorpusPaths
						});
						await w.postMessage({ type: 'browseKbListResult', ...listing });
						break;
					}
					case 'createNoteInFolderFromPicker': {
						const fileUri = await this.state.createNoteInFolderFromPicker(message.folderUri, message.title);
						await this.sidebarProvider.refresh();
						const listing = await this.state.browseKbList(message.folderUri, {
							corpus: message.corpus,
							customCorpusPaths: message.customCorpusPaths
						});
						await w.postMessage({
							type: 'browseKbListResult',
							...listing,
							navigateToFileUri: fileUri
						});
						break;
					}
					case 'createSubfolderFromPicker': {
						const newFolderUri = await this.state.createSubfolderFromPicker(message.parentUri, message.name);
						await this.sidebarProvider.refresh();
						const listing = await this.state.browseKbList(newFolderUri, {
							corpus: message.corpus,
							customCorpusPaths: message.customCorpusPaths
						});
						await w.postMessage({ type: 'browseKbListResult', ...listing });
						break;
					}
					case 'storagePickCustomPaths': {
						const kbRoot = this.state.getKnowledgeBaseRoot();
						if (!kbRoot) {
							void vscode.window.showWarningMessage('Pick a knowledge base (.driplock) folder first.');
							break;
						}
						const uris = await vscode.window.showOpenDialog({
							canSelectFiles: true,
							canSelectFolders: true,
							canSelectMany: true,
							openLabel: 'Add from KB',
							title: 'Add files or folders from the .driplock knowledge base',
							defaultUri: kbRoot
						});
						if (!uris || !uris.length) break;
						const entries = [];
						const seen = new Set();
						for (const uri of uris) {
							const rel = path.relative(kbRoot.fsPath, uri.fsPath).replace(/\\/g, '/');
							if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
								void vscode.window.showWarningMessage(
									`Skipped path outside KB: ${uri.fsPath}`
								);
								continue;
							}
							const low = rel.toLowerCase();
							if (seen.has(low)) continue;
							seen.add(low);
							let kind = 'file';
							try {
								const st = await vscode.workspace.fs.stat(uri);
								if (st.type & vscode.FileType.Directory) kind = 'folder';
							} catch {
								/* keep file */
							}
							entries.push({
								path: rel,
								kind,
								name: path.basename(uri.fsPath)
							});
						}
						if (entries.length) {
							await w.postMessage({
								type: 'storageCustomPathsPicked',
								payload: { entries }
							});
						}
						break;
					}
					case 'selectionChanged':
						lastStorageSelection = message.selection;
						break;
					case 'reorderHeadingSiblings': {
						await this.state.reorderHeadingSiblings(
							message.fileUri,
							message.parentPath != null ? message.parentPath : '',
							message.orderedPaths || []
						);
						await this.sidebarProvider.refresh();
						const note = message.note || lastComposerNote;
						const meta = await this.state.getFileHeadingMeta(message.fileUri, note);
						await w.postMessage({ type: 'fileHeadingsRefreshed', meta });
						break;
					}
					case 'saveDraft': {
						const note = message.note || lastComposerNote;
						const draft = await this.state.saveDraft(note);
						await notifyDraftSaved(this.sidebarProvider, draft, 'Draft saved.');
						break;
					}
					case 'ingestNote': {
						const note = message.note || lastComposerNote;
						const selection = lastStorageSelection;
						if (!selection) {
							await vscode.window.showWarningMessage(
								'Choose a storage target in the DRIP Storage view (secondary side bar) before ingesting.'
							);
							break;
						}
						const result = await this.state.ingestNote(note, selection);
						const summary = `Note ${result.mode === 'append' ? 'appended to' : 'created at'} ${result.targetPath}`;
						await notifyAfterIngest(this.sidebarProvider, summary);
						break;
					}
					case 'moveIssueBrowse': {
						const ctx = moveIssueContext || {};
						const kbRoot = this.state.getVerifiedKnowledgeBaseRoot && this.state.getVerifiedKnowledgeBaseRoot();
						if (!kbRoot || !ctx.projectFolderPrefix || !ctx.issueId) {
							await w.postMessage({
								type: 'moveIssueBrowseResult',
								level: 'root',
								inboxCount: 0,
								features: []
							});
							break;
						}
						const { listProjectMoveBrowse } = require('../document/project/projectIssueMove');
						const result = await listProjectMoveBrowse(
							kbRoot,
							ctx.projectFolderPrefix,
							message.node || { kind: 'root' },
							{
								issueId: ctx.issueId,
								title: ctx.issueTitle,
								rank: message.rank === true
							}
						);
						await w.postMessage({ type: 'moveIssueBrowseResult', ...result });
						break;
					}
					case 'moveIssueConfirm': {
						const ctx = moveIssueContext;
						const kbRoot = this.state.getVerifiedKnowledgeBaseRoot && this.state.getVerifiedKnowledgeBaseRoot();
						if (!ctx || !kbRoot || !message.target) {
							break;
						}
						const { moveProjectIssue } = require('../document/project/projectIssueMove');
						const result = await moveProjectIssue(
							kbRoot,
							ctx.projectFolderPrefix,
							ctx.issueId,
							message.target,
							{ context: this.state.context, removeParent: message.removeParent === true }
						);
						moveIssueContext = null;
						await w.postMessage({
							type: 'moveIssueDone',
							issueId: result.issueId
						});
						const { refreshProjectViewIfShown } = require('./lhs/projects/panel');
						refreshProjectViewIfShown();
						void vscode.window.setStatusBarMessage(`Moved ${ctx.issueId}`, 3000);
						break;
					}
					case 'moveIssueCancel': {
						moveIssueContext = null;
						break;
					}
					default:
						break;
				}
			} catch (error) {
				await w.postMessage({
					type: 'operationError',
					message: error instanceof Error ? error.message : String(error)
				});
			}
		});

		webviewView.onDidDispose(() => {
			if (storageWebviewRef === w) {
				storageWebviewRef = null;
			}
		});
	}

	/**
	 * LLM ingest proposal for a note (nothing is written; Ingest applies it).
	 * @param {{ title?: string, content?: string }} note
	 * @param {{ corpus?: unknown, customCorpusPaths?: unknown }} corpus
	 */
	async runLlmIngestPlan(note, corpus) {
		const kbRoot = await this.state.ensureKnowledgeBaseRoot();
		if (!kbRoot) {
			return { ok: false, message: 'Select a knowledge base folder first.' };
		}
		try {
			const { planLlmIngest } = require('../ingest/ingestPlanner');
			return await planLlmIngest({
				kbRoot,
				note: { title: note.title || '', content: note.content || '' },
				context: this.state.context,
				corpus: { corpus: corpus.corpus, customCorpusPaths: corpus.customCorpusPaths }
			});
		} catch (err) {
			return { ok: false, message: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * User accepted the LLM's split: part 1 replaces the Composer note, the rest become drafts,
	 * then part 1 is planned again on its own.
	 * @param {import('vscode').Webview} w
	 * @param {{ note?: any, parts?: { title?: string, text?: string }[], corpus?: unknown, customCorpusPaths?: unknown }} message
	 */
	async splitNoteIntoDrafts(w, message) {
		const parts = (Array.isArray(message.parts) ? message.parts : [])
			.map(p => ({ title: String((p && p.title) || '').trim(), text: String((p && p.text) || '').trim() }))
			.filter(p => p.text);
		if (parts.length < 2) {
			await w.postMessage({ type: 'llmIngestPlanResult', ok: false, message: 'Nothing to split.' });
			return;
		}
		const note = message.note || lastComposerNote || {};
		const stamp = Date.now();
		for (let i = parts.length - 1; i >= 1; i--) {
			await this.state.saveDraft({ id: `draft-${stamp}-${i}`, title: parts[i].title, content: parts[i].text });
		}
		const first = await this.state.saveDraft({
			id: note.id || `draft-${stamp}-0`,
			title: parts[0].title,
			metadata: '',
			content: parts[0].text,
			metadataFilename: note.metadataFilename || ''
		});
		await notifyDraftSaved(
			this.sidebarProvider,
			first,
			`Split into ${parts.length} notes. Note 1 is loaded; the others are in Drafts.`
		);
		await w.postMessage({ type: 'llmIngestPlanResult', ...(await this.runLlmIngestPlan(first, message)) });
	}
}

class DripComposerPanel {
	static currentPanel = undefined;

	static async createOrShow(extensionUri, state, sidebarProvider, draftId, capture) {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		if (DripComposerPanel.currentPanel) {
			DripComposerPanel.currentPanel.panel.reveal(column);
			await DripComposerPanel.currentPanel.loadState(draftId, '', {
				clearStorageSuggestions: !capture
			});
			if (capture) {
				await DripComposerPanel.currentPanel.postCapture(capture);
			}
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			DRIP_PANEL_ID,
			'DRIP Composer',
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extensionUri]
			}
		);

		DripComposerPanel.currentPanel = new DripComposerPanel(panel, state, sidebarProvider, extensionUri);
		await DripComposerPanel.currentPanel.loadState(draftId, '', {
			clearStorageSuggestions: !capture
		});
		if (capture) {
			await DripComposerPanel.currentPanel.postCapture(capture);
		}
	}

	static postState() {
		if (DripComposerPanel.currentPanel) {
			void DripComposerPanel.currentPanel.loadState();
		}
	}

	/**
	 * @param {import('vscode').WebviewPanel} panel
	 * @param {*} state
	 * @param {*} sidebarProvider
	 * @param {import('vscode').Uri} extensionUri
	 */
	constructor(panel, state, sidebarProvider, extensionUri) {
		this.panel = panel;
		this.state = state;
		this.sidebarProvider = sidebarProvider;
		this.extensionUri = extensionUri;

		this.panel.webview.html = getComposerHtml(this.panel.webview, this.extensionUri);

		this.panel.onDidDispose(() => {
			DripComposerPanel.currentPanel = undefined;
		});

		this.registerMessageHandlers();
	}

	registerMessageHandlers() {
		this.panel.webview.onDidReceiveMessage(async message => {
			try {
				switch (message.type) {
					case 'requestState':
						await this.loadState(message.draftId);
						break;
					case 'noteSnapshot':
						lastComposerNote = {
							id: message.note?.id || '',
							title: message.note?.title || '',
							headings: message.note?.headings || '',
							metadata: message.note?.metadata || '',
							content: message.note?.content || '',
							metadataFilename: message.note?.metadataFilename || ''
						};
						postToStorage({
							type: 'composerNote',
							note: {
								...lastComposerNote,
								content: combineComposerSections(
									lastComposerNote.metadata,
									lastComposerNote.content
								)
							}
						});
						break;
					case 'composerNewNote':
						lastStorageSelection = undefined;
						lastComposerCapture = null;
						postToStorage({
							type: 'storageReset',
							summaryText: 'No target selected. Use Suggestions.'
						});
						break;
					case 'saveDraft':
						await this.handleSaveDraft(message.note);
						break;
					case 'ingestNote':
						await this.handleIngest(message.note);
						break;
					case 'deleteDraft':
						await this.handleDeleteDraft(message.draftId);
						break;
					case 'selectKnowledgeBase':
						await vscode.commands.executeCommand(DRIP_SELECT_KB_COMMAND_ID);
						await this.loadState(message.noteId);
						break;
				}
			} catch (error) {
				await this.postError(error);
			}
		});
	}

	async handleSaveDraft(note) {
		const draft = await this.state.saveDraft(note);
		await notifyDraftSaved(this.sidebarProvider, draft, 'Draft saved.');
	}

	async handleDeleteDraft(draftId) {
		const id = String(draftId || '').trim();
		if (!id) {
			await vscode.window.showInformationMessage(
				'This note is not a saved draft yet. Save Draft first, or use New Note to clear the form.'
			);
			return;
		}
		await this.state.deleteItem({
			kind: 'draft',
			contextValue: 'dripDraft',
			draftId: id
		});
		if (this.state.getDraftById(id)) {
			return;
		}
		lastComposerCapture = null;
		lastComposerNote = null;
		lastStorageSelection = undefined;
		postToStorage({
			type: 'storageReset',
			summaryText: 'No target selected. Use Suggestions.'
		});
		await this.sidebarProvider.refresh();
		await this.loadState(undefined, 'Draft deleted.');
	}

	async handleIngest(note) {
		await revealDripStorageView();
		const selection = lastStorageSelection;
		if (!selection) {
			await vscode.window.showInformationMessage(
				'DRIP Storage is open on the right. Choose a target (Suggestions, AI, or Browse), then click Ingest again.'
			);
			return;
		}
		const result = await this.state.ingestNote(note, selection);
		const summary = `Note ${result.mode === 'append' ? 'appended to' : 'created at'} ${result.targetPath}`;
		await notifyAfterIngest(this.sidebarProvider, summary);
	}

	async postCapture(capture) {
		const title = capture.title != null ? capture.title : '';
		const metadata = capture.metadata != null ? capture.metadata : '';
		const content = capture.content != null ? capture.content : '';
		lastComposerCapture = { title, metadata, content };
		const ingestTitle = (() => {
			const m = String(title || '').trim().match(/^#{1,6}\s+(.*)$/);
			return m ? String(m[1] || '').trim() : String(title || '').trim();
		})();
		// Capture always starts a new unsaved draft — do not keep the previous draft id
		// or Save Draft would overwrite the earlier draft (same title is common).
		lastComposerNote = {
			id: '',
			title: ingestTitle,
			headings: ingestTitle,
			metadata,
			content,
			metadataFilename: ingestTitle
		};
		postToStorage({
			type: 'composerNote',
			note: {
				...lastComposerNote,
				content: combineComposerSections(metadata, content)
			}
		});
		await this.panel.webview.postMessage({
			type: 'capturedSelection',
			title,
			metadata,
			content
		});
		postToStorage({
			type: 'storageReset',
			summaryText: 'No target selected. Use Suggestions.'
		});
	}

	async loadState(draftId, statusMessage, options = {}) {
		if (options.clearStorageSuggestions) {
			lastComposerCapture = null;
		}
		const hasExplicitDraftId =
			draftId !== undefined && draftId !== null && String(draftId).trim().length > 0;
		const resolvedId = hasExplicitDraftId ? draftId : lastComposerNote?.id;
		const selectedDraft = resolvedId ? this.state.getDraftById(resolvedId) : undefined;
		const sidebarState = await this.state.getSidebarState();

		let draft = selectedDraft;
		if (
			!draft &&
			lastComposerNote &&
			(lastComposerNote.title ||
				lastComposerNote.headings ||
				lastComposerNote.metadata ||
				lastComposerNote.content ||
				lastComposerNote.metadataFilename)
		) {
			draft = {
				id: lastComposerNote.id || '',
				title: lastComposerNote.title || '',
				priority: 'Medium',
				headings: lastComposerNote.headings || '',
				metadata: lastComposerNote.metadata || '',
				content: lastComposerNote.content || '',
				metadataFilename: lastComposerNote.metadataFilename || '',
				status: 'draft'
			};
		}
		if (!draft) {
			draft = createEmptyDraft();
		}

		lastComposerNote = {
			id: draft.id || '',
			title: draft.title || '',
			headings: draft.headings || '',
			metadata: draft.metadata || '',
			content: draft.content || '',
			metadataFilename: draft.metadataFilename || ''
		};

		await this.panel.webview.postMessage({
			type: 'composerState',
			state: {
				kbRootPath: sidebarState.kbRootPath,
				draft,
				statusMessage: statusMessage || '',
				clearStorageSuggestions: options.clearStorageSuggestions === true,
				capture: lastComposerCapture
			}
		});

		postToStorage({
			type: 'composerNote',
			note: {
				...lastComposerNote,
				content: combineComposerSections(lastComposerNote.metadata, lastComposerNote.content)
			}
		});

		if (options.clearStorageSuggestions) {
			postToStorage({
				type: 'storageReset',
				summaryText: 'No target selected. Use Suggestions.'
			});
		}
	}

	async postError(error) {
		await this.panel.webview.postMessage({
			type: 'operationError',
			message: error instanceof Error ? error.message : String(error)
		});
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
		this.panel.webview.html = getTagsWebviewHtml(this.panel.webview);

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
	DripComposerPanel,
	DripTagsPanel,
	DripSubGraphPanel,
	DripStorageWebviewProvider,
	DRIP_VIEW_ID,
	DRIP_COMPONENTS_VIEW_ID,
	DRIP_KB_VIEW_ID,
	DRIP_DRAFTS_VIEW_ID,
	DRIP_STORAGE_VIEW_ID,
	postKbNoteSettingsToStorage,
	postTagGraphStateToAll,
	pushTagGraphUi,
	revealDripStorageView,
	beginIssueMove
};
