'use strict';

// Composer panel + RHS Storage webview provider: the capture-to-ingest workflow.
// Both surfaces share one in-memory "working note" state (lastComposerNote /
// lastComposerCapture / lastStorageSelection) and post to each other via the
// Storage webview. Tag-graph message routing is delegated to ./tags/panel.

const path = require('path');
const vscode = require('vscode');
const {
	DRIP_PANEL_ID,
	DRIP_SELECT_KB_COMMAND_ID
} = require('../shared/constants');
const { getComposerHtml } = require('./composer/composerHtml');
const { getStorageWebviewHtml } = require('./rhs/storage/storageHtml');
const { createEmptyDraft, combineComposerSections } = require('../state/state');
const { draftToTxtMetadata, parseDripTxtMetadata, cleanTitleFromDripTxt } = require('../capture/noteDraft.js');
const { getMetadataSettings } = require('../document/model/dripNoteMetadataTemplates.js');
const { kbRootFor, listTagsForNote, createTagForNote } = require('../graph/noteTagScope');
const { DripRetrieverPanel } = require('./lhs/retriever/panel');
const {
	DripTagsPanel,
	handleTagGraphMessage,
	registerTagGraphWebview,
	unregisterTagGraphWebview
} = require('./tags/panel');

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

/**
 * Metadata schema sent to the Composer so it can render metadata as chips
 * (type chip + attribute/relation chips with pickers).
 */
function composerMetadataSchema() {
	const s = getMetadataSettings();
	// The Composer is knowledge-base-only (never projects), so the project-scoped
	// heading types (issue / decision) are not offered here — only concept and task.
	const KB_TYPE_IDS = new Set(['concept', 'task']);
	return {
		types: (s.types || [])
			.filter(t => KB_TYPE_IDS.has(String(t.id).toLowerCase()))
			.map(t => ({
				id: t.id,
				marker: t.marker,
				shortcut: t.shortcut,
				color: t.color || '',
				attributes: Object.entries(t.attributes || {}).map(([key, rule]) => ({
					key,
					kind: rule && rule.kind ? rule.kind : 'enum',
					values: Array.isArray(rule && rule.values) ? rule.values : [],
					default: (rule && rule.default) || '',
					label: (rule && rule.label) || ''
				}))
			})),
		allowedRelations: Array.from(s.allowedRelations || [])
	};
}

