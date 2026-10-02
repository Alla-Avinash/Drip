'use strict';

/**
 * Apply RHS form model onto a .d.txt buffer with surgical line edits only.
 */

const vscode = require('vscode');
const {
	getMetadataSettingsForNotePath,
	getTypeRule
} = require('../../../document/model/dripnoteMetadataTemplates');
const { normalizeDateTimeValue } = require('../../../document/parse/dripnoteDatetime');
const { findPersistentZoneAtLine } = require('../../../document/model/persistentHeadingZones');
const { planPersistentHeadingPatch } = require('../../../document/model/headingBlockPatch');
const session = require('./headingFormSession');

let applyDepth = 0;

function isHeadingFormApplyActive() {
	return applyDepth > 0;
}

/**
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function runAsHeadingFormApply(fn) {
	applyDepth += 1;
	try {
		return await fn();
	} finally {
		applyDepth -= 1;
	}
}

/**
 * @param {import('vscode').TextEditor} editor
 * @param {any} model
 * @returns {Promise<boolean>} true if buffer changed
 */
async function applyHeadingFormModel(editor, model) {
	const doc = editor.document;
	const settings = getMetadataSettingsForNotePath(doc.uri.fsPath);
	const headingLineHint = Number(model.headingLine);
	const zone =
		findPersistentZoneAtLine(doc.getText(), headingLineHint, settings) ||
		findPersistentZoneAtLine(doc.getText(), Number(model.lockStart), settings);
	if (!zone || !zone.persistent || !zone.readyForRhs) {
		return false;
	}

	const lockedTypeId = settings.lockedTypeId
		? String(settings.lockedTypeId).toLowerCase()
		: null;
	const typeId = lockedTypeId || (model.typeId ? String(model.typeId).trim().toLowerCase() : null);

	// Issues: keep durable `.i-N` (from model or existing zone). Other typed headings:
	// force shortcut from typeId (ignore stale typePrefix). Untyped: bare `.`.
	let typePrefix = typeId ? '' : '.';
	let issueEntityId = model.issueEntityId;
	if (typeId === 'issue') {
		typePrefix = String(model.typePrefix || zone.typePrefix || '').trim();
		if (!issueEntityId) {
			try {
				const { peekIssueEntityId } = require('../../../document/project/issueEntityIdStamp');
				issueEntityId =
					peekIssueEntityId(typePrefix, model.titleDisplay || zone.titleDisplay || '') ||
					undefined;
			} catch {
				/* ignore */
			}
		}
	}

	const lines = doc.getText().replace(/\r\n/g, '\n').split('\n');
	/** @type {Record<string, unknown>} */
	let attributes = model.attributes && typeof model.attributes === 'object' ? { ...model.attributes } : {};
	if (typeId === 'issue') {
		try {
			const { ensureIssueParentAttribute } = require('../../../document/project/issueParentLink');
			attributes = ensureIssueParentAttribute(attributes, doc.getText(), zone.headingLine);
		} catch (err) {
			console.error('[DRIP] stamp issue parent on apply', err);
		}
	}

	// Normalize datetime attributes ("2 days" / "45 min" → "YYYY-MM-DD HH:mm") the same way
	// the editor's quick-fix does, so the buffer never stores a raw relative value.
	for (const [key, value] of Object.entries(attributes)) {
		const rule = getTypeRule(settings, typeId || '', key);
		if (rule && rule.kind === 'datetime' && value) {
			const normalized = normalizeDateTimeValue(String(value), new Date());
			if (normalized && normalized !== String(value)) attributes[key] = normalized;
		}
	}

	const patch = planPersistentHeadingPatch(
		lines,
		zone,
		{
			level: model.level || zone.level,
			tabDepth: model.tabDepth ?? zone.tabDepth,
			typeId,
			typePrefix,
			issueEntityId,
			titleDisplay: model.titleDisplay,
			attributes,
			tags: model.tags || [],
			relations: model.relations || [],
			special: model.special || {}
		},
		settings
	);
	if (patch.unchanged) return false;

	const cursor = editor.selection.active;
	return runAsHeadingFormApply(async () => {
		const ok = await editor.edit(
			eb => {
				const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
				if (patch.metaBlockReplace) {
					const br = patch.metaBlockReplace;
					const start = new vscode.Position(br.startLine, 0);
					const endLine = doc.lineAt(br.endLineInclusive);
					const end = endLine.rangeIncludingLineBreak.end;
					const body =
						br.texts.length === 0
							? ''
							: br.texts.join(eol) + eol;
					eb.replace(new vscode.Range(start, end), body);
				}
				const replaces = patch.lineReplacements
					.filter(r => r.text !== null)
					.sort((a, b) => b.line - a.line);
				for (const r of replaces) {
					// Title may shift if meta block replace changed line count above it — title is always above meta.
					const lineText = doc.lineAt(r.line).text;
					eb.replace(new vscode.Range(r.line, 0, r.line, lineText.length), r.text);
				}
				if (patch.insertsAfter && patch.insertsAfter.texts.length) {
					const after = patch.insertsAfter.line;
					const chunk = eol + patch.insertsAfter.texts.join(eol);
					eb.insert(doc.lineAt(after).range.end, chunk);
				}
			},
			{ undoStopBefore: false, undoStopAfter: false }
		);
		if (!ok) return false;
		const maxLine = Math.max(0, editor.document.lineCount - 1);
		const line = Math.min(Math.max(0, cursor.line), maxLine);
		const col = Math.min(cursor.character, editor.document.lineAt(line).text.length);
		editor.selection = new vscode.Selection(
			new vscode.Position(line, col),
			new vscode.Position(line, col)
		);

		const fresh = findPersistentZoneAtLine(editor.document.getText(), zone.headingLine, settings);
		if (fresh) {
			let issueEntityId;
			if (String(fresh.typeId || '').toLowerCase() === 'issue') {
				try {
					const { peekIssueEntityId } = require('../../../document/project/issueEntityIdStamp');
					issueEntityId = peekIssueEntityId(fresh.typePrefix, fresh.titleDisplay) || undefined;
				} catch {
					/* ignore */
				}
			}
			session.setBound({
				uri: editor.document.uri.toString(),
				headingLine: fresh.headingLine,
				identityText: fresh.identityText
			});
			await session.postToForm({
				type: 'headingFormBoundUpdate',
				payload: {
					lockStart: fresh.lockStart,
					lockEndExclusive: fresh.lockEndExclusive,
					identityLine: fresh.identityLine,
					headingLine: fresh.headingLine,
					identityText: fresh.identityText,
					level: fresh.level,
					tabDepth: fresh.tabDepth,
					typePrefix: fresh.typePrefix,
					typeId: fresh.typeId,
					issueEntityId
				}
			});
		}
		session.markOpened();
		return true;
	});
}

