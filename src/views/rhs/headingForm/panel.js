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
const { getHeadingEditModes } = require('../../../document/model/dripTxt/dripTxtHeadingEditModes');
const { getMetadataSettingsForNotePath } = require('../../../document/model/dripNoteMetadataTemplates.js');
const { findPersistentZoneAtLine } = require('../../../document/model/dripTxt/dripTxtPersistentHeadingZones.js');
const { listTagsFromIndex } = require('../../../indexing/embeddings/headingEmbeddingSearch');
const { listKnownTagLabelsForCompletion } = require('../../editor/dripTxt/dripTxtTagCompletion.js');
const session = require('./headingFormSession');
const {
	applyHeadingFormModelFromMessage,
	applyHeadingFormModel,
	isHeadingFormApplyActive
} = require('./headingFormApply');
const { setHeadingFormKbRootGetter, getHeadingFormKbRoot } = require('./headingFormKb');

/** @type {import('vscode').ExtensionContext | undefined} */
let extensionContext;

/**
 * @param {import('vscode').ExtensionContext} context
 */
function setHeadingFormExtensionContext(context) {
	extensionContext = context;
}

/**
 * Stamp durable `.i-N` into the issue heading type prefix in the editor buffer.
 * @param {import('vscode').TextEditor} editor
 * @param {any} payload
 * @returns {Promise<{ headingLine: number } | null>}
 */
