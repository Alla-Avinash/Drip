'use strict';

/**
 * Durable per-project operation log and version-vector checkpoints.
 */

const {
	readOpsJsonl,
	appendOpJsonl,
	writeOpsJsonl,
	readSyncState,
	writeSyncState,
	emptySyncState,
	readProjectRecord,
	projectFolderUriFromPrefix
} = require('./projectSidecar');

const COMPACT_AFTER = 80;
const COMPACT_TAIL = 16;
const COMPACT_COOLDOWN_MS = 120000;

/**
 * @param {import('vscode').Uri} projectFolderUri
 */
async function listOperations(projectFolderUri) {
	return readOpsJsonl(projectFolderUri);
}

/**
 * @param {import('vscode').Uri} projectFolderUri
 * @param {string} opId
 */
async function hasOperation(projectFolderUri, opId) {
	const ops = await listOperations(projectFolderUri);
	return ops.some(op => op && op.opId === opId);
}

/**
 * Forget this project's shared history. Used when a project is converted back
 * to solo so a future re-share starts clean and never replays the close
 * operation or any old member changes.
 * @param {import('vscode').Uri} projectFolderUri
 */
async function resetProjectLog(projectFolderUri) {
	await writeOpsJsonl(projectFolderUri, []);
	await writeSyncState(projectFolderUri, emptySyncState());
}

/**
 * Append if this op id is new. Updates the local version vector for the author.
 * @param {import('vscode').Uri} projectFolderUri
 * @param {object} op
 */
async function appendOperation(projectFolderUri, op) {
	if (!op || !op.opId) throw new Error('Operation is missing an id.');
	if (await hasOperation(projectFolderUri, op.opId)) return { appended: false, op };
	await appendOpJsonl(projectFolderUri, op);
	const sync = await readSyncState(projectFolderUri);
	const seq = Math.max(1, Math.floor(Number(op.seq) || 1));
	const prev = Math.floor(Number(sync.vector[op.author]) || 0);
	if (seq > prev) sync.vector[op.author] = seq;
	if (!sync.appliedOpIds.includes(op.opId)) sync.appliedOpIds.push(op.opId);
	if (sync.appliedOpIds.length > 5000) sync.appliedOpIds = sync.appliedOpIds.slice(-4000);
	await writeSyncState(projectFolderUri, sync);
	return { appended: true, op };
}

/**
 * @param {import('vscode').Uri} projectFolderUri
 * @returns {Promise<Record<string, number>>}
 */
async function readVersionVector(projectFolderUri) {
	const sync = await readSyncState(projectFolderUri);
	return { ...(sync.vector || {}) };
}

/**
 * Ops we have that the other peer is missing, based on their vector.
 * @param {import('vscode').Uri} projectFolderUri
 * @param {Record<string, number>} theirVector
 */
async function opsMissingFrom(projectFolderUri, theirVector) {
	const theirs = theirVector && typeof theirVector === 'object' ? theirVector : {};
	const ops = await listOperations(projectFolderUri);
	return ops.filter(op => {
		if (!op || !op.author) return false;
		const seen = Math.floor(Number(theirs[op.author]) || 0);
		const seq = Math.floor(Number(op.seq) || 0);
		return seq > seen;
	});
}

/**
 * Next sequence number this local peer should use.
 * @param {import('vscode').Uri} projectFolderUri
 * @param {string} peerId
 */
async function nextSeqFor(projectFolderUri, peerId) {
	const vec = await readVersionVector(projectFolderUri);
	return Math.floor(Number(vec[peerId]) || 0) + 1;
}

/**
 * @param {import('vscode').Uri} projectFolderUri
 * @param {string} message
 */
async function pushNotice(projectFolderUri, message) {
	const sync = await readSyncState(projectFolderUri);
	sync.notices = sync.notices || [];
	sync.notices.push({ at: new Date().toISOString(), message: String(message || '') });
	if (sync.notices.length > 40) sync.notices = sync.notices.slice(-30);
	await writeSyncState(projectFolderUri, sync);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function logForProject(kbRootUri, folderPrefix) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	return {
		folderUri,
		record: await readProjectRecord(folderUri)
	};
}

