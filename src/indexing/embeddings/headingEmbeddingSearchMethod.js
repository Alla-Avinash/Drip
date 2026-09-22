'use strict';

/**
 * Lock heading-embedding search strategy once per KB load (until VS Code restart / KB rebind).
 *
 * - vectorCount ≤ 1000 → `exact` (sqlite-vec)
 * - vectorCount > 1000 → `faiss` (ANN; persisted HNSW under `.dripindex/`)
 *
 * Does **not** re-count on every search.
 */

const { openDripIndexDb } = require('../dripIndexDb');
const { countHeadingEmbeddings } = require('./headingEmbeddingStore');

/** Cutover chosen by product decision (faiss_1000). */
const FAISS_VECTOR_THRESHOLD = 1000;

/**
 * @typedef {'exact' | 'faiss' | 'none'} HeadingEmbeddingSearchMethod
 * @typedef {{
 *   method: HeadingEmbeddingSearchMethod,
 *   vectorCount: number,
 *   lockedAt: number,
 *   kbFsPath: string
 * }} HeadingEmbeddingSearchLock
 */

/** @type {Map<string, HeadingEmbeddingSearchLock>} */
const locksByKb = new Map();

/**
 * @param {import('vscode').Uri | string | null | undefined} kbRootUri
 */
function kbKey(kbRootUri) {
	if (!kbRootUri) return '';
	if (typeof kbRootUri === 'string') return kbRootUri;
	return String(kbRootUri.fsPath || '');
}

/**
 * @param {number} vectorCount
 * @returns {HeadingEmbeddingSearchMethod}
 */
function chooseMethodForCount(vectorCount) {
	const n = Number(vectorCount) || 0;
	if (n <= 0) {
		return 'none';
	}
	if (n > FAISS_VECTOR_THRESHOLD) {
		return 'faiss';
	}
	return 'exact';
}

/**
 * Read vector count and lock method for this KB. Idempotent until {@link clearHeadingEmbeddingSearchLock}.
 * @param {import('vscode').Uri} kbRootUri
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<HeadingEmbeddingSearchLock>}
 */
async function lockHeadingEmbeddingSearchMethod(kbRootUri, opts) {
	const key = kbKey(kbRootUri);
	if (!key) {
		return { method: 'none', vectorCount: 0, lockedAt: Date.now(), kbFsPath: '' };
	}
	if (!opts?.force) {
		const existing = locksByKb.get(key);
		if (existing) {
			return existing;
		}
	}

	const handle = await openDripIndexDb(kbRootUri);
	let vectorCount = 0;
	try {
		vectorCount = countHeadingEmbeddings(handle.db);
	} finally {
		handle.close();
	}

	/** @type {HeadingEmbeddingSearchLock} */
	const lock = {
		method: chooseMethodForCount(vectorCount),
		vectorCount,
		lockedAt: Date.now(),
		kbFsPath: key
	};
	locksByKb.set(key, lock);
	console.log(
		`[DRIP] heading embedding search locked: method=${lock.method} vectors=${lock.vectorCount}`
	);

	if (lock.method === 'faiss') {
		void (async () => {
			try {
				const { ensureFaissSession, loadFaissModule } = require('./headingEmbeddingFaiss');
				if (!loadFaissModule()) {
					console.warn('[DRIP] FAISS locked but faiss-node missing; searches will use exact fallback');
					return;
				}
				const handle2 = await openDripIndexDb(kbRootUri);
				try {
					ensureFaissSession(kbRootUri, handle2.db);
				} finally {
					handle2.close();
				}
			} catch (err) {
				console.error('[DRIP] FAISS ensure on lock failed', err);
			}
		})();
	}

	return lock;
}

/**
 * @param {import('vscode').Uri | string} kbRootUri
 * @returns {HeadingEmbeddingSearchLock | undefined}
 */
function getLockedHeadingEmbeddingSearchMethod(kbRootUri) {
	return locksByKb.get(kbKey(kbRootUri));
}

/**
 * @param {import('vscode').Uri | string} [kbRootUri] — omit to clear all
 */
function clearHeadingEmbeddingSearchLock(kbRootUri) {
	if (kbRootUri == null || kbRootUri === '') {
		locksByKb.clear();
		try {
			require('./headingEmbeddingFaiss').clearFaissSession();
		} catch {
			/* optional */
		}
		return;
	}
	locksByKb.delete(kbKey(kbRootUri));
	try {
		require('./headingEmbeddingFaiss').clearFaissSession(kbRootUri);
	} catch {
		/* optional */
	}
}

module.exports = {
	FAISS_VECTOR_THRESHOLD,
	chooseMethodForCount,
	lockHeadingEmbeddingSearchMethod,
	getLockedHeadingEmbeddingSearchMethod,
	clearHeadingEmbeddingSearchLock
};
