'use strict';

/**
 * DRIP Project View — Linear-style project → feature → issue browser (index.drip backed).
 * UI script/CSS live under webview/ (external files — avoids inline-script HTML parser bugs).
 */

const vscode = require('vscode');
const path = require('path');
const { DRIP_PROJECT_VIEW_PANEL_ID } = require('../../../shared/constants');
const { getNonce } = require('../../../shared/utils');
const {
	listProjectsFromIndex,
	listProjectChildrenFromIndex
} = require('../../../indexing/projectViewQuery');

function tryCloseAuxiliaryBar() {
	try {
		void vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
	} catch {
		/* ignore */
	}
}

/**
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} extensionUri
 */
function getProjectViewHtml(webview, extensionUri) {
	const nonce = getNonce();
	const styleUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'src', 'views', 'lhs', 'projects', 'webview', 'projectView.css')
	);
	const jsUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'src', 'views', 'lhs', 'projects', 'webview', 'projectView.js')
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
<title>Project View</title>
<link rel="stylesheet" href="${styleUri}" />
</head>
<body>
<header>
	<h1>Project View</h1>
	<span class="meta" id="kbMeta">Loading…</span>
	<button type="button" class="ghost" id="btnRefresh">Refresh</button>
</header>
<div class="layout">
	<div class="center" id="root">
		<p class="page-sub">Connecting to extension host…</p>
	</div>
</div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

class DripProjectViewPanel {
	/** @type {DripProjectViewPanel | undefined} */
	static currentPanel;

