'use strict';

/**
 * After a shared-project note is saved, stamp missing issue / concept / decision
 * uids and record creates, field/title/body edits, moves, and deletes so the
 * other machine can recreate the same text in the same place.
 */

const path = require('path');
const vscode = require('vscode');
const { projectFolderPrefixForPath, isProjectShared, projectFolderUriFromPrefix } = require('./projectSidecar');
const { stampMissingIssueUidsInText, stampMissingTypedUidsInText, collectIssueIds } = require('./projectHiddenIds');
const { noteFormatForPath } = require('../document/model/dripNoteFileTypes.js');
const { readIssueBlock } = require('../document/project/issueBlockEdit');
const { headingPathAboveIssue, headingNumForIssue, listSectionHeadings } = require('../document/project/issueInboxLayout');
const {
	recordLocalOperation,
	queueIssueCreate,
	queueIssueUpdate,
	cancelPendingIssue,
	queueHeadingUpdate,
	queueHeadingDelete,
	queueFileUpdate,
	detectProjectFileKind,
	OP_TYPES
} = require('./projectRecord');
const { markExpectedDiskWrite } = require('../shared/documentEditGuard');

/** @type {Map<string, Map<string, { issueKey: string, title: string, body: string, attributes: Record<string, string> }>>} */
const lastByFile = new Map();
/** @type {Map<string, Map<string, { path: string, title: string, persistent: boolean, body: string }>>} */
const lastHeadingsByFile = new Map();
/** @type {Map<string, string>} */
const lastFileTextByFile = new Map();

const SKIP_ATTRS = new Set(['uid']);

function snapshotIssues(text, format) {
	/** @type {Map<string, { issueKey: string, title: string, body: string, attributes: Record<string, string> }>} */
	const map = new Map();
	for (const issueKey of collectIssueIds(text, format)) {
		const block = readIssueBlock(text, issueKey, format);
		if (!block) continue;
		const uid = String((block.attributes && block.attributes.uid) || '').trim();
		if (!uid) continue;
		const attributes = {};
		for (const [k, v] of Object.entries(block.attributes || {})) {
			if (SKIP_ATTRS.has(String(k).toLowerCase())) continue;
			attributes[String(k).toLowerCase()] = String(v == null ? '' : v);
		}
		map.set(uid, {
			issueKey,
			title: String(block.title || ''),
			body: String(block.body || ''),
			headingPath: headingPathAboveIssue(text, issueKey, format) || '',
			attributes
		});
	}
	return map;
}

