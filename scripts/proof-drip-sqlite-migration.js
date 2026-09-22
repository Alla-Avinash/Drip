/**
 * Step 2 smoke: better-sqlite3 file-backed index.drip + v10 schema (no embeddings).
 * Run: node scripts/proof-drip-sqlite-migration.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDripSqlite } = require('../src/indexing/db/dripSqlite');
const { ensureDripIndexSchema, SCHEMA_VERSION } = require('../src/indexing/dbSchema/dripIndexSchema');

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

function main() {
	console.log('=== DRIP Step 2: sql.js → better-sqlite3 migration smoke ===');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drip-sqlite-mig-'));
	const dbPath = path.join(dir, 'index.drip');

	// Empty file like initializeDripIndex creates
	fs.writeFileSync(dbPath, '');
	const db = openDripSqlite(dbPath);
	ensureDripIndexSchema(db);

	const verRow = db.exec(`SELECT value FROM index_meta WHERE key = 'schema_version'`);
	const ver = verRow[0] && verRow[0].values[0] ? Number(verRow[0].values[0][0]) : -1;
	assert(ver === SCHEMA_VERSION, 'schema_version', `got ${ver}, want ${SCHEMA_VERSION}`);
	assert(SCHEMA_VERSION >= 11, 'schema includes embeddings era', String(SCHEMA_VERSION));

	db.run(`INSERT INTO files (id, path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [
		0,
		'note.d.txt',
		'note',
		1,
		1
	]);
	db.run(
		`INSERT INTO headings (file_id, heading_id, title, metadata_type_id, hash) VALUES (?, ?, ?, ?, ?)`,
		[0, 0, 'Root', null, 'abc']
	);
	db.run('BEGIN');
	db.run(`INSERT INTO tags (tag_id, tag_name) VALUES (?, ?)`, [1, 'react']);
	db.run(`INSERT INTO searchtags (file_id, heading_id, tag_id) VALUES (?, ?, ?)`, [0, 0, 1]);
	db.run('COMMIT');

	const paths = db.exec('SELECT path FROM files ORDER BY path');
	assert(
		paths[0].values[0][0] === 'note.d.txt',
		'exec SELECT files.path',
		String(paths[0].values[0][0])
	);

	const stmt = db.prepare('SELECT heading_id, hash FROM headings WHERE file_id = ?');
	stmt.bind([0]);
	assert(stmt.step(), 'prepare/bind/step');
	const row = stmt.get();
	assert(Number(row[0]) === 0 && String(row[1]) === 'abc', 'stmt.get positional', JSON.stringify(row));
	stmt.free();

	const tags = db.exec('SELECT tag_name FROM tags');
	assert(tags[0].values[0][0] === 'react', 'tags row');

	db.close();

	// Re-open persisted file
	const db2 = openDripSqlite(dbPath);
	ensureDripIndexSchema(db2);
	const count = db2.exec('SELECT COUNT(*) FROM headings');
	assert(Number(count[0].values[0][0]) === 1, 'persist across reopen', String(count[0].values[0][0]));
	db2.close();

	fs.rmSync(dir, { recursive: true, force: true });

	console.log('\n=== summary ===');
	console.log(`PASS ${PASS.length}  FAIL ${FAIL.length}`);
	if (FAIL.length) {
		process.exitCode = 1;
		return;
	}
	console.log('GO: file-backed better-sqlite3 + current schema works without sql.js.');
}

try {
	main();
} catch (err) {
	console.error('\nFATAL:', err && err.stack ? err.stack : err);
	process.exitCode = 1;
}
