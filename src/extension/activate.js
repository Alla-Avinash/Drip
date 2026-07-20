'use strict';

const vscode = require('vscode');
const {
	DRIP_COMMAND_ID,
	DRIP_CAPTURE_SELECTION_COMMAND_ID,
	DRIP_SELECT_KB_COMMAND_ID,
	DRIP_OPEN_KB_EDITOR_COMMAND_ID,
	DRIP_COMPONENTS_VIEW_ID,
	DRIP_KB_VIEW_ID,
	DRIP_DRAFTS_VIEW_ID,
	DRIP_RECENTS_VIEW_ID,
	DRIP_OPEN_RECENT_FILE_COMMAND_ID
} = require('../shared/constants');
const { DripState } = require('../state/state');
const { DripTreeDataProvider } = require('../views/lhs/knowledgebase/tree');
const {
	DripComposerPanel,
	DripTagsPanel,
	DripStorageWebviewProvider,
	DRIP_STORAGE_VIEW_ID,
	postKbNoteSettingsToStorage,
	postTagGraphStateToAll,
	revealDripStorageView
} = require('../views/views');
const { getSettingsWebviewHtml } = require('../views/settingsWebview');
const { registerNoteImagePasteAndDrop } = require('../views/editor/noteImagePaste');
const { registerDripnoteReferenceAssist } = require('../graph/dripnoteReferenceAssist');
const { registerNoteDocumentLinks } = require('../graph/noteDocumentLinks');
const { registerDripnoteReferenceDefinitions } = require('../graph/dripnoteReferenceDefinitions');
const { registerDripnoteLinkDropInsert } = require('../graph/dripnoteLinkDropInsert');
const { registerDripnoteDocumentSymbols } = require('../views/editor/dripnoteDocumentSymbols');
const { runEmbeddingBenchmark } = require('../retrieval/embeddings');
const { splitSelectionForCapture } = require('../views/capturePreprocess');
const { createKbTreeDragDropController } = require('../views/lhs/knowledgebase/kbTreeDragDrop');
const { registerDripSidebarViewBehavior } = require('../views/lhs/knowledgebase/dripSidebarViews');
const { showKbNewMenu } = require('../views/lhs/knowledgebase/kbCreateMenu');
const { invalidateKbNoteExtensionsCache } = require('../document/model/noteFileTypes');
const { initializeMultiGraphStorage } = require('../graph/tagGraphStore');
const {
	saveSettingsToDripIndex,
	importSettingsToKnowledgeBase,
	exportSettingsFromKnowledgeBase
} = require('../startup/settingsDrip');
const { getSettingsDripFileUri } = require('../startup/initializeDripIndex');
const { registerDripnoteTagCompletion } = require('../views/editor/dripnoteTagCompletion');
const { registerDripnoteSemanticTokens } = require('../views/editor/dripnoteSemanticTokens');
const { registerDripnoteMetadataDiagnostics } = require('../document/validate/dripnoteMetadataDiagnosticsTemplates');
const { registerDripnoteMetadataCompletion } = require('../views/editor/dripnoteMetadataCompletion');
const { registerDripnoteCustomDecorations } = require('../views/editor/dripnoteCustomDecorations');
const { registerDripnoteHeadingIdentityDisplay } = require('../views/editor/dripnoteHeadingIdentityDisplay');
const { registerDripnoteIndexSync } = require('../indexing/dripnoteIndexSync');
const { registerStartupCheck, resetStartupCheckCache, runStartupCheck } = require('../startup/startupCheck');
const { registerDripCanvasPanel } = require('../views/lhs/canvas/panel');
const {
	DripRetrieverPanel,
	registerRetrieverAutoRefresh,
	refreshRetrieverCatalogIfShown,
	scheduleRetrieverCatalogRebuildIfShown
} = require('../views/lhs/retriever/panel');
const { runRetrieverHeadingQuickOpen } = require('../retrieval/retrieverQuickOpen');
const { updateKnowledgeBase } = require('../startup/updateKnowledgeBase');
const { openKbEditorNote } = require('../startup/kbEditorNote');
const { getDefaultKnowledgeBaseSettingsObject } = require('../startup/defaultKnowledgeBaseSettings');

/**
 * @param {import('vscode').Webview} webview
 * @param {import('./state/state').DripState} dripState
 */
