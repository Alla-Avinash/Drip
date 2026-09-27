'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { DRIP_RETRIEVER_PANEL_ID } = require('../../../shared/constants');
const { getNonce } = require('../../../shared/utils');
const {
	buildRetrieverCatalogShell,
	isIndexerNotePath
} = require('../../../retrieval/dripnoteRetrieverQuery');
const { readTextFile } = require('../../../indexing/kbFilesystem');
const { extractFileIdFromHeader } = require('../../../graph/dripnoteReferenceSync');
const {
	fileNameMatchesKbNote,
	getKbNoteExtensions,
	stripKbNoteExtension
} = require('../../../document/model/noteFileTypes');

/**
 * Same KB root the sidebar tree and Retriever use: pinned folder first, else workspace / note-dir fallback.
 * @param {{ getRetrieverKnowledgeBaseRoot?: () => { uri?: import('vscode').Uri }, getKnowledgeBaseRoot?: () => import('vscode').Uri | undefined }} state
 */
function retrieverLiveKbRootKey(state) {
	const rk =
		typeof state?.getRetrieverKnowledgeBaseRoot === 'function'
			? state.getRetrieverKnowledgeBaseRoot()
			: { uri: state?.getKnowledgeBaseRoot?.() };
	const u = rk && rk.uri;
	return u && u.fsPath ? u.fsPath.replace(/\\/g, '/').toLowerCase() : '';
}

/** Close the secondary (right) side bar where Chat often lives — best-effort, command may be absent. */
function tryCloseAuxiliaryBarForRetriever() {
	void vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(
		() => undefined,
		() => undefined
	);
}

/**
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} extensionUri
 */
