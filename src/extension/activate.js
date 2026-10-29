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
	DRIP_PROJECTS_VIEW_ID,
	DRIP_DRAFTS_VIEW_ID,
	DRIP_RECENTS_VIEW_ID,
	DRIP_OPEN_RECENT_FILE_COMMAND_ID,
	DRIP_DAILY_NOTES_VIEW_ID,
	DRIP_OPEN_TODAY_DAILY_NOTE_COMMAND_ID,
	DRIP_CHAT_VIEW_ID,
	DRIP_STORAGE_VIEW_ID
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
	DripStorageWebviewProvider,
	postKbNoteSettingsToStorage,
	revealDripStorageView
} = require('../views/views');
const {
	DripTagsPanel,
	postTagGraphStateToAll
} = require('../views/tags/panel');
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
const {
	createOrShowSettingsPanel,
	getOpenSettingsPanel,
	postDripSettingsValuesToWebview,
	registerSettingsThemeSync
} = require('../views/settings/settingsPanel');
const { registerGithubBackupCommands } = require('../startup/githubBackupCommands');
const { registerNoteImagePasteAndDrop } = require('../views/editor/noteImagePaste');
const { registerDripnoteReferenceAssist } = require('../graph/dripTxtReferenceAssist.js');
const { registerNoteDocumentLinks } = require('../graph/noteDocumentLinks');
const { registerDripnoteReferenceDefinitions } = require('../graph/dripTxtReferenceDefinitions.js');
const { registerDripnoteLinkDropInsert } = require('../graph/dripTxtLinkDropInsert.js');
const { registerDripnoteDocumentSymbols } = require('../views/editor/dripTxt/dripTxtDocumentSymbols.js');
const { runEmbeddingBenchmark } = require('../retrieval/embeddings');
const { parseSelectionForComposer } = require('../views/capturePreprocess');
const { truncateSelectionToSubtree } = require('../capture/noteDraft');
const { noteFormatForPath } = require('../document/model/dripNoteFileTypes.js');
const { runGuardedDocumentEdit } = require('../shared/documentEditGuard');
const { createKbTreeDragDropController } = require('../views/lhs/knowledgebase/kbTreeDragDrop');
const { registerDripSidebarViewBehavior } = require('../views/lhs/knowledgebase/dripSidebarViews');
const { showKbNewMenu, showProjectsNewMenu } = require('../views/lhs/knowledgebase/kbCreateMenu');

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
const { invalidateKbNoteExtensionsCache } = require('../document/model/dripNoteFileTypes.js');
const { initializeMultiGraphStorage } = require('../graph/tagGraphStore');
const { registerDripnoteTagCompletion } = require('../views/editor/dripTxt/dripTxtTagCompletion.js');
const { registerDripnoteSemanticTokens } = require('../views/editor/dripTxt/dripTxtSemanticTokens.js');
const { registerDripnoteMetadataDiagnostics } = require('../document/validate/dripTxt/dripTxtMetadataDiagnosticsTemplates.js');
const { registerDripMdNoteMetadataValidation } = require('../document/validate/dripMd/dripMdNoteMetadataValidation.js');
const { registerDripMdNoteFileHeaderReconcile } = require('../document/validate/dripMd/dripMdNoteFileHeaderReconcile.js');
const { registerDripnoteMetadataCompletion } = require('../views/editor/dripTxt/dripTxtMetadataCompletion.js');
const { registerDripnoteHeadingShorthand } = require('../views/editor/dripTxt/dripTxtHeadingShorthand.js');
const { registerDripnoteHeadingIndentSync } = require('../views/editor/dripTxt/dripTxtHeadingIndentSync.js');
const { registerDripnoteCustomDecorations } = require('../views/editor/dripTxt/dripTxtCustomDecorations.js');
const { registerDripnoteHeadingIdentityDisplay } = require('../views/editor/dripTxt/dripTxtHeadingIdentityDisplay.js');
const { DripMdEditorProvider, requestMdEditorSelection, deleteMdEditorSelection } = require('../views/editor/dripMdEditor/dripMdEditorProvider');
const { registerNoteLifecycle } = require('../indexing/sync/dripTxt/dripTxtLifecycle.js');
const { registerStartupCheck, resetStartupCheckCache, runStartupCheck } = require('../startup/startupCheck');
const {
	DripRetrieverPanel,
	registerRetrieverAutoRefresh,
	refreshRetrieverCatalogIfShown,
	scheduleRetrieverCatalogRebuildIfShown
} = require('../views/lhs/retriever/panel');
	const { DripProjectViewPanel, refreshProjectViewIfShown } = require('../views/lhs/projects/panel');
	const { bindPeerIdentityContext, ensurePeerIdentity } = require('../peer/peerIdentity');
	const { registerProjectShareCommands } = require('../peer/projectShareCommands');
