'use strict';

/**
 * Record a local change as an operation on a shared project (file already written).
 */

const { createOperation, OP_TYPES } = require('./projectOp');
const { applyOperation } = require('./projectOpApply');
const { nextSeqFor } = require('./projectOpLog');
const { readProjectRecord, projectFolderUriFromPrefix } = require('./projectSidecar');
const { ensurePeerIdentity } = require('./peerIdentity');

const ISSUE_UPDATE_WAIT_MS = 8000;
/** @type {Map<string, { kbRootUri: import('vscode').Uri, folderPrefix: string, payload: object, timer: ReturnType<typeof setTimeout> }>} */
const pendingIssueCreates = new Map();
/** @type {Map<string, { kbRootUri: import('vscode').Uri, folderPrefix: string, payload: object, timer: ReturnType<typeof setTimeout> }>} */
const pendingIssueUpdates = new Map();
/** @type {Map<string, { kbRootUri: import('vscode').Uri, folderPrefix: string, payload: object, timer: ReturnType<typeof setTimeout> }>} */
const pendingHeadingUpdates = new Map();
/** @type {Map<string, { kbRootUri: import('vscode').Uri, folderPrefix: string, payload: object, timer: ReturnType<typeof setTimeout> }>} */
const pendingHeadingDeletes = new Map();
/** @type {Map<string, { kbRootUri: import('vscode').Uri, folderPrefix: string, type: string, payload: object, timer: ReturnType<typeof setTimeout> }>} */
const pendingFileUpdates = new Map();

function headingUpdateKey(folderPrefix, rel, headingPath) {
	return `${String(folderPrefix || '')}\0${String(rel || '')}\0${String(headingPath || '')}`;
}

function issueUpdateKey(folderPrefix, uid) {
	return `${String(folderPrefix || '')}\0${String(uid || '')}`;
}

