'use strict';

/**
 * Apply RHS form model onto a .d.txt buffer with surgical line edits only.
 */

const vscode = require('vscode');
const { getMetadataSettings } = require('../../../document/model/dripnoteMetadataTemplates');
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
	const settings = getMetadataSettings();
	const headingLineHint = Number(model.headingLine);
	const zone =
		findPersistentZoneAtLine(doc.getText(), headingLineHint, settings) ||
		findPersistentZoneAtLine(doc.getText(), Number(model.lockStart), settings);
	if (!zone || !zone.persistent || !zone.readyForRhs) {
		return false;
	}

	const lines = doc.getText().replace(/\r\n/g, '\n').split('\n');
	const patch = planPersistentHeadingPatch(
		lines,
		zone,
		{
			level: model.level || zone.level,
			tabDepth: model.tabDepth ?? zone.tabDepth,
			typeId: model.typeId,
			// Do not reuse zone.typePrefix — RHS type changes must rewrite the heading shortcut.
			typePrefix: model.typeId ? '' : '.',
			titleDisplay: model.titleDisplay,
			attributes: model.attributes || {},
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
					typeId: fresh.typeId
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
	await applyHeadingFormModel(editor, model || {});
}

module.exports = {
	applyHeadingFormModel,
	applyHeadingFormModelFromMessage,
	isHeadingFormApplyActive,
	runAsHeadingFormApply
};