function getRetrieverPanelHtml(webview, extensionUri) {
	const nonce = getNonce();
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'views', 'lhs', 'retriever', 'webview', 'retrieverPanel.css'));
	const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'views', 'lhs', 'retriever', 'webview', 'retrieverPanel.js'));
	const csp = [
		`default-src 'none';`,
		// Allow linked retrieverPanel.css and any style="" set from script (chip selected state).
		`style-src ${webview.cspSource} 'unsafe-inline';`,
		`script-src 'nonce-${nonce}' ${webview.cspSource};`
	].join(' ');
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Retriever</title>
<link rel="stylesheet" href="${styleUri}" />
</head>
<body>
	<main>
		<header class="rz-brand" aria-label="Retriever">
			<h1 class="rz-h1">DRIP RETRIEVER</h1>
			<p class="rz-brand-sub">Search and filter headings across your knowledge base</p>
		</header>
		<div class="rz-scope-strip" aria-label="Retrieval scope">
			<span class="rz-scope-strip-label">Scope</span>
			<div class="rz-scope-checks" role="radiogroup" aria-label="Search files or headings">
				<label class="rz-scope-check-label"><input type="radio" name="rz-scope" id="rz-scope-headings" value="headings" checked /> Headings</label>
				<label class="rz-scope-check-label"><input type="radio" name="rz-scope" id="rz-scope-files" value="files" /> Files</label>
			</div>
			<div class="aside-field rz-corpus-field" style="margin:0 0 0 12px;max-width:260px;">
				<label for="rz-corpus">Corpus</label>
				<div class="rz-corpus-row">
					<select id="rz-corpus" class="rz-select" aria-label="Search corpus">
						<option value="working" selected>Working set (.dripignore)</option>
						<option value="entire">Entire KB</option>
						<option value="custom">Custom paths…</option>
					</select>
					<button type="button" class="rz-btn secondary rz-corpus-edit-btn hidden" id="rz-corpus-edit" title="Change custom paths">Edit</button>
				</div>
			</div>
		</div>
		<div id="rz-custom-corpus" class="rz-custom-corpus hidden" hidden>
			<div class="rz-custom-corpus-inner">
				<h2 class="rz-custom-corpus-title">Custom paths</h2>
				<p class="rz-custom-corpus-sub">Drop or add files/folders from inside the .driplock knowledge base only. Paths outside the KB are rejected. Not saved after this session.</p>
				<div id="rz-custom-drop" class="rz-custom-drop" tabindex="0" role="button" aria-label="Drop files or folders here">
					<span class="rz-custom-drop-label">Drag &amp; drop files or folders here</span>
				</div>
				<div class="rz-custom-toolbar">
					<button type="button" class="rz-btn secondary" id="rz-custom-add">Add files or folders…</button>
				</div>
				<ul id="rz-custom-entries" class="rz-custom-entries" aria-live="polite"></ul>
				<p id="rz-custom-empty" class="rz-custom-empty">No paths yet — drop or add at least one file or folder.</p>
				<div class="rz-custom-footer">
					<span class="rz-custom-footer-spacer"></span>
					<button type="button" class="rz-btn secondary" id="rz-custom-cancel">Cancel</button>
					<button type="button" class="rz-btn" id="rz-custom-done">Done</button>
				</div>
			</div>
		</div>
		<div class="toolbar">
			<div class="search-wrap rz-search-slot">
				<input id="rz-heading-search" class="search-input" type="text" placeholder="Search headings by meaning…" autocomplete="off" spellcheck="false" aria-expanded="false" aria-controls="rz-suggest-panel" aria-autocomplete="list" />
				<div id="rz-suggest-panel" class="rz-suggest-panel hidden" role="listbox" aria-label="Top embedding matches — click to open"></div>
			</div>
			<button type="button" class="rz-btn secondary" id="rz-clear-filters" title="Clear search, scope, corpus (back to Working set), metadata types, and tags">Clear filters</button>
			<button type="button" class="rz-btn secondary" id="rz-refresh" title="Flush pending index updates, reload from index.drip, and re-run your query">Refresh</button>
			<button type="button" class="rz-btn secondary" id="rz-copy-md" title="Copy visible results as Markdown" disabled>Copy list</button>
		</div>
		<div id="rz-kb-banner" class="rz-banner" hidden>
			No knowledge base root is configured. Pick a KB folder from DRIP Storage.
		</div>
		<div class="filter-bar">
			<div class="filter-block">
				<span class="filter-label">Metadata types</span>
				<p id="rz-types-empty-hint" class="rz-inline-hint hidden">No types in DRIP Settings — add templates, then Refresh.</p>
				<div id="rz-type-chips" class="chip-row" role="toolbar" aria-label="Filter by metadata type"></div>
			</div>
			<div class="filter-row-tags-rel">
				<div class="filter-block filter-block--half">
					<span class="filter-label">Tags</span>
					<div class="aside-field filter-select-field">
						<label for="rz-tag-graph">Tag graph</label>
						<select id="rz-tag-graph" class="rz-select" aria-label="Apply tags from a saved tag graph">
							<option value="">None</option>
						</select>
					</div>
					<div class="tag-input-row rz-tag-picker">
						<input id="rz-tag-input" class="rz-tag-entry" placeholder="Search tags, Enter to add…" autocomplete="off" spellcheck="false" aria-autocomplete="list" aria-controls="rz-tag-suggest" aria-expanded="false" />
						<div id="rz-tag-suggest" class="rz-tag-suggest hidden" role="listbox" aria-label="Matching tags"></div>
					</div>
					<div id="rz-tag-chips" class="chip-row" aria-live="polite"></div>
				</div>
				<div class="filter-block filter-block--half">
					<span class="filter-label">Relations</span>
					<div class="aside-field filter-select-field">
						<label for="rz-relation-type">Relation type</label>
						<select id="rz-relation-type" class="rz-select" aria-label="Relation type to add tags for (you can add several types)">
							<option value="">Choose type…</option>
						</select>
					</div>
					<div class="tag-input-row rz-tag-picker">
						<input id="rz-rel-tag-input" class="rz-tag-entry" placeholder="Add tags for this type, then switch type to add more…" autocomplete="off" spellcheck="false" aria-autocomplete="list" aria-controls="rz-rel-tag-suggest" aria-expanded="false" disabled />
						<div id="rz-rel-tag-suggest" class="rz-tag-suggest hidden" role="listbox" aria-label="Matching relation tags"></div>
					</div>
					<div id="rz-rel-tag-chips" class="chip-row" aria-live="polite"></div>
				</div>
			</div>
		</div>
		<div class="viewport">
			<div id="rz-empty" class="empty">
				<h2>DRIP Retriever</h2>
				<p>Preparing…</p>
			</div>
			<div id="rz-list" class="result-list" role="region" aria-label="Retriever search results" hidden></div>
			<div id="rz-board" class="result-board" hidden></div>
		</div>
		<div class="rz-footer-wrap">
			<div id="rz-footer" class="rz-footer-text" aria-live="polite"></div>
			<button type="button" class="rz-btn secondary rz-load-more-btn hidden" id="rz-load-more">Load more</button>
		</div>
		<div id="rz-ctx-menu" class="rz-ctx-menu" hidden role="menu" aria-hidden="true">
			<button type="button" class="rz-ctx-item" role="menuitem" data-act="open">Open</button>
			<button type="button" class="rz-ctx-item" role="menuitem" data-act="reveal">Reveal in Explorer</button>
			<button type="button" class="rz-ctx-item" role="menuitem" data-act="copy-path">Copy path:line</button>
			<button type="button" class="rz-ctx-item" role="menuitem" data-act="copy-l">Copy L. reference…</button>
		</div>
	</main>
	<aside>
		<h3>Display</h3>
		<div class="aside-field">
			<label for="rz-view-mode">View</label>
			<select id="rz-view-mode" class="rz-select">
				<option value="list" selected>List</option>
				<option value="board">Board</option>
			</select>
		</div>
		<div class="aside-field">
			<label for="rz-group-by">Group</label>
			<select id="rz-group-by" class="rz-select">
				<option value="none" selected>None</option>
				<option value="folder">Folder</option>
				<option value="file">File</option>
				<option value="type">Type</option>
			</select>
			<p id="rz-group-files-hint" class="aside-muted hidden">Group is disabled when Scope is Files (results are already file buckets).</p>
		</div>
		<div class="aside-field">
			<label for="rz-search-engine">Search engine</label>
			<select id="rz-search-engine" class="rz-select" aria-label="How results are ranked">
				<option value="recommended" selected>Recommended</option>
				<option value="semantic">Only semantic search</option>
				<option value="word">Only word search</option>
			</select>
		</div>
		<p class="aside-sub">Shown in results</p>
		<label class="aside-check"><input type="checkbox" id="rz-show-type" checked /> <span>Metadata type marker</span></label>
		<label class="aside-check"><input type="checkbox" id="rz-show-bc" checked /> <span>Metadata key-values</span></label>
		<label class="aside-check"><input type="checkbox" id="rz-show-tags" checked /> <span>Search tags</span></label>
		<label class="aside-check"><input type="checkbox" id="rz-show-relations" checked /> <span>Relations</span></label>
		<label class="aside-check"><input type="checkbox" id="rz-show-path" checked /> <span>Filepath</span></label>
		<button type="button" class="rz-btn secondary rz-clear-attr-filters" id="rz-clear-attr-filters" title="Clear all metadata key filters">Clear metadata filters</button>
		<div id="rz-attr-filter-panel" class="rz-attr-filter-panel hidden" hidden>
			<p class="aside-sub">Metadata filters</p>
			<p class="rz-attr-filter-empty hidden" id="rz-attr-filter-empty">Select a metadata type above to filter by its keys.</p>
			<div id="rz-attr-filter-body" class="rz-attr-filter-body"></div>
		</div>
	</aside>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

class DripRetrieverPanel {
	static currentPanel = undefined;

