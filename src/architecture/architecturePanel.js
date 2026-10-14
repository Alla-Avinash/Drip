'use strict';

/**
 * DRIP Project Architecture — an interactive graph of a project's architecture.
 *
 * Launched from the Project View detail header ("Architecture" button). Shows the
 * project's features, components, sub-components, and implementation workflows as
 * nodes on a canvas, backed by the project's own `_architecture/architecture.drip`
 * database. Reuses the same node/link graph model as the tags graph.
 */

const vscode = require('vscode');
const path = require('path');
const { DRIP_ARCHITECTURE_PANEL_ID } = require('../shared/constants');
const { getNonce } = require('../shared/utils');
const { listProjectChildrenFromIndex } = require('../indexing/projectViewQuery');
const store = require('./architectureStore');
const workflowStore = require('./workflowStore');

function getArchitectureHtml(webview, extensionUri) {
	const nonce = getNonce();
	const styleUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'src', 'architecture', 'webview', 'architectureView.css')
	);
	const jsUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'src', 'architecture', 'webview', 'architectureView.js')
	);
	const csp = [
		`default-src 'none'`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}' ${webview.cspSource}`
	].join('; ');

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Project Architecture</title>
<link rel="stylesheet" href="${styleUri}" />
</head>
<body>
<header class="arch-header">
	<span class="arch-back" id="archBack" title="Back to Project View">\u2190 Projects</span>
	<h1 class="arch-title">Architecture</h1>
	<span class="arch-project" id="archProject"></span>
	<span class="arch-spacer"></span>
	<button type="button" class="arch-btn" id="archBtnComponent">New component</button>
	<button type="button" class="arch-btn" id="archBtnSubcomponent">New sub-component</button>
	<button type="button" class="arch-btn" id="archBtnImplementation">New implementation</button>
	<button type="button" class="arch-btn" id="archBtnMakeWorkflow" title="Build a workflow from components on this graph">Make workflow</button>
	<button type="button" class="arch-btn" id="archBtnReset">Reset view</button>
</header>
<div class="arch-hint" id="archHint">Loading architecture\u2026</div>
<div class="arch-body">
	<div class="arch-canvas-wrap" id="archCanvasWrap">
		<canvas id="archCanvas" width="800" height="500" aria-label="Project architecture graph"></canvas>
		<div class="arch-hover-label" id="archHoverLabel" hidden></div>
		<div class="arch-context" id="archContextMenu" hidden></div>
		<div class="arch-inline-edit" id="archInlineEdit" hidden>
			<input type="text" id="archInlineInput" class="arch-field" placeholder="Name" autocomplete="off" />
		</div>
		<div class="arch-workflow-bar" id="archWorkflowBar" hidden>
			<button type="button" class="arch-btn" id="wfBtnRestart" title="Restart">&#9198;</button>
			<button type="button" class="arch-btn" id="wfBtnStepBack" title="Step back">&#9194;</button>
			<button type="button" class="arch-btn" id="wfBtnPlay" title="Play / pause">&#9654;</button>
			<button type="button" class="arch-btn" id="wfBtnStepFwd" title="Step forward">&#9193;</button>
			<select class="arch-btn" id="wfSpeed">
				<option value="0.5">0.5&#215;</option>
				<option value="1" selected>1&#215;</option>
				<option value="2">2&#215;</option>
			</select>
			<span class="arch-wf-status" id="wfStatus"></span>
			<button type="button" class="arch-btn" id="wfBtnExit">Exit</button>
		</div>
	</div>
	<div class="arch-sidebar" id="archSidebar"></div>
</div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

class DripArchitecturePanel {
	/** @type {DripArchitecturePanel | undefined} */
	static currentPanel;

