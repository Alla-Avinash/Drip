'use strict';

/**
 * Deterministic display-key remint: earlier (time, peer id) keeps i-N;
 * the later create becomes max(known) + 1.
 */

const vscode = require('vscode');
const { compareOps } = require('./projectOp');
const { updateIssueBlockText } = require('../document/project/issueBlockEdit');
const { forEachKnowledgeBaseNotePath } = require('../indexing/kbFilesystem');
const { noteFormatForPath } = require('../document/model/dripNoteFileTypes.js');
const { projectFolderPrefixForPath } = require('./projectSidecar');

/**
 * @param {object[]} createOps issue.create ops that requested the same display key
 * @returns {object} winner (keeps the key)
 */
function winnerOfCollision(createOps) {
	const list = (createOps || []).slice().sort(compareOps);
	return list[0] || null;
}

/**
 * @param {number[]} used
 * @returns {number}
 */
function nextFreeNumber(used) {
	let max = 0;
	for (const n of used || []) {
		const v = Math.floor(Number(n) || 0);
		if (v > max) max = v;
	}
	return max + 1;
}

/**
 * Rewrite every visible `i-from` that belongs to this uid to `i-to`.
 * Parent lines are rewritten only when they point at this issue's old key
 * and the heading being edited is this uid or already uses the old key as parent.
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {{ uid: string, fromKey: string, toKey: string }} change
 */
async function rewriteDisplayKey(kbRootUri, folderPrefix, change) {
	const fromKey = String(change.fromKey || '').toLowerCase();
	const toKey = String(change.toKey || '').toLowerCase();
	const uid = String(change.uid || '');
	if (!fromKey || !toKey || fromKey === toKey || !uid) return 0;
	const prefix = String(folderPrefix || '').replace(/\\/g, '/').replace(/\/+$/, '');
	let files = 0;
	await forEachKnowledgeBaseNotePath(kbRootUri, async note => {
		const rel = String(note.relativePath || '').replace(/\\/g, '/');
		if (!rel.startsWith(prefix + '/') && rel !== prefix) return;
		let text;
		try {
			text = Buffer.from(await vscode.workspace.fs.readFile(note.uri)).toString('utf8');
		} catch {
			return;
		}
		const fmt = noteFormatForPath(note.uri.fsPath) === '.d.md' ? 'drip-md' : 'drip-txt';
		const next = rewriteKeysInText(text, fmt, fromKey, toKey, uid);
		if (next !== text) {
			await vscode.workspace.fs.writeFile(note.uri, Buffer.from(next, 'utf8'));
			files += 1;
		}
	});
	return files;
}

/**
 * @param {string} text
 * @param {string} format
 * @param {string} fromKey
 * @param {string} toKey
 * @param {string} uid
 */
function rewriteKeysInText(text, format, fromKey, toKey, uid) {
	const { readIssueBlock } = require('../document/project/issueBlockEdit');
	const { collectIssueIds } = require('./projectHiddenIds');
	let next = text;
	for (const issueId of collectIssueIds(next, format)) {
		const block = readIssueBlock(next, issueId, format);
		if (!block) continue;
		const blockUid = String((block.attributes && block.attributes.uid) || '');
		if (issueId.toLowerCase() === fromKey && blockUid === uid) {
			next = renameIssueHeadingKey(next, issueId, toKey, format);
			continue;
		}
		const parent = String((block.attributes && block.attributes.parent) || '').toLowerCase();
		if (parent === fromKey) {
			const updated = updateIssueBlockText(next, issueId, { attributes: { parent: toKey } }, format);
			if (updated.ok) next = updated.text;
		}
	}
	return next;
}

function renameIssueHeadingKey(text, fromKey, toKey, format) {
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	const from = String(fromKey || '').replace(/^i-/i, '');
	const to = String(toKey || '').replace(/^i-/i, '');
	const re =
		format === 'drip-md'
			? new RegExp(`^(#{1,6}\\s+)i-${from}\\b`, 'i')
			: new RegExp(`^(\\s*#\\d*\\s+\\.?)i-${from}\\b`, 'i');
	for (let i = 0; i < lines.length; i++) {
		if (re.test(lines[i])) {
			lines[i] = lines[i].replace(re, `$1i-${to}`);
		}
	}
	return lines.join('\n');
}

module.exports = {
	winnerOfCollision,
	nextFreeNumber,
	rewriteDisplayKey,
	rewriteKeysInText
};
