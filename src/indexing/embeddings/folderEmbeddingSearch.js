'use strict';

/**
 * Folder semantic search over `index.drip` (exact sqlite-vec only — no FAISS).
 */

const vscode = require('vscode');
const { openDripIndexDb } = require('../dripIndexDb');
const { encodeHeadingEmbeddingText } = require('./headingEmbeddingEncode');
const { getEmbeddingMeta } = require('./headingEmbeddingStore');
const { searchFolderEmbeddingsExact } = require('./folderEmbeddingStore');
const {
	normalizeFolderPath,
	folderBasename,
	getFolderH0TitleFromDb
} = require('./folderEmbeddingText');

/**
 * @param {number} distance
 */
function distanceToScore(distance) {
	const d = Number(distance);
	if (!Number.isFinite(d) || d < 0) {
		return 0;
	}
	return 1 / (1 + d);
}

/**
 * @typedef {{
 *   embedding_id: number,
 *   distance: number,
 *   score: number,
 *   folderPath: string,
 *   folderName: string,
 *   h0Title: string,
 *   uri: string,
 *   id: string
 * }} FolderEmbeddingSearchHit
 */

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} queryText
 * @param {{ limit?: number, modelId?: string }} [opts]
 * @returns {Promise<FolderEmbeddingSearchHit[]>}
 */
async function searchFoldersExact(kbRootUri, queryText, opts) {
	const limit = Math.max(1, Math.min(Number(opts?.limit) || 20, 200));
	const q = String(queryText || '').trim();
	if (!q) {
		return [];
	}

	let modelId = opts?.modelId;
	{
		const handle = await openDripIndexDb(kbRootUri);
		try {
			if (!modelId) {
				modelId = getEmbeddingMeta(handle.db).model;
			}
		} finally {
			handle.close();
		}
	}

	const vector = await encodeHeadingEmbeddingText(q, { modelId });

	const handle = await openDripIndexDb(kbRootUri);
	try {
		const knn = searchFolderEmbeddingsExact(handle.db, vector, limit);
		/** @type {FolderEmbeddingSearchHit[]} */
		const hits = [];
		for (const row of knn) {
			const folderPath = normalizeFolderPath(row.folder_path);
			const folderName = folderBasename(folderPath);
			const h0Title = getFolderH0TitleFromDb(handle.db, folderPath);
			const folderUri =
				folderPath === '.'
					? kbRootUri
					: vscode.Uri.joinPath(kbRootUri, ...folderPath.split('/').filter(Boolean));
			hits.push({
				embedding_id: Number(row.embedding_id),
				distance: Number(row.distance),
				score: distanceToScore(row.distance),
				folderPath,
				folderName,
				h0Title,
				uri: folderUri.toString(),
				id: `folder:${folderPath}`
			});
		}
		return hits;
	} finally {
		handle.close();
	}
}

module.exports = {
	searchFoldersExact
};