	/**
	 * @param {import('vscode').ExtensionContext} context
	 * @param {{ getKnowledgeBaseRoot?: () => import('vscode').Uri | undefined }} state
	 */
	static createOrShow(context, state) {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;
		if (DripProjectViewPanel.currentPanel) {
			const existing = DripProjectViewPanel.currentPanel;
			existing.panel.reveal(column);
			// Always re-set HTML so webview picks up script/CSS fixes (old inline HTML stuck on Loading).
			existing.panel.webview.html = getProjectViewHtml(
				existing.panel.webview,
				context.extensionUri
			);
			tryCloseAuxiliaryBar();
			// `ready` from the reloaded script will call refresh().
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			DRIP_PROJECT_VIEW_PANEL_ID,
			'DRIP Project View',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(context.extensionUri, 'src', 'views', 'lhs', 'projects')
				]
			}
		);
		DripProjectViewPanel.currentPanel = new DripProjectViewPanel(panel, context, state);
		panel.webview.html = getProjectViewHtml(panel.webview, context.extensionUri);
		tryCloseAuxiliaryBar();
		// First paint is driven by the webview `ready` message (script must load first).
		panel.onDidDispose(() => {
			DripProjectViewPanel.currentPanel = undefined;
		});
	}

	/**
	 * @param {import('vscode').WebviewPanel} panel
	 * @param {import('vscode').ExtensionContext} context
	 * @param {{ getKnowledgeBaseRoot?: () => import('vscode').Uri | undefined }} state
	 */
	constructor(panel, context, state) {
		this.panel = panel;
		this.context = context;
		this.state = state;
		this._selectedPrefix = '';

		panel.webview.onDidReceiveMessage(async message => {
			try {
				switch (message.type) {
					case 'ready':
					case 'refresh':
						await this.refresh();
						break;
					case 'selectProject':
						this._selectedPrefix = String(message.folderPrefix || '');
						await this.loadProject(this._selectedPrefix);
						break;
					case 'clearProject':
						this._selectedPrefix = '';
						break;
					case 'openHeading':
						await this.openHeading(message);
						break;
					case 'createIssue':
						await this.createIssue(message);
						break;
					case 'assignIssue':
						await this.assignIssue(message);
						break;
					default:
						break;
				}
			} catch (err) {
				const msg = err && err.message ? err.message : String(err);
				console.error('[DRIP] Project View message failed', err);
				void this.panel.webview.postMessage({ type: 'error', message: msg });
			}
		});
	}

	async refresh() {
		try {
			const kbRoot = this.state.getKnowledgeBaseRoot && this.state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				this._selectedPrefix = '';
				await this.panel.webview.postMessage({
					type: 'projects',
					projects: [],
					kbLabel: 'Select a knowledge base first'
				});
				return;
			}
			const { projects } = await listProjectsFromIndex(kbRoot);
			if (
				this._selectedPrefix &&
				!projects.some(p => p.folderPrefix === this._selectedPrefix)
			) {
				this._selectedPrefix = '';
			}
			await this.panel.webview.postMessage({
				type: 'projects',
				projects,
				kbLabel: path.basename(kbRoot.fsPath)
			});
			if (this._selectedPrefix) {
				await this.loadProject(this._selectedPrefix);
			}
		} catch (err) {
			const msg = err && err.message ? err.message : String(err);
			console.error('[DRIP] Project View refresh failed', err);
			await this.panel.webview.postMessage({ type: 'error', message: msg });
		}
	}

	/**
	 * @param {string} folderPrefix
	 */
	async loadProject(folderPrefix) {
		const kbRoot = this.state.getKnowledgeBaseRoot && this.state.getKnowledgeBaseRoot();
		if (!kbRoot || !folderPrefix) {
			await this.panel.webview.postMessage({
				type: 'projectDetail',
				folderPrefix: '',
				features: [],
				issues: []
			});
			return;
		}
		const data = await listProjectChildrenFromIndex(kbRoot, folderPrefix);
		try {
			const folderUri = vscode.Uri.joinPath(
				kbRoot,
				...folderPrefix.replace(/\/+$/, '').split('/').filter(Boolean)
			);
			const { ensureProjectIssuesFile } = require('../../../document/project/projectIssuesMailbox');
			await ensureProjectIssuesFile(folderUri, { kbRoot, context: this.context });
		} catch {
			/* ignore */
		}
		await this.panel.webview.postMessage({
			type: 'projectDetail',
			folderPrefix,
			features: data.features,
			issues: data.issues
		});
	}

	/**
	 * @param {{ folderPrefix?: string, parentIssueId?: string, title?: string }} message
	 */
	async createIssue(message) {
		const kbRoot = this.state.getKnowledgeBaseRoot && this.state.getKnowledgeBaseRoot();
		const prefix = String(message.folderPrefix || this._selectedPrefix || '');
		if (!kbRoot || !prefix) return;
		const folderUri = vscode.Uri.joinPath(
			kbRoot,
			...prefix.replace(/\/+$/, '').split('/').filter(Boolean)
		);
		// Prefer title from in-panel compose; never use the top InputBox.
		const title = String(message.title || '').trim();
		if (!title) {
			void vscode.window.showWarningMessage('Enter an issue title in the Project View form.');
			return;
		}
		const { createIssueInProjectInbox } = require('../../../document/project/projectIssuesMailbox');
		const result = await createIssueInProjectInbox(kbRoot, folderUri, {
			title,
			parentIssueId: message.parentIssueId || null,
			context: this.context
		});
		void vscode.window.setStatusBarMessage(`Created ${result.issueId}`, 2500);
		await this.loadProject(prefix);
	}

	/**
	 * @param {{ folderPrefix?: string, issueId?: string }} message
	 */
	async assignIssue(message) {
		const kbRoot = this.state.getKnowledgeBaseRoot && this.state.getKnowledgeBaseRoot();
		const prefix = String(message.folderPrefix || this._selectedPrefix || '');
		const issueId = String(message.issueId || '');
		if (!kbRoot || !prefix || !issueId) return;
		const data = await listProjectChildrenFromIndex(kbRoot, prefix);
		const features = data.features || [];
		if (!features.length) {
			void vscode.window.showWarningMessage('Create a feature first, then assign the issue.');
			return;
		}
		const picked = await vscode.window.showQuickPick(
			features.map(f => ({
				label: f.title,
				description: f.folderPrefix || f.path,
				feature: f
			})),
			{ placeHolder: `Send ${issueId} to feature mailbox` }
		);
		if (!picked) return;
		const folderUri = vscode.Uri.joinPath(
			kbRoot,
			...prefix.replace(/\/+$/, '').split('/').filter(Boolean)
		);
		const feat = picked.feature;
		const featureUri = feat.isFolderIndex
			? vscode.Uri.joinPath(
					kbRoot,
					...String(feat.folderPrefix || '')
						.replace(/\/+$/, '')
						.split('/')
						.filter(Boolean)
				)
			: vscode.Uri.joinPath(kbRoot, ...String(feat.path || '').split('/').filter(Boolean));
		const { moveIssueToFeatureMailbox } = require('../../../document/project/projectIssuesMailbox');
		await moveIssueToFeatureMailbox(kbRoot, folderUri, featureUri, issueId, {
			context: this.context
		});
		void vscode.window.setStatusBarMessage(`Moved ${issueId} → feature mailbox`, 3000);
		await this.loadProject(prefix);
	}

	/**
	 * @param {{ path?: string, title?: string, headingId?: number }} message
	 */
	async openHeading(message) {
		const kbRoot = this.state.getKnowledgeBaseRoot && this.state.getKnowledgeBaseRoot();
		if (!kbRoot || !message.path) return;
		const uri = vscode.Uri.joinPath(kbRoot, ...String(message.path).split('/').filter(Boolean));
		const doc = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(doc, { preview: false });
		const wantTitle = String(message.title || '')
			.trim()
			.toLowerCase();
		if (!wantTitle) return;
		const text = doc.getText();
		const lines = text.replace(/\r\n/g, '\n').split('\n');
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(/^#{1,6}\s+(.*)$/);
			if (!m) continue;
			const title = String(m[1] || '')
				.replace(/^\.([A-Za-z][A-Za-z0-9_-]*)\s+/, '')
				.replace(/^\.\s+/, '')
				.trim()
				.toLowerCase();
			if (title === wantTitle) {
				const pos = new vscode.Position(i, 0);
				editor.selection = new vscode.Selection(pos, pos);
				editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
				break;
			}
		}
	}
}

function refreshProjectViewIfShown() {
	const panel = DripProjectViewPanel.currentPanel;
	if (!panel) return;
	void (async () => {
		await panel.refresh();
		if (panel._selectedPrefix) {
			await panel.loadProject(panel._selectedPrefix);
		}
	})();
}

module.exports = {
	DripProjectViewPanel,
	getProjectViewHtml,
	refreshProjectViewIfShown
};
