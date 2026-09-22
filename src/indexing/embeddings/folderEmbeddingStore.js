'use strict';

/**
 * Folder embedding storage in `index.drip`.
 *
 * Tables:
 * - `folder_embedding_records` — embedding_id ↔ folder_path
 * - `folder_embedding_vectors` — sqlite-vec `vec0` float vectors
 *
 * Uses the same global embedding_* index_meta as heading vectors (one model).
 * Separate id allocator: `next_folder_embedding_id`.
 * Exact search only (no FAISS) — folder counts stay small.
 */

const {
	getEmbeddingMeta,
	DEFAULT_EMBEDDING_DIMENSIONS,
	coerceEmbeddingValues
} = require('./headingEmbeddingStore');

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
	const info = db.exec(
		`SELECT name FROM sqlite_master WHERE type='table' AND name='${VECTORS_TABLE}'`
	);
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
	`);
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES (?, ?)`, [NEXT_ID_META_KEY, '1']);

	const { dimensions } = getEmbeddingMeta(db);
	if (!folderVectorsTableExists(db)) {
		db.exec(`
			CREATE VIRTUAL TABLE ${VECTORS_TABLE} USING vec0(
				embedding_id INTEGER PRIMARY KEY,
				embedding float[${dimensions}]
			);
		`);
	}
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
 * @returns {number}
 */
function countFolderEmbeddings(db) {
	if (!folderVectorsTableExists(db)) {
		return 0;
	}
	const stmt = db.prepare(`SELECT COUNT(*) FROM ${VECTORS_TABLE}`);
	stmt.bind([]);
	if (!stmt.step()) {
		stmt.free();
		return 0;
	}
	const n = Number(stmt.get()[0]) || 0;
	stmt.free();
	return n;
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
 * @param {number} embeddingId
 */
function deleteFolderVectorRow(db, embeddingId) {
	if (!db.native || !folderVectorsTableExists(db)) {
		return;
	}
	db.native
		.prepare(`DELETE FROM ${VECTORS_TABLE} WHERE embedding_id = ?`)
		.run(BigInt(embeddingId));
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
	deleteFolderVectorRow(db, embeddingId);
	db.run(`DELETE FROM ${RECORDS_TABLE} WHERE embedding_id = ?`, [embeddingId]);
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function clearAllFolderEmbeddings(db) {
	if (folderVectorsTableExists(db)) {
		db.exec(`DROP TABLE IF EXISTS ${VECTORS_TABLE}`);
	}
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
		throw new Error(
			`upsertFolderEmbedding: expected ${dimensions} dims, got ${values.length}`
		);
	}
	if (!db.native) {
		throw new Error('upsertFolderEmbedding: native DB handle missing');
	}

	let embeddingId = getFolderEmbeddingId(db, folder);
	if (embeddingId == null) {
		embeddingId = allocateFolderEmbeddingId(db);
		db.run(`INSERT INTO ${RECORDS_TABLE} (embedding_id, folder_path) VALUES (?, ?)`, [
			embeddingId,
			folder
		]);
	} else {
		deleteFolderVectorRow(db, embeddingId);
	}

	db.native
		.prepare(`INSERT INTO ${VECTORS_TABLE} (embedding_id, embedding) VALUES (?, ?)`)
		.run(BigInt(embeddingId), JSON.stringify(values));

	return embeddingId;
}

/**
 * Exact KNN for folders.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number[] | Float32Array} query
 * @param {number} k
 * @returns {{ embedding_id: number, distance: number, folder_path: string }[]}
 */
function searchFolderEmbeddingsExact(db, query, k) {
	const { dimensions } = getEmbeddingMeta(db);
	const values = Array.from(query);
	if (values.length !== dimensions) {
		throw new Error(
			`searchFolderEmbeddingsExact: expected ${dimensions} dims, got ${values.length}`
		);
	}
	if (!db.native || !folderVectorsTableExists(db)) {
		return [];
	}
	const limit = Math.max(1, Number(k) || 1);
	const rows = db.native
		.prepare(
			`
			SELECT
				v.embedding_id AS embedding_id,
				v.distance AS distance,
				r.folder_path AS folder_path
			FROM ${VECTORS_TABLE} v
			JOIN ${RECORDS_TABLE} r ON r.embedding_id = v.embedding_id
			WHERE v.embedding MATCH ?
			  AND k = ?
			ORDER BY v.distance
			`
		)
		.all(JSON.stringify(values), limit);

	return rows.map(r => ({
		embedding_id: Number(r.embedding_id),
		distance: Number(r.distance),
		folder_path: String(r.folder_path || '.')
	}));
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
		out.push({
			embedding_id: Number(row[0]),
			folder_path: String(row[1] || '.')
		});
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
	countFolderEmbeddings,
	getFolderEmbeddingId,
	allocateFolderEmbeddingId,
	deleteFolderEmbedding,
	clearAllFolderEmbeddings,
	upsertFolderEmbedding,
	searchFolderEmbeddingsExact,
	listFolderEmbeddingRecords,
	folderVectorsTableExists,
	coerceEmbeddingValues
};
