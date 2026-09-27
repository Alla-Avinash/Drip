'use strict';

/**
 * Drip project folders: any KB directory whose name ends with `.p`.
 * Holds a project index note `_<displayName>.p.d.txt`.
 */

const path = require('path');

const PROJECT_FOLDER_EXT = '.p';

/**
 * @param {string} folderBasename
 * @returns {boolean}
 */
function isDripProjectFolderName(folderBasename) {
	const name = String(folderBasename || '').trim();
	if (!name) return false;
	return name.toLowerCase().endsWith(PROJECT_FOLDER_EXT);
}

/**
 * Display / h0 title: folder basename without trailing `.p`.
 * @param {string} folderBasename
 * @returns {string}
 */
function projectDisplayNameFromFolderName(folderBasename) {
	const name = String(folderBasename || '').trim();
	if (!name) return 'project';
	if (name.toLowerCase().endsWith(PROJECT_FOLDER_EXT)) {
		const stem = name.slice(0, -PROJECT_FOLDER_EXT.length).trim();
		return stem || 'project';
	}
	return name;
}

/**
 * Strip characters illegal in Windows/macOS/Linux file names.
 * @param {string} name
 * @returns {string}
 */
function sanitizeProjectIndexStem(name) {
	const cleaned = String(name || '')
		.trim()
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
		.replace(/\.+$/g, '')
		.trim();
	return cleaned || 'project';
}

/**
 * Project index note basename: `_Research.p.d.txt` for folder `Research.p`.
 * @param {string} folderBasename
 * @returns {string}
 */
function projectIndexFileName(folderBasename) {
	const stem = sanitizeProjectIndexStem(projectDisplayNameFromFolderName(folderBasename));
	return `_${stem}.p.d.txt`;
}

/**
 * True if basename is a project or feature folder index note:
 * `_Name.p.d.txt` / `_Name.f.d.txt`.
 * @param {string} fileBasename
 * @returns {boolean}
 */
function isProjectIndexFileName(fileBasename) {
	const base = String(fileBasename || '').trim();
	return /^_.+\.(p|f)\.d\.txt$/i.test(base);
}

/**
 * Index note that must not be deleted alone — parent folder is `.p` or `.f`.
 * @param {string} fileFsPath
 * @returns {boolean}
 */
function isProtectedFolderIndexNotePath(fileFsPath) {
	const fsPath = String(fileFsPath || '');
	if (!fsPath) return false;
	const base = path.basename(fsPath);
	if (!isProjectIndexFileName(base)) return false;
	const parentBase = path.basename(path.dirname(fsPath));
	return (
		isDripProjectFolderName(parentBase) ||
		String(parentBase || '')
			.trim()
			.toLowerCase()
			.endsWith('.f')
	);
}

module.exports = {
	PROJECT_FOLDER_EXT,
	isDripProjectFolderName,
	projectDisplayNameFromFolderName,
	projectIndexFileName,
	isProjectIndexFileName,
	isProtectedFolderIndexNotePath,
	sanitizeProjectIndexStem
};
