'use strict';

/**
 * Tag embedding storage in `index.drip` (plain-JS L2 scan — no sqlite-vec / FAISS).
 *
 * Tables:
 * - `tag_embedding_records` — embedding_id ↔ tag_id
 * - `tag_embedding_vectors` — ordinary table; `embedding` BLOB (Float32)
 *
 * Shares global embedding_* index_meta with heading/folder vectors.
 * Allocator: `next_tag_embedding_id`.
 */

const { getEmbeddingMeta } = require('./headingEmbeddingStore');
const { l2Squared, coerceVector, toBlob } = require('./vectorMath');

const RECORDS_TABLE = 'tag_embedding_records';
const VECTORS_TABLE = 'tag_embedding_vectors';
const NEXT_ID_META_KEY = 'next_tag_embedding_id';

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
function tagVectorsTableExists(db) {
	const info = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${VECTORS_TABLE}'`);
	return info.length > 0 && info[0].values.length > 0;
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function ensureTagEmbeddingStorage(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${RECORDS_TABLE} (
			embedding_id INTEGER PRIMARY KEY,
			tag_id INTEGER NOT NULL UNIQUE,
			FOREIGN KEY (tag_id) REFERENCES tags(tag_id) ON DELETE CASCADE
		);
		CREATE INDEX IF NOT EXISTS idx_tag_embedding_tag
			ON ${RECORDS_TABLE}(tag_id);
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
function allocateTagEmbeddingId(db) {
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
 * @param {number} tagId
 * @returns {number | undefined}
 */
function getTagEmbeddingId(db, tagId) {
	const stmt = db.prepare(`SELECT embedding_id FROM ${RECORDS_TABLE} WHERE tag_id = ?`);
	stmt.bind([tagId]);
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
 * @param {number} tagId
 * @param {number[] | Float32Array} embedding
 * @returns {number}
 */
function upsertTagEmbedding(db, tagId, embedding) {
	ensureTagEmbeddingStorage(db);
	const { dimensions } = getEmbeddingMeta(db);
	const values = Array.from(embedding);
	if (values.length !== dimensions) {
		throw new Error(`upsertTagEmbedding: expected ${dimensions} dims, got ${values.length}`);
	}

	let embeddingId = getTagEmbeddingId(db, tagId);
	if (embeddingId == null) {
		embeddingId = allocateTagEmbeddingId(db);
		db.run(`INSERT INTO ${RECORDS_TABLE} (embedding_id, tag_id) VALUES (?, ?)`, [embeddingId, tagId]);
	}

	db.run(`INSERT OR REPLACE INTO ${VECTORS_TABLE} (embedding_id, embedding) VALUES (?, ?)`, [
		embeddingId,
		toBlob(values)
	]);

	return embeddingId;
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number} tagId
 */
function deleteTagEmbedding(db, tagId) {
	const embeddingId = getTagEmbeddingId(db, tagId);
	if (embeddingId == null) return;
	db.run(`DELETE FROM ${VECTORS_TABLE} WHERE embedding_id = ?`, [embeddingId]);
	db.run(`DELETE FROM ${RECORDS_TABLE} WHERE tag_id = ?`, [tagId]);
}

/**
 * KNN by L2 distance for tags (plain-JS scan).
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number[] | Float32Array} query
 * @param {number} k
 * @returns {{ embedding_id: number, distance: number, tag_id: number, tag_name: string }[]}
 */
function searchTagEmbeddingsExact(db, query, k) {
	ensureTagEmbeddingStorage(db);
	const { dimensions } = getEmbeddingMeta(db);
	const values = Array.from(query);
	if (values.length !== dimensions) {
		throw new Error(`searchTagEmbeddingsExact: expected ${dimensions} dims, got ${values.length}`);
	}
	if (!db.native || !tagVectorsTableExists(db)) {
		return [];
	}
	const limit = Math.max(1, Number(k) || 1);

	/** @type {Map<number, number>} */
	const tagByEmbedding = new Map();
	for (const r of db.native.prepare(`SELECT embedding_id, tag_id FROM ${RECORDS_TABLE}`).all()) {
		tagByEmbedding.set(Number(r.embedding_id), Number(r.tag_id));
	}
	/** @type {Map<number, string>} */
	const nameByTag = new Map();
	for (const r of db.native.prepare(`SELECT tag_id, tag_name FROM tags`).all()) {
		nameByTag.set(Number(r.tag_id), String(r.tag_name || '').trim().toLowerCase());
	}

	/** @type {{ embedding_id: number, distance: number, tag_id: number, tag_name: string }[]} */
	const scored = [];
	for (const row of db.native.prepare(`SELECT embedding_id, embedding FROM ${VECTORS_TABLE}`).all()) {
		const embeddingId = Number(row.embedding_id);
		const tagId = tagByEmbedding.get(embeddingId);
		if (tagId == null) continue;
		const vec = coerceVector(row.embedding, dimensions);
		if (!vec || vec.length !== dimensions) continue;
		scored.push({
			embedding_id: embeddingId,
			distance: l2Squared(values, vec),
			tag_id: tagId,
			tag_name: nameByTag.get(tagId) || ''
		});
	}

	scored.sort((a, b) => a.distance - b.distance);
	return scored.slice(0, limit);
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @returns {{ tag_id: number, tag_name: string }[]}
 */
function listTagsMissingEmbeddings(db) {
	ensureTagEmbeddingStorage(db);
	if (!db.native) return [];
	const rows = db.native
		.prepare(
			`
			SELECT t.tag_id AS tag_id, t.tag_name AS tag_name
			FROM tags t
			LEFT JOIN ${RECORDS_TABLE} r ON r.tag_id = t.tag_id
			WHERE r.tag_id IS NULL
			ORDER BY LOWER(t.tag_name)
			`
		)
		.all();
	return rows.map(r => ({
		tag_id: Number(r.tag_id),
		tag_name: String(r.tag_name || '').trim().toLowerCase()
	}));
}

module.exports = {
	RECORDS_TABLE,
	VECTORS_TABLE,
	ensureTagEmbeddingStorage,
	upsertTagEmbedding,
	deleteTagEmbedding,
	searchTagEmbeddingsExact,
	listTagsMissingEmbeddings,
	getTagEmbeddingId
};
