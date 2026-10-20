'use strict';

/**
 * Project-scoped durable allocators for `f-#` and `i-#`.
 *
 * Issues: next id = max(live project issues ∪ session reservations) + 1.
 * Deleting the highest issue (e.g. i-10) reuses that number after the index drops it.
 * Existing issues are never renumbered. Middle gaps are not filled (latest / high-water).
 *
 * Features: monotonic counter in `index_meta` (bump-only).
 *
 * Meta key: `project_entity_alloc_<normalizedProjectPrefix>`
 * Value JSON: `{ "nextIssue": N, "nextFeature": M }` — nextIssue is a cache only.
 */

const { openDripProjectsDb } = require('../../indexing/dripProjectDb');
const {
	formatIssueEntityId,
	formatFeatureEntityId,
	normalizeIssueEntityId,
	normalizeFeatureEntityId
} = require('./projectStructureRules');

/** @type {Map<string, Set<number>>} project alloc key → ids handed out but maybe not indexed yet */
const sessionReservedIssues = new Map();

/**
 * @param {string} projectFolderPrefix e.g. `App.p/`
 * @returns {string}
 */
function allocMetaKey(projectFolderPrefix) {
	const p = String(projectFolderPrefix || '')
		.replace(/\\/g, '/')
		.replace(/\/+$/, '')
		.toLowerCase();
	return `project_entity_alloc_${p || '_unknown'}`;
}

/**
 * @param {string} projectFolderPrefix
 * @returns {string} SQL LIKE pattern for files under the project
 */
function projectPathLike(projectFolderPrefix) {
	const p = String(projectFolderPrefix || '')
		.replace(/\\/g, '/')
		.replace(/\/+$/, '');
	return `${p}/%`;
}

/**
 * @param {import('../../indexing/db/dripSqlite').DripSqliteDatabase | { native?: import('better-sqlite3').Database, prepare?: Function }} db
 * @param {string} key
 * @returns {{ nextIssue: number, nextFeature: number }}
 */
function readAlloc(db, key) {
	let raw = '';
	try {
		if (db && db.native && typeof db.native.prepare === 'function') {
			const row = db.native.prepare(`SELECT value FROM index_meta WHERE key = ?`).get(key);
			raw = row && row.value != null ? String(row.value) : '';
		} else if (db && typeof db.prepare === 'function') {
			const stmt = db.prepare(`SELECT value FROM index_meta WHERE key = ?`);
			stmt.bind([key]);
			if (stmt.step()) {
				const row = stmt.get();
				raw = row && row[0] != null ? String(row[0]) : '';
			}
			stmt.free();
		}
	} catch {
		raw = '';
	}
	let nextIssue = 1;
	let nextFeature = 1;
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			const ni = Number(parsed && parsed.nextIssue);
			const nf = Number(parsed && parsed.nextFeature);
			if (Number.isFinite(ni) && ni >= 1) nextIssue = Math.floor(ni);
			if (Number.isFinite(nf) && nf >= 1) nextFeature = Math.floor(nf);
		} catch {
			/* keep defaults */
		}
	}
	return { nextIssue, nextFeature };
}

/**
 * @param {import('../../indexing/db/dripSqlite').DripSqliteDatabase} db
 * @param {string} key
 * @param {{ nextIssue: number, nextFeature: number }} alloc
 */
function writeAlloc(db, key, alloc) {
	const value = JSON.stringify({
		nextIssue: Math.max(1, Math.floor(Number(alloc.nextIssue) || 1)),
		nextFeature: Math.max(1, Math.floor(Number(alloc.nextFeature) || 1))
	});
	if (db && db.native && typeof db.native.prepare === 'function') {
		db.native.prepare(`INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)`).run(key, value);
		return;
	}
	db.run(`INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)`, [key, value]);
}

/**
 * Parse an issue number from an indexed heading title (`i-12 Fix` or `.i-12 Fix`).
 * @param {string} title
 * @returns {number | null}
 */
