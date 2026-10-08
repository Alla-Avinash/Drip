'use strict';

/**
 * Runtime SQLite schema for `<kb>/.dripindex/index.drip` (spec: cursor/new/features.txt §4–7).
 * Human-readable mirror (docs only): cursor/new/index.drip.schema.sql
 *
 * Heading identity in `.d.txt` files: `@fN:hM #hash` on the line **above** `# title` (not below).
 * Per-file heading id allocator: `index_meta.heading_alloc_<file_id>` → JSON `{ "next": N, "free": […] }`.
 *
 * Defaults (application-enforced; see `headings.metadata_type_id`):
 * - `headings.metadata_type_id` → SQL NULL when the note has no `.type` marker or an unknown type
 * - `index_meta.schema_version` → `15`
 * - `index_meta.next_file_id` → `0`
 * - `index_meta.next_project_id` → `1`
 * - `index_meta.embedding_*` → model/dims/format/generation (see headingEmbeddingStore.js)
 *
 * Lookup tables (name stored once; rows reference ids):
 * - `metadata_types(metadata_type_id, metadata_type_name)`
 * - `relation_types(relation_type_id, relation_type_name)`
 *
 * Typed metadata (hot keys only) + `metadata_remaining_keys` EAV for the rest.
 * Heading hierarchy (v12): `headings.parent` = parent `heading_id` in the same file (from tab indent); NULL = root.
 * Projects (v14): `projects` registry + `headings.project_id` (NULL = note zone) + `issues` (issue_key / parent_issue_key).
 * Issue logical parent: `issues.parent_issue_key` = `i-N` (cross-file); distinct from `headings.parent`.
 * Project entity alloc: `index_meta` key `project_entity_alloc_<prefix>` → `{"nextIssue":N,"nextFeature":M}` (cache; live from `issues`).
 * Heading embeddings (v11): `heading_embedding_records` + sqlite-vec `heading_embedding_vectors`.
 * Folder embeddings (v11 additive): `folder_embedding_records` + `folder_embedding_vectors` (exact only).
 */

const { ensureHeadingEmbeddingStorage } = require('../embeddings/headingEmbeddingStore');
const { ensureFolderEmbeddingStorage } = require('../embeddings/folderEmbeddingStore');
const { ensureTagEmbeddingStorage } = require('../embeddings/tagEmbeddingStore');

const SCHEMA_VERSION = 15;

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
	priority TEXT,
	PRIMARY KEY (file_id, heading_id),
	FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_sort ON project_metadata(deadline, priority);

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

-- Canonical Project View issue store (v14). issue_key = i-N; parent_issue_key = logical parent.
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

-- Embedding id map (vectors live in sqlite-vec virtual table — see ensureHeadingEmbeddingStorage)
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
	'project_metadata',
	'task_metadata',
	'issue_metadata',
	'decision_metadata'
];

const REMAINING_METADATA_TABLE = 'metadata_remaining_keys';

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
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
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {string} table
 * @param {string} column
 */
