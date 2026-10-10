'use strict';

/**
 * Keep file vectors in step with `files` rows by set difference:
 * encode paths that have no vector, delete vectors whose path is gone.
 * Project-zone notes (under a `.p`/`.f` folder) are skipped entirely — their vectors are
 * never stored here. Text depends on the path only, so no per-edit hooks are needed —
 * renames show up as one new path + one orphan.
 */

const { encodeHeadingEmbeddingText } = require('./headingEmbeddingEncode');
const { getEmbeddingMeta } = require('./headingEmbeddingStore');
const { isProjectNotePath } = require('../projectIndex');
const {
	buildFileEmbeddingText,
	ensureFileEmbeddingStorage,
	listFileEmbeddingRecords,
	deleteFileEmbedding,
	upsertFileEmbedding
} = require('./fileEmbeddingStore');

/** @type {Map<string, Promise<{ added: number, removed: number }>>} */
const inFlight = new Map();

function openDripIndexDb(...args) {
	return require('../dripIndexDb').openDripIndexDb(...args);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<{ added: number, removed: number }>}
 */
async function runSync(kbRootUri) {
	/** @type {string[]} */
	let missing = [];
	let modelId = '';
	let removed = 0;
	{
		const handle = await openDripIndexDb(kbRootUri);
		try {
			ensureFileEmbeddingStorage(handle.db);
			modelId = getEmbeddingMeta(handle.db).model;
			const live = new Set(
				handle.db.native
					.prepare(`SELECT path FROM files`)
					.all()
					.map(r => String(r.path || '').replace(/\\/g, '/'))
					// Project-zone notes (under a `.p`/`.f` folder) are excluded — they belong
					// to `projects.drip`, not the document search this vector feed powers.
					.filter(p => Boolean(p) && !isProjectNotePath(p))
			);
			const have = new Set();
			for (const rec of listFileEmbeddingRecords(handle.db)) {
				if (live.has(rec.file_path)) {
					have.add(rec.file_path);
				} else {
					deleteFileEmbedding(handle.db, rec.file_path);
					removed += 1;
				}
			}
			missing = [...live].filter(p => !have.has(p));
		} finally {
			handle.close();
		}
	}
	if (!missing.length) return { added: 0, removed };

	/** @type {{ path: string, vector: number[] }[]} */
	const encoded = [];
	for (const p of missing) {
		encoded.push({ path: p, vector: Array.from(await encodeHeadingEmbeddingText(buildFileEmbeddingText(p), { modelId })) });
	}

	const handle = await openDripIndexDb(kbRootUri);
	try {
		ensureFileEmbeddingStorage(handle.db);
		for (const e of encoded) upsertFileEmbedding(handle.db, e.path, e.vector);
	} finally {
		handle.close();
	}
	return { added: encoded.length, removed };
}

/**
 * Bring file vectors up to date (one run per KB at a time; callers share it).
 * @param {import('vscode').Uri} kbRootUri
 */
function syncFileEmbeddings(kbRootUri) {
	const key = String(kbRootUri && kbRootUri.fsPath || '');
	const running = inFlight.get(key);
	if (running) return running;
	const p = runSync(kbRootUri).finally(() => inFlight.delete(key));
	inFlight.set(key, p);
	return p;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 */
async function repairFileEmbeddingsInBackground(kbRootUri) {
	const { added, removed } = await syncFileEmbeddings(kbRootUri);
	if (added || removed) {
		console.log(`[DRIP] file embeddings: +${added} / -${removed}`);
	}
}

module.exports = { syncFileEmbeddings, repairFileEmbeddingsInBackground };
