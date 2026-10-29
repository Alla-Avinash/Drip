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
	await attachIssueTalk(payload, doc.uri);
	await session.postToForm({ type: 'headingFormLoad', payload });
	if (opts.reveal && session.getWebview()) {
		// Already opened above when needed; ensure visible without stealing caret again.
		session.markOpened();
	}
}

async function projectContextForDoc(docUri) {
	const { getHeadingFormKbRoot } = require('./headingFormKb');
	const kbRoot = getHeadingFormKbRoot();
	if (!kbRoot || !docUri) return null;
	const { projectFolderPrefixForPath, readProjectRecord, projectFolderUriFromPrefix } = require('../../../peer/projectSidecar');
	const prefix = projectFolderPrefixForPath(kbRoot.fsPath, docUri.fsPath);
	if (!prefix) return null;
	const folderUri = projectFolderUriFromPrefix(kbRoot, prefix);
	const rec = await readProjectRecord(folderUri);
	return { kbRoot, prefix, folderUri, rec };
}

async function attachIssueTalk(payload, docUri) {
	if (!payload || payload.typeId !== 'issue') return payload;
	const uid = String((payload.attributes && payload.attributes.uid) || '').trim();
	const ctx = await projectContextForDoc(docUri);
	const shared = !!(ctx && ctx.rec && ctx.rec.shared);
	const tdef = (payload.types || []).find(t => String(t.id || '').toLowerCase() === 'issue');
	if (shared) {
		const names = (ctx.rec.teams || []).map(t => t.name).filter(Boolean);
		if (tdef && tdef.attributes && tdef.attributes.team) {
			tdef.attributes.team = {
				...tdef.attributes.team,
				values: names,
				required: names.length > 0
			};
		}
		try {
			const me = await require('../../../peer/peerIdentity').ensurePeerIdentity();
			payload.talkCaps = require('../../../peer/projectRoles').memberCaps(ctx.rec, me.peerId);
		} catch {
			payload.talkCaps = { chatWrite: true };
		}
	} else {
		// Solo (not shared) project: teams do not apply and there is no role to
		// gate against, so hide the team field and give the local user full access.
		if (tdef && tdef.attributes) delete tdef.attributes.team;
		payload.talkCaps = { chatWrite: true, issueEdit: true, issueStatus: true, issueDelete: true };
	}
	if (uid && ctx) {
		try {
			payload.talk = await require('../../../peer/projectChat').readRoom(ctx.folderUri, 'issue', uid, ctx.rec);
		} catch {
			payload.talk = { messages: [] };
		}
	} else {
		payload.talk = { messages: [] };
	}
	return payload;
}