function columnExists(db, table, column) {
	const info = db.exec(`PRAGMA table_info(${table})`);
	if (!info.length) return false;
	return info[0].values.some(row => String(row[1] || '') === column);
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {string} table
 * @param {string} column
 */
function columnIsNotNull(db, table, column) {
	const info = db.exec(`PRAGMA table_info(${table})`);
	if (!info.length) return false;
	const row = info[0].values.find(value => String(value[1] || '') === column);
	return !!row && Number(row[3]) === 1;
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {string} table
 */
function tableExists(db, table) {
	const safe = String(table || '').replace(/'/g, "''");
	const info = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${safe}'`);
	return info.length > 0 && info[0].values.length > 0;
}

/**
 * Legacy v2 relations shape → v3 tag_id relations.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
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
			CREATE TABLE IF NOT EXISTS relation_types (
				relation_type_id INTEGER PRIMARY KEY,
				relation_type_name TEXT NOT NULL UNIQUE
			);
			CREATE TABLE relations (
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
		`);
	}
}

/**
 * Untyped headings use SQL NULL (not a sentinel string).
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
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
 * v7 stripped an older parent_id column. v12 reintroduces `parent` from indent parse.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function migrateHeadingsWithoutHierarchy(db) {
	if (!tableExists(db, 'headings') || !columnExists(db, 'headings', 'parent_id')) {
		return;
	}
	db.exec(`
		PRAGMA foreign_keys = OFF;
		DROP INDEX IF EXISTS idx_parent;
		DROP TABLE IF EXISTS headings_v7;
		CREATE TABLE headings_v7 (
			file_id INTEGER NOT NULL,
			heading_id INTEGER NOT NULL,
			title TEXT NOT NULL,
			metadata_type TEXT,
			hash TEXT,
			PRIMARY KEY (file_id, heading_id),
			FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
		);
		INSERT INTO headings_v7 (file_id, heading_id, title, metadata_type, hash)
			SELECT file_id, heading_id, title, metadata_type, hash FROM headings;
		DROP TABLE headings;
		ALTER TABLE headings_v7 RENAME TO headings;
		CREATE INDEX IF NOT EXISTS idx_heading_type ON headings(metadata_type);
		CREATE INDEX IF NOT EXISTS idx_headings_title ON headings(title);
		PRAGMA foreign_keys = ON;
	`);
}

/**
 * v12: store document hierarchy as `headings.parent` (same-file parent heading_id).
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function migrateHeadingsAddParent(db) {
	if (!tableExists(db, 'headings')) return;
	if (!columnExists(db, 'headings', 'parent')) {
		db.exec(`ALTER TABLE headings ADD COLUMN parent INTEGER`);
	}
	db.exec(`CREATE INDEX IF NOT EXISTS idx_headings_parent ON headings(file_id, parent)`);
}

/**
 * v13: logical issue parent `parent: i-N` → `issue_metadata.parent_issue_key`.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function migrateIssueMetadataParentKey(db) {
	if (!tableExists(db, 'issue_metadata')) return;
	if (!columnExists(db, 'issue_metadata', 'parent_issue_key')) {
		db.exec(`ALTER TABLE issue_metadata ADD COLUMN parent_issue_key TEXT`);
	}
	db.exec(`CREATE INDEX IF NOT EXISTS idx_issue_parent_key ON issue_metadata(parent_issue_key)`);
}

/**
 * v14: projects registry, headings.project_id, issues table; backfill from paths + issue_metadata.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function migrateProjectsV14(db) {
	if (!tableExists(db, 'files')) return;

	db.exec(`
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
	`);

	if (tableExists(db, 'headings') && !columnExists(db, 'headings', 'project_id')) {
		db.exec(`ALTER TABLE headings ADD COLUMN project_id INTEGER REFERENCES projects(project_id)`);
	}
	db.exec(`CREATE INDEX IF NOT EXISTS idx_headings_project ON headings(project_id)`);

	db.exec(`
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
	`);

	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES ('next_project_id', '1')`);

	// Backfill projects + headings.project_id + issues from existing rows (native API).
	if (!db.native) return;
	const {
		projectFolderPrefixFromPath,
		ensureProjectRow,
		issueKeyFromHeadingTitle
	} = require('../projectIndex');

	const fileRows = db.native.prepare(`SELECT id AS fileId, path AS path FROM files`).all();
	/** @type {Map<string, number>} */
	const prefixToId = new Map();
	for (const r of fileRows || []) {
		const filePath = String(r.path || '').replace(/\\/g, '/');
		const prefix = projectFolderPrefixFromPath(filePath);
		if (!prefix) continue;
		let projectId = prefixToId.get(prefix);
		if (projectId == null) {
			projectId = ensureProjectRow(db, prefix, {
				fileId: Number(r.fileId),
				filePath
			});
			if (projectId != null) prefixToId.set(prefix, projectId);
		}
		if (projectId == null) continue;
		db.native
			.prepare(`UPDATE headings SET project_id = ? WHERE file_id = ? AND project_id IS NULL`)
			.run(projectId, Number(r.fileId));
	}

	if (!tableExists(db, 'issue_metadata')) return;
	const issueRows = db.native
		.prepare(
			`SELECT h.file_id AS fileId, h.heading_id AS headingId, h.title AS title, h.project_id AS projectId,
			        im.status AS status, im.category AS category, im.deadline AS deadline,
			        im.priority AS priority, im.parent_issue_key AS parentIssueKey
			 FROM headings h
			 JOIN issue_metadata im
			   ON im.file_id = h.file_id AND im.heading_id = h.heading_id
			 WHERE h.project_id IS NOT NULL`
		)
		.all();
	const insert = db.native.prepare(
		`INSERT OR REPLACE INTO issues (
			project_id, issue_key, file_id, heading_id, title,
			parent_issue_key, status, category, deadline, priority
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	for (const r of issueRows || []) {
		const projectId = Number(r.projectId);
		const issueKey = issueKeyFromHeadingTitle(r.title);
		if (!Number.isFinite(projectId) || !issueKey) continue;
		insert.run(
			projectId,
			issueKey,
			Number(r.fileId),
			Number(r.headingId),
			String(r.title || issueKey),
			r.parentIssueKey != null ? String(r.parentIssueKey) : null,
			r.status != null ? String(r.status) : null,
			r.category != null ? String(r.category) : null,
			r.deadline != null && Number.isFinite(Number(r.deadline)) ? Number(r.deadline) : null,
			r.priority != null ? String(r.priority) : null
		);
	}
}

/**
 * v15: add `priority` to `projects` and `project_metadata` (project-level priority).
 * Project priority was declared in the `.project` template but never persisted.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function migrateProjectPriorityV15(db) {
	if (tableExists(db, 'projects') && !columnExists(db, 'projects', 'priority')) {
		db.exec(`ALTER TABLE projects ADD COLUMN priority TEXT`);
	}
	if (tableExists(db, 'project_metadata') && !columnExists(db, 'project_metadata', 'priority')) {
		db.exec(`ALTER TABLE project_metadata ADD COLUMN priority TEXT`);
	}
	db.exec(`DROP INDEX IF EXISTS idx_project_sort`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_project_sort ON project_metadata(deadline, priority)`);
}

/**
 * Drop `target_heading_id` from heading_references (refs are file-level `@fN` only).
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function migrateHeadingReferencesFileOnly(db) {
	const info = db.exec(`PRAGMA table_info(heading_references)`);
	if (!info.length || !info[0].values) {
		return;
	}
	const cols = info[0].values.map(row => String(row[1] || '').toLowerCase());
	if (!cols.includes('target_heading_id')) {
		return;
	}

	db.exec(`
		PRAGMA foreign_keys = OFF;
		CREATE TABLE heading_references_v8 (
			source_file_id INTEGER NOT NULL,
			source_heading_id INTEGER NOT NULL,
			target_file_id INTEGER NOT NULL,
			PRIMARY KEY (source_file_id, source_heading_id, target_file_id)
		);
		INSERT OR IGNORE INTO heading_references_v8 (source_file_id, source_heading_id, target_file_id)
			SELECT source_file_id, source_heading_id, target_file_id FROM heading_references;
		DROP TABLE heading_references;
		ALTER TABLE heading_references_v8 RENAME TO heading_references;
		CREATE INDEX IF NOT EXISTS idx_ref_source ON heading_references(source_file_id, source_heading_id);
		CREATE INDEX IF NOT EXISTS idx_ref_target ON heading_references(target_file_id);
		PRAGMA foreign_keys = ON;
	`);
}

/**
 * v9: metadata_types / relation_types lookup tables; headings + relations store ids not text.
 * Idempotent: skips when columns already use *_id.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function migrateMetadataAndRelationTypeIds(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS metadata_types (
			metadata_type_id INTEGER PRIMARY KEY,
			metadata_type_name TEXT NOT NULL UNIQUE
		);
		CREATE TABLE IF NOT EXISTS relation_types (
			relation_type_id INTEGER PRIMARY KEY,
			relation_type_name TEXT NOT NULL UNIQUE
		);
	`);

	const headingsNeedMigrate =
		tableExists(db, 'headings') && columnExists(db, 'headings', 'metadata_type');
	if (headingsNeedMigrate) {
		const distinct = db.exec(
			`SELECT DISTINCT TRIM(LOWER(metadata_type)) FROM headings
			 WHERE metadata_type IS NOT NULL AND TRIM(metadata_type) != ''`
		);
		let nextMetaId = 0;
		const maxMeta = db.exec(`SELECT COALESCE(MAX(metadata_type_id), -1) FROM metadata_types`);
		if (maxMeta.length && maxMeta[0].values.length) {
			nextMetaId = Number(maxMeta[0].values[0][0]) + 1;
		}
		/** @type {Map<string, number>} */
		const metaIdByName = new Map();
		const existingMeta = db.exec(`SELECT metadata_type_id, metadata_type_name FROM metadata_types`);
		if (existingMeta.length) {
			for (const row of existingMeta[0].values) {
				metaIdByName.set(String(row[1] || '').toLowerCase(), Number(row[0]));
			}
		}
		if (distinct.length) {
			for (const row of distinct[0].values) {
				const name = String(row[0] || '').toLowerCase();
				if (!name || metaIdByName.has(name)) {
					continue;
				}
				db.run(
					`INSERT INTO metadata_types (metadata_type_id, metadata_type_name) VALUES (?, ?)`,
					[nextMetaId, name]
				);
				metaIdByName.set(name, nextMetaId);
				nextMetaId += 1;
			}
		}

		db.exec(`
			PRAGMA foreign_keys = OFF;
			DROP INDEX IF EXISTS idx_heading_type;
			DROP TABLE IF EXISTS headings_v9;
			CREATE TABLE headings_v9 (
				file_id INTEGER NOT NULL,
				heading_id INTEGER NOT NULL,
				title TEXT NOT NULL,
				metadata_type_id INTEGER,
				hash TEXT,
				PRIMARY KEY (file_id, heading_id),
				FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
				FOREIGN KEY (metadata_type_id) REFERENCES metadata_types(metadata_type_id)
			);
			INSERT INTO headings_v9 (file_id, heading_id, title, metadata_type_id, hash)
				SELECT h.file_id, h.heading_id, h.title,
					CASE
						WHEN h.metadata_type IS NULL OR TRIM(h.metadata_type) = '' THEN NULL
						ELSE (
							SELECT m.metadata_type_id FROM metadata_types m
							WHERE m.metadata_type_name = TRIM(LOWER(h.metadata_type))
						)
					END,
					h.hash
				FROM headings h;
			DROP TABLE headings;
			ALTER TABLE headings_v9 RENAME TO headings;
			CREATE INDEX IF NOT EXISTS idx_heading_type ON headings(metadata_type_id);
			CREATE INDEX IF NOT EXISTS idx_headings_title ON headings(title);
			PRAGMA foreign_keys = ON;
		`);
	}

	const relationsNeedMigrate =
		tableExists(db, 'relations') && columnExists(db, 'relations', 'relation_type');
	if (relationsNeedMigrate) {
		const distinctRel = db.exec(
			`SELECT DISTINCT TRIM(LOWER(relation_type)) FROM relations
			 WHERE relation_type IS NOT NULL AND TRIM(relation_type) != ''`
		);
		let nextRelId = 0;
		const maxRel = db.exec(`SELECT COALESCE(MAX(relation_type_id), -1) FROM relation_types`);
		if (maxRel.length && maxRel[0].values.length) {
			nextRelId = Number(maxRel[0].values[0][0]) + 1;
		}
		/** @type {Map<string, number>} */
		const relIdByName = new Map();
		const existingRel = db.exec(`SELECT relation_type_id, relation_type_name FROM relation_types`);
		if (existingRel.length) {
			for (const row of existingRel[0].values) {
				relIdByName.set(String(row[1] || '').toLowerCase(), Number(row[0]));
			}
		}
		if (distinctRel.length) {
			for (const row of distinctRel[0].values) {
				const name = String(row[0] || '').toLowerCase();
				if (!name || relIdByName.has(name)) {
					continue;
				}
				db.run(
					`INSERT INTO relation_types (relation_type_id, relation_type_name) VALUES (?, ?)`,
					[nextRelId, name]
				);
				relIdByName.set(name, nextRelId);
				nextRelId += 1;
			}
		}

		db.exec(`
			PRAGMA foreign_keys = OFF;
			DROP INDEX IF EXISTS idx_relations_from;
			DROP INDEX IF EXISTS idx_relations_tag;
			DROP INDEX IF EXISTS idx_relations_type;
			DROP TABLE IF EXISTS relations_v9;
			CREATE TABLE relations_v9 (
				from_file_id INTEGER NOT NULL,
				from_heading_id INTEGER NOT NULL,
				relation_type_id INTEGER NOT NULL,
				tag_id INTEGER NOT NULL,
				PRIMARY KEY (from_file_id, from_heading_id, relation_type_id, tag_id),
				FOREIGN KEY (relation_type_id) REFERENCES relation_types(relation_type_id),
				FOREIGN KEY (tag_id) REFERENCES tags(tag_id)
			);
			INSERT OR IGNORE INTO relations_v9 (from_file_id, from_heading_id, relation_type_id, tag_id)
				SELECT r.from_file_id, r.from_heading_id, rt.relation_type_id, r.tag_id
				FROM relations r
				INNER JOIN relation_types rt
					ON rt.relation_type_name = TRIM(LOWER(r.relation_type));
			DROP TABLE relations;
			ALTER TABLE relations_v9 RENAME TO relations;
			CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_file_id, from_heading_id);
			CREATE INDEX IF NOT EXISTS idx_relations_tag ON relations(tag_id);
			CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type_id);
			PRAGMA foreign_keys = ON;
		`);
	}
}

