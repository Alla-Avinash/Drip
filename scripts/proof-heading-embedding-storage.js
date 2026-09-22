/**
 * Step 3 smoke: schema v11 embedding storage + sqlite-vec (no model inference).
 * Run: node scripts/proof-heading-embedding-storage.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDripSqlite } = require('../src/indexing/db/dripSqlite');
const { ensureDripIndexSchema, SCHEMA_VERSION } = require('../src/indexing/dbSchema/dripIndexSchema');
const {
	DEFAULT_EMBEDDING_DIMENSIONS,
	getEmbeddingMeta,
	countHeadingEmbeddings,
	upsertHeadingEmbedding,
	searchHeadingEmbeddingsExact,
	deleteHeadingEmbedding,
	clearAllHeadingEmbeddings
} = require('../src/indexing/embeddings/headingEmbeddingStore');

const PASS = [];
const FAIL = [];

function assert(cond, label, detail) {
	if (cond) {
		PASS.push(label);
		console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
	} else {
		FAIL.push(label);
		console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
	}
}

function unit(i, dim) {
	const v = new Array(dim).fill(0);
	v[i % dim] = 1;
	return v;
}

function main() {
	console.log('=== DRIP Step 3: heading embedding storage ===');
	assert(SCHEMA_VERSION === 11, 'SCHEMA_VERSION is 11', String(SCHEMA_VERSION));

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drip-emb-store-'));
	const dbPath = path.join(dir, 'index.drip');
	fs.writeFileSync(dbPath, '');

	const db = openDripSqlite(dbPath);
	ensureDripIndexSchema(db);

	const verStmt = db.prepare(`SELECT value FROM index_meta WHERE key = 'schema_version'`);
	verStmt.bind([]);
	verStmt.step();
	const ver = Number(verStmt.get()[0]);
	verStmt.free();
	assert(ver === 11, 'persisted schema_version', String(ver));

	const meta = getEmbeddingMeta(db);
	assert(meta.dimensions === DEFAULT_EMBEDDING_DIMENSIONS, 'embedding dimensions', String(meta.dimensions));
	assert(!!meta.model, 'embedding_model seeded', meta.model);

	db.run(`INSERT INTO files (id, path, name, created_at, updated_at) VALUES (0, 'a.d.txt', 'a', 1, 1)`);
	db.run(
		`INSERT INTO headings (file_id, heading_id, title, metadata_type_id, hash) VALUES (0, 0, 'Root', NULL, 'h0')`
	);
	db.run(
		`INSERT INTO headings (file_id, heading_id, title, metadata_type_id, hash) VALUES (0, 1, 'Alpha', NULL, 'h1')`
	);
	db.run(
		`INSERT INTO headings (file_id, heading_id, title, metadata_type_id, hash) VALUES (0, 2, 'Beta', NULL, 'h2')`
	);

	const dim = meta.dimensions;
	const id0 = upsertHeadingEmbedding(db, 0, 0, unit(0, dim));
	const id1 = upsertHeadingEmbedding(db, 0, 1, unit(1, dim));
	const id2 = upsertHeadingEmbedding(db, 0, 2, unit(2, dim));
	assert(id0 >= 1 && id1 >= 1 && id2 >= 1, 'upsert returns embedding_ids', `${id0},${id1},${id2}`);
	assert(countHeadingEmbeddings(db) === 3, 'count = 3');

	const hits = searchHeadingEmbeddingsExact(db, unit(1, dim), 2);
	assert(hits.length === 2, 'knn k=2', JSON.stringify(hits.map(h => h.heading_id)));
	assert(hits[0].heading_id === 1, 'top hit is heading 1', `h=${hits[0].heading_id}`);
	assert(hits[0].file_id === 0, 'join file_id');

	deleteHeadingEmbedding(db, 0, 1);
	assert(countHeadingEmbeddings(db) === 2, 'count after delete heading');

	// upsert replace
	upsertHeadingEmbedding(db, 0, 2, unit(5, dim));
	assert(countHeadingEmbeddings(db) === 2, 'count after replace upsert');

	clearAllHeadingEmbeddings(db);
	assert(countHeadingEmbeddings(db) === 0, 'clear all');

	db.close();

	const db2 = openDripSqlite(dbPath);
	ensureDripIndexSchema(db2);
	assert(getEmbeddingMeta(db2).dimensions === dim, 'meta survives reopen');
	assert(countHeadingEmbeddings(db2) === 0, 'empty after clear persists');
	db2.close();

	fs.rmSync(dir, { recursive: true, force: true });

	console.log('\n=== summary ===');
	console.log(`PASS ${PASS.length}  FAIL ${FAIL.length}`);
	if (FAIL.length) {
		process.exitCode = 1;
		return;
	}
	console.log('GO: v11 embedding storage + sqlite-vec CRUD/KNN work.');
}

try {
	main();
} catch (err) {
	console.error('\nFATAL:', err && err.stack ? err.stack : err);
	process.exitCode = 1;
}
