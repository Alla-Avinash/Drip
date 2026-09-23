'use strict';

/**
 * RHS Heading webview host.
 *
 * Responsibilities only:
 * - resolve webview HTML
 * - route messages (autosave / delete / copy id)
 * - build form payload from a persistent zone
 *
 * Session chrome → headingFormSession.js
 * Buffer writes → headingFormApply.js
 * Soft-lock → views/editor/persistentHeadingSoftLock.js
 */

const vscode = require('vscode');
const path = require('path');
const { DRIP_HEADING_FORM_VIEW_ID } = require('../../../shared/constants');
const { getHeadingFormWebviewHtml } = require('./headingFormHtml');
const { getHeadingEditModes } = require('../../../document/model/headingEditModes');
const { getMetadataSettings } = require('../../../document/model/dripnoteMetadataTemplates');
const { findPersistentZoneAtLine } = require('../../../document/model/persistentHeadingZones');
const { listTagsFromIndex } = require('../../../indexing/embeddings/headingEmbeddingSearch');
const { listKnownTagLabelsForCompletion } = require('../../editor/dripnoteTagCompletion');
const session = require('./headingFormSession');
const {
	applyHeadingFormModelFromMessage,
	isHeadingFormApplyActive
} = require('./headingFormApply');

/** @type {import('vscode').ExtensionContext | undefined} */
let extensionContext;

/**
 * @param {import('vscode').ExtensionContext} context
 */
function setHeadingFormExtensionContext(context) {
	extensionContext = context;
}

/**
 * @param {string[]} list
 * @returns {string[]}
 */
function uniqueTagNames(list) {
	const seen = new Set();
	const out = [];
	for (const raw of list || []) {
		const t = String(raw || '').trim();
		if (!t) continue;
		const low = t.toLowerCase();
		if (seen.has(low)) continue;
		seen.add(low);
		out.push(t);
	}
	return out;
}

/**
 * Collect tag tokens from `tags: […]` / `rel: […]` / shorthand `[…]` lines in a note.
 * @param {string} text
 * @returns {string[]}
 */
function extractTagTokensFromText(text) {
	/** @type {string[]} */
	const out = [];
	const pushInner = inner => {
		for (const part of String(inner || '').split(',')) {
			const t = part.trim();
			if (t) out.push(t);
		}
	};
	for (const raw of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
		const t = raw.trim();
		if (!t || t.startsWith('//')) continue;
		const kv = t.match(/^[A-Za-z][A-Za-z0-9_-]*\s*:\s*\[([^\]]*)\]/);
		if (kv) {
			pushInner(kv[1]);
			continue;
		}
		const short = t.match(/^\[([^\]]*)\]\s*$/);
		if (short) pushInner(short[1]);
	}
	return out;
}

/**
 * Same sources as in-editor tag intellisense (graphs + index + current file).
 * @param {import('vscode').TextDocument} doc
 * @returns {Promise<string[]>}
 */
async function collectKnownTagsForDoc(doc) {
	const text = doc.getText();
	const fromGraphs = extensionContext
		? listKnownTagLabelsForCompletion(extensionContext, text)
		: extractTagTokensFromText(text);
	/** @type {string[]} */
	let fromIndex = [];
	try {
		const wf = vscode.workspace.getWorkspaceFolder(doc.uri);
		const kbUri =
			(wf && wf.uri) ||
			(doc.uri.scheme === 'file' ? vscode.Uri.file(path.dirname(doc.uri.fsPath)) : undefined);
		if (kbUri) {
			const info = await listTagsFromIndex(kbUri);
			fromIndex = Array.isArray(info.allTags) ? info.allTags : [];
		}
	} catch {
		/* index may be unavailable */
	}
	return uniqueTagNames([...fromGraphs, ...fromIndex]);
}

/**
 * @param {import('vscode').TextDocument} doc
 * @param {number} line
 * @param {string[]} [knownTags]
 */
function buildPayloadForLine(doc, line, knownTags) {
	const modes = getHeadingEditModes();
	if (!modes.showRhsForm) return null;
	const settings = getMetadataSettings();
	const zone = findPersistentZoneAtLine(doc.getText(), line, settings);
	// Non-persistent headings never drive the RHS form.
	if (!zone || !zone.persistent || !zone.readyForRhs) return null;

	const types = (settings.types || []).map(t => ({
		id: t.id,
		marker: t.marker,
		shortcut: t.shortcut,
		attributes: t.attributes || {}
	}));
	/** @type {Record<string, string>} */
	const attributes = { ...(zone.attributes || {}) };
	if (zone.typeId) {
		const tdef = types.find(t => String(t.id || '').toLowerCase() === zone.typeId);
		const attrs = tdef && tdef.attributes ? tdef.attributes : {};
		for (const key of Object.keys(attrs)) {
			if (attributes[key] == null) attributes[key] = '';
		}
	}
	return {
		softLock: modes.softLockPersistent,
		documentUri: doc.uri.toString(),
		headingLine: zone.headingLine,
		lockStart: zone.lockStart,
		lockEndExclusive: zone.lockEndExclusive,
		identityLine: zone.identityLine,
		tabDepth: zone.tabDepth,
		level: zone.level,
		titleDisplay: zone.titleDisplay,
		typePrefix: zone.typePrefix,
		typeId: zone.typeId,
		identityText: zone.identityText,
		attributes,
		tags: zone.tags,
		relations: zone.relations,
		special: zone.special,
		types,
		relationNames: [...(settings.allowedRelations || [])],
		knownTags: Array.isArray(knownTags) ? knownTags : []
	};
}

