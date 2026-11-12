'use strict';

/**
 * Open / init / reset **per-project** indexes under `<kb>/.dripindex/projects/`.
 *
 * Each `.p` project gets its own SQLite file (`….drip`). That DB holds only that
 * project's features, issues, headings, and project-zone embeddings — so callers
 * open the right file by folder prefix instead of filtering a shared table by
 * `project_id` across the whole knowledge base.
 *
 * The shared `files` registry and `@fN` minting stay in `index.drip`.
 */

const vscode = require('vscode');
const path = require('path');
const { getDripIndexRootUri } = require('../startup/initializeDripIndex');
const { ensureDripProjectSchema } = require('./dbSchema/dripProjectSchema');
const { openDripSqlite } = require('./db/dripSqlite');

/** Directory under `.dripindex/` that holds one `.drip` file per project. */
const PROJECTS_DIR = 'projects';

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {import('vscode').Uri}
 */
function getProjectsIndexDirUri(kbRootUri) {
	return vscode.Uri.joinPath(getDripIndexRootUri(kbRootUri), PROJECTS_DIR);
}

/**
 * Encode a project folder prefix into a safe single-segment file stem.
 * `sample/kjh.p/` → `sample--kjh.p`
 * @param {string} folderPrefix
 * @returns {string}
 */
