'use strict';

/**
 * File embedding storage in `index.drip` (one vector per note file).
 *
 * Embedded text is the file's KB path + file name only (see `buildFileEmbeddingText`),
 * so a vector only goes stale on rename / move / delete — keyed by `file_path`.
 *
 * Tables (created lazily; dims follow the global embedding model):
 * - `file_embedding_records` — embedding_id ↔ file_path
 * - `file_embedding_vectors` — ordinary table; `embedding` BLOB (Float32)
 * Scoring is a plain-JS L2 scan (no sqlite-vec / FAISS).
 */

const { getEmbeddingMeta } = require('./headingEmbeddingStore');
const { l2Squared, coerceVector, toBlob } = require('./vectorMath');

const RECORDS_TABLE = 'file_embedding_records';
const VECTORS_TABLE = 'file_embedding_vectors';

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {string} name
 */
function tableExists(db, name) {
	const info = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`);
	return info.length > 0 && info[0].values.length > 0;
}

/**
 * `Career/Resume.d.txt` → `Resume\nCareer/Resume` (file name first so it carries the most weight).
 * @param {string} relPath
 * @returns {string}
 */
function buildFileEmbeddingText(relPath) {
	const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
	const { noteFileStem } = require('./folderEmbeddingText');
	const slash = rel.lastIndexOf('/');
	const folder = slash >= 0 ? rel.slice(0, slash) : '';
	const stem = noteFileStem(slash >= 0 ? rel.slice(slash + 1) : rel);
	return folder ? `${stem}\n${folder}/${stem}` : stem;
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function ensureFileEmbeddingStorage(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${RECORDS_TABLE} (
			embedding_id INTEGER PRIMARY KEY AUTOINCREMENT,
			file_path TEXT NOT NULL UNIQUE
		);
		CREATE TABLE IF NOT EXISTS ${VECTORS_TABLE} (
			embedding_id INTEGER PRIMARY KEY,
			embedding BLOB NOT NULL
		);
	`);
}

/**
 * Drop both tables (model change / full rebuild); recreated lazily with the new dims.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function clearAllFileEmbeddings(db) {
	db.exec(`DROP TABLE IF EXISTS ${VECTORS_TABLE}`);
	db.exec(`DROP TABLE IF EXISTS ${RECORDS_TABLE}`);
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @returns {{ embedding_id: number, file_path: string }[]}
 */
function listFileEmbeddingRecords(db) {
	if (!tableExists(db, RECORDS_TABLE)) return [];
	return db.native
		.prepare(`SELECT embedding_id, file_path FROM ${RECORDS_TABLE}`)
		.all()
		.map(r => ({ embedding_id: Number(r.embedding_id), file_path: String(r.file_path || '') }));
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {string} filePath
 */
function deleteFileEmbedding(db, filePath) {
	const row = db.native.prepare(`SELECT embedding_id FROM ${RECORDS_TABLE} WHERE file_path = ?`).get(filePath);
	if (!row) return;
	db.native.prepare(`DELETE FROM ${VECTORS_TABLE} WHERE embedding_id = ?`).run(row.embedding_id);
	db.native.prepare(`DELETE FROM ${RECORDS_TABLE} WHERE embedding_id = ?`).run(row.embedding_id);
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {string} filePath
 * @param {number[] | Float32Array} embedding
 */
function upsertFileEmbedding(db, filePath, embedding) {
	const { dimensions } = getEmbeddingMeta(db);
	const values = Array.from(embedding);
	if (values.length !== dimensions) {
		throw new Error(`upsertFileEmbedding: expected ${dimensions} dims, got ${values.length}`);
	}
	deleteFileEmbedding(db, filePath);
	const info = db.native.prepare(`INSERT INTO ${RECORDS_TABLE} (file_path) VALUES (?)`).run(filePath);
	db.native
		.prepare(`INSERT INTO ${VECTORS_TABLE} (embedding_id, embedding) VALUES (?, ?)`)
		.run(info.lastInsertRowid, toBlob(values));
}

/**
 * L2 distance from `query` to every file vector (plain-JS scan — file counts stay small).
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number[] | Float32Array} query
 * @returns {{ file_path: string, distance: number }[]} closest first
 */
function scoreAllFileEmbeddings(db, query) {
	if (!tableExists(db, VECTORS_TABLE) || !tableExists(db, RECORDS_TABLE)) return [];
	const { dimensions } = getEmbeddingMeta(db);
	const values = Array.from(query);

	/** @type {Map<number, string>} */
	const paths = new Map();
	for (const r of db.native.prepare(`SELECT embedding_id, file_path FROM ${RECORDS_TABLE}`).all()) {
		paths.set(Number(r.embedding_id), String(r.file_path || ''));
	}

	/** @type {{ file_path: string, distance: number }[]} */
	const out = [];
	for (const row of db.native.prepare(`SELECT embedding_id, embedding FROM ${VECTORS_TABLE}`).all()) {
		const path = paths.get(Number(row.embedding_id));
		if (path == null) continue;
		const vec = coerceVector(row.embedding, dimensions);
		if (!vec || vec.length !== dimensions) continue;
		out.push({ file_path: path, distance: l2Squared(values, vec) });
	}
	out.sort((a, b) => a.distance - b.distance);
	return out;
}

module.exports = {
	RECORDS_TABLE,
	VECTORS_TABLE,
	buildFileEmbeddingText,
	ensureFileEmbeddingStorage,
	clearAllFileEmbeddings,
	listFileEmbeddingRecords,
	deleteFileEmbedding,
	upsertFileEmbedding,
	scoreAllFileEmbeddings
};
