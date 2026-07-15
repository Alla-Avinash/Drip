'use strict';

const path = require('path');
const vscode = require('vscode');
const { DRIP_RETRIEVER_PANEL_ID } = require('../../../shared/constants');
const { getNonce } = require('../../../shared/utils');
const {
	buildRetrieverIndex,
	buildRetrieverCatalogShell,
	queryRetrieverCatalog,
	isIndexerNotePath,
	peekRetrieverSuggestions
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

/**
 * Full heading scan is deferred until the search box has text or the client pages results (`offset` > 0).
 * Type/tag/scope UI does not trigger scanning by itself.
 * @param {unknown} payload
 */
function retrieverPayloadRequiresHeadingScan(payload) {
	const p = payload && typeof payload === 'object' ? payload : {};
	const q = typeof p.q === 'string' ? p.q.trim() : '';
	if (q.length > 0) return true;
	const off = Number(p.offset);
	if (Number.isFinite(off) && off > 0) return true;
	return false;
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
			<div class="rz-scope-checks" role="group" aria-label="Files and headings">
				<label class="rz-scope-check-label"><input type="checkbox" id="rz-scope-files" checked /> Files</label>
				<label class="rz-scope-check-label"><input type="checkbox" id="rz-scope-headings" checked /> Headings</label>
			</div>
		</div>
		<div class="toolbar">
			<div class="search-wrap rz-search-slot">
				<input id="rz-heading-search" class="search-input" type="text" placeholder="Search all headings…" autocomplete="off" spellcheck="false" aria-expanded="false" aria-controls="rz-suggest-panel" aria-autocomplete="list" />
				<div id="rz-suggest-panel" class="rz-suggest-panel hidden" role="listbox" aria-label="Heading matches"></div>
			</div>
			<button type="button" class="rz-btn secondary" id="rz-clear-filters" title="Clear search, scope (Files/Headings), metadata types, and tags">Clear filters</button>
			<button type="button" class="rz-btn secondary" id="rz-refresh" title="Rebuild catalog from disk">Refresh</button>
			<button type="button" class="rz-btn secondary" id="rz-copy-md" title="Copy visible results as Markdown" disabled>Copy list</button>
		</div>
		<div id="rz-kb-banner" class="rz-banner" hidden>
			No knowledge base root is configured. Pick a KB folder from DRIP Storage.
		</div>
		<div class="filter-bar">
			<div class="filter-block">
				<span class="filter-label">Metadata types</span>
				<p id="rz-types-empty-hint" class="rz-inline-hint hidden">No types configured. Add templates in <strong>DRIP Settings</strong> (Metadata types).</p>
				<p class="rz-inline-hint">Tap types to keep only headings that use <strong>any</strong> of the selected markers (OR). Tap again to turn a type off. With none selected, all types show.</p>
				<div id="rz-type-chips" class="chip-row" role="toolbar" aria-label="Filter by metadata type"></div>
			</div>
			<div class="filter-block">
				<span class="filter-label">Tags (must have all)</span>
				<div class="tag-input-row">
					<input id="rz-tag-input" class="rz-tag-entry" list="rz-tag-list" placeholder="Pick or type tag, Enter to add…" autocomplete="off" spellcheck="false" />
					<datalist id="rz-tag-list"></datalist>
				</div>
				<div id="rz-tag-chips" class="chip-row" aria-live="polite"></div>
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
				<option value="type">Type</option>
			</select>
		</div>
		<div class="aside-field">
			<label for="rz-sort-by">Sort</label>
			<select id="rz-sort-by" class="rz-select">
				<option value="recent" selected>Recently modified</option>
				<option value="title">Title A–Z</option>
				<option value="path">Path</option>
			</select>
		</div>
		<p class="aside-sub">Shown in results</p>
		<label class="aside-check"><input type="checkbox" id="rz-show-bc" checked /> <span>Breadcrumbs</span></label>
		<label class="aside-check"><input type="checkbox" id="rz-show-path" checked /> <span>Path &amp; line</span></label>
		<label class="aside-check"><input type="checkbox" id="rz-show-type" checked /> <span>Type marker</span></label>
		<label class="aside-check"><input type="checkbox" id="rz-show-tags" /> <span>Tags on row</span></label>
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
		/** Serialize rebuild/query/suggest so concurrent webview messages cannot overlap `rebuildAndPushInit`. */
		this._retrieverCatalogChain = Promise.resolve();
		panel.webview.onDidReceiveMessage(async message => {
			try {
				if (message?.type === 'retrieverPanelReady') {
					await this.pushLightCatalogInit();
					await this.flushPendingApplyQueryIfAny();
					return;
				}
				if (message?.type === 'retrieverRebuild') {
					void this.queueRetrieverCatalogOp(() => this.rebuildAndPushInit()).catch(e => {
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
				if (message?.type === 'retrieverOpen') {
					await openRetrieverTarget(message.uri, message.line);
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
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				await vscode.window.showErrorMessage(`Retriever: ${msg}`);
			}
		});
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
	 * @param {{ q?: string, limit?: number, _seq?: number }} payload
	 */
	pushSuggestResults(payload) {
		const rows = Array.isArray(this.catalog?.rows) ? this.catalog.rows : [];
		/** @type {unknown[]} */
		let items = [];
		try {
			const limRaw = Number(payload && payload.limit);
			const lim =
				Number.isFinite(limRaw) && limRaw > 0 ? Math.min(Math.floor(limRaw), 48) : 26;
			items = peekRetrieverSuggestions(rows, {
				q: typeof payload.q === 'string' ? payload.q : '',
				limit: lim
			});
		} catch {
			items = [];
		}
		void this.panel.webview.postMessage({
			type: 'retrieverSuggestResult',
			payload: {
				items: Array.isArray(items) ? items : [],
				_seq: typeof payload._seq === 'number' ? payload._seq : 0
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
	 * Re-scan if the user changed the KB folder (sidebar) since the last catalog build.
	 * @param {unknown} payload
	 */
	async ensureCatalogMatchesKbThenQuery(payload) {
		const live = retrieverLiveKbRootKey(this.state);
		if (live !== this._catalogKbKey) {
			await this.pushLightCatalogInit();
		}
		if (retrieverPayloadRequiresHeadingScan(payload) && !this._headingIndexReady) {
			await this.rebuildAndPushInit();
		}
		this.pushQueryResult(payload);
	}

	/**
	 * @param {{ q?: string, _seq?: number, limit?: number }} pl
	 */
	async ensureCatalogMatchesKbThenSuggest(pl) {
		const live = retrieverLiveKbRootKey(this.state);
		if (live !== this._catalogKbKey) {
			await this.pushLightCatalogInit();
		}
		if (retrieverPayloadRequiresHeadingScan(pl || {}) && !this._headingIndexReady) {
			await this.rebuildAndPushInit();
		}
		this.pushSuggestResults(pl);
	}

	/** KB metadata shell only (no heading scan). Clears in-memory heading rows until search text or paging. */
	async pushLightCatalogInit() {
		const rk =
			typeof this.state?.getRetrieverKnowledgeBaseRoot === 'function'
				? this.state.getRetrieverKnowledgeBaseRoot()
				: { uri: this.state?.getKnowledgeBaseRoot?.(), usedWorkspaceFallback: false };
		const kbRoot = rk && rk.uri;
		const usedWorkspaceFallback = Boolean(rk && rk.usedWorkspaceFallback);
		this._catalogKbKey = kbRoot ? kbRoot.fsPath.replace(/\\/g, '/').toLowerCase() : '';
		this._headingIndexReady = false;
		this.catalog = kbRoot
			? buildRetrieverCatalogShell(kbRoot, { usedWorkspaceFallback })
			: /** @type {Awaited<ReturnType<typeof buildRetrieverIndex>>} */ ({
					rows: [],
					metadataTypes: [],
					allTags: [],
					tagCounts: [],
					kbMissing: true,
					noteFilesVisited: 0,
					kbRootPath: '',
					usedWorkspaceFallback: false
			  });
		const c = this.catalog;
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
				headingsIndexed: 0,
				kbRootPath: typeof c.kbRootPath === 'string' ? c.kbRootPath : kbRoot ? kbRoot.fsPath : '',
				noteFilesVisited: 0,
				usedWorkspaceFallback: Boolean(c.usedWorkspaceFallback),
				persistedUi
			}
		});
	}

	async rebuildAndPushInit() {
		const rk =
			typeof this.state?.getRetrieverKnowledgeBaseRoot === 'function'
				? this.state.getRetrieverKnowledgeBaseRoot()
				: { uri: this.state?.getKnowledgeBaseRoot?.(), usedWorkspaceFallback: false };
		const kbRoot = rk && rk.uri;
		const usedWorkspaceFallback = Boolean(rk && rk.usedWorkspaceFallback);
		this._catalogKbKey = kbRoot ? kbRoot.fsPath.replace(/\\/g, '/').toLowerCase() : '';
		try {
			this.catalog = kbRoot
				? await buildRetrieverIndex(kbRoot, { usedWorkspaceFallback })
				: /** @type {Awaited<ReturnType<typeof buildRetrieverIndex>>} */ ({
						rows: [],
						metadataTypes: [],
						allTags: [],
						tagCounts: [],
						kbMissing: true,
						noteFilesVisited: 0,
						kbRootPath: '',
						usedWorkspaceFallback: false
				  });
			this._headingIndexReady = Boolean(kbRoot && !this.catalog.kbMissing);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			await vscode.window.showErrorMessage(`Retriever catalog build failed: ${msg}`);
			this._headingIndexReady = false;
			this.catalog = {
				rows: [],
				metadataTypes: [],
				allTags: [],
				tagCounts: [],
				kbMissing: true,
				noteFilesVisited: 0,
				kbRootPath: kbRoot ? kbRoot.fsPath : '',
				usedWorkspaceFallback
			};
		}
		const c = this.catalog;
		const persistedUi =
			typeof this.state?.getRetrieverPersistedUi === 'function' ? this.state.getRetrieverPersistedUi() : null;
		await this.panel.webview.postMessage({
			type: 'retrieverCatalogInit',
			payload: {
				shellOnly: false,
				kbMissing: Boolean(c.kbMissing),
				metadataTypes: c.metadataTypes || [],
				allTags: c.allTags || [],
				tagCounts: Array.isArray(c.tagCounts) ? c.tagCounts.slice(0, 500) : [],
				headingsIndexed: Array.isArray(c.rows) ? c.rows.length : 0,
				kbRootPath: typeof c.kbRootPath === 'string' ? c.kbRootPath : kbRoot ? kbRoot.fsPath : '',
				noteFilesVisited: Number(c.noteFilesVisited) || 0,
				usedWorkspaceFallback: Boolean(c.usedWorkspaceFallback),
				persistedUi
			}
		});
	}

	pushQueryResult(payload) {
		const rows = Array.isArray(this.catalog?.rows) ? this.catalog.rows : [];
		const sortBy =
			payload && typeof payload.sortBy === 'string' && payload.sortBy.trim()
				? payload.sortBy.trim()
				: 'recent';
		const groupBy =
			payload && typeof payload.groupBy === 'string' && payload.groupBy.trim()
				? payload.groupBy.trim()
				: 'none';
		const q = payload && typeof payload.q === 'string' ? payload.q : '';
		const offsetRaw = Number(payload?.offset);
		const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
		const limitRaw = Number(payload?.limit);
		const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined;
		const result = queryRetrieverCatalog(rows, {
			q,
			sortBy,
			groupBy,
			offset,
			limit
		});
		void this.panel.webview.postMessage({
			type: 'retrieverCatalogResult',
			payload: result
		});
	}
}

/**
 * @param {string} uriStr
 * @param {number} line 1-based
 */
async function openRetrieverTarget(uriStr, line) {
	if (!uriStr || typeof uriStr !== 'string') return;
	const uri = vscode.Uri.parse(uriStr);
	const doc = await vscode.workspace.openTextDocument(uri);
	const ed = await vscode.window.showTextDocument(doc, {
		preview: false,
		// Same editor group / tab strip as the active column — not a forced split (Beside).
		viewColumn: vscode.ViewColumn.Active
	});
	const lineIndex = Math.max(0, (Number(line) || 1) - 1);
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
