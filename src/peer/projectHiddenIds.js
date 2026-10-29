'use strict';

/**
 * Hidden unique ids on project entities. The visible `i-N` / `c-N` / `d-N` / `f-N`
 * key can remint; the hidden id never changes.
 */

const vscode = require('vscode');
const { newPrefixedId } = require('./peerIds');
const { projectFolderUriFromPrefix } = require('./projectSidecar');
const { updateIssueBlockText, readIssueBlock } = require('../document/project/issueBlockEdit');
const { noteFormatForPath } = require('../document/model/dripNoteFileTypes.js');
const { forEachKnowledgeBaseNotePath } = require('../indexing/kbFilesystem');

const UID_KEY = 'uid';
const FILE_UID_HEADER = 'fileuid';

/**
 * @returns {string}
 */
function newIssueUid() {
	return newPrefixedId('iss');
}

function newFeatureUid() {
	return newPrefixedId('feat');
}

function newFileUid() {
	return newPrefixedId('file');
}

function newConceptUid() {
	return newPrefixedId('con');
}

function newDecisionUid() {
	return newPrefixedId('dec');
}

/**
 * @param {string} text
 * @returns {{ text: string, fileUid: string, changed: boolean }}
 */
function ensureFileUidInHeader(text) {
	const src = String(text || '');
	const lines = src.replace(/\r\n/g, '\n').split('\n');
	let fileUid = '';
	let fileidLine = -1;
	let insertAt = 0;
	for (let i = 0; i < Math.min(lines.length, 40); i++) {
		const m = String(lines[i] || '').match(/^\s*(fileuid|fileid)\s*:\s*(.+)\s*$/i);
		if (!m) {
			if (/^\s*---\s*$/.test(lines[i])) break;
			continue;
		}
		const key = m[1].toLowerCase();
		if (key === 'fileuid') {
			fileUid = String(m[2] || '').trim();
			break;
		}
		if (key === 'fileid') fileidLine = i;
	}
	if (fileUid) return { text: src, fileUid, changed: false };
	fileUid = newFileUid();
	const line = `${FILE_UID_HEADER}: ${fileUid}`;
	if (fileidLine >= 0) lines.splice(fileidLine + 1, 0, line);
	else lines.splice(insertAt, 0, line);
	return { text: lines.join('\n'), fileUid, changed: true };
}

/**
 * Stamp a uid on every issue in one note that is missing one.
 * When a map of known issue-key → uid is passed, a stripped uid is put back
 * instead of minting a new one (so a save cannot look like a new issue).
 * @param {string} text
 * @param {string} format
 * @param {Map<string, string>|Record<string, string>|null} [reuseUidByIssueKey]
 * @returns {{ text: string, stamped: { issueId: string, uid: string }[] }}
 */
function stampMissingIssueUidsInText(text, format, reuseUidByIssueKey) {
	const src = String(text || '');
	const issueIds = collectIssueIds(src, format);
	let next = src;
	/** @type {{ issueId: string, uid: string }[]} */
	const stamped = [];
	const reuse =
		reuseUidByIssueKey instanceof Map
			? reuseUidByIssueKey
			: reuseUidByIssueKey && typeof reuseUidByIssueKey === 'object'
				? new Map(Object.entries(reuseUidByIssueKey))
				: null;
	for (const issueId of issueIds) {
		const block = readIssueBlock(next, issueId, format);
		if (!block) continue;
		const existing = String((block.attributes && block.attributes.uid) || '').trim();
		if (existing) continue;
		const reused = reuse && reuse.get(String(issueId).toLowerCase());
		const uid = reused ? String(reused) : newIssueUid();
		const updated = updateIssueBlockText(next, issueId, { attributes: { uid } }, format);
		if (!updated.ok) continue;
		next = updated.text;
		stamped.push({ issueId, uid });
	}
	return { text: next, stamped };
}

/**
 * Visible display keys for one letter (`i` / `c` / `d`) in a note.
 * @param {string} text
 * @param {string} format
 * @param {string} letter
 * @returns {string[]}
 */
