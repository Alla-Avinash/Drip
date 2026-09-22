'use strict';

/**
 * Heading embedding storage in `index.drip` (schema v11+).
 *
 * Tables:
 * - `heading_embedding_records` — embedding_id ↔ (file_id, heading_id)
 * - `heading_embedding_vectors` — sqlite-vec `vec0` float vectors
 *
 * Global model/config lives in `index_meta` (not per row):
 *   embedding_model, embedding_dimensions, embedding_format_version, embedding_generation
 *
 * No content_hash / updated_at / model_id on rows (by design).
 * Inference / search wiring is later steps — this module is storage only.
 */

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
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES (?, ?)`, [
		'next_embedding_id',
		'1'
	]);
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
			Number.isFinite(dimensions) && dimensions > 0
				? dimensions
				: DEFAULT_EMBEDDING_DIMENSIONS,
		formatVersion: getMeta(db, 'embedding_format_version') || DEFAULT_EMBEDDING_FORMAT_VERSION,
		generation: getMeta(db, 'embedding_generation') || DEFAULT_EMBEDDING_GENERATION
	};
}

/**
 * Point index_meta at a new embedding model and bump generation (invalidates FAISS manifest sync).
 * Does not clear vectors — caller must clear heading/folder tables.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {string} modelId
 * @param {{ dimensions?: number }} [opts]
 * @returns {{ model: string, dimensions: number, formatVersion: string, generation: string }}
 */
function setEmbeddingModelMeta(db, modelId, opts) {
	const nextModel = String(modelId || '').trim() || DEFAULT_EMBEDDING_MODEL;
	setMeta(db, 'embedding_model', nextModel);
	const prevGen = parseInt(getMeta(db, 'embedding_generation') || '0', 10);
	const nextGen = Number.isFinite(prevGen) ? prevGen + 1 : 1;
	setMeta(db, 'embedding_generation', String(nextGen));
	if (opts && opts.dimensions != null) {
		const d = Number(opts.dimensions);
		if (Number.isFinite(d) && d > 0) {
			setMeta(db, 'embedding_dimensions', String(d));
		}
	}
	return getEmbeddingMeta(db);
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
 * Create mapping + vec0 tables and seed embedding meta. Idempotent.
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
	`);

	seedEmbeddingIndexMeta(db);
	const { dimensions } = getEmbeddingMeta(db);

	if (!vectorsTableExists(db)) {
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
 * @returns {number}
 */
function countHeadingEmbeddings(db) {
	if (!vectorsTableExists(db)) {
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
 * @param {number} fileId
 * @param {number} headingId
 * @returns {number | undefined}
 */
function getEmbeddingId(db, fileId, headingId) {
	const stmt = db.prepare(
		`SELECT embedding_id FROM ${RECORDS_TABLE} WHERE file_id = ? AND heading_id = ?`
	);
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
 * Delete vec0 row via native binding (PK must be BigInt for sqlite-vec).
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number} embeddingId
 */
function deleteVectorRow(db, embeddingId) {
	if (!db.native || !vectorsTableExists(db)) {
		return;
	}
	db.native
		.prepare(`DELETE FROM ${VECTORS_TABLE} WHERE embedding_id = ?`)
		.run(BigInt(embeddingId));
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
	if (vectorsTableExists(db)) {
		// vec0 has no reliable DELETE FROM without WHERE in some builds — drop & recreate.
		db.exec(`DROP TABLE IF EXISTS ${VECTORS_TABLE}`);
	}
	db.run(`DELETE FROM ${RECORDS_TABLE}`);
	setMeta(db, 'next_embedding_id', '1');
	ensureHeadingEmbeddingStorage(db);
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
		throw new Error(
			`upsertHeadingEmbedding: expected ${dimensions} dims, got ${values.length}`
		);
	}
	if (!db.native) {
		throw new Error('upsertHeadingEmbedding: native DB handle missing');
	}

	let embeddingId = getEmbeddingId(db, fileId, headingId);
	if (embeddingId == null) {
		embeddingId = allocateEmbeddingId(db);
		db.run(
			`INSERT INTO ${RECORDS_TABLE} (embedding_id, file_id, heading_id) VALUES (?, ?, ?)`,
			[embeddingId, fileId, headingId]
		);
	} else {
		deleteVectorRow(db, embeddingId);
	}

	db.native
		.prepare(
			`INSERT INTO ${VECTORS_TABLE} (embedding_id, embedding) VALUES (?, ?)`
		)
		.run(BigInt(embeddingId), JSON.stringify(values));

	return embeddingId;
}

/**
 * Exact KNN via sqlite-vec. Returns embedding_id + distance + file/heading ids.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number[] | Float32Array} query
 * @param {number} k
 * @returns {{ embedding_id: number, distance: number, file_id: number, heading_id: number }[]}
 */
function searchHeadingEmbeddingsExact(db, query, k) {
	const { dimensions } = getEmbeddingMeta(db);
	const values = Array.from(query);
	if (values.length !== dimensions) {
		throw new Error(
			`searchHeadingEmbeddingsExact: expected ${dimensions} dims, got ${values.length}`
		);
	}
	if (!db.native || !vectorsTableExists(db)) {
		return [];
	}
	const limit = Math.max(1, Number(k) || 1);
	const rows = db.native
		.prepare(
			`
			SELECT
				v.embedding_id AS embedding_id,
				v.distance AS distance,
				r.file_id AS file_id,
				r.heading_id AS heading_id
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
		file_id: Number(r.file_id),
		heading_id: Number(r.heading_id)
	}));
}

/**
 * @param {Buffer | Float32Array | number[] | string} raw
 * @param {number} dimensions
 * @returns {number[]}
 */
function coerceEmbeddingValues(raw, dimensions) {
	if (Buffer.isBuffer(raw)) {
		const floats = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
		return Array.from(floats);
	}
	if (raw instanceof Float32Array) {
		return Array.from(raw);
	}
	if (Array.isArray(raw)) {
		return raw.map(Number);
	}
	if (typeof raw === 'string') {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				return parsed.map(Number);
			}
		} catch {
			/* fall through */
		}
	}
	throw new Error(`coerceEmbeddingValues: unsupported payload (want ${dimensions} dims)`);
}

/**
 * Export all stored vectors for FAISS rebuild (sqlite-vec is authoritative).
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @returns {{ embedding_id: number, embedding: number[] }[]}
 */
function listAllHeadingEmbeddings(db) {
	const { dimensions } = getEmbeddingMeta(db);
	if (!db.native || !vectorsTableExists(db)) {
		return [];
	}
	const rows = db.native
		.prepare(
			`
			SELECT embedding_id, embedding
			FROM ${VECTORS_TABLE}
			ORDER BY embedding_id
			`
		)
		.all();
	/** @type {{ embedding_id: number, embedding: number[] }[]} */
	const out = [];
	for (const row of rows) {
		const embeddingId = Number(row.embedding_id);
		const values = coerceEmbeddingValues(row.embedding, dimensions);
		if (values.length !== dimensions) {
			console.warn(
				`[DRIP] skip embedding_id=${embeddingId}: dims ${values.length} !== ${dimensions}`
			);
			continue;
		}
		out.push({ embedding_id: embeddingId, embedding: values });
	}
	return out;
}

/**
 * Read one vector by embedding_id (for incremental FAISS upsert).
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number} embeddingId
 * @returns {number[] | undefined}
 */
function getHeadingEmbeddingVector(db, embeddingId) {
	const { dimensions } = getEmbeddingMeta(db);
	if (!db.native || !vectorsTableExists(db)) {
		return undefined;
	}
	const row = db.native
		.prepare(`SELECT embedding FROM ${VECTORS_TABLE} WHERE embedding_id = ?`)
		.get(BigInt(embeddingId));
	if (!row) {
		return undefined;
	}
	const values = coerceEmbeddingValues(row.embedding, dimensions);
	return values.length === dimensions ? values : undefined;
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
	setEmbeddingModelMeta,
	countHeadingEmbeddings,
	getEmbeddingId,
	allocateEmbeddingId,
	deleteHeadingEmbedding,
	deleteFileEmbeddings,
	clearAllHeadingEmbeddings,
	upsertHeadingEmbedding,
	searchHeadingEmbeddingsExact,
	listAllHeadingEmbeddings,
	getHeadingEmbeddingVector,
	coerceEmbeddingValues
};