async function postDripSettingsValuesToWebview(webview, dripState) {
	const c = vscode.workspace.getConfiguration('drip');
	const nt = require('../document/model/noteFileTypes');
	const kbRoot = dripState.getKnowledgeBaseRoot();
	const defs = getDefaultKnowledgeBaseSettingsObject();
	await webview.postMessage({
		type: 'settingsValues',
		autoOpenComposerOnSidebarReveal: c.get('autoOpenComposerOnSidebarReveal', defs.autoOpenComposerOnSidebarReveal),
		knowledgeBaseFileExtensions: nt.getKbNoteExtensions(),
		defaultNewNoteExtension: nt.getDefaultNewNoteExtension(),
		customTypeMarkers: c.get('dripnoteCustomTypeMarkers', defs.dripnoteCustomTypeMarkers),
		customColors: c.get('dripnoteCustomColors', defs.dripnoteCustomColors),
		metadataTemplatesEnabled: c.get('metadataTemplatesEnabled', defs.metadataTemplatesEnabled),
		metadataStrictValidation: c.get('metadataStrictValidation', defs.metadataStrictValidation),
		metadataIgnoreErrors: c.get('metadataIgnoreErrors', defs.metadataIgnoreErrors),
		metadataAutoInsertTemplate: c.get('metadataAutoInsertTemplate', defs.metadataAutoInsertTemplate),
		metadataShowIndentErrors: c.get('metadataShowIndentErrors', defs.metadataShowIndentErrors),
		showHeadingHierarchyIndentErrors: c.get('showHeadingHierarchyIndentErrors', defs.showHeadingHierarchyIndentErrors),
		metadataUseCustomColors: c.get('metadataUseCustomColors', defs.metadataUseCustomColors),
		metadataTypes: c.get('metadataTypes', defs.metadataTypes),
		metadataTypeColors: c.get('metadataTypeColors', defs.metadataTypeColors),
		metadataKeyColor: c.get('metadataKeyColor', defs.metadataKeyColor),
		metadataValueColor: c.get('metadataValueColor', defs.metadataValueColor),
		tagsRelationsConfig: c.get('tagsRelationsConfig', defs.tagsRelationsConfig),
		refLinksConfig: c.get('refLinksConfig', defs.refLinksConfig),
		dripMetadataMarks: c.get('dripMetadataMarks', defs.dripMetadataMarks),
		experimentalEmbeddings: c.get('experimentalEmbeddings', defs.experimentalEmbeddings),
		embeddingModel: c.get('embeddingModel', defs.embeddingModel),
		kbSettingsFilePath: kbRoot ? getSettingsDripFileUri(kbRoot).fsPath : ''
	});
}