function collectTypedEntityIds(text, format, letter) {
	const L = String(letter || 'i')
		.trim()
		.charAt(0)
		.toLowerCase();
	if (!L || !/[icd]/.test(L)) return [];
	const ids = [];
	const seen = new Set();
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	const re =
		format === 'drip-md'
			? new RegExp(`^#{1,6}\\s+(${L}-\\d+)\\b`, 'i')
			: new RegExp(`^\\s*#\\d*\\s+\\.?(${L}-\\d+)\\b`, 'i');
	for (const line of lines) {
		const m = String(line || '').match(re);
		if (!m) continue;
		const id = String(m[1] || '').toLowerCase();
		if (seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

/**
 * @param {string} text
 * @param {string} format
 * @returns {string[]}
 */
function collectIssueIds(text, format) {
	return collectTypedEntityIds(text, format, 'i');
}

function collectConceptIds(text, format) {
	return collectTypedEntityIds(text, format, 'c');
}

function collectDecisionIds(text, format) {
	return collectTypedEntityIds(text, format, 'd');
}

function typedHeadingLineRe(format, entityId) {
	const esc = String(entityId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return format === 'drip-md'
		? new RegExp(`^(#{1,6}\\s+)${esc}\\b`, 'i')
		: new RegExp(`^(\\s*#\\d*\\s+\\.?)${esc}\\b`, 'i');
}

/**
 * Hidden uid already on this `c-N` / `d-N` / `i-N` heading, or empty.
 * @param {string} text
 * @param {string} entityId
 * @param {string} format
 * @returns {string}
 */
function readTypedEntityUid(text, entityId, format) {
	const id = String(entityId || '').toLowerCase();
	if (!id) return '';
	if (id.startsWith('i-')) {
		const block = readIssueBlock(text, id, format);
		return String((block && block.attributes && block.attributes.uid) || '').trim();
	}
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	const re = typedHeadingLineRe(format, id);
	for (let i = 0; i < lines.length; i++) {
		if (!re.test(lines[i])) continue;
		if (format === 'drip-md') {
			const { parseHeadingComment } = require('../document/model/dripMd/dripMdNoteComment.js');
			if (i + 1 < lines.length) {
				const c = parseHeadingComment(lines[i + 1]);
				const field = c && c.fields.find(f => String(f.key || '').toLowerCase() === UID_KEY);
				if (field) return String(field.value || '').trim();
			}
			return '';
		}
		for (let j = i + 1; j < lines.length; j++) {
			const raw = String(lines[j] || '');
			const tr = raw.trim();
			if (!tr || /^#/.test(tr) || /^@+h\d+/i.test(tr)) break;
			const m = tr.match(/^uid\s*:\s*(.+)$/i);
			if (m) return String(m[1] || '').trim();
			if (/^\.[a-z]/i.test(tr) || /^[a-z][a-z0-9_-]*\s*:/i.test(tr) || tr.startsWith('//')) continue;
			break;
		}
		return '';
	}
	return '';
}

/**
 * Insert a missing uid under a concept / decision heading (issues use the issue editor).
 * @param {string} text
 * @param {string} entityId
 * @param {string} uid
 * @param {string} format
 * @param {string} typeId concept | decision
 * @returns {string | null}
 */
function insertTypedEntityUid(text, entityId, uid, format, typeId) {
	const id = String(entityId || '').toLowerCase();
	const uidVal = String(uid || '').trim();
	if (!id || !uidVal) return null;
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	const re = typedHeadingLineRe(format, id);
	const headingAt = lines.findIndex(l => re.test(l));
	if (headingAt < 0) return null;
	if (format === 'drip-md') {
		const { parseHeadingComment, formatHeadingComment, isHeadingComment } = require('../document/model/dripMd/dripMdNoteComment.js');
		const next = headingAt + 1;
		if (next < lines.length && isHeadingComment(lines[next])) {
			const c = parseHeadingComment(lines[next]);
			if (!c) return null;
			const fields = c.fields.filter(f => String(f.key || '').toLowerCase() !== UID_KEY);
			fields.push({ key: UID_KEY, value: uidVal });
			lines[next] = formatHeadingComment(c.headingNum, c.typeId || typeId, fields);
		} else {
			lines.splice(next, 0, formatHeadingComment(0, typeId, [{ key: UID_KEY, value: uidVal }]));
		}
		return lines.join('\n');
	}
	let markerIdx = -1;
	let lastMeta = headingAt;
	const markerRe = typeId === 'decision' ? /^\.decision\b/i : /^\.concept\b/i;
	for (let j = headingAt + 1; j < lines.length; j++) {
		const raw = String(lines[j] || '');
		const tr = raw.trim();
		if (!tr || /^#/.test(tr) || /^@+h\d+/i.test(tr)) break;
		if (/^\.[a-z]/i.test(tr)) {
			if (markerRe.test(tr)) markerIdx = j;
			lastMeta = j;
			continue;
		}
		if (/^[a-z][a-z0-9_-]*\s*:/i.test(tr) || tr.startsWith('//')) {
			lastMeta = j;
			continue;
		}
		break;
	}
	const headInd = (String(lines[headingAt]).match(/^(\s*)/) || ['', ''])[1];
	if (markerIdx < 0) {
		lines.splice(headingAt + 1, 0, `${headInd}\t.${typeId}`, `${headInd}\t\t${UID_KEY}: ${uidVal}`);
	} else {
		const markerInd = (String(lines[markerIdx]).match(/^(\s*)/) || ['', ''])[1];
		lines.splice(lastMeta + 1, 0, `${markerInd}\t${UID_KEY}: ${uidVal}`);
	}
	return lines.join('\n');
}

/**
 * Stamp a uid on every concept or decision heading in one note that is missing one.
 * @param {string} text
 * @param {string} format
 * @param {'concept' | 'decision'} kind
 * @returns {{ text: string, stamped: { entityId: string, uid: string }[] }}
 */
function stampMissingTypedUidsInText(text, format, kind) {
	const typeId = kind === 'decision' ? 'decision' : 'concept';
	const letter = typeId === 'decision' ? 'd' : 'c';
	const newUid = typeId === 'decision' ? newDecisionUid : newConceptUid;
	const src = String(text || '');
	const ids = collectTypedEntityIds(src, format, letter);
	let next = src;
	/** @type {{ entityId: string, uid: string }[]} */
	const stamped = [];
	for (const entityId of ids) {
		if (readTypedEntityUid(next, entityId, format)) continue;
		const uid = newUid();
		const updated = insertTypedEntityUid(next, entityId, uid, format, typeId);
		if (!updated) continue;
		next = updated;
		stamped.push({ entityId, uid });
	}
	return { text: next, stamped };
}

/**
 * Rewrite a visible `c-N` / `d-N` heading key in one file.
 * @param {string} text
 * @param {string} format
 * @param {string} fromKey
 * @param {string} toKey
 * @param {string} letter
 * @returns {string}
 */
function renameTypedHeadingKey(text, format, fromKey, toKey, letter) {
	const L = String(letter || '').toLowerCase();
	const from = String(fromKey || '').replace(new RegExp(`^${L}-`, 'i'), '');
	const to = String(toKey || '').replace(new RegExp(`^${L}-`, 'i'), '');
	if (!from || !to || from === to) return String(text || '');
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	const re =
		format === 'drip-md'
			? new RegExp(`^(#{1,6}\\s+)${L}-${from}\\b`, 'i')
			: new RegExp(`^(\\s*#\\d*\\s+\\.?)${L}-${from}\\b`, 'i');
	for (let i = 0; i < lines.length; i++) {
		if (re.test(lines[i])) lines[i] = lines[i].replace(re, `$1${L}-${to}`);
	}
	return lines.join('\n');
}

/**
 * One-time stamp when a project is shared: fileuid plus issue / concept / decision uids.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function stampProjectHiddenIds(kbRootUri, folderPrefix) {
	projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const prefix = String(folderPrefix || '').replace(/\\/g, '/').replace(/\/+$/, '');
	/** @type {{ files: number, issues: number }} */
	const counts = { files: 0, issues: 0 };
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
		const file = ensureFileUidInHeader(text);
		const issues = stampMissingIssueUidsInText(file.text, fmt);
		const concepts = stampMissingTypedUidsInText(issues.text, fmt, 'concept');
		const decisions = stampMissingTypedUidsInText(concepts.text, fmt, 'decision');
		const { reprintProjectNoteText } = require('../document/project/projectIssuesReprint');
		const reprinted = reprintProjectNoteText(decisions.text, fmt);
		if (file.changed) counts.files += 1;
		counts.issues += issues.stamped.length + concepts.stamped.length + decisions.stamped.length;
		if (
			file.changed ||
			issues.stamped.length ||
			concepts.stamped.length ||
			decisions.stamped.length ||
			reprinted !== text
		) {
			await vscode.workspace.fs.writeFile(note.uri, Buffer.from(reprinted, 'utf8'));
		}
	});
	return counts;
}

/**
 * Remove the `fileuid:` header line from note text (inverse of `ensureFileUidInHeader`).
 * @param {string} text
 * @returns {string}
 */
function stripFileUidFromHeader(text) {
	const src = String(text || '');
	const lines = src.replace(/\r\n/g, '\n').split('\n');
	let changed = false;
	const out = [];
	for (const line of lines) {
		if (/^\s*fileuid\s*:\s*.+$/i.test(line)) {
			changed = true;
			continue;
		}
		out.push(line);
	}
	return changed ? out.join('\n') : src;
}

/**
 * Remove the hidden `uid` from a concept / decision heading (inverse of
 * `insertTypedEntityUid`). Issues use the issue editor path instead.
 * @param {string} text
 * @param {string} entityId
 * @param {string} format
 * @param {string} typeId concept | decision
 * @returns {string}
 */
function stripTypedEntityUid(text, entityId, format, typeId) {
	const id = String(entityId || '').toLowerCase();
	const src = String(text || '');
	if (!id) return src;
	const lines = src.replace(/\r\n/g, '\n').split('\n');
	const re = typedHeadingLineRe(format, id);
	const headingAt = lines.findIndex(l => re.test(l));
	if (headingAt < 0) return src;

	if (format === 'drip-md') {
		const { parseHeadingComment, formatHeadingComment, isHeadingComment } = require('../document/model/dripMd/dripMdNoteComment.js');
		const next = headingAt + 1;
		if (next >= lines.length || !isHeadingComment(lines[next])) return src;
		const c = parseHeadingComment(lines[next]);
		if (!c) return src;
		const fields = c.fields.filter(f => String(f.key || '').toLowerCase() !== UID_KEY);
		if (fields.length === c.fields.length) return src;
		lines[next] = formatHeadingComment(c.headingNum, c.typeId || typeId, fields);
		return lines.join('\n');
	}

	// drip-txt: drop the `uid:` line in the heading's metadata region.
	for (let j = headingAt + 1; j < lines.length; j++) {
		const raw = String(lines[j] || '');
		const tr = raw.trim();
		if (!tr || /^#/.test(tr) || /^@+h\d+/i.test(tr)) break;
		if (/^uid\s*:/i.test(tr)) {
			lines.splice(j, 1);
			return lines.join('\n');
		}
		if (/^\.[a-z]/i.test(tr) || /^[a-z][a-z0-9_-]*\s*:/i.test(tr) || tr.startsWith('//')) continue;
		break;
	}
	return src;
}

/**
 * Strip every sharing-only marker from one note: `fileuid` header, issue `uid`
 * and `team`, and concept / decision `uid`. `team` is removed here too so a
 * re-index of a solo project cannot recreate team data.
 * @param {string} text
 * @param {string} format
 * @returns {{ text: string, changed: boolean }}
 */
function stripSharingMarkersInText(text, format) {
	let next = String(text || '');
	let changed = false;

	const header = stripFileUidFromHeader(next);
	if (header !== next) {
		next = header;
		changed = true;
	}

	for (const issueId of collectIssueIds(next, format)) {
		const block = readIssueBlock(next, issueId, format);
		if (!block) continue;
		const attrs = block.attributes || {};
		const patch = {};
		if (attrs.uid) patch.uid = '';
		if (attrs.team) patch.team = '';
		if (!Object.keys(patch).length) continue;
		const updated = updateIssueBlockText(next, issueId, { attributes: patch }, format);
		if (updated.ok && updated.text !== next) {
			next = updated.text;
			changed = true;
		}
	}

	for (const [letter, typeId] of [['c', 'concept'], ['d', 'decision']]) {
		for (const entityId of collectTypedEntityIds(next, format, letter)) {
			if (!readTypedEntityUid(next, entityId, format)) continue;
			const stripped = stripTypedEntityUid(next, entityId, format, typeId);
			if (stripped !== next) {
				next = stripped;
				changed = true;
			}
		}
	}

	return { text: next, changed };
}

/**
 * Remove sharing-only markers (uid / team / fileuid) from every note in a
 * project folder. Called when a shared project converts back to solo.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @returns {Promise<number>} number of notes rewritten
 */
async function stripProjectHiddenIds(kbRootUri, folderPrefix) {
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
		const { text: next, changed } = stripSharingMarkersInText(text, fmt);
		if (changed) {
			await vscode.workspace.fs.writeFile(note.uri, Buffer.from(next, 'utf8'));
			files += 1;
		}
	});
	return files;
}

module.exports = {
	UID_KEY,
	FILE_UID_HEADER,
	newIssueUid,
	newFeatureUid,
	newFileUid,
	newConceptUid,
	newDecisionUid,
	ensureFileUidInHeader,
	stampMissingIssueUidsInText,
	stampMissingTypedUidsInText,
	collectTypedEntityIds,
	collectIssueIds,
	collectConceptIds,
	collectDecisionIds,
	readTypedEntityUid,
	renameTypedHeadingKey,
	stampProjectHiddenIds,
	stripProjectHiddenIds
};
