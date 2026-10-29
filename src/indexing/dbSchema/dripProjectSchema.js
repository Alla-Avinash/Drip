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
 * - issue ids (`i-N`) are derived live from `issue_metadata` rows (see projectIndex.js)
 * - concept (`c-N`) and decision (`d-N`) ids are per-project integers minted from
 *   the project's entity alloc counter (same pattern as issue numbering)
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

-- The single canonical issue store. Keyed by location (file_id, heading_id) for the
-- generic typed-metadata write path, with a per-project unique entity key for the
-- Project View and link tables. issue_key = i-N; parent_issue_key = logical parent i-N.
CREATE TABLE IF NOT EXISTS issue_metadata (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	issue_key TEXT,
	project_id INTEGER,
	feature_id INTEGER,
	status TEXT,
	category TEXT,
	deadline INTEGER,
	priority TEXT,
	parent_issue_key TEXT,
	PRIMARY KEY (file_id, heading_id),
	UNIQUE (project_id, issue_key),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE,
	FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
	FOREIGN KEY (feature_id) REFERENCES features(feature_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_issue_sort ON issue_metadata(deadline, priority);
CREATE INDEX IF NOT EXISTS idx_issue_parent_key ON issue_metadata(parent_issue_key);
CREATE INDEX IF NOT EXISTS idx_issue_project ON issue_metadata(project_id);

-- Issue → team assignment. Keyed by the issue number (issue_key = i-N) instead of
-- the issue's file/heading location, so a project's teams live in one clean,
-- separable table. Deleting a project's rows (e.g. on convert-to-solo) leaves no
-- team data behind in the generic EAV store. "team" is the team name, matching
-- project.json teams[].name.
CREATE TABLE IF NOT EXISTS issue_teams (
	project_id INTEGER NOT NULL,
	issue_key TEXT NOT NULL,
	team TEXT NOT NULL,
	PRIMARY KEY (project_id, issue_key),
	FOREIGN KEY (project_id, issue_key) REFERENCES issue_metadata(project_id, issue_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_issue_teams_team ON issue_teams(team);

-- Canonical Project View concept store. concept_key = c-N's number (per project,
-- integer starting at 1). Concepts live in the project's _concepts folder, outside
-- any feature, so there is no feature_id column here.
CREATE TABLE IF NOT EXISTS concepts (
	project_id INTEGER NOT NULL,
	concept_key INTEGER NOT NULL,
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	title TEXT,
	status TEXT,
	domain TEXT,
	PRIMARY KEY (project_id, concept_key),
	UNIQUE (file_id, heading_id),
	FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_concepts_project ON concepts(project_id);

-- Canonical Project View decision store. decision_key = d-N's number (per project,
-- integer starting at 1). superseded_by = another d-N number; concept_key = a c-N number.
CREATE TABLE IF NOT EXISTS decisions (
	project_id INTEGER NOT NULL,
	decision_key INTEGER NOT NULL,
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	title TEXT,
	status TEXT,
	category TEXT,
	superseded_by INTEGER,
	concept_key INTEGER,
	PRIMARY KEY (project_id, decision_key),
	UNIQUE (file_id, heading_id),
	FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id);

-- Issue ↔ concept links (list, like tags). One issue can connect to many concepts.
CREATE TABLE IF NOT EXISTS issue_concept_links (
	project_id INTEGER NOT NULL,
	issue_key TEXT NOT NULL,
	concept_key INTEGER NOT NULL,
	PRIMARY KEY (project_id, issue_key, concept_key),
	FOREIGN KEY (project_id, issue_key) REFERENCES issue_metadata(project_id, issue_key) ON DELETE CASCADE,
	FOREIGN KEY (project_id, concept_key) REFERENCES concepts(project_id, concept_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_issue_concept_links_concept ON issue_concept_links(project_id, concept_key);

-- Issue ↔ decision links (list, like tags). One issue can connect to many decisions.
CREATE TABLE IF NOT EXISTS issue_decision_links (
	project_id INTEGER NOT NULL,
	issue_key TEXT NOT NULL,
	decision_key INTEGER NOT NULL,
	PRIMARY KEY (project_id, issue_key, decision_key),
	FOREIGN KEY (project_id, issue_key) REFERENCES issue_metadata(project_id, issue_key) ON DELETE CASCADE,
	FOREIGN KEY (project_id, decision_key) REFERENCES decisions(project_id, decision_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_issue_decision_links_decision ON issue_decision_links(project_id, decision_key);

-- Decision ↔ concept links (list, like tags). One decision can connect to many concepts.
CREATE TABLE IF NOT EXISTS decision_concept_links (
	project_id INTEGER NOT NULL,
	decision_key INTEGER NOT NULL,
	concept_key INTEGER NOT NULL,
	PRIMARY KEY (project_id, decision_key, concept_key),
	FOREIGN KEY (project_id, decision_key) REFERENCES decisions(project_id, decision_key) ON DELETE CASCADE,
	FOREIGN KEY (project_id, concept_key) REFERENCES concepts(project_id, concept_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_decision_concept_links_concept ON decision_concept_links(project_id, concept_key);

-- Typed metadata for concept headings (c-N) living in project _concepts folders.
CREATE TABLE IF NOT EXISTS concept_metadata (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	concept_key INTEGER,
	status TEXT,
	domain TEXT,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_concept_key ON concept_metadata(concept_key);

-- Typed metadata for decision headings (d-N) living in project _decisions folders.
CREATE TABLE IF NOT EXISTS decision_metadata (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	decision_key INTEGER,
	status TEXT,
	category TEXT,
	superseded_by INTEGER,
	concept_key INTEGER,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_decision_key ON decision_metadata(decision_key);
CREATE INDEX IF NOT EXISTS idx_decision_superseded ON decision_metadata(superseded_by);

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
const TYPED_METADATA_TABLES = ['issue_metadata', 'concept_metadata', 'decision_metadata'];

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
