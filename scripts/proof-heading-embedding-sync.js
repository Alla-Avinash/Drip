/**
 * Step 5 smoke: embedding sync planning (no model download, no vscode).
 * Run: node scripts/proof-heading-embedding-sync.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDripSqlite } = require('../src/indexing/db/dripSqlite');
const { ensureDripIndexSchema } = require('../src/indexing/dbSchema/dripIndexSchema');
const {
	upsertHeadingEmbedding,
	getEmbeddingId,
	deleteHeadingEmbedding
} = require('../src/indexing/embeddings/headingEmbeddingStore');
const {
	planHeadingEmbeddingRewrite,
	collectAllHeadingEmbeddingTargets,
	enqueueHeadingEmbeddingUpserts,
	enqueueMissingHeadingEmbeddings
} = require('../src/indexing/embeddings/headingEmbeddingSync');
const {
	pendingHeadingEmbeddingJobCount,
	clearHeadingEmbeddingQueue,
	takeHeadingEmbeddingJobs
} = require('../src/indexing/embeddings/headingEmbeddingQueue');

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

async function main() {
	console.log('=== DRIP Step 5: heading embedding sync planning ===');
	clearHeadingEmbeddingQueue();

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drip-emb-sync-'));
	const dbPath = path.join(dir, 'index.drip');
	fs.writeFileSync(dbPath, '');
	const db = openDripSqlite(dbPath);
	ensureDripIndexSchema(db);

	db.run(`INSERT INTO files (id, path, name, created_at, updated_at) VALUES (0, 'n.d.txt', 'n', 1, 1)`);
	db.run(
		`INSERT INTO headings (file_id, heading_id, title, metadata_type_id, hash) VALUES (0, 0, 'Root', NULL, 'h0')`
	);
	db.run(
		`INSERT INTO headings (file_id, heading_id, title, metadata_type_id, hash) VALUES (0, 1, 'Alpha', NULL, 'h1')`
	);
	db.run(`INSERT INTO tags (tag_id, tag_name) VALUES (1, 'react')`);
	db.run(`INSERT INTO searchtags (file_id, heading_id, tag_id) VALUES (0, 1, 1)`);
	upsertHeadingEmbedding(db, 0, 1, unit(1, 384));

	const parsed = {
		headings: [
			{ heading_id: 0, title: 'Root' },
			{ heading_id: 1, title: 'Alpha' }
		],
		searchtags: [{ source_heading_id: 1, tag_name: 'react' }]
	};

	assert(
		collectAllHeadingEmbeddingTargets(0, parsed).length === 2,
		'collectAll targets'
	);

	const same = planHeadingEmbeddingRewrite(db, 0, 1, parsed);
	assert(same.keepEmbedding && !same.needUpsert, 'unchanged title/tags keeps vector');

	const titleChange = planHeadingEmbeddingRewrite(db, 0, 1, {
		headings: [{ heading_id: 1, title: 'Alpha Renamed' }],
		searchtags: [{ source_heading_id: 1, tag_name: 'react' }]
	});
	assert(titleChange.needUpsert && !titleChange.keepEmbedding, 'title change needs upsert');

	const tagChange = planHeadingEmbeddingRewrite(db, 0, 1, {
		headings: [{ heading_id: 1, title: 'Alpha' }],
		searchtags: [{ source_heading_id: 1, tag_name: 'vue' }]
	});
	assert(tagChange.needUpsert, 'tag change needs upsert');

	const bodyOnlyPlan = planHeadingEmbeddingRewrite(db, 0, 1, {
		headings: [{ heading_id: 1, title: 'Alpha' }],
		searchtags: [{ source_heading_id: 1, tag_name: 'react' }]
	});
	assert(bodyOnlyPlan.keepEmbedding, 'same title/tags → keep (body-only edit case)');

	// Simulate keepEmbedding rewrite: delete scoped rows without wiping vector
	assert(getEmbeddingId(db, 0, 1) != null, 'vector present before keep path');
	deleteHeadingEmbedding(db, 0, 2); // no-op missing
	// keep path: do not call deleteHeadingEmbedding
	assert(getEmbeddingId(db, 0, 1) != null, 'vector still present when keepEmbedding');

	db.close();

	// Missing repair enqueue (opens DB via lazy dripIndexDb — needs vscode stub)
	const Module = require('module');
	const origRequire = Module.prototype.require;
	Module.prototype.require = function (id) {
		if (id === 'vscode') {
			return {
				Uri: {
					file: p => ({ fsPath: p, scheme: 'file' }),
					joinPath: (base, ...parts) => ({
						fsPath: path.join(base.fsPath || base, ...parts),
						scheme: 'file'
					})
				},
				workspace: { fs: {} }
			};
		}
		return origRequire.apply(this, arguments);
	};

	try {
		clearHeadingEmbeddingQueue();
		// Point a fake kb root at our temp dir; getIndexDbUri joins .dripindex/index.drip
		const kbRoot = { fsPath: dir };
		const dripIndex = path.join(dir, '.dripindex');
		fs.mkdirSync(dripIndex, { recursive: true });
		fs.renameSync(dbPath, path.join(dripIndex, 'index.drip'));

		const n = await enqueueMissingHeadingEmbeddings(kbRoot);
		assert(n >= 1, 'enqueue missing (h0 has no vector)', n);
		assert(pendingHeadingEmbeddingJobCount(kbRoot) >= 1, 'jobs pending after missing scan');
		const jobs = takeHeadingEmbeddingJobs(kbRoot);
		assert(jobs.some(j => j.headingId === 0), 'missing includes heading 0', jobs);

		enqueueHeadingEmbeddingUpserts(kbRoot, [{ fileId: 0, headingId: 1 }]);
		assert(pendingHeadingEmbeddingJobCount(kbRoot) === 1, 'upsert enqueue');
	} finally {
		Module.prototype.require = origRequire;
		clearHeadingEmbeddingQueue();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}

	console.log('\n=== summary ===');
	console.log(`PASS ${PASS.length}  FAIL ${FAIL.length}`);
	if (FAIL.length) {
		process.exitCode = 1;
		return;
	}
	console.log('GO: sync plans upserts only when title/tags change; missing repair enqueues.');
}

main().catch(err => {
	console.error('\nFATAL:', err && err.stack ? err.stack : err);
	process.exitCode = 1;
});
