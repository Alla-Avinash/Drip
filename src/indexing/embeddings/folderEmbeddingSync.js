'use strict';

/**
 * Wire folder embeddings to index updates:
 * - Derive folders from indexed note paths (ancestors)
 * - Upsert when a note under the folder changes (path / h0 may change)
 * - Delete orphans when no notes remain under a folder path
 * - Exact sqlite-vec only (no FAISS)
 */

const {
	normalizeFolderPath,
	ancestorFolderPathsOfNote,
	listFolderPathsFromFiles,
	buildFolderEmbeddingTextFromDb
} = require('./folderEmbeddingText');
const {
	enqueueFolderEmbeddingJobs,
	drainFolderEmbeddingQueue,
	pendingFolderEmbeddingJobCount
} = require('./folderEmbeddingQueue');
const { encodeHeadingEmbeddingText } = require('./headingEmbeddingEncode');
const { isProjectNotePath } = require('../projectIndex');
const {
	getFolderEmbeddingId,
	upsertFolderEmbedding,
	deleteFolderEmbedding,
	listFolderEmbeddingRecords
} = require('./folderEmbeddingStore');
const { getEmbeddingMeta } = require('./headingEmbeddingStore');

/** @type {Map<string, NodeJS.Timeout>} */
const drainTimers = new Map();
const DRAIN_DEBOUNCE_MS = 1500;

/**
 * @returns {typeof import('../dripIndexDb').openDripIndexDb}
 */
function openDripIndexDb(...args) {
	return require('../dripIndexDb').openDripIndexDb(...args);
}

/**
 * @param {import('vscode').Uri | string} kbRootUri
 */
function kbKey(kbRootUri) {
	if (!kbRootUri) return '';
	if (typeof kbRootUri === 'string') return kbRootUri;
	return String(kbRootUri.fsPath || '');
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string[]} folderPaths
 */
function enqueueFolderEmbeddingUpserts(kbRootUri, folderPaths) {
	if (!folderPaths || !folderPaths.length) {
		return;
	}
	enqueueFolderEmbeddingJobs(kbRootUri, folderPaths, 'upsert');
	scheduleFolderEmbeddingDrain(kbRootUri);
}

/**
 * After a note path is indexed or updated, refresh all ancestor folder vectors.
 * Project-zone notes are skipped — their folders must not gain folder vectors here.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} noteRelPath
 */
function enqueueFolderEmbeddingsForNotePath(kbRootUri, noteRelPath) {
	if (isProjectNotePath(noteRelPath)) return;
	enqueueFolderEmbeddingUpserts(kbRootUri, ancestorFolderPathsOfNote(noteRelPath));
}

/**
 * @param {import('vscode').Uri} kbRootUri
 */