/**
 * @param {import('vscode').TextEditor | undefined} editor
 * @param {number} [line]
 * @param {{ reveal?: boolean }} [opts]
 */
async function syncHeadingFormFromEditor(editor, line, opts = {}) {
	const modes = getHeadingEditModes();
	if (!modes.showRhsForm || !editor || !editor.document) {
		session.setBound(null);
		await session.postToForm({ type: 'headingFormClear' });
		return;
	}
	const doc = editor.document;
	const p = String(doc.uri.fsPath || '').toLowerCase();
	if (doc.languageId !== 'dripnote' && !p.endsWith('.d.txt')) {
		session.setBound(null);
		await session.postToForm({ type: 'headingFormClear' });
		return;
	}
	const lineNo = typeof line === 'number' ? line : editor.selection.active.line;
	const knownTags = await collectKnownTagsForDoc(doc);
	const payload = buildPayloadForLine(doc, lineNo, knownTags);
	if (!payload) {
		session.setBound(null);
		await session.postToForm({ type: 'headingFormClear' });
		return;
	}
	session.setBound({
		uri: payload.documentUri,
		headingLine: payload.headingLine,
		identityText: payload.identityText
	});

	// First open: webview may not exist yet — open bar, wait for resolve, then load.
	if (opts.reveal || !session.getWebview()) {
		if (opts.reveal) await session.openHeadingSidebar();
		else await session.waitForWebview(800);
	}
	await session.postToForm({ type: 'headingFormLoad', payload });
	if (opts.reveal && session.getWebview()) {
		// Already opened above when needed; ensure visible without stealing caret again.
		session.markOpened();
	}
}

async function requestHeadingFormFlush() {
	await session.postToForm({ type: 'headingFormFlush' });
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
function registerHeadingFormAutoFlush(context) {
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(async ed => {
			if (session.shouldSuppressClose()) return;
			await requestHeadingFormFlush();
			const b = session.getBound();
			if (!b) return;
			// Focus moved to RHS webview / other UI — keep form bound to the note.
			if (!ed || !ed.document) return;
			const nextUri = ed.document.uri.toString();
			if (nextUri !== b.uri) await session.closeHeadingSidebar();
		}),
		vscode.window.onDidChangeTextEditorSelection(async e => {
			if (session.shouldSuppressClose()) return;
			if (isHeadingFormApplyActive()) return;
			const b = session.getBound();
			if (!b) return;
			if (!session.isViewVisible()) {
				await requestHeadingFormFlush();
				await session.closeHeadingSidebar();
				return;
			}
			const editor = e.textEditor;
			if (!editor || editor.document.uri.toString() !== b.uri) {
				await requestHeadingFormFlush();
				await session.closeHeadingSidebar();
				return;
			}
			const zone = findPersistentZoneAtLine(editor.document.getText(), editor.selection.active.line);
			if (zone && zone.persistent && zone.headingLine === b.headingLine) return;
			await requestHeadingFormFlush();
			await session.closeHeadingSidebar();
		})
	);
}

class DripHeadingFormWebviewProvider {
	/** @param {import('vscode').Uri} extensionUri */
	constructor(extensionUri) {
		this.extensionUri = extensionUri;
	}

	/** @param {import('vscode').WebviewView} webviewView */
	resolveWebviewView(webviewView) {
		session.attachView(webviewView);
		const w = webviewView.webview;
		w.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
		w.html = getHeadingFormWebviewHtml(w, this.extensionUri);

		w.onDidReceiveMessage(async message => {
			try {
				switch (message.type) {
					case 'headingFormReady':
						session.flushPendingMessage();
						break;
					case 'headingFormCopyId': {
						const id = String(message.id || '').trim();
						if (id) await vscode.env.clipboard.writeText(id);
						break;
					}
					case 'headingFormAutosave':
					case 'headingFormApply':
						await applyHeadingFormModelFromMessage(message.model || {});
						break;
					case 'headingFormDelete': {
						const model = message.model || {};
						const uriStr = String(model.documentUri || (session.getBound() && session.getBound().uri) || '');
						let editor = vscode.window.activeTextEditor;
						if (uriStr && (!editor || editor.document.uri.toString() !== uriStr)) {
							editor = vscode.window.visibleTextEditors.find(
								ed => ed.document.uri.toString() === uriStr
							);
						}
						if (!editor) break;
						const pick = await vscode.window.showWarningMessage(
							'Delete this persistent heading and its metadata?',
							{ modal: true },
							'Delete',
							'Cancel'
						);
						if (pick !== 'Delete') break;
						const start = Number(model.identityLine >= 0 ? model.identityLine : model.headingLine);
						const end = Number(model.lockEndExclusive);
						if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) break;
						const { runAsHeadingFormApply } = require('./headingFormApply');
						await runAsHeadingFormApply(async () => {
							await editor.edit(eb => {
								eb.delete(new vscode.Range(start, 0, end, 0));
							});
						});
						await session.closeHeadingSidebar();
						break;
					}
					default:
						break;
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				void vscode.window.showErrorMessage(`DRIP Heading form: ${msg}`);
			}
		});
	}
}

module.exports = {
	DripHeadingFormWebviewProvider,
	DRIP_HEADING_FORM_VIEW_ID,
	revealDripHeadingFormView: session.openHeadingSidebar,
	syncHeadingFormFromEditor,
	requestHeadingFormFlush,
	registerHeadingFormAutoFlush,
	closeDripHeadingSidebar: session.closeHeadingSidebar,
	markHeadingFormJustOpened: session.markOpened,
	isHeadingFormApplyActive,
	buildPayloadForLine,
	setHeadingFormExtensionContext
};
