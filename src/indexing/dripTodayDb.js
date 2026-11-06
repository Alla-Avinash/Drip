'use strict';

/**
 * Open / init / reset the Today-scoped index at `<kb>/.dripindex/today.drip`.
 *
 * Today notes live under `.drip.dailynotes/` and are indexed here only — never in
 * `index.drip` or `projects.drip`. Schema matches the document index (concept/task).
 */

const vscode = require('vscode');
const { TODAY_FILE, getDripIndexRootUri } = require('../startup/initializeDripIndex');
const { ensureDripIndexSchema } = require('./dbSchema/dripIndexSchema');
const { openDripSqlite } = require('./db/dripSqlite');

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {import('vscode').Uri}
 */
function getTodayDripUri(kbRootUri) {
	return vscode.Uri.joinPath(getDripIndexRootUri(kbRootUri), TODAY_FILE);
}

/**
 * Open (or create) `today.drip`, ensuring its schema.
 * @param {import('vscode').Uri} kbRootUri
 */
function openDripTodayDb(kbRootUri) {
	const uri = getTodayDripUri(kbRootUri);
	const db = openDripSqlite(uri.fsPath);
	ensureDripIndexSchema(db);

	return {
		db,
		uri,
		async save() {},
		close() {
			db.close();
		}
	};
}

/**
 * Create an empty `today.drip` with schema when missing.
 * @param {import('vscode').Uri} kbRootUri
 */
async function initEmptyDripTodayFile(kbRootUri) {
	const handle = openDripTodayDb(kbRootUri);
	try {
		await handle.save();
	} finally {
		handle.close();
	}
}

/**
 * Delete `<kb>/.dripindex/today.drip` and create a fresh empty schema.
 * @param {import('vscode').Uri} kbRootUri
 */
async function resetDripTodayDatabase(kbRootUri) {
	const uri = getTodayDripUri(kbRootUri);
	try {
		await vscode.workspace.fs.delete(uri, { useTrash: false });
	} catch {
		// missing is fine
	}
	await initEmptyDripTodayFile(kbRootUri);
}

module.exports = {
	getTodayDripUri,
	openDripTodayDb,
	initEmptyDripTodayFile,
	resetDripTodayDatabase
};
