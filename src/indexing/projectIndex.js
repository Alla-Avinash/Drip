'use strict';

/**
 * Project-scoped index helpers.
 *
 * These operate on the project-scoped `projects.drip` database (opened by callers via
 * `openDripProjectsDb`), never on `index.drip`.
 * - `projects` rows keyed by folder_prefix (e.g. `sample/kjh.p/`)
 * - `headings.project_id` set for every heading under a `.p` folder
 * - `issues` rows keyed by (project_id, issue_key) with parent_issue_key hierarchy
 */

const path = require('path');
const {
	isDripProjectFolderName,
	projectDisplayNameFromFolderName,
	isProjectIndexFileName
} = require('../document/model/dripProjectFolder');
const {
	isDripFeatureFolderName,
	featureDisplayNameFromFolderName
} = require('../document/model/dripFeature');
const {
	normalizeIssueEntityId,
	parseIssueTitleEntityId
} = require('../document/project/projectStructureRules');

/**
 * @param {string} filePath
 * @returns {string} e.g. `sample/kjh.p/` or ''
 */
function projectFolderPrefixFromPath(filePath) {
	const rel = String(filePath || '').replace(/\\/g, '/');
	const parts = rel.split('/').filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		if (isDripProjectFolderName(parts[i])) {
			return parts.slice(0, i + 1).join('/') + '/';
		}
	}
	return '';
}

/**
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @returns {number}
 */
function allocateProjectId(db) {
	let next = 1;
	try {
		if (db.native) {
			const row = db.native.prepare(`SELECT value FROM index_meta WHERE key = 'next_project_id'`).get();
			const n = row && row.value != null ? parseInt(String(row.value), 10) : NaN;
			if (Number.isFinite(n) && n >= 1) next = n;
		} else {
			const stmt = db.prepare(`SELECT value FROM index_meta WHERE key = 'next_project_id'`);
			stmt.bind([]);
			if (stmt.step()) {
				const row = stmt.get();
				const n = row && row[0] != null ? parseInt(String(row[0]), 10) : NaN;
				if (Number.isFinite(n) && n >= 1) next = n;
			}
			stmt.free();
		}
	} catch {
		next = 1;
	}
	const id = next;
	db.run(`INSERT OR REPLACE INTO index_meta(key, value) VALUES ('next_project_id', ?)`, [
		String(id + 1)
	]);
	return id;
}

/**
 * Ensure a `projects` row for this folder prefix; return project_id.
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {string} folderPrefix
 * @param {{ fileId?: number, filePath?: string, title?: string, status?: string|null, deadline?: number|null, priority?: string|null }} [opts]
 * @returns {number | null}
 */
