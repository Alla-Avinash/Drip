'use strict';

/**
 * Hybrid tag suggest for Retriever:
 * - up to 3 letter/prefix matches from `tags`
 * - up to 5 sqlite-vec nearest neighbors (no FAISS)
 */

const { openDripIndexDb } = require('../dripIndexDb');
const { getEmbeddingMeta } = require('./headingEmbeddingStore');
const { encodeHeadingEmbeddingText } = require('./headingEmbeddingEncode');
const { ensureTagEmbeddingStorage, searchTagEmbeddingsExact } = require('./tagEmbeddingStore');
const { syncMissingTagEmbeddings } = require('./tagEmbeddingSync');

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} queryText
 * @param {{ prefixLimit?: number, semanticLimit?: number, exclude?: string[] }} [opts]
 * @returns {Promise<{ prefix: string[], semantic: string[] }>}
 */
async function suggestTagsHybrid(kbRootUri, queryText, opts) {
	const q = String(queryText || '')
		.trim()
		.toLowerCase();
	const prefixLimit = Math.max(0, Math.min(Number(opts?.prefixLimit) || 3, 10));
	const semanticLimit = Math.max(0, Math.min(Number(opts?.semanticLimit) || 5, 20));
	const exclude = new Set(
		(Array.isArray(opts?.exclude) ? opts.exclude : []).map(t =>
			String(t || '')
				.trim()
				.toLowerCase()
		)
	);

	/** @type {string[]} */
	let prefix = [];
	{
		const handle = await openDripIndexDb(kbRootUri);
		try {
			if (handle.db.native) {
				const rows = handle.db.native
					.prepare(
						`
						SELECT t.tag_name AS tag_name
						FROM tags t
						ORDER BY
							CASE
								WHEN LOWER(t.tag_name) = ? THEN 0
								WHEN LOWER(t.tag_name) LIKE ? THEN 1
								ELSE 2
							END,
							LOWER(t.tag_name)
						LIMIT 80
						`
					)
					.all(q || '\0', q ? `${q}%` : '%');
				for (const r of rows) {
					const name = String(r.tag_name || '')
						.trim()
						.toLowerCase();
					if (!name || exclude.has(name)) continue;
					if (q && !name.includes(q) && !name.startsWith(q)) continue;
					if (!q || name.startsWith(q) || name.includes(q)) {
						prefix.push(name);
					}
					if (prefix.length >= prefixLimit) break;
				}
				// Prefer startsWith when query present.
				if (q) {
					const starts = prefix.filter(t => t.startsWith(q));
					const rest = prefix.filter(t => !t.startsWith(q));
					prefix = [...starts, ...rest].slice(0, prefixLimit);
				}
			}
		} finally {
			handle.close();
		}
	}

	/** @type {string[]} */
	let semantic = [];
	if (q.length >= 1 && semanticLimit > 0) {
		try {
			await syncMissingTagEmbeddings(kbRootUri);
			let modelId = '';
			{
				const handle = await openDripIndexDb(kbRootUri);
				try {
					ensureTagEmbeddingStorage(handle.db);
					modelId = getEmbeddingMeta(handle.db).model;
				} finally {
					handle.close();
				}
			}
			const vector = await encodeHeadingEmbeddingText(q, { modelId });
			const handle = await openDripIndexDb(kbRootUri);
			try {
				const hits = searchTagEmbeddingsExact(handle.db, vector, semanticLimit + prefix.length + 5);
				const taken = new Set(prefix);
				for (const h of hits) {
					const name = String(h.tag_name || '')
						.trim()
						.toLowerCase();
					if (!name || exclude.has(name) || taken.has(name)) continue;
					semantic.push(name);
					taken.add(name);
					if (semantic.length >= semanticLimit) break;
				}
			} finally {
				handle.close();
			}
		} catch (err) {
			console.warn('[DRIP] tag semantic suggest failed', err && err.message);
			semantic = [];
		}
	}

	return { prefix, semantic };
}

module.exports = {
	suggestTagsHybrid
};