function mergeIssueUpdatePayload(prev, next) {
	const out = { ...(prev || {}), ...(next || {}) };
	if ((prev && prev.attributes) || (next && next.attributes)) {
		out.attributes = { ...((prev && prev.attributes) || {}), ...((next && next.attributes) || {}) };
	}
	return out;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @returns {Promise<boolean>}
 */
async function isSharedProject(kbRootUri, folderPrefix) {
	const rec = await readProjectRecord(projectFolderUriFromPrefix(kbRootUri, folderPrefix));
	return !!(rec && rec.shared && rec.projectId);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} type
 * @param {object} payload
 */
async function recordLocalOperation(kbRootUri, folderPrefix, type, payload) {
	if (type !== OP_TYPES.ISSUE_UPDATE) {
		await flushPendingIssueUpdates(folderPrefix, payload && payload.uid);
	}
	if (type !== OP_TYPES.NOTE_HEADING_BODY_SET) {
		await flushPendingHeadingUpdates(folderPrefix);
	}
	if (type !== OP_TYPES.CONCEPT_UPDATE && type !== OP_TYPES.DECISION_UPDATE) {
		await flushPendingFileUpdates(folderPrefix);
	}
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await readProjectRecord(folderUri);
	if (!rec || !rec.shared || !rec.projectId) return null;
	try {
		if (!require('./projectLanSync').isSharingActive(rec.projectId)) return null;
	} catch {
		return null;
	}
	const me = await ensurePeerIdentity();
	const op = await createOperation({
		projectId: rec.projectId,
		type,
		payload,
		seq: await nextSeqFor(folderUri, me.peerId)
	});
	await applyOperation(kbRootUri, folderPrefix, op, { alreadyApplied: true });
	try {
		await require('./projectLanSync').publishLanOps(kbRootUri, folderPrefix, [op]);
	} catch (err) {
		console.error('[DRIP] lan op publish', err);
	}
	try {
		await require('./projectInternetSync').publishInternetOps(rec.projectId, rec.inviteCapability, [op]);
	} catch (err) {
		console.error('[DRIP] internet op publish', err);
	}
	try {
		const compactOp = await require('./projectOpLog').compactOpLogIfNeeded(kbRootUri, folderPrefix);
		if (compactOp) {
			try {
				await require('./projectLanSync').publishLanOps(kbRootUri, folderPrefix, [compactOp]);
			} catch {
				/* compact publish is best-effort */
			}
			try {
				await require('./projectInternetSync').publishInternetOps(
					rec.projectId,
					rec.inviteCapability,
					[compactOp]
				);
			} catch {
				/* compact publish is best-effort */
			}
		}
	} catch (err) {
		console.error('[DRIP] compact op log', err);
	}
	return op;
}

/**
 * Hold a create or edit until typing pauses so a half-written title is not sent.
 */
function armPending(map, key, kbRootUri, folderPrefix, payload, type) {
	const prev = map.get(key);
	const next = {
		kbRootUri,
		folderPrefix,
		payload: type === OP_TYPES.ISSUE_UPDATE || type === OP_TYPES.ISSUE_CREATE
			? mergeIssueUpdatePayload(prev && prev.payload, payload)
			: { ...(prev && prev.payload), ...payload }
	};
	if (prev && prev.timer) clearTimeout(prev.timer);
	next.timer = setTimeout(() => {
		map.delete(key);
		void recordLocalOperation(next.kbRootUri, next.folderPrefix, type, next.payload);
	}, ISSUE_UPDATE_WAIT_MS);
	map.set(key, next);
}

function cancelPending(map, key) {
	const item = map.get(key);
	if (!item) return false;
	if (item.timer) clearTimeout(item.timer);
	map.delete(key);
	return true;
}

/**
 * A new issue waits the same few seconds as an edit so a half-typed title
 * is not sent. Further keystrokes fold into this same create.
 */
function queueIssueCreate(kbRootUri, folderPrefix, payload) {
	const uid = String((payload && payload.uid) || '');
	if (!uid) return;
	const key = issueUpdateKey(folderPrefix, uid);
	cancelPending(pendingIssueUpdates, key);
	armPending(pendingIssueCreates, key, kbRootUri, folderPrefix, payload, OP_TYPES.ISSUE_CREATE);
}

function queueIssueUpdate(kbRootUri, folderPrefix, payload) {
	const uid = String((payload && payload.uid) || '');
	if (!uid) return;
	const key = issueUpdateKey(folderPrefix, uid);
	if (pendingIssueCreates.has(key)) {
		armPending(pendingIssueCreates, key, kbRootUri, folderPrefix, payload, OP_TYPES.ISSUE_CREATE);
		return;
	}
	armPending(pendingIssueUpdates, key, kbRootUri, folderPrefix, payload, OP_TYPES.ISSUE_UPDATE);
}

/** Drop a create that never went out (the issue was deleted while still being typed). */
function cancelPendingIssue(folderPrefix, uid) {
	const key = issueUpdateKey(folderPrefix, uid);
	return cancelPending(pendingIssueCreates, key) || cancelPending(pendingIssueUpdates, key);
}

/**
 * @param {string} [folderPrefix]
 * @param {string} [uid]
 */
async function flushPendingIssueUpdates(folderPrefix, uid) {
	const prefix = String(folderPrefix || '');
	const only = uid ? String(uid) : '';
	const jobs = [];
	for (const [map, type] of [
		[pendingIssueCreates, OP_TYPES.ISSUE_CREATE],
		[pendingIssueUpdates, OP_TYPES.ISSUE_UPDATE]
	]) {
		for (const [key, item] of map) {
			if (prefix && item.folderPrefix !== prefix) continue;
			if (only && String(item.payload.uid || '') !== only) continue;
			if (item.timer) clearTimeout(item.timer);
			map.delete(key);
			jobs.push(recordLocalOperation(item.kbRootUri, item.folderPrefix, type, item.payload));
		}
	}
	if (jobs.length) await Promise.all(jobs);
}

/**
 * Heading body / title waits the same few seconds as an issue edit.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {object} payload
 */
function queueHeadingUpdate(kbRootUri, folderPrefix, payload) {
	const headingPath = String((payload && payload.headingPath) || '');
	const rel = String((payload && payload.rel) || '');
	if (!headingPath || !rel) return;
	const key = headingUpdateKey(folderPrefix, rel, headingPath);
	cancelPending(pendingHeadingDeletes, key);
	armPending(pendingHeadingUpdates, key, kbRootUri, folderPrefix, payload, OP_TYPES.NOTE_HEADING_BODY_SET);
}

/**
 * Wait before deleting a heading. If that path still has a create that never
 * went out (half-typed title), drop it and send nothing.
 */
function queueHeadingDelete(kbRootUri, folderPrefix, payload) {
	const headingPath = String((payload && payload.headingPath) || '');
	const rel = String((payload && payload.rel) || '');
	if (!headingPath || !rel) return;
	const key = headingUpdateKey(folderPrefix, rel, headingPath);
	if (cancelPending(pendingHeadingUpdates, key)) return;
	armPending(pendingHeadingDeletes, key, kbRootUri, folderPrefix, { rel, headingPath }, OP_TYPES.HEADING_DELETE);
}

/**
 * @param {string} [folderPrefix]
 */
async function flushPendingHeadingUpdates(folderPrefix) {
	const prefix = String(folderPrefix || '');
	const jobs = [];
	for (const [map, type] of [
		[pendingHeadingDeletes, OP_TYPES.HEADING_DELETE],
		[pendingHeadingUpdates, OP_TYPES.NOTE_HEADING_BODY_SET]
	]) {
		for (const [key, item] of map) {
			if (prefix && item.folderPrefix !== prefix) continue;
			if (item.timer) clearTimeout(item.timer);
			map.delete(key);
			jobs.push(recordLocalOperation(item.kbRootUri, item.folderPrefix, type, item.payload));
		}
	}
	if (jobs.length) await Promise.all(jobs);
}

function dropPendingInMap(map, folderPrefix) {
	const prefix = String(folderPrefix || '');
	for (const [key, item] of map) {
		if (prefix && item.folderPrefix !== prefix) continue;
		if (item.timer) clearTimeout(item.timer);
		map.delete(key);
	}
}

/**
 * Sharing stopped: forget queued creates/edits so half-typed headings are not sent.
 */
function dropPendingProjectEdits(folderPrefix) {
	dropPendingInMap(pendingIssueCreates, folderPrefix);
	dropPendingInMap(pendingIssueUpdates, folderPrefix);
	dropPendingInMap(pendingHeadingUpdates, folderPrefix);
	dropPendingInMap(pendingHeadingDeletes, folderPrefix);
	dropPendingInMap(pendingFileUpdates, folderPrefix);
}

/**
 * Record a new project file (feature / note / concept / decision) after it is written.
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} fileUri
 * @param {{ kind?: string, title?: string, displayKey?: string, uid?: string, folderRel?: string }} [extra]
 */
async function recordNewProjectFile(kbRootUri, fileUri, extra) {
	if (!kbRootUri || !fileUri) return null;
	const { projectFolderPrefixForPath } = require('./projectSidecar');
	const prefix = projectFolderPrefixForPath(kbRootUri.fsPath, fileUri.fsPath);
	if (!prefix || !(await isSharedProject(kbRootUri, prefix))) return null;
	const folderUri = projectFolderUriFromPrefix(kbRootUri, prefix);
	const rel = require('path')
		.relative(folderUri.fsPath, fileUri.fsPath)
		.replace(/\\/g, '/');
	if (!rel || rel.startsWith('..')) return null;
	let text = '';
	try {
		text = Buffer.from(await require('vscode').workspace.fs.readFile(fileUri)).toString('utf8');
	} catch {
		return null;
	}
	const kind = String((extra && extra.kind) || detectProjectFileKind(rel));
	const type =
		kind === 'feature'
			? OP_TYPES.FEATURE_CREATE
			: kind === 'concept'
				? OP_TYPES.CONCEPT_CREATE
				: kind === 'decision'
					? OP_TYPES.DECISION_CREATE
					: OP_TYPES.NOTE_CREATE;
	try {
		require('./projectHandEdit').seedHandEditBaseline(fileUri, text);
	} catch {
		/* baseline is optional */
	}
	return recordLocalOperation(kbRootUri, prefix, type, {
		rel,
		text,
		kind,
		title: (extra && extra.title) || '',
		displayKey: (extra && extra.displayKey) || '',
		uid: (extra && extra.uid) || '',
		folderRel: (extra && extra.folderRel) || ''
	});
}

function fileUpdateKey(folderPrefix, rel) {
	return `${String(folderPrefix || '')}\0${String(rel || '')}`;
}

/**
 * A later save of a concept / decision note waits a few seconds, same as an issue edit.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} type
 * @param {object} payload
 */
function queueFileUpdate(kbRootUri, folderPrefix, type, payload) {
	const rel = String((payload && payload.rel) || '');
	if (!rel) return;
	const key = fileUpdateKey(folderPrefix, rel);
	const prev = pendingFileUpdates.get(key);
	const next = {
		kbRootUri,
		folderPrefix,
		type,
		payload: { ...(prev && prev.payload), ...payload }
	};
	if (prev && prev.timer) clearTimeout(prev.timer);
	next.timer = setTimeout(() => {
		pendingFileUpdates.delete(key);
		void recordLocalOperation(next.kbRootUri, next.folderPrefix, next.type, next.payload);
	}, ISSUE_UPDATE_WAIT_MS);
	pendingFileUpdates.set(key, next);
}

/**
 * @param {string} [folderPrefix]
 */
async function flushPendingFileUpdates(folderPrefix) {
	const prefix = String(folderPrefix || '');
	const jobs = [];
	for (const [key, item] of pendingFileUpdates) {
		if (prefix && item.folderPrefix !== prefix) continue;
		if (item.timer) clearTimeout(item.timer);
		pendingFileUpdates.delete(key);
		jobs.push(recordLocalOperation(item.kbRootUri, item.folderPrefix, item.type, item.payload));
	}
	if (jobs.length) await Promise.all(jobs);
}

/**
 * Record that a concept / decision note was deleted so the other machine removes it too.
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} fileUri
 */
async function recordDeletedProjectFile(kbRootUri, fileUri) {
	if (!kbRootUri || !fileUri) return null;
	const { projectFolderPrefixForPath } = require('./projectSidecar');
	const prefix = projectFolderPrefixForPath(kbRootUri.fsPath, fileUri.fsPath);
	if (!prefix || !(await isSharedProject(kbRootUri, prefix))) return null;
	const folderUri = projectFolderUriFromPrefix(kbRootUri, prefix);
	const rel = require('path')
		.relative(folderUri.fsPath, fileUri.fsPath)
		.replace(/\\/g, '/');
	if (!rel || rel.startsWith('..')) return null;
	const kind = detectProjectFileKind(rel);
	if (kind !== 'concept' && kind !== 'decision') return null;
	return recordLocalOperation(
		kbRootUri,
		prefix,
		kind === 'decision' ? OP_TYPES.DECISION_DELETE : OP_TYPES.CONCEPT_DELETE,
		{ rel, kind }
	);
}

function detectProjectFileKind(rel) {
	const n = String(rel || '').replace(/\\/g, '/').toLowerCase();
	if (n.includes('/_concepts/') || n.startsWith('_concepts/')) return 'concept';
	if (n.includes('/_decisions/') || n.startsWith('_decisions/')) return 'decision';
	const base = n.split('/').pop() || n;
	if (/^_.+\.p\.d\.(txt|md)$/.test(base)) return 'project-index';
	if (/^_.+\.f\.d\.(txt|md)$/.test(base)) return 'feature-index';
	if (/(^|\/)[^/]+\.f(\/|\.d\.)/.test(n)) return 'feature';
	return 'note';
}

module.exports = {
	OP_TYPES,
	isSharedProject,
	recordLocalOperation,
	recordNewProjectFile,
	recordDeletedProjectFile,
	queueIssueCreate,
	queueIssueUpdate,
	cancelPendingIssue,
	flushPendingIssueUpdates,
	queueHeadingUpdate,
	queueHeadingDelete,
	flushPendingHeadingUpdates,
	dropPendingProjectEdits,
	queueFileUpdate,
	flushPendingFileUpdates,
	detectProjectFileKind,
	ISSUE_UPDATE_WAIT_MS
};
