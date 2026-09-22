/**
 * Step 1 proof: better-sqlite3 + sqlite-vec + faiss-node (isolated; no DRIP DB changes).
 * Run: node scripts/proof-native-embeddings.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const Database = require('better-sqlite3');
const { getLoadablePath } = require('sqlite-vec');
const { Index, IndexFlatL2, MetricType } = require('faiss-node');

const DIM = 8;
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

function l2(a, b) {
	let s = 0;
	for (let i = 0; i < a.length; i++) {
		const d = a[i] - b[i];
		s += d * d;
	}
	return s;
}

function main() {
	console.log('=== DRIP Step 1: native embedding stack proof ===');
	console.log(`node ${process.version} | ${process.platform} ${process.arch} | modules ${process.versions.modules}`);

	// --- better-sqlite3 ---
	console.log('\n[1] better-sqlite3');
	const db = new Database(':memory:');
	const ver = db.prepare('select sqlite_version() as v').get().v;
	assert(!!ver, 'open in-memory db', `sqlite ${ver}`);

	// --- sqlite-vec ---
	console.log('\n[2] sqlite-vec (vec0)');
	const vecPath = getLoadablePath();
	assert(fs.existsSync(vecPath), 'vec0 loadable exists', vecPath);
	db.loadExtension(vecPath);
	const vecVer = db.prepare('select vec_version() as v').get().v;
	assert(!!vecVer, 'load sqlite-vec extension', vecVer);

	db.exec(`
		CREATE TABLE heading_embedding_records (
			embedding_id INTEGER PRIMARY KEY,
			file_id TEXT NOT NULL,
			heading_id TEXT NOT NULL,
			UNIQUE(file_id, heading_id)
		);
		CREATE VIRTUAL TABLE heading_embeddings USING vec0(
			embedding_id INTEGER PRIMARY KEY,
			embedding float[${DIM}]
		);
	`);
	assert(true, 'create records + vec0 tables');

	const rows = [
		{ embedding_id: 1, file_id: 'fA', heading_id: 'h1', embedding: [1, 0, 0, 0, 0, 0, 0, 0] },
		{ embedding_id: 2, file_id: 'fA', heading_id: 'h2', embedding: [0, 1, 0, 0, 0, 0, 0, 0] },
		{ embedding_id: 3, file_id: 'fB', heading_id: 'h1', embedding: [0.9, 0.1, 0, 0, 0, 0, 0, 0] },
	];

	const insertRec = db.prepare(
		'INSERT INTO heading_embedding_records (embedding_id, file_id, heading_id) VALUES (?, ?, ?)'
	);
	// sqlite-vec + better-sqlite3: PK must be BigInt; vector as JSON text
	const insertVec = db.prepare(
		'INSERT INTO heading_embeddings (embedding_id, embedding) VALUES (?, ?)'
	);
	const insertAll = db.transaction((items) => {
		for (const r of items) {
			insertRec.run(r.embedding_id, r.file_id, r.heading_id);
			insertVec.run(BigInt(r.embedding_id), JSON.stringify(r.embedding));
		}
	});
	insertAll(rows);
	assert(db.prepare('SELECT COUNT(*) AS n FROM heading_embeddings').get().n === 3, 'insert 3 vectors');

	const queryJson = JSON.stringify([0.95, 0.05, 0, 0, 0, 0, 0, 0]);
	const knn = db.prepare(`
		SELECT
			v.embedding_id,
			v.distance,
			r.file_id,
			r.heading_id
		FROM heading_embeddings v
		JOIN heading_embedding_records r ON r.embedding_id = v.embedding_id
		WHERE v.embedding MATCH ?
		  AND k = 2
		ORDER BY v.distance
	`).all(queryJson);

	assert(knn.length === 2, 'vec0 KNN returns k=2', JSON.stringify(knn.map((x) => Number(x.embedding_id))));
	const topId = Number(knn[0].embedding_id);
	assert(
		topId === 1 || topId === 3,
		'vec0 top hit is near query (id 1 or 3)',
		`top=${topId} dist=${knn[0].distance}`
	);
	assert(knn[0].file_id && knn[0].heading_id, 'vec0 join maps embedding_id → (file_id, heading_id)',
		`${knn[0].file_id}/${knn[0].heading_id}`);

	// --- faiss-node ---
	console.log('\n[3] faiss-node (HNSW + persist)');
	const flat = new IndexFlatL2(DIM);
	for (const r of rows) {
		flat.add(r.embedding);
	}
	assert(flat.ntotal() === 3, 'IndexFlatL2 add', `ntotal=${flat.ntotal()}`);
	const flatHit = flat.search([0.95, 0.05, 0, 0, 0, 0, 0, 0], 1);
	assert(flatHit.labels[0] === 0 || flatHit.labels[0] === 2, 'IndexFlatL2 search label',
		`label=${flatHit.labels[0]} dist=${flatHit.distances[0]}`);

	const hnsw = Index.fromFactory(DIM, 'HNSW32,Flat', MetricType.METRIC_L2);
	const flatVectors = rows.flatMap((r) => r.embedding);
	if (!hnsw.isTrained()) {
		hnsw.train(flatVectors);
	}
	hnsw.add(flatVectors);
	assert(hnsw.ntotal() === 3, 'HNSW fromFactory add', `ntotal=${hnsw.ntotal()}`);

	const hnswHit = hnsw.search([0.95, 0.05, 0, 0, 0, 0, 0, 0], 2);
	assert(hnswHit.labels.length === 2, 'HNSW search k=2', JSON.stringify(hnswHit.labels));

	// Map FAISS row label → embedding_id (insertion order)
	const labelToEmbeddingId = rows.map((r) => r.embedding_id);
	const topEmbId = labelToEmbeddingId[hnswHit.labels[0]];
	const mapped = db.prepare(
		'SELECT file_id, heading_id FROM heading_embedding_records WHERE embedding_id = ?'
	).get(topEmbId);
	assert(!!mapped, 'FAISS label → embedding_id → (file_id, heading_id)',
		`label=${hnswHit.labels[0]} → emb=${topEmbId} → ${mapped.file_id}/${mapped.heading_id}`);

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drip-faiss-proof-'));
	const indexPath = path.join(tmpDir, 'headings.faiss');
	hnsw.write(indexPath);
	assert(fs.existsSync(indexPath), 'FAISS write to disk', indexPath);

	const loaded = Index.read(indexPath);
	assert(loaded.ntotal() === 3, 'FAISS read back', `ntotal=${loaded.ntotal()}`);
	const loadedHit = loaded.search([0.95, 0.05, 0, 0, 0, 0, 0, 0], 1);
	assert(
		loadedHit.labels[0] === hnswHit.labels[0],
		'FAISS reload search matches',
		`label=${loadedHit.labels[0]}`
	);

	// Sanity: exact L2 of query vs row 1 should be small
	const expected = l2([0.95, 0.05, 0, 0, 0, 0, 0, 0], rows[0].embedding);
	assert(expected < 0.01, 'manual L2 sanity', `l2=${expected}`);

	db.close();
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}

	console.log('\n=== summary ===');
	console.log(`PASS ${PASS.length}  FAIL ${FAIL.length}`);
	if (FAIL.length) {
		console.error('Failed:', FAIL.join(', '));
		process.exitCode = 1;
		return;
	}
	console.log('GO: better-sqlite3 + sqlite-vec + faiss-node work in plain Node on this machine.');
	console.log('Note: VS Code Extension Host still needs Electron ABI rebuild (later step).');
}

try {
	main();
} catch (err) {
	console.error('\nFATAL:', err && err.stack ? err.stack : err);
	process.exitCode = 1;
}
