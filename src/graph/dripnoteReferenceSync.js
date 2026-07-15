'use strict';

const path = require('path');
const { forEachKnowledgeBaseNote, writeTextFile } = require('../document/kbNoteOps');
const { stripKbNoteExtension } = require('../document/model/noteFileTypes');

const MD_IMAGE = /^(\s*L\.[\s\t]*)!\[([^\]]*)\]\(([^)]+)\)(.*)$/i;

function extractFileIdFromHeader(text) {
	const m = String(text || '').match(/^\s*fileid\s*:\s*(@[A-Za-z0-9_-]+)/im);
	return m ? String(m[1]) : '';
}

function makeNewHref(fromFileUri, toFileUri) {
	const fromDir = path.dirname(fromFileUri.fsPath);
	const rel = path.relative(fromDir, toFileUri.fsPath).replace(/\\/g, '/');
	return rel.startsWith('.') ? rel : `./${rel}`;
}

function escapeRegExp(s) {
	return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteLLine(line, opts) {
	const { oldFileId, newFileId, newStem, newHref } = opts;
	const m = String(line || '').match(MD_IMAGE);
	if (!m) return null;
	const prefix = m[1];
	const oldAlt = m[2];
	const rest = m[4] || '';
	if (!oldAlt.includes(oldFileId)) return null;

	const newAlt = `${newStem} - ${newFileId}`;
	return `${prefix}![${newAlt}](${newHref})${rest}`;
}

function rewriteGenericLLineId(line, oldFileId, newFileId) {
	const s = String(line || '');
	if (!/^\s*L\./i.test(s)) return null;
	if (!s.includes(oldFileId)) return null;
	return s.replace(new RegExp(escapeRegExp(oldFileId), 'g'), newFileId);
}

/**
 * @param {import('vscode').Uri} noteUri
 * @param {string} noteText
 * @param {string} oldFileId
 * @param {string} newFileId
 * @param {import('vscode').Uri} toAbsUri
 * @param {string} newStem
 * @returns {string|null}
 */
function rewriteNoteTextForFileId(noteUri, noteText, oldFileId, newFileId, toAbsUri, newStem) {
	if (!noteText || !noteText.includes(oldFileId)) {
		return null;
	}
	const lines = noteText.replace(/\r\n/g, '\n').split('\n');
	let changed = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!/^\s*L\./i.test(line)) continue;
		if (!line.includes(oldFileId)) continue;
		const newHref = makeNewHref(noteUri, toAbsUri);
		const rewritten = rewriteLLine(line, {
			oldFileId,
			newFileId,
			newStem,
			newHref
		});
		if (rewritten && rewritten !== line) {
			lines[i] = rewritten;
			changed = true;
			continue;
		}
		const generic = rewriteGenericLLineId(line, oldFileId, newFileId);
		if (generic && generic !== line) {
			lines[i] = generic;
			changed = true;
		}
	}
	return changed ? lines.join('\n') : null;
}

async function updateRefsOnRename(context, kbRoot, fromFileUri, toFileUri, oldFileId, newFileId) {
	const newStem = stripKbNoteExtension(path.basename(toFileUri.fsPath));
	const toAbsUri = toFileUri;
	const kbRootUri = kbRoot;

	/** @type {import('vscode').Uri[]} */
	const changedNotes = [];
	await forEachKnowledgeBaseNote(
		kbRootUri,
		async note => {
			if (!note?.uri?.fsPath || !note.text) return;
			if (!note.text.includes(oldFileId)) return;
			const next = rewriteNoteTextForFileId(note.uri, note.text, oldFileId, newFileId, toAbsUri, newStem);
			if (next) {
				await writeTextFile(note.uri, next);
				changedNotes.push(note.uri);
			}
		},
		{ yieldEvery: 20 }
	);
	return changedNotes;
}

/**
 * Same-path file id change (e.g. canonical realign): rewrite every `L.` line that mentions oldFileId.
 * @returns {Promise<import('vscode').Uri[]>} notes that were written
 */
async function updateRefsOnFileIdChange(kbRoot, oldFileId, newFileId, targetNoteUri) {
	if (!oldFileId || !newFileId || oldFileId === newFileId) {
		return [];
	}
	const newStem = stripKbNoteExtension(path.basename(targetNoteUri.fsPath));
	const toAbsUri = targetNoteUri;

	/** @type {import('vscode').Uri[]} */
	const changedNotes = [];
	await forEachKnowledgeBaseNote(
		kbRoot,
		async note => {
			if (!note?.uri?.fsPath || !note.text) return;
			if (!note.text.includes(oldFileId)) return;
			const next = rewriteNoteTextForFileId(note.uri, note.text, oldFileId, newFileId, toAbsUri, newStem);
			if (next) {
				await writeTextFile(note.uri, next);
				changedNotes.push(note.uri);
			}
		},
		{ yieldEvery: 20 }
	);
	return changedNotes;
}

/**
 * True if any `L.` line in the KB still contains this id text (substring match).
 */
async function kbHasLLineContainingFileId(kbRoot, fileIdSubstring) {
	if (!fileIdSubstring) return false;
	let hit = false;
	await forEachKnowledgeBaseNote(
		kbRoot,
		async note => {
			if (hit || !note?.text) return;
			if (!note.text.includes(fileIdSubstring)) return;
			const lines = note.text.split(/\r?\n/);
			for (const line of lines) {
				if (/^\s*L\./i.test(line) && line.includes(fileIdSubstring)) {
					hit = true;
					return;
				}
			}
		},
		{ yieldEvery: 30 }
	);
	return hit;
}

async function removeRefsOnDelete(context, kbRoot, deletedFileId) {
	const kbRootUri = kbRoot;
	/** @type {import('vscode').Uri[]} */
	const changedNotes = [];
	await forEachKnowledgeBaseNote(
		kbRootUri,
		async note => {
			if (!note?.uri?.fsPath || !note.text) return;
			if (!note.text.includes(deletedFileId)) return;
			const lines = note.text.replace(/\r\n/g, '\n').split('\n');
			let changed = false;
			const filtered = [];
			for (const line of lines) {
				if (/^\s*L\./i.test(line) && line.includes(deletedFileId)) {
					changed = true;
					continue;
				}
				filtered.push(line);
			}
			if (changed) {
				await writeTextFile(note.uri, filtered.join('\n'));
				changedNotes.push(note.uri);
			}
		},
		{ yieldEvery: 20 }
	);
	return changedNotes;
}

module.exports = {
	extractFileIdFromHeader,
	updateRefsOnRename,
	updateRefsOnFileIdChange,
	kbHasLLineContainingFileId,
	removeRefsOnDelete
};
