'use strict';

/**
 * Keep tag embeddings in sync with the `tags` table (sqlite-vec only).
 * Encodes missing tags with the same MiniLM model as headings.
 */

const { openDripIndexDb } = require('../dripIndexDb');
const { getEmbeddingMeta } = require('./headingEmbeddingStore');
const { encodeHeadingEmbeddingText } = require('./headingEmbeddingEncode');
const {
	ensureTagEmbeddingStorage,
	upsertTagEmbedding,
	listTagsMissingEmbeddings
} = require('./tagEmbeddingStore');

/** @type {Map<string, Promise<void>>} */
const syncInFlight = new Map();

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {string}
 */
function kbKey(kbRootUri) {
	return String(kbRootUri && kbRootUri.fsPath ? kbRootUri.fsPath : '')
		.replace(/\\/g, '/')
		.toLowerCase();
}

/**
 * Encode any tags that do not yet have a vector. Safe to call often (no-op when complete).
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<{ synced: number }>}
 */
async function syncMissingTagEmbeddings(kbRootUri) {
	const key = kbKey(kbRootUri);
	if (!key) return { synced: 0 };
	const existing = syncInFlight.get(key);
	if (existing) {
		await existing;
		return { synced: 0 };
	}

	const run = (async () => {
		let missing = [];
		let modelId = '';
		{
			const handle = await openDripIndexDb(kbRootUri);
			try {
				ensureTagEmbeddingStorage(handle.db);
				missing = listTagsMissingEmbeddings(handle.db);
				modelId = getEmbeddingMeta(handle.db).model;
			} finally {
				handle.close();
			}
		}
		if (!missing.length) return;

		for (const row of missing) {
			const name = String(row.tag_name || '').trim();
			if (!name) continue;
			const vector = await encodeHeadingEmbeddingText(name, { modelId });
			const handle = await openDripIndexDb(kbRootUri);
			try {
				upsertTagEmbedding(handle.db, row.tag_id, vector);
			} finally {
				handle.close();
			}
		}
	})();

	syncInFlight.set(key, run);
	try {
		await run;
		return { synced: 1 };
	} finally {
		syncInFlight.delete(key);
	}
}

module.exports = {
	syncMissingTagEmbeddings
};