function postKbNoteSettingsToStorage() {
	const nt = require('../document/model/dripNoteFileTypes.js');
	postToStorage({
		type: 'kbNoteSettings',
		knowledgeBaseFileExtensions: nt.getKbNoteExtensions(),
		defaultNewNoteExtension: nt.getDefaultNewNoteExtension()
	});
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
			typeId: draft.typeId || '',
			fields: Array.isArray(draft.fields) ? draft.fields : [],
			metadata: draft.metadata || '',
			content: draft.content || '',
			metadataFilename: draft.metadataFilename || ''
		};
		postToStorage({
			type: 'composerNote',
			note: lastComposerNote
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
			typeId: empty.typeId || '',
			fields: Array.isArray(empty.fields) ? empty.fields : [],
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
						const fileUri = await this.state.createNoteInFolderFromPicker(message.folderUri, message.title, message.fileExtension);
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
				note: { title: note.title || '', content: combineComposerSections(note.metadata, note.content) },
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
					case 'noteSnapshot': {
						const typeId = message.note?.typeId != null ? String(message.note.typeId) : '';
						const fields = Array.isArray(message.note?.fields) ? message.note.fields : [];
						lastComposerNote = {
							id: message.note?.id || '',
							title: message.note?.title || '',
							headings: message.note?.headings || '',
							typeId,
							fields,
							metadata: draftToTxtMetadata(typeId, fields),
							content: message.note?.content || '',
							metadataFilename: message.note?.metadataFilename || '',
							sourceFormat: message.note?.sourceFormat || ''
						};
						postToStorage({
							type: 'composerNote',
							note: lastComposerNote
						});
						break;
					}
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
					case 'tags-list':
						// The Composer is KB-only, so its tags come from the KB tag graphs
						// (the "individual tags" graph plus every other KB graph), never
						// a per-project graph. An empty path keeps the note out of any
						// project folder, so listTagsForNote resolves to all KB tags.
						{
							const tags = await listTagsForNote(this.state.context, '');
							await this.panel.webview.postMessage({ type: 'tags-list', tags });
						}
						break;
					case 'create-tag':
						{
							const name = String(message.tag || '').trim();
							if (name) {
								const tags = await createTagForNote(this.state.context, '', name);
								await this.panel.webview.postMessage({ type: 'tags-list', tags });
							}
						}
						break;
					case 'tags-search':
						{
							// Semantic tag matches for the search box, from the KB tag
							// embeddings (the same source the `.d.md` dropdown uses).
							const query = String(message.query || '').trim();
							const kbRoot = kbRootFor(this.state.context);
							let semantic = [];
							if (query && kbRoot) {
								try {
									const { suggestTagsHybrid } = require('../indexing/embeddings/tagEmbeddingSearch');
									const res = await suggestTagsHybrid(kbRoot, query, { semanticLimit: 3 });
									semantic = Array.isArray(res.semantic) ? res.semantic : [];
								} catch (err) {
									console.warn('[DRIP] composer tag semantic search failed', err && err.message);
								}
							}
							await this.panel.webview.postMessage({ type: 'tags-search', query, semantic });
						}
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
		const title = capture.title != null ? String(capture.title) : '';
		const typeId = capture.typeId != null ? String(capture.typeId) : '';
		const fields = Array.isArray(capture.fields) ? capture.fields : [];
		const content = capture.content != null ? String(capture.content) : '';
		const multipleRoots = !!capture.multipleRoots;
		const sourceFormat = capture.sourceFormat != null ? String(capture.sourceFormat) : '';
		lastComposerCapture = { title, typeId, fields, content, multipleRoots, sourceFormat };
		const ingestTitle = (() => {
			const m = String(title || '').trim().match(/^#{1,6}\s+(.*)$/);
			return m ? String(m[1] || '').trim() : String(title || '').trim();
		})();
		const metadata = draftToTxtMetadata(typeId, fields);
		// Capture always starts a new unsaved draft — do not keep the previous draft id
		// or Save Draft would overwrite the earlier draft (same title is common).
		lastComposerNote = {
			id: '',
			title: ingestTitle,
			headings: ingestTitle,
			typeId,
			fields,
			metadata,
			content,
			metadataFilename: ingestTitle,
			sourceFormat
		};
		postToStorage({
			type: 'composerNote',
			note: lastComposerNote
		});
		await this.panel.webview.postMessage({
			type: 'capturedSelection',
			title,
			typeId,
			fields,
			content,
			multipleRoots,
			sourceFormat
		});
		if (multipleRoots) {
			void vscode.window.showInformationMessage(
				'The selection contains multiple top-level headings, so it was kept as a draft instead of one note.'
			);
		}
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
				typeId: lastComposerNote.typeId || '',
				fields: lastComposerNote.fields || [],
				metadata: lastComposerNote.metadata || '',
				content: lastComposerNote.content || '',
				metadataFilename: lastComposerNote.metadataFilename || '',
				sourceFormat: lastComposerNote.sourceFormat || '',
				status: 'draft'
			};
		}
		if (!draft) {
			draft = createEmptyDraft();
		}

		// Migrate older drafts that stored only the metadata string (no structured fields).
		if (draft && (draft.metadata || '') && !draft.typeId && !(draft.fields && draft.fields.length)) {
			const parsed = parseDripTxtMetadata(draft.metadata);
			if (parsed.typeId || parsed.fields.length) {
				const clean = cleanTitleFromDripTxt(draft.title);
				draft = {
					...draft,
					typeId: parsed.typeId,
					fields: parsed.fields,
					title: clean || draft.title || ''
				};
			}
		}

		lastComposerNote = {
			id: draft.id || '',
			title: draft.title || '',
			headings: draft.headings || '',
			typeId: draft.typeId || '',
			fields: Array.isArray(draft.fields) ? draft.fields : [],
			metadata: draft.metadata || '',
			content: draft.content || '',
			metadataFilename: draft.metadataFilename || '',
			sourceFormat: draft.sourceFormat || ''
		};

		await this.panel.webview.postMessage({
			type: 'composerState',
			state: {
				kbRootPath: sidebarState.kbRootPath,
				draft,
				statusMessage: statusMessage || '',
				clearStorageSuggestions: options.clearStorageSuggestions === true,
				capture: lastComposerCapture,
				metadataSchema: composerMetadataSchema()
			}
		});

		postToStorage({
			type: 'composerNote',
			note: lastComposerNote
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

module.exports = {
	DripComposerPanel,
	DripStorageWebviewProvider,
	postKbNoteSettingsToStorage,
	revealDripStorageView,
	beginIssueMove
};