/**
 * v10: five typed metadata tables + metadata_remaining_keys EAV.
 * Best-effort copy from v9 shapes; rebuild index if old rows look incomplete.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function migrateTypedMetadataV10(db) {
	db.exec(`
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
	`);

	if (!columnIsNotNull(db, 'metadata_remaining_keys', 'value')) {
		db.exec(`
			PRAGMA foreign_keys = OFF;
			DROP TABLE IF EXISTS metadata_remaining_keys_v10;
			CREATE TABLE metadata_remaining_keys_v10 (
				file_id INTEGER NOT NULL,
				heading_id INTEGER NOT NULL,
				metadata_type_id INTEGER NOT NULL,
				key TEXT NOT NULL,
				value TEXT NOT NULL,
				PRIMARY KEY (file_id, heading_id, metadata_type_id, key),
				FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE,
				FOREIGN KEY (metadata_type_id) REFERENCES metadata_types(metadata_type_id)
			);
			INSERT OR IGNORE INTO metadata_remaining_keys_v10
				(file_id, heading_id, metadata_type_id, key, value)
				SELECT file_id, heading_id, metadata_type_id, key, value
				FROM metadata_remaining_keys
				WHERE value IS NOT NULL AND TRIM(value) != '';
			DROP TABLE metadata_remaining_keys;
			ALTER TABLE metadata_remaining_keys_v10 RENAME TO metadata_remaining_keys;
			CREATE INDEX IF NOT EXISTS idx_remaining_keys_heading
				ON metadata_remaining_keys(file_id, heading_id);
			CREATE INDEX IF NOT EXISTS idx_remaining_keys_type_key
				ON metadata_remaining_keys(metadata_type_id, key);
			CREATE INDEX IF NOT EXISTS idx_remaining_keys_lookup
				ON metadata_remaining_keys(metadata_type_id, key, value);
			PRAGMA foreign_keys = ON;
		`);
	}

	const conceptNeeds =
		tableExists(db, 'concept_metadata') && columnExists(db, 'concept_metadata', 'difficulty');
	if (conceptNeeds) {
		db.exec(`
			PRAGMA foreign_keys = OFF;
			CREATE TABLE concept_metadata_v10 (
				file_id INTEGER NOT NULL,
				heading_id INTEGER NOT NULL,
				status TEXT,
				PRIMARY KEY (file_id, heading_id),
				FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
			);
			INSERT OR IGNORE INTO concept_metadata_v10 (file_id, heading_id, status)
				SELECT file_id, heading_id, NULL FROM concept_metadata;
			INSERT OR IGNORE INTO metadata_remaining_keys (file_id, heading_id, metadata_type_id, key, value)
				SELECT c.file_id, c.heading_id, h.metadata_type_id, 'difficulty', c.difficulty
				FROM concept_metadata c
				INNER JOIN headings h ON h.file_id = c.file_id AND h.heading_id = c.heading_id
				WHERE c.difficulty IS NOT NULL AND TRIM(c.difficulty) != ''
				  AND h.metadata_type_id IS NOT NULL;
			DROP TABLE concept_metadata;
			ALTER TABLE concept_metadata_v10 RENAME TO concept_metadata;
			PRAGMA foreign_keys = ON;
		`);
	} else if (!tableExists(db, 'concept_metadata')) {
		db.exec(`
			CREATE TABLE concept_metadata (
				file_id INTEGER NOT NULL,
				heading_id INTEGER NOT NULL,
				status TEXT,
				PRIMARY KEY (file_id, heading_id),
				FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
			);
		`);
	}

	const projectNeeds =
		tableExists(db, 'project_metadata') && !columnExists(db, 'project_metadata', 'deadline');
	if (projectNeeds) {
		db.exec(`
			PRAGMA foreign_keys = OFF;
			CREATE TABLE project_metadata_v10 (
				file_id INTEGER NOT NULL,
				heading_id INTEGER NOT NULL,
				status TEXT,
				deadline INTEGER,
				PRIMARY KEY (file_id, heading_id),
				FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
			);
			INSERT OR IGNORE INTO project_metadata_v10 (file_id, heading_id, status, deadline)
				SELECT file_id, heading_id, status, NULL FROM project_metadata;
			DROP TABLE project_metadata;
			ALTER TABLE project_metadata_v10 RENAME TO project_metadata;
			CREATE INDEX IF NOT EXISTS idx_project_sort ON project_metadata(deadline);
			PRAGMA foreign_keys = ON;
		`);
	}

	const issueOld =
		tableExists(db, 'issue_metadata') && columnExists(db, 'issue_metadata', 'work_minutes');
	if (issueOld) {
		db.exec(`
			PRAGMA foreign_keys = OFF;
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
			CREATE TABLE issue_metadata_v10 (
				file_id INTEGER NOT NULL,
				heading_id INTEGER NOT NULL,
				status TEXT,
				category TEXT,
				deadline INTEGER,
				priority TEXT,
				PRIMARY KEY (file_id, heading_id),
				FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
			);
			INSERT OR IGNORE INTO task_metadata (file_id, heading_id, status, category, deadline, priority)
				SELECT i.file_id, i.heading_id, i.status, NULL, i.deadline, i.priority
				FROM issue_metadata i
				INNER JOIN headings h ON h.file_id = i.file_id AND h.heading_id = i.heading_id
				INNER JOIN metadata_types mt ON mt.metadata_type_id = h.metadata_type_id
				WHERE mt.metadata_type_name = 'task';
			INSERT OR IGNORE INTO issue_metadata_v10 (file_id, heading_id, status, category, deadline, priority)
				SELECT i.file_id, i.heading_id, i.status, NULL, i.deadline, i.priority
				FROM issue_metadata i
				INNER JOIN headings h ON h.file_id = i.file_id AND h.heading_id = i.heading_id
				LEFT JOIN metadata_types mt ON mt.metadata_type_id = h.metadata_type_id
				WHERE mt.metadata_type_name IS NULL OR mt.metadata_type_name != 'task';
			INSERT OR IGNORE INTO metadata_remaining_keys (file_id, heading_id, metadata_type_id, key, value)
				SELECT i.file_id, i.heading_id, h.metadata_type_id, 'duration', CAST(i.work_minutes AS TEXT)
				FROM issue_metadata i
				INNER JOIN headings h ON h.file_id = i.file_id AND h.heading_id = i.heading_id
				WHERE i.work_minutes IS NOT NULL AND h.metadata_type_id IS NOT NULL;
			DROP TABLE issue_metadata;
			ALTER TABLE issue_metadata_v10 RENAME TO issue_metadata;
			CREATE INDEX IF NOT EXISTS idx_issue_sort ON issue_metadata(deadline, priority);
			CREATE INDEX IF NOT EXISTS idx_task_sort ON task_metadata(deadline, priority);
			PRAGMA foreign_keys = ON;
		`);
	}

	if (!tableExists(db, 'task_metadata')) {
		db.exec(`
			CREATE TABLE task_metadata (
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
		`);
	}

	if (!tableExists(db, 'decision_metadata')) {
		db.exec(`
			CREATE TABLE decision_metadata (
				file_id INTEGER NOT NULL,
				heading_id INTEGER NOT NULL,
				category TEXT,
				PRIMARY KEY (file_id, heading_id),
				FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
			);
		`);
	}

	if (tableExists(db, 'issue_metadata') && !columnExists(db, 'issue_metadata', 'category')) {
		db.exec(`
			PRAGMA foreign_keys = OFF;
			CREATE TABLE issue_metadata_v10b (
				file_id INTEGER NOT NULL,
				heading_id INTEGER NOT NULL,
				status TEXT,
				category TEXT,
				deadline INTEGER,
				priority TEXT,
				PRIMARY KEY (file_id, heading_id),
				FOREIGN KEY (file_id, heading_id) REFERENCES headings(file_id, heading_id) ON DELETE CASCADE
			);
			INSERT OR IGNORE INTO issue_metadata_v10b (file_id, heading_id, status, category, deadline, priority)
				SELECT file_id, heading_id, status, NULL, deadline, priority FROM issue_metadata;
			DROP TABLE issue_metadata;
			ALTER TABLE issue_metadata_v10b RENAME TO issue_metadata;
			CREATE INDEX IF NOT EXISTS idx_issue_sort ON issue_metadata(deadline, priority);
			PRAGMA foreign_keys = ON;
		`);
	}
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
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

	if (version < 7) {
		migrateHeadingsWithoutHierarchy(db);
	}

	if (version < 8) {
		migrateHeadingReferencesFileOnly(db);
	}

	if (version < 9) {
		migrateMetadataAndRelationTypeIds(db);
	}

	if (version < 10) {
		migrateTypedMetadataV10(db);
	}

	if (version < 11) {
		// Records table comes from SCHEMA_SQL; vec0 + meta via ensureHeadingEmbeddingStorage.
	}

	if (version < 12) {
		migrateHeadingsAddParent(db);
	}

	if (version < 13) {
		migrateIssueMetadataParentKey(db);
	}

	if (version < 14) {
		migrateProjectsV14(db);
	}

	if (version < 15) {
		migrateProjectPriorityV15(db);
	}

	db.exec(SCHEMA_SQL);
	ensureHeadingEmbeddingStorage(db);
	ensureFolderEmbeddingStorage(db);
	ensureTagEmbeddingStorage(db);

	db.run(`INSERT OR REPLACE INTO index_meta(key, value) VALUES ('schema_version', ?)`, [
		String(SCHEMA_VERSION)
	]);
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function seedInitialIndexMeta(db) {
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES ('next_file_id', '0')`);
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES ('next_project_id', '1')`);
	db.run(`INSERT OR REPLACE INTO index_meta(key, value) VALUES ('schema_version', ?)`, [
		String(SCHEMA_VERSION)
	]);
}

/**
 * Create or upgrade `index.drip` to {@link SCHEMA_VERSION}.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 */
