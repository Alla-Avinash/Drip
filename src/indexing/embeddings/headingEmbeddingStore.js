'use strict';

/**
 * Heading embedding storage in `index.drip`.
 *
 * Tables:
 * - `heading_embedding_records` — embedding_id ↔ (file_id, heading_id)
 * - `heading_embedding_vectors` — ordinary table; `embedding` BLOB (Float32)
 *
 * Search is a plain-JS L2 scan over all vectors (no sqlite-vec, no FAISS).
 * Global model/config lives in `index_meta` (not per row):
 *   embedding_model, embedding_dimensions, embedding_format_version, embedding_generation
 */

const { l2Squared, coerceVector, toBlob } = require('./vectorMath');

const DEFAULT_EMBEDDING_DIMENSIONS = 384;
const DEFAULT_EMBEDDING_FORMAT_VERSION = '1';
const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_EMBEDDING_GENERATION = '0';

const RECORDS_TABLE = 'heading_embedding_records';
const VECTORS_TABLE = 'heading_embedding_vectors';

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
 */
function seedEmbeddingIndexMeta(db) {
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES (?, ?)`, [
		'embedding_model',
		DEFAULT_EMBEDDING_MODEL
	]);
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES (?, ?)`, [
		'embedding_dimensions',
		String(DEFAULT_EMBEDDING_DIMENSIONS)
	]);
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES (?, ?)`, [
		'embedding_format_version',
		DEFAULT_EMBEDDING_FORMAT_VERSION
	]);
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES (?, ?)`, [
		'embedding_generation',
		DEFAULT_EMBEDDING_GENERATION
	]);
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES (?, ?)`, ['next_embedding_id', '1']);
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @returns {{ model: string, dimensions: number, formatVersion: string, generation: string }}
 */
function getEmbeddingMeta(db) {
	const dimensions = parseInt(getMeta(db, 'embedding_dimensions') || '', 10);
	return {
		model: getMeta(db, 'embedding_model') || DEFAULT_EMBEDDING_MODEL,
		dimensions:
			Number.isFinite(dimensions) && dimensions > 0 ? dimensions : DEFAULT_EMBEDDING_DIMENSIONS,
		formatVersion: getMeta(db, 'embedding_format_version') || DEFAULT_EMBEDDING_FORMAT_VERSION,
		generation: getMeta(db, 'embedding_generation') || DEFAULT_EMBEDDING_GENERATION
	};
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @returns {boolean}
 */
function vectorsTableExists(db) {
	const info = db.exec(
		`SELECT name FROM sqlite_master WHERE type='table' AND name='${VECTORS_TABLE}'`
	);
	return info.length > 0 && info[0].values.length > 0;
}

/**
 * Create mapping + vector tables and seed embedding meta. Idempotent.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function ensureHeadingEmbeddingStorage(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${RECORDS_TABLE} (
			embedding_id INTEGER PRIMARY KEY,
			file_id INTEGER NOT NULL,
			heading_id INTEGER NOT NULL,
			UNIQUE (file_id, heading_id),
			FOREIGN KEY (file_id, heading_id)
				REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
		);
		CREATE INDEX IF NOT EXISTS idx_heading_embedding_file
			ON ${RECORDS_TABLE}(file_id);
		CREATE TABLE IF NOT EXISTS ${VECTORS_TABLE} (
			embedding_id INTEGER PRIMARY KEY,
			embedding BLOB NOT NULL
		);
	`);

	seedEmbeddingIndexMeta(db);
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @returns {number}
 */
function allocateEmbeddingId(db) {
	const raw = getMeta(db, 'next_embedding_id');
	let next = parseInt(raw || '1', 10);
	if (!Number.isFinite(next) || next < 1) {
		next = 1;
	}
	setMeta(db, 'next_embedding_id', String(next + 1));
	return next;
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number} fileId
 * @param {number} headingId
 * @returns {number | undefined}
 */
