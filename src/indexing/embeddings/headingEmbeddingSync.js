'use strict';

/**
 * Wire heading embeddings to index updates:
 * - Enqueue upserts when title / semantic tags change (or vector missing)
 * - Keep existing vector when only non-input fields change (body, workflow meta, …)
 * - Async drain: encode via Transformers.js → upsert into SQLite (plain BLOB)
 * - Startup / rebuild: enqueue headings that lack a vector
 */

const {
	buildHeadingEmbeddingText,
	buildHeadingEmbeddingTextFromDb,
	buildHeadingEmbeddingTextFromParsed,
	getHeadingTitle
} = require('./headingEmbeddingText');
const {
	enqueueHeadingEmbeddingJobs,
	drainHeadingEmbeddingQueue,
	pendingHeadingEmbeddingJobCount
} = require('./headingEmbeddingQueue');
const { encodeHeadingEmbeddingText } = require('./headingEmbeddingEncode');
const {
	getEmbeddingId,
	getEmbeddingMeta,
	upsertHeadingEmbedding,
	deleteHeadingEmbedding
} = require('./headingEmbeddingStore');

/** @type {Map<string, NodeJS.Timeout>} */
const drainTimers = new Map();

const DRAIN_DEBOUNCE_MS = 1500;

/**
 * @returns {typeof import('../dripIndexDb').openDripIndexDb}
 */
function openDripIndexDb(...args) {
	// Lazy require avoids circular load with dripIndexDb → sync.
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
 * Decide whether a heading still present after an incremental rewrite needs a new vector.
 * Call **before** deleting scoped rows (so old title/tags are still readable).
 *
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number} fileId
 * @param {number} headingId
 * @param {object} parsed
 * @returns {{ needUpsert: boolean, keepEmbedding: boolean }}
 */
function planHeadingEmbeddingRewrite(db, fileId, headingId, parsed) {
	const heading = (parsed.headings || []).find(h => Number(h.heading_id) === Number(headingId));
	if (!heading) {
		return { needUpsert: false, keepEmbedding: false };
	}
	const newText = buildHeadingEmbeddingTextFromParsed(heading, parsed);
	const hasVec = getEmbeddingId(db, fileId, headingId) != null;
	if (!hasVec) {
		return { needUpsert: true, keepEmbedding: false };
	}
	const oldText = buildHeadingEmbeddingTextFromDb(db, fileId, headingId);
	if (oldText === newText) {
		return { needUpsert: false, keepEmbedding: true };
	}
	return { needUpsert: true, keepEmbedding: false };
}

/**
 * After a full file replace (embeddings already cleared), every heading needs upsert.
 * @param {number} fileId
 * @param {object} parsed
 * @returns {{ fileId: number, headingId: number }[]}
 */
