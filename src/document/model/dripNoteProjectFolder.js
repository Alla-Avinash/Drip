'use strict';

/**
 * Drip project folders: any KB directory whose name ends with `.p`.
 * Holds a project index note `_<displayName>.p.d.txt` (or `.p.d.md` when the
 * default new-note format is `.d.md`).
 */

const path = require('path');
const { getDefaultNewNoteExtension } = require('./dripNoteFileTypes.js');

const PROJECT_FOLDER_EXT = '.p';

/** Project-scoped subfolders: concepts (c-N), decisions (d-N), and archived issues. */
const CONCEPTS_SUBFOLDER_NAME = '_concepts';
const DECISIONS_SUBFOLDER_NAME = '_decisions';
const ARCHIVE_SUBFOLDER_NAME = '_archive';

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
 * Project index note basename: `_Research.p.d.txt` for folder `Research.p`
 * (or `_Research.p.d.md` when the default new-note format is `.d.md`).
 * @param {string} folderBasename
 * @returns {string}
 */
function projectIndexFileName(folderBasename) {
	const stem = sanitizeProjectIndexStem(projectDisplayNameFromFolderName(folderBasename));
	const ext = getDefaultNewNoteExtension() === '.d.md' ? '.d.md' : '.d.txt';
	return `_${stem}.p${ext}`;
}

/**
 * True if basename is a project or feature folder index note:
 * `_Name.p.d.txt` / `_Name.f.d.txt` / `_Name.p.d.md` / `_Name.f.d.md`.
 * @param {string} fileBasename
 * @returns {boolean}
 */
function isProjectIndexFileName(fileBasename) {
	const base = String(fileBasename || '').trim();
	return /^_.+\.(p|f)\.d\.(txt|md)$/i.test(base);
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

/**
 * True if fsPath sits somewhere under a project (`.p`) or feature (`.f`) folder.
 * Walks up from the file's own directory, so a note nested anywhere inside a project
 * counts as "in a project" — this drives which metadata types / tags graph it uses.
 * @param {string} fsPath
 * @returns {boolean}
 */
function isPathInsideProjectFolder(fsPath) {
	const file = String(fsPath || '');
	if (!file) return false;
	let dir = path.dirname(file);
	while (dir && dir !== path.dirname(dir)) {
		const base = String(path.basename(dir) || '').trim().toLowerCase();
		if (base.endsWith('.p') || base.endsWith('.f')) return true;
		dir = path.dirname(dir);
	}
	return false;
}

/**
 * Special subfolder type for a note path: `_concepts` → `concept`, `_decisions` → `decision`.
 * Only counts when that subfolder sits inside a project (`.p`) / feature (`.f`) folder —
 * a stray `_concepts` folder outside a project means nothing. Returns null otherwise.
 * @param {string} fsPath
 * @returns {'concept' | 'decision' | null}
 */
function specialProjectSubfolderTypeIdForPath(fsPath) {
	const file = String(fsPath || '');
	if (!file) return null;
	let dir = path.dirname(file);
	while (dir && dir !== path.dirname(dir)) {
		const base = String(path.basename(dir) || '').trim().toLowerCase();
		if (base === CONCEPTS_SUBFOLDER_NAME) return 'concept';
		if (base === DECISIONS_SUBFOLDER_NAME) return 'decision';
		// Stop at the project/feature boundary — subfolders only count inside one.
		if (base.endsWith('.p') || base.endsWith('.f')) return null;
		dir = path.dirname(dir);
	}
	return null;
}

module.exports = {
	PROJECT_FOLDER_EXT,
	CONCEPTS_SUBFOLDER_NAME,
	DECISIONS_SUBFOLDER_NAME,
	ARCHIVE_SUBFOLDER_NAME,
	isDripProjectFolderName,
	projectDisplayNameFromFolderName,
	projectIndexFileName,
	isProjectIndexFileName,
	isProtectedFolderIndexNotePath,
	isPathInsideProjectFolder,
	specialProjectSubfolderTypeIdForPath,
	sanitizeProjectIndexStem
};
