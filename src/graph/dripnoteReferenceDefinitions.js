'use strict';

const path = require('path');
const vscode = require('vscode');
const { forEachKnowledgeBaseNote } = require('../document/kbNoteOps');
const { extractFileIdFromHeader } = require('./dripnoteReferenceSync');

const L_LINE_RE = /^\s*L\./i;
const AT_ID_RE = /@([A-Za-z0-9][A-Za-z0-9_-]*)/g;

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {string} fileId e.g. `@ab12cd34ef`
 */
async function findNoteUriByFileId(kbRoot, fileId) {
	const want = String(fileId || '').trim();
	if (!want.startsWith('@')) {
		return null;
	}
	/** @type {import('vscode').Uri | null} */
	let hit = null;
	await forEachKnowledgeBaseNote(
		kbRoot,
		async note => {
			if (hit || !note?.uri || !note.text) {
				return;
			}
			const base = path.basename(note.uri.fsPath).toLowerCase();
			if (base === '_index.d.txt' || base.startsWith('_index.')) {
				return;
			}
			const id = extractFileIdFromHeader(note.text);
			if (id && id === want) {
				hit = note.uri;
			}
		},
		{ yieldEvery: 25 }
	);
	return hit;
}

/**
 * Go to definition on `L. … @fileid…` (Ctrl+click / F12 on the @id token).
 */
function registerDripnoteReferenceDefinitions(context, state) {
	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider({ language: 'dripnote', scheme: 'file' }, {
			async provideDefinition(document, position, token) {
				if (token.isCancellationRequested) {
					return undefined;
				}
				const kbRoot = state.getKnowledgeBaseRoot();
				if (!kbRoot) {
					return undefined;
				}
				const relKb = path.relative(kbRoot.fsPath, document.uri.fsPath);
				if (relKb.startsWith('..') || path.isAbsolute(relKb)) {
					return undefined;
				}

				const line = document.lineAt(position.line).text;
				if (!L_LINE_RE.test(line)) {
					return undefined;
				}

				const lineStart = document.offsetAt(new vscode.Position(position.line, 0));
				const posOffset = document.offsetAt(position);
				const rel = posOffset - lineStart;

				let m;
				AT_ID_RE.lastIndex = 0;
				while ((m = AT_ID_RE.exec(line)) !== null) {
					const start = m.index;
					const end = start + m[0].length;
					if (rel >= start && rel < end) {
						const atId = `@${m[1]}`;
						const target = await findNoteUriByFileId(kbRoot, atId);
						if (!target) {
							return undefined;
						}
						return new vscode.Location(target, new vscode.Position(0, 0));
					}
				}
				return undefined;
			}
		})
	);
}

module.exports = {
	registerDripnoteReferenceDefinitions,
	findNoteUriByFileId
};
