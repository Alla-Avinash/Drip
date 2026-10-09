'use strict';

/**
 * Static SQLite schema for `<kb>/.dripindex/index.drip` (schema v16).
 *
 * Heading identity in `.d.txt` files: `@fN:hM #hash` on the line **above** `# title` (not below).
 * Per-file heading id allocator: `index_meta.heading_alloc_<file_id>` → JSON `{ "next": N, "free": […] }`.
 *
 * Defaults (application-enforced; see `headings.metadata_type_id`):
 * - `headings.metadata_type_id` → SQL NULL when the note has no `.type` marker or an unknown type
 * - `index_meta.schema_version` → `16`
 * - `index_meta.next_file_id` → `0`
 * - `index_meta.next_project_id` → `1`
 * - `index_meta.next_feature_id` → `1`
 * - `index_meta.embedding_*` → model/dims/format/generation (see headingEmbeddingStore.js)
 *
 * Lookup tables (name stored once; rows reference ids):
 * - `metadata_types(metadata_type_id, metadata_type_name)`
 * - `relation_types(relation_type_id, relation_type_name)`
 *
 * Typed metadata (hot keys only) + `metadata_remaining_keys` EAV for the rest.
 * `headings.parent` = parent `heading_id` in the same file (from tab indent); NULL = root.
 * `projects` registry + `headings.project_id` (NULL = note zone) + `issues` (issue_key / parent_issue_key).
 * `features` registry (folder_prefix, title, category) + `headings.feature_id`.
 * Issue logical parent: `issues.parent_issue_key` = `i-N` (cross-file); distinct from `headings.parent`.
 * Project entity alloc: `index_meta` key `project_entity_alloc_<prefix>` → `{"nextIssue":N,"nextFeature":M}` (cache; live from `issues`).
 * Heading embeddings: `heading_embedding_records` + `heading_embedding_vectors` (plain BLOB table).
 * Folder embeddings: `folder_embedding_records` + `folder_embedding_vectors` (plain BLOB table).
 */

const { ensureHeadingEmbeddingStorage } = require('../embeddings/headingEmbeddingStore');
const { ensureFolderEmbeddingStorage } = require('../embeddings/folderEmbeddingStore');
const { ensureTagEmbeddingStorage } = require('../embeddings/tagEmbeddingStore');

const SCHEMA_VERSION = 16;

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

