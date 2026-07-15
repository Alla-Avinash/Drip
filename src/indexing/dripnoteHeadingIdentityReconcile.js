'use strict';

const path = require('path');
const vscode = require('vscode');
const { forEachKnowledgeBaseNote } = require('../document/kbNoteOps');
const { fileNameMatchesKbNote } = require('../document/model/noteFileTypes');
const { readTextFile, writeTextFile } = require('./kbFilesystem');
const { buildHeadingIdPoolFromText } = require('./dripnoteHeadingIdPool');
const {
	reconcileHeadingIdentitiesForKbNote,
	needsHeadingIdentityReconcile,
	collectHeadingIdentityDiagnostics,
	parseFileEntityFromLines
} = require('./dripnoteHeadingIdentity');
const { collectHeadingSequenceValidated } = require('../document/parse/dripnoteCanvasParse');

/**
 * Apply reconciled note text to an open buffer.
 * @param {import('vscode').Uri} noteUri
 * @param {string} reconciled
 * @param {{ includeDirty?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
async function applyReconciledTextToOpenNote(noteUri, reconciled, options = {}) {
	const key = noteUri.toString();
	const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key && !d.isClosed);
	if (!doc || (doc.isDirty && !options.includeDirty)) {
		return false;
	}
	const current = doc.getText().replace(/\r\n/g, '\n');
	if (current === reconciled) {
		return true;
	}
	const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
	const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === key);
	if (editor) {
		return editor.edit(
			editBuilder => {
				editBuilder.replace(fullRange, reconciled);
			},
			{ undoStopBefore: false, undoStopAfter: false }
		);
	}
	return vscode.workspace.applyEdit(new vscode.WorkspaceEdit().replace(noteUri, fullRange, reconciled));
}

/**
 * @param {import('vscode').Uri} noteUri
 * @param {string} reconciled
 * @returns {Promise<boolean>}
 */
async function applyReconciledTextToOpenNoteIfClean(noteUri, reconciled) {
	return applyReconciledTextToOpenNote(noteUri, reconciled, { includeDirty: false });
}

/**
 * Reconcile heading `@fN:hM` lines and `headings:` count on disk; refresh open clean buffers.
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @param {import('vscode').ExtensionContext | null | undefined} [_context]
 * @param {{ text?: string, refreshHashes?: boolean, applyOpenEditor?: boolean }} [options]
 * @returns {Promise<{ changed: boolean, text: string }>}
 */
async function reconcileNoteHeadingIdentitiesOnDisk(kbRootUri, noteUri, _context, options = {}) {
	let text = options.text != null ? String(options.text) : '';
	if (!text && options.text !== '') {
		text = await readTextFile(noteUri);
	}
	const normalized = String(text).replace(/\r\n/g, '\n');
	const pool = buildHeadingIdPoolFromText(normalized);
	const result = await reconcileHeadingIdentitiesForKbNote(kbRootUri, normalized, {
		noteUri,
		headingIdPool: pool,
		refreshHashes: options.refreshHashes === true
	});
	const changed = result.changed || result.text !== normalized;
	if (changed) {
		await writeTextFile(noteUri, result.text);
	}
	if (changed || options.applyOpenEditor) {
		await applyReconciledTextToOpenNote(noteUri, result.text, {
			includeDirty: options.applyOpenEditor === true
		});
	}
	return { changed, text: result.text };
}

/**
 * Reconcile heading identities for every KB note on disk (full KB update pass).
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').ExtensionContext | null | undefined} [context]
 * @returns {Promise<{ total: number, changed: number, failed: number }>}
 */
async function reconcileAllKbNoteHeadingIdentities(kbRootUri, context) {
	let total = 0;
	let changed = 0;
	let failed = 0;

	await forEachKnowledgeBaseNote(
		kbRootUri,
		async note => {
			if (!note?.uri?.fsPath || !fileNameMatchesKbNote(path.basename(note.uri.fsPath))) {
				return;
			}
			total += 1;
			try {
				const result = await reconcileNoteHeadingIdentitiesOnDisk(kbRootUri, note.uri, context, {
					text: note.text
				});
				if (result.changed) {
					changed += 1;
				}
			} catch (err) {
				failed += 1;
				console.error('[DRIP] heading identity reconcile during KB update', note.uri.fsPath, err);
			}
		},
		{ yieldEvery: 15 }
	);

	return { total, changed, failed };
}

/**
 * Collect heading-only issues remaining after reconcile.
 * @param {string} text
 * @returns {{ line?: number, message: string, severity: 'error' | 'warning' }[]}
 */