async function stampIssueIdOntoEditor(editor, payload) {
	const kbRoot = getHeadingFormKbRoot();
	if (!kbRoot || !editor || !payload) return null;
	const { ensureIssueTypePrefixHasEntityId } = require('../../../document/project/issueEntityIdStamp');
	const ensured = await ensureIssueTypePrefixHasEntityId(
		kbRoot,
		editor.document.uri.fsPath,
		payload.typePrefix || '',
		payload.titleDisplay || ''
	);
	if (!ensured) return null;

	let bufferAlreadyNumbered = false;
	try {
		const line = editor.document.lineAt(payload.headingLine).text;
		bufferAlreadyNumbered = /#\s+\.i-\d+\b/i.test(line);
	} catch {
		bufferAlreadyNumbered = false;
	}

	payload.issueEntityId = ensured.issueId;
	payload.typePrefix = ensured.typePrefix;
	payload.titleDisplay = ensured.titleDisplay;

	// Buffer already has `# .i-N` and we did not allocate → nothing to write.
	if (!ensured.allocated && bufferAlreadyNumbered) {
		return null;
	}

	const model = {
		...payload,
		typePrefix: ensured.typePrefix,
		titleDisplay: ensured.titleDisplay,
		typeId: 'issue',
		issueEntityId: ensured.issueId
	};
	const changed = await applyHeadingFormModel(editor, model);
	if (!changed) return null;
	return { headingLine: payload.headingLine };
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
	const settings = getMetadataSettingsForNotePath(doc.uri.fsPath);
	const zone = findPersistentZoneAtLine(doc.getText(), line, settings);
	// Non-persistent headings never drive the RHS form.
	if (!zone || !zone.persistent || !zone.readyForRhs) return null;

	const types = (settings.types || []).map(t => ({
		id: t.id,
		marker: t.marker,
		shortcut: t.shortcut,
		attributes: t.attributes || {}
	}));
	const typeLocked = !!settings.specialIndex && !!settings.lockedTypeId;
	const typeId = typeLocked
		? String(settings.lockedTypeId).toLowerCase()
		: zone.typeId
			? String(zone.typeId).toLowerCase()
			: null;
	/** @type {Record<string, string>} */
	const attributes = { ...(zone.attributes || {}) };
	if (typeId) {
		const tdef = types.find(t => String(t.id || '').toLowerCase() === typeId);
		const attrs = tdef && tdef.attributes ? tdef.attributes : {};
		for (const key of Object.keys(attrs)) {
			if (attributes[key] == null) attributes[key] = '';
		}
	}
	let titleDisplay = zone.titleDisplay;
	let issueEntityId = '';
	/** @type {boolean} */
	let parentStamped = false;
	if (typeId === 'issue') {
		const { peekIssueEntityId } = require('../../../document/project/issueEntityIdStamp');
		issueEntityId = peekIssueEntityId(zone.typePrefix, titleDisplay);
		// RHS title is human text only — strip legacy leading `i-N` if still present.
		if (issueEntityId) {
			const { parseIssueTitleEntityId } = require('../../../document/project/projectStructureRules');
			const legacy = parseIssueTitleEntityId(titleDisplay);
			if (legacy && legacy.id === issueEntityId) {
				titleDisplay = legacy.rest;
			}
		}
		// Nested under an issue in this file → parent is implied; drop any redundant `parent:` line.
		const beforeParent = String(attributes.parent || '').trim();
		const { ensureIssueParentAttribute } = require('../../../document/project/issueParentLink');
		Object.assign(
			attributes,
			ensureIssueParentAttribute(attributes, doc.getText(), zone.headingLine)
		);
		parentStamped = beforeParent !== String(attributes.parent || '').trim();
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
		titleDisplay,
		typePrefix: zone.typePrefix,
		typeId,
		typeLocked,
		specialIndex: !!settings.specialIndex,
		identityText: zone.identityText,
		issueEntityId,
		attributes,
		tags: zone.tags,
		relations: zone.relations,
		special: zone.special,
		types,
		relationNames: [...(settings.allowedRelations || [])],
		knownTags: Array.isArray(knownTags) ? knownTags : [],
		parentStamped
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
	let payload = buildPayloadForLine(doc, lineNo, knownTags);
	if (!payload) {
		session.setBound(null);
		await session.postToForm({ type: 'headingFormClear' });
		return;
	}

	// New / unstamped issue under a project → allocate durable `.i-N` once into the type prefix.
	if (payload.typeId === 'issue' && !payload.issueEntityId) {
		const stamped = await stampIssueIdOntoEditor(editor, payload);
		if (stamped) {
			payload = buildPayloadForLine(doc, stamped.headingLine, knownTags) || payload;
		} else {
			const { peekIssueEntityId } = require('../../../document/project/issueEntityIdStamp');
			payload.issueEntityId = peekIssueEntityId(payload.typePrefix, payload.titleDisplay);
		}
	}

	// Issue tree: remove `parent:` on nested issues (indentation already says it),
	// and collapse duplicate `parent:` lines (legacy bug).
	if (payload.typeId === 'issue') {
		const linesNow = doc.getText().replace(/\r\n/g, '\n').split('\n');
		let parentLineCount = 0;
		const end = Math.max(
			payload.headingLine + 1,
			Number(payload.lockEndExclusive) || payload.headingLine + 1
		);
		for (let j = payload.headingLine + 1; j < end && j < linesNow.length; j++) {
			if (/^\s*parent\s*:/i.test(String(linesNow[j] || ''))) parentLineCount += 1;
		}
		if (payload.parentStamped || parentLineCount > 1) {
			const wrote = await applyHeadingFormModel(editor, payload);
			if (wrote) {
				payload = buildPayloadForLine(doc, payload.headingLine, knownTags) || payload;
			}
		}
		try {
			const { loadIssueParentContext, selfIssueKeyFromModel } = require('./headingFormIssueParent');
			const ctx = await loadIssueParentContext(
				doc,
				payload.headingLine,
				selfIssueKeyFromModel(payload)
			);
			payload.issueParent = {
				locked: ctx.locked,
				lockedParent: ctx.lockedParent,
				options: ctx.options
			};
		} catch (err) {
			console.error('[DRIP] issue parent options', err);
		}
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
			const zone = findPersistentZoneAtLine(
				editor.document.getText(),
				editor.selection.active.line,
				getMetadataSettingsForNotePath(editor.document.uri.fsPath)
			);
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
					case 'headingFormNormalizeDatetime': {
						const key = String(message.key || '');
						const raw = String(message.value || '');
						const { normalizeDateTimeValue } = require('../../../document/parse/dripTxt/dripTxtDatetime.js');
						const value = normalizeDateTimeValue(raw, new Date());
						await session.postToForm({ type: 'headingFormDatetimeNormalized', key, value });
						break;
					}
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