CREATE TABLE IF NOT EXISTS metadata_types (
	metadata_type_id INTEGER PRIMARY KEY,
	metadata_type_name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS relation_types (
	relation_type_id INTEGER PRIMARY KEY,
	relation_type_name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS projects (
	project_id INTEGER PRIMARY KEY,
	folder_prefix TEXT NOT NULL UNIQUE,
	index_file_id INTEGER,
	title TEXT,
	status TEXT,
	deadline INTEGER,
	priority TEXT,
	FOREIGN KEY (index_file_id) REFERENCES files(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_prefix ON projects(folder_prefix);

CREATE TABLE IF NOT EXISTS features (
	feature_id INTEGER PRIMARY KEY,
	folder_prefix TEXT NOT NULL UNIQUE,
	index_file_id INTEGER,
	title TEXT,
	category TEXT,
	FOREIGN KEY (index_file_id) REFERENCES files(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_features_prefix ON features(folder_prefix);

CREATE TABLE IF NOT EXISTS headings (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	title TEXT NOT NULL,
	metadata_type_id INTEGER,
	hash TEXT,
	-- Parent heading_id in the same file (from tab indent at index time). NULL = root.
	parent INTEGER,
	-- NULL = note zone (concept/task); set when file lives under a .p project folder.
	project_id INTEGER,
	-- Set when the heading belongs to a .f feature folder.
	feature_id INTEGER,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
	FOREIGN KEY (metadata_type_id) REFERENCES metadata_types(metadata_type_id),
	FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE SET NULL,
	FOREIGN KEY (feature_id) REFERENCES features(feature_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_headings_project ON headings(project_id);
CREATE INDEX IF NOT EXISTS idx_headings_feature ON headings(feature_id);

CREATE INDEX IF NOT EXISTS idx_heading_type ON headings(metadata_type_id);
CREATE INDEX IF NOT EXISTS idx_headings_title ON headings(title);
CREATE INDEX IF NOT EXISTS idx_headings_parent ON headings(file_id, parent);

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
	relation_type_id INTEGER NOT NULL,
	tag_id INTEGER NOT NULL,
	PRIMARY KEY (from_file_id, from_heading_id, relation_type_id, tag_id),
	FOREIGN KEY (relation_type_id) REFERENCES relation_types(relation_type_id),
	FOREIGN KEY (tag_id) REFERENCES tags(tag_id)
);

CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_file_id, from_heading_id);
CREATE INDEX IF NOT EXISTS idx_relations_tag ON relations(tag_id);
CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type_id);

CREATE TABLE IF NOT EXISTS concept_metadata (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	domain TEXT,
	status TEXT,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_metadata (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	status TEXT,
	category TEXT,
	deadline INTEGER,
	priority TEXT,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_sort ON task_metadata(deadline, priority);

CREATE TABLE IF NOT EXISTS issue_metadata (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	status TEXT,
	category TEXT,
	deadline INTEGER,
	priority TEXT,
	parent_issue_key TEXT,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_issue_sort ON issue_metadata(deadline, priority);
CREATE INDEX IF NOT EXISTS idx_issue_parent_key ON issue_metadata(parent_issue_key);

-- Canonical Project View issue store. issue_key = i-N; parent_issue_key = logical parent.
CREATE TABLE IF NOT EXISTS issues (
	project_id INTEGER NOT NULL,
	issue_key TEXT NOT NULL,
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	title TEXT,
	parent_issue_key TEXT,
	status TEXT,
	category TEXT,
	deadline INTEGER,
	priority TEXT,
	PRIMARY KEY (project_id, issue_key),
	UNIQUE (file_id, heading_id),
	FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(project_id, parent_issue_key);
CREATE INDEX IF NOT EXISTS idx_issues_sort ON issues(deadline, priority);

CREATE TABLE IF NOT EXISTS metadata_remaining_keys (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	metadata_type_id INTEGER NOT NULL,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	PRIMARY KEY (file_id, heading_id, metadata_type_id, key),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE,
	FOREIGN KEY (metadata_type_id) REFERENCES metadata_types(metadata_type_id)
);

CREATE INDEX IF NOT EXISTS idx_remaining_keys_heading ON metadata_remaining_keys(file_id, heading_id);
CREATE INDEX IF NOT EXISTS idx_remaining_keys_type_key ON metadata_remaining_keys(metadata_type_id, key);
CREATE INDEX IF NOT EXISTS idx_remaining_keys_lookup ON metadata_remaining_keys(metadata_type_id, key, value);

-- Embedding id map (vectors live in a plain BLOB table — see ensureHeadingEmbeddingStorage)
CREATE TABLE IF NOT EXISTS heading_embedding_records (
	embedding_id INTEGER PRIMARY KEY,
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	UNIQUE (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_heading_embedding_file ON heading_embedding_records(file_id);
`;

const TYPED_METADATA_TABLES = [
	'concept_metadata',
	'task_metadata',
	'issue_metadata'
];

const REMAINING_METADATA_TABLE = 'metadata_remaining_keys';

/**
 * Seed `index_meta` counters for a fresh index. Idempotent: existing counters are preserved.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function seedInitialIndexMeta(db) {
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES ('next_file_id', '0')`);
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES ('next_project_id', '1')`);
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES ('next_feature_id', '1')`);
	db.run(`INSERT OR REPLACE INTO index_meta(key, value) VALUES ('schema_version', ?)`, [
		String(SCHEMA_VERSION)
	]);
}

/**
 * v15 → v16 additive columns. `CREATE TABLE IF NOT EXISTS` never adds columns to an
 * existing table, so an index built before these columns existed would otherwise fail
 * every heading / concept insert (and the `idx_headings_feature` index below).
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function migrateFeatureColumns(db) {
	/**
	 * @param {string} table
	 * @param {string} column
	 * @param {string} ddl e.g. `feature_id INTEGER`
	 */
	const addColumnIfMissing = (table, column, ddl) => {
		let info;
		try {
			info = db.native.pragma(`table_info(${table})`);
		} catch {
			return;
		}
		if (!Array.isArray(info) || !info.length) return; // table missing — SCHEMA_SQL creates it fresh
		if (info.some(row => String(row && row.name) === column)) return;
		db.native.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
	};
	addColumnIfMissing('headings', 'feature_id', 'feature_id INTEGER');
	addColumnIfMissing('concept_metadata', 'domain', 'domain TEXT');
}

/**
 * Create the static schema in `index.drip`. Everything is `CREATE … IF NOT EXISTS`,
 * so this is safe to run on every open (fresh DBs get the full schema, existing DBs keep their rows).
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function ensureDripIndexSchema(db) {
	migrateFeatureColumns(db);
	db.exec(SCHEMA_SQL);
	seedInitialIndexMeta(db);
	ensureHeadingEmbeddingStorage(db);
	ensureFolderEmbeddingStorage(db);
	ensureTagEmbeddingStorage(db);
}

module.exports = {
	SCHEMA_VERSION,
	SCHEMA_SQL,
	TYPED_METADATA_TABLES,
	REMAINING_METADATA_TABLE,
	ensureDripIndexSchema
};
