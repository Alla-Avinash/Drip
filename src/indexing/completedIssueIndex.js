'use strict';

/**
 * Per-project index of completed issues (`completed_issues` table).
 *
 * Answers: issue key → current file/heading, completed_at, archived?, which
 * checkpoint lists it (if any). Notes + checkpoint files stay authoritative;
 * this table is updated on index write, archive move, and checkpoint edit.
 */

const path = require('path');
const { openDripProjectsDb } = require('./dripProjectDb');
const { projectFolderPrefixFromPath } = require('./projectIndex');
const { isCompletedStatus } = require('../document/project/issueCompletedStamp');
const { parseFlexibleDateTime } = require('../document/parse/dripTxt/dripTxtDatetime.js');

/**
 * Local copy — do not require projectCheckpoints here (circular load with dripIndexDb).
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeIssueKey(raw) {
	const m = String(raw || '')
		.trim()
		.toLowerCase()
		.match(/^i-(\d+)$/);
	if (!m) return '';
	return `i-${parseInt(m[1], 10)}`;
}

/**
 * @param {unknown} raw
 * @returns {number | null} unix seconds
 */
function completedAtUnixSeconds(raw) {
	const s = String(raw == null ? '' : raw).trim();
	if (!s) return null;
	if (/^\d{9,12}$/.test(s)) {
		const n = Number(s);
		return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
	}
	const when = parseFlexibleDateTime(s);
	if (!when || Number.isNaN(when.getTime())) return null;
	return Math.floor(when.getTime() / 1000);
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function remainingCompletedValue(remaining) {
	if (!Array.isArray(remaining)) return '';
	const pair = remaining.find(p => p && String(p.key || '').trim().toLowerCase() === 'completed');
	return pair && pair.value != null ? String(pair.value) : '';
}

/**
 * Upsert or clear one completed-issue row from an indexed issue heading.
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {{
 *   issueKey: string,
 *   fileId: number,
 *   headingId: number,
 *   status?: string|null,
 *   completedRaw?: string|null,
 *   filePath?: string|null
 * }} row
 */
function syncCompletedIssueFromIndex(db, row) {
	const issueKey = normalizeIssueKey(row && row.issueKey);
	if (!issueKey || !db) return;
	const fileId = Math.floor(Number(row.fileId));
	const headingId = Math.floor(Number(row.headingId));
	if (!Number.isFinite(fileId) || !Number.isFinite(headingId)) return;

	if (!isCompletedStatus(row.status)) {
		db.run(`DELETE FROM completed_issues WHERE issue_key = ?`, [issueKey]);
		return;
	}

	const completedAt = completedAtUnixSeconds(row.completedRaw);
	const filePath = String(row.filePath || '').replace(/\\/g, '/');
	const archived = /(^|\/)_archive\//i.test(filePath) && !/(^|\/)_checkpoints\//i.test(filePath) ? 1 : 0;

	// Preserve an existing checkpoint claim when only location/status changes.
	let checkpointRel = null;
	try {
		if (db.native) {
			const prev = db.native
				.prepare(`SELECT checkpoint_rel AS checkpointRel FROM completed_issues WHERE issue_key = ?`)
				.get(issueKey);
			if (prev && prev.checkpointRel != null && String(prev.checkpointRel).trim()) {
				checkpointRel = String(prev.checkpointRel).replace(/\\/g, '/');
			}
		}
	} catch {
		checkpointRel = null;
	}

	db.run(
		`INSERT INTO completed_issues (issue_key, file_id, heading_id, completed_at, archived, checkpoint_rel)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(issue_key) DO UPDATE SET
			file_id = excluded.file_id,
			heading_id = excluded.heading_id,
			completed_at = excluded.completed_at,
			archived = excluded.archived,
			checkpoint_rel = COALESCE(excluded.checkpoint_rel, completed_issues.checkpoint_rel)`,
		[issueKey, fileId, headingId, completedAt, archived, checkpointRel]
	);
}

/**
 * Drop completed-issue rows for a whole file (before reindexing / deleting it).
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {number} fileId
 */
function deleteCompletedIssuesForFile(db, fileId) {
	const id = Math.floor(Number(fileId));
	if (!Number.isFinite(id) || !db) return;
	db.run(`DELETE FROM completed_issues WHERE file_id = ?`, [id]);
}

/**
 * Drop one heading's completed-issue row (incremental delete).
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {number} fileId
 * @param {number} headingId
 */
function deleteCompletedIssueForHeading(db, fileId, headingId) {
	const fid = Math.floor(Number(fileId));
	const hid = Math.floor(Number(headingId));
	if (!Number.isFinite(fid) || !Number.isFinite(hid) || !db) return;
	db.run(`DELETE FROM completed_issues WHERE file_id = ? AND heading_id = ?`, [fid, hid]);
}

/**
 * Mark an issue archived (after move into done-N) and update its file location.
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {string} issueKey
 * @param {{ fileId?: number, headingId?: number }} [loc]
 */
function markCompletedIssueArchived(db, issueKey, loc) {
	const key = normalizeIssueKey(issueKey);
	if (!key || !db) return;
	const fileId = loc && loc.fileId != null ? Math.floor(Number(loc.fileId)) : null;
	const headingId = loc && loc.headingId != null ? Math.floor(Number(loc.headingId)) : null;
	if (Number.isFinite(fileId) && Number.isFinite(headingId)) {
		db.run(
			`UPDATE completed_issues
			 SET archived = 1, file_id = ?, heading_id = ?
			 WHERE issue_key = ?`,
			[fileId, headingId, key]
		);
		return;
	}
	db.run(`UPDATE completed_issues SET archived = 1 WHERE issue_key = ?`, [key]);
}

/**
 * Rebuild checkpoint_rel for every completed issue from checkpoint notes on disk.
 * Clears claims first, then sets them from `## Changes` lists.
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} projectFolderUri
 */
async function rebuildCheckpointClaims(kbRootUri, projectFolderUri) {
	const relFolder = path.relative(kbRootUri.fsPath, projectFolderUri.fsPath).replace(/\\/g, '/');
	const prefix = projectFolderPrefixFromPath(relFolder + '/');
	if (!prefix) return;

	const { listCheckpoints } = require('../document/project/projectCheckpoints');
	const list = await listCheckpoints(projectFolderUri);
	/** @type {Map<string, string>} issueKey → checkpoint rel */
	const claimByKey = new Map();
	for (const cp of list) {
		const rel = String(cp.rel || '').replace(/\\/g, '/');
		for (const raw of cp.issueKeys || []) {
			const key = normalizeIssueKey(raw);
			if (!key || claimByKey.has(key)) continue;
			claimByKey.set(key, rel);
		}
	}

	const handle = openDripProjectsDb(kbRootUri, prefix);
	try {
		handle.db.run(`UPDATE completed_issues SET checkpoint_rel = NULL`);
		for (const [issueKey, checkpointRel] of claimByKey) {
			// Upsert so a claim is recorded even if the issue row is not in the
			// completed_issues table yet (e.g. before a full reindex).
			handle.db.run(
				`INSERT INTO completed_issues (issue_key, file_id, heading_id, completed_at, archived, checkpoint_rel)
				 VALUES (?, 0, 0, NULL, 0, ?)
				 ON CONFLICT(issue_key) DO UPDATE SET checkpoint_rel = excluded.checkpoint_rel`,
				[issueKey, checkpointRel]
			);
		}
	} finally {
		handle.close();
	}
}

/**
 * Claimed issue keys from the index (falls back to empty if the table is empty /
 * missing — callers may still scan checkpoint files).
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} [exceptRel]
 * @returns {Promise<Set<string>>}
 */
async function listClaimedIssueKeysFromIndex(kbRootUri, folderPrefix, exceptRel) {
	const claimed = new Set();
	const prefix = String(folderPrefix || '')
		.replace(/\\/g, '/')
		.replace(/\/+$/, '');
	if (!kbRootUri || !prefix) return claimed;
	const skip = String(exceptRel || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '')
		.toLowerCase();
	const handle = openDripProjectsDb(kbRootUri, prefix);
	try {
		if (!handle.db.native) return claimed;
		const rows = handle.db.native
			.prepare(
				`SELECT issue_key AS issueKey, checkpoint_rel AS checkpointRel
				 FROM completed_issues
				 WHERE checkpoint_rel IS NOT NULL AND TRIM(checkpoint_rel) != ''`
			)
			.all();
		for (const r of rows || []) {
			const rel = String(r.checkpointRel || '')
				.replace(/\\/g, '/')
				.replace(/^\/+|\/+$/g, '')
				.toLowerCase();
			if (skip && rel === skip) continue;
			const key = normalizeIssueKey(r.issueKey);
			if (key) claimed.add(key);
		}
	} catch {
		/* table may be empty on first open */
	} finally {
		handle.close();
	}
	return claimed;
}

/**
 * Completed issues due for archive (not yet archived, stamp old enough).
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {number} afterDays
 * @param {Date} [now]
 * @returns {{ issueKey: string, fileId: number, headingId: number, completedAt: number|null }[]}
 */
function listIssuesReadyToArchive(db, afterDays, now) {
	/** @type {{ issueKey: string, fileId: number, headingId: number, completedAt: number|null }[]} */
	const out = [];
	const days = Math.max(1, Math.floor(Number(afterDays) || 3));
	const cutoff = Math.floor(((now || new Date()).getTime() - days * 86400000) / 1000);
	if (!db || !db.native) return out;
	try {
		const rows = db.native
			.prepare(
				`SELECT issue_key AS issueKey, file_id AS fileId, heading_id AS headingId,
				        completed_at AS completedAt
				 FROM completed_issues
				 WHERE archived = 0
				   AND completed_at IS NOT NULL
				   AND completed_at <= ?`
			)
			.all(cutoff);
		for (const r of rows || []) {
			const key = normalizeIssueKey(r.issueKey);
			if (!key) continue;
			out.push({
				issueKey: key,
				fileId: Number(r.fileId) || 0,
				headingId: Number(r.headingId) || 0,
				completedAt: r.completedAt != null ? Number(r.completedAt) : null
			});
		}
	} catch {
		return out;
	}
	return out;
}

module.exports = {
	completedAtUnixSeconds,
	remainingCompletedValue,
	syncCompletedIssueFromIndex,
	deleteCompletedIssuesForFile,
	deleteCompletedIssueForHeading,
	markCompletedIssueArchived,
	rebuildCheckpointClaims,
	listClaimedIssueKeysFromIndex,
	listIssuesReadyToArchive
};
