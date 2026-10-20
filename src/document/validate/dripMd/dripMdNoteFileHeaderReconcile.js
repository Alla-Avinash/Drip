'use strict';

/**
 * Host-side file-header reconcile for `.d.md` notes.
 *
 * Ensures each `.d.md` note opens (or sits in the workspace) with the canonical header
 * block: a hidden `<!-- drip-file … -->` comment, a matching h0 title, and a blank line
 * before the body. It reads the document and writes back through a WorkspaceEdit, so it
 * never depends on the webview being visible — which makes tabs restored from a previous
 * session safe.
 *
 * This slice is pure structure: the filename is corrected to the file stem, the h0 is
 * aligned, the persistent-heading count is refreshed, and an existing valid `@fN` fileid
 * is preserved. Fileid allocation + uniqueness + link propagation are a later DB phase;
 * they plug in by passing a resolved `fileid` instead of `null`.
 */

const vscode = require('vscode');
const path = require('path');
const {
	stripMdNoteExtension,
	reconcileMdNoteFileHeader
} = require('../../model/dripMd/dripMdNoteFileHeader.js');

/**
 * @param {import('vscode').TextDocument} document
 * @returns {boolean}
 */
function isDripMdNoteDocument(document) {
	if (!document || document.uri.scheme !== 'file') return false;
	return String(document.uri.fsPath || '').toLowerCase().endsWith('.d.md');
}

/**
 * @param {import('vscode').TextDocument} document
 * @returns {Promise<void>}
 */
async function reconcileDocumentHeader(document) {
	// The debounce timer can fire after the document was closed; reading a closed
	// document throws.
	if (!document || document.isClosed || !isDripMdNoteDocument(document)) return;

	const fileStem = stripMdNoteExtension(path.basename(document.uri.fsPath));
	const result = reconcileMdNoteFileHeader(document.getText(), { fileStem, fileid: null });
	if (!result.changed) return;

	// Replace only the header region (lines [0, bodyStart)) so the body — and any
	// unsaved edits in the editor — is left untouched. Rebuild the newlines with the
	// document's own EOL so we never mix line endings.
	const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
	const replacement = result.headerLines.join(eol);
	const range = new vscode.Range(
		new vscode.Position(0, 0),
		new vscode.Position(result.bodyStartLineIndex, 0)
	);

	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, range, replacement);
	await vscode.workspace.applyEdit(edit);
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
function registerDripMdNoteFileHeaderReconcile(context) {
	// Reconcile on open and on save only — never on a mid-typing debounce. The webview is
	// the single writer of an open document; rewriting the header behind it caused save
	// conflicts ("content is newer"). The header holds the persistent-heading count, which
	// is refreshed on save once the note is at rest.
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(doc => {
			if (!isDripMdNoteDocument(doc)) return;
			void reconcileDocumentHeader(doc).catch(err =>
				console.error('[DRIP] .d.md file-header reconcile failed', err)
			);
		}),
		vscode.workspace.onDidSaveTextDocument(doc => {
			if (!isDripMdNoteDocument(doc)) return;
			void reconcileDocumentHeader(doc).catch(err =>
				console.error('[DRIP] .d.md file-header reconcile failed', err)
			);
		})
	);

	// Tabs restored from a previous session are already open before activation finishes.
	for (const doc of vscode.workspace.textDocuments) {
		if (isDripMdNoteDocument(doc)) {
			void reconcileDocumentHeader(doc).catch(err =>
				console.error('[DRIP] .d.md file-header reconcile failed', err)
			);
		}
	}
}

module.exports = { registerDripMdNoteFileHeaderReconcile };