	/**
	 * @param {import('vscode').Uri} extensionUri
	 * @param {{
	 *   getKnowledgeBaseRoot?: () => import('vscode').Uri | undefined,
	 *   getRetrieverPersistedUi?: () => unknown,
	 *   saveRetrieverPersistedUi?: (data: Record<string, unknown>) => Promise<void>
	 * }} state
	 * @param {{ applyQuery?: string }} [openOpts]
	 */
	static createOrShow(extensionUri, state, openOpts) {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
		const applyQuery =
			openOpts && typeof openOpts.applyQuery === 'string' ? openOpts.applyQuery.trim() : '';

		if (DripRetrieverPanel.currentPanel) {
			try {
				DripRetrieverPanel.currentPanel.panel.reveal(column);
				tryCloseAuxiliaryBarForRetriever();
				if (applyQuery) {
					void DripRetrieverPanel.currentPanel.postQueryToWebview(applyQuery);
				}
				return;
			} catch {
				DripRetrieverPanel.currentPanel = undefined;
			}
		}

		const panel = vscode.window.createWebviewPanel(
			DRIP_RETRIEVER_PANEL_ID,
			'DRIP Retriever',
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extensionUri]
			}
		);

		DripRetrieverPanel.currentPanel = new DripRetrieverPanel(panel, state, applyQuery);
		panel.webview.html = getRetrieverPanelHtml(panel.webview, extensionUri);
		tryCloseAuxiliaryBarForRetriever();

		panel.onDidDispose(() => {
			DripRetrieverPanel.currentPanel = undefined;
		});
	}

	/**
	 * @param {import('vscode').WebviewPanel} panel
	 * @param {{
	 *   getKnowledgeBaseRoot?: () => import('vscode').Uri | undefined,
	 *   getRetrieverPersistedUi?: () => unknown,
	 *   saveRetrieverPersistedUi?: (data: Record<string, unknown>) => Promise<void>
	 * }} state
	 * @param {string} [pendingApplyQuery] applied after first catalog init
	 */
	constructor(panel, state, pendingApplyQuery) {
		this.panel = panel;
		this.state = state;
		/** @type {string} */
		this._pendingApplyAfterInit =
			typeof pendingApplyQuery === 'string' ? pendingApplyQuery.trim() : '';
		/** @type {{ rows: unknown[], metadataTypes?: unknown[], allTags?: unknown[], kbMissing?: boolean }} */
		this.catalog = { rows: [], metadataTypes: [], allTags: [], kbMissing: false };
		/** Normalized fs path for the KB root used to build {@link DripRetrieverPanel#catalog} */
		this._catalogKbKey = '';
		/** True after a full disk heading index has been built for {@link DripRetrieverPanel#_catalogKbKey}. */
		this._headingIndexReady = false;
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		this._sgTimer = undefined;
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		this._tagSugTimer = undefined;
		/** Serialize rebuild/query/suggest so concurrent webview messages cannot overlap `rebuildAndPushInit`. */
		this._retrieverCatalogChain = Promise.resolve();
		this._metaColorCfgSub = vscode.workspace.onDidChangeConfiguration(ev => {
			if (
				ev.affectsConfiguration('drip.metadataUseCustomColors') ||
				ev.affectsConfiguration('drip.metadataKeyColor') ||
				ev.affectsConfiguration('drip.metadataValueColor') ||
				ev.affectsConfiguration('drip.metadataTypeColors') ||
				ev.affectsConfiguration('drip.metadataTypes') ||
				ev.affectsConfiguration('drip.dripnoteCustomColors') ||
				ev.affectsConfiguration('drip.tagsRelationsConfig')
			) {
				void this.pushMetadataUiColors().catch(() => {});
			}
		});
		panel.onDidDispose(() => {
			try {
				this._metaColorCfgSub.dispose();
			} catch {
				/* ignore */
			}
		});
		panel.webview.onDidReceiveMessage(async message => {
			try {
				if (message?.type === 'retrieverPanelReady') {
					await this.pushLightCatalogInit();
					await this.flushPendingApplyQueryIfAny();
					return;
				}
				if (message?.type === 'retrieverRebuild') {
					void this.queueRetrieverCatalogOp(() => this.rebuildFromIndexAfterFlush()).catch(e => {
						const msg = e instanceof Error ? e.message : String(e);
						void vscode.window.showErrorMessage(`Retriever: ${msg}`);
					});
					return;
				}
				if (message?.type === 'retrieverQuery') {
					const payload = message.payload;
					void this.queueRetrieverCatalogOp(() => this.ensureCatalogMatchesKbThenQuery(payload)).catch(
						e => {
							const msg = e instanceof Error ? e.message : String(e);
							void vscode.window.showErrorMessage(`Retriever: ${msg}`);
						}
					);
					return;
				}
				if (message?.type === 'retrieverSuggest') {
					clearTimeout(this._sgTimer);
					const pl = message.payload || {};
					this._sgTimer = setTimeout(() => {
						void this.queueRetrieverCatalogOp(() => this.ensureCatalogMatchesKbThenSuggest(pl)).catch(
							e => {
								const msg = e instanceof Error ? e.message : String(e);
								void vscode.window.showErrorMessage(`Retriever: ${msg}`);
							}
						);
					}, 110);
					return;
				}
				if (message?.type === 'retrieverTagSuggest') {
					clearTimeout(this._tagSugTimer);
					const pl = message.payload || {};
					this._tagSugTimer = setTimeout(() => {
						void this.pushTagSuggestResults(pl).catch(e => {
							console.error('[DRIP] tag suggest failed', e);
						});
					}, 90);
					return;
				}
				if (message?.type === 'retrieverApplyTagGraph') {
					await this.applyTagGraphToWebview(message.payload || {});
					return;
				}
				if (message?.type === 'retrieverOpen') {
					await openRetrieverTarget(message.uri, message.line, {
						title: typeof message.title === 'string' ? message.title : '',
						headingId: Number(message.headingId) || 0
					});
					return;
				}
				if (message?.type === 'retrieverSaveUi') {
					if (this.state?.saveRetrieverPersistedUi && message.payload && typeof message.payload === 'object') {
						await this.state.saveRetrieverPersistedUi(message.payload);
					}
					return;
				}
				if (message?.type === 'retrieverReveal') {
					await revealRetrieverTargetInExplorer(message.uri);
					return;
				}
				if (message?.type === 'retrieverCopyPathLine') {
					await vscode.env.clipboard.writeText(`${message.relPath || ''}:${Number(message.line) || 1}`);
					void vscode.window.setStatusBarMessage('Copied path:line', 2000);
					return;
				}
				if (message?.type === 'retrieverCopyLLink') {
					await copyRetrieverLLink(
						this.state,
						message.uri,
						typeof message.fileId === 'string' ? message.fileId : ''
					);
					return;
				}
				if (message?.type === 'retrieverClipboardEmpty') {
					void vscode.window.showInformationMessage('Retriever has nothing to export — adjust filters or load more.');
					return;
				}
				if (message?.type === 'retrieverClipboard' && typeof message.text === 'string') {
					await vscode.env.clipboard.writeText(message.text);
					void vscode.window.setStatusBarMessage('Retriever list copied to clipboard', 2600);
					return;
				}
				if (message?.type === 'retrieverPickCustomPaths') {
					await this.pickCustomCorpusPaths(message.payload || {});
					return;
				}
				if (message?.type === 'retrieverResolveDroppedPaths') {
					await this.resolveDroppedCustomPaths(message.payload || {});
					return;
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				await vscode.window.showErrorMessage(`Retriever: ${msg}`);
			}
		});
	}

	/**
	 * Map absolute URIs to KB-relative corpus entries (reject anything outside the .driplock root).
	 * @param {import('vscode').Uri[]} uris
	 * @returns {Promise<{ path: string, kind: 'file'|'folder', name: string }[]>}
	 */
	async resolveUrisToCustomCorpusEntries(uris) {
		const kbRoot =
			typeof this.state?.getRetrieverKnowledgeBaseRoot === 'function'
				? this.state.getRetrieverKnowledgeBaseRoot().uri
				: this.state?.getKnowledgeBaseRoot?.();
		if (!kbRoot || kbRoot.scheme !== 'file') {
			void vscode.window.showWarningMessage('Pick a knowledge base (.driplock) folder first.');
			return [];
		}

		let rootResolved = kbRoot.fsPath;
		try {
			rootResolved = await fs.promises.realpath(kbRoot.fsPath);
		} catch {
			rootResolved = kbRoot.fsPath;
		}
		const rootNative = path.resolve(rootResolved);

		/** @type {{ path: string, kind: 'file'|'folder', name: string }[]} */
		const out = [];
		const seen = new Set();
		/** @type {string[]} */
		const skippedOutside = [];

		for (const uri of uris || []) {
			if (!uri || uri.scheme !== 'file') continue;

			let absResolved = uri.fsPath;
			try {
				absResolved = await fs.promises.realpath(uri.fsPath);
			} catch {
				absResolved = uri.fsPath;
			}
			const absNative = path.resolve(absResolved);

			// Strict containment under the .driplock KB root (realpath + relative; blocks escapes).
			const relCheck = path.relative(rootNative, absNative);
			const inside =
				relCheck === '' ||
				(!relCheck.startsWith('..') && !path.isAbsolute(relCheck));
			if (!inside) {
				skippedOutside.push(path.basename(uri.fsPath) || uri.fsPath);
				continue;
			}

			let kind = /** @type {'file'|'folder'} */ ('file');
			try {
				const st = await vscode.workspace.fs.stat(uri);
				kind = st.type & vscode.FileType.Directory ? 'folder' : 'file';
			} catch {
				continue;
			}

			const rel = relCheck.replace(/\\/g, '/').replace(/\/+$/, '');
			if (!rel) {
				void vscode.window.showWarningMessage(
					'Cannot add the KB (.driplock) root itself — pick a file or subfolder inside it.'
				);
				continue;
			}
			const key = rel.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				path: rel,
				kind,
				name: path.basename(rel) || rel
			});
		}

		if (skippedOutside.length) {
			const sample = skippedOutside.slice(0, 3).join(', ');
			const more = skippedOutside.length > 3 ? ` (+${skippedOutside.length - 3} more)` : '';
			void vscode.window.showWarningMessage(
				`Skipped outside the .driplock KB: ${sample}${more}`
			);
		}
		return out;
	}

	/**
	 * @param {{ mode?: string }} payload
	 */
	async pickCustomCorpusPaths(_payload) {
		const kbRoot =
			typeof this.state?.getRetrieverKnowledgeBaseRoot === 'function'
				? this.state.getRetrieverKnowledgeBaseRoot().uri
				: this.state?.getKnowledgeBaseRoot?.();
		if (!kbRoot) {
			void vscode.window.showWarningMessage('Pick a knowledge base (.driplock) folder first.');
			return;
		}
		const uris = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: true,
			canSelectMany: true,
			openLabel: 'Add from KB',
			title: 'Add files or folders from the .driplock knowledge base',
			defaultUri: kbRoot
		});
		if (!uris || !uris.length) return;
		const entries = await this.resolveUrisToCustomCorpusEntries(uris);
		if (!entries.length) return;
		await this.panel.webview.postMessage({
			type: 'retrieverCustomPathsPicked',
			payload: { entries }
		});
	}

	/**
	 * @param {{ uris?: string[] }} payload
	 */
	async resolveDroppedCustomPaths(payload) {
		const raw = Array.isArray(payload && payload.uris) ? payload.uris : [];
		/** @type {import('vscode').Uri[]} */
		const uris = [];
		for (const u of raw) {
			try {
				uris.push(vscode.Uri.parse(String(u || '')));
			} catch {
				// skip
			}
		}
		const entries = await this.resolveUrisToCustomCorpusEntries(uris);
		if (entries.length) {
			await this.panel.webview.postMessage({
				type: 'retrieverCustomPathsPicked',
				payload: { entries }
			});
		} else if (raw.length) {
			void vscode.window.showWarningMessage(
				'Nothing added — drop files or folders from inside the .driplock knowledge base only.'
			);
		}
	}

	/**
	 * @param {() => Promise<void>} fn
	 * @returns {Promise<void>}
	 */
	queueRetrieverCatalogOp(fn) {
		const run = this._retrieverCatalogChain.then(() => fn());
		this._retrieverCatalogChain = run.catch(() => {});
		return run;
	}

	/**
	 * @param {{ q?: string, limit?: number, _seq?: number, selectedTypeIds?: string[], selectedTags?: string[], scopeFiles?: boolean, scopeHeadings?: boolean }} payload
	 */
	async pushSuggestResults(payload) {
		const kbRoot =
			typeof this.state?.getRetrieverKnowledgeBaseRoot === 'function'
				? this.state.getRetrieverKnowledgeBaseRoot().uri
				: this.state?.getKnowledgeBaseRoot?.();
		const seq = typeof payload._seq === 'number' ? payload._seq : 0;
		const limRaw = Number(payload && payload.limit);
		const lim =
			Number.isFinite(limRaw) && limRaw > 0 ? Math.min(Math.floor(limRaw), 48) : 26;

		/** @type {unknown[]} */
		let items = [];
		let searchMethod = 'index';
		if (kbRoot && String((payload && payload.q) || '').trim()) {
			try {
				const { queryRetrieverFromIndex } = require('../../../indexing/embeddings/headingEmbeddingSearch');
				const result = await queryRetrieverFromIndex(kbRoot, {
					...payload,
					offset: 0,
					limit: lim
				});
				searchMethod = result.searchMethod;
				items = result.rows;
			} catch (err) {
				console.error('[DRIP] embedding suggest failed', err);
				items = [];
				searchMethod = 'error';
			}
		}

		await this.panel.webview.postMessage({
			type: 'retrieverSuggestResult',
			payload: {
				items: Array.isArray(items) ? items : [],
				_seq: seq,
				searchMethod
			}
		});
	}

	/**
	 * Sets the heading search field and re-runs the query (used by command args + Quick Pick).
	 * @param {string} query
	 */
	async postQueryToWebview(query) {
		const q = String(query || '').trim();
		if (!q) return;
		try {
			await this.panel.webview.postMessage({
				type: 'retrieverApplyQuery',
				payload: { query: q }
			});
		} catch {
			// panel may be disposing
		}
	}

	async flushPendingApplyQueryIfAny() {
		const q = this._pendingApplyAfterInit || '';
		this._pendingApplyAfterInit = '';
		if (q) {
			await this.postQueryToWebview(q);
		}
	}

	/**
	 * Keep shell in sync with KB folder; never walks `.d.txt` files for search.
	 * @param {unknown} payload
	 */
	async ensureCatalogMatchesKbThenQuery(payload) {
		const live = retrieverLiveKbRootKey(this.state);
		if (live !== this._catalogKbKey) {
			await this.pushLightCatalogInit();
		}
		await this.pushQueryResult(payload);
	}

	/**
	 * @param {{ q?: string, _seq?: number, limit?: number }} pl
	 */
	async ensureCatalogMatchesKbThenSuggest(pl) {
		const live = retrieverLiveKbRootKey(this.state);
		if (live !== this._catalogKbKey) {
			await this.pushLightCatalogInit();
		}
		await this.pushSuggestResults(pl);
	}

	/** Shell from settings + tags from `index.drip` (no note file walk).
	 * @param {{ post?: boolean }} [opts] — set `post: false` to refresh `this.catalog` only (caller posts once).
	 */
	async pushLightCatalogInit(opts) {
		const shouldPost = !opts || opts.post !== false;
		const rk =
			typeof this.state?.getRetrieverKnowledgeBaseRoot === 'function'
				? this.state.getRetrieverKnowledgeBaseRoot()
				: { uri: this.state?.getKnowledgeBaseRoot?.(), usedWorkspaceFallback: false };
		const kbRoot = rk && rk.uri;
		const usedWorkspaceFallback = Boolean(rk && rk.usedWorkspaceFallback);
		this._catalogKbKey = kbRoot ? kbRoot.fsPath.replace(/\\/g, '/').toLowerCase() : '';
		this._headingIndexReady = Boolean(kbRoot);
		this.catalog = kbRoot
			? buildRetrieverCatalogShell(kbRoot, { usedWorkspaceFallback })
			: {
					rows: [],
					metadataTypes: [],
					allTags: [],
					tagCounts: [],
					relationTypes: [],
					kbMissing: true,
					noteFilesVisited: 0,
					kbRootPath: '',
					usedWorkspaceFallback: false
			  };
		if (kbRoot) {
			try {
				const {
					listTagsFromIndex,
					listRelationTypesFromIndex
				} = require('../../../indexing/embeddings/headingEmbeddingSearch');
				const tagInfo = await listTagsFromIndex(kbRoot);
				this.catalog.allTags = tagInfo.allTags;
				this.catalog.tagCounts = tagInfo.tagCounts;
				this.catalog.relationTypes = await listRelationTypesFromIndex(kbRoot);
			} catch (err) {
				console.error('[DRIP] listTagsFromIndex failed', err);
			}
			// Type chips always come from Settings (plus webview adds “None”).
			try {
				const shell = buildRetrieverCatalogShell(kbRoot, { usedWorkspaceFallback });
				this.catalog.metadataTypes = shell.metadataTypes || [];
			} catch (err) {
				console.error('[DRIP] settings metadata types failed', err);
			}
			// Background: ensure sqlite-vec tag embeddings exist (exact only).
			void require('../../../indexing/embeddings/tagEmbeddingSync')
				.syncMissingTagEmbeddings(kbRoot)
				.catch(err => console.warn('[DRIP] tag embedding sync', err && err.message));
		}
		if (!shouldPost) {
			return;
		}
		const tagGraphs = this.listTagGraphOptions();
		const c = this.catalog;
		const metadataColors = this.syncCatalogMetadataColorsForWebview();
		const persistedUi =
			typeof this.state?.getRetrieverPersistedUi === 'function' ? this.state.getRetrieverPersistedUi() : null;
		await this.panel.webview.postMessage({
			type: 'retrieverCatalogInit',
			payload: {
				shellOnly: true,
				kbMissing: Boolean(c.kbMissing),
				metadataTypes: c.metadataTypes || [],
				allTags: c.allTags || [],
				tagCounts: Array.isArray(c.tagCounts) ? c.tagCounts.slice(0, 500) : [],
				relationTypes: Array.isArray(c.relationTypes) ? c.relationTypes : [],
				tagGraphs,
				headingsIndexed: 0,
				kbRootPath: typeof c.kbRootPath === 'string' ? c.kbRootPath : kbRoot ? kbRoot.fsPath : '',
				noteFilesVisited: 0,
				usedWorkspaceFallback: Boolean(c.usedWorkspaceFallback),
				persistedUi,
				catalogSource: 'index.drip',
				metadataColors
			}
		});
	}

	/** Resolve Settings type colors onto catalog chips + metadataColors payload (same sources as editor). */
	syncCatalogMetadataColorsForWebview() {
		const colors = this.getRetrieverMetadataUiColors();
		const types = this.catalog.metadataTypes || [];
		for (const t of types) {
			const id = String((t && t.id) || '')
				.trim()
				.toLowerCase();
			if (!id) continue;
			const resolved =
				String((colors.typeColors && colors.typeColors[id]) || '').trim() ||
				String((t && t.color) || '').trim();
			if (!resolved) continue;
			t.color = resolved;
			colors.typeColors[id] = resolved;
			const marker = String((t && t.marker) || '')
				.trim()
				.toLowerCase();
			const bare = marker.replace(/^\./, '');
			if (marker) colors.typeColors[marker] = resolved;
			if (bare) colors.typeColors[bare] = resolved;
		}
		return colors;
	}

	/** @returns {{
	 *   useCustom: boolean,
	 *   keyColor: string,
	 *   valueColor: string,
	 *   tagsColor: string,
	 *   typeColors: Record<string, string>,
	 *   markerColors: Record<string, string>
	 * }} */
	getRetrieverMetadataUiColors() {
		try {
			const {
				getMetadataColorSettings,
				getRelationsKeywordColors,
				getCustomColorMap
			} = require('../../editor/dripnoteCustomDecorations');
			const { getMetadataSettings } = require('../../../document/model/dripnoteMetadataTemplates');
			const meta = getMetadataColorSettings();
			const rel = getRelationsKeywordColors();
			/** @type {Record<string, string>} */
			const typeColors = {};
			if (meta.typeColors && typeof meta.typeColors.forEach === 'function') {
				meta.typeColors.forEach((color, id) => {
					if (id && color) typeColors[String(id).toLowerCase()] = String(color);
				});
			}
			const settings = getMetadataSettings();
			for (const t of settings.types || []) {
				const id = String((t && t.id) || '')
					.trim()
					.toLowerCase();
				const color = String((t && t.color) || '').trim();
				if (id && color) {
					// Type Color field on the metadata type wins over the colors map when both exist.
					typeColors[id] = color;
				} else if (id && typeColors[id]) {
					// keep map color
				}
				const marker = String((t && t.marker) || '')
					.trim()
					.toLowerCase();
				const resolved = (id && typeColors[id]) || '';
				if (resolved && marker) {
					typeColors[marker] = resolved;
					typeColors[marker.replace(/^\./, '')] = resolved;
				}
			}
			/** @type {Record<string, string>} */
			const markerColors = {};
			const customMap = getCustomColorMap();
			if (customMap && typeof customMap.forEach === 'function') {
				customMap.forEach((color, key) => {
					if (key && color) markerColors[String(key).toLowerCase()] = String(color);
				});
			}
			const keyColor = String(meta.keyColor || '').trim();
			const tagsColor =
				String(rel.tagsKeywordColor || '').trim() || keyColor;
			return {
				useCustom: Boolean(meta.useCustom),
				keyColor,
				valueColor: String(meta.valueColor || '').trim(),
				tagsColor,
				typeColors,
				markerColors
			};
		} catch {
			return {
				useCustom: false,
				keyColor: '',
				valueColor: '',
				tagsColor: '',
				typeColors: {},
				markerColors: {}
			};
		}
	}

	async pushMetadataUiColors() {
		await this.panel.webview.postMessage({
			type: 'retrieverMetadataColors',
			payload: this.getRetrieverMetadataUiColors()
		});
	}

	/** @returns {{ id: string, name: string }[]} */
	listTagGraphOptions() {
		try {
			const ctx = this.state && this.state.context;
			if (!ctx) return [];
			const { listStoredTagGraphs } = require('../../../graph/tagGraphStore');
			return listStoredTagGraphs(ctx).map(g => ({
				id: String(g.id),
				name: String(g.name || g.id)
			}));
		} catch {
			return [];
		}
	}

	/**
	 * Hybrid tag suggest: 3 letter matches + 5 embedding neighbors (sqlite-vec).
	 * @param {{ q?: string, exclude?: string[], _seq?: number }} payload
	 */
	async pushTagSuggestResults(payload) {
		const kbRoot =
			typeof this.state?.getRetrieverKnowledgeBaseRoot === 'function'
				? this.state.getRetrieverKnowledgeBaseRoot().uri
				: this.state?.getKnowledgeBaseRoot?.();
		const q = typeof payload.q === 'string' ? payload.q : '';
		const seq = typeof payload._seq === 'number' ? payload._seq : 0;
		const exclude = Array.isArray(payload.exclude) ? payload.exclude : [];
		/** @type {{ prefix: string[], semantic: string[] }} */
		let result = { prefix: [], semantic: [] };
		if (kbRoot && String(q || '').trim()) {
			try {
				const { suggestTagsHybrid } = require('../../../indexing/embeddings/tagEmbeddingSearch');
				result = await suggestTagsHybrid(kbRoot, q, {
					prefixLimit: 3,
					semanticLimit: 5,
					exclude
				});
			} catch (err) {
				console.error('[DRIP] suggestTagsHybrid failed', err);
			}
		} else if (kbRoot && !String(q || '').trim()) {
			// Empty query: show first tags from catalog as prefix only.
			result.prefix = (this.catalog.allTags || [])
				.filter(t => !exclude.map(x => String(x).toLowerCase()).includes(String(t).toLowerCase()))
				.slice(0, 3);
		}
		await this.panel.webview.postMessage({
			type: 'retrieverTagSuggestResult',
			payload: {
				prefix: result.prefix,
				semantic: result.semantic,
				_seq: seq
			}
		});
	}

	/**
	 * Load all labels from a saved tag graph → tag chips (soft-rank).
	 * @param {{ graphId?: string }} payload
	 */
	async applyTagGraphToWebview(payload) {
		const graphId = String((payload && payload.graphId) || '').trim();
		const ctx = this.state && this.state.context;
		/** @type {string[]} */
		let tags = [];
		if (graphId && ctx) {
			try {
				const { loadStoredTagGraphById } = require('../../../graph/tagGraphStore');
				const graph = loadStoredTagGraphById(ctx, graphId);
				const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
				const seen = new Set();
				for (const n of nodes) {
					const label = String((n && n.label) || '')
						.trim()
						.toLowerCase();
					if (!label || seen.has(label)) continue;
					seen.add(label);
					tags.push(label);
				}
			} catch (err) {
				console.error('[DRIP] applyTagGraph failed', err);
			}
		}
		await this.panel.webview.postMessage({
			type: 'retrieverApplyTagGraphResult',
			payload: {
				graphId,
				tags,
				tagMode: 'relevant'
			}
		});
	}

	/** Flush pending index writes, then reload catalog + re-query from index.drip. */
	async rebuildFromIndexAfterFlush() {
		try {
			const { flushPendingDripIndexUpdates } = require('../../../indexing/dripnoteIndexSync');
			await flushPendingDripIndexUpdates();
		} catch (err) {
			console.warn('[DRIP] Retriever refresh: index flush skipped', err && err.message);
		}
		await this.rebuildAndPushInit();
	}

	/** Refresh metadata/tags from index.drip — never walks the KB tree. */
	async rebuildAndPushInit() {
		// Load catalog silently, then post a single init (avoids double chip re-render / query).
		await this.pushLightCatalogInit({ post: false });
		const kbRoot =
			typeof this.state?.getRetrieverKnowledgeBaseRoot === 'function'
				? this.state.getRetrieverKnowledgeBaseRoot().uri
				: this.state?.getKnowledgeBaseRoot?.();
		const c = this.catalog;
		const metadataColors = this.syncCatalogMetadataColorsForWebview();
		let headingsIndexed = 0;
		if (kbRoot) {
			try {
				const { listHeadingsFromIndex } = require('../../../indexing/embeddings/headingEmbeddingSearch');
				const listed = await listHeadingsFromIndex(kbRoot, { limit: 1, offset: 0 });
				headingsIndexed = listed.total;
			} catch (err) {
				console.error('[DRIP] rebuild from index.drip failed', err);
			}
		}
		await this.panel.webview.postMessage({
			type: 'retrieverCatalogInit',
			payload: {
				shellOnly: false,
				kbMissing: Boolean(c.kbMissing),
				metadataTypes: c.metadataTypes || [],
				allTags: c.allTags || [],
				tagCounts: Array.isArray(c.tagCounts) ? c.tagCounts.slice(0, 500) : [],
				relationTypes: Array.isArray(c.relationTypes) ? c.relationTypes : [],
				tagGraphs: this.listTagGraphOptions(),
				headingsIndexed,
				kbRootPath: typeof c.kbRootPath === 'string' ? c.kbRootPath : kbRoot ? kbRoot.fsPath : '',
				noteFilesVisited: 0,
				usedWorkspaceFallback: Boolean(c.usedWorkspaceFallback),
				persistedUi:
					typeof this.state?.getRetrieverPersistedUi === 'function'
						? this.state.getRetrieverPersistedUi()
						: null,
				catalogSource: 'index.drip',
				metadataColors
			}
		});
	}

	async pushQueryResult(payload) {
		const offsetRaw = Number(payload?.offset);
		const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

		const kbRoot =
			typeof this.state?.getRetrieverKnowledgeBaseRoot === 'function'
				? this.state.getRetrieverKnowledgeBaseRoot().uri
				: this.state?.getKnowledgeBaseRoot?.();

		if (!kbRoot) {
			await this.panel.webview.postMessage({
				type: 'retrieverCatalogResult',
				payload: {
					rows: [],
					truncated: false,
					totalMatched: 0,
					offset: 0,
					loadedThrough: 0,
					pageSize: 0,
					searchMethod: 'none'
				}
			});
			return;
		}

		try {
			const { queryRetrieverFromIndex } = require('../../../indexing/embeddings/headingEmbeddingSearch');
			const result = await queryRetrieverFromIndex(kbRoot, {
				...(payload && typeof payload === 'object' ? payload : {}),
				offset
			});
			console.log(
				`[DRIP] Retriever searchMethod=${result.searchMethod} rows=${result.rows.length}/${result.totalMatched} (index.drip only)`
			);
			await this.panel.webview.postMessage({
				type: 'retrieverCatalogResult',
				payload: result
			});
		} catch (err) {
			console.error('[DRIP] Retriever index search failed', err);
			await this.panel.webview.postMessage({
				type: 'retrieverCatalogResult',
				payload: {
					rows: [],
					truncated: false,
					totalMatched: 0,
					offset,
					loadedThrough: offset,
					pageSize: 0,
					searchMethod: 'error',
					error: err && err.message ? String(err.message) : String(err)
				}
			});
		}
	}
}

