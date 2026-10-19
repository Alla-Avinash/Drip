'use strict';

const vscode = require('vscode');
const {
	DRIP_COMMAND_ID,
	DRIP_CAPTURE_SELECTION_COMMAND_ID,
	DRIP_FOCUS_CHAT_COMMAND_ID,
	DRIP_ADD_SELECTION_TO_CHAT_COMMAND_ID,
	DRIP_SELECT_KB_COMMAND_ID,
	DRIP_OPEN_KB_EDITOR_COMMAND_ID,
	DRIP_COMPONENTS_VIEW_ID,
	DRIP_KB_VIEW_ID,
	DRIP_DRAFTS_VIEW_ID,
	DRIP_RECENTS_VIEW_ID,
	DRIP_OPEN_RECENT_FILE_COMMAND_ID,
	DRIP_DAILY_NOTES_VIEW_ID,
	DRIP_OPEN_TODAY_DAILY_NOTE_COMMAND_ID,
	DRIP_CHAT_VIEW_ID
} = require('../shared/constants');
const {
	ensureTodayDailyNote,
	isDailyNoteUri,
	isDailyNoteUnchangedFromCreate
} = require('../startup/dailyNotesDrip');
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
const {
	DripHeadingFormWebviewProvider,
	DRIP_HEADING_FORM_VIEW_ID,
	registerHeadingFormAutoFlush,
	setHeadingFormExtensionContext
} = require('../views/rhs/headingForm/panel');
const { setHeadingFormKbRootGetter } = require('../views/rhs/headingForm/headingFormKb');
const { registerPersistentHeadingSoftLock } = require('../views/editor/persistentHeadingSoftLock');
const { registerDripProjectFolderWatch } = require('../startup/dripProjectFolder');
const { registerDripFeatureFolderWatch } = require('../startup/dripFeatureFolder');
const { getSettingsWebviewHtml } = require('../views/settingsWebview');
const { registerNoteImagePasteAndDrop } = require('../views/editor/noteImagePaste');
const { registerDripnoteReferenceAssist } = require('../graph/dripnoteReferenceAssist');
const { registerNoteDocumentLinks } = require('../graph/noteDocumentLinks');
const { registerDripnoteReferenceDefinitions } = require('../graph/dripnoteReferenceDefinitions');
const { registerDripnoteLinkDropInsert } = require('../graph/dripnoteLinkDropInsert');
const { registerDripnoteDocumentSymbols } = require('../views/editor/dripnoteDocumentSymbols');
const { runEmbeddingBenchmark } = require('../retrieval/embeddings');
const { parseSelectionForComposer } = require('../views/capturePreprocess');
const { createKbTreeDragDropController } = require('../views/lhs/knowledgebase/kbTreeDragDrop');
const { registerDripSidebarViewBehavior } = require('../views/lhs/knowledgebase/dripSidebarViews');
const { showKbNewMenu } = require('../views/lhs/knowledgebase/kbCreateMenu');

/**
 * Resolve a folder/file Uri from a tree item, Uri, or `{ uri: string|Uri }` (quick-pick New menu).
 * @param {unknown} item
 * @returns {import('vscode').Uri | undefined}
 */
function uriFromCommandArg(item) {
	if (!item) return undefined;
	if (item instanceof vscode.Uri) return item;
	if (typeof item === 'string') {
		try {
			return vscode.Uri.parse(item);
		} catch {
			return undefined;
		}
	}
	const u = /** @type {{ uri?: unknown, kind?: string }} */ (item).uri;
	if (!u) return undefined;
	if (u instanceof vscode.Uri) return u;
	if (typeof u === 'string') {
		try {
			return vscode.Uri.parse(u);
		} catch {
			return undefined;
		}
	}
	return undefined;
}
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
const { registerDripMdNoteMetadataValidation } = require('../document/validate/dripMdNoteMetadataValidation');
const { registerDripMdNoteFileHeaderReconcile } = require('../document/validate/dripMdNoteFileHeaderReconcile');
const { registerDripnoteMetadataCompletion } = require('../views/editor/dripnoteMetadataCompletion');
const { registerDripnoteHeadingShorthand } = require('../views/editor/dripnoteHeadingShorthand');
const { registerDripnoteCustomDecorations } = require('../views/editor/dripnoteCustomDecorations');
const { registerDripnoteHeadingIdentityDisplay } = require('../views/editor/dripnoteHeadingIdentityDisplay');
const { DripMdEditorProvider } = require('../views/editor/dripMdEditor/dripMdEditorProvider');
const { registerNoteLifecycle } = require('../indexing/sync/dripnoteLifecycle');
const { registerStartupCheck, resetStartupCheckCache, runStartupCheck } = require('../startup/startupCheck');
const {
	DripRetrieverPanel,
	registerRetrieverAutoRefresh,
	refreshRetrieverCatalogIfShown,
	scheduleRetrieverCatalogRebuildIfShown
} = require('../views/lhs/retriever/panel');
const { DripProjectViewPanel, refreshProjectViewIfShown } = require('../views/lhs/projects/panel');
const { DripChatWebviewProvider } = require('../views/rhs/chat/panel');
const { runRetrieverHeadingQuickOpen } = require('../retrieval/retrieverQuickOpen');
const { updateKnowledgeBase } = require('../startup/updateKnowledgeBase');
const { openKbEditorNote } = require('../startup/kbEditorNote');
const { getDefaultKnowledgeBaseSettingsObject } = require('../startup/defaultKnowledgeBaseSettings');

