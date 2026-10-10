'use strict';

/**
 * Static SQLite schema for `<kb>/.dripindex/projects.drip` — the project-scoped index.
 *
 * This is a second SQLite file, separate from `index.drip`. It holds everything that
 * belongs to the project/feature/issue hierarchy so project headings never leak into
 * the global document-KB search. `index.drip` keeps document headings (concept/task),
 * the shared `files` registry, tags, relations, and embeddings.
 *
 * The two databases share one file-id sequence: `@fN` ids are minted by `index.drip`
 * (`index_meta.next_file_id`); `projects.drip` only *records* file ids, it never mints
 * them. Because SQLite foreign keys cannot cross database files, `projects.drip` tables
 * reference `file_id` as a plain integer with no FK into `index.drip.files`.
 *
 * Project entity alloc is local to this file:
 * - `index_meta.next_project_id` / `next_feature_id` seed the project/feature ids
 * - issue ids (`i-N`) are derived live from `issues` rows (see projectIndex.js)
 */

const PROJECTS_SCHEMA_VERSION = 1;

/** @type {string} */
const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS index_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
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
	priority TEXT
);

CREATE INDEX IF NOT EXISTS idx_projects_prefix ON projects(folder_prefix);

CREATE TABLE IF NOT EXISTS features (
	feature_id INTEGER PRIMARY KEY,
	folder_prefix TEXT NOT NULL UNIQUE,
	index_file_id INTEGER,
	title TEXT,
	category TEXT
);

CREATE INDEX IF NOT EXISTS idx_features_prefix ON features(folder_prefix);

CREATE TABLE IF NOT EXISTS headings (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	title TEXT NOT NULL,
	metadata_type_id INTEGER,
	hash TEXT,
	parent INTEGER,
	project_id INTEGER,
	feature_id INTEGER,
	PRIMARY KEY (file_id, heading_id),
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
`;

/** Typed metadata tables owned by the project zone. */
const TYPED_METADATA_TABLES = ['issue_metadata'];

const REMAINING_METADATA_TABLE = 'metadata_remaining_keys';

/**
 * Seed `index_meta` counters for a fresh project index. Idempotent.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function seedProjectIndexMeta(db) {
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES ('next_project_id', '1')`);
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES ('next_feature_id', '1')`);
	db.run(`INSERT OR REPLACE INTO index_meta(key, value) VALUES ('schema_version', ?)`, [
		String(PROJECTS_SCHEMA_VERSION)
	]);
}

/**
 * Create the project-scoped schema. Idempotent via `CREATE … IF NOT EXISTS`.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function ensureDripProjectSchema(db) {
	db.exec(SCHEMA_SQL);
	seedProjectIndexMeta(db);
}

module.exports = {
	PROJECTS_SCHEMA_VERSION,
	SCHEMA_SQL,
	TYPED_METADATA_TABLES,
	REMAINING_METADATA_TABLE,
	ensureDripProjectSchema
};
