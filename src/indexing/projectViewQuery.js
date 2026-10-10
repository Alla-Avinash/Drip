'use strict';

/**
 * Project View queries against `projects.drip` (the project-scoped index).
 *
 * `projects.drip` holds projects, features, issues, and project headings. The shared
 * `files` registry (file id → path) lives in `index.drip`, so queries load a small
 * `id → path` map from `index.drip` and join in JS — SQLite foreign keys cannot cross
 * database files.
 */

const path = require('path');
const { openDripIndexDb } = require('./dripIndexDb');
const { openDripProjectsDb } = require('./dripProjectDb');
const { isDripFeatureFolderName } = require('../document/model/dripFeature');
const { isProjectIndexFileName } = require('../document/model/dripProjectFolder');

/**
 * @param {unknown} row
 * @returns {Record<string, unknown>}
 */
function asRow(row) {
	return row && typeof row === 'object' ? /** @type {Record<string, unknown>} */ (row) : {};
}

/**
 * Map of file id → KB-relative path from the shared `files` registry in `index.drip`.
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<Map<number, string>>}
 */
async function loadFilePathMap(kbRootUri) {
	const handle = await openDripIndexDb(kbRootUri);
	try {
		const rows = handle.db.native.prepare('SELECT id, path FROM files').all();
		/** @type {Map<number, string>} */
		const map = new Map();
		for (const r of rows || []) {
			const row = asRow(r);
			map.set(Number(row.id) || 0, String(row.path || '').replace(/\\/g, '/'));
		}
		return map;
	} finally {
		handle.close();
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<{
 *   projects: {
 *     projectId: number,
 *     fileId: number,
 *     headingId: number,
 *     title: string,
 *     path: string,
 *     folderPrefix: string,
 *     status: string | null,
 *     deadline: number | null
 *   }[]
 * }>}
 */
async function listProjectsFromIndex(kbRootUri) {
	if (!kbRootUri) return { projects: [] };
	const handle = await openDripProjectsDb(kbRootUri);
	try {
		const db = handle.db;
		const rows = db.native
			.prepare(
				`SELECT p.project_id AS projectId, p.folder_prefix AS folderPrefix, p.title AS title,
				        p.status AS status, p.deadline AS deadline, p.priority AS priority, p.index_file_id AS indexFileId,
				        (SELECT COUNT(*) FROM issues i WHERE i.project_id = p.project_id) AS issueCount
				 FROM projects p
				 ORDER BY LOWER(COALESCE(p.title, p.folder_prefix)) ASC`
			)
			.all();

		// Per-project issue status breakdown (powers the issue bubble fraction + stats).
		const statusRows = db.native
			.prepare(
				`SELECT project_id AS projectId, LOWER(COALESCE(status, '')) AS status, COUNT(*) AS n
				 FROM issues
				 GROUP BY project_id, LOWER(COALESCE(status, ''))`
			)
			.all();
		/** @type {Map<number, Record<string, number>>} */
		const statusByProject = new Map();
		for (const r of statusRows || []) {
			const row = asRow(r);
			const pid = Number(row.projectId) || 0;
			const status = String(row.status || '').toLowerCase();
			const n = Number(row.n) || 0;
			if (!pid || !status) continue;
			if (!statusByProject.has(pid)) statusByProject.set(pid, {});
			statusByProject.get(pid)[status] = n;
		}

		const pathMap = await loadFilePathMap(kbRootUri);

		const projects = (rows || []).map(r => {
			const row = asRow(r);
			const folderPrefix = String(row.folderPrefix || '');
			const fileId = Number(row.indexFileId) || 0;
			return {
				projectId: Number(row.projectId) || 0,
				fileId,
				headingId: 0,
				title: String(row.title || path.posix.basename(folderPrefix.replace(/\/+$/, '')) || 'Untitled'),
				path: pathMap.get(fileId) || folderPrefix,
				folderPrefix,
				status: row.status != null ? String(row.status) : null,
				priority: row.priority != null ? String(row.priority) : null,
				deadline:
					row.deadline != null && Number.isFinite(Number(row.deadline))
						? Number(row.deadline)
						: null,
				issueCount:
					row.issueCount != null && Number.isFinite(Number(row.issueCount))
						? Number(row.issueCount)
						: 0,
				issueStatusCounts: statusByProject.get(Number(row.projectId) || 0) || {}
			};
		});
		return { projects };
	} finally {
		handle.close();
	}
}

/**
 * Standalone `*.f.d.txt` feature files under a project. These are never recorded in the
 * `features` registry (which only holds `.f` folders), so they are always derived from the
 * shared `files` registry in `index.drip` — even for indexes built after v16.
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db projects.drip handle (for h0 headings)
 * @param {Map<number, string>} pathMap file id → KB-relative path (from index.drip)
 * @param {string} prefix project folder prefix (no trailing slash)
 * @returns {{
 *   fileId: number,
 *   headingId: number,
 *   title: string,
 *   path: string,
 *   folderPrefix: null,
 *   isFolderIndex: boolean,
 *   category: null
 * }[]}
 */
function deriveFileFeaturesFromFiles(db, pathMap, prefix) {
	const features = [];
	for (const [fileId, filePath] of pathMap.entries()) {
		if (!filePath.startsWith(`${prefix}/`)) continue;
		const base = path.posix.basename(filePath);
		// Standalone feature file (`Name.f.d.txt`) — not a folder index note (`_Name.f.d.txt`).
		if (!/\.f\.d\.txt$/i.test(base) || isProjectIndexFileName(base)) continue;

		let title = base.replace(/\.f\.d\.txt$/i, '');
		let headingId = 0;
		try {
			const enrich = db.native
				.prepare(
					`SELECT heading_id AS headingId, title AS title
					 FROM headings WHERE file_id = ? AND heading_id = 0 LIMIT 1`
				)
				.get(fileId);
			const er = asRow(enrich);
			if (er.headingId != null) headingId = Number(er.headingId);
			if (er.title != null && String(er.title).trim()) title = String(er.title).trim();
		} catch {
			/* no h0 heading recorded yet */
		}
		features.push({
			fileId,
			headingId,
			title: title || 'Untitled',
			path: filePath,
			folderPrefix: null,
			isFolderIndex: false,
			category: null
		});
	}
	features.sort((a, b) => String(a.title).toLowerCase().localeCompare(String(b.title).toLowerCase()));
	return features;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} projectFolderPrefix
 * @returns {Promise<{
 *   features: {
 *     fileId: number,
 *     headingId: number,
 *     title: string,
 *     path: string,
 *     folderPrefix: string | null,
 *     isFolderIndex: boolean,
 *     category: string | null
 *   }[],
 *   issues: {
 *     projectId: number,
 *     fileId: number,
 *     headingId: number,
 *     title: string,
 *     path: string,
 *     parent: number | null,
 *     parentIssueKey: string | null,
 *     issueKey: string | null,
 *     inProjectInbox: boolean,
 *     status: string | null,
 *     priority: string | null,
 *     deadline: number | null,
 *     featurePathPrefix: string | null
 *   }[]
 * }>}
 */
async function listProjectChildrenFromIndex(kbRootUri, projectFolderPrefix) {
	const prefix = String(projectFolderPrefix || '')
		.replace(/\\/g, '/')
		.replace(/\/+$/, '');
	if (!kbRootUri || !prefix) return { features: [], issues: [] };
	const like = `${prefix}/%`;
	const handle = await openDripProjectsDb(kbRootUri);
	try {
		const db = handle.db;

		const projectRow = db.native
			.prepare(
				`SELECT project_id AS projectId FROM projects WHERE folder_prefix = ? OR folder_prefix = ?`
			)
			.get(prefix + '/', prefix);
		const projectId = projectRow ? Number(asRow(projectRow).projectId) : 0;

		// Features come from the `features` registry (`.f` folders under this project).
		const featureRows = db.native
			.prepare(
				`SELECT f.feature_id AS featureId, f.folder_prefix AS folderPrefix, f.title AS title,
				        f.category AS category, f.index_file_id AS indexFileId
				 FROM features f
				 WHERE REPLACE(f.folder_prefix, '\\', '/') LIKE ?
				 ORDER BY LOWER(COALESCE(f.title, f.folder_prefix)) ASC`
			)
			.all(like);

		const pathMap = await loadFilePathMap(kbRootUri);

		// Folder features from the `features` registry + standalone `*.f.d.txt` feature files
		// (which the registry never records).
		const folderFeatures = (featureRows || []).map(r => {
			const row = asRow(r);
			const folderPrefix = String(row.folderPrefix || '').replace(/\\/g, '/');
			const fileId = Number(row.indexFileId) || 0;
			return {
				fileId,
				headingId: 0,
				title:
					String(row.title || path.posix.basename(folderPrefix.replace(/\/+$/, '')) || 'Untitled'),
				path: pathMap.get(fileId) || folderPrefix,
				folderPrefix,
				isFolderIndex: true,
				category: row.category != null ? String(row.category) : null
			};
		});
		const features = folderFeatures.concat(deriveFileFeaturesFromFiles(db, pathMap, prefix));
		features.sort((a, b) =>
			String(a.title).toLowerCase().localeCompare(String(b.title).toLowerCase())
		);

		/** @type {any[]} */
		let issueRows = [];
		if (projectId) {
			issueRows = db.native
				.prepare(
					`SELECT i.project_id AS projectId, i.file_id AS fileId, i.heading_id AS headingId,
					        i.title AS title, i.issue_key AS issueKey, i.parent_issue_key AS parentIssueKey,
					        i.status AS status, i.priority AS priority, i.deadline AS deadline,
					        h.parent AS parent
					 FROM issues i
					 LEFT JOIN headings h
					   ON h.file_id = i.file_id AND h.heading_id = i.heading_id
					 WHERE i.project_id = ?
					 ORDER BY
					   CASE LOWER(COALESCE(i.priority, ''))
					     WHEN 'high' THEN 0
					     WHEN 'medium' THEN 1
					     WHEN 'low' THEN 2
					     ELSE 3
					   END,
					   LOWER(COALESCE(i.title, i.issue_key)) ASC`
				)
				.all(projectId);
		}

		const issues = (issueRows || []).map(r => {
			const row = asRow(r);
			const fileId = Number(row.fileId) || 0;
			const filePath = pathMap.get(fileId) || '';
			let featurePathPrefix = null;
			for (const f of features) {
				if (f.folderPrefix && (filePath === f.folderPrefix || filePath.startsWith(f.folderPrefix))) {
					featurePathPrefix = f.folderPrefix;
					break;
				}
				if (filePath === f.path) {
					featurePathPrefix = f.path;
					break;
				}
			}
			const parentRaw = row.parent;
			const parent =
				parentRaw != null && parentRaw !== '' && Number.isFinite(Number(parentRaw))
					? Math.floor(Number(parentRaw))
					: null;
			const parentIssueKey =
				row.parentIssueKey != null && String(row.parentIssueKey).trim()
					? String(row.parentIssueKey).trim().toLowerCase().replace(/^i-(\d+)$/i, (_, n) => `i-${parseInt(n, 10)}`)
					: null;
			const issueKey =
				row.issueKey != null && String(row.issueKey).trim()
					? String(row.issueKey).trim().toLowerCase().replace(/^i-(\d+)$/i, (_, n) => `i-${parseInt(n, 10)}`)
					: null;
			const inProjectInbox =
				/\/_issues\.d\.txt$/i.test(filePath) || /^_issues\.d\.txt$/i.test(filePath);
			return {
				projectId: Number(row.projectId) || projectId,
				fileId,
				headingId: Number(row.headingId) || 0,
				title: String(row.title || issueKey || 'Untitled'),
				path: filePath,
				parent,
				parentIssueKey,
				issueKey,
				inProjectInbox,
				status: row.status != null ? String(row.status) : null,
				priority: row.priority != null ? String(row.priority) : null,
				deadline:
					row.deadline != null && Number.isFinite(Number(row.deadline))
						? Number(row.deadline)
						: null,
				featurePathPrefix
			};
		});

		const { sanitizeIssueParents } = require('../document/project/issueParentLink');
		sanitizeIssueParents(issues);

		return { features, issues };
	} finally {
		handle.close();
	}
}

/**
 * Issues of one project for the RHS "Parent issue" field (any file / feature / folder).
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} projectFolderPrefix e.g. `App.p/`
 * @returns {Promise<{ issueKey: string, title: string, path: string, parentIssueKey: string | null }[]>}
 */
async function listProjectIssuesForParentPicker(kbRootUri, projectFolderPrefix) {
	const prefix = String(projectFolderPrefix || '')
		.replace(/\\/g, '/')
		.replace(/\/+$/, '');
	if (!kbRootUri || !prefix) return [];
	const handle = await openDripProjectsDb(kbRootUri);
	try {
		const db = handle.db;
		const projectRow = db.native
			.prepare(`SELECT project_id AS projectId FROM projects WHERE folder_prefix = ? OR folder_prefix = ?`)
			.get(prefix + '/', prefix);
		const projectId = projectRow ? Number(asRow(projectRow).projectId) : 0;
		if (!projectId) return [];
		const rows = db.native
			.prepare(
				`SELECT i.issue_key AS issueKey, i.title AS title, i.parent_issue_key AS parentIssueKey,
				        i.file_id AS fileId
				 FROM issues i
				 WHERE i.project_id = ?`
			)
			.all(projectId);
		const pathMap = await loadFilePathMap(kbRootUri);
		return (rows || [])
			.map(r => {
				const row = asRow(r);
				return {
					issueKey: String(row.issueKey || '').trim().toLowerCase(),
					title: String(row.title || ''),
					path: pathMap.get(Number(row.fileId) || 0) || '',
					parentIssueKey:
						row.parentIssueKey != null && String(row.parentIssueKey).trim()
							? String(row.parentIssueKey).trim().toLowerCase()
							: null
				};
			})
			.filter(r => /^i-\d+$/.test(r.issueKey));
	} finally {
		handle.close();
	}
}

module.exports = {
	projectFolderPrefixFromPath: require('./projectIndex').projectFolderPrefixFromPath,
	listProjectsFromIndex,
	listProjectChildrenFromIndex,
	listProjectIssuesForParentPicker
};