function projectDbStemFromPrefix(folderPrefix) {
	const p = String(folderPrefix || '')
		.replace(/\\/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '');
	if (!p) return '';
	return p.replace(/\//g, '--').replace(/[<>:"|?*\x00-\x1f]/g, '_');
}

/**
 * @param {string} stem file stem without `.drip`
 * @returns {string} folder prefix with trailing `/`
 */
function projectPrefixFromDbStem(stem) {
	const s = String(stem || '').trim();
	if (!s) return '';
	return s.replace(/--/g, '/') + '/';
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix e.g. `sample/kjh.p/`
 * @returns {import('vscode').Uri}
 */
function getProjectDripUri(kbRootUri, folderPrefix) {
	const stem = projectDbStemFromPrefix(folderPrefix);
	if (!stem) {
		throw new Error('getProjectDripUri: folderPrefix is required');
	}
	return vscode.Uri.joinPath(getProjectsIndexDirUri(kbRootUri), `${stem}.drip`);
}

/**
 * Ensure `<kb>/.dripindex/projects/` exists (no shared mega-DB file).
 * @param {import('vscode').Uri} kbRootUri
 */
async function ensureProjectsIndexDir(kbRootUri) {
	const dir = getProjectsIndexDirUri(kbRootUri);
	await vscode.workspace.fs.createDirectory(dir);
	return dir;
}

/**
 * Open (or create) the SQLite index for one project folder.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix e.g. `sample/kjh.p/` or `sample/kjh.p`
 * @returns {{ db: import('./db/dripSqlite').DripSqliteDatabase, uri: import('vscode').Uri, folderPrefix: string, save: () => Promise<void>, close: () => void }}
 */
function openDripProjectsDb(kbRootUri, folderPrefix) {
	const prefix = String(folderPrefix || '')
		.replace(/\\/g, '/')
		.replace(/\/+$/, '');
	if (!prefix) {
		throw new Error('openDripProjectsDb: folderPrefix is required (one DB per project)');
	}
	const normalized = prefix + '/';
	const uri = getProjectDripUri(kbRootUri, normalized);
	// Parent dir must exist before better-sqlite3 creates the file.
	try {
		const fs = require('fs');
		fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
	} catch {
		/* createDirectory may race; open will surface real errors */
	}
	const db = openDripSqlite(uri.fsPath);
	ensureDripProjectSchema(db);

	return {
		db,
		uri,
		folderPrefix: normalized,
		async save() {},
		close() {
			db.close();
		}
	};
}

/**
 * Open the project DB that owns this KB-relative note path.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} noteRelPath
 */
function openDripProjectsDbForNotePath(kbRootUri, noteRelPath) {
	// Lazy require avoids a cycle with projectIndex.js (which opens project DBs).
	const { projectFolderPrefixFromPath } = require('./projectIndex');
	const prefix = projectFolderPrefixFromPath(noteRelPath);
	if (!prefix) {
		throw new Error(`openDripProjectsDbForNotePath: not under a project: ${noteRelPath}`);
	}
	return openDripProjectsDb(kbRootUri, prefix);
}

/**
 * List every per-project DB file under `.dripindex/projects/`.
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<{ stem: string, folderPrefix: string, uri: import('vscode').Uri }[]>}
 */
async function listProjectDbEntries(kbRootUri) {
	const dir = getProjectsIndexDirUri(kbRootUri);
	/** @type {{ stem: string, folderPrefix: string, uri: import('vscode').Uri }[]} */
	const out = [];
	let entries = [];
	try {
		entries = await vscode.workspace.fs.readDirectory(dir);
	} catch {
		return out;
	}
	for (const [name, type] of entries) {
		if (type !== vscode.FileType.File) continue;
		if (!/\.drip$/i.test(name)) continue;
		const stem = name.replace(/\.drip$/i, '');
		const folderPrefix = projectPrefixFromDbStem(stem);
		if (!folderPrefix) continue;
		out.push({
			stem,
			folderPrefix,
			uri: vscode.Uri.joinPath(dir, name)
		});
	}
	return out;
}

/**
 * Open each project DB, run `fn`, then close. Stops nothing on per-DB errors (logs).
 * @param {import('vscode').Uri} kbRootUri
 * @param {(handle: ReturnType<typeof openDripProjectsDb>) => void | Promise<void>} fn
 */
async function forEachProjectDb(kbRootUri, fn) {
	const entries = await listProjectDbEntries(kbRootUri);
	for (const e of entries) {
		let handle;
		try {
			handle = openDripProjectsDb(kbRootUri, e.folderPrefix);
			await fn(handle);
		} catch (err) {
			console.warn('[DRIP] project DB visit failed', e.folderPrefix, err && err.message);
		} finally {
			try {
				if (handle) handle.close();
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * Ensure the projects index directory exists (fresh KB). Does not create a blank DB.
 * @param {import('vscode').Uri} kbRootUri
 */
async function initEmptyDripProjectsFile(kbRootUri) {
	await ensureProjectsIndexDir(kbRootUri);
}

/**
 * Delete all per-project DBs and recreate the empty `projects/` directory.
 * Also removes a legacy shared `.dripindex/projects.drip` file if present.
 * No migration — caller must reindex.
 * @param {import('vscode').Uri} kbRootUri
 */
async function resetDripProjectsDatabase(kbRootUri) {
	const dir = getProjectsIndexDirUri(kbRootUri);
	try {
		await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
	} catch {
		/* missing is fine */
	}
	// Pre-split layout used one shared projects.drip next to index.drip.
	try {
		const legacy = vscode.Uri.joinPath(getDripIndexRootUri(kbRootUri), 'projects.drip');
		await vscode.workspace.fs.delete(legacy, { useTrash: false });
	} catch {
		/* missing is fine */
	}
	await ensureProjectsIndexDir(kbRootUri);
}

/**
 * Delete one project's DB file (after the folder is removed from disk).
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function deleteProjectDatabase(kbRootUri, folderPrefix) {
	const prefix = String(folderPrefix || '')
		.replace(/\\/g, '/')
		.replace(/\/+$/, '');
	if (!prefix) return;
	const uri = getProjectDripUri(kbRootUri, prefix + '/');
	try {
		await vscode.workspace.fs.delete(uri, { useTrash: false });
	} catch {
		/* missing is fine */
	}
}

module.exports = {
	PROJECTS_DIR,
	getProjectsIndexDirUri,
	getProjectDripUri,
	projectDbStemFromPrefix,
	projectPrefixFromDbStem,
	ensureProjectsIndexDir,
	openDripProjectsDb,
	openDripProjectsDbForNotePath,
	listProjectDbEntries,
	forEachProjectDb,
	initEmptyDripProjectsFile,
	resetDripProjectsDatabase,
	deleteProjectDatabase
};
