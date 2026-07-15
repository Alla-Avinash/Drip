-- DRIP index.drip — SQLite schema v6
-- Canonical runtime: cursor/new/dripIndexSchema.js (used by src/indexing/dripIndexDb.js)
-- Spec: cursor/new/features.txt (DB schema §4–7)
--
-- File layout: identity line ABOVE each # heading:
--   @f23:h1 #abcd1234
--   # Section title
--
-- index_meta defaults (seeded on init):
--   schema_version → "6"
--   next_file_id   → "0"
--   heading_alloc_<file_id> → per-file non-h0 id pool JSON, e.g. '{"next":4,"free":[2,3]}'
--   workflow_alloc_<file_id>_<workflow_heading_id> → dense per-workflow task id pool (contiguous .t1…tN)

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
	-- NULL = no .type marker, or marker not in drip.metadataTypes (known ids only are stored)
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

-- Typed metadata (columns align with indexable DRIP metadata types; see dripIndexTypedMetadata.js)

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