/**
 * @param {import('vscode').Webview} webview
 * @param {import('../state/state').DripState} dripState
 * @param {import('vscode').ExtensionContext} [extensionContext]
 */
async function postDripSettingsValuesToWebview(webview, dripState, extensionContext) {
	const c = vscode.workspace.getConfiguration('drip');
	const nt = require('../document/model/noteFileTypes');
	const {
		migrateFileLevelMetadataTypesIfNeeded,
		getMetadataSettings,
		getFileLevelMetadataSettings
	} = require('../document/model/dripnoteMetadataTemplates');
	try {
		await migrateFileLevelMetadataTypesIfNeeded();
	} catch {
		/* ignore migration errors */
	}
	const kbRoot = dripState.getKnowledgeBaseRoot();
	const defs = getDefaultKnowledgeBaseSettingsObject();
	const docTypes = getMetadataSettings().types;
	const fileTypes = getFileLevelMetadataSettings().types;
	/** @type {{ folderPrefix: string, title: string }[]} */
	let projects = [];
	/** @type {Record<string, any>} */
	let projectMetadataOverrides = {};
	if (kbRoot) {
		try {
			const { listProjectsFromIndex } = require('../indexing/projectViewQuery');
			projects = (await listProjectsFromIndex(kbRoot)).projects.map(p => ({
				folderPrefix: String(p.folderPrefix || ''),
				title: String(p.title || '')
			}));
		} catch (err) {
			console.error('[DRIP] list projects for settings failed', err);
		}
		projectMetadataOverrides = await require('../document/model/dripnoteProjectMetadata').loadProjectMetadataSettings(kbRoot);
	}
	/** @type {unknown} */
	let githubBackupStatus = null;
	if (kbRoot && extensionContext) {
		try {
			const { getBackupStatus } = require('../startup/githubBackup');
			githubBackupStatus = await getBackupStatus(extensionContext, kbRoot);
		} catch (err) {
			console.error('[DRIP] github backup status failed', err);
		}
	}
	/** @type {unknown} */
	let llmStatus = null;
	if (extensionContext) {
		try {
			llmStatus = await require('../llm/llmSettings').getLlmStatus(extensionContext);
		} catch (err) {
			console.error('[DRIP] llm status failed', err);
		}
	}
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
		metadataTypes: docTypes,
		fileLevelMetadataTypes: fileTypes,
		metadataTypeColors: c.get('metadataTypeColors', defs.metadataTypeColors),
		metadataKeyColor: c.get('metadataKeyColor', defs.metadataKeyColor),
		metadataValueColor: c.get('metadataValueColor', defs.metadataValueColor),
		dripnoteDocColors: c.get('dripnoteDocColors', defs.dripnoteDocColors),
		dripnoteDocThemeColors: require('../views/editor/themeTokenColors').getDocRoleThemeColors(),
		tagsRelationsConfig: c.get('tagsRelationsConfig', defs.tagsRelationsConfig),
		dripMetadataMarks: c.get('dripMetadataMarks', defs.dripMetadataMarks),
		editHeadingsInFile: c.get('editHeadingsInFile', defs.editHeadingsInFile === true),
		editHeadingsViaRhs: c.get('editHeadingsViaRhs', defs.editHeadingsViaRhs !== false),
		kbSettingsFilePath: kbRoot ? getSettingsDripFileUri(kbRoot).fsPath : '',
		projects,
		projectMetadataOverrides,
		githubBackupStatus,
		llmStatus,
		mcpStatus: await require('../integrations/mcp/mcpBridge').getMcpStatus()
	});
}

