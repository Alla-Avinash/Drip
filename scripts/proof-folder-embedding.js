/**
 * Step 8 smoke: folder embedding text/store/search (no MiniLM download).
 * Run: node scripts/proof-folder-embedding.js
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
	console.log('=== DRIP Step 8: folder embeddings ===');
	const restore = installVscodeStub();

	const {
		normalizeFolderPath,
		ancestorFolderPathsOfNote,
		buildFolderEmbeddingText,
		listFolderPathsFromFiles,
		getFolderH0TitleFromDb,
		buildFolderEmbeddingTextFromDb
	} = require('../src/indexing/embeddings/folderEmbeddingText');
	const {
		ensureFolderEmbeddingStorage,
		upsertFolderEmbedding,
		searchFolderEmbeddingsExact,
		countFolderEmbeddings,
		getFolderEmbeddingId,
		clearAllFolderEmbeddings
	} = require('../src/indexing/embeddings/folderEmbeddingStore');
	const { openDripSqlite } = require('../src/indexing/db/dripSqlite');
	const { ensureDripIndexSchema } = require('../src/indexing/dbSchema/dripIndexSchema');

	assert(normalizeFolderPath('') === '.', 'root normalize');
	assert(normalizeFolderPath('a/b/') === 'a/b', 'trim trailing slash');
	assert(
		JSON.stringify(ancestorFolderPathsOfNote('docs/api/note.d.txt')) ===
			JSON.stringify(['.', 'docs', 'docs/api']),
		'ancestors'
	);
	assert(
		buildFolderEmbeddingText({ folderPath: 'docs/api', h0Title: 'API surface' }) ===
			'docs/api\nAPI surface',
		'text with h0'
	);
	assert(buildFolderEmbeddingText({ folderPath: 'docs' }) === 'docs', 'text path only');

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drip-folder-emb-'));
	const dripIndex = path.join(dir, '.dripindex');
	fs.mkdirSync(dripIndex, { recursive: true });
	const dbPath = path.join(dripIndex, 'index.drip');
	fs.writeFileSync(dbPath, '');
	const db = openDripSqlite(dbPath);
	ensureDripIndexSchema(db);
	ensureFolderEmbeddingStorage(db);

	db.run(`INSERT INTO files (id, path, name, created_at, updated_at) VALUES (1, 'docs/api/api.d.txt', 'api.d.txt', 1, 1)`);
	db.run(
		`INSERT INTO headings (file_id, heading_id, title, metadata_type_id, hash) VALUES (1, 0, 'API surface', NULL, 'h0')`
	);
	db.run(`INSERT INTO files (id, path, name, created_at, updated_at) VALUES (2, 'docs/guide.d.txt', 'guide.d.txt', 1, 1)`);
	db.run(
		`INSERT INTO headings (file_id, heading_id, title, metadata_type_id, hash) VALUES (2, 0, 'Guide root', NULL, 'h0')`
	);

	const folders = listFolderPathsFromFiles(db);
	assert(folders.includes('.') && folders.includes('docs') && folders.includes('docs/api'), 'derived folders', folders);
	assert(getFolderH0TitleFromDb(db, 'docs/api') === 'API surface', 'rep note h0 by basename');
	assert(buildFolderEmbeddingTextFromDb(db, 'docs/api').includes('API surface'), 'fromDb text');

	const dim = 384;
	upsertFolderEmbedding(db, 'docs/api', unit(0, dim));
	upsertFolderEmbedding(db, 'docs', unit(1, dim));
	upsertFolderEmbedding(db, '.', unit(2, dim));
	assert(countFolderEmbeddings(db) === 3, 'count', countFolderEmbeddings(db));
	assert(getFolderEmbeddingId(db, 'docs/api') != null, 'id for docs/api');

	const hits = searchFolderEmbeddingsExact(db, unit(0, dim), 2);
	assert(hits.length === 2, 'knn k=2', hits.length);
	assert(hits[0].folder_path === 'docs/api', 'top folder', hits[0]);

	clearAllFolderEmbeddings(db);
	assert(countFolderEmbeddings(db) === 0, 'cleared');

	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
	restore();

	console.log('\n=== summary ===');
	console.log(`PASS ${PASS.length}  FAIL ${FAIL.length}`);
	if (FAIL.length) {
		process.exitCode = 1;
		return;
	}
	console.log('GO: folder embedding text + sqlite-vec exact path work.');
}

main().catch(err => {
	console.error('\nFATAL:', err && err.stack ? err.stack : err);
	process.exitCode = 1;
});
