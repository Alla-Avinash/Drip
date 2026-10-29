'use strict';

// Stateless editor/document helpers used by DripState: rewrite a note through the open
// editor when possible, find the open document for a URI, and build KB path breadcrumbs.

const path = require('path');
const vscode = require('vscode');
const { readTextFile, writeTextFile } = require('../document/dripNoteKbOps.js');
const { runGuardedDocumentEdit } = require('../shared/documentEditGuard');

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {import('vscode').Uri} folderUri
 * @returns {{ label: string, folderUri: string }[]}
 */
function kbPathSegments(kbRoot, folderUri) {
	const relFolder = path.relative(kbRoot.fsPath, folderUri.fsPath).replace(/\\/g, '/');
	const segments = [{ label: '(root)', folderUri: kbRoot.toString() }];
	if (!relFolder || relFolder === '.') {
		return segments;
	}
	let cursor = kbRoot;
	for (const part of relFolder.split('/').filter(Boolean)) {
		cursor = vscode.Uri.joinPath(cursor, part);
		segments.push({ label: part, folderUri: cursor.toString() });
	}
	return segments;
}

/**
 * Find an open (non-closed) text document for a file URI.
 * @param {import('vscode').Uri} uri
 * @returns {import('vscode').TextDocument | undefined}
 */
function findOpenTextDocument(uri) {
	if (!uri) return undefined;
	const key = uri.toString();
	const fsPath = uri.fsPath;
	return vscode.workspace.textDocuments.find(
		d => !d.isClosed && (d.uri.toString() === key || d.uri.fsPath === fsPath)
	);
}

/**
 * Rewrite an open note buffer (no rename) via WorkspaceEdit + save.
 * Falls back to disk write when the file is not open.
 *
 * @param {import('vscode').Uri} uri
 * @param {(text: string) => string | Promise<string>} transformText
 */
async function rewriteNotePreferringEditor(uri, transformText) {
	let doc = findOpenTextDocument(uri);
	if (!doc) {
		const text = await readTextFile(uri);
		const next = await transformText(text);
		if (next !== text && String(next).replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n')) {
			await writeTextFile(uri, next);
		}
		return;
	}
	if (doc.isDirty) {
		await doc.save();
	}
	const before = doc.getText();
	const after = await transformText(before);
	const beforeNorm = before.replace(/\r\n/g, '\n');
	const afterNorm = String(after || '').replace(/\r\n/g, '\n');
	await runGuardedDocumentEdit(async () => {
		if (afterNorm !== beforeNorm) {
			const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
			const we = new vscode.WorkspaceEdit();
			we.replace(doc.uri, fullRange, String(after ?? ''));
			await vscode.workspace.applyEdit(we);
			doc = findOpenTextDocument(uri) || (await vscode.workspace.openTextDocument(uri));
		}
		if (doc.isDirty) {
			await doc.save();
		}
	});
}

/**
 * Read the open editor first so a change is applied on top of what is on screen
 * (including typing that is not saved yet). Disk is only used when the file is not open.
 * @param {import('vscode').Uri} uri
 * @returns {Promise<string>}
 */
async function readNoteTextPreferEditor(uri) {
	const doc = findOpenTextDocument(uri);
	if (doc) return doc.getText().replace(/\r\n/g, '\n');
	if (!uri) return '';
	try {
		return (await readTextFile(uri)).replace(/\r\n/g, '\n');
	} catch {
		return '';
	}
}

/**
 * Put this text in the open editor (then save) so VS Code does not ask to overwrite
 * a newer file on disk. Writes the file directly when it is not open.
 * @param {import('vscode').Uri} uri
 * @param {string} text
 */
async function replaceOpenNoteOrWriteDisk(uri, text) {
	const vscode = require('vscode');
	const { markExpectedDiskWrite } = require('../shared/documentEditGuard');
	const next = String(text || '').replace(/\r\n/g, '\n');
	markExpectedDiskWrite(uri);
	const doc = findOpenTextDocument(uri);
	if (!doc) {
		await writeTextFile(uri, next);
		return;
	}
	await runGuardedDocumentEdit(async () => {
		const before = doc.getText().replace(/\r\n/g, '\n');
		if (before !== next) {
			const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
			const we = new vscode.WorkspaceEdit();
			we.replace(doc.uri, fullRange, next);
			await vscode.workspace.applyEdit(we);
		}
		const open = findOpenTextDocument(uri) || doc;
		if (open.isDirty) {
			await open.save();
		}
	});
}

/** Storage "AI" button: how many folder / file / heading suggestions to show. */
const AI_SUGGESTION_LIMIT = 4;

module.exports = {
	kbPathSegments,
	AI_SUGGESTION_LIMIT,
	rewriteNotePreferringEditor,
	readNoteTextPreferEditor,
	replaceOpenNoteOrWriteDisk,
	findOpenTextDocument
};