function ensureDripIndexSchema(db) {
	const hasExistingSchema = tableExists(db, 'index_meta');
	if (!hasExistingSchema) {
		db.exec(SCHEMA_SQL);
		seedInitialIndexMeta(db);
		ensureHeadingEmbeddingStorage(db);
		ensureFolderEmbeddingStorage(db);
		ensureTagEmbeddingStorage(db);
		return;
	}

	// Existing databases must migrate before SCHEMA_SQL creates indexes that
	// reference v10 columns (metadata_type_id / relation_type_id).
	migrateSchemaIfNeeded(db);
	// Idempotent repairs for DBs that already report a version but still have old columns.
	migrateHeadingReferencesFileOnly(db);
	migrateMetadataAndRelationTypeIds(db);
	migrateTypedMetadataV10(db);
	migrateHeadingsAddParent(db);
	migrateIssueMetadataParentKey(db);
	migrateProjectsV14(db);
	migrateProjectPriorityV15(db);
	db.exec(SCHEMA_SQL);
	seedInitialIndexMeta(db);
	db.run(`INSERT OR IGNORE INTO index_meta(key, value) VALUES ('next_project_id', '1')`);
	ensureHeadingEmbeddingStorage(db);
	ensureFolderEmbeddingStorage(db);
	ensureTagEmbeddingStorage(db);
}

module.exports = {
	SCHEMA_VERSION,
	SCHEMA_SQL,
	TYPED_METADATA_TABLES,
	REMAINING_METADATA_TABLE,
	ensureDripIndexSchema,
	seedInitialIndexMeta,
	getSchemaVersion
};
