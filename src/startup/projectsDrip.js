'use strict';

/**
 * The Projects home folder (`.drip.project`) at the knowledge-base root.
 * Every `.p` folder lives here. Hidden from the Knowledge Base tree.
 */

const path = require('path');
const vscode = require('vscode');
const { PROJECTS_DIR } = require('../shared/constants');

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {import('vscode').Uri}
 */
function projectsHomeUri(kbRootUri) {
	return vscode.Uri.joinPath(kbRootUri, PROJECTS_DIR);
}

/**
 * @param {string} name
 */
function isProjectsHomeName(name) {
	return String(name || '') === PROJECTS_DIR;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} currentUri
 * @param {string} name
 */
function isHiddenProjectsHomeFolder(kbRootUri, currentUri, name) {
	if (!isProjectsHomeName(name)) return false;
	return path.resolve(kbRootUri.fsPath) === path.resolve(currentUri.fsPath);
}

/**
 * A `.p` folder may only sit directly under `.drip.project`.
 * @param {string} kbRootFs
 * @param {string} folderFsPath
 */
function isDirectChildOfProjectsHome(kbRootFs, folderFsPath) {
	const root = path.resolve(String(kbRootFs || ''));
	const folder = path.resolve(String(folderFsPath || ''));
	if (!root || !folder) return false;
	const parent = path.dirname(folder);
	const grand = path.dirname(parent);
	return path.basename(parent) === PROJECTS_DIR && path.resolve(grand) === root;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<import('vscode').Uri>}
 */
async function ensureProjectsHome(kbRootUri) {
	if (!kbRootUri) throw new Error('No knowledge base folder selected.');
	const home = projectsHomeUri(kbRootUri);
	try {
		await vscode.workspace.fs.createDirectory(home);
	} catch {
		/* already exists */
	}
	return home;
}

/**
 * Folder prefix used by the project index / share layer, e.g. `.drip.project/App.p/`.
 * @param {string} projectFolderName
 */
function projectPrefixUnderHome(projectFolderName) {
	const name = String(projectFolderName || '').replace(/\/+$/, '');
	return `${PROJECTS_DIR}/${name}/`;
}

module.exports = {
	projectsHomeUri,
	isProjectsHomeName,
	isHiddenProjectsHomeFolder,
	isDirectChildOfProjectsHome,
	ensureProjectsHome,
	projectPrefixUnderHome
};