function collectHeadingReconcileIssues(text) {
	const normalized = String(text || '').replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');
	/** @type {{ line?: number, message: string, severity: 'error' | 'warning' }[]} */
	const issues = [];

	const { errors } = collectHeadingSequenceValidated(lines, 0);
	for (const e of errors) {
		issues.push({ line: e.lineIndex + 1, message: e.message, severity: 'error' });
	}

	const file = parseFileEntityFromLines(lines);
	for (const d of collectHeadingIdentityDiagnostics(normalized, file?.fileNum ?? null)) {
		if (d.kind === 'duplicate') {
			issues.push({
				line: d.lineIndex + 1,
				message: `Duplicate heading identity @f${d.fileNum}:h${d.headingNum}`,
				severity: 'warning'
			});
			continue;
		}
		const msg =
			d.kind === 'file-mismatch'
				? `Heading identity @f${d.fileNum} does not match fileid in header`
				: `Invalid heading identity @f${d.fileNum}:h${d.headingNum}`;
		issues.push({ line: d.lineIndex + 1, message: msg, severity: 'error' });
	}

	if (needsHeadingIdentityReconcile(normalized)) {
		issues.push({
			message: 'Heading identities or headings: count still need reconcile after update',
			severity: 'warning'
		});
	}

	return issues;
}

/**
 * Reconcile heading identities for notes under a KB file or folder scope.
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} scopeUri
 * @param {import('vscode').ExtensionContext | null | undefined} [context]
 * @returns {Promise<{ total: number, changed: number, failed: number, issues: { path: string, line?: number, message: string, severity: 'error' | 'warning' }[] }>}
 */
async function reconcileHeadingIdentitiesScope(kbRootUri, scopeUri, context) {
	const relScope = path.relative(kbRootUri.fsPath, scopeUri.fsPath).replace(/\\/g, '/');
	if (relScope.startsWith('..') || path.isAbsolute(relScope)) {
		throw new Error('Scope is outside the knowledge base.');
	}

	let stat;
	try {
		stat = await vscode.workspace.fs.stat(scopeUri);
	} catch {
		throw new Error('Scope path not found.');
	}

	/** @type {import('vscode').Uri[]} */
	const noteUris = [];

	if (stat.type === vscode.FileType.File) {
		if (fileNameMatchesKbNote(path.basename(scopeUri.fsPath))) {
			noteUris.push(scopeUri);
		}
	} else {
		const scopePath = scopeUri.fsPath.replace(/\\/g, '/');
		const scopePrefix = scopePath.endsWith('/') ? scopePath : `${scopePath}/`;
		await forEachKnowledgeBaseNote(kbRootUri, async note => {
			if (!note?.uri?.fsPath) {
				return;
			}
			const notePath = note.uri.fsPath.replace(/\\/g, '/');
			if (notePath === scopePath.replace(/\\/g, '/') || notePath.startsWith(scopePrefix)) {
				noteUris.push(note.uri);
			}
		});
	}

	let changed = 0;
	let failed = 0;
	/** @type {{ path: string, line?: number, message: string, severity: 'error' | 'warning' }[]} */
	const issues = [];

	for (const noteUri of noteUris) {
		const relPath = path.relative(kbRootUri.fsPath, noteUri.fsPath).replace(/\\/g, '/');
		let text = '';
		try {
			text = await readTextFile(noteUri);
		} catch (err) {
			failed += 1;
			issues.push({
				path: relPath,
				message: `Could not read file: ${err && err.message ? err.message : String(err)}`,
				severity: 'error'
			});
			continue;
		}

		try {
			const result = await reconcileNoteHeadingIdentitiesOnDisk(kbRootUri, noteUri, context, {
				text,
				applyOpenEditor: true
			});
			if (result.changed) {
				changed += 1;
			}
			for (const issue of collectHeadingReconcileIssues(result.text)) {
				issues.push({ path: relPath, ...issue });
			}
		} catch (err) {
			failed += 1;
			issues.push({
				path: relPath,
				message: err && err.message ? err.message : String(err),
				severity: 'error'
			});
		}
	}

	return { total: noteUris.length, changed, failed, issues };
}

module.exports = {
	reconcileNoteHeadingIdentitiesOnDisk,
	reconcileAllKbNoteHeadingIdentities,
	reconcileHeadingIdentitiesScope,
	collectHeadingReconcileIssues,
	applyReconciledTextToOpenNote,
	applyReconciledTextToOpenNoteIfClean
};
