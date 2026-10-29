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
const {
	getFileLevelMetadataSettings,
	getMetadataSettings
} = require('../../../document/model/dripNoteMetadataTemplates.js');

function tryCloseAuxiliaryBar() {
	try {
		void vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
	} catch {
		/* ignore */
	}
}

/**
 * Enum values from a metadata type's attribute, lowercased and deduped.
 * @param {{ attributes?: Record<string, { values?: unknown[] }> } | undefined} type
 * @param {string} key
 * @returns {string[]}
 */
function enumValuesFor(type, key) {
	const a = type && type.attributes && type.attributes[String(key).toLowerCase()];
	const values = a && Array.isArray(a.values) ? a.values : [];
	return Array.from(new Set(values.map(v => String(v).trim().toLowerCase()).filter(Boolean)));
}

/**
 * Field schema for the Project View filter/group/sort toolbar. Enum values are
 * read live from DRIP settings (`.project` / `.issue` templates), not hardcoded.
 * @returns {{ project: { fields: object[] }, issue: { fields: object[] } }}
 */
function buildFilterSchemaForWebview() {
	const fileLevel = getFileLevelMetadataSettings();
	const doc = getMetadataSettings();
	const projectType = fileLevel.typeById && fileLevel.typeById.get('project');
	const issueType = doc.typeById && doc.typeById.get('issue');

	return {
		project: {
			fields: [
				{ id: 'title', label: 'Title', kind: 'text' },
				{ id: 'status', label: 'Status', kind: 'enum', values: enumValuesFor(projectType, 'status') },
				{ id: 'priority', label: 'Priority', kind: 'enum', values: enumValuesFor(projectType, 'priority') },
				{ id: 'deadline', label: 'Deadline', kind: 'datetime' },
				{ id: 'issues', label: 'Issues', kind: 'number' }
			]
		},
		issue: {
			fields: [
				{ id: 'title', label: 'Title', kind: 'text' },
				{ id: 'feature', label: 'Feature', kind: 'enum', values: [] },
				{ id: 'status', label: 'Status', kind: 'enum', values: enumValuesFor(issueType, 'status') },
				{ id: 'priority', label: 'Priority', kind: 'enum', values: enumValuesFor(issueType, 'priority') },
				{ id: 'deadline', label: 'Deadline', kind: 'datetime' },
				{ id: 'category', label: 'Category', kind: 'enum', values: enumValuesFor(issueType, 'category') },
				{ id: 'team', label: 'Team', kind: 'enum', values: [] }
			]
		}
	};
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
	const schemaUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'src', 'views', 'lhs', 'projects', 'webview', 'filterSchema.js')
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
<script nonce="${nonce}" src="${schemaUri}"></script>
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
					case 'moveIssue':
						await this.moveIssue(message);
						break;
					case 'openProjectOverview':
						await this.openProjectOverview(message);
						break;
					case 'openFeatureOverview':
						await this.openFeatureOverview(message);
						break;
					case 'joinProject':
						await vscode.commands.executeCommand('drip.joinProject');
						break;
					case 'openProjectSettings':
					case 'openProjectShare': {
						const prefix = String(message.folderPrefix || this._selectedPrefix || '');
						const title = String(message.title || '');
						const pick = await vscode.window.showQuickPick(
							[
								{
									label: 'Project metadata',
									description: 'Status, priority, and category for this project',
									panel: 'project-types'
								},
								{
									label: 'Share settings',
									description: 'Invite people and keep this project in sync',
									panel: 'project-sharing'
								}
							],
							{ placeHolder: title || 'Project settings' }
						);
						if (!pick) break;
						await vscode.commands.executeCommand('drip.openDripSettingsView', {
							panel: pick.panel,
							projectKey: prefix,
							projectTitle: title
						});
						break;
					}
					case 'requestProjectTags':
						await this.sendProjectTags(String(message.folderPrefix || this._selectedPrefix || ''));
						break;
					case 'addProjectTag':
						await this.mutateProjectTags('add', message);
						break;
					case 'renameProjectTag':
						await this.mutateProjectTags('rename', message);
						break;
					case 'setProjectTagDescription':
						await this.mutateProjectTags('description', message);
						break;
					case 'deleteProjectTag':
						await this.mutateProjectTags('delete', message);
						break;
					case 'loadChatOverview':
						await this.loadChatOverview(message);
						break;
					case 'openChatRoom':
						await this.openChatRoom(message);
						break;
					case 'sendChat':
						await this.sendChat(message);
						break;
					case 'clearChat':
						await this.clearChat(message);
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
			const kbRoot = this.state.getVerifiedKnowledgeBaseRoot && this.state.getVerifiedKnowledgeBaseRoot();
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
				schema: buildFilterSchemaForWebview(),
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
		const kbRoot = this.state.getVerifiedKnowledgeBaseRoot && this.state.getVerifiedKnowledgeBaseRoot();
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
		let share = { shared: false, status: 'solo', members: [], role: '', notices: [] };
		try {
			const { shareStateForWebview } = require('../../../peer/projectShareCommands');
			share = await shareStateForWebview(kbRoot, folderPrefix);
		} catch {
			/* sharing is optional */
		}
		await this.panel.webview.postMessage({
			type: 'projectDetail',
			folderPrefix,
			features: data.features,
			issues: data.issues,
			share
		});
	}

	/**
	 * @param {{ folderPrefix?: string, parentIssueId?: string, title?: string }} message
	 */
	async createIssue(message) {
		const kbRoot = this.state.getVerifiedKnowledgeBaseRoot && this.state.getVerifiedKnowledgeBaseRoot();
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
		const rec = await require('../../../peer/projectSidecar').readProjectRecord(folderUri);
		if (rec && rec.shared) {
			const me = await require('../../../peer/peerIdentity').ensurePeerIdentity();
			const { hasCap, CAPS } = require('../../../peer/projectRoles');
			if (!hasCap(rec, me.peerId, CAPS.ISSUE_CREATE)) {
				void vscode.window.showWarningMessage('Your role cannot create issues.');
				return;
			}
		}
		const { createIssueInProjectInbox } = require('../../../document/project/projectIssuesMailbox');
		const result = await createIssueInProjectInbox(kbRoot, folderUri, {
			title,
			parentIssueId: message.parentIssueId || null,
			team: String(message.team || ''),
			attributes: message.team ? { team: String(message.team) } : {},
			context: this.context
		});
		void vscode.window.setStatusBarMessage(`Created ${result.issueId}`, 2500);
		await this.loadProject(prefix);
	}

	/**
	 * Open the RHS Storage sidebar in "move issue" mode for this issue (scoped to the project).
	 * The actual move happens only when the user confirms in Storage.
	 * @param {{ folderPrefix?: string, issueId?: string }} message
	 */
	async moveIssue(message) {
		const kbRoot = this.state.getVerifiedKnowledgeBaseRoot && this.state.getVerifiedKnowledgeBaseRoot();
		const prefix = String(message.folderPrefix || this._selectedPrefix || '');
		const issueId = String(message.issueId || '');
		if (!kbRoot || !prefix || !issueId) return;
		try {
			const folderUri = vscode.Uri.joinPath(
				kbRoot,
				...prefix.replace(/\/+$/, '').split('/').filter(Boolean)
			);
			const rec = await require('../../../peer/projectSidecar').readProjectRecord(folderUri);
			if (rec && rec.shared) {
				const me = await require('../../../peer/peerIdentity').ensurePeerIdentity();
				const { hasCap, CAPS } = require('../../../peer/projectRoles');
				if (!hasCap(rec, me.peerId, CAPS.ISSUE_MOVE)) {
					void vscode.window.showWarningMessage('Your role cannot move issues.');
					return;
				}
			}
		} catch {
			/* role check is best-effort */
		}

		const { issues } = await listProjectChildrenFromIndex(kbRoot, prefix);
		const issue = issues.find(
			i => String(i.issueKey || '').toLowerCase() === issueId.toLowerCase()
		);
		if (!issue) {
			void vscode.window.showWarningMessage(`Issue ${issueId} not found.`);
			return;
		}

		// Project display name for the Storage banner.
		let projectName = prefix.replace(/\/+$/, '').split('/').pop() || prefix;
		try {
			const { projects } = await listProjectsFromIndex(kbRoot);
			const proj = projects.find(p => p.folderPrefix === prefix);
			if (proj && proj.title) projectName = String(proj.title);
		} catch {
			/* fall back to the folder name */
		}

		const { beginIssueMove } = require('../../views');
		await beginIssueMove({
			projectName,
			projectFolderPrefix: prefix,
			issueId,
			issueTitle: String(issue.title || ''),
			hasParent: !!issue.parentIssueKey
		});
	}

	/**
	 * @param {{ path?: string, title?: string, headingId?: number }} message
	 */
	async openHeading(message) {
		const kbRoot = this.state.getVerifiedKnowledgeBaseRoot && this.state.getVerifiedKnowledgeBaseRoot();
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
			const m = lines[i].match(/^#\d*\s+(.*)$/);
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

	/** @returns {import('vscode').Uri | undefined} */
	kbRoot() {
		return this.state.getVerifiedKnowledgeBaseRoot && this.state.getVerifiedKnowledgeBaseRoot();
	}

	/**
	 * Open the project's index note `_<Name>.p.d.txt`, creating it first if missing.
	 * @param {{ folderPrefix?: string }} message
	 */
	async openProjectOverview(message) {
		const kbRoot = this.kbRoot();
		const prefix = String(message.folderPrefix || this._selectedPrefix || '');
		if (!kbRoot || !prefix) return;
		const folderUri = vscode.Uri.joinPath(
			kbRoot,
			...prefix.replace(/\/+$/, '').split('/').filter(Boolean)
		);
		const { ensureProjectIndexFile } = require('../../../startup/dripProjectFolder');
		const { projectIndexFileName } = require('../../../document/model/dripNoteProjectFolder.js');
		let uri = await ensureProjectIndexFile(folderUri, { kbRoot, context: this.context });
		if (!uri) {
			uri = vscode.Uri.joinPath(folderUri, projectIndexFileName(path.basename(folderUri.fsPath)));
		}
		await vscode.commands.executeCommand('vscode.open', uri);
	}

	/**
	 * Open a feature's overview/index note. For a `.f` folder, ensure + open `_<Name>.f.d.txt`;
	 * for a standalone `*.f.d.txt` file, open the file itself (creating a blank one if missing).
	 * @param {{ folderPrefix?: string, path?: string, featureFolderPrefix?: string, isFolderIndex?: boolean, title?: string }} message
	 */
	async openFeatureOverview(message) {
		const kbRoot = this.kbRoot();
		if (!kbRoot) return;
		const isFolderIndex = message.isFolderIndex === true;
		let uri;
		if (isFolderIndex) {
			const folderPrefix = String(message.featureFolderPrefix || '');
			if (!folderPrefix) return;
			const folderUri = vscode.Uri.joinPath(
				kbRoot,
				...folderPrefix.replace(/\/+$/, '').split('/').filter(Boolean)
			);
			const { ensureFeatureIndexFile } = require('../../../startup/dripFeatureFolder');
			const { featureIndexFileName } = require('../../../document/model/dripNoteFeature.js');
			uri = await ensureFeatureIndexFile(folderUri, { kbRoot, context: this.context });
			if (!uri) {
				uri = vscode.Uri.joinPath(folderUri, featureIndexFileName(path.basename(folderUri.fsPath)));
			}
		} else {
			const filePath = String(message.path || '');
			if (!filePath) return;
			uri = vscode.Uri.joinPath(kbRoot, ...filePath.split('/').filter(Boolean));
			try {
				await vscode.workspace.fs.stat(uri);
			} catch {
				// Standalone feature file missing — create a minimal `.f` note.
				const { buildNewNoteFile, writeTextFile } = require('../../../document/dripNoteKbOps.js');
				const { isDripFeatureFileName } = require('../../../document/model/dripNoteFeature.js');
				const base = path.posix.basename(filePath);
				const title = isDripFeatureFileName(base)
					? base.replace(/\.f\.d\.txt$/i, '')
					: String(message.title || base);
				await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
				await writeTextFile(uri, buildNewNoteFile({ title, content: '', metadataFilename: title }, { h0TypeMarker: '.f' }));
			}
		}
		await vscode.commands.executeCommand('vscode.open', uri);
	}

	/**
	 * @param {string} prefix
	 */
	async sendProjectTags(prefix) {
		const kbRoot = this.kbRoot();
		if (!kbRoot || !prefix) {
			await this.panel.webview.postMessage({ type: 'projectTagsState', folderPrefix: prefix || '', tags: [] });
			return;
		}
		const { loadProjectTags } = require('../../../graph/projectTagStore');
		const tags = await loadProjectTags(kbRoot, prefix);
		await this.panel.webview.postMessage({ type: 'projectTagsState', folderPrefix: prefix, tags });
	}

	/**
	 * @param {'add' | 'rename' | 'description' | 'delete'} op
	 * @param {{ folderPrefix?: string, tagId?: string, name?: string, description?: string }} message
	 */
	async mutateProjectTags(op, message) {
		const kbRoot = this.kbRoot();
		const prefix = String(message.folderPrefix || this._selectedPrefix || '');
		if (!kbRoot || !prefix) return;
		const store = require('../../../graph/projectTagStore');
		if (op === 'add') {
			await store.addProjectTag(kbRoot, prefix, String(message.name || ''), String(message.description || ''));
		} else if (op === 'rename') {
			await store.renameProjectTag(kbRoot, prefix, String(message.tagId || ''), String(message.name || ''));
		} else if (op === 'description') {
			await store.setProjectTagDescription(kbRoot, prefix, String(message.tagId || ''), String(message.description || ''));
		} else if (op === 'delete') {
			await store.deleteProjectTag(kbRoot, prefix, String(message.tagId || ''));
		}
		await this.sendProjectTags(prefix);
	}

	async _chatContext(message) {
		const kbRoot = this.state.getVerifiedKnowledgeBaseRoot && this.state.getVerifiedKnowledgeBaseRoot();
		const prefix = String(message.folderPrefix || this._selectedPrefix || '');
		if (!kbRoot || !prefix) return null;
		const folderUri = vscode.Uri.joinPath(kbRoot, ...prefix.replace(/\/+$/, '').split('/').filter(Boolean));
		const rec = await require('../../../peer/projectSidecar').readProjectRecord(folderUri);
		const me = await require('../../../peer/peerIdentity').ensurePeerIdentity();
		return { kbRoot, prefix, folderUri, rec, me };
	}

	async _postChatOverview(ctx) {
		const { chatOverview } = require('../../../peer/projectChat');
		const overview = await chatOverview(ctx.folderUri, ctx.rec, ctx.me.peerId, {
			kbRootUri: ctx.kbRoot,
			folderPrefix: ctx.prefix
		});
		await this.panel.webview.postMessage({ type: 'chatOverview', overview });
	}

	async refreshChatOverview() {
		const ctx = await this._chatContext({ folderPrefix: this._selectedPrefix || '' });
		if (!ctx || !ctx.rec || !ctx.rec.shared) return;
		await this._postChatOverview(ctx);
	}

	/** Re-send the currently open room's messages so read ticks update live. */
	async refreshOpenChatRoom() {
		const active = this._activeChatRoom;
		if (!active) return;
		const ctx = await this._chatContext({ folderPrefix: this._selectedPrefix || '' });
		if (!ctx || !ctx.rec || !ctx.rec.shared) return;
		const { readRoom } = require('../../../peer/projectChat');
		const data = await readRoom(ctx.folderUri, active.room, active.id, ctx.rec, ctx.me.peerId);
		await this.panel.webview.postMessage({
			type: 'chatRoom',
			room: active.room,
			id: active.id,
			messages: data.messages || []
		});
	}

	async loadChatOverview(message) {
		const ctx = await this._chatContext(message);
		if (!ctx || !ctx.rec || !ctx.rec.shared) return;
		await this._postChatOverview(ctx);
	}

	async openChatRoom(message) {
		const ctx = await this._chatContext(message);
		if (!ctx || !ctx.rec || !ctx.rec.shared) return;
		const room = String(message.room || 'project');
		const id = String(message.id || '');
		if (room === 'mentions') {
			const { markMentionsRead } = require('../../../peer/projectChat');
			await markMentionsRead(ctx.folderUri, ctx.rec, ctx.me.peerId);
			await this._postChatOverview(ctx);
			return;
		}
		const { readRoom, markRead } = require('../../../peer/projectChat');
		this._activeChatRoom = { room, id };
		const data = await readRoom(ctx.folderUri, room, id, ctx.rec, ctx.me.peerId);
		const mr = await markRead(ctx.folderUri, room, id);
		if (mr.advanced) {
			try {
				const { recordLocalOperation, OP_TYPES } = require('../../../peer/projectRecord');
				await recordLocalOperation(ctx.kbRoot, ctx.prefix, OP_TYPES.CHAT_READ, { room, id, upTo: mr.upTo });
			} catch (err) {
				console.error('[DRIP] record chat read', err);
			}
		}
		await this.panel.webview.postMessage({
			type: 'chatRoom',
			room,
			id,
			messages: data.messages || []
		});
		await this._postChatOverview(ctx);
	}

	async sendChat(message) {
		const ctx = await this._chatContext(message);
		if (!ctx || !ctx.rec || !ctx.rec.shared) return;
		if (ctx.rec.shared) {
			const { hasCap, CAPS } = require('../../../peer/projectRoles');
			if (!hasCap(ctx.rec, ctx.me.peerId, CAPS.CHAT_WRITE)) {
				void vscode.window.showWarningMessage('Your role cannot talk on this project.');
				return;
			}
		}
		const room = String(message.room || 'project');
		const id = String(message.id || '');
		const { appendMessage, appendIssueMessage } = require('../../../peer/projectChat');
		let data;
		if (room === 'issue') {
			// Issue chat supports `@team-name` mentions, which fan out to team talk.
			const sent = await appendIssueMessage(ctx.folderUri, ctx.rec, id, String(message.text || ''), ctx.me, String(message.issueKey || ''));
			data = sent.issueData;
			try {
				const { recordLocalOperation, OP_TYPES } = require('../../../peer/projectRecord');
				const last = (data.messages || [])[data.messages.length - 1];
				if (last) {
					await recordLocalOperation(ctx.kbRoot, ctx.prefix, OP_TYPES.CHAT_APPEND, { room, id, message: last });
				}
				for (const f of sent.fanout) {
					if (f && f.message) {
						await recordLocalOperation(ctx.kbRoot, ctx.prefix, OP_TYPES.CHAT_APPEND, {
							room: 'team',
							id: f.teamId,
							message: f.message,
							grants: f.grants,
							participants: f.participants
						});
					}
				}
			} catch (err) {
				console.error('[DRIP] record issue chat', err);
			}
		} else {
			const res = await appendMessage(ctx.folderUri, ctx.rec, room, id, String(message.text || ''), ctx.me);
			data = res.data;
			try {
				if (res.message) {
					const { recordLocalOperation, OP_TYPES } = require('../../../peer/projectRecord');
					await recordLocalOperation(ctx.kbRoot, ctx.prefix, OP_TYPES.CHAT_APPEND, {
						room,
						id,
						message: res.message,
						grants: res.grants,
						participants: res.participants
					});
				}
			} catch (err) {
				console.error('[DRIP] record chat', err);
			}
		}
		// Re-read the room so the response carries decrypted text plus read state
		// (blue ticks) for the newly appended message.
		const fresh = await require('../../../peer/projectChat').readRoom(ctx.folderUri, room, id, ctx.rec, ctx.me.peerId);
		await this.panel.webview.postMessage({
			type: 'chatRoom',
			room,
			id,
			messages: fresh.messages || []
		});
		await this._postChatOverview(ctx);
	}

	async clearChat(message) {
		const ctx = await this._chatContext(message);
		if (!ctx || !ctx.rec || !ctx.rec.shared) return;
		if (ctx.rec.shared) {
			const { hasCap, CAPS } = require('../../../peer/projectRoles');
			if (!hasCap(ctx.rec, ctx.me.peerId, CAPS.CHAT_WRITE)) {
				void vscode.window.showWarningMessage('Your role cannot clear talk.');
				return;
			}
		}
		const room = String(message.room || 'project');
		const id = String(message.id || '');
		const { clearRoom } = require('../../../peer/projectChat');
		const data = await clearRoom(ctx.folderUri, room, id);
		try {
			const { recordLocalOperation, OP_TYPES } = require('../../../peer/projectRecord');
			await recordLocalOperation(ctx.kbRoot, ctx.prefix, OP_TYPES.CHAT_CLEAR, { room, id });
		} catch (err) {
			console.error('[DRIP] record chat clear', err);
		}
		await this.panel.webview.postMessage({
			type: 'chatRoom',
			room,
			id,
			messages: data.messages || []
		});
		await this._postChatOverview(ctx);
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

/**
 * Refresh only the chat overview (badges, mentions, DM/issue lists) without
 * reloading the whole project or closing the open chat modal. Called after a
 * chat operation arrives from another member.
 * @param {string} folderPrefix
 */
function refreshProjectChatIfShown(folderPrefix) {
	const panel = DripProjectViewPanel.currentPanel;
	if (!panel) return;
	const sel = String(panel._selectedPrefix || '');
	if (!sel || sel !== String(folderPrefix || '')) return;
	void (async () => {
		try {
			await panel.refreshChatOverview();
			await panel.refreshOpenChatRoom();
		} catch {
			/* chat refresh is best-effort */
		}
	})();
}

module.exports = {
	DripProjectViewPanel,
	getProjectViewHtml,
	refreshProjectViewIfShown,
	refreshProjectChatIfShown
};
