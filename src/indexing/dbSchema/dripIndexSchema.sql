-- =============================================================================
-- DRIP index schema (SQLite) — reference documentation
-- =============================================================================
-- This file is the human-readable SQLite equivalent of dripIndexSchema.js plus
-- the embedding tables created by the *EmbeddingStore modules. It exists so a
-- new developer can see every table and index in one glance.
--
-- The live schema is built at runtime by:
--   - dbSchema/dripIndexSchema.js        (core document-scope tables)
--   - embeddings/headingEmbeddingStore.js
--   - embeddings/folderEmbeddingStore.js
--   - embeddings/tagEmbeddingStore.js
--   - embeddings/fileEmbeddingStore.js
--
-- Database file: <kbRoot>/.dripindex/index.drip  (SQLite, opened via better-sqlite3)
--
-- Scope: this is the *document* index. It holds the shared `files` registry (every
-- KB note, document AND project), document headings (concept/task), tags, relations,
-- and embeddings. Project-scoped data (projects, features, issues, project headings)
-- lives in a second file, `projects.drip` — see dripProjectSchema.sql — so project
-- headings never surface in the global document search.
--
-- NOTE: This file is documentation only. It is NOT executed by the extension.
--       If you change the runtime schema, keep this file in sync.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- index_meta — key/value store for counters, config, and per-file allocators.
-- Seeded keys (see seedInitialIndexMeta / the *EmbeddingStore seeders):
--   schema_version, next_file_id
--   embedding_model, embedding_dimensions, embedding_format_version,
--   embedding_generation, next_embedding_id, next_folder_embedding_id,
--   next_tag_embedding_id
--   heading_alloc_<file_id>  -> JSON { "next": N, "free": [...] }
-- -----------------------------------------------------------------------------
CREATE TABLE index_meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- files — one row per indexed note (id is the sequential @fN number). This is the
-- single, shared registry: project notes keep their `files` row here too.
-- -----------------------------------------------------------------------------
CREATE TABLE files (
	id         INTEGER PRIMARY KEY,
	path       TEXT NOT NULL UNIQUE,
	name       TEXT,
	created_at INTEGER,
	updated_at INTEGER
);

-- -----------------------------------------------------------------------------
-- Lookup tables: names stored once, rows reference ids.
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
-- headings — one row per *document* heading (identity = file_id + heading_id).
--   parent = parent heading_id in the same file (from tab indent); NULL = root
--   Project/feature scoping lives in projects.drip.headings, not here.
-- -----------------------------------------------------------------------------
CREATE TABLE headings (
	file_id         INTEGER NOT NULL,
	heading_id      INTEGER NOT NULL,
	title           TEXT NOT NULL,
	metadata_type_id INTEGER,
	hash            TEXT,
	parent          INTEGER,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
	FOREIGN KEY (metadata_type_id) REFERENCES metadata_types(metadata_type_id)
);
CREATE INDEX idx_heading_type    ON headings(metadata_type_id);
CREATE INDEX idx_headings_title  ON headings(title);
CREATE INDEX idx_headings_parent ON headings(file_id, parent);

-- -----------------------------------------------------------------------------
-- tags / searchtags / relations — tag vocabulary and tag/relation links.
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
-- Typed metadata tables — fixed columns per document metadata type (hot keys only).
-- Extra/custom keys go to metadata_remaining_keys (EAV).
-- -----------------------------------------------------------------------------
CREATE TABLE concept_metadata (
	file_id    INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	domain     TEXT,
	status     TEXT,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE TABLE task_metadata (
	file_id    INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	status     TEXT,
	category   TEXT,
	deadline   INTEGER,
	priority   TEXT,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);
CREATE INDEX idx_task_sort ON task_metadata(deadline, priority);

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

-- =============================================================================
-- Embedding tables — vectors stored as plain Float32 BLOBs, searched in JS (L2).
-- =============================================================================

-- Heading embeddings (headingEmbeddingStore.js)
CREATE TABLE heading_embedding_records (
	embedding_id INTEGER PRIMARY KEY,
	file_id      INTEGER NOT NULL,
	heading_id   INTEGER NOT NULL,
	UNIQUE (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);
CREATE INDEX idx_heading_embedding_file ON heading_embedding_records(file_id);

CREATE TABLE heading_embedding_vectors (
	embedding_id INTEGER PRIMARY KEY,
	embedding    BLOB NOT NULL
);

-- Folder embeddings (folderEmbeddingStore.js)
CREATE TABLE folder_embedding_records (
	embedding_id INTEGER PRIMARY KEY,
	folder_path  TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_folder_embedding_path ON folder_embedding_records(folder_path);

CREATE TABLE folder_embedding_vectors (
	embedding_id INTEGER PRIMARY KEY,
	embedding    BLOB NOT NULL
);

-- Tag embeddings (tagEmbeddingStore.js)
CREATE TABLE tag_embedding_records (
	embedding_id INTEGER PRIMARY KEY,
	tag_id       INTEGER NOT NULL UNIQUE,
	FOREIGN KEY (tag_id) REFERENCES tags(tag_id) ON DELETE CASCADE
);
CREATE INDEX idx_tag_embedding_tag ON tag_embedding_records(tag_id);

CREATE TABLE tag_embedding_vectors (
	embedding_id INTEGER PRIMARY KEY,
	embedding    BLOB NOT NULL
);

-- File embeddings (fileEmbeddingStore.js)
CREATE TABLE file_embedding_records (
	embedding_id INTEGER PRIMARY KEY AUTOINCREMENT,
	file_path    TEXT NOT NULL UNIQUE
);

CREATE TABLE file_embedding_vectors (
	embedding_id INTEGER PRIMARY KEY,
	embedding    BLOB NOT NULL
);