/**
 * @param {any} model
 */
async function applyHeadingFormModelFromMessage(model) {
	const uriStr = String(
		(model && model.documentUri) || (session.getBound() && session.getBound().uri) || ''
	).trim();
	let editor = vscode.window.activeTextEditor;
	if (uriStr && (!editor || editor.document.uri.toString() !== uriStr)) {
		const open = vscode.window.visibleTextEditors.find(ed => ed.document.uri.toString() === uriStr);
		if (open) editor = open;
		else {
			try {
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr));
				editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
			} catch {
				editor = undefined;
			}
		}
	}
	if (!editor) return;

	const next = { ...(model || {}) };
	const typeId = next.typeId ? String(next.typeId).trim().toLowerCase() : '';
	if (typeId === 'issue') {
		try {
			const { ensureIssueTypePrefixHasEntityId } = require('../../../document/project/issueEntityIdStamp');
			const { getHeadingFormKbRoot } = require('./headingFormKb');
			const kbRoot = getHeadingFormKbRoot();
			if (kbRoot) {
				const ensured = await ensureIssueTypePrefixHasEntityId(
					kbRoot,
					editor.document.uri.fsPath,
					next.typePrefix || '',
					next.titleDisplay || ''
				);
				if (ensured) {
					next.typePrefix = ensured.typePrefix;
					next.titleDisplay = ensured.titleDisplay;
					next.issueEntityId = ensured.issueId;
				}
			}
		} catch (err) {
			console.error('[DRIP] stamp issue id on apply', err);
		}
		try {
			const { validateIssueParentForApply } = require('./headingFormIssueParent');
			const res = await validateIssueParentForApply(editor.document, next);
			next.attributes = { ...(next.attributes || {}), parent: res.value };
			if (!res.ok) {
				await session.postToForm({
					type: 'headingFormIssueParentError',
					message: res.error || 'Invalid parent issue.',
					value: res.value
				});
			}
		} catch (err) {
			console.error('[DRIP] validate issue parent on apply', err);
		}
	}
	await applyHeadingFormModel(editor, next);
}

module.exports = {
	applyHeadingFormModel,
	applyHeadingFormModelFromMessage,
	isHeadingFormApplyActive,
	runAsHeadingFormApply
};
