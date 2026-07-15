'use strict';

/**
 * Canonical SQLite schema for `<kb>/.dripindex/index.drip` (spec: cursor/new/features.txt §4–7).
 *
 * Heading identity in `.d.txt` files: `@fN:hM #hash` on the line **above** `# title` (not below).
 * Per-file heading id allocator: `index_meta.heading_alloc_<file_id>` → JSON `{ "next": N, "free": […] }`.
 *
 * Defaults (application-enforced; see `headings.metadata_type`):
 * - `headings.metadata_type` → SQL NULL when the note has no `.type` marker or an unknown type
 * - `headings.tab_depth` → `0`
 * - `index_meta.schema_version` → `6`
 * - `index_meta.next_file_id` → `0`
 */

const SCHEMA_VERSION = 6;

/** @type {string} */
const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS index_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
	id INTEGER PRIMARY KEY,
	path TEXT NOT NULL UNIQUE,
	name TEXT,
	created_at INTEGER,
	updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS headings (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	parent_id INTEGER,
	title TEXT NOT NULL,
	tab_depth INTEGER NOT NULL DEFAULT 0,
	metadata_type TEXT,
	hash TEXT,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS heading_references (
	source_file_id INTEGER NOT NULL,
	source_heading_id INTEGER NOT NULL,
	target_file_id INTEGER NOT NULL,
	target_heading_id INTEGER NOT NULL,
	PRIMARY KEY (source_file_id, source_heading_id, target_file_id, target_heading_id)
);

CREATE INDEX IF NOT EXISTS idx_ref_source ON heading_references(source_file_id, source_heading_id);
CREATE INDEX IF NOT EXISTS idx_ref_target ON heading_references(target_file_id, target_heading_id);
CREATE INDEX IF NOT EXISTS idx_heading_type ON headings(metadata_type);
CREATE INDEX IF NOT EXISTS idx_parent ON headings(file_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_headings_title ON headings(title);

CREATE TABLE IF NOT EXISTS tags (
	tag_id INTEGER PRIMARY KEY,
	tag_name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS searchtags (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	tag_id INTEGER NOT NULL,
	PRIMARY KEY (file_id, heading_id, tag_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE,
	FOREIGN KEY (tag_id) REFERENCES tags(tag_id)
);

CREATE INDEX IF NOT EXISTS idx_searchtags_tag ON searchtags(tag_id);

CREATE TABLE IF NOT EXISTS relations (
	from_file_id INTEGER NOT NULL,
	from_heading_id INTEGER NOT NULL,
	relation_type TEXT NOT NULL,
	tag_id INTEGER NOT NULL,
	PRIMARY KEY (from_file_id, from_heading_id, relation_type, tag_id),
	FOREIGN KEY (tag_id) REFERENCES tags(tag_id)
);

CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_file_id, from_heading_id);
CREATE INDEX IF NOT EXISTS idx_relations_tag ON relations(tag_id);

CREATE TABLE IF NOT EXISTS issue_metadata (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	status TEXT,
	priority TEXT,
	deadline INTEGER,
	work_minutes INTEGER,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_issue_sort ON issue_metadata(deadline, priority);

CREATE TABLE IF NOT EXISTS project_metadata (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	status TEXT,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS concept_metadata (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	difficulty TEXT,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);
`;

const TYPED_METADATA_TABLES = ['issue_metadata', 'project_metadata', 'concept_metadata'];

/**
 * @param {import('sql.js').Database} db
 * @returns {number}
 */
function getSchemaVersion(db) {
	try {
		const stmt = db.prepare(`SELECT value FROM index_meta WHERE key = 'schema_version'`);
		if (stmt.step()) {
			const row = stmt.get();
			stmt.free();
			return parseInt(String(row && row[0]), 10) || 0;
		}
		stmt.free();
	} catch {
		// fresh db
	}
	return 0;
}

/**
 * @param {import('sql.js').Database} db
 * @param {string} table
 * @param {string} column
 */
function columnExists(db, table, column) {
	const info = db.exec(`PRAGMA table_info(${table})`);
	if (!info.length) return false;
	return info[0].values.some(row => String(row[1] || '') === column);
}

/**
 * @param {import('sql.js').Database} db
 * @param {string} table
 */
function tableExists(db, table) {
	const safe = String(table || '').replace(/'/g, "''");
	const info = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${safe}'`);
	return info.length > 0 && info[0].values.length > 0;
}

/**
 * Legacy v2 relations shape → v3 tag_id relations.
 * @param {import('sql.js').Database} db
 */
function migrateLegacyRelationsTable(db) {
	let recreateRelations = false;
	const info = db.exec('PRAGMA table_info(relations)');
	if (info.length) {
		const cols = new Set(info[0].values.map(row => String(row[1] || '')));
		if (cols.has('to_file_id')) {
			db.run('DROP TABLE relations');
			recreateRelations = true;
		}
	}
	try {
		db.run('DROP INDEX IF EXISTS idx_relations_to');
	} catch {
		// ignore
	}
	if (recreateRelations) {
		db.exec(`
			CREATE TABLE relations (
				from_file_id INTEGER NOT NULL,
				from_heading_id INTEGER NOT NULL,
				relation_type TEXT NOT NULL,
				tag_id INTEGER NOT NULL,
				PRIMARY KEY (from_file_id, from_heading_id, relation_type, tag_id),
				FOREIGN KEY (tag_id) REFERENCES tags(tag_id)
			);
			CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_file_id, from_heading_id);
			CREATE INDEX IF NOT EXISTS idx_relations_tag ON relations(tag_id);
		`);
	}
}

/**
 * Untyped headings use SQL NULL (not a sentinel string).
 * @param {import('sql.js').Database} db
 */
function migrateMetadataTypeNullable(db) {
	if (!tableExists(db, 'headings')) {
		return;
	}
	try {
		db.run(
			`UPDATE headings SET metadata_type = NULL
			 WHERE metadata_type IS NULL
			    OR TRIM(metadata_type) = ''
			    OR LOWER(TRIM(metadata_type)) = 'none'`
		);
	} catch {
		// ignore
	}
}

/**
 * @param {import('sql.js').Database} db
 */
function migrateSchemaIfNeeded(db) {
	migrateLegacyRelationsTable(db);

	const version = getSchemaVersion(db);
	if (version >= SCHEMA_VERSION) {
		return;
	}

	if (version < 6) {
		migrateMetadataTypeNullable(db);
	}

	if (tableExists(db, 'headings') && !columnExists(db, 'headings', 'tab_depth')) {
		db.run('ALTER TABLE headings ADD COLUMN tab_depth INTEGER NOT NULL DEFAULT 0');
	}

	db.exec(SCHEMA_SQL);

	db.run(`INSERT OR REPLACE INTO index_meta(key, value) VALUES ('schema_version', ?)`, [
		String(SCHEMA_VERSION)
	]);
}

/**
 * @param {import('sql.js').Database} db
 */
function seedInitialIndexMeta(db) {
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES ('next_file_id', '0')`);
	db.run(`INSERT OR REPLACE INTO index_meta(key, value) VALUES ('schema_version', ?)`, [
		String(SCHEMA_VERSION)
	]);
}

/**
 * Create or upgrade `index.drip` to {@link SCHEMA_VERSION}.
 * @param {import('sql.js').Database} db
 */
function ensureDripIndexSchema(db) {
	db.exec(SCHEMA_SQL);
	migrateSchemaIfNeeded(db);
	seedInitialIndexMeta(db);
}

module.exports = {
	SCHEMA_VERSION,
	SCHEMA_SQL,
	TYPED_METADATA_TABLES,
	ensureDripIndexSchema,
	seedInitialIndexMeta,
	getSchemaVersion
};
