/**
 * Step 6 smoke: search method lock + exact KNN card join (no model download).
 * Run: node scripts/proof-heading-embedding-search.js
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
	console.log('=== DRIP Step 6: heading embedding search ===');
	const restore = installVscodeStub();

	const {
		chooseMethodForCount,
		FAISS_VECTOR_THRESHOLD,
		lockHeadingEmbeddingSearchMethod,
		getLockedHeadingEmbeddingSearchMethod,
		clearHeadingEmbeddingSearchLock
	} = require('../src/indexing/embeddings/headingEmbeddingSearchMethod');
	const { openDripSqlite } = require('../src/indexing/db/dripSqlite');
	const { ensureDripIndexSchema } = require('../src/indexing/dbSchema/dripIndexSchema');
	const { upsertHeadingEmbedding } = require('../src/indexing/embeddings/headingEmbeddingStore');
	const {
		searchHeadingsExact,
		distanceToScore,
		embeddingHitsToRetrieverWireRows,
		loadCardsForEmbeddingIds
	} = require('../src/indexing/embeddings/headingEmbeddingSearch');

	assert(chooseMethodForCount(0) === 'none', '0 → none');
	assert(chooseMethodForCount(1) === 'exact', '1 → exact');
	assert(chooseMethodForCount(FAISS_VECTOR_THRESHOLD) === 'exact', '1000 → exact');
	assert(chooseMethodForCount(FAISS_VECTOR_THRESHOLD + 1) === 'faiss', '1001 → faiss');
	assert(distanceToScore(0) === 1, 'distance 0 → score 1');

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drip-emb-search-'));
	const dripIndex = path.join(dir, '.dripindex');
	fs.mkdirSync(dripIndex, { recursive: true });
	const dbPath = path.join(dripIndex, 'index.drip');
	fs.writeFileSync(dbPath, '');
	const db = openDripSqlite(dbPath);
	ensureDripIndexSchema(db);

	db.run(`INSERT INTO files (id, path, name, created_at, updated_at) VALUES (0, 'a.d.txt', 'a', 1, 1)`);
	db.run(
		`INSERT INTO headings (file_id, heading_id, title, metadata_type_id, hash) VALUES (0, 0, 'Root', NULL, 'h0')`
	);
	db.run(
		`INSERT INTO headings (file_id, heading_id, title, metadata_type_id, hash) VALUES (0, 1, 'React hooks', NULL, 'h1')`
	);
	db.run(`INSERT INTO tags (tag_id, tag_name) VALUES (1, 'react')`);
	db.run(`INSERT INTO searchtags (file_id, heading_id, tag_id) VALUES (0, 1, 1)`);

	const dim = 384;
	upsertHeadingEmbedding(db, 0, 0, unit(0, dim));
	upsertHeadingEmbedding(db, 0, 1, unit(1, dim));
	db.close();

	const kbRoot = { fsPath: dir };
	clearHeadingEmbeddingSearchLock();
	const lock = await lockHeadingEmbeddingSearchMethod(kbRoot, { force: true });
	assert(lock.method === 'exact' && lock.vectorCount === 2, 'lock exact for 2 vectors', lock);
	const again = await lockHeadingEmbeddingSearchMethod(kbRoot);
	assert(again.lockedAt === lock.lockedAt, 'second lock is idempotent');
	assert(getLockedHeadingEmbeddingSearchMethod(kbRoot).method === 'exact', 'get locked');

	// Exact search without encode: call store KNN via searchHeadingsExact would encode —
	// instead test card join + wire mapping with a reopened DB.
	const db2 = openDripSqlite(dbPath);
	const cards = loadCardsForEmbeddingIds(db2, [1, 2], kbRoot);
	assert(cards.size === 2, 'load cards for embedding ids', cards.size);
	const card1 = [...cards.values()].find(c => c.heading_id === 1);
	assert(card1 && card1.title === 'React hooks', 'card title from DB', card1 && card1.title);
	assert(card1.tags.includes('react'), 'card tags from DB', card1.tags);
	assert(card1.uri.includes('a.d.txt'), 'card uri from path', card1.uri);

	const wire = embeddingHitsToRetrieverWireRows([
		{ ...card1, distance: 0.1, score: distanceToScore(0.1) }
	]);
	assert(wire[0].title === 'React hooks' && wire[0].tags[0] === 'react', 'wire row');

	// searchHeadingsExact needs encode — skip heavy model; verify function exists
	assert(typeof searchHeadingsExact === 'function', 'searchHeadingsExact exported');

	db2.close();
	clearHeadingEmbeddingSearchLock();
	fs.rmSync(dir, { recursive: true, force: true });
	restore();

	console.log('\n=== summary ===');
	console.log(`PASS ${PASS.length}  FAIL ${FAIL.length}`);
	if (FAIL.length) {
		process.exitCode = 1;
		return;
	}
	console.log('GO: search method lock + DB card join work (exact encode path uses shared MiniLM).');
}

main().catch(err => {
	console.error('\nFATAL:', err && err.stack ? err.stack : err);
	process.exitCode = 1;
});
