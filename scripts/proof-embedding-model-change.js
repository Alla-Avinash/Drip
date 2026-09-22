/**
 * Step 9 smoke: model change clears vectors + bumps generation (no MiniLM download).
 * Run: node scripts/proof-embedding-model-change.js
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
				window: {
					showWarningMessage: async () => 'Change & Rebuild',
					showInformationMessage: async () => undefined
				},
				workspace: {
					fs: {},
					getConfiguration: () => ({
						get: (k, d) => d,
						update: async () => undefined
					})
				},
				ConfigurationTarget: { Workspace: 2, Global: 1 }
			};
		}
		return orig.apply(this, arguments);
	};
	return () => {
		Module.prototype.require = orig;
	};
}

async function main() {
	console.log('=== DRIP Step 9: embedding model change ===');
	const restore = installVscodeStub();

	const { openDripSqlite } = require('../src/indexing/db/dripSqlite');
	const { ensureDripIndexSchema } = require('../src/indexing/dbSchema/dripIndexSchema');
	const {
		upsertHeadingEmbedding,
		getEmbeddingMeta,
		countHeadingEmbeddings
	} = require('../src/indexing/embeddings/headingEmbeddingStore');
	const {
		upsertFolderEmbedding,
		countFolderEmbeddings
	} = require('../src/indexing/embeddings/folderEmbeddingStore');
	const {
		normalizeEmbeddingModelId,
		applyEmbeddingModelChange
	} = require('../src/indexing/embeddings/embeddingModelChange');

	assert(
		normalizeEmbeddingModelId('  Xenova/foo  ') === 'Xenova/foo',
		'normalize trim'
	);

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drip-model-change-'));
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
	const dim = 384;
	upsertHeadingEmbedding(db, 0, 0, unit(0, dim));
	upsertFolderEmbedding(db, '.', unit(1, dim));
	const before = getEmbeddingMeta(db);
	assert(countHeadingEmbeddings(db) === 1, 'heading vectors before');
	assert(countFolderEmbeddings(db) === 1, 'folder vectors before');
	db.close();

	const kbRoot = { fsPath: dir };
	const result = await applyEmbeddingModelChange(kbRoot, 'Xenova/other-model');
	assert(result.ok && result.model === 'Xenova/other-model', 'apply ok', result);

	const db2 = openDripSqlite(dbPath);
	const after = getEmbeddingMeta(db2);
	assert(after.model === 'Xenova/other-model', 'meta model updated', after.model);
	assert(Number(after.generation) === Number(before.generation) + 1, 'generation bumped', {
		before: before.generation,
		after: after.generation
	});
	assert(countHeadingEmbeddings(db2) === 0, 'heading vectors cleared');
	assert(countFolderEmbeddings(db2) === 0, 'folder vectors cleared');

	const fileCount = Number(
		db2.native.prepare('SELECT COUNT(*) AS n FROM files').get().n
	);
	const headingCount = Number(
		db2.native.prepare('SELECT COUNT(*) AS n FROM headings').get().n
	);
	assert(fileCount === 1 && headingCount === 1, 'note rows preserved', {
		fileCount,
		headingCount
	});

	const skip = await applyEmbeddingModelChange(kbRoot, 'Xenova/other-model');
	assert(skip.skipped === true, 'same model skips wipe');

	db2.close();
	fs.rmSync(dir, { recursive: true, force: true });
	restore();

	console.log('\n=== summary ===');
	console.log(`PASS ${PASS.length}  FAIL ${FAIL.length}`);
	if (FAIL.length) {
		process.exitCode = 1;
		return;
	}
	console.log('GO: model change clears embedding tables only and bumps generation.');
}

main().catch(err => {
	console.error('\nFATAL:', err && err.stack ? err.stack : err);
	process.exitCode = 1;
});