function collectAllHeadingEmbeddingTargets(fileId, parsed) {
	/** @type {{ fileId: number, headingId: number }[]} */
	const out = [];
	const seen = new Set();
	for (const h of parsed.headings || []) {
		const headingId = Number(h.heading_id);
		if (!Number.isFinite(headingId) || seen.has(headingId)) continue;
		seen.add(headingId);
		out.push({ fileId, headingId });
	}
	return out;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {{ fileId: number, headingId: number }[]} upserts
 */
function enqueueHeadingEmbeddingUpserts(kbRootUri, upserts) {
	if (!upserts || !upserts.length) {
		return;
	}
	enqueueHeadingEmbeddingJobs(kbRootUri, upserts, 'upsert');
	scheduleHeadingEmbeddingDrain(kbRootUri);
}

/**
 * Debounced background drain for a KB.
 * @param {import('vscode').Uri} kbRootUri
 */
function scheduleHeadingEmbeddingDrain(kbRootUri) {
	const key = kbKey(kbRootUri);
	const prev = drainTimers.get(key);
	if (prev) {
		clearTimeout(prev);
	}
	const timer = setTimeout(() => {
		drainTimers.delete(key);
		void runHeadingEmbeddingDrain(kbRootUri).catch(err => {
			console.error('[DRIP] heading embedding drain failed', err);
		});
	}, DRAIN_DEBOUNCE_MS);
	if (typeof timer.unref === 'function') {
		timer.unref();
	}
	drainTimers.set(key, timer);
}

/**
 * Cancel a pending debounced drain (e.g. before a synchronous await during reset).
 * @param {import('vscode').Uri} kbRootUri
 */
function cancelScheduledHeadingEmbeddingDrain(kbRootUri) {
	const key = kbKey(kbRootUri);
	const prev = drainTimers.get(key);
	if (prev) {
		clearTimeout(prev);
		drainTimers.delete(key);
	}
}

/**
 * Enqueue any missing heading vectors and drain until the queue is empty (blocks).
 * @param {import('vscode').Uri} kbRootUri
 * @param {{
 *   progress?: import('vscode').Progress<{ message?: string, increment?: number }>,
 *   token?: import('vscode').CancellationToken
 * }} [opts]
 * @returns {Promise<{ enqueued: number, processed: number }>}
 */
async function awaitHeadingEmbeddingsReady(kbRootUri, opts) {
	cancelScheduledHeadingEmbeddingDrain(kbRootUri);
	const enqueued = await enqueueMissingHeadingEmbeddings(kbRootUri);
	if (opts?.progress) {
		opts.progress.report({
			message:
				enqueued > 0
					? `Encoding ${enqueued} heading embedding(s)…`
					: 'Heading embeddings up to date'
		});
	}
	if (opts?.token?.isCancellationRequested) {
		return { enqueued, processed: 0 };
	}
	const result = await runHeadingEmbeddingDrain(kbRootUri);
	return { enqueued, processed: result.processed || 0 };
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {{ fileId: number, headingId: number, reason: string }} job
 */
async function processOneJob(kbRootUri, job) {
	if (job.reason === 'delete') {
		const handle = await openDripIndexDb(kbRootUri);
		try {
			deleteHeadingEmbedding(handle.db, job.fileId, job.headingId);
		} finally {
			handle.close();
		}
		return;
	}

	let text = '';
	let modelId = '';
	{
		const handle = await openDripIndexDb(kbRootUri);
		try {
			if (getHeadingTitle(handle.db, job.fileId, job.headingId) === undefined) {
				return;
			}
			text = buildHeadingEmbeddingTextFromDb(handle.db, job.fileId, job.headingId);
			modelId = getEmbeddingMeta(handle.db).model;
		} finally {
			handle.close();
		}
	}

	if (!String(text || '').trim()) {
		// Empty input — still store a vector of the fallback encode path in encodeHeadingEmbeddingText
		text = buildHeadingEmbeddingText({ title: '', tags: [] }) || ' ';
	}

	const vector = await encodeHeadingEmbeddingText(text, { modelId });

	const handle2 = await openDripIndexDb(kbRootUri);
	try {
		if (getHeadingTitle(handle2.db, job.fileId, job.headingId) === undefined) {
			return;
		}
		upsertHeadingEmbedding(handle2.db, job.fileId, job.headingId, vector);
	} finally {
		handle2.close();
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 */
async function runHeadingEmbeddingDrain(kbRootUri) {
	return drainHeadingEmbeddingQueue(kbRootUri, job => processOneJob(kbRootUri, job));
}

/**
 * Enqueue every heading that has no embedding_id yet.
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<number>} number enqueued
 */
async function enqueueMissingHeadingEmbeddings(kbRootUri) {
	const handle = await openDripIndexDb(kbRootUri);
	/** @type {{ fileId: number, headingId: number }[]} */
	const missing = [];
	try {
		const rows = handle.db.exec(
			`
			SELECT h.file_id, h.heading_id
			FROM headings h
			LEFT JOIN heading_embedding_records r
				ON r.file_id = h.file_id AND r.heading_id = h.heading_id
			WHERE r.embedding_id IS NULL
			ORDER BY h.file_id, h.heading_id
			`
		);
		if (rows.length) {
			for (const row of rows[0].values) {
				missing.push({
					fileId: Number(row[0]),
					headingId: Number(row[1])
				});
			}
		}
	} finally {
		handle.close();
	}
	enqueueHeadingEmbeddingUpserts(kbRootUri, missing);
	return missing.length;
}

/**
 * After rebuild / startup: fill any missing vectors in the background.
 * @param {import('vscode').Uri} kbRootUri
 */
async function repairHeadingEmbeddingsInBackground(kbRootUri) {
	const n = await enqueueMissingHeadingEmbeddings(kbRootUri);
	if (n > 0) {
		console.log(`[DRIP] queued ${n} heading embedding(s) for background encode`);
	}
	return n;
}

module.exports = {
	planHeadingEmbeddingRewrite,
	collectAllHeadingEmbeddingTargets,
	enqueueHeadingEmbeddingUpserts,
	scheduleHeadingEmbeddingDrain,
	cancelScheduledHeadingEmbeddingDrain,
	awaitHeadingEmbeddingsReady,
	runHeadingEmbeddingDrain,
	enqueueMissingHeadingEmbeddings,
	repairHeadingEmbeddingsInBackground,
	pendingHeadingEmbeddingJobCount,
	DRAIN_DEBOUNCE_MS
};
