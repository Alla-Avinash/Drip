'use strict';

/**
 * Folder embedding storage in `index.drip`.
 *
 * Tables:
 * - `folder_embedding_records` — embedding_id ↔ folder_path
 * - `folder_embedding_vectors` — ordinary table; `embedding` BLOB (Float32)
 *
 * Shares the global embedding_* index_meta with heading vectors (one model).
 * Separate id allocator: `next_folder_embedding_id`.
 * Search is a plain-JS L2 scan (no sqlite-vec / FAISS) — folder counts stay small.
 */

const {
	getEmbeddingMeta,
	DEFAULT_EMBEDDING_DIMENSIONS
} = require('./headingEmbeddingStore');
const { l2Squared, coerceVector, toBlob } = require('./vectorMath');

const RECORDS_TABLE = 'folder_embedding_records';
const VECTORS_TABLE = 'folder_embedding_vectors';
const NEXT_ID_META_KEY = 'next_folder_embedding_id';

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {string} key
 * @returns {string | undefined}
 */
function getMeta(db, key) {
	const stmt = db.prepare(`SELECT value FROM index_meta WHERE key = ?`);
	stmt.bind([key]);
	if (!stmt.step()) {
		stmt.free();
		return undefined;
	}
	const row = stmt.get();
	stmt.free();
	return row && row[0] != null ? String(row[0]) : undefined;
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {string} key
 * @param {string} value
 */
function setMeta(db, key, value) {
	db.run(`INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)`, [key, String(value)]);
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @returns {boolean}
 */
function folderVectorsTableExists(db) {
	const info = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${VECTORS_TABLE}'`);
	return info.length > 0 && info[0].values.length > 0;
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function ensureFolderEmbeddingStorage(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${RECORDS_TABLE} (
			embedding_id INTEGER PRIMARY KEY,
			folder_path TEXT NOT NULL UNIQUE
		);
		CREATE INDEX IF NOT EXISTS idx_folder_embedding_path
			ON ${RECORDS_TABLE}(folder_path);
		CREATE TABLE IF NOT EXISTS ${VECTORS_TABLE} (
			embedding_id INTEGER PRIMARY KEY,
			embedding BLOB NOT NULL
		);
	`);
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES (?, ?)`, [NEXT_ID_META_KEY, '1']);
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @returns {number}
 */
function allocateFolderEmbeddingId(db) {
	const raw = getMeta(db, NEXT_ID_META_KEY);
	let next = parseInt(raw || '1', 10);
	if (!Number.isFinite(next) || next < 1) {
		next = 1;
	}
	setMeta(db, NEXT_ID_META_KEY, String(next + 1));
	return next;
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {string} folderPath
 * @returns {number | undefined}
 */
function getFolderEmbeddingId(db, folderPath) {
	const { normalizeFolderPath } = require('./folderEmbeddingText');
	const folder = normalizeFolderPath(folderPath);
	const stmt = db.prepare(`SELECT embedding_id FROM ${RECORDS_TABLE} WHERE folder_path = ?`);
	stmt.bind([folder]);
	if (!stmt.step()) {
		stmt.free();
		return undefined;
	}
	const id = Number(stmt.get()[0]);
	stmt.free();
	return Number.isFinite(id) ? id : undefined;
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {string} folderPath
 */
function deleteFolderEmbedding(db, folderPath) {
	const embeddingId = getFolderEmbeddingId(db, folderPath);
	if (embeddingId == null) {
		return;
	}
	db.run(`DELETE FROM ${VECTORS_TABLE} WHERE embedding_id = ?`, [embeddingId]);
	db.run(`DELETE FROM ${RECORDS_TABLE} WHERE embedding_id = ?`, [embeddingId]);
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function clearAllFolderEmbeddings(db) {
	db.run(`DELETE FROM ${VECTORS_TABLE}`);
	db.run(`DELETE FROM ${RECORDS_TABLE}`);
	setMeta(db, NEXT_ID_META_KEY, '1');
	ensureFolderEmbeddingStorage(db);
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {string} folderPath
 * @param {number[] | Float32Array} embedding
 * @returns {number} embedding_id
 */
function upsertFolderEmbedding(db, folderPath, embedding) {
	const { normalizeFolderPath } = require('./folderEmbeddingText');
	const folder = normalizeFolderPath(folderPath);
	const { dimensions } = getEmbeddingMeta(db);
	const values = Array.from(embedding);
	if (values.length !== dimensions) {
		throw new Error(`upsertFolderEmbedding: expected ${dimensions} dims, got ${values.length}`);
	}

	let embeddingId = getFolderEmbeddingId(db, folder);
	if (embeddingId == null) {
		embeddingId = allocateFolderEmbeddingId(db);
		db.run(`INSERT INTO ${RECORDS_TABLE} (embedding_id, folder_path) VALUES (?, ?)`, [
			embeddingId,
			folder
		]);
	}

	db.run(`INSERT OR REPLACE INTO ${VECTORS_TABLE} (embedding_id, embedding) VALUES (?, ?)`, [
		embeddingId,
		toBlob(values)
	]);

	return embeddingId;
}

/**
 * KNN by L2 distance for folders (plain-JS scan).
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number[] | Float32Array} query
 * @param {number} k
 * @returns {{ embedding_id: number, distance: number, folder_path: string }[]}
 */
function searchFolderEmbeddingsExact(db, query, k) {
	const { dimensions } = getEmbeddingMeta(db);
	const values = Array.from(query);
	if (values.length !== dimensions) {
		throw new Error(`searchFolderEmbeddingsExact: expected ${dimensions} dims, got ${values.length}`);
	}
	if (!db.native || !folderVectorsTableExists(db)) {
		return [];
	}
	const limit = Math.max(1, Number(k) || 1);

	/** @type {Map<number, string>} */
	const paths = new Map();
	for (const r of db.native.prepare(`SELECT embedding_id, folder_path FROM ${RECORDS_TABLE}`).all()) {
		paths.set(Number(r.embedding_id), String(r.folder_path || '.'));
	}

	/** @type {{ embedding_id: number, distance: number, folder_path: string }[]} */
	const scored = [];
	for (const row of db.native.prepare(`SELECT embedding_id, embedding FROM ${VECTORS_TABLE}`).all()) {
		const embeddingId = Number(row.embedding_id);
		const folderPath = paths.get(embeddingId);
		if (folderPath == null) continue;
		const vec = coerceVector(row.embedding, dimensions);
		if (!vec || vec.length !== dimensions) continue;
		scored.push({
			embedding_id: embeddingId,
			distance: l2Squared(values, vec),
			folder_path: folderPath
		});
	}

	scored.sort((a, b) => a.distance - b.distance);
	return scored.slice(0, limit);
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @returns {{ embedding_id: number, folder_path: string }[]}
 */
function listFolderEmbeddingRecords(db) {
	const stmt = db.prepare(`SELECT embedding_id, folder_path FROM ${RECORDS_TABLE} ORDER BY folder_path`);
	stmt.bind([]);
	/** @type {{ embedding_id: number, folder_path: string }[]} */
	const out = [];
	while (stmt.step()) {
		const row = stmt.get();
		out.push({ embedding_id: Number(row[0]), folder_path: String(row[1] || '.') });
	}
	stmt.free();
	return out;
}

module.exports = {
	RECORDS_TABLE,
	VECTORS_TABLE,
	NEXT_ID_META_KEY,
	DEFAULT_EMBEDDING_DIMENSIONS,
	ensureFolderEmbeddingStorage,
	getFolderEmbeddingId,
	allocateFolderEmbeddingId,
	deleteFolderEmbedding,
	clearAllFolderEmbeddings,
	upsertFolderEmbedding,
	searchFolderEmbeddingsExact,
	listFolderEmbeddingRecords,
	folderVectorsTableExists
};