async function activate(context) {
	await initializeMultiGraphStorage(context);
	registerDripnoteTagCompletion(context);
	registerDripnoteSemanticTokens(context);
	registerDripnoteMetadataDiagnostics(context);
	registerDripnoteMetadataCompletion(context);
	registerDripnoteCustomDecorations(context);
	registerDripnoteHeadingIdentityDisplay(context);
	registerDripCanvasPanel(context);
	const state = new DripState(context);
	registerDripnoteIndexSync(context, state);
	registerStartupCheck(context, state);
	registerRetrieverAutoRefresh(context, state);
	state.syncTagGraphCheckpointFromStorage();
	const componentsTreeProvider = new DripTreeDataProvider(state, 'components');
	const kbTreeProvider = new DripTreeDataProvider(state, 'knowledge');
	const draftsTreeProvider = new DripTreeDataProvider(state, 'drafts');
	const recentsTreeProvider = new DripTreeDataProvider(state, 'recents');
	const sidebarRefreshHub = {
		refresh() {
			componentsTreeProvider.refresh();
			kbTreeProvider.refresh();
			draftsTreeProvider.refresh();
			recentsTreeProvider.refresh();
		}
	};
	state.setDraftsRefreshListener(() => sidebarRefreshHub.refresh());
	state.setRecentsRefreshListener(() => recentsTreeProvider.refresh());
	let hasAutoOpenedComposer = false;
	let kbWatcher;
	/** @type {import('vscode').WebviewPanel | null} */
	let settingsPanel = null;

	function refreshUi() {
		sidebarRefreshHub.refresh();
		DripComposerPanel.postState();
	}

	const kbDragDropController = createKbTreeDragDropController(state, refreshUi);
	const componentsTreeView = vscode.window.createTreeView(DRIP_COMPONENTS_VIEW_ID, {
		treeDataProvider: componentsTreeProvider
	});
	const kbTreeView = vscode.window.createTreeView(DRIP_KB_VIEW_ID, {
		treeDataProvider: kbTreeProvider,
		showCollapseAll: true,
		canSelectMany: true,
		dragAndDropController: kbDragDropController
	});
	const draftsTreeView = vscode.window.createTreeView(DRIP_DRAFTS_VIEW_ID, {
		treeDataProvider: draftsTreeProvider
	});
	const recentsTreeView = vscode.window.createTreeView(DRIP_RECENTS_VIEW_ID, {
		treeDataProvider: recentsTreeProvider
	});

	context.subscriptions.push(componentsTreeView, kbTreeView, draftsTreeView, recentsTreeView);
	registerDripSidebarViewBehavior(kbTreeView, componentsTreeView, context);

	function isDripnoteDocument(doc) {
		if (!doc || doc.uri.scheme === 'untitled') return false;
		if (doc.languageId === 'dripnote') return true;
		const p = String(doc.uri.fsPath || doc.uri.path || '').toLowerCase();
		return p.endsWith('.d.txt');
	}

	async function trackRecentFromDocument(doc) {
		if (!isDripnoteDocument(doc)) return;
		try {
			await state.touchRecentFile(doc.uri);
		} catch {
			/* ignore */
		}
	}

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor && editor.document) {
				void trackRecentFromDocument(editor.document);
			}
		}),
		vscode.workspace.onDidSaveTextDocument(doc => {
			void trackRecentFromDocument(doc);
		})
	);
	if (vscode.window.activeTextEditor) {
		void trackRecentFromDocument(vscode.window.activeTextEditor.document);
	}

	function ensureKnowledgeBaseWatcher() {
		kbWatcher?.dispose();
		kbWatcher = undefined;

		const kbRoot =
			state.getKnowledgeBaseRoot() ||
			(typeof state.getRetrieverKnowledgeBaseRoot === 'function'
				? state.getRetrieverKnowledgeBaseRoot().uri
				: undefined);
		if (!kbRoot) {
			return;
		}

		kbWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(kbRoot, '**/*'));
		kbWatcher.onDidCreate(refreshUi);
		kbWatcher.onDidChange(refreshUi);
		kbWatcher.onDidDelete(refreshUi);
		context.subscriptions.push(kbWatcher);
	}

	registerNoteImagePasteAndDrop(context);
	registerDripnoteReferenceAssist(context, state);
	registerNoteDocumentLinks(context);
	registerDripnoteReferenceDefinitions(context, state);
	registerDripnoteLinkDropInsert(context);
	registerDripnoteDocumentSymbols(context);

	function wireSettingsWebviewMessageHandler(webview) {
		webview.onDidReceiveMessage(async message => {
			try {
				switch (message.type) {
					case 'requestSettings':
						await postDripSettingsValuesToWebview(webview, state);
						break;
					case 'updateSetting':
						{
							const kbRoot = state.getKnowledgeBaseRoot();
							const target = kbRoot
								? vscode.ConfigurationTarget.Workspace
								: vscode.ConfigurationTarget.Global;
							await vscode.workspace
								.getConfiguration('drip')
								.update(message.key, message.value, target);
							if (kbRoot) {
								await saveSettingsToDripIndex(kbRoot);
								invalidateKbNoteExtensionsCache();
							}
						}
						break;
					case 'importKbSettings': {
						const kbRoot = state.getKnowledgeBaseRoot();
						if (!kbRoot) {
							void vscode.window.showWarningMessage(
								'Select a DRIP knowledge base folder before importing settings.'
							);
							break;
						}
						const result = await importSettingsToKnowledgeBase(kbRoot);
						if (result.ok) {
							invalidateKbNoteExtensionsCache();
							await postDripSettingsValuesToWebview(webview, state);
						}
						break;
					}
					case 'exportKbSettings': {
						const kbRoot = state.getKnowledgeBaseRoot();
						if (!kbRoot) {
							void vscode.window.showWarningMessage(
								'Select a DRIP knowledge base folder before exporting settings.'
							);
							break;
						}
						await exportSettingsFromKnowledgeBase(kbRoot);
						break;
					}
					case 'openKeyboardShortcuts':
						await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings');
						break;
					case 'selectKnowledgeBase':
						await vscode.commands.executeCommand('drip.selectKnowledgeBase');
						break;
					case 'openDripUserSettings':
						await vscode.commands.executeCommand('workbench.action.openSettings', 'drip');
						break;
					case 'runEmbeddingBenchmark':
						await vscode.commands.executeCommand('drip.testEmbeddings');
						break;
				}
			} catch (error) {
				console.error(error);
			}
		});
	}

	function createOrShowSettingsPanel() {
		const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;
		if (settingsPanel) {
			settingsPanel.reveal(column, false);
			return settingsPanel;
		}
		settingsPanel = vscode.window.createWebviewPanel(
			'drip.settings.editor',
			'DRIP Settings',
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true
			}
		);
		settingsPanel.webview.html = getSettingsWebviewHtml(settingsPanel.webview);
		wireSettingsWebviewMessageHandler(settingsPanel.webview);
		settingsPanel.onDidDispose(() => {
			settingsPanel = null;
		});
		return settingsPanel;
	}


	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			DRIP_STORAGE_VIEW_ID,
			new DripStorageWebviewProvider(context.extensionUri, state, sidebarRefreshHub)
		)
	);

	context.subscriptions.push(
		kbTreeView,
		draftsTreeView,
		vscode.commands.registerCommand('drip.openTagsPanel', async () => {
			DripTagsPanel.createOrShow(context.extensionUri, state);
		}),
		vscode.commands.registerCommand('drip.openRetriever', async opts => {
			const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : undefined;
			DripRetrieverPanel.createOrShow(context.extensionUri, state, o);
		}),
		vscode.commands.registerCommand('drip.retrieverQuickOpen', async () => {
			await runRetrieverHeadingQuickOpen(state);
		}),
		vscode.commands.registerCommand(DRIP_COMMAND_ID, async draftId => {
			await DripComposerPanel.createOrShow(context.extensionUri, state, sidebarRefreshHub, draftId);
		}),
		vscode.commands.registerCommand(DRIP_OPEN_RECENT_FILE_COMMAND_ID, async uriOrString => {
			try {
				const uri =
					uriOrString instanceof vscode.Uri
						? uriOrString
						: vscode.Uri.parse(String(uriOrString || '').trim());
				if (!uri || !String(uri.toString() || '').trim()) return;
				const doc = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(doc, { preview: false });
				await state.touchRecentFile(uri);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				void vscode.window.showErrorMessage(`DRIP could not open recent file: ${msg}`);
			}
		}),
		vscode.commands.registerCommand(DRIP_OPEN_KB_EDITOR_COMMAND_ID, async () => {
			try {
				await openKbEditorNote(context, state);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				void vscode.window.showErrorMessage(`DRIP could not open the KB editor: ${msg}`);
			}
		}),
		vscode.commands.registerCommand(DRIP_CAPTURE_SELECTION_COMMAND_ID, async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showInformationMessage('Open a file and select text to capture into the composer.');
				return;
			}
			const text = editor.document.getText(editor.selection);
			if (!text.trim()) {
				vscode.window.showInformationMessage('Select some text in the editor first.');
				return;
			}
			const capture = splitSelectionForCapture(text);
			await DripComposerPanel.createOrShow(context.extensionUri, state, sidebarRefreshHub, undefined, capture);
		}),
		vscode.commands.registerCommand('drip.openDripSettingsView', async () => {
			createOrShowSettingsPanel();
		}),
		vscode.commands.registerCommand('drip.showKbNewMenu', async item => {
			const uri =
				item?.uri && typeof item.uri === 'string'
					? vscode.Uri.parse(item.uri)
					: item?.uri;
			const folderUri =
				uri && item?.kind === 'folder'
					? uri
					: kbTreeView.selection?.[0]?.kind === 'folder'
						? kbTreeView.selection[0].uri
						: undefined;
			await showKbNewMenu(folderUri);
			refreshUi();
		}),
		vscode.commands.registerCommand(DRIP_SELECT_KB_COMMAND_ID, async () => {
			const pickedKb = await state.pickKnowledgeBaseFolder();
			resetStartupCheckCache();
			await runStartupCheck(context, state);
			ensureKnowledgeBaseWatcher();
			refreshUi();
			if (pickedKb) {
				state.syncTagGraphCheckpointFromStorage();
				await postTagGraphStateToAll(state);
				await state.refreshDraftsFromStorage();
				await state.refreshRecentsFromStorage();
				refreshRetrieverCatalogIfShown();
				if (settingsPanel) {
					await postDripSettingsValuesToWebview(settingsPanel.webview, state);
				}
			}
		}),
		vscode.commands.registerCommand('drip.createNoteFile', async item => {
			try {
				await state.createNoteFile(item?.uri);
				refreshUi();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				void vscode.window.showErrorMessage(msg);
			}
		}),
		vscode.commands.registerCommand('drip.createMarkdownFile', async item => {
			try {
				await state.createMarkdownFile(item?.uri);
				refreshUi();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				void vscode.window.showErrorMessage(msg);
			}
		}),
		vscode.commands.registerCommand('drip.createFolder', async item => {
			try {
				await state.createFolder(item?.uri);
				refreshUi();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				void vscode.window.showErrorMessage(msg);
			}
		}),
		vscode.commands.registerCommand('drip.createDripIgnore', async item => {
			await state.ensureDripIgnoreFile(item?.uri);
			refreshUi();
		}),
		vscode.commands.registerCommand('drip.ignorePath', async item => {
			await state.addIgnoreEntry(item);
			refreshUi();
		}),
		vscode.commands.registerCommand('drip.refreshTree', async () => {
			refreshUi();
		}),
		vscode.commands.registerCommand('drip.copyPath', async item => {
			await state.copyPath(item);
		}),
		vscode.commands.registerCommand('drip.renameItem', async item => {
			await state.renameItem(item);
			refreshUi();
		}),
		vscode.commands.registerCommand('drip.deleteItem', async item => {
			await state.deleteItem(item);
			refreshUi();
		}),
		vscode.commands.registerCommand('drip.createIndexHere', async () => {
			const kbRoot = await state.ensureKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a knowledge base folder first.');
				return;
			}
			await updateKnowledgeBase(context, kbRoot, { force: true });
			refreshUi();
		}),
		vscode.commands.registerCommand('drip.removeIndexHere', async () => {
			void vscode.window.showInformationMessage(
				'Per-folder _index files are no longer used. Use "Update index" on the Knowledge Base toolbar to rebuild index.drip.'
			);
		}),
		vscode.commands.registerCommand('drip.testEmbeddings', async () => {
			const ch = vscode.window.createOutputChannel('DRIP Embeddings');
			ch.show();
			ch.appendLine('DRIP embedding benchmark (Transformers.js + ONNX Runtime in the extension host)');
			ch.appendLine('');
			try {
				await runEmbeddingBenchmark(line => ch.appendLine(line));
				void vscode.window.showInformationMessage(
					'DRIP: Embedding benchmark finished. See Output → DRIP Embeddings.'
				);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				ch.appendLine(msg);
				if (error instanceof Error && error.stack) {
					ch.appendLine(error.stack);
				}
				void vscode.window.showErrorMessage(`DRIP embedding benchmark failed: ${msg}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('drip')) {
				invalidateKbNoteExtensionsCache();
				refreshUi();
				postKbNoteSettingsToStorage();
				const retrieverStale =
					e.affectsConfiguration('drip.knowledgeBaseFileExtensions') ||
					e.affectsConfiguration('drip.metadataTypes') ||
					e.affectsConfiguration('drip.metadataTemplatesEnabled') ||
					e.affectsConfiguration('drip.dripnoteCustomTypeMarkers');
				if (retrieverStale) {
					scheduleRetrieverCatalogRebuildIfShown();
				}
			}
		})
	);

	context.subscriptions.push(
		kbTreeView.onDidChangeVisibility(() => {
			const cfg = vscode.workspace.getConfiguration('drip');
			if (!cfg.get('autoOpenComposerOnSidebarReveal', true)) {
				return;
			}
			if (!hasAutoOpenedComposer && kbTreeView.visible) {
				hasAutoOpenedComposer = true;
				void vscode.commands.executeCommand(DRIP_COMMAND_ID);
			}
		})
	);

	ensureKnowledgeBaseWatcher();
}

module.exports = { activate };
