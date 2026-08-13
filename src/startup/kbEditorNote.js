'use strict';

const path = require('path');
const vscode = require('vscode');
const { KB_EDITOR_NOTE_FILENAME } = require('../shared/constants');
const { buildNewNoteFile } = require('../document/kbNoteOps');
const { writeTextFile } = require('../indexing/kbFilesystem');
const { allocateNextEntityNumber, indexNewNoteImmediately } = require('../indexing/dripnoteIndex');
const { normalizeNoteIdentityFile } = require('../indexing/dripnoteFileIdentity');

const LEGACY_KB_EDITOR_NOTE_FILENAME = '.editor.d.txt';

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {import('vscode').Uri}
 */
function getKbEditorNoteUri(kbRootUri) {
	return vscode.Uri.joinPath(kbRootUri, KB_EDITOR_NOTE_FILENAME);
}

/**
 * @param {string} fileName
 */
function isKbEditorNoteFileName(fileName) {
	return String(fileName || '').toLowerCase() === KB_EDITOR_NOTE_FILENAME.toLowerCase();
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} relPath
 */
function isKbEditorNoteRelPath(kbRootUri, relPath) {
	const normalized = String(relPath || '').replace(/\\/g, '/');
	const expected = KB_EDITOR_NOTE_FILENAME.replace(/\\/g, '/');
	return normalized === expected || path.basename(normalized).toLowerCase() === expected.toLowerCase();
}

/**
 * Ensure `.Editor.d.txt` exists at the KB root (scratchpad for capture / quick notes).
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').ExtensionContext} [context]
 * @returns {Promise<import('vscode').Uri>}
 */
async function ensureKbEditorNote(kbRootUri, context) {
	const uri = getKbEditorNoteUri(kbRootUri);
	try {
		await vscode.workspace.fs.stat(uri);
		return uri;
	} catch {
		const legacyUri = vscode.Uri.joinPath(kbRootUri, LEGACY_KB_EDITOR_NOTE_FILENAME);
		try {
			await vscode.workspace.fs.stat(legacyUri);
			await vscode.workspace.fs.rename(legacyUri, uri);
			return uri;
		} catch {
			// Create on first use / KB init.
		}
	}

	const n = await allocateNextEntityNumber(kbRootUri);
	const text = buildNewNoteFile(
		{ title: 'Editor', content: '' },
		{ metadataFilename: '.Editor', fileEntityNumber: n }
	);
	await writeTextFile(uri, text);
	await normalizeNoteIdentityFile(uri, { context });
	try {
		await indexNewNoteImmediately(kbRootUri, uri, context, text);
	} catch (err) {
		console.error('[DRIP] immediate index after KB editor note create', err);
	}
	return uri;
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {{ getKnowledgeBaseRoot?: () => import('vscode').Uri | undefined, ensureKnowledgeBaseRoot?: () => Promise<import('vscode').Uri | undefined> }} state
 */
async function openKbEditorNote(context, state) {
	const kbRoot =
		typeof state.ensureKnowledgeBaseRoot === 'function'
			? await state.ensureKnowledgeBaseRoot()
			: state.getKnowledgeBaseRoot?.();
	if (!kbRoot) {
		return undefined;
	}

	const uri = await ensureKbEditorNote(kbRoot, context);
	await vscode.window.showTextDocument(uri, { preview: false });
	return uri;
}

module.exports = {
	ensureKbEditorNote,
	getKbEditorNoteUri,
	isKbEditorNoteFileName,
	isKbEditorNoteRelPath,
	openKbEditorNote
};