function scheduleFolderEmbeddingDrain(kbRootUri) {
	const key = kbKey(kbRootUri);
	const prev = drainTimers.get(key);
	if (prev) {
		clearTimeout(prev);
	}
	const timer = setTimeout(() => {
		drainTimers.delete(key);
		void runFolderEmbeddingDrain(kbRootUri).catch(err => {
			console.error('[DRIP] folder embedding drain failed', err);
		});
	}, DRAIN_DEBOUNCE_MS);
	if (typeof timer.unref === 'function') {
		timer.unref();
	}
	drainTimers.set(key, timer);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 */
function cancelScheduledFolderEmbeddingDrain(kbRootUri) {
	const key = kbKey(kbRootUri);
	const prev = drainTimers.get(key);
	if (prev) {
		clearTimeout(prev);
		drainTimers.delete(key);
	}
}

/**
 * Enqueue missing folder vectors and drain until empty (blocks).
 * @param {import('vscode').Uri} kbRootUri
 * @param {{
 *   progress?: import('vscode').Progress<{ message?: string, increment?: number }>,
 *   token?: import('vscode').CancellationToken
 * }} [opts]
 * @returns {Promise<{ enqueued: number, processed: number }>}
 */
async function awaitFolderEmbeddingsReady(kbRootUri, opts) {
	cancelScheduledFolderEmbeddingDrain(kbRootUri);
	// Loop until nothing is missing: enqueue whatever lacks a vector, drain, repeat.
	let enqueued = 0;
	let processed = 0;
	for (;;) {
		const n = await enqueueMissingFolderEmbeddings(kbRootUri);
		if (n > 0) {
			enqueued += n;
			if (opts?.progress) {
				opts.progress.report({ message: `Encoding ${n} folder embedding(s)…` });
			}
		}
		if (opts?.token?.isCancellationRequested) {
			break;
		}
		const result = await runFolderEmbeddingDrain(kbRootUri);
		processed += result.processed || 0;
		if (n === 0) {
			break;
		}
	}
	return { enqueued, processed };
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {{ folderPath: string, reason: string }} job
 */
async function processOneFolderJob(kbRootUri, job) {
	const folderPath = normalizeFolderPath(job.folderPath);

	if (job.reason === 'delete') {
		const handle = await openDripIndexDb(kbRootUri);
		try {
			deleteFolderEmbedding(handle.db, folderPath);
		} finally {
			handle.close();
		}
		return;
	}

	let text = '';
	let modelId = '';
	let stillPresent = false;
	{
		const handle = await openDripIndexDb(kbRootUri);
		try {
			const live = new Set(listFolderPathsFromFiles(handle.db));
			stillPresent = live.has(folderPath);
			if (!stillPresent) {
				deleteFolderEmbedding(handle.db, folderPath);
				return;
			}
			text = buildFolderEmbeddingTextFromDb(handle.db, folderPath);
			modelId = getEmbeddingMeta(handle.db).model;
		} finally {
			handle.close();
		}
	}

	if (!String(text || '').trim()) {
		text = folderPath || '.';
	}

	const vector = await encodeHeadingEmbeddingText(text, { modelId });

	const handle2 = await openDripIndexDb(kbRootUri);
	try {
		const live = new Set(listFolderPathsFromFiles(handle2.db));
		if (!live.has(folderPath)) {
			deleteFolderEmbedding(handle2.db, folderPath);
			return;
		}
		upsertFolderEmbedding(handle2.db, folderPath, vector);
	} finally {
		handle2.close();
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 */
async function runFolderEmbeddingDrain(kbRootUri) {
	return drainFolderEmbeddingQueue(kbRootUri, job => processOneFolderJob(kbRootUri, job));
}

/**
 * Enqueue folders that lack a vector; delete orphan records.
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<number>} number of upserts enqueued
 */
async function enqueueMissingFolderEmbeddings(kbRootUri) {
	const handle = await openDripIndexDb(kbRootUri);
	/** @type {string[]} */
	const missing = [];
	/** @type {string[]} */
	const orphans = [];
	try {
		const live = new Set(listFolderPathsFromFiles(handle.db));
		for (const folderPath of live) {
			if (getFolderEmbeddingId(handle.db, folderPath) == null) {
				missing.push(folderPath);
			}
		}
		for (const rec of listFolderEmbeddingRecords(handle.db)) {
			if (!live.has(normalizeFolderPath(rec.folder_path))) {
				orphans.push(rec.folder_path);
			}
		}
		for (const orphan of orphans) {
			deleteFolderEmbedding(handle.db, orphan);
		}
	} finally {
		handle.close();
	}
	enqueueFolderEmbeddingUpserts(kbRootUri, missing);
	return missing.length;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 */
async function repairFolderEmbeddingsInBackground(kbRootUri) {
	const n = await enqueueMissingFolderEmbeddings(kbRootUri);
	if (n > 0) {
		console.log(`[DRIP] queued ${n} folder embedding(s) for background encode`);
	}
	return n;
}

module.exports = {
	enqueueFolderEmbeddingUpserts,
	enqueueFolderEmbeddingsForNotePath,
	scheduleFolderEmbeddingDrain,
	cancelScheduledFolderEmbeddingDrain,
	awaitFolderEmbeddingsReady,
	runFolderEmbeddingDrain,
	enqueueMissingFolderEmbeddings,
	repairFolderEmbeddingsInBackground,
	pendingFolderEmbeddingJobCount,
	DRAIN_DEBOUNCE_MS
};