	/**
	 * @param {import('vscode').ExtensionContext} context
	 * @param {{ getVerifiedKnowledgeBaseRoot?: () => import('vscode').Uri | undefined }} state
	 * @param {string} folderPrefix
	 * @param {string} projectTitle
	 */
	static createOrShow(context, state, folderPrefix, projectTitle) {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;
		if (DripArchitecturePanel.currentPanel) {
			const existing = DripArchitecturePanel.currentPanel;
			existing.setProject(folderPrefix, projectTitle);
			existing.panel.reveal(column);
			existing.panel.webview.html = getArchitectureHtml(existing.panel.webview, context.extensionUri);
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			DRIP_ARCHITECTURE_PANEL_ID,
			'Project Architecture',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(context.extensionUri, 'src', 'architecture')
				]
			}
		);
		DripArchitecturePanel.currentPanel = new DripArchitecturePanel(
			panel,
			context,
			state,
			folderPrefix,
			projectTitle
		);
		panel.webview.html = getArchitectureHtml(panel.webview, context.extensionUri);
		panel.onDidDispose(() => {
			DripArchitecturePanel.currentPanel = undefined;
		});
	}

	/**
	 * @param {import('vscode').WebviewPanel} panel
	 * @param {import('vscode').ExtensionContext} context
	 * @param {{ getVerifiedKnowledgeBaseRoot?: () => import('vscode').Uri | undefined }} state
	 * @param {string} folderPrefix
	 * @param {string} projectTitle
	 */
	constructor(panel, context, state, folderPrefix, projectTitle) {
		this.panel = panel;
		this.context = context;
		this.state = state;
		this.folderPrefix = String(folderPrefix || '');
		this.projectTitle = String(projectTitle || '');

		panel.webview.onDidReceiveMessage(async message => {
			try {
				switch (message.type) {
					case 'ready':
					case 'refresh':
						await this.refresh();
						break;
					case 'createEntity':
						await this.createEntity(message);
						break;
					case 'renameEntity':
						await store.renameEntity(this.kbRoot(), this.folderPrefix, message);
						await this.refresh();
						break;
					case 'deleteEntity':
						await store.deleteEntity(this.kbRoot(), this.folderPrefix, message);
						await this.refresh();
						break;
					case 'moveEntity':
						await store.moveEntity(this.kbRoot(), this.folderPrefix, message);
						break;
					case 'setParent':
						await store.setParent(this.kbRoot(), this.folderPrefix, message);
						await this.refresh();
						break;
					case 'setFeature':
						await store.setFeature(this.kbRoot(), this.folderPrefix, message);
						await this.refresh();
						break;
					case 'addLink':
						await store.addLink(this.kbRoot(), this.folderPrefix, message);
						await this.refresh();
						break;
					case 'removeLink':
						await store.removeLink(this.kbRoot(), this.folderPrefix, message);
						await this.refresh();
						break;
					case 'openDescription':
						await this.openDescription(message);
						break;
					case 'playWorkflow':
						await this.playWorkflow(message);
						break;
					case 'buildWorkflow':
						await this.buildWorkflow(message);
						break;
					case 'saveWorkflow':
						await this.saveWorkflow(message);
						break;
					case 'back':
						this.panel.dispose();
						break;
					default:
						break;
				}
			} catch (err) {
				const msg = err && err.message ? err.message : String(err);
				console.error('[DRIP] Architecture message failed', err);
				void this.panel.webview.postMessage({ type: 'error', message: msg });
			}
		});
	}

	/** @returns {import('vscode').Uri | undefined} */
	kbRoot() {
		return this.state.getVerifiedKnowledgeBaseRoot && this.state.getVerifiedKnowledgeBaseRoot();
	}

	/** @param {string} folderPrefix @param {string} projectTitle */
	setProject(folderPrefix, projectTitle) {
		this.folderPrefix = String(folderPrefix || '');
		this.projectTitle = String(projectTitle || '');
	}

	async refresh() {
		const kbRoot = this.kbRoot();
		if (!kbRoot || !this.folderPrefix) {
			await this.panel.webview.postMessage({
				type: 'graph',
				nodes: [],
				links: [],
				projectTitle: this.projectTitle
			});
			return;
		}
		const { features } = await listProjectChildrenFromIndex(kbRoot, this.folderPrefix);
		const { nodes, links } = await store.loadGraph(kbRoot, this.folderPrefix, features);
		await this.panel.webview.postMessage({
			type: 'graph',
			nodes,
			links,
			projectTitle: this.projectTitle
		});
	}

	/**
	 * @param {{ entityType?: string, name?: string, parentId?: string, featureId?: string }} message
	 */
	async createEntity(message) {
		const kbRoot = this.kbRoot();
		if (!kbRoot || !this.folderPrefix) return;
		await store.createEntity(kbRoot, this.folderPrefix, {
			type: String(message.entityType || 'component'),
			name: String(message.name || '').trim() || 'Untitled',
			parentId: message.parentId ? String(message.parentId) : null,
			featureId: message.featureId ? String(message.featureId) : null
		});
		await this.refresh();
	}

	/**
	 * @param {{ id?: string }} message
	 */
	async openDescription(message) {
		const kbRoot = this.kbRoot();
		const id = String(message.id || '');
		if (!kbRoot || !id) return;
		const { nodes } = await store.loadGraph(kbRoot, this.folderPrefix, []);
		const node = nodes.find(n => String(n.id) === id);
		if (!node || !node.descriptionFile) return;
		const uri = store.descriptionFileUri(kbRoot, this.folderPrefix, node.descriptionFile);
		try {
			await vscode.workspace.fs.stat(uri);
		} catch {
			// Description file went missing — recreate it in place.
			await store.writeDescriptionFileTo(kbRoot, this.folderPrefix, node.descriptionFile, node.name);
		}
		await vscode.commands.executeCommand('vscode.open', uri);
	}

	/**
	 * Load an implementation's workflow and hand it to the webview for playback.
	 * @param {{ id?: string }} message
	 */
	async playWorkflow(message) {
		const kbRoot = this.kbRoot();
		const id = String(message.id || '');
		if (!kbRoot || !id) return;
		const node = await this.nodeById(id);
		if (!node || node.type !== 'implementation') return;
		const wf = await workflowStore.loadWorkflow(kbRoot, this.folderPrefix, id);
		await this.panel.webview.postMessage({
			type: 'workflowData',
			workflowId: id,
			name: wf.name,
			steps: wf.steps,
			mode: 'play'
		});
	}

	/**
	 * Load an implementation's workflow and hand it to the webview for editing (builder).
	 * @param {{ id?: string }} message
	 */
	async buildWorkflow(message) {
		const kbRoot = this.kbRoot();
		const id = String(message.id || '');
		if (!kbRoot || !id) return;
		const node = await this.nodeById(id);
		if (!node || node.type !== 'implementation') return;
		const wf = await workflowStore.loadWorkflow(kbRoot, this.folderPrefix, id);
		await this.panel.webview.postMessage({
			type: 'workflowData',
			workflowId: id,
			name: wf.name,
			steps: wf.steps,
			mode: 'build'
		});
	}

	/**
	 * Persist a workflow definition built in the webview.
	 * @param {{ workflowId?: string, steps?: object[] }} message
	 */
	async saveWorkflow(message) {
		const kbRoot = this.kbRoot();
		const workflowId = String(message.workflowId || '');
		if (!kbRoot || !workflowId) return;
		await workflowStore.saveWorkflow(kbRoot, this.folderPrefix, workflowId, message.steps || []);
		await this.panel.webview.postMessage({ type: 'workflowSaved', workflowId });
	}

	/**
	 * @param {string} id
	 * @returns {Promise<object | undefined>}
	 */
	async nodeById(id) {
		const kbRoot = this.kbRoot();
		if (!kbRoot) return undefined;
		const { nodes } = await store.loadGraph(kbRoot, this.folderPrefix, []);
		return nodes.find(n => String(n.id) === id);
	}
}

module.exports = {
	DripArchitecturePanel,
	getArchitectureHtml
};