/**
 * Normalize heading title for fuzzy compare (strip type marker suffixes).
 * @param {string} s
 */
function normalizeRetrieverHeadingTitle(s) {
	return String(s || '')
		.trim()
		.toLowerCase()
		.replace(/\s+\.[\w.-]+\s*$/, '')
		.replace(/\s+/g, ' ');
}

/**
 * Find 1-based line of a heading in an open document by identity (`@fN:hM`) then title.
 * @param {import('vscode').TextDocument} doc
 * @param {{ title?: string, headingId?: number }} opts
 * @returns {number} 1-based line, or 0 if not found
 */
function findRetrieverHeadingLine(doc, opts) {
	const headingId = Number(opts && opts.headingId) || 0;
	const wantTitle = normalizeRetrieverHeadingTitle((opts && opts.title) || '');
	const lineCount = doc.lineCount;

	if (headingId > 0) {
		const idRe = new RegExp(`^\\s*@+\\s*f\\d+\\s*:\\s*h${headingId}\\b`, 'i');
		for (let i = 0; i < lineCount; i++) {
			const text = doc.lineAt(i).text;
			if (!idRe.test(text)) continue;
			// Prefer the `#` heading that this identity owns (usually next few lines).
			for (let j = i; j < Math.min(i + 6, lineCount); j++) {
				if (/^\s*#{1,6}\s+\S/.test(doc.lineAt(j).text)) return j + 1;
			}
			return i + 1;
		}
	}

	if (wantTitle) {
		let softMatch = 0;
		for (let i = 0; i < lineCount; i++) {
			const m = /^(\s*)(#{1,6})\s+(.*)$/.exec(doc.lineAt(i).text);
			if (!m) continue;
			const got = normalizeRetrieverHeadingTitle(m[3]);
			if (!got) continue;
			if (got === wantTitle) return i + 1;
			if (!softMatch && (got.includes(wantTitle) || wantTitle.includes(got))) softMatch = i + 1;
		}
		if (softMatch) return softMatch;
	}

	return 0;
}

/**
 * @param {string} uriStr
 * @param {number} line 1-based fallback
 * @param {{ title?: string, headingId?: number }} [opts]
 */
async function openRetrieverTarget(uriStr, line, opts) {
	if (!uriStr || typeof uriStr !== 'string') return;
	const uri = vscode.Uri.parse(uriStr);
	const doc = await vscode.workspace.openTextDocument(uri);
	const ed = await vscode.window.showTextDocument(doc, {
		preview: false,
		// Same editor group / tab strip as the active column — not a forced split (Beside).
		viewColumn: vscode.ViewColumn.Active
	});

	const found = findRetrieverHeadingLine(doc, {
		title: opts && opts.title,
		headingId: opts && opts.headingId
	});
	const lineIndex = Math.max(0, (found || Number(line) || 1) - 1);
	const pos = new vscode.Position(lineIndex, 0);
	ed.selection = new vscode.Selection(pos, pos);
	ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/**
 * @param {string} uriStr
 */
async function revealRetrieverTargetInExplorer(uriStr) {
	if (!uriStr || typeof uriStr !== 'string') return;
	const uri = vscode.Uri.parse(uriStr);
	try {
		await vscode.commands.executeCommand('revealInExplorer', uri);
	} catch {
		try {
			await vscode.commands.executeCommand('explorerResourceReveal', uri, true);
		} catch {
			void vscode.window.showWarningMessage('Could not reveal file in Explorer for this workspace.');
		}
	}
}

/**
 * Relative href from anchor file dir to target, same pattern as dripnote reference inserts.
 */
function relPathHref(fromFileFs, toFileFs) {
	const fromDir = path.dirname(fromFileFs);
	let rel = path.relative(fromDir, toFileFs).replace(/\\/g, '/');
	return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * @param {{
 *   getKnowledgeBaseRoot?: () => import('vscode').Uri | undefined
 * }} state
 * @param {string} uriStr file:// target note
 * @param {string} [preResolvedFileId] from catalog when known
 */
async function copyRetrieverLLink(state, uriStr, preResolvedFileId) {
	if (!uriStr || typeof uriStr !== 'string') return;
	const targetUri = vscode.Uri.parse(uriStr);
	const kb =
		typeof state.getRetrieverKnowledgeBaseRoot === 'function'
			? state.getRetrieverKnowledgeBaseRoot().uri
			: state.getKnowledgeBaseRoot?.();
	let href = '';
	const ed = vscode.window.activeTextEditor;
	if (
		ed &&
		ed.document &&
		ed.document.uri.scheme === 'file' &&
		ed.document.uri.fsPath !== targetUri.fsPath
	) {
		href = relPathHref(ed.document.uri.fsPath, targetUri.fsPath);
	} else if (kb && targetUri.scheme === 'file') {
		const rel = path.relative(kb.fsPath, targetUri.fsPath).replace(/\\/g, '/');
		href = rel.startsWith('.') ? rel : `./${rel}`;
	} else if (targetUri.scheme === 'file') {
		href = targetUri.fsPath.replace(/\\/g, '/');
	}

	let fileId = String(preResolvedFileId || '').trim();
	if (!fileId) {
		try {
			const text = await readTextFile(targetUri);
			fileId = extractFileIdFromHeader(text);
		} catch {
			fileId = '';
		}
	}

	const base = targetUri.scheme === 'file' ? path.basename(targetUri.fsPath) : '';
	const stem = base ? stripKbNoteExtension(base) : 'note';
	const targetLabel = `${stem} - ${fileId || '@unknown'}`;
	await vscode.env.clipboard.writeText(`L. ![${targetLabel}](${href})`);
	void vscode.window.setStatusBarMessage('Copied L. reference', 2800);
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let _retrieverSaveDebounce;

/**
 * When the Retriever panel is open, debounce-rebuild the catalog after KB note saves.
 * @param {import('vscode').ExtensionContext} context
 * @param {{ getKnowledgeBaseRoot?: () => import('vscode').Uri | undefined }} state
 */
function registerRetrieverAutoRefresh(context, state) {
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(doc => {
			if (!DripRetrieverPanel.currentPanel) {
				return;
			}
			const kb =
				typeof state.getRetrieverKnowledgeBaseRoot === 'function'
					? state.getRetrieverKnowledgeBaseRoot().uri
					: state.getKnowledgeBaseRoot?.();
			if (!kb) {
				return;
			}
			const rel = path.relative(kb.fsPath, doc.uri.fsPath).replace(/\\/g, '/');
			if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
				return;
			}
			if (isIndexerNotePath(rel)) {
				return;
			}
			const base = path.basename(doc.uri.fsPath);
			if (!fileNameMatchesKbNote(base, getKbNoteExtensions())) {
				return;
			}
			clearTimeout(_retrieverSaveDebounce);
			_retrieverSaveDebounce = setTimeout(() => {
				const panel = DripRetrieverPanel.currentPanel;
				if (panel && panel._headingIndexReady) {
					void panel.rebuildAndPushInit();
				}
			}, 650);
		})
	);
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let _retrieverCfgDebounce;

/** Re-scan disk and push a fresh catalog to the Retriever webview when the panel is visible. */
function refreshRetrieverCatalogIfShown() {
	const panel = DripRetrieverPanel.currentPanel;
	if (!panel) return;
	if (panel._headingIndexReady) {
		void panel.rebuildAndPushInit();
	} else {
		void panel.pushLightCatalogInit();
	}
}

/**
 * Debounced rebuild when settings that affect headings / markers / scanned extensions change.
 * @param {number} [ms]
 */
function scheduleRetrieverCatalogRebuildIfShown(ms) {
	const delay = typeof ms === 'number' ? ms : 450;
	const panel = DripRetrieverPanel.currentPanel;
	if (!panel) return;
	clearTimeout(_retrieverCfgDebounce);
	_retrieverCfgDebounce = setTimeout(() => {
		_retrieverCfgDebounce = undefined;
		refreshRetrieverCatalogIfShown();
	}, delay);
}

module.exports = {
	DripRetrieverPanel,
	getRetrieverPanelHtml,
	registerRetrieverAutoRefresh,
	openRetrieverHeading: openRetrieverTarget,
	refreshRetrieverCatalogIfShown,
	scheduleRetrieverCatalogRebuildIfShown
};