function attrsPayload(attributes) {
	const out = {};
	for (const [k, v] of Object.entries(attributes || {})) {
		if (SKIP_ATTRS.has(String(k).toLowerCase())) continue;
		out[String(k).toLowerCase()] = String(v == null ? '' : v);
	}
	return out;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @param {string} [text]
 */
async function synthesizeHandEditsOnSave(kbRootUri, noteUri, text) {
	if (!kbRootUri || !noteUri) return;
	const prefix = projectFolderPrefixForPath(kbRootUri.fsPath, noteUri.fsPath);
	if (!prefix) return;
	const folderUri = projectFolderUriFromPrefix(kbRootUri, prefix);
	if (!(await isProjectShared(folderUri))) return;
	try {
		const rec = await require('./projectSidecar').readProjectRecord(folderUri);
		if (!rec || !require('./projectLanSync').isSharingActive(rec.projectId)) return;
	} catch {
		return;
	}
	const fmt = noteFormatForPath(noteUri.fsPath) === '.d.md' ? 'drip-md' : 'drip-txt';
	const fileKey = noteUri.fsPath.replace(/\\/g, '/').toLowerCase();
	const prevKnown = lastByFile.get(fileKey);
	const reuseUidByIssueKey = new Map();
	if (prevKnown) {
		for (const [uid, row] of prevKnown) {
			if (row && row.issueKey) reuseUidByIssueKey.set(String(row.issueKey).toLowerCase(), uid);
		}
	}
	let src = text;
	if (src == null) {
		try {
			src = Buffer.from(await vscode.workspace.fs.readFile(noteUri)).toString('utf8');
		} catch {
			return;
		}
	}
	let stamped = stampMissingIssueUidsInText(src, fmt, reuseUidByIssueKey);
	const rel = path.relative(folderUri.fsPath, noteUri.fsPath).replace(/\\/g, '/');
	const fileKind = detectProjectFileKind(rel);
	if (fileKind === 'concept' || fileKind === 'decision') {
		stamped = {
			text: stampMissingTypedUidsInText(stamped.text, fmt, fileKind).text,
			stamped: stamped.stamped
		};
	}
	if (stamped.text !== src) {
		markExpectedDiskWrite(noteUri);
		await vscode.workspace.fs.writeFile(noteUri, Buffer.from(stamped.text, 'utf8'));
		src = stamped.text;
	}
	{
		const { isCompletedStatus, COMPLETED_FIELD, completedStampNow } = require('../document/project/issueCompletedStamp');
		const { updateIssueBlockText } = require('../document/project/issueBlockEdit');
		let next = src;
		for (const issueKey of collectIssueIds(next, fmt)) {
			const block = readIssueBlock(next, issueKey, fmt);
			if (!block || !isCompletedStatus(block.attributes && block.attributes.status)) continue;
			if (String((block.attributes && block.attributes[COMPLETED_FIELD]) || '').trim()) continue;
			const patched = updateIssueBlockText(
				next,
				issueKey,
				{ attributes: { status: 'completed', [COMPLETED_FIELD]: completedStampNow() } },
				fmt
			);
			if (patched.ok) next = patched.text;
		}
		if (next !== src) {
			markExpectedDiskWrite(noteUri);
			await vscode.workspace.fs.writeFile(noteUri, Buffer.from(next, 'utf8'));
			src = next;
		}
	}
	const now = snapshotIssues(src, fmt);
	const prev = prevKnown;
	const headingsNow = snapshotHeadings(src, fmt);
	const headingsPrev = lastHeadingsByFile.get(fileKey);

	if (headingsPrev) {
		for (const [path, cur] of headingsNow) {
			const before = headingsPrev.get(path);
			if (!before || before.body !== cur.body || before.title !== cur.title) {
				queueHeadingUpdate(kbRootUri, prefix, {
					rel,
					headingPath: path,
					title: cur.title,
					persistent: cur.persistent,
					body: cur.body
				});
			}
		}
		for (const [path] of headingsPrev) {
			if (headingsNow.has(path)) continue;
			queueHeadingDelete(kbRootUri, prefix, { rel, headingPath: path });
		}
	}

	for (const row of stamped.stamped) {
		if (reuseUidByIssueKey.get(String(row.issueId).toLowerCase()) === row.uid) continue;
		const cur = now.get(row.uid);
		queueIssueCreate(kbRootUri, prefix, {
			uid: row.uid,
			issueKey: row.issueId,
			title: (cur && cur.title) || '',
			parentIssueId: (cur && cur.attributes && cur.attributes.parent) || null,
			rel,
			headingPath: (cur && cur.headingPath) || '',
			headingNum: headingNumForIssue(stamped.text, row.issueId, fmt) || 0,
			body: (cur && cur.body) || '',
			attributes: cur ? attrsPayload(cur.attributes) : {}
		});
	}

	if (prev) {
		for (const [uid, cur] of now) {
			if (stamped.stamped.some(s => s.uid === uid)) continue;
			const before = prev.get(uid);
			if (!before) {
				queueIssueCreate(kbRootUri, prefix, {
					uid,
					issueKey: cur.issueKey,
					title: cur.title,
					parentIssueId: cur.attributes.parent || null,
					rel,
					headingPath: cur.headingPath || '',
					headingNum: headingNumForIssue(stamped.text, cur.issueKey, fmt) || 0,
					body: cur.body,
					attributes: attrsPayload(cur.attributes)
				});
				continue;
			}
			if (String(before.headingPath || '') !== String(cur.headingPath || '') && cur.headingPath) {
				await recordLocalOperation(kbRootUri, prefix, OP_TYPES.ISSUE_MOVE, {
					uid,
					issueKey: cur.issueKey,
					target: {
						kind: 'heading',
						headingPath: cur.headingPath,
						position: 'under',
						rel
					}
				});
			}
			const patch = { uid };
			if (before.title !== cur.title) patch.title = cur.title;
			const attrs = {};
			const keys = new Set([...Object.keys(before.attributes), ...Object.keys(cur.attributes)]);
			for (const field of keys) {
				if (String(before.attributes[field] || '') === String(cur.attributes[field] || '')) continue;
				attrs[field] = cur.attributes[field] || '';
			}
			if (Object.keys(attrs).length) patch.attributes = attrs;
			if (before.body !== cur.body) patch.body = cur.body;
			if (patch.title != null || patch.attributes || Object.prototype.hasOwnProperty.call(patch, 'body')) {
				queueIssueUpdate(kbRootUri, prefix, patch);
			}
		}
		for (const [uid, before] of prev) {
			if (now.has(uid)) continue;
			if (cancelPendingIssue(prefix, uid)) continue;
			await recordLocalOperation(kbRootUri, prefix, OP_TYPES.ISSUE_DELETE, {
				uid,
				issueKey: before.issueKey
			});
		}
	}

	lastByFile.set(fileKey, now);
	lastHeadingsByFile.set(fileKey, headingsNow);
	if (fileKind === 'concept' || fileKind === 'decision') {
		const prevText = lastFileTextByFile.get(fileKey);
		lastFileTextByFile.set(fileKey, src);
		const type = fileKind === 'decision' ? OP_TYPES.DECISION_UPDATE : OP_TYPES.CONCEPT_UPDATE;
		const createType = fileKind === 'decision' ? OP_TYPES.DECISION_CREATE : OP_TYPES.CONCEPT_CREATE;
		if (prevText == null) {
			await recordLocalOperation(kbRootUri, prefix, createType, { rel, text: src, kind: fileKind });
		} else if (prevText !== src) {
			queueFileUpdate(kbRootUri, prefix, type, { rel, text: src, kind: fileKind });
		}
		return;
	}
	if (fileKind === 'project-index' || fileKind === 'feature-index') {
		const prevText = lastFileTextByFile.get(fileKey);
		lastFileTextByFile.set(fileKey, src);
		if (prevText != null && prevText !== src) {
			queueFileUpdate(kbRootUri, prefix, OP_TYPES.NOTE_UPDATE, { rel, text: src, kind: fileKind });
		}
	}
}

function snapshotHeadings(text, format) {
	/** @type {Map<string, { path: string, title: string, persistent: boolean, body: string }>} */
	const map = new Map();
	for (const row of listSectionHeadings(text, format)) {
		if (!row.path) continue;
		map.set(row.path, row);
	}
	return map;
}

/**
 * Remember the current headings/issues so the next save only sends a real diff.
 * @param {import('vscode').Uri} noteUri
 * @param {string} text
 */
function rememberHandEditBaseline(noteUri, text) {
	if (!noteUri) return;
	const fmt = noteFormatForPath(noteUri.fsPath) === '.d.md' ? 'drip-md' : 'drip-txt';
	const fileKey = noteUri.fsPath.replace(/\\/g, '/').toLowerCase();
	lastByFile.set(fileKey, snapshotIssues(text, fmt));
	lastHeadingsByFile.set(fileKey, snapshotHeadings(text, fmt));
	lastFileTextByFile.set(fileKey, String(text || ''));
}

function seedHandEditBaseline(noteUri, text) {
	if (!noteUri) return;
	const fileKey = noteUri.fsPath.replace(/\\/g, '/').toLowerCase();
	if (!lastByFile.has(fileKey) || !lastHeadingsByFile.has(fileKey)) {
		rememberHandEditBaseline(noteUri, text);
	}
}

module.exports = {
	synthesizeHandEditsOnSave,
	seedHandEditBaseline,
	rememberHandEditBaseline
};
