'use strict';

/**
 * Tag embedding storage in `index.drip` (sqlite-vec exact only — no FAISS).
 *
 * Tables:
 * - `tag_embedding_records` — embedding_id ↔ tag_id
 * - `tag_embedding_vectors` — sqlite-vec `vec0` float vectors
 *
 * Shares global embedding_* index_meta with heading/folder vectors.
 * Allocator: `next_tag_embedding_id`.
 */

const { getEmbeddingMeta } = require('./headingEmbeddingStore');

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
	const info = db.exec(
		`SELECT name FROM sqlite_master WHERE type='table' AND name='${VECTORS_TABLE}'`
	);
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
	`);
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES (?, ?)`, [NEXT_ID_META_KEY, '1']);

	const { dimensions } = getEmbeddingMeta(db);
	if (!tagVectorsTableExists(db)) {
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
 * @param {number} embeddingId
 */
function deleteTagVectorRow(db, embeddingId) {
	if (!db.native || !tagVectorsTableExists(db)) {
		return;
	}
	try {
		db.native.prepare(`DELETE FROM ${VECTORS_TABLE} WHERE embedding_id = ?`).run(BigInt(embeddingId));
	} catch {
		try {
			db.native.prepare(`DELETE FROM ${VECTORS_TABLE} WHERE embedding_id = ?`).run(Number(embeddingId));
		} catch {
			// ignore
		}
	}
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
	if (!db.native) {
		throw new Error('upsertTagEmbedding: native DB handle missing');
	}

	let embeddingId = getTagEmbeddingId(db, tagId);
	if (embeddingId == null) {
		embeddingId = allocateTagEmbeddingId(db);
		db.run(`INSERT INTO ${RECORDS_TABLE} (embedding_id, tag_id) VALUES (?, ?)`, [
			embeddingId,
			tagId
		]);
	} else {
		deleteTagVectorRow(db, embeddingId);
	}

	db.native
		.prepare(`INSERT INTO ${VECTORS_TABLE} (embedding_id, embedding) VALUES (?, ?)`)
		.run(BigInt(embeddingId), JSON.stringify(values));

	return embeddingId;
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number} tagId
 */
function deleteTagEmbedding(db, tagId) {
	const embeddingId = getTagEmbeddingId(db, tagId);
	if (embeddingId == null) return;
	deleteTagVectorRow(db, embeddingId);
	db.run(`DELETE FROM ${RECORDS_TABLE} WHERE tag_id = ?`, [tagId]);
}

/**
 * Exact KNN for tags via sqlite-vec.
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
		throw new Error(
			`searchTagEmbeddingsExact: expected ${dimensions} dims, got ${values.length}`
		);
	}
	if (!db.native || !tagVectorsTableExists(db)) {
		return [];
	}
	const limit = Math.max(1, Number(k) || 1);
	const rows = db.native
		.prepare(
			`
			SELECT
				v.embedding_id AS embedding_id,
				v.distance AS distance,
				r.tag_id AS tag_id,
				t.tag_name AS tag_name
			FROM ${VECTORS_TABLE} v
			JOIN ${RECORDS_TABLE} r ON r.embedding_id = v.embedding_id
			JOIN tags t ON t.tag_id = r.tag_id
			WHERE v.embedding MATCH ?
			  AND k = ?
			ORDER BY v.distance
			`
		)
		.all(JSON.stringify(values), limit);

	return rows.map(r => ({
		embedding_id: Number(r.embedding_id),
		distance: Number(r.distance),
		tag_id: Number(r.tag_id),
		tag_name: String(r.tag_name || '')
			.trim()
			.toLowerCase()
	}));
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
		tag_name: String(r.tag_name || '')
			.trim()
			.toLowerCase()
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
