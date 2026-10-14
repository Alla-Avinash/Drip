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
-- issue_metadata — the single canonical issue store. Keyed by location
-- (file_id, heading_id) for the generic typed-metadata write path, with a
-- per-project unique entity key for the Project View + link tables.
--   issue_key = the issue's own i-N; parent_issue_key = logical parent i-N (cross-file)
-- -----------------------------------------------------------------------------
CREATE TABLE issue_metadata (
	file_id          INTEGER NOT NULL,
	heading_id       INTEGER NOT NULL,
	issue_key        TEXT,
	project_id       INTEGER,
	feature_id       INTEGER,
	status           TEXT,
	category         TEXT,
	deadline         INTEGER,
	priority         TEXT,
	parent_issue_key TEXT,
	PRIMARY KEY (file_id, heading_id),
	UNIQUE (project_id, issue_key),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE,
	FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
	FOREIGN KEY (feature_id) REFERENCES features(feature_id) ON DELETE SET NULL
);
CREATE INDEX idx_issue_sort       ON issue_metadata(deadline, priority);
CREATE INDEX idx_issue_parent_key ON issue_metadata(parent_issue_key);
CREATE INDEX idx_issue_project    ON issue_metadata(project_id);

-- -----------------------------------------------------------------------------
-- concept_metadata — fixed columns for a concept heading (c-N) in a project
-- _concepts folder. concept_key = c-N's integer number.
-- -----------------------------------------------------------------------------
CREATE TABLE concept_metadata (
	file_id     INTEGER NOT NULL,
	heading_id  INTEGER NOT NULL,
	concept_key INTEGER,
	status      TEXT,
	domain      TEXT,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);
CREATE INDEX idx_concept_key ON concept_metadata(concept_key);

-- -----------------------------------------------------------------------------
-- decision_metadata — fixed columns for a decision heading (d-N) in a project
-- _decisions folder. `superseded_by` = another d-N number, `concept_key` = c-N number.
-- -----------------------------------------------------------------------------
CREATE TABLE decision_metadata (
	file_id       INTEGER NOT NULL,
	heading_id    INTEGER NOT NULL,
	decision_key  INTEGER,
	status        TEXT,
	category      TEXT,
	superseded_by INTEGER,
	concept_key   INTEGER,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);
CREATE INDEX idx_decision_key       ON decision_metadata(decision_key);
CREATE INDEX idx_decision_superseded ON decision_metadata(superseded_by);

-- -----------------------------------------------------------------------------
-- concepts — canonical Project View concept store (c-N number per project).
-- Concepts live in _concepts, outside any feature → no feature_id column.
-- -----------------------------------------------------------------------------
CREATE TABLE concepts (
	project_id  INTEGER NOT NULL,
	concept_key INTEGER NOT NULL,
	file_id     INTEGER NOT NULL,
	heading_id  INTEGER NOT NULL,
	title       TEXT,
	status      TEXT,
	domain      TEXT,
	PRIMARY KEY (project_id, concept_key),
	UNIQUE (file_id, heading_id),
	FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);
CREATE INDEX idx_concepts_project ON concepts(project_id);

-- -----------------------------------------------------------------------------
-- decisions — canonical Project View decision store (d-N number per project).
-- superseded_by = another d-N number; concept_key = the c-N number this decision
-- is about.
-- -----------------------------------------------------------------------------
CREATE TABLE decisions (
	project_id    INTEGER NOT NULL,
	decision_key  INTEGER NOT NULL,
	file_id       INTEGER NOT NULL,
	heading_id    INTEGER NOT NULL,
	title         TEXT,
	status        TEXT,
	category      TEXT,
	superseded_by INTEGER,
	concept_key   INTEGER,
	PRIMARY KEY (project_id, decision_key),
	UNIQUE (file_id, heading_id),
	FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);
CREATE INDEX idx_decisions_project ON decisions(project_id);

-- -----------------------------------------------------------------------------
-- issue_concept_links / issue_decision_links — many-to-many "list" links (like
-- tags): one issue can connect to many concepts / decisions.
-- -----------------------------------------------------------------------------
CREATE TABLE issue_concept_links (
	project_id  INTEGER NOT NULL,
	issue_key   TEXT NOT NULL,
	concept_key INTEGER NOT NULL,
	PRIMARY KEY (project_id, issue_key, concept_key),
	FOREIGN KEY (project_id, issue_key)   REFERENCES issue_metadata(project_id, issue_key) ON DELETE CASCADE,
	FOREIGN KEY (project_id, concept_key) REFERENCES concepts(project_id, concept_key) ON DELETE CASCADE
);
CREATE INDEX idx_issue_concept_links_concept ON issue_concept_links(project_id, concept_key);

CREATE TABLE issue_decision_links (
	project_id   INTEGER NOT NULL,
	issue_key    TEXT NOT NULL,
	decision_key INTEGER NOT NULL,
	PRIMARY KEY (project_id, issue_key, decision_key),
	FOREIGN KEY (project_id, issue_key)    REFERENCES issue_metadata(project_id, issue_key) ON DELETE CASCADE,
	FOREIGN KEY (project_id, decision_key) REFERENCES decisions(project_id, decision_key) ON DELETE CASCADE
);
CREATE INDEX idx_issue_decision_links_decision ON issue_decision_links(project_id, decision_key);

-- -----------------------------------------------------------------------------
-- decision_concept_links — many-to-many "list" links (like tags): one decision
-- can connect to many concepts.
-- -----------------------------------------------------------------------------
CREATE TABLE decision_concept_links (
	project_id   INTEGER NOT NULL,
	decision_key INTEGER NOT NULL,
	concept_key  INTEGER NOT NULL,
	PRIMARY KEY (project_id, decision_key, concept_key),
	FOREIGN KEY (project_id, decision_key) REFERENCES decisions(project_id, decision_key) ON DELETE CASCADE,
	FOREIGN KEY (project_id, concept_key)  REFERENCES concepts(project_id, concept_key) ON DELETE CASCADE
);
CREATE INDEX idx_decision_concept_links_concept ON decision_concept_links(project_id, concept_key);

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
