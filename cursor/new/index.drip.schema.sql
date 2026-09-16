-- DRIP index.drip — SQLite schema v10
-- Docs mirror only — runtime schema: src/indexing/dbSchema/dripIndexSchema.js (via dripIndexDb.js)
-- Spec: cursor/new/features.txt (DB schema §4–7)
--
-- File layout: identity line ABOVE each # heading:
--   @f23:h1 #abcd1234
--   # Section title
--
-- refs (file-level only):
--   ref: [@f26 (optional topic), @f45, @f3]
--
-- index_meta defaults (seeded on init):
--   schema_version → "10"
--   next_file_id   → "0"
--   heading_alloc_<file_id> → per-file non-h0 id pool JSON, e.g. '{"next":4,"free":[2,3]}'
--   workflow_alloc_<file_id>_<workflow_heading_id> → dense per-workflow task id pool (contiguous .t1…tN)
--
-- Lookup tables store each type name once; headings/relations reference ids.
-- Typed tables store hot keys; metadata_remaining_keys stores the rest (EAV).

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

CREATE TABLE IF NOT EXISTS headings (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	title TEXT NOT NULL,
	-- NULL = no .type marker, or marker not in drip.metadataTypes (known ids only are stored)
	metadata_type_id INTEGER,
	hash TEXT,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
	FOREIGN KEY (metadata_type_id) REFERENCES metadata_types(metadata_type_id)
);

CREATE TABLE IF NOT EXISTS heading_references (
	source_file_id INTEGER NOT NULL,
	source_heading_id INTEGER NOT NULL,
	target_file_id INTEGER NOT NULL,
	PRIMARY KEY (source_file_id, source_heading_id, target_file_id)
);

CREATE INDEX IF NOT EXISTS idx_ref_source ON heading_references(source_file_id, source_heading_id);
CREATE INDEX IF NOT EXISTS idx_ref_target ON heading_references(target_file_id);
CREATE INDEX IF NOT EXISTS idx_heading_type ON headings(metadata_type_id);
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
	relation_type_id INTEGER NOT NULL,
	tag_id INTEGER NOT NULL,
	PRIMARY KEY (from_file_id, from_heading_id, relation_type_id, tag_id),
	FOREIGN KEY (relation_type_id) REFERENCES relation_types(relation_type_id),
	FOREIGN KEY (tag_id) REFERENCES tags(tag_id)
);

CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_file_id, from_heading_id);
CREATE INDEX IF NOT EXISTS idx_relations_tag ON relations(tag_id);
CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type_id);

-- Typed metadata (hot keys) + EAV remaining keys — see dripIndexTypedMetadata.js

CREATE TABLE IF NOT EXISTS concept_metadata (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	status TEXT,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_metadata (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	status TEXT,
	deadline INTEGER,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_sort ON project_metadata(deadline);

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
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_issue_sort ON issue_metadata(deadline, priority);

CREATE TABLE IF NOT EXISTS decision_metadata (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	category TEXT,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS metadata_remaining_keys (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	metadata_type_id INTEGER NOT NULL,
	key TEXT NOT NULL,
	value TEXT,
	PRIMARY KEY (file_id, heading_id, metadata_type_id, key),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE,
	FOREIGN KEY (metadata_type_id) REFERENCES metadata_types(metadata_type_id)
);

CREATE INDEX IF NOT EXISTS idx_remaining_keys_heading ON metadata_remaining_keys(file_id, heading_id);
CREATE INDEX IF NOT EXISTS idx_remaining_keys_type_key ON metadata_remaining_keys(metadata_type_id, key);
