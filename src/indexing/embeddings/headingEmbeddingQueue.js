'use strict';

/**
 * Per-KB queue of heading embedding jobs.
 *
 * Step 4: queue API only — not wired to index update / startup yet (Step 5).
 *
 * Jobs are deduped by `fileId:headingId` (last reason wins). Deletes are applied
 * immediately by the processor when wired; until then callers may still enqueue them.
 */

/**
 * @typedef {'upsert' | 'delete'} HeadingEmbeddingJobReason
 * @typedef {{ fileId: number, headingId: number, reason: HeadingEmbeddingJobReason }} HeadingEmbeddingJob
 */

/** @type {Map<string, Map<string, HeadingEmbeddingJob>>} kbKey → jobKey → job */
const queuesByKb = new Map();

/** @type {Map<string, Promise<{ processed: number, skippedBusy: boolean }>>} */
const inFlight = new Map();

/**
 * @param {import('vscode').Uri | { fsPath?: string } | string | null | undefined} kbRoot
 * @returns {string}
 */
function kbKey(kbRoot) {
	if (!kbRoot) {
		return '';
	}
	if (typeof kbRoot === 'string') {
		return kbRoot;
	}
	return String(kbRoot.fsPath || '');
}

/**
 * @param {number} fileId
 * @param {number} headingId
 */
function jobKey(fileId, headingId) {
	return `${Number(fileId)}:${Number(headingId)}`;
}

/**
 * @param {import('vscode').Uri | string} kbRootUri
 * @returns {Map<string, HeadingEmbeddingJob>}
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
 * @param {number} fileId
 * @param {number} headingId
 * @param {HeadingEmbeddingJobReason} reason
 */
function enqueueHeadingEmbeddingJob(kbRootUri, fileId, headingId, reason) {
	const q = getQueue(kbRootUri);
	const k = jobKey(fileId, headingId);
	q.set(k, {
		fileId: Number(fileId),
		headingId: Number(headingId),
		reason: reason === 'delete' ? 'delete' : 'upsert'
	});
}

/**
 * @param {import('vscode').Uri | string} kbRootUri
 * @param {{ fileId: number, headingId: number }[]} headings
 * @param {HeadingEmbeddingJobReason} reason
 */
function enqueueHeadingEmbeddingJobs(kbRootUri, headings, reason) {
	for (const h of headings || []) {
		if (h == null || h.fileId == null || h.headingId == null) {
			continue;
		}
		enqueueHeadingEmbeddingJob(kbRootUri, h.fileId, h.headingId, reason);
	}
}

/**
 * @param {import('vscode').Uri | string} kbRootUri
 * @returns {number}
 */
function pendingHeadingEmbeddingJobCount(kbRootUri) {
	return getQueue(kbRootUri).size;
}

/**
 * Snapshot and clear pending jobs for a KB.
 * @param {import('vscode').Uri | string} kbRootUri
 * @returns {HeadingEmbeddingJob[]}
 */
function takeHeadingEmbeddingJobs(kbRootUri) {
	const q = getQueue(kbRootUri);
	const jobs = [...q.values()];
	q.clear();
	return jobs;
}

/**
 * Drain the queue with an async worker. Re-entrant safe per KB (skips if already draining).
 * @param {import('vscode').Uri | string} kbRootUri
 * @param {(job: HeadingEmbeddingJob) => Promise<void>} worker
 * @returns {Promise<{ processed: number, skippedBusy: boolean }>}
 */
async function drainHeadingEmbeddingQueue(kbRootUri, worker) {
	const key = kbKey(kbRootUri);
	// Re-entrant calls (e.g. the debounced background drain running while the reset
	// awaits) must await the same in-flight drain instead of starting a second one —
	// otherwise the second caller would return early and read a half-encoded index.
	const existing = inFlight.get(key);
	if (existing) {
		return existing;
	}
	const run = (async () => {
		let processed = 0;
		for (;;) {
			const jobs = takeHeadingEmbeddingJobs(kbRootUri);
			if (!jobs.length) {
				break;
			}
			for (const job of jobs) {
				await worker(job);
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

/**
 * @param {import('vscode').Uri | string} [kbRootUri] — omit to clear all KBs
 */
function clearHeadingEmbeddingQueue(kbRootUri) {
	if (kbRootUri == null || kbRootUri === '') {
		queuesByKb.clear();
		inFlight.clear();
		return;
	}
	const key = kbKey(kbRootUri);
	queuesByKb.delete(key);
	inFlight.delete(key);
}

module.exports = {
	enqueueHeadingEmbeddingJob,
	enqueueHeadingEmbeddingJobs,
	pendingHeadingEmbeddingJobCount,
	takeHeadingEmbeddingJobs,
	drainHeadingEmbeddingQueue,
	clearHeadingEmbeddingQueue
};