function getEmbeddingId(db, fileId, headingId) {
	const stmt = db.prepare(`SELECT embedding_id FROM ${RECORDS_TABLE} WHERE file_id = ? AND heading_id = ?`);
	stmt.bind([fileId, headingId]);
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
function deleteVectorRow(db, embeddingId) {
	db.run(`DELETE FROM ${VECTORS_TABLE} WHERE embedding_id = ?`, [embeddingId]);
}

/**
 * Remove embedding for one heading (vector + record).
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number} fileId
 * @param {number} headingId
 */
function deleteHeadingEmbedding(db, fileId, headingId) {
	const embeddingId = getEmbeddingId(db, fileId, headingId);
	if (embeddingId == null) {
		return;
	}
	deleteVectorRow(db, embeddingId);
	db.run(`DELETE FROM ${RECORDS_TABLE} WHERE embedding_id = ?`, [embeddingId]);
}

/**
 * Remove all embeddings for a file.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number} fileId
 */
function deleteFileEmbeddings(db, fileId) {
	const stmt = db.prepare(`SELECT embedding_id FROM ${RECORDS_TABLE} WHERE file_id = ?`);
	stmt.bind([fileId]);
	/** @type {number[]} */
	const ids = [];
	while (stmt.step()) {
		ids.push(Number(stmt.get()[0]));
	}
	stmt.free();
	for (const embeddingId of ids) {
		deleteVectorRow(db, embeddingId);
	}
	db.run(`DELETE FROM ${RECORDS_TABLE} WHERE file_id = ?`, [fileId]);
}

/**
 * Wipe all heading embeddings (records + vectors). Used on full reindex / model rebuild.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function clearAllHeadingEmbeddings(db) {
	db.run(`DELETE FROM ${VECTORS_TABLE}`);
	db.run(`DELETE FROM ${RECORDS_TABLE}`);
	setMeta(db, 'next_embedding_id', '1');
	ensureHeadingEmbeddingStorage(db);
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @returns {number} total stored heading embeddings
 */
function countHeadingEmbeddings(db) {
	if (!db.native) return 0;
	const row = db.native.prepare(`SELECT COUNT(*) AS n FROM ${RECORDS_TABLE}`).get();
	return Number(row && row.n) || 0;
}

/**
 * Insert or replace the vector for (file_id, heading_id).
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number} fileId
 * @param {number} headingId
 * @param {number[] | Float32Array} embedding
 * @returns {number} embedding_id
 */
function upsertHeadingEmbedding(db, fileId, headingId, embedding) {
	const { dimensions } = getEmbeddingMeta(db);
	const values = Array.from(embedding);
	if (values.length !== dimensions) {
		throw new Error(`upsertHeadingEmbedding: expected ${dimensions} dims, got ${values.length}`);
	}

	let embeddingId = getEmbeddingId(db, fileId, headingId);
	if (embeddingId == null) {
		embeddingId = allocateEmbeddingId(db);
		db.run(`INSERT INTO ${RECORDS_TABLE} (embedding_id, file_id, heading_id) VALUES (?, ?, ?)`, [
			embeddingId,
			fileId,
			headingId
		]);
	}

	db.run(`INSERT OR REPLACE INTO ${VECTORS_TABLE} (embedding_id, embedding) VALUES (?, ?)`, [
		embeddingId,
		toBlob(values)
	]);

	return embeddingId;
}

/**
 * KNN by L2 distance over all heading vectors (plain-JS scan).
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number[] | Float32Array} query
 * @param {number} k
 * @returns {{ embedding_id: number, distance: number, file_id: number, heading_id: number }[]}
 */
function searchHeadingEmbeddingsExact(db, query, k) {
	const { dimensions } = getEmbeddingMeta(db);
	const values = Array.from(query);
	if (values.length !== dimensions) {
		throw new Error(`searchHeadingEmbeddingsExact: expected ${dimensions} dims, got ${values.length}`);
	}
	if (!db.native || !vectorsTableExists(db)) {
		return [];
	}
	const limit = Math.max(1, Number(k) || 1);

	/** @type {Map<number, { file_id: number, heading_id: number }>} */
	const records = new Map();
	for (const r of db.native.prepare(`SELECT embedding_id, file_id, heading_id FROM ${RECORDS_TABLE}`).all()) {
		records.set(Number(r.embedding_id), { file_id: Number(r.file_id), heading_id: Number(r.heading_id) });
	}

	/** @type {{ embedding_id: number, distance: number, file_id: number, heading_id: number }[]} */
	const scored = [];
	for (const row of db.native.prepare(`SELECT embedding_id, embedding FROM ${VECTORS_TABLE}`).all()) {
		const embeddingId = Number(row.embedding_id);
		const rec = records.get(embeddingId);
		if (!rec) continue;
		const vec = coerceVector(row.embedding, dimensions);
		if (!vec || vec.length !== dimensions) continue;
		scored.push({
			embedding_id: embeddingId,
			distance: l2Squared(values, vec),
			file_id: rec.file_id,
			heading_id: rec.heading_id
		});
	}

	scored.sort((a, b) => a.distance - b.distance);
	return scored.slice(0, limit);
}

module.exports = {
	DEFAULT_EMBEDDING_DIMENSIONS,
	DEFAULT_EMBEDDING_FORMAT_VERSION,
	DEFAULT_EMBEDDING_MODEL,
	DEFAULT_EMBEDDING_GENERATION,
	RECORDS_TABLE,
	VECTORS_TABLE,
	ensureHeadingEmbeddingStorage,
	seedEmbeddingIndexMeta,
	getEmbeddingMeta,
	getEmbeddingId,
	allocateEmbeddingId,
	deleteHeadingEmbedding,
	deleteFileEmbeddings,
	clearAllHeadingEmbeddings,
	upsertHeadingEmbedding,
	searchHeadingEmbeddingsExact,
	countHeadingEmbeddings
};