function issueNumberFromTitle(title) {
	const t = String(title || '').trim();
	const m = t.match(/^\.?(i)-(\d+)\b/i);
	if (!m) return null;
	const n = parseInt(m[2], 10);
	return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * Live issue numbers under a project (from `issues` table when present, else headings).
 * @param {import('../../indexing/db/dripSqlite').DripSqliteDatabase} db
 * @param {string} projectFolderPrefix
 * @returns {Set<number>}
 */
function liveIssueNumbers(db, projectFolderPrefix) {
	/** @type {Set<number>} */
	const used = new Set();
	const prefix = String(projectFolderPrefix || '')
		.replace(/\\/g, '/')
		.replace(/\/+$/, '');
	const normalized = prefix ? prefix + '/' : '';

	try {
		if (db && db.native && typeof db.native.prepare === 'function') {
			const project = db.native
				.prepare(
					`SELECT project_id AS projectId FROM projects
					 WHERE folder_prefix = ? OR folder_prefix = ?`
				)
				.get(normalized, prefix);
			if (project && project.projectId != null) {
				const rows = db.native
					.prepare(
						`SELECT issue_key AS issueKey FROM issue_metadata WHERE project_id = ? AND issue_key IS NOT NULL`
					)
					.all(Number(project.projectId));
				for (const row of rows || []) {
					const m = String(row.issueKey || '')
						.trim()
						.match(/^i-(\d+)$/i);
					if (m) {
						const n = parseInt(m[1], 10);
						if (Number.isFinite(n) && n >= 1) used.add(n);
					}
				}
				return used;
			}
		}
	} catch {
		/* fall through to title scan */
	}

	const like = projectPathLike(projectFolderPrefix);
	/** @type {{ title?: string }[]} */
	let rows = [];
	try {
		if (db && db.native && typeof db.native.prepare === 'function') {
			rows = db.native
				.prepare(
					`SELECT h.title AS title
					 FROM headings h
					 JOIN files f ON f.id = h.file_id
					 JOIN metadata_types mt ON mt.metadata_type_id = h.metadata_type_id
					 WHERE LOWER(mt.metadata_type_name) = 'issue'
					   AND REPLACE(f.path, '\\', '/') LIKE ?`
				)
				.all(like);
		}
	} catch {
		rows = [];
	}
	for (const row of rows || []) {
		const n = issueNumberFromTitle(row && row.title);
		if (n != null) used.add(n);
	}
	return used;
}

/**
 * @param {import('../../indexing/db/dripSqlite').DripSqliteDatabase} db
 * @param {string} projectFolderPrefix
 * @returns {number}
 */
function maxLiveIssueNumber(db, projectFolderPrefix) {
	let max = 0;
	for (const n of liveIssueNumbers(db, projectFolderPrefix)) {
		if (n > max) max = n;
	}
	return max;
}

/**
 * Bump feature counter upward if scanned max ids are ahead. Sync issue cache to liveMax+1.
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} projectFolderPrefix
 * @param {{ maxIssue?: number, maxFeature?: number }} seen
 */
async function ensureAllocAtLeast(kbRootUri, projectFolderPrefix, seen) {
	const handle = await openDripProjectsDb(kbRootUri);
	try {
		const key = allocMetaKey(projectFolderPrefix);
		const cur = readAlloc(handle.db, key);
		const liveMax = maxLiveIssueNumber(handle.db, projectFolderPrefix);
		const maxI = Math.max(liveMax, Math.floor(Number(seen.maxIssue) || 0));
		const maxF = Math.max(0, Math.floor(Number(seen.maxFeature) || 0));
		const next = {
			nextIssue: Math.max(1, maxI + 1),
			nextFeature: Math.max(cur.nextFeature, maxF + 1)
		};
		writeAlloc(handle.db, key, next);
		await handle.save();
		return next;
	} finally {
		handle.close();
	}
}

/**
 * Next issue id = max(live ∪ session-reserved) + 1.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} projectFolderPrefix
 * @returns {Promise<string>} normalized `i-N`
 */
async function allocateNextIssueEntityId(kbRootUri, projectFolderPrefix) {
	const handle = await openDripProjectsDb(kbRootUri);
	try {
		const key = allocMetaKey(projectFolderPrefix);
		const cur = readAlloc(handle.db, key);
		const used = liveIssueNumbers(handle.db, projectFolderPrefix);

		let reserved = sessionReservedIssues.get(key);
		if (!reserved) {
			reserved = new Set();
			sessionReservedIssues.set(key, reserved);
		}
		// Drop reservations that are now visible in the index (or were deleted and
		// are no longer at/above the live high-water — reclaimed).
		const liveMax = maxLiveIssueNumber(handle.db, projectFolderPrefix);
		for (const r of [...reserved]) {
			if (used.has(r)) reserved.delete(r);
			else if (r > liveMax) {
				/* keep — pending write not indexed yet */
			} else {
				reserved.delete(r);
			}
		}
		// If a reserved id above liveMax was deleted from disk before indexing,
		// it still blocks; clear reserved ids that are not in `used` when liveMax
		// has been stable — only keep reserved > liveMax for the race window.
		// (Already handled: reserved > liveMax kept; others cleared.)

		let max = liveMax;
		for (const r of reserved) {
			if (r > max) max = r;
		}
		const n = max + 1;
		reserved.add(n);

		writeAlloc(handle.db, key, { nextIssue: n + 1, nextFeature: cur.nextFeature });
		await handle.save();
		return formatIssueEntityId(n);
	} finally {
		handle.close();
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} projectFolderPrefix
 * @returns {Promise<string>} normalized `f-N`
 */
async function allocateNextFeatureEntityId(kbRootUri, projectFolderPrefix) {
	const handle = await openDripProjectsDb(kbRootUri);
	try {
		const key = allocMetaKey(projectFolderPrefix);
		const cur = readAlloc(handle.db, key);
		const id = formatFeatureEntityId(cur.nextFeature);
		writeAlloc(handle.db, key, { nextIssue: cur.nextIssue, nextFeature: cur.nextFeature + 1 });
		await handle.save();
		return id;
	} finally {
		handle.close();
	}
}

module.exports = {
	allocMetaKey,
	readAlloc,
	writeAlloc,
	liveIssueNumbers,
	maxLiveIssueNumber,
	issueNumberFromTitle,
	ensureAllocAtLeast,
	allocateNextIssueEntityId,
	allocateNextFeatureEntityId,
	normalizeIssueEntityId,
	normalizeFeatureEntityId
};