async function activate(context) {
	const { configureEmbeddingModelCache } = require('../retrieval/embeddings');
	configureEmbeddingModelCache(context.extensionPath);

	// Migrate a legacy single-key LLM install into the profile model once.
	require('../llm/llmSettings').migrateLegacyLlmSettings(context).catch(() => {});

	const { initRhsStorageContexts } = require('../views/rhs/revealStorageOnly');
	await initRhsStorageContexts();

	await initializeMultiGraphStorage(context);
	registerDripnoteTagCompletion(context);
	registerDripnoteSemanticTokens(context);
	registerDripnoteMetadataDiagnostics(context);
	registerDripMdNoteMetadataValidation(context);
	registerDripMdNoteFileHeaderReconcile(context);
	registerDripnoteMetadataCompletion(context);
	registerDripnoteHeadingShorthand(context);
	registerDripnoteCustomDecorations(context);
	registerDripnoteHeadingIdentityDisplay(context);
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(
			DripMdEditorProvider.viewType,
			new DripMdEditorProvider(context),
			{ webviewOptions: { retainContextWhenHidden: true } }
		)
	);
	const state = new DripState(context);
	registerNoteLifecycle(context, state);
	registerPersistentHeadingSoftLock(context);
	registerDripProjectFolderWatch(context, state);
	registerDripFeatureFolderWatch(context, state);
	setHeadingFormExtensionContext(context);
	setHeadingFormKbRootGetter(() => state.getKnowledgeBaseRoot && state.getKnowledgeBaseRoot());
	registerHeadingFormAutoFlush(context);
	registerRetrieverAutoRefresh(context, state);
	state.syncTagGraphCheckpointFromStorage();
	const componentsTreeProvider = new DripTreeDataProvider(state, 'components');
	const kbTreeProvider = new DripTreeDataProvider(state, 'knowledge');
	const draftsTreeProvider = new DripTreeDataProvider(state, 'drafts');
	const recentsTreeProvider = new DripTreeDataProvider(state, 'recents');
	const dailyNotesTreeProvider = new DripTreeDataProvider(state, 'dailyNotes');
	const sidebarRefreshHub = {
		refresh() {
			componentsTreeProvider.refresh();
			kbTreeProvider.refresh();
			draftsTreeProvider.refresh();
			recentsTreeProvider.refresh();
			dailyNotesTreeProvider.refresh();
		}
	};
	state.setDraftsRefreshListener(() => sidebarRefreshHub.refresh());
	state.setRecentsRefreshListener(() => recentsTreeProvider.refresh());
	// Start the KB verification. Once the saved folder is confirmed to be a `.driplock` KB
	// (or found missing/invalid), refresh the views that depend on the verified root.
	registerStartupCheck(context, state, () => {
		sidebarRefreshHub.refresh();
		refreshProjectViewIfShown();
	});
	require('../integrations/mcp/mcpBridge').registerDripMcp(context, state, {
		refreshUi: () => kbTreeProvider.refresh()
	});
	/** Newly created daily notes: uri → initial text (discard on close if unchanged). */
	const newDailyNoteInitialText = new Map();
	let hasAutoOpenedComposer = false;
	let kbWatcher;
	/** @type {import('vscode').WebviewPanel | null} */
	let settingsPanel = null;

	function refreshUi() {
		sidebarRefreshHub.refresh();
		DripComposerPanel.postState();
		// Do not rebuild Retriever catalog here — FS events (incl. index.drip WAL) would
		// loop with open/write from catalog refresh. Retriever refreshes on note save /
		// KB select / settings via registerRetrieverAutoRefresh + explicit callers.
		refreshProjectViewIfShown();
	}

	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let _kbFsRefreshTimer;

	/**
	 * Debounced tree/UI refresh for KB disk events. Ignores `.dripindex` (index.drip / WAL)
	 * so opening the DB cannot re-enter refreshUi.
	 * @param {import('vscode').Uri} [uri]
	 */
	function onKnowledgeBaseFsEvent(uri) {
		const rel = uri && kbRootFsRel(uri);
		if (rel != null && isDripIndexArtifactPath(rel)) {
			return;
		}
		clearTimeout(_kbFsRefreshTimer);
		_kbFsRefreshTimer = setTimeout(() => {
			_kbFsRefreshTimer = undefined;
			refreshUi();
		}, 350);
	}

	/**
	 * @param {import('vscode').Uri} uri
	 * @returns {string | null} posix-ish relative path, or null if outside KB
	 */
	function kbRootFsRel(uri) {
		const kbRoot =
			state.getKnowledgeBaseRoot() ||
			(typeof state.getRetrieverKnowledgeBaseRoot === 'function'
				? state.getRetrieverKnowledgeBaseRoot().uri
				: undefined);
		if (!kbRoot || !uri) return null;
		const rel = require('path').relative(kbRoot.fsPath, uri.fsPath).replace(/\\/g, '/');
		if (!rel || rel.startsWith('..') || require('path').isAbsolute(rel)) return null;
		return rel;
	}

	/** Index DB / WAL / sidecar under `.dripindex` — never drive sidebar refresh. */
	function isDripIndexArtifactPath(rel) {
		const p = String(rel || '')
			.replace(/\\/g, '/')
			.toLowerCase();
		return p === '.dripindex' || p.startsWith('.dripindex/');
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
	const dailyNotesTreeView = vscode.window.createTreeView(DRIP_DAILY_NOTES_VIEW_ID, {
		treeDataProvider: dailyNotesTreeProvider,
		showCollapseAll: true
	});

	context.subscriptions.push(componentsTreeView, kbTreeView, draftsTreeView, recentsTreeView, dailyNotesTreeView);
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

	// Discard brand-new daily notes that were never edited before closing
	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument(async doc => {
			const key = doc.uri.toString();
			if (!newDailyNoteInitialText.has(key)) return;
			const initialText = newDailyNoteInitialText.get(key) || '';
			newDailyNoteInitialText.delete(key);
			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) return;
			if (!isDailyNoteUri(kbRoot, doc.uri)) return;
			try {
				const buf = await vscode.workspace.fs.readFile(doc.uri);
				const text = Buffer.from(buf).toString('utf8');
				if (isDailyNoteUnchangedFromCreate(text, initialText)) {
					const { removeFileFromDripIndex } = require('../indexing/dripIndexDb');
					const rel = require('path')
						.relative(kbRoot.fsPath, doc.uri.fsPath)
						.replace(/\\/g, '/');
					try {
						await removeFileFromDripIndex(kbRoot, rel);
					} catch {
						/* best-effort */
					}
					await vscode.workspace.fs.delete(doc.uri, { useTrash: false });
					dailyNotesTreeProvider.refresh();
				}
			} catch {
				// best-effort
			}
		})
	);

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
		kbWatcher.onDidCreate(onKnowledgeBaseFsEvent);
		kbWatcher.onDidChange(onKnowledgeBaseFsEvent);
		kbWatcher.onDidDelete(onKnowledgeBaseFsEvent);
		context.subscriptions.push(kbWatcher);
	}

	registerNoteImagePasteAndDrop(context);
	registerDripnoteReferenceAssist(context, state);
	registerNoteDocumentLinks(context);
	registerDripnoteReferenceDefinitions(context, state);
	registerDripnoteLinkDropInsert(context);
	registerDripnoteDocumentSymbols(context);

	/**
	 * @param {import('vscode').Webview} webview
	 * @param {string} [error]
	 */
	async function postDripShortcutsToWebview(webview, error) {
		try {
			const data = await require('../startup/dripKeybindings').getDripShortcuts(context);
			await webview.postMessage({ type: 'shortcutsData', ...data, error: error || '' });
		} catch (err) {
			await webview.postMessage({
				type: 'shortcutsData',
				rows: [],
				error: error || (err instanceof Error ? err.message : String(err))
			});
		}
	}

	async function postLlmStatusToWebview(webview) {
		try {
			const status = await require('../llm/llmSettings').getLlmStatus(context);
			await webview.postMessage({ type: 'llmStatus', status });
		} catch (err) {
			console.error('[DRIP] llm status failed', err);
		}
	}

	function wireSettingsWebviewMessageHandler(webview) {
		webview.onDidReceiveMessage(async message => {
			try {
				switch (message.type) {
					case 'requestSettings':
						await postDripSettingsValuesToWebview(webview, state, context);
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
							await postDripSettingsValuesToWebview(webview, state, context);
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
					case 'openKeybindingsFile':
						await require('../startup/dripKeybindings').openUserKeybindingsFile(context);
						break;
					case 'requestShortcuts':
						await postDripShortcutsToWebview(webview);
						break;
					case 'updateShortcut': {
						let error = '';
						try {
							await require('../startup/dripKeybindings').updateDripShortcut(
								context,
								String(message.command || ''),
								message.mode,
								message.key
							);
						} catch (err) {
							error = err instanceof Error ? err.message : String(err);
						}
						await postDripShortcutsToWebview(webview, error);
						break;
					}
					case 'selectKnowledgeBase':
						await vscode.commands.executeCommand('drip.selectKnowledgeBase');
						break;
					case 'reindexCurrentKbWorkspace':
						await vscode.commands.executeCommand('drip.reindexCurrentKbWorkspace');
						break;
					case 'resetReindexEntireKb':
						await vscode.commands.executeCommand('drip.resetReindexEntireKb');
						break;
					case 'openDripUserSettings':
						await vscode.commands.executeCommand('workbench.action.openSettings', 'drip');
						break;
					case 'runEmbeddingBenchmark':
						await vscode.commands.executeCommand('drip.testEmbeddings');
						break;
					case 'githubBackupSaveRemote':
						await vscode.commands.executeCommand('drip.github.configureRemote', {
							remoteUrl: message.remoteUrl,
							branch: message.branch
						});
						await postDripSettingsValuesToWebview(webview, state, context);
						break;
					case 'githubBackupInit':
						await vscode.commands.executeCommand('drip.github.initRepo');
						await postDripSettingsValuesToWebview(webview, state, context);
						break;
					case 'githubBackupPush':
						await vscode.commands.executeCommand('drip.github.pushBackup');
						await postDripSettingsValuesToWebview(webview, state, context);
						break;
					case 'githubBackupPull':
						await vscode.commands.executeCommand('drip.github.pullBackup');
						await postDripSettingsValuesToWebview(webview, state, context);
						break;
					case 'githubBackupOpen':
						await vscode.commands.executeCommand('drip.github.openRemote');
						break;
					case 'githubBackupSetPat':
						await vscode.commands.executeCommand('drip.github.setPat');
						await postDripSettingsValuesToWebview(webview, state, context);
						break;
					case 'githubBackupClearPat':
						await vscode.commands.executeCommand('drip.github.clearPat');
						await postDripSettingsValuesToWebview(webview, state, context);
						break;
					case 'mcpSetEnabled':
						await require('../integrations/mcp/mcpBridge').setMcpEnabled(message.value === true);
						break;
					case 'mcpSetPort':
						await require('../integrations/mcp/mcpBridge').setMcpPort(message.value);
						break;
					case 'mcpCopy':
						await require('../integrations/mcp/mcpBridge').copyMcpValue(message.kind);
						break;
					case 'mcpRestart':
						await vscode.commands.executeCommand('drip.mcp.restart');
						break;
					case 'mcpRegenerateToken':
						await vscode.commands.executeCommand('drip.mcp.regenerateToken');
						break;
					case 'mcpOpenHealth':
						await vscode.env.openExternal(
							vscode.Uri.parse((await require('../integrations/mcp/mcpBridge').getMcpStatus()).healthUrl)
						);
						break;
				case 'llmAddProfile':
					{
						await require('../llm/llmSettings').addLlmProfile(context, message.profile);
						await postLlmStatusToWebview(webview);
					}
					break;
				case 'llmUpdateProfile':
					{
						await require('../llm/llmSettings').updateLlmProfile(context, message.profileId, message.patch);
						await postLlmStatusToWebview(webview);
					}
					break;
				case 'llmDeleteProfile':
					{
						await require('../llm/llmSettings').deleteLlmProfile(context, message.profileId);
						await postLlmStatusToWebview(webview);
					}
					break;
				case 'llmSetActiveProfile':
					{
						await require('../llm/llmSettings').setActiveLlmProfile(context, message.profileId);
						await postLlmStatusToWebview(webview);
					}
					break;
				case 'llmSetApiKey':
					{
						const key = String(message.value || '').trim();
						if (key) {
							await require('../llm/llmSettings').setLlmApiKey(context, key, message.profileId);
						}
						await postLlmStatusToWebview(webview);
					}
					break;
				case 'llmClearApiKey':
					await require('../llm/llmSettings').clearLlmApiKey(context, message.profileId);
					await postLlmStatusToWebview(webview);
					break;
				case 'llmTestConnection':
					{
						const profileId = String(message.profileId || '');
						const cfg = require('../llm/llmSettings').getLlmConfigForProfile(context, profileId);
						const apiKey = await require('../llm/llmSettings').getLlmApiKey(context, profileId);
						let result;
						if (!cfg) {
							result = { ok: false, message: 'Provider not found.' };
						} else if (!apiKey) {
							result = { ok: false, message: 'No API key saved for this provider.' };
						} else {
							try {
								const { chatComplete } = require('../llm/llmClient');
								await chatComplete({
									baseUrl: cfg.baseUrl,
									model: cfg.model,
									apiKey,
									maxTokens: 8,
									temperature: 0,
									timeoutMs: 20000,
									messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
								});
								result = { ok: true, message: `Connected — ${cfg.model}` };
							} catch (err) {
								result = { ok: false, message: err instanceof Error ? err.message : String(err) };
							}
						}
						await webview.postMessage({ type: 'llmTestResult', profileId, ...result });
					}
					break;
					case 'saveProjectMetadata': {
						const kbRoot = state.getKnowledgeBaseRoot();
						if (!kbRoot) {
							void vscode.window.showWarningMessage(
								'Select a DRIP knowledge base folder before saving project metadata.'
							);
							break;
						}
						const pm = require('../document/model/dripnoteProjectMetadata');
						await pm.saveProjectMetadataSettings(kbRoot, message.projectKey, message.overrides);
						await postDripSettingsValuesToWebview(webview, state, context);
						break;
					}
				}
			} catch (error) {
				console.error(error);
			}
		});
	}

	/** @param {string} [panelId] settings nav id to show (e.g. `mcp`) */
	function createOrShowSettingsPanel(panelId, projectKey, projectTitle) {
		const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;
		if (settingsPanel) {
			settingsPanel.reveal(column, false);
			if (panelId) {
				void settingsPanel.webview.postMessage({
					type: 'showPanel',
					panel: panelId,
					projectKey: projectKey || '',
					projectTitle: projectTitle || ''
				});
			}
			return settingsPanel;
		}
		settingsPanel = vscode.window.createWebviewPanel(
			'drip.settings.editor',
			'DRIP Settings',
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [context.extensionUri]
			}
		);
		settingsPanel.webview.html = getSettingsWebviewHtml(settingsPanel.webview, context.extensionUri, {
			initialPanel: panelId,
			initialProject: projectKey,
			initialProjectTitle: projectTitle
		});
		wireSettingsWebviewMessageHandler(settingsPanel.webview);
		const mcpBridge = require('../integrations/mcp/mcpBridge');
		const panelWebview = settingsPanel.webview;
		const mcpStatusSub = mcpBridge.onMcpStatusChange(async () => {
			void panelWebview.postMessage({ type: 'mcpStatus', status: await mcpBridge.getMcpStatus() });
		});
		settingsPanel.onDidDispose(() => {
			mcpStatusSub.dispose();
			settingsPanel = null;
		});
		return settingsPanel;
	}

	// Keep the Doc Coloring swatches in sync with the editor when the theme or token
	// color customizations change. Send only the resolved theme colors so any unsaved
	// edits in the form are left untouched.
	const postDocThemeColors = () => {
		if (!settingsPanel) return;
		void settingsPanel.webview.postMessage({
			type: 'docThemeColors',
			colors: require('../views/editor/themeTokenColors').getDocRoleThemeColors()
		});
	};
	context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(postDocThemeColors));
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration('workbench.colorTheme') ||
				e.affectsConfiguration('editor.tokenColorCustomizations') ||
				e.affectsConfiguration('editor.semanticTokenColorCustomizations')
			) {
				postDocThemeColors();
			}
		})
	);


	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			DRIP_HEADING_FORM_VIEW_ID,
			new DripHeadingFormWebviewProvider(context.extensionUri)
		)
	);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			DRIP_STORAGE_VIEW_ID,
			new DripStorageWebviewProvider(context.extensionUri, state, sidebarRefreshHub)
		)
	);

	const dripChatProvider = new DripChatWebviewProvider(context, state);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(DRIP_CHAT_VIEW_ID, dripChatProvider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
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
		vscode.commands.registerCommand('drip.openProjectView', async () => {
			DripProjectViewPanel.createOrShow(context, state);
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
			// Selection → cut it into the Composer; no selection → use the clipboard text.
			const editor = vscode.window.activeTextEditor;
			const selections = editor ? editor.selections.filter(s => !s.isEmpty) : [];
			const text = selections.length
				? selections.map(s => editor.document.getText(s)).join('\n')
				: await vscode.env.clipboard.readText();
			if (!text.trim()) {
				vscode.window.showInformationMessage('Select some text in the editor (or copy it) first.');
				return;
			}
			const capture = parseSelectionForComposer(text);
			if (selections.length) {
				await vscode.env.clipboard.writeText(text);
				await editor.edit(edit => {
					for (const s of selections) edit.delete(s);
				});
			}
			await DripComposerPanel.createOrShow(context.extensionUri, state, sidebarRefreshHub, undefined, capture);
			await revealDripStorageView();
		}),
		vscode.commands.registerCommand(DRIP_FOCUS_CHAT_COMMAND_ID, () => {
			dripChatProvider.reveal();
		}),
		vscode.commands.registerCommand(DRIP_ADD_SELECTION_TO_CHAT_COMMAND_ID, async () => {
			const editor = vscode.window.activeTextEditor;
			let text = '';
			if (editor && editor.selections.some(s => !s.isEmpty)) {
				text = editor.selections
					.filter(s => !s.isEmpty)
					.map(s => editor.document.getText(s))
					.join('\n');
				await vscode.env.clipboard.writeText(text);
			} else {
				text = await vscode.env.clipboard.readText();
			}
			if (!text.trim()) {
				void vscode.window.showInformationMessage('Select some text (or copy it) first, then add it to DRIP Chat.');
				return;
			}
			dripChatProvider.appendToInput(text);
		}),
		vscode.commands.registerCommand('drip.openDripSettingsView', async opts => {
			createOrShowSettingsPanel(
				opts && typeof opts.panel === 'string' ? opts.panel : undefined,
				opts && typeof opts.projectKey === 'string' ? opts.projectKey : undefined,
				opts && typeof opts.projectTitle === 'string' ? opts.projectTitle : undefined
			);
		}),
		vscode.commands.registerCommand('drip.github.configureRemote', async opts => {
			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a DRIP knowledge base first.');
				return;
			}
			const { saveRemoteConfig } = require('../startup/githubBackup');
			const o = opts && typeof opts === 'object' ? opts : {};
			let remoteUrl = String(o.remoteUrl || '').trim();
			let branch = String(o.branch || '').trim();
			if (!remoteUrl) {
				remoteUrl =
					(await vscode.window.showInputBox({
						prompt: 'GitHub remote URL (HTTPS or SSH)',
						placeHolder: 'https://github.com/you/my-kb.git',
						ignoreFocusOut: true
					})) || '';
			}
			if (!remoteUrl.trim()) return;
			if (!branch) {
				branch =
					(await vscode.window.showInputBox({
						prompt: 'Branch name',
						value: 'main',
						ignoreFocusOut: true
					})) || 'main';
			}
			await saveRemoteConfig(kbRoot, { remoteUrl: remoteUrl.trim(), branch: branch.trim() || 'main' });
			void vscode.window.showInformationMessage('DRIP GitHub remote saved.');
		}),
		vscode.commands.registerCommand('drip.github.initRepo', async () => {
			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a DRIP knowledge base first.');
				return;
			}
			try {
				const { initBackupRepo, isGitAvailable } = require('../startup/githubBackup');
				if (!(await isGitAvailable())) {
					const open = 'Open Git downloads';
					const pick = await vscode.window.showErrorMessage(
						'Git is not installed or not on PATH.',
						open
					);
					if (pick === open) {
						await vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com/downloads'));
					}
					return;
				}
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'DRIP: initializing GitHub backup…'
					},
					async () => initBackupRepo(context, kbRoot)
				);
				void vscode.window.showInformationMessage('DRIP GitHub backup initialized.');
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				void vscode.window.showErrorMessage(`DRIP GitHub init failed: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('drip.github.pushBackup', async () => {
			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a DRIP knowledge base first.');
				return;
			}
			try {
				const { pushBackup } = require('../startup/githubBackup');
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'DRIP: pushing KB backup…'
					},
					async () => pushBackup(context, kbRoot)
				);
				void vscode.window.showInformationMessage('DRIP knowledge base backup pushed.');
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				void vscode.window.showErrorMessage(`DRIP GitHub push failed: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('drip.github.pullBackup', async () => {
			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a DRIP knowledge base first.');
				return;
			}
			try {
				const { pullBackup } = require('../startup/githubBackup');
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'DRIP: pulling KB backup…'
					},
					async () =>
						pullBackup(context, kbRoot, {
							reindex: async () => {
								await vscode.commands.executeCommand('drip.reindexCurrentKbWorkspace');
							}
						})
				);
				void vscode.window.showInformationMessage('DRIP knowledge base backup pulled.');
				refreshUi();
				refreshProjectViewIfShown();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				void vscode.window.showErrorMessage(`DRIP GitHub pull failed: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('drip.github.openRemote', async () => {
			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a DRIP knowledge base first.');
				return;
			}
			const { getGithubBackupSettings, githubWebUrl } = require('../startup/githubBackup');
			const cfg = await getGithubBackupSettings(kbRoot);
			const web = githubWebUrl(cfg.remoteUrl);
			if (!web) {
				void vscode.window.showWarningMessage(
					'Set a github.com remote URL first (HTTPS or git@github.com:…).'
				);
				return;
			}
			await vscode.env.openExternal(vscode.Uri.parse(web));
		}),
		vscode.commands.registerCommand('drip.github.setPat', async () => {
			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a DRIP knowledge base first.');
				return;
			}
			const { setStoredPat } = require('../startup/githubBackup');
			const pat = await vscode.window.showInputBox({
				prompt: 'GitHub personal access token (stored in VS Code Secret Storage for this KB)',
				password: true,
				ignoreFocusOut: true,
				placeHolder: 'ghp_… or github_pat_…'
			});
			if (pat == null) return;
			if (!String(pat).trim()) {
				void vscode.window.showWarningMessage('Token was empty — nothing saved.');
				return;
			}
			await setStoredPat(context, kbRoot, pat);
			void vscode.window.showInformationMessage('DRIP GitHub token saved in Secret Storage.');
		}),
		vscode.commands.registerCommand('drip.github.clearPat', async () => {
			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a DRIP knowledge base first.');
				return;
			}
			const { clearStoredPat } = require('../startup/githubBackup');
			await clearStoredPat(context, kbRoot);
			void vscode.window.showInformationMessage('DRIP GitHub token cleared.');
		}),
		vscode.commands.registerCommand('drip.showKbNewMenu', async item => {
			const uri = uriFromCommandArg(item);
			const selected = kbTreeView.selection?.[0];
			const folderUri =
				uri ||
				(selected?.uri
					? selected.uri
					: undefined);
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
				dailyNotesTreeProvider.refresh();
				refreshRetrieverCatalogIfShown();
				if (settingsPanel) {
					await postDripSettingsValuesToWebview(settingsPanel.webview, state, context);
				}
			}
		}),
		vscode.commands.registerCommand('drip.createNoteFile', async item => {
			try {
				await state.createNoteFile(uriFromCommandArg(item));
				refreshUi();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				void vscode.window.showErrorMessage(msg);
			}
		}),
		vscode.commands.registerCommand('drip.createMarkdownFile', async item => {
			try {
				await state.createMarkdownFile(uriFromCommandArg(item));
				refreshUi();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				void vscode.window.showErrorMessage(msg);
			}
		}),
		vscode.commands.registerCommand('drip.createFolder', async item => {
			try {
				await state.createFolder(uriFromCommandArg(item));
				refreshUi();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				void vscode.window.showErrorMessage(msg);
			}
		}),
		vscode.commands.registerCommand('drip.createProjectFolder', async item => {
			try {
				await state.createProjectFolder(uriFromCommandArg(item));
				refreshUi();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				void vscode.window.showErrorMessage(msg);
			}
		}),
		vscode.commands.registerCommand('drip.createFeatureFolder', async item => {
			try {
				await state.createFeatureFolder(uriFromCommandArg(item));
				refreshUi();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				void vscode.window.showErrorMessage(msg);
			}
		}),
		vscode.commands.registerCommand('drip.createFeatureFile', async item => {
			try {
				await state.createFeatureFile(uriFromCommandArg(item));
				refreshUi();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				void vscode.window.showErrorMessage(msg);
			}
		}),
		vscode.commands.registerCommand('drip.createDripIgnore', async item => {
			await state.ensureDripIgnoreFile(uriFromCommandArg(item));
			refreshUi();
		}),
		vscode.commands.registerCommand('drip.ignorePath', async item => {
			await state.addIgnoreEntry(item);
			refreshUi();
		}),
		vscode.commands.registerCommand('drip.refreshTree', async () => {
			refreshUi();
		}),
		vscode.commands.registerCommand(DRIP_OPEN_TODAY_DAILY_NOTE_COMMAND_ID, async () => {
			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a Knowledge Base folder first.');
				return;
			}
			try {
				const now = new Date();
				const { uri, isNew, initialText } = await ensureTodayDailyNote(kbRoot, now, {
					context
				});
				await vscode.window.showTextDocument(uri);
				dailyNotesTreeProvider.refresh();
				if (isNew) {
					newDailyNoteInitialText.set(uri.toString(), initialText);
				}
			} catch (err) {
				void vscode.window.showErrorMessage(`Could not open daily note: ${err instanceof Error ? err.message : String(err)}`);
			}
		}),
		vscode.commands.registerCommand('drip.copyPath', async item => {
			await state.copyPath(item);
		}),
		vscode.commands.registerCommand('drip.renameItem', async item => {
			await state.renameItem(item);
			refreshUi();
		}),
		vscode.commands.registerCommand('drip.convertFolderToFeature', async item => {
			await state.convertFolderToFeature(item);
			refreshUi();
		}),
		vscode.commands.registerCommand('drip.deleteProject', async item => {
			await state.deleteProject(item);
			refreshUi();
		}),
		vscode.commands.registerCommand('drip.deleteFeature', async item => {
			await state.deleteFeature(item);
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
					e.affectsConfiguration('drip.fileLevelMetadataTypes') ||
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
