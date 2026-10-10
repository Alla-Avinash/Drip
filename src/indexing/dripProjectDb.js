'use strict';

/**
 * Open / init / reset the project-scoped index at `<kb>/.dripindex/projects.drip`.
 *
 * `projects.drip` stores the project/feature/issue hierarchy and project headings,
 * kept separate from `index.drip` so project headings never surface in global search.
 * The shared `files` registry and the `@fN` file-id counter stay in `index.drip`.
 */

const vscode = require('vscode');
const { PROJECTS_FILE, getDripIndexRootUri } = require('../startup/initializeDripIndex');
const { ensureDripProjectSchema } = require('./dbSchema/dripProjectSchema');
const { openDripSqlite } = require('./db/dripSqlite');

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {import('vscode').Uri}
 */
function getProjectsDripUri(kbRootUri) {
	return vscode.Uri.joinPath(getDripIndexRootUri(kbRootUri), PROJECTS_FILE);
}

/**
 * Open (or create) `projects.drip`, ensuring its schema.
 * @param {import('vscode').Uri} kbRootUri
 */
function openDripProjectsDb(kbRootUri) {
	const uri = getProjectsDripUri(kbRootUri);
	const db = openDripSqlite(uri.fsPath);
	ensureDripProjectSchema(db);

	return {
		db,
		uri,
		/** File-backed DB persists on each write; keep for call-site compatibility. */
		async save() {},
		close() {
			db.close();
		}
	};
}

/**
 * Create an empty `projects.drip` with schema when missing.
 * @param {import('vscode').Uri} kbRootUri
 */
async function initEmptyDripProjectsFile(kbRootUri) {
	const handle = openDripProjectsDb(kbRootUri);
	try {
		await handle.save();
	} finally {
		handle.close();
	}
}

/**
 * Delete `<kb>/.dripindex/projects.drip` and create a fresh empty schema.
 * @param {import('vscode').Uri} kbRootUri
 */
async function resetDripProjectsDatabase(kbRootUri) {
	const uri = getProjectsDripUri(kbRootUri);
	try {
		await vscode.workspace.fs.delete(uri, { useTrash: false });
	} catch {
		// missing is fine
	}
	await initEmptyDripProjectsFile(kbRootUri);
}

module.exports = {
	getProjectsDripUri,
	openDripProjectsDb,
	initEmptyDripProjectsFile,
	resetDripProjectsDatabase
};
