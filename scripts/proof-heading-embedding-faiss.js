/**
 * Step 7 smoke: FAISS rebuild/load/search + embedding_id mapping (no MiniLM download).
 * Run: node scripts/proof-heading-embedding-faiss.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const PASS = [];
const FAIL = [];

function assert(cond, label, detail) {
	if (cond) {
		PASS.push(label);
		console.log(`  PASS  ${label}${detail != null ? ` — ${JSON.stringify(detail)}` : ''}`);
	} else {
		FAIL.push(label);
		console.error(`  FAIL  ${label}${detail != null ? ` — ${JSON.stringify(detail)}` : ''}`);
	}
}

function unit(i, dim) {
	const v = new Array(dim).fill(0);
	v[i % dim] = 1;
	return v;
}

function installVscodeStub() {
	const orig = Module.prototype.require;
	Module.prototype.require = function (id) {
		if (id === 'vscode') {
			return {
				Uri: {
					file: p => ({ fsPath: p, scheme: 'file' }),
					joinPath: (base, ...parts) => ({
						fsPath: path.join(base.fsPath || String(base), ...parts),
						scheme: 'file',
						toString() {
							return 'file:///' + this.fsPath.replace(/\\/g, '/');
						}
					})
				},
				workspace: { fs: {} }
			};
		}
		return orig.apply(this, arguments);
	};
	return () => {
		Module.prototype.require = orig;
	};
}

async function main() {
	console.log('=== DRIP Step 7: heading embedding FAISS ===');
	const restore = installVscodeStub();

	const {
		loadFaissModule,
		rebuildFaissFromDb,
		ensureFaissSession,
		searchFaiss,
		clearFaissSession,
		deleteFaissArtifacts,
		faissIndexPath,
		faissManifestPath,
		readManifest,
		HNSW_FACTORY
	} = require('../src/indexing/embeddings/headingEmbeddingFaiss');
	const { openDripSqlite } = require('../src/indexing/db/dripSqlite');
	const { ensureDripIndexSchema } = require('../src/indexing/dbSchema/dripIndexSchema');
	const {
		upsertHeadingEmbedding,
		listAllHeadingEmbeddings,
		countHeadingEmbeddings
	} = require('../src/indexing/embeddings/headingEmbeddingStore');

	const faiss = loadFaissModule();
	assert(!!faiss, 'faiss-node loads');

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drip-emb-faiss-'));
	const dripIndex = path.join(dir, '.dripindex');
	fs.mkdirSync(dripIndex, { recursive: true });
	const dbPath = path.join(dripIndex, 'index.drip');
	fs.writeFileSync(dbPath, '');
	const db = openDripSqlite(dbPath);
	ensureDripIndexSchema(db);

	db.run(`INSERT INTO files (id, path, name, created_at, updated_at) VALUES (0, 'a.d.txt', 'a', 1, 1)`);
	const dim = 384;
	const n = 12;
	for (let h = 0; h < n; h++) {
		db.run(
			`INSERT INTO headings (file_id, heading_id, title, metadata_type_id, hash) VALUES (0, ?, ?, NULL, ?)`,
			[h, `Heading ${h}`, `h${h}`]
		);
		upsertHeadingEmbedding(db, 0, h, unit(h, dim));
	}

	assert(countHeadingEmbeddings(db) === n, 'sqlite-vec count', countHeadingEmbeddings(db));
	const listed = listAllHeadingEmbeddings(db);
	assert(listed.length === n, 'listAllHeadingEmbeddings', listed.length);
	assert(listed[0].embedding.length === dim, 'exported dims', listed[0].embedding.length);

	clearFaissSession();
	const kbRoot = { fsPath: dir };
	const session = rebuildFaissFromDb(kbRoot, db);
	assert(!!session, 'rebuildFaissFromDb returns session');
	assert(session.index.ntotal() === n, 'HNSW ntotal', session.index.ntotal());
	assert(session.embeddingIds.length === n, 'embeddingIds length', session.embeddingIds.length);
	assert(fs.existsSync(faissIndexPath(dir)), 'faiss file written');
	assert(fs.existsSync(faissManifestPath(dir)), 'manifest written');

	const manifest = readManifest(dir);
	assert(manifest && manifest.factory === HNSW_FACTORY, 'manifest factory', manifest && manifest.factory);
	assert(manifest.vectorCount === n, 'manifest vectorCount', manifest.vectorCount);

	const query = unit(3, dim);
	const hits = searchFaiss(kbRoot, db, query, 3);
	assert(hits.length === 3, 'search k=3', hits.length);
	assert(hits[0].embedding_id === listed[3].embedding_id, 'top hit is query axis', hits[0]);

	clearFaissSession();
	const loaded = ensureFaissSession(kbRoot, db);
	assert(!!loaded && loaded.index.ntotal() === n, 'ensure loads from disk', loaded && loaded.index.ntotal());
	const hits2 = searchFaiss(kbRoot, db, query, 1);
	assert(hits2[0].embedding_id === hits[0].embedding_id, 'reload search matches');

	deleteFaissArtifacts(kbRoot);
	assert(!fs.existsSync(faissIndexPath(dir)), 'artifacts deleted');

	db.close();
	clearFaissSession();
	fs.rmSync(dir, { recursive: true, force: true });
	restore();

	console.log('\n=== summary ===');
	console.log(`PASS ${PASS.length}  FAIL ${FAIL.length}`);
	if (FAIL.length) {
		process.exitCode = 1;
		return;
	}
	console.log('GO: FAISS HNSW rebuild/load/search maps labels → embedding_id.');
}

main().catch(err => {
	console.error('\nFATAL:', err && err.stack ? err.stack : err);
	process.exitCode = 1;
});
