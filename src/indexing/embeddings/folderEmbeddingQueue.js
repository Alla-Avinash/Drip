'use strict';

/**
 * Per-KB queue of folder embedding jobs (keyed by folder_path).
 */

/**
 * @typedef {'upsert' | 'delete'} FolderEmbeddingJobReason
 * @typedef {{ folderPath: string, reason: FolderEmbeddingJobReason }} FolderEmbeddingJob
 */

/** @type {Map<string, Map<string, FolderEmbeddingJob>>} */
const queuesByKb = new Map();

/** @type {Map<string, Promise<{ processed: number, skippedBusy: boolean }>>} */
const inFlight = new Map();

/**
 * @param {import('vscode').Uri | { fsPath?: string } | string | null | undefined} kbRoot
 */
function kbKey(kbRoot) {
	if (!kbRoot) return '';
	if (typeof kbRoot === 'string') return kbRoot;
	return String(kbRoot.fsPath || '');
}

/**
 * @param {import('vscode').Uri | string} kbRootUri
 */
function getQueue(kbRootUri) {
	const key = kbKey(kbRootUri);
	let q = queuesByKb.get(key);
	if (!q) {
		q = new Map();
		queuesByKb.set(key, q);
	}
	return q;
}

/**
 * @param {import('vscode').Uri | string} kbRootUri
 * @param {string} folderPath
 * @param {FolderEmbeddingJobReason} reason
 */
function enqueueFolderEmbeddingJob(kbRootUri, folderPath, reason) {
	const { normalizeFolderPath } = require('./folderEmbeddingText');
	const folder = normalizeFolderPath(folderPath);
	const q = getQueue(kbRootUri);
	q.set(folder, {
		folderPath: folder,
		reason: reason === 'delete' ? 'delete' : 'upsert'
	});
}

/**
 * @param {import('vscode').Uri | string} kbRootUri
 * @param {string[]} folderPaths
 * @param {FolderEmbeddingJobReason} reason
 */
function enqueueFolderEmbeddingJobs(kbRootUri, folderPaths, reason) {
	for (const p of folderPaths || []) {
		if (p == null || p === '') continue;
		enqueueFolderEmbeddingJob(kbRootUri, p, reason);
	}
}

/**
 * @param {import('vscode').Uri | string} kbRootUri
 */
function pendingFolderEmbeddingJobCount(kbRootUri) {
	return getQueue(kbRootUri).size;
}

/**
 * @param {import('vscode').Uri | string} kbRootUri
 * @returns {FolderEmbeddingJob[]}
 */
function takeFolderEmbeddingJobs(kbRootUri) {
	const q = getQueue(kbRootUri);
	const jobs = [...q.values()];
	q.clear();
	return jobs;
}

/**
 * @param {import('vscode').Uri | string} kbRootUri
 * @param {(job: FolderEmbeddingJob) => Promise<void>} processJob
 * @returns {Promise<{ processed: number, skippedBusy: boolean }>}
 */
async function drainFolderEmbeddingQueue(kbRootUri, processJob) {
	const key = kbKey(kbRootUri);
	// Re-entrant calls must await the same in-flight drain instead of starting a
	// second one — otherwise the second caller returns early on a half-encoded index.
	const existing = inFlight.get(key);
	if (existing) {
		return existing;
	}
	const run = (async () => {
		let processed = 0;
		for (;;) {
			const jobs = takeFolderEmbeddingJobs(kbRootUri);
			if (!jobs.length) {
				break;
			}
			for (const job of jobs) {
				await processJob(job);
				processed++;
			}
		}
		return { processed, skippedBusy: false };
	})();
	inFlight.set(key, run);
	try {
		return await run;
	} finally {
		inFlight.delete(key);
	}
}

module.exports = {
	enqueueFolderEmbeddingJob,
	enqueueFolderEmbeddingJobs,
	pendingFolderEmbeddingJobCount,
	takeFolderEmbeddingJobs,
	drainFolderEmbeddingQueue
};
