/**
 * Step 4 smoke: embedding input text + queue (no model download).
 * Run: node scripts/proof-heading-embedding-text.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDripSqlite } = require('../src/indexing/db/dripSqlite');
const { ensureDripIndexSchema } = require('../src/indexing/dbSchema/dripIndexSchema');
const {
	buildHeadingEmbeddingText,
	normalizeSemanticTags,
	buildHeadingEmbeddingTextFromDb,
	buildHeadingEmbeddingTextFromParsed,
	collectSemanticTagsFromParsed
} = require('../src/indexing/embeddings/headingEmbeddingText');
const {
	enqueueHeadingEmbeddingJob,
	pendingHeadingEmbeddingJobCount,
	takeHeadingEmbeddingJobs,
	drainHeadingEmbeddingQueue,
	clearHeadingEmbeddingQueue
} = require('../src/indexing/embeddings/headingEmbeddingQueue');

const PASS = [];
const FAIL = [];

function assert(cond, label, detail) {
	if (cond) {
		PASS.push(label);
		console.log(`  PASS  ${label}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
	} else {
		FAIL.push(label);
		console.error(`  FAIL  ${label}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
	}
}

async function main() {
	console.log('=== DRIP Step 4: heading embedding input text + queue ===');

	assert(
		buildHeadingEmbeddingText({ title: '  Hello   World ', tags: [] }) === 'Hello World',
		'title only normalized'
	);
	assert(
		buildHeadingEmbeddingText({ title: 'Alpha', tags: ['react', 'React', ' vue '] }) ===
			'Alpha\nreact, vue',
		'title + deduped sorted tags'
	);
	assert(
		JSON.stringify(normalizeSemanticTags(['B', 'a', 'A'])) === JSON.stringify(['a', 'B']),
		'tag normalize sort'
	);

	const parsed = {
		searchtags: [
			{ source_heading_id: 1, tag_name: 'zeta' },
			{ source_heading_id: 1, tag_name: 'alpha' },
			{ source_heading_id: 2, tag_name: 'other' }
		]
	};
	assert(
		JSON.stringify(collectSemanticTagsFromParsed(parsed, 1)) === JSON.stringify(['alpha', 'zeta']),
		'collect from parsed'
	);
	assert(
		buildHeadingEmbeddingTextFromParsed({ title: 'Sec', heading_id: 1 }, parsed) ===
			'Sec\nalpha, zeta',
		'from parsed'
	);

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drip-emb-text-'));
	const dbPath = path.join(dir, 'index.drip');
	fs.writeFileSync(dbPath, '');
	const db = openDripSqlite(dbPath);
	ensureDripIndexSchema(db);
	db.run(`INSERT INTO files (id, path, name, created_at, updated_at) VALUES (0, 'n.d.txt', 'n', 1, 1)`);
	db.run(
		`INSERT INTO headings (file_id, heading_id, title, metadata_type_id, hash) VALUES (0, 1, 'Topic', NULL, 'x')`
	);
	db.run(`INSERT INTO tags (tag_id, tag_name) VALUES (1, 'graph'), (2, 'index')`);
	db.run(`INSERT INTO searchtags (file_id, heading_id, tag_id) VALUES (0, 1, 2), (0, 1, 1)`);
	assert(
		buildHeadingEmbeddingTextFromDb(db, 0, 1) === 'Topic\ngraph, index',
		'from db'
	);
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });

	clearHeadingEmbeddingQueue();
	const kb = 'C:/fake/kb';
	enqueueHeadingEmbeddingJob(kb, 0, 1, 'upsert');
	enqueueHeadingEmbeddingJob(kb, 0, 1, 'delete'); // last wins
	enqueueHeadingEmbeddingJob(kb, 0, 2, 'upsert');
	assert(pendingHeadingEmbeddingJobCount(kb) === 2, 'dedupe pending count');
	const taken = takeHeadingEmbeddingJobs(kb);
	assert(
		taken.find(j => j.headingId === 1).reason === 'delete',
		'last reason wins',
		taken.find(j => j.headingId === 1)
	);
	assert(pendingHeadingEmbeddingJobCount(kb) === 0, 'queue emptied by take');

	enqueueHeadingEmbeddingJob(kb, 1, 0, 'upsert');
	/** @type {number[]} */
	const seen = [];
	const result = await drainHeadingEmbeddingQueue(kb, async job => {
		seen.push(job.fileId);
	});
	assert(result.processed === 1 && seen[0] === 1, 'drain processes jobs', result);

	console.log('\n=== summary ===');
	console.log(`PASS ${PASS.length}  FAIL ${FAIL.length}`);
	if (FAIL.length) {
		process.exitCode = 1;
		return;
	}
	console.log('GO: embedding input text + queue API ready (encode uses retrieval/embeddings.js).');
	console.log('Note: index update wiring is Step 5.');
}

main().catch(err => {
	console.error('\nFATAL:', err && err.stack ? err.stack : err);
	process.exitCode = 1;
});
