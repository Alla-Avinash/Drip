'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { getDripMdEditorHtml } = require('./dripMdEditorHtml');
const { getMetadataTemplateConfig } = require('../../../document/model/dripnoteMetadataTemplates');
const { isPathInsideProjectFolder } = require('../../../document/model/dripProjectFolder');
const { kbRootFor, projectFolderPrefixForNote, listTagsForNote, createTagForNote } = require('../../../graph/noteTagScope');

/**
 * Document metadata types a `.d.md` heading may use, filtered by where the note lives:
 * a normal KB offers `concept` + `task`; a note inside a project/feature folder also gets
 * `issue`. (Project/feature are file-level types for index notes, never heading types.)
 * @param {string} [noteFsPath]
 * @returns {Set<string>}
 */
function mdHeadingTypeIdsForPath(noteFsPath) {
	const allowed = new Set(['concept', 'task']);
	if (isPathInsideProjectFolder(noteFsPath)) {
		allowed.add('issue');
	}
	return allowed;
}

/**
 * Build a plain, JSON-serializable snapshot of the metadata schema for the webview.
 * `getMetadataTemplateConfig()` returns Maps/Sets for lookup, so we pass only the
 * compact `types` list (filtered to what this note's context allows) plus the allowed
 * relations as an array — everything the chip picker needs, nothing it doesn't.
 * @param {string} [noteFsPath]
 * @returns {{ types: object[], allowedRelations: string[] }}
 */
function buildMdEditorSchema(noteFsPath) {
	const cfg = getMetadataTemplateConfig();
	const allowed = mdHeadingTypeIdsForPath(noteFsPath);
	return {
		types: (Array.isArray(cfg.types) ? cfg.types : []).filter(t => allowed.has(String(t.id || '').toLowerCase())),
		allowedRelations: Array.from(cfg.allowedRelations || [])
	};
}

/**
 * Custom editor for `.d.md` markdown notes.
 *
 * Replaces the default plain-text editor with a webview running CodeMirror 6 with
 * markdown syntax highlighting (the same editor engine Obsidian is built on). It only
 * loads and saves the file text — no DRIP index, links, tags, or other components are
 * wired into it, so it behaves as a self-contained markdown editor.
 */
class DripMdEditorProvider {
	static viewType = 'drip.mdEditor';

	/**
	 * @param {import('vscode').ExtensionContext} context
	 */
	constructor(context) {
		this.context = context;
	}

	/**
	 * @param {import('vscode').TextDocument} document
	 * @param {import('vscode').WebviewPanel} webviewPanel
	 * @param {import('vscode').CancellationToken} _token
	 */
	async resolveCustomTextEditor(document, webviewPanel, _token) {
		// Allow the webview to load images relative to the document's directory (and the
		// containing workspace folder when there is one), so `![alt](./img.png)` resolves.
		const localRoots = [this.context.extensionUri];
		const folder = vscode.workspace.getWorkspaceFolder(document.uri);
		if (folder) localRoots.push(folder.uri);
		else localRoots.push(vscode.Uri.joinPath(document.uri, '..'));
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: localRoots
		};
		try {
			webviewPanel.webview.html = getDripMdEditorHtml(
				webviewPanel.webview,
				this.context.extensionUri,
				document.uri,
				document.getText(),
				buildMdEditorSchema(document.uri.fsPath)
			);
		} catch (err) {
			// Never leave the panel silently blank — surface the host-side failure.
			const msg = err instanceof Error ? err.message : String(err);
			webviewPanel.webview.html = `<!DOCTYPE html><html><body style="padding:12px;font-family:sans-serif;color:#f14c4c">DRIP editor failed to start: ${msg}</body></html>`;
			console.error('[DRIP] md editor html failed', err);
		}

		const updateWebview = () => {
			void webviewPanel.webview.postMessage({
				type: 'update',
				text: document.getText()
			});
		};

