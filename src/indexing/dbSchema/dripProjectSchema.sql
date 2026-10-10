-- =============================================================================
-- DRIP project index schema (SQLite) — reference documentation
-- =============================================================================
-- This file is the human-readable SQLite equivalent of dripProjectSchema.js.
-- It documents the second, project-scoped database file.
--
-- Database file: <kbRoot>/.dripindex/projects.drip
--
-- Scope: everything that belongs to the project/feature/issue hierarchy — projects,
-- features, issues, and project headings — plus the lookup/EAV tables those rows
-- reference. Keeping this in a separate file means project headings never leak into
-- the global document search (which reads `index.drip` only) and are loaded only when
-- the Project View opens.
--
-- Relationship to index.drip:
--   - The shared `files` registry and the `@fN` file-id counter live in `index.drip`.
--   - `projects.drip` only *records* file ids; it never mints them.
--   - Because SQLite FKs cannot cross files, `file_id` columns here are plain integers
--     with no FK into `index.drip.files`.
--
-- NOTE: This file is documentation only. It is NOT executed by the extension.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- index_meta — project-scoped counters.
--   next_project_id, next_feature_id, schema_version
--   project_entity_alloc_<prefix> -> JSON { "nextIssue": N, "nextFeature": M }
-- -----------------------------------------------------------------------------
CREATE TABLE index_meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- Lookup tables (same shape as index.drip, but scoped to this file).
-- -----------------------------------------------------------------------------
CREATE TABLE metadata_types (
	metadata_type_id   INTEGER PRIMARY KEY,
	metadata_type_name TEXT NOT NULL UNIQUE
);

CREATE TABLE relation_types (
	relation_type_id   INTEGER PRIMARY KEY,
	relation_type_name TEXT NOT NULL UNIQUE
);

-- -----------------------------------------------------------------------------
-- projects / features — folder-prefix registries. `index_file_id` points at a file
-- id in index.drip.files (no FK, cross-file).
-- -----------------------------------------------------------------------------
CREATE TABLE projects (
	project_id    INTEGER PRIMARY KEY,
	folder_prefix TEXT NOT NULL UNIQUE,
	index_file_id INTEGER,
	title         TEXT,
	status        TEXT,
	deadline      INTEGER,
	priority      TEXT
);
CREATE INDEX idx_projects_prefix ON projects(folder_prefix);

CREATE TABLE features (
	feature_id    INTEGER PRIMARY KEY,
	folder_prefix TEXT NOT NULL UNIQUE,
	index_file_id INTEGER,
	title         TEXT,
	category      TEXT
);
CREATE INDEX idx_features_prefix ON features(folder_prefix);

-- -----------------------------------------------------------------------------
-- headings — one row per *project* heading (identity = file_id + heading_id).
--   project_id / feature_id = set here (this is the project zone).
-- -----------------------------------------------------------------------------
CREATE TABLE headings (
	file_id         INTEGER NOT NULL,
	heading_id      INTEGER NOT NULL,
	title           TEXT NOT NULL,
	metadata_type_id INTEGER,
	hash            TEXT,
	parent          INTEGER,
	project_id      INTEGER,
	feature_id      INTEGER,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (metadata_type_id) REFERENCES metadata_types(metadata_type_id),
	FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE SET NULL,
	FOREIGN KEY (feature_id) REFERENCES features(feature_id) ON DELETE SET NULL
);
CREATE INDEX idx_headings_project ON headings(project_id);
CREATE INDEX idx_headings_feature ON headings(feature_id);
CREATE INDEX idx_heading_type    ON headings(metadata_type_id);
CREATE INDEX idx_headings_title  ON headings(title);
CREATE INDEX idx_headings_parent ON headings(file_id, parent);

-- -----------------------------------------------------------------------------
-- tags / searchtags / relations — same shape as index.drip.
-- -----------------------------------------------------------------------------
CREATE TABLE tags (
	tag_id   INTEGER PRIMARY KEY,
	tag_name TEXT NOT NULL UNIQUE
);

CREATE TABLE searchtags (
	file_id    INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	tag_id     INTEGER NOT NULL,
	PRIMARY KEY (file_id, heading_id, tag_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE,
	FOREIGN KEY (tag_id) REFERENCES tags(tag_id)
);
CREATE INDEX idx_searchtags_tag ON searchtags(tag_id);

CREATE TABLE relations (
	from_file_id    INTEGER NOT NULL,
	from_heading_id INTEGER NOT NULL,
	relation_type_id INTEGER NOT NULL,
	tag_id          INTEGER NOT NULL,
	PRIMARY KEY (from_file_id, from_heading_id, relation_type_id, tag_id),
	FOREIGN KEY (relation_type_id) REFERENCES relation_types(relation_type_id),
	FOREIGN KEY (tag_id) REFERENCES tags(tag_id)
);
CREATE INDEX idx_relations_from ON relations(from_file_id, from_heading_id);
CREATE INDEX idx_relations_tag  ON relations(tag_id);
CREATE INDEX idx_relations_type ON relations(relation_type_id);

-- -----------------------------------------------------------------------------
-- issue_metadata — fixed columns for an issue heading (hot keys only).
-- -----------------------------------------------------------------------------
CREATE TABLE issue_metadata (
	file_id         INTEGER NOT NULL,
	heading_id      INTEGER NOT NULL,
	status          TEXT,
	category        TEXT,
	deadline        INTEGER,
	priority        TEXT,
	parent_issue_key TEXT,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);
CREATE INDEX idx_issue_sort       ON issue_metadata(deadline, priority);
CREATE INDEX idx_issue_parent_key ON issue_metadata(parent_issue_key);

-- -----------------------------------------------------------------------------
-- issues — canonical Project View issue store.
--   issue_key = i-N (per project); parent_issue_key = logical parent i-N (cross-file)
-- -----------------------------------------------------------------------------
CREATE TABLE issues (
	project_id       INTEGER NOT NULL,
	issue_key        TEXT NOT NULL,
	file_id          INTEGER NOT NULL,
	heading_id       INTEGER NOT NULL,
	title            TEXT,
	parent_issue_key TEXT,
	status           TEXT,
	category         TEXT,
	deadline         INTEGER,
	priority         TEXT,
	PRIMARY KEY (project_id, issue_key),
	UNIQUE (file_id, heading_id),
	FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);
CREATE INDEX idx_issues_project ON issues(project_id);
CREATE INDEX idx_issues_parent  ON issues(project_id, parent_issue_key);
CREATE INDEX idx_issues_sort    ON issues(deadline, priority);

-- -----------------------------------------------------------------------------
-- metadata_remaining_keys — EAV store for non-fixed metadata keys.
-- -----------------------------------------------------------------------------
CREATE TABLE metadata_remaining_keys (
	file_id          INTEGER NOT NULL,
	heading_id       INTEGER NOT NULL,
	metadata_type_id INTEGER NOT NULL,
	key              TEXT NOT NULL,
	value            TEXT NOT NULL,
	PRIMARY KEY (file_id, heading_id, metadata_type_id, key),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE,
	FOREIGN KEY (metadata_type_id) REFERENCES metadata_types(metadata_type_id)
);
CREATE INDEX idx_remaining_keys_heading ON metadata_remaining_keys(file_id, heading_id);
CREATE INDEX idx_remaining_keys_type_key ON metadata_remaining_keys(metadata_type_id, key);
CREATE INDEX idx_remaining_keys_lookup  ON metadata_remaining_keys(metadata_type_id, key, value);