async function headingTalkAction(message, kind) {
	const { getHeadingFormKbRoot } = require('./headingFormKb');
	const kbRoot = getHeadingFormKbRoot();
	const uri = vscode.Uri.parse(String(message.documentUri || ''));
	if (!kbRoot || !uri.fsPath) return;
	const ctx = await projectContextForDoc(uri);
	if (!ctx) return;
	const uid = String(message.uid || '');
	const me = await require('../../../peer/peerIdentity').ensurePeerIdentity();
	if (ctx.rec && ctx.rec.shared) {
		const { hasCap, CAPS } = require('../../../peer/projectRoles');
		if (!hasCap(ctx.rec, me.peerId, CAPS.CHAT_WRITE)) {
			void vscode.window.showWarningMessage('Your role cannot talk on this issue.');
			return;
		}
	}
	const chat = require('../../../peer/projectChat');
	let data = { messages: [] };
	if (kind === 'send') {
		const issueKey = String(message.issueEntityId || '');
		const sent = await chat.appendIssueMessage(ctx.folderUri, ctx.rec, uid, String(message.text || ''), me, issueKey);
		data = sent.issueData;
		if (ctx.rec && ctx.rec.shared) {
			const { recordLocalOperation } = require('../../../peer/projectRecord');
			const opTypes = require('../../../peer/projectOp').OP_TYPES;
			if (data.messages.length) {
				const last = data.messages[data.messages.length - 1];
				await recordLocalOperation(kbRoot, ctx.prefix, opTypes.CHAT_APPEND, {
					room: 'issue',
					id: uid,
					message: last
				});
			}
			// Team mentions fan out as separate messages in each team's talk room.
			for (const f of sent.fanout) {
				if (f && f.message) {
					await recordLocalOperation(kbRoot, ctx.prefix, opTypes.CHAT_APPEND, {
						room: 'team',
						id: f.teamId,
						message: f.message,
						grants: f.grants,
						participants: f.participants
					});
				}
			}
		}
	} else if (kind === 'clear') {
		data = await chat.clearRoom(ctx.folderUri, 'issue', uid);
		if (ctx.rec && ctx.rec.shared) {
			await require('../../../peer/projectRecord').recordLocalOperation(kbRoot, ctx.prefix, require('../../../peer/projectOp').OP_TYPES.CHAT_CLEAR, {
				room: 'issue',
				id: uid
			});
		}
	} else if (kind === 'save') {
		if (ctx.rec && ctx.rec.shared) {
			const { hasCap, CAPS } = require('../../../peer/projectRoles');
			if (!hasCap(ctx.rec, me.peerId, CAPS.ISSUE_EDIT)) {
				void vscode.window.showWarningMessage('Your role cannot save talk onto the issue note.');
				return;
			}
		}
		data = await chat.readRoom(ctx.folderUri, 'issue', uid, ctx.rec);
		const lines = (data.messages || []).map(m => `${m.name || m.author}: ${m.text}`).filter(Boolean);
		if (!lines.length) {
			void vscode.window.showInformationMessage('Nothing in talk to save.');
			return;
		}
		const issueId = String(message.issueEntityId || '');
		if (!issueId) return;
		const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		const { appendIssueNoteText } = require('../../../document/project/issueBlockEdit');
		const { noteFormatForPath } = require('../../../document/model/dripNoteFileTypes.js');
		const fmt = noteFormatForPath(uri.fsPath) === '.d.md' ? 'drip-md' : 'drip-txt';
		const next = appendIssueNoteText(text, issueId, `From talk:\n${lines.join('\n')}`, fmt);
		if (next && next.ok) {
			const { markExpectedDiskWrite } = require('../../../shared/documentEditGuard');
			markExpectedDiskWrite(uri);
			await vscode.workspace.fs.writeFile(uri, Buffer.from(next.text, 'utf8'));
			data = await chat.clearRoom(ctx.folderUri, 'issue', uid);
			if (ctx.rec && ctx.rec.shared) {
				const { recordLocalOperation, OP_TYPES } = require('../../../peer/projectRecord');
				await recordLocalOperation(kbRoot, ctx.prefix, OP_TYPES.ISSUE_BODY_APPEND, {
					uid,
					issueKey: issueId,
					note: `From talk:\n${lines.join('\n')}`
				});
				await recordLocalOperation(kbRoot, ctx.prefix, OP_TYPES.CHAT_CLEAR, { room: 'issue', id: uid });
			}
		}
	}
	await session.postToForm({ type: 'headingFormTalk', messages: data.messages || [] });
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
					case 'headingFormTalkSend':
						await headingTalkAction(message, 'send');
						break;
					case 'headingFormTalkClear':
						await headingTalkAction(message, 'clear');
						break;
					case 'headingFormTalkSave':
						await headingTalkAction(message, 'save');
						break;
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
						try {
							const ctx = await projectContextForDoc(editor.document.uri);
							if (ctx && ctx.rec && ctx.rec.shared) {
								const me = await require('../../../peer/peerIdentity').ensurePeerIdentity();
								const { hasCap, CAPS } = require('../../../peer/projectRoles');
								if (!hasCap(ctx.rec, me.peerId, CAPS.ISSUE_DELETE)) {
									void vscode.window.showWarningMessage('Your role cannot delete this heading.');
									break;
								}
							}
						} catch {
							/* role check is best-effort */
						}
						const pick = await vscode.window.showWarningMessage(
							'Delete this persistent heading and its metadata?',
							{ modal: true },
							'Delete',
							'Cancel'
						);
						if (pick !== 'Delete') break;
						try {
							const { getHeadingFormKbRoot } = require('./headingFormKb');
							const kbRoot = getHeadingFormKbRoot();
							if (kbRoot) {
								await require('../../../peer/projectHandEdit').synthesizeHandEditsOnSave(
									kbRoot,
									editor.document.uri,
									editor.document.getText()
								);
							}
						} catch {
							/* snapshot seed is optional */
						}
						const start = Number(model.identityLine >= 0 ? model.identityLine : model.headingLine);
						const end = Number(model.lockEndExclusive);
						if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) break;
						const { runAsHeadingFormApply } = require('./headingFormApply');
						await runAsHeadingFormApply(async () => {
							await editor.edit(eb => {
								eb.delete(new vscode.Range(start, 0, end, 0));
							});
						});
						try {
							const { getHeadingFormKbRoot } = require('./headingFormKb');
							const kbRoot = getHeadingFormKbRoot();
							if (kbRoot) {
								await require('../../../peer/projectHandEdit').synthesizeHandEditsOnSave(
									kbRoot,
									editor.document.uri,
									editor.document.getText()
								);
							}
						} catch (err) {
							console.error('[DRIP] record heading-form delete', err);
						}
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
