'use strict';

/**
 * Find an issue inside a project folder by hidden uid or visible i-N key.
 */

const vscode = require('vscode');
const { forEachKnowledgeBaseNotePath } = require('../indexing/kbFilesystem');
const { noteFormatForPath } = require('../document/model/dripNoteFileTypes.js');
const { readIssueBlock } = require('../document/project/issueBlockEdit');
const { collectIssueIds, collectTypedEntityIds, readTypedEntityUid } = require('./projectHiddenIds');

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {{ uid?: string, issueKey?: string }} query
 * @returns {Promise<{ uri: import('vscode').Uri, issueId: string, format: string, attributes: Record<string, string>, title: string } | null>}
 */
async function findIssueInProject(kbRootUri, folderPrefix, query) {
	const wantUid = String((query && query.uid) || '').trim();
	const wantKey = String((query && query.issueKey) || '')
		.trim()
		.toLowerCase();
	if (!wantUid && !wantKey) return null;
	const prefix = String(folderPrefix || '').replace(/\\/g, '/').replace(/\/+$/, '');
	/** @type {null | { uri: import('vscode').Uri, issueId: string, format: string, attributes: Record<string, string>, title: string }} */
	let found = null;
	await forEachKnowledgeBaseNotePath(kbRootUri, async note => {
		if (found) return;
		const rel = String(note.relativePath || '').replace(/\\/g, '/');
		if (!rel.startsWith(prefix + '/') && rel !== prefix) return;
		let text;
		try {
			text = Buffer.from(await vscode.workspace.fs.readFile(note.uri)).toString('utf8');
		} catch {
			return;
		}
		const format = noteFormatForPath(note.uri.fsPath) === '.d.md' ? 'drip-md' : 'drip-txt';
		for (const issueId of collectIssueIds(text, format)) {
			const block = readIssueBlock(text, issueId, format);
			if (!block) continue;
			const uid = String((block.attributes && block.attributes.uid) || '').trim();
			if (wantUid && uid === wantUid) {
				found = {
					uri: note.uri,
					issueId,
					format,
					attributes: block.attributes || {},
					title: block.title || ''
				};
				return;
			}
			if (!wantUid && wantKey && issueId.toLowerCase() === wantKey) {
				found = {
					uri: note.uri,
					issueId,
					format,
					attributes: block.attributes || {},
					title: block.title || ''
				};
				return;
			}
		}
	});
	return found;
}

/**
 * Every live issue key number in the project (for remint max).
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function listIssueKeysInProject(kbRootUri, folderPrefix) {
	const prefix = String(folderPrefix || '').replace(/\\/g, '/').replace(/\/+$/, '');
	/** @type {{ issueId: string, uid: string }[]} */
	const out = [];
	await forEachKnowledgeBaseNotePath(kbRootUri, async note => {
		const rel = String(note.relativePath || '').replace(/\\/g, '/');
		if (!rel.startsWith(prefix + '/') && rel !== prefix) return;
		let text;
		try {
			text = Buffer.from(await vscode.workspace.fs.readFile(note.uri)).toString('utf8');
		} catch {
			return;
		}
		const format = noteFormatForPath(note.uri.fsPath) === '.d.md' ? 'drip-md' : 'drip-txt';
		for (const issueId of collectIssueIds(text, format)) {
			const block = readIssueBlock(text, issueId, format);
			out.push({
				issueId,
				uid: String((block && block.attributes && block.attributes.uid) || '')
			});
		}
	});
	return out;
}

/**
 * Every live `c-N` or `d-N` in the project (for remint), optionally skipping one file.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} letter
 * @param {import('vscode').Uri} [skipUri]
 */
async function listTypedKeysInProject(kbRootUri, folderPrefix, letter, skipUri) {
	const prefix = String(folderPrefix || '').replace(/\\/g, '/').replace(/\/+$/, '');
	const skip = skipUri ? String(skipUri.fsPath || '').replace(/\\/g, '/').toLowerCase() : '';
	const L = String(letter || '').toLowerCase();
	/** @type {{ key: string, num: number, uid: string }[]} */
	const out = [];
	await forEachKnowledgeBaseNotePath(kbRootUri, async note => {
		if (skip && String(note.uri.fsPath || '').replace(/\\/g, '/').toLowerCase() === skip) return;
		const rel = String(note.relativePath || '').replace(/\\/g, '/');
		if (!rel.startsWith(prefix + '/') && rel !== prefix) return;
		let text;
		try {
			text = Buffer.from(await vscode.workspace.fs.readFile(note.uri)).toString('utf8');
		} catch {
			return;
		}
		const format = noteFormatForPath(note.uri.fsPath) === '.d.md' ? 'drip-md' : 'drip-txt';
		for (const key of collectTypedEntityIds(text, format, L)) {
			const n = parseInt(String(key).replace(new RegExp(`^${L}-`, 'i'), ''), 10);
			out.push({
				key: String(key).toLowerCase(),
				num: Number.isFinite(n) ? n : 0,
				uid: readTypedEntityUid(text, key, format)
			});
		}
	});
	return out;
}

module.exports = {
	findIssueInProject,
	listIssueKeysInProject,
	listTypedKeysInProject
};
