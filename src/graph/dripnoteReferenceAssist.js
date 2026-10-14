'use strict';

const path = require('path');
const vscode = require('vscode');
const { fileNameMatchesKbNote, stripKbNoteExtension } = require('../document/model/noteFileTypes');
const { extractFileIdFromHeader } = require('./dripnoteReferenceSync');
const { readTextFile } = require('../indexing/kbFilesystem');

const REF_LINE_RE = /^\s*L\.\s*!\[[^\]]*\]\([^)]+\)/i;
const IDENTITY_LINE_RE = /^\s*(filename|fileid)\s*:/i;

function relPath(fromFile, toFile) {
	const fromDir = path.dirname(fromFile.fsPath);
	const rel = path.relative(fromDir, toFile.fsPath).replace(/\\/g, '/');
	return rel.startsWith('.') ? rel : `./${rel}`;
}

async function buildReferenceInsert(currentDoc, droppedFileUri) {
	const fs = droppedFileUri.fsPath || '';
	const name = path.basename(fs);
	if (!fileNameMatchesKbNote(name)) return null;
	let fileId = '';
	try {
		const text = await readTextFile(droppedFileUri);
		fileId = extractFileIdFromHeader(text);
	} catch {
		fileId = '';
	}
	const stem = stripKbNoteExtension(name);
	const target = `${stem} - ${fileId || '@unknown'}`;
	const href = relPath(currentDoc.uri, droppedFileUri);
	return `L. ![${target}](${href})`;
}

function registerDripnoteReferenceAssist(context, state) {
	// 1) Warn when user edits L. reference lines manually.
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(ev => {
			const doc = ev.document;
			if (!doc || doc.languageId !== 'dripnote') return;
			// Find header cutoff once per event.
			let headerEndLine = doc.lineCount;
			for (let i = 0; i < doc.lineCount; i++) {
				if (String(doc.lineAt(i).text || '').trim() === '---') {
					headerEndLine = i;
					break;
				}
			}
			for (const c of ev.contentChanges || []) {
				const startLine = c.range.start.line;
				const endLine = Math.max(startLine, c.range.end.line);
				for (let ln = startLine; ln <= endLine; ln++) {
					const lineText = doc.lineAt(Math.min(ln, doc.lineCount - 1)).text;
					if (ln < headerEndLine && IDENTITY_LINE_RE.test(lineText)) {
						vscode.window.setStatusBarMessage(
							'Identity header is managed by DRIP. Rename files via explorer/DRIP actions.',
							5000
						);
						return;
					}
					if (REF_LINE_RE.test(lineText)) {
						vscode.window.setStatusBarMessage(
							'You are editing a file reference (L. ![name - @fileid](path)).',
							5000
						);
						return;
					}
				}
			}
		})
	);

	// Hover hint for immutable identity lines.
	context.subscriptions.push(
		vscode.languages.registerHoverProvider(
			{ language: 'dripnote', scheme: 'file' },
			{
				provideHover(document, position) {
					const line = document.lineAt(position.line).text;
					if (!IDENTITY_LINE_RE.test(line)) return null;
					const sep = document
						.getText()
						.split(/\r?\n/)
						.findIndex(l => String(l || '').trim() === '---');
					if (sep >= 0 && position.line > sep) return null;
					return new vscode.Hover("can't modify this information");
				}
			}
		)
	);

	// 2) Drag/drop file into .d.txt creates L. reference.
	if (typeof vscode.languages.registerDocumentDropEditProvider === 'function') {
		const selector = { language: 'dripnote', scheme: 'file' };
		const provider = {
			async provideDocumentDropEdits(document, _position, dataTransfer, _token) {
				const uriList = dataTransfer.get('text/uri-list');
				if (!uriList) return undefined;
				const raw = await uriList.asString();
				if (!raw) return undefined;
				const first = raw
					.split(/\r?\n/)
					.map(s => s.trim())
					.find(s => s && !s.startsWith('#'));
				if (!first) return undefined;
				let uri;
				try {
					uri = vscode.Uri.parse(first);
				} catch {
					return undefined;
				}
				if (uri.scheme !== 'file') return undefined;
				const ins = await buildReferenceInsert(document, uri);
				if (!ins) return undefined;
				const drop = new vscode.DocumentDropEdit(ins);
				drop.title = 'Insert DRIP file reference';
				return drop;
			}
		};
		context.subscriptions.push(
			vscode.languages.registerDocumentDropEditProvider(selector, provider, {
				dropMimeTypes: ['text/uri-list', 'files']
			})
		);
	}
}

module.exports = {
	registerDripnoteReferenceAssist
};

