-- DRIP index.drip — SQLite schema v14
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
--   schema_version → "14"
--   next_file_id   → "0"
--   next_project_id → "1"
--   heading_alloc_<file_id> → per-file non-h0 id pool JSON, e.g. '{"next":4,"free":[2,3]}'
--   workflow_alloc_<file_id>_<workflow_heading_id> → dense per-workflow task id pool (contiguous .t1…tN)
--   project_entity_alloc_<projectPrefix> → '{"nextIssue":N,"nextFeature":M}' cache (live issues from `issues`)
--   embedding_model / embedding_dimensions / embedding_format_version / embedding_generation
--   next_embedding_id → allocator for heading_embedding_records.embedding_id
--
-- Projects (v14):
--   projects(project_id, folder_prefix, …) — one row per `.p` folder
--   headings.project_id — NULL for note-zone; set under a project (filter Project View cheaply)
--   issues(project_id, issue_key, …, parent_issue_key) — canonical issue store / hierarchy
--   issue_metadata kept as typed hot-keys mirror on ingest
--
-- Lookup tables store each type name once; headings/relations reference ids.
-- Typed tables store hot keys; metadata_remaining_keys stores the rest (EAV).
-- headings.parent = same-file parent heading_id from tab indent at index time (NULL = root).
-- issues.parent_issue_key = logical parent `i-N` (cross-file); distinct from headings.parent.

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
	FOREIGN KEY (index_file_id) REFERENCES files(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_prefix ON projects(folder_prefix);

CREATE TABLE IF NOT EXISTS headings (
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	title TEXT NOT NULL,
	-- NULL = no .type marker, or marker not in drip.metadataTypes (known ids only are stored)
	metadata_type_id INTEGER,
	hash TEXT,
	-- Parent heading_id in the same file (from tab indent). NULL = root.
	parent INTEGER,
	-- NULL = note zone; set when file is under a `.p` project folder.
	project_id INTEGER,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
	FOREIGN KEY (metadata_type_id) REFERENCES metadata_types(metadata_type_id),
	FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_headings_project ON headings(project_id);

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
	parent_issue_key TEXT,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_issue_sort ON issue_metadata(deadline, priority);
CREATE INDEX IF NOT EXISTS idx_issue_parent_key ON issue_metadata(parent_issue_key);

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
	value TEXT NOT NULL,
	PRIMARY KEY (file_id, heading_id, metadata_type_id, key),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE,
	FOREIGN KEY (metadata_type_id) REFERENCES metadata_types(metadata_type_id)
);

CREATE INDEX IF NOT EXISTS idx_remaining_keys_heading ON metadata_remaining_keys(file_id, heading_id);
CREATE INDEX IF NOT EXISTS idx_remaining_keys_type_key ON metadata_remaining_keys(metadata_type_id, key);
CREATE INDEX IF NOT EXISTS idx_remaining_keys_lookup ON metadata_remaining_keys(metadata_type_id, key, value);

-- Embedding id map (no content_hash / updated_at / model_id per row)
CREATE TABLE IF NOT EXISTS heading_embedding_records (
	embedding_id INTEGER PRIMARY KEY,
	file_id INTEGER NOT NULL,
	heading_id INTEGER NOT NULL,
	UNIQUE (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_heading_embedding_file ON heading_embedding_records(file_id);

-- Runtime (sqlite-vec), dimensions from index_meta.embedding_dimensions (default 384):
-- CREATE VIRTUAL TABLE heading_embedding_vectors USING vec0(
--   embedding_id INTEGER PRIMARY KEY,
--   embedding float[384]
-- );
--
-- FAISS ANN sidecar (not SQLite; only when vectorCount > 1000 at KB lock):
--   .dripindex/heading-embeddings.faiss
--   .dripindex/heading-embeddings.faiss.json  (embeddingIds[] label → embedding_id)

-- Folder embeddings (exact sqlite-vec only; same embedding_* model meta):
CREATE TABLE IF NOT EXISTS folder_embedding_records (
	embedding_id INTEGER PRIMARY KEY,
	folder_path TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_folder_embedding_path ON folder_embedding_records(folder_path);
-- Runtime: CREATE VIRTUAL TABLE folder_embedding_vectors USING vec0(...);
-- index_meta.next_folder_embedding_id

-- Tag embeddings (exact sqlite-vec only; used by Retriever tag suggest — no FAISS):
CREATE TABLE IF NOT EXISTS tag_embedding_records (
	embedding_id INTEGER PRIMARY KEY,
	tag_id INTEGER NOT NULL UNIQUE,
	FOREIGN KEY (tag_id) REFERENCES tags(tag_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tag_embedding_tag ON tag_embedding_records(tag_id);
-- Runtime: CREATE VIRTUAL TABLE tag_embedding_vectors USING vec0(...);
-- index_meta.next_tag_embedding_id