		// Keep the webview in sync when the document changes on disk or in another editor.
		const changeSubscription = vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.toString() === document.uri.toString()) {
				updateWebview();
			}
		});

		// Re-send the metadata schema when DRIP settings change, so the chip picker
		// always reflects the latest types/attributes without reopening the note.
		const settingsSubscription = vscode.workspace.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration('drip')) return;
			void webviewPanel.webview.postMessage({ type: 'schema', ...buildMdEditorSchema(document.uri.fsPath) });
		});

		webviewPanel.onDidDispose(() => {
			changeSubscription.dispose();
			settingsSubscription.dispose();
		});

		// Route keyboard input into the webview once the panel is the active editor.
		webviewPanel.onDidChangeViewState(e => {
			if (e.webviewPanel.visible && e.webviewPanel.active) {
				void webviewPanel.webview.postMessage({ type: 'focus' });
			}
		});

		webviewPanel.webview.onDidReceiveMessage(async message => {
			switch (message.type) {
				case 'ready':
					// The editor is mounted; send it the current file content, then focus it.
					updateWebview();
					void webviewPanel.webview.postMessage({ type: 'focus' });
					break;
				case 'edit':
					await this.applyEdit(document, String(message.text || ''));
					break;
				case 'resolve-image':
					this.resolveImage(webviewPanel.webview, document, message);
					break;
				case 'tags-list':
					{
						const tags = await listTagsForNote(this.context, document.uri.fsPath);
						await webviewPanel.webview.postMessage({ type: 'tags-list', tags });
					}
					break;
				case 'create-tag':
					{
						const name = String(message.tag || '').trim();
						if (name) {
							const tags = await createTagForNote(this.context, document.uri.fsPath, name);
							await webviewPanel.webview.postMessage({ type: 'tags-list', tags });
						}
					}
					break;
				case 'tags-search':
					{
						// Semantic tag matches for the search box. Only KB notes have tag
						// embeddings; project notes keep their (per-project) tags word-only.
						const query = String(message.query || '').trim();
						const kbRoot = kbRootFor(this.context);
						const prefix = kbRoot ? projectFolderPrefixForNote(kbRoot, document.uri.fsPath) : '';
						let semantic = [];
						if (query && kbRoot && !prefix) {
							try {
								const { suggestTagsHybrid } = require('../../../indexing/embeddings/tagEmbeddingSearch');
								const res = await suggestTagsHybrid(kbRoot, query, { semanticLimit: 3 });
								semantic = Array.isArray(res.semantic) ? res.semantic : [];
							} catch (err) {
								console.warn('[DRIP] tag semantic search failed', err && err.message);
							}
						}
						await webviewPanel.webview.postMessage({ type: 'tags-search', query, semantic });
					}
					break;
			}
		});
	}

	/**
	 * Replace the whole document with the edited text.
	 * @param {import('vscode').TextDocument} document
	 * @param {string} text
	 */
	async applyEdit(document, text) {
		const edit = new vscode.WorkspaceEdit();
		edit.replace(
			document.uri,
			new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
			text
		);
		await vscode.workspace.applyEdit(edit);
	}

	/**
	 * Resolve a relative/absolute image src (from `![alt](src)`) against the document's
	 * directory and map it to a webview file URI the page is allowed to load. Empty uri
	 * means the path couldn't be resolved (missing file), so the editor keeps its placeholder.
	 * @param {import('vscode').Webview} webview
	 * @param {import('vscode').TextDocument} document
	 * @param {{ src?: string }} message
	 */
	resolveImage(webview, document, message) {
		const src = String(message.src || '');
		let uri = '';
		try {
			const abs = path.resolve(path.dirname(document.uri.fsPath), src);
			if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
				uri = webview.asWebviewUri(vscode.Uri.file(abs)).toString();
			}
		} catch {
			uri = '';
		}
		void webview.postMessage({ type: 'resolved-image', src, uri });
	}
}

module.exports = { DripMdEditorProvider };