/**
 * True when this machine no longer has every op the other person is missing.
 * They need the current folder, not a replay of deleted history.
 * @param {import('vscode').Uri} projectFolderUri
 * @param {Record<string, number>} theirVector
 */
async function cannotFillGap(projectFolderUri, theirVector) {
	const ours = await readVersionVector(projectFolderUri);
	const ops = await listOperations(projectFolderUri);
	/** @type {Map<string, Set<number>>} */
	const have = new Map();
	for (const op of ops) {
		if (!op || !op.author) continue;
		let set = have.get(op.author);
		if (!set) {
			set = new Set();
			have.set(op.author, set);
		}
		set.add(Math.floor(Number(op.seq) || 0));
	}
	const theirs = theirVector && typeof theirVector === 'object' ? theirVector : {};
	for (const [author, seq] of Object.entries(ours)) {
		const from = Math.floor(Number(theirs[author]) || 0) + 1;
		const to = Math.floor(Number(seq) || 0);
		const set = have.get(author) || new Set();
		for (let s = from; s <= to; s += 1) {
			if (!set.has(s)) return true;
		}
	}
	return false;
}

async function opsForHello(projectFolderUri) {
	const ops = await listOperations(projectFolderUri);
	return ops.slice(-40);
}

/**
 * Drop ops already covered by a compact checkpoint. Keeps the compact op itself
 * and anything newer than that checkpoint.
 * @param {import('vscode').Uri} projectFolderUri
 * @param {Record<string, number>} vector
 * @param {string} [keepOpId]
 */
async function trimOpsCoveredByVector(projectFolderUri, vector, keepOpId) {
	const ops = await listOperations(projectFolderUri);
	const vec = vector && typeof vector === 'object' ? vector : {};
	const kept = ops.filter(op => {
		if (!op) return false;
		if (keepOpId && op.opId === keepOpId) return true;
		const seen = Math.floor(Number(vec[op.author]) || 0);
		return Math.floor(Number(op.seq) || 0) > seen;
	});
	if (kept.length < ops.length) await writeOpsJsonl(projectFolderUri, kept);
	return kept.length;
}

/**
 * Admin only: fold old history into the current files and keep a short tail.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function compactOpLogIfNeeded(kbRootUri, folderPrefix) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await readProjectRecord(folderUri);
	if (!rec || !rec.shared || !rec.projectId) return null;
	const { ensurePeerIdentity } = require('./peerIdentity');
	const { isAdmin } = require('./projectSharing');
	const me = await ensurePeerIdentity();
	if (!isAdmin(rec, me.peerId)) return null;
	const ops = await listOperations(folderUri);
	if (ops.length < COMPACT_AFTER) return null;
	const sync = await readSyncState(folderUri);
	if (sync.lastCompactAt && Date.now() - Date.parse(String(sync.lastCompactAt)) < COMPACT_COOLDOWN_MS) {
		return null;
	}
	const vector = await readVersionVector(folderUri);
	const { createOperation, OP_TYPES } = require('./projectOp');
	const compactOp = await createOperation({
		projectId: rec.projectId,
		type: OP_TYPES.PROJECT_COMPACT,
		payload: { vector },
		seq: await nextSeqFor(folderUri, me.peerId)
	});
	const tail = ops.slice(-COMPACT_TAIL);
	const kept = [compactOp, ...tail.filter(o => o && o.opId !== compactOp.opId)];
	await writeOpsJsonl(folderUri, kept);
	sync.compactedVector = vector;
	sync.lastCompactAt = new Date().toISOString();
	const prev = Math.floor(Number(sync.vector[me.peerId]) || 0);
	if (compactOp.seq > prev) sync.vector[me.peerId] = compactOp.seq;
	if (!sync.appliedOpIds.includes(compactOp.opId)) sync.appliedOpIds.push(compactOp.opId);
	await writeSyncState(folderUri, sync);
	return compactOp;
}

module.exports = {
	listOperations,
	hasOperation,
	appendOperation,
	resetProjectLog,
	readVersionVector,
	opsMissingFrom,
	nextSeqFor,
	pushNotice,
	logForProject,
	cannotFillGap,
	opsForHello,
	trimOpsCoveredByVector,
	compactOpLogIfNeeded,
	COMPACT_AFTER,
	COMPACT_TAIL
};