function ensureProjectRow(db, folderPrefix, opts = {}) {
	const prefix = String(folderPrefix || '')
		.replace(/\\/g, '/')
		.replace(/\/+$/, '');
	if (!prefix) return null;
	const normalized = prefix + '/';

	let existing = null;
	try {
		if (db.native) {
			existing = db.native
				.prepare(`SELECT project_id AS projectId FROM projects WHERE folder_prefix = ?`)
				.get(normalized);
		}
	} catch {
		existing = null;
	}
	if (existing && existing.projectId != null) {
		const projectId = Math.floor(Number(existing.projectId));
		const base = path.posix.basename(prefix);
		const title =
			(opts.title && String(opts.title).trim()) ||
			projectDisplayNameFromFolderName(base);
		const isIndex =
			opts.filePath && isProjectIndexFileName(path.posix.basename(String(opts.filePath).replace(/\\/g, '/')));
		if (isIndex && opts.fileId != null) {
			db.run(
				`UPDATE projects SET index_file_id = ?, title = COALESCE(?, title),
				 status = COALESCE(?, status), deadline = COALESCE(?, deadline), priority = COALESCE(?, priority)
				 WHERE project_id = ?`,
				[
					Math.floor(Number(opts.fileId)),
					title,
					opts.status != null ? String(opts.status) : null,
					opts.deadline != null && Number.isFinite(Number(opts.deadline))
						? Number(opts.deadline)
						: null,
					opts.priority != null ? String(opts.priority) : null,
					projectId
				]
			);
		}
		return projectId;
	}

	const projectId = allocateProjectId(db);
	const base = path.posix.basename(prefix);
	const title =
		(opts.title && String(opts.title).trim()) || projectDisplayNameFromFolderName(base);
	const isIndex =
		opts.filePath && isProjectIndexFileName(path.posix.basename(String(opts.filePath).replace(/\\/g, '/')));
	db.run(
		`INSERT INTO projects (project_id, folder_prefix, index_file_id, title, status, deadline, priority)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			projectId,
			normalized,
			isIndex && opts.fileId != null ? Math.floor(Number(opts.fileId)) : null,
			title,
			opts.status != null ? String(opts.status) : null,
			opts.deadline != null && Number.isFinite(Number(opts.deadline)) ? Number(opts.deadline) : null,
			opts.priority != null ? String(opts.priority) : null
		]
	);
	return projectId;
}

/**
 * Resolve project_id for a file path (creates projects row if needed).
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {string} filePath
 * @param {number} [fileId]
 * @returns {number | null}
 */
function resolveProjectIdForFile(db, filePath, fileId) {
	const prefix = projectFolderPrefixFromPath(filePath);
	if (!prefix) return null;
	return ensureProjectRow(db, prefix, { fileId, filePath });
}

/**
 * True when a KB-relative path belongs to the project zone (under a `.p` project
 * folder or a `.f` feature folder). Project-zone notes index into `projects.drip`.
 * @param {string} filePath
 * @returns {boolean}
 */
function isProjectNotePath(filePath) {
	return Boolean(projectFolderPrefixFromPath(filePath) || featureFolderPrefixFromPath(filePath));
}

/**
 * @param {string} filePath
 * @returns {'project' | 'document'}
 */
function classifyNoteZone(filePath) {
	return isProjectNotePath(filePath) ? 'project' : 'document';
}

/**
 * Feature folder prefix for a file path (e.g. `sample/kjh.p/Auth.f/`), or ''.
 * @param {string} filePath
 * @returns {string}
 */
function featureFolderPrefixFromPath(filePath) {
	const rel = String(filePath || '').replace(/\\/g, '/');
	const parts = rel.split('/').filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		if (isDripFeatureFolderName(parts[i])) {
			return parts.slice(0, i + 1).join('/') + '/';
		}
	}
	return '';
}

/**
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @returns {number}
 */
function allocateFeatureId(db) {
	let next = 1;
	try {
		if (db.native) {
			const row = db.native.prepare(`SELECT value FROM index_meta WHERE key = 'next_feature_id'`).get();
			const n = row && row.value != null ? parseInt(String(row.value), 10) : NaN;
			if (Number.isFinite(n) && n >= 1) next = n;
		} else {
			const stmt = db.prepare(`SELECT value FROM index_meta WHERE key = 'next_feature_id'`);
			stmt.bind([]);
			if (stmt.step()) {
				const row = stmt.get();
				const n = row && row[0] != null ? parseInt(String(row[0]), 10) : NaN;
				if (Number.isFinite(n) && n >= 1) next = n;
			}
			stmt.free();
		}
	} catch {
		next = 1;
	}
	const id = next;
	db.run(`INSERT OR REPLACE INTO index_meta(key, value) VALUES ('next_feature_id', ?)`, [String(id + 1)]);
	return id;
}

/**
 * True if basename is a `.f` folder index note (`_Auth.f.d.txt`).
 * @param {string} base
 * @returns {boolean}
 */
function isFeatureIndexFileName(base) {
	return /^_.+\.f\.d\.txt$/i.test(String(base || ''));
}

/**
 * Ensure a `features` row for this folder prefix; return feature_id.
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {string} folderPrefix
 * @param {{ fileId?: number, filePath?: string, title?: string, category?: string|null }} [opts]
 * @returns {number | null}
 */
function ensureFeatureRow(db, folderPrefix, opts = {}) {
	const prefix = String(folderPrefix || '').replace(/\\/g, '/').replace(/\/+$/, '');
	if (!prefix) return null;
	const normalized = prefix + '/';

	let existing = null;
	try {
		if (db.native) {
			existing = db.native
				.prepare(`SELECT feature_id AS featureId FROM features WHERE folder_prefix = ?`)
				.get(normalized);
		}
	} catch {
		existing = null;
	}
	if (existing && existing.featureId != null) {
		const featureId = Math.floor(Number(existing.featureId));
		const base = path.posix.basename(prefix);
		const title =
			(opts.title && String(opts.title).trim()) || featureDisplayNameFromFolderName(base);
		const isIndex =
			opts.filePath && isFeatureIndexFileName(path.posix.basename(String(opts.filePath).replace(/\\/g, '/')));
		if (isIndex && opts.fileId != null) {
			db.run(
				`UPDATE features SET index_file_id = ?, title = COALESCE(?, title), category = COALESCE(?, category)
				 WHERE feature_id = ?`,
				[
					Math.floor(Number(opts.fileId)),
					title,
					opts.category != null ? String(opts.category) : null,
					featureId
				]
			);
		}
		return featureId;
	}

	const featureId = allocateFeatureId(db);
	const base = path.posix.basename(prefix);
	const title =
		(opts.title && String(opts.title).trim()) || featureDisplayNameFromFolderName(base);
	const isIndex =
		opts.filePath && isFeatureIndexFileName(path.posix.basename(String(opts.filePath).replace(/\\/g, '/')));
	db.run(
		`INSERT INTO features (feature_id, folder_prefix, index_file_id, title, category)
		 VALUES (?, ?, ?, ?, ?)`,
		[
			featureId,
			normalized,
			isIndex && opts.fileId != null ? Math.floor(Number(opts.fileId)) : null,
			title,
			opts.category != null ? String(opts.category) : null
		]
	);
	return featureId;
}

/**
 * Resolve feature_id for a file path (creates features row if needed).
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {string} filePath
 * @param {number} [fileId]
 * @returns {number | null}
 */
function resolveFeatureIdForFile(db, filePath, fileId) {
	const prefix = featureFolderPrefixFromPath(filePath);
	if (!prefix) return null;
	return ensureFeatureRow(db, prefix, { fileId, filePath });
}

/**
 * @param {string} title indexed title e.g. `i-34 Fix`
 * @returns {string | null} `i-34`
 */
function issueKeyFromHeadingTitle(title) {
	const parsed = parseIssueTitleEntityId(title);
	if (parsed) return parsed.id;
	const m = String(title || '')
		.trim()
		.match(/^\.?(i-\d+)\b/i);
	return m ? normalizeIssueEntityId(m[1]) : null;
}

/**
 * Upsert one issues row (canonical Project View store).
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {{
 *   projectId: number,
 *   fileId: number,
 *   headingId: number,
 *   title: string,
 *   issueKey?: string|null,
 *   status?: string|null,
 *   category?: string|null,
 *   deadline?: number|null,
 *   priority?: string|null,
 *   parentIssueKey?: string|null
 * }} row
 */
function upsertIssueRow(db, row) {
	const projectId = Math.floor(Number(row.projectId));
	const fileId = Math.floor(Number(row.fileId));
	const headingId = Math.floor(Number(row.headingId));
	if (!Number.isFinite(projectId) || !Number.isFinite(fileId) || !Number.isFinite(headingId)) {
		return;
	}
	const issueKey =
		normalizeIssueEntityId(row.issueKey) || issueKeyFromHeadingTitle(row.title || '');
	if (!issueKey) return;

	let parentKey = null;
	if (row.parentIssueKey) {
		parentKey = normalizeIssueEntityId(row.parentIssueKey);
	}

	const title = String(row.title || '').trim() || issueKey;

	// One heading → one issue: clear stale key for this heading, then upsert by key.
	db.run(`DELETE FROM issues WHERE file_id = ? AND heading_id = ?`, [fileId, headingId]);
	db.run(
		`INSERT INTO issues (
			project_id, issue_key, file_id, heading_id, title,
			parent_issue_key, status, category, deadline, priority
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(project_id, issue_key) DO UPDATE SET
			file_id = excluded.file_id,
			heading_id = excluded.heading_id,
			title = excluded.title,
			parent_issue_key = excluded.parent_issue_key,
			status = excluded.status,
			category = excluded.category,
			deadline = excluded.deadline,
			priority = excluded.priority`,
		[
			projectId,
			issueKey,
			fileId,
			headingId,
			title,
			parentKey,
			row.status != null ? String(row.status) : null,
			row.category != null ? String(row.category) : null,
			row.deadline != null && Number.isFinite(Number(row.deadline)) ? Number(row.deadline) : null,
			row.priority != null ? String(row.priority) : null
		]
	);
}

module.exports = {
	projectFolderPrefixFromPath,
	featureFolderPrefixFromPath,
	isProjectNotePath,
	classifyNoteZone,
	allocateProjectId,
	ensureProjectRow,
	resolveProjectIdForFile,
	allocateFeatureId,
	ensureFeatureRow,
	resolveFeatureIdForFile,
	issueKeyFromHeadingTitle,
	upsertIssueRow
};
