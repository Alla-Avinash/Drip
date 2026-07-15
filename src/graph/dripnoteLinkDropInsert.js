'use strict';

const path = require('path');
const vscode = require('vscode');
const { fileNameMatchesKbNote, stripKbNoteExtension } = require('../document/model/noteFileTypes');
const { readTextFile } = require('../indexing/kbFilesystem');

const FILEID_RE = /^\s*fileid\s*:\s*(@[A-Za-z0-9_-]+)/im;

/**
 * @param {vscode.DataTransfer} dataTransfer
 * @param {vscode.CancellationToken} token
 * @returns {Promise<vscode.Uri | null>}
 */
async function extractFirstFileUriFromTransfer(dataTransfer, token) {
	const uriMimeTypes = ['text/uri-list', 'application/vnd.code.uri-list'];
	for (const mime of uriMimeTypes) {
		const item = dataTransfer.get(mime);
		if (!item) continue;
		let raw = '';
		try {
			raw = typeof item.asString === 'function' ? await item.asString() : String(item.value ?? '');
		} catch {
			continue;
		}
		if (!raw) continue;
		for (const line of raw.split(/\r?\n/)) {
			if (token.isCancellationRequested) return null;
			const s = line.trim();
			if (!s || s.startsWith('#')) continue;
			try {
				const u = vscode.Uri.parse(s);
				if (u.scheme === 'file') return u;
			} catch {
				/* ignore */
			}
		}
	}

	// Fallback: dropped file — must use DataTransferFile.uri (full path). Never Uri.file(file.name): basename-only URIs break on disk.
	const filesItem = dataTransfer.get('files');
	if (filesItem) {
		const file = filesItem.asFile();
		if (file && file.uri && file.uri.scheme === 'file') {
			return file.uri;
		}
	}
	return null;
}

function relativePathFromNoteToDest(noteUri, destUri) {
	const fromDir = path.dirname(noteUri.fsPath);
	return path.relative(fromDir, destUri.fsPath).replace(/\\/g, '/');
}

async function insertForTargetNote(targetUri, destNoteUri) {
	const noteText = await readTextFile(targetUri);
	const fileIdMatch = String(noteText || '').match(FILEID_RE);
	const fileId = fileIdMatch ? String(fileIdMatch[1]) : '';
	if (!fileId) return null;

	const stem = stripKbNoteExtension(path.basename(targetUri.fsPath));
	const rel = relativePathFromNoteToDest(destNoteUri, targetUri);
	const relFinal = rel.startsWith('.') ? rel : `./${rel}`;
	return {
		fileId,
		stem,
		insertText: `L. ![${stem} - ${fileId}](${relFinal})`
	};
}

function registerDripnoteLinkDropInsert(context) {
	if (typeof vscode.languages.registerDocumentDropEditProvider !== 'function') {
		return;
	}
	if (!vscode.DocumentDropOrPasteEditKind || !vscode.DocumentDropOrPasteEditKind.Text) {
		return;
	}

	const dripNoteLinkKind = vscode.DocumentDropOrPasteEditKind.Text.append('markdown', 'links', 'drip-note-link');
	const selector = { language: 'dripnote', scheme: 'file' };

	const provider = {
		async provideDocumentDropEdits(document, _position, dataTransfer, _ctx, token) {
			if (document.languageId !== 'dripnote' || document.uri.scheme !== 'file') {
				return undefined;
			}
			const dropped = await extractFirstFileUriFromTransfer(dataTransfer, token);
			if (!dropped || token.isCancellationRequested) return undefined;
			if (!fileNameMatchesKbNote(path.basename(dropped.fsPath))) {
				return undefined;
			}

			try {
				const insert = await insertForTargetNote(dropped, document.uri);
				if (!insert) return undefined;
				const drop = new vscode.DocumentDropEdit(insert.insertText);
				drop.title = 'Insert DRIP link (L.)';
				drop.kind = dripNoteLinkKind;
				return drop;
			} catch {
				return undefined;
			}
		}
	};

	context.subscriptions.push(
		vscode.languages.registerDocumentDropEditProvider(
			selector,
			provider,
			{
				providedDropEditKinds: [dripNoteLinkKind],
				dropMimeTypes: ['text/uri-list', 'files']
			}
		)
	);
}

module.exports = {
	registerDripnoteLinkDropInsert
};

