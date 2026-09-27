'use strict';

/**
 * Project View queries against `index.drip` (schema v14).
 * Uses `projects` + `issues` + `headings.project_id` (no path LIKE for issues).
 */

const path = require('path');
const { openDripIndexDb } = require('./dripIndexDb');
const {
	isDripFeatureFolderName
} = require('../document/model/dripFeature');
const { isProjectIndexFileName } = require('../document/model/dripProjectFolder');

/**
 * @param {unknown} row
 * @returns {Record<string, unknown>}
 */
function asRow(row) {
	return row && typeof row === 'object' ? /** @type {Record<string, unknown>} */ (row) : {};
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
	const handle = await openDripIndexDb(kbRootUri);
	try {
		const db = handle.db;
		const rows = db.native
			.prepare(
				`SELECT p.project_id AS projectId, p.folder_prefix AS folderPrefix, p.title AS title,
				        p.status AS status, p.deadline AS deadline, p.index_file_id AS indexFileId,
				        f.path AS path
				 FROM projects p
				 LEFT JOIN files f ON f.id = p.index_file_id
				 ORDER BY LOWER(COALESCE(p.title, p.folder_prefix)) ASC`
			)
			.all();

		const projects = (rows || []).map(r => {
			const row = asRow(r);
			const folderPrefix = String(row.folderPrefix || '');
			const fileId = Number(row.indexFileId) || 0;
			return {
				projectId: Number(row.projectId) || 0,
				fileId,
				headingId: 0,
				title: String(row.title || path.posix.basename(folderPrefix.replace(/\/+$/, '')) || 'Untitled'),
				path: String(row.path || folderPrefix),
				folderPrefix,
				status: row.status != null ? String(row.status) : null,
				deadline:
					row.deadline != null && Number.isFinite(Number(row.deadline))
						? Number(row.deadline)
						: null
			};
		});
		return { projects };
	} finally {
		handle.close();
	}
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
 *     isFolderIndex: boolean
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
	const handle = await openDripIndexDb(kbRootUri);
	try {
		const db = handle.db;

		const projectRow = db.native
			.prepare(
				`SELECT project_id AS projectId FROM projects WHERE folder_prefix = ? OR folder_prefix = ?`
			)
			.get(prefix + '/', prefix);
		const projectId = projectRow ? Number(projectRow.projectId) : 0;

		const fileRows = db.native
			.prepare(
				`SELECT id AS fileId, path AS path
				 FROM files
				 WHERE REPLACE(path, '\\', '/') LIKE ?
				 ORDER BY LOWER(path) ASC`
			)
			.all(like);

		/** @type {Map<string, {
		 *   fileId: number,
		 *   path: string,
		 *   folderPrefix: string | null,
		 *   isFolderIndex: boolean
		 * }>} */
		const featuresByKey = new Map();
		for (const r of fileRows || []) {
			const row = asRow(r);
			const filePath = String(row.path || '').replace(/\\/g, '/');
			const base = path.posix.basename(filePath);
			const parentDir = path.posix.dirname(filePath);
			const parentBase = path.posix.basename(parentDir);
			const fileId = Number(row.fileId) || 0;

			if (/\.f\.d\.txt$/i.test(base)) {
				if (!featuresByKey.has(filePath)) {
					featuresByKey.set(filePath, {
						fileId,
						path: filePath,
						folderPrefix: null,
						isFolderIndex: false
					});
				}
				continue;
			}
			if (isDripFeatureFolderName(parentBase)) {
				const featPrefix = parentDir.endsWith('/') ? parentDir : parentDir + '/';
				const existing = featuresByKey.get(featPrefix);
				const preferIndex =
					/^_/.test(base) || /_recent\.d\.txt$/i.test(base) || isProjectIndexFileName(base);
				if (!existing || preferIndex) {
					featuresByKey.set(featPrefix, {
						fileId,
						path: filePath,
						folderPrefix: featPrefix,
						isFolderIndex: true
					});
				}
			}
		}

		const features = [];
		for (const f of featuresByKey.values()) {
			const enrich = db.native
				.prepare(
					`SELECT heading_id AS headingId, title AS title
					 FROM headings WHERE file_id = ? AND heading_id = 0 LIMIT 1`
				)
				.get(f.fileId);
			const er = asRow(enrich);
			const folderBase = f.folderPrefix
				? path.posix.basename(f.folderPrefix.replace(/\/+$/, ''))
				: path.posix.basename(f.path).replace(/\.f\.d\.txt$/i, '');
			features.push({
				fileId: f.fileId,
				headingId: er.headingId != null ? Number(er.headingId) : 0,
				title: (er.title != null && String(er.title).trim()) || folderBase || 'Untitled',
				path: f.path,
				folderPrefix: f.folderPrefix,
				isFolderIndex: f.isFolderIndex
			});
		}
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
					        f.path AS path, h.parent AS parent
					 FROM issues i
					 JOIN files f ON f.id = i.file_id
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
			const filePath = String(row.path || '').replace(/\\/g, '/');
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
				fileId: Number(row.fileId) || 0,
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
	const handle = await openDripIndexDb(kbRootUri);
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
				        f.path AS path
				 FROM issues i
				 JOIN files f ON f.id = i.file_id
				 WHERE i.project_id = ?`
			)
			.all(projectId);
		return (rows || [])
			.map(r => {
				const row = asRow(r);
				return {
					issueKey: String(row.issueKey || '').trim().toLowerCase(),
					title: String(row.title || ''),
					path: String(row.path || '').replace(/\\/g, '/'),
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