const { DripChatWebviewProvider } = require('../views/rhs/chat/panel');
const { runRetrieverHeadingQuickOpen } = require('../retrieval/retrieverQuickOpen');
const { updateKnowledgeBase } = require('../startup/updateKnowledgeBase');
const { openKbEditorNote } = require('../startup/kbEditorNote');

async function activate(context) {
	const { configureEmbeddingModelCache } = require('../retrieval/embeddings');
	configureEmbeddingModelCache(context.extensionPath);

	// Migrate a legacy single-key LLM install into the profile model once.
	require('../llm/llmSettings').migrateLegacyLlmSettings(context).catch(() => {});

	const { initRhsStorageContexts } = require('../views/rhs/revealStorageOnly');
	await initRhsStorageContexts();

	bindPeerIdentityContext(context);
	ensurePeerIdentity().catch(() => {});

	await initializeMultiGraphStorage(context);
	registerDripnoteTagCompletion(context);
	registerDripnoteSemanticTokens(context);
	registerDripnoteMetadataDiagnostics(context);
	registerDripMdNoteMetadataValidation(context);
	registerDripMdNoteFileHeaderReconcile(context);
	registerDripnoteMetadataCompletion(context);
	registerDripnoteHeadingShorthand(context);
	registerDripnoteHeadingIndentSync(context);
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
	const runIssueArchiveSweepIfDue = require('../document/project/projectIssueArchive').registerIssueArchiveSweep(
		context,
		state
	);
	setHeadingFormExtensionContext(context);
	setHeadingFormKbRootGetter(() => state.getKnowledgeBaseRoot && state.getKnowledgeBaseRoot());
	registerHeadingFormAutoFlush(context);
	registerRetrieverAutoRefresh(context, state);
	state.syncTagGraphCheckpointFromStorage();
	const componentsTreeProvider = new DripTreeDataProvider(state, 'components');
	const kbTreeProvider = new DripTreeDataProvider(state, 'knowledge');
	const projectsTreeProvider = new DripTreeDataProvider(state, 'projects');
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
		},
		refreshProjects() {
			projectsTreeProvider.refresh();
		}
	};
	state.setDraftsRefreshListener(() => sidebarRefreshHub.refresh());
	state.setRecentsRefreshListener(() => recentsTreeProvider.refresh());
	// Start the KB verification. Once the saved folder is confirmed to be a `.driplock` KB
	// (or found missing/invalid), refresh the views that depend on the verified root.
	registerStartupCheck(context, state, () => {
		sidebarRefreshHub.refresh();
		sidebarRefreshHub.refreshProjects();
		refreshProjectViewIfShown();
		const kb = state.getVerifiedKnowledgeBaseRoot && state.getVerifiedKnowledgeBaseRoot();
		if (kb) {
			require('../peer/projectShareCommands')
				.resumeSharedProjectListeners(kb)
				.catch(() => {});
			runIssueArchiveSweepIfDue();
		}
	});
	require('../integrations/mcp/mcpBridge').registerDripMcp(context, state, {
		refreshUi: () => kbTreeProvider.refresh()
	});
	/** Newly created daily notes: uri → initial text (discard on close if unchanged). */
	const newDailyNoteInitialText = new Map();
	let hasAutoOpenedComposer = false;
	let kbWatcher;

	function refreshUi() {
		sidebarRefreshHub.refresh();
		DripComposerPanel.postState();
		// Do not rebuild Retriever catalog here — FS events (incl. index.drip WAL) would
		// loop with open/write from catalog refresh. Retriever refreshes on note save /
		// KB select / settings via registerRetrieverAutoRefresh + explicit callers.
		refreshProjectViewIfShown();
	}

	/** Create / delete / join / rename — not the disk watcher. */
	function refreshUiAndProjects() {
		refreshUi();
		sidebarRefreshHub.refreshProjects();
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
		if (rel != null && (isDripIndexArtifactPath(rel) || isProjectSidecarPath(rel))) {
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

	/** Project `.drip/` sidecar (ops log, sync vector) — writing it must not reload Projects. */
	function isProjectSidecarPath(rel) {
		const p = String(rel || '').replace(/\\/g, '/');
		return /(^|\/)\.drip(\/|$)/i.test(p);
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
	const projectsTreeView = vscode.window.createTreeView(DRIP_PROJECTS_VIEW_ID, {
		treeDataProvider: projectsTreeProvider,
		showCollapseAll: true,
		canSelectMany: true,
		dragAndDropController: kbDragDropController
	});
	context.subscriptions.push(
		vscode.window.registerFileDecorationProvider(projectsTreeProvider.presenceDecorations)
	);
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

	context.subscriptions.push(componentsTreeView, kbTreeView, projectsTreeView, draftsTreeView, recentsTreeView, dailyNotesTreeView);
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

	registerSettingsThemeSync(context);
	registerGithubBackupCommands(context, state, {
		refreshUi,
		refreshProjectView: refreshProjectViewIfShown
	});
	registerProjectShareCommands(context, state, { refreshProjectView: refreshProjectViewIfShown });
	try {
		const { setPresenceChangeListener } = require('../peer/projectLanSync');
		setPresenceChangeListener(() => {
			projectsTreeProvider.refreshPresence();
		});
	} catch {
		/* LAN presence is optional */
	}
	context.subscriptions.push({
		dispose: () => {
			try {
				require('../peer/projectLanSync').stopAllLanListeners();
			} catch {
				/* ignore */
			}
		}
	});

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
			let text = '';
			let sourceFormat = '';
			let fromMdEditor = false;

			if (selections.length) {
				text = selections.map(s => editor.document.getText(s)).join('\n');
				sourceFormat = noteFormatForPath(editor.document.uri.fsPath);
			} else {
				// A custom webview editor (`.d.md`) has no activeTextEditor — ask its webview
				// for the CodeMirror selection before falling back to the clipboard.
				const mdSel = await requestMdEditorSelection();
				if (mdSel && mdSel.trim()) {
					text = mdSel;
					sourceFormat = 'drip-md';
					fromMdEditor = true;
				} else {
					text = await vscode.env.clipboard.readText();
					sourceFormat = noteFormatForPath('');
				}
			}

			if (!text.trim()) {
				vscode.window.showInformationMessage('Select some text in the editor (or copy it) first.');
				return;
			}
			// Stop the capture at the first heading shallower (higher in the hierarchy) than the
			// captured heading, so a parent heading (or anything above the subtree) is never
			// captured or cut. `cutText` is a prefix of `text`, so its length maps onto the
			// original selection's offsets for the cut below.
			const cutText = truncateSelectionToSubtree(text, sourceFormat);
			const capture = parseSelectionForComposer(cutText, sourceFormat);
			if (fromMdEditor) {
				// Cut the selection in the `.d.md` editor (copy to clipboard, then remove it).
				await vscode.env.clipboard.writeText(cutText);
				deleteMdEditorSelection(cutText.length);
			} else if (selections.length) {
				await vscode.env.clipboard.writeText(cutText);
				// The cut is an intentional capture, not a manual bulk delete — guard it so the
				// soft-lock does not ask to confirm the bulk delete of persistent headings.
				await runGuardedDocumentEdit(async () => {
					await editor.edit(edit => {
						if (selections.length === 1) {
							// Single selection: cut only the captured prefix; the remainder stays.
							const s = selections[0];
							const end = editor.document.positionAt(editor.document.offsetAt(s.start) + cutText.length);
							edit.delete(new vscode.Range(s.start, end));
						} else {
							for (const s of selections) edit.delete(s);
						}
					});
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
				context,
				state,
				opts && typeof opts.panel === 'string' ? opts.panel : undefined,
				opts && typeof opts.projectKey === 'string' ? opts.projectKey : undefined,
				opts && typeof opts.projectTitle === 'string' ? opts.projectTitle : undefined
			);
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
			refreshUiAndProjects();
		}),
		vscode.commands.registerCommand('drip.showProjectsNewMenu', async item => {
			const uri = uriFromCommandArg(item);
			const selected = projectsTreeView.selection?.[0];
			const folderUri =
				uri ||
				(selected?.uri
					? selected.uri
					: undefined);
			await showProjectsNewMenu(folderUri);
			refreshUiAndProjects();
		}),
		vscode.commands.registerCommand(DRIP_SELECT_KB_COMMAND_ID, async () => {
			const pickedKb = await state.pickKnowledgeBaseFolder();
			resetStartupCheckCache();
			await runStartupCheck(context, state);
			ensureKnowledgeBaseWatcher();
			refreshUiAndProjects();
			if (pickedKb) {
				state.syncTagGraphCheckpointFromStorage();
				await postTagGraphStateToAll(state);
				await state.refreshDraftsFromStorage();
				await state.refreshRecentsFromStorage();
				dailyNotesTreeProvider.refresh();
				refreshRetrieverCatalogIfShown();
				if (getOpenSettingsPanel()) {
					await postDripSettingsValuesToWebview(getOpenSettingsPanel().webview, state, context);
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
				refreshUiAndProjects();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				void vscode.window.showErrorMessage(msg);
			}
		}),
		vscode.commands.registerCommand('drip.createFeatureFolder', async item => {
			try {
				await state.createFeatureFolder(uriFromCommandArg(item));
				refreshUiAndProjects();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				void vscode.window.showErrorMessage(msg);
			}
		}),
		vscode.commands.registerCommand('drip.createFeatureFile', async item => {
			try {
				await state.createFeatureFile(uriFromCommandArg(item));
				refreshUiAndProjects();
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
			refreshUiAndProjects();
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
			refreshUiAndProjects();
		}),
		vscode.commands.registerCommand('drip.convertFolderToFeature', async item => {
			await state.convertFolderToFeature(item);
			refreshUiAndProjects();
		}),
		vscode.commands.registerCommand('drip.deleteProject', async item => {
			await state.deleteProject(item);
			refreshUiAndProjects();
			const settings = getOpenSettingsPanel();
			if (settings) {
				await postDripSettingsValuesToWebview(settings.webview, state, context);
			}
		}),
		vscode.commands.registerCommand('drip.deleteFeature', async item => {
			await state.deleteFeature(item);
			refreshUiAndProjects();
		}),
		vscode.commands.registerCommand('drip.deleteItem', async item => {
			await state.deleteItem(item);
			refreshUiAndProjects();
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

async function deactivate() {
	try {
		await require('../peer/projectRecord').flushPendingIssueUpdates();
		await require('../peer/projectRecord').flushPendingHeadingUpdates();
	} catch {
		/* window is closing */
	}
	try {
		await Promise.race([
			require('../peer/projectMailbox').pushAllProjectMailboxesOnExit(),
			new Promise((_, reject) => setTimeout(() => reject(new Error('mailbox push timed out')), 12000))
		]);
	} catch (err) {
		console.error('[DRIP] mailbox push on exit', err);
	}
}

module.exports = { activate, deactivate };
