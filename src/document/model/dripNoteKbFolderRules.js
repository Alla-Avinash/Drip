'use strict';

/**
 * Placement rules for project (`.p`) and feature (`.f`) folders/notes:
 * - Projects: not nested inside another project
 * - Features: only under a project; not nested inside another feature
 * - Features must not sit directly under the KB root (must be under some `.p`)
 * - Converting a folder to feature/project is blocked if it already contains nested features/projects
 */

const path = require('path');
const vscode = require('vscode');
const { isDripProjectFolderName, isProjectIndexFileName } = require('./dripNoteProjectFolder.js');
const { isDripFeatureFolderName, isDripFeatureFileName } = require('./dripNoteFeature.js');
const {
	isProjectIssuesFileName,
	isFeatureInboxFileName
} = require('../project/projectStructureRules');

/**
 * Walk directory ancestors from `startDir` inclusive up to (but not including) kb root.
 * @param {string} kbRootFs
 * @param {string} startDirFs
 * @returns {string[]} basenames, nearest first
 */
function ancestorFolderBasenames(kbRootFs, startDirFs) {
	const root = path.normalize(String(kbRootFs || ''));
	let dir = path.normalize(String(startDirFs || ''));
	const out = [];
	if (!root || !dir) return out;

	const rootLower = root.replace(/\\/g, '/').toLowerCase();
	for (;;) {
		const dirLower = dir.replace(/\\/g, '/').toLowerCase();
		if (dirLower === rootLower) break;
		if (!dirLower.startsWith(rootLower + '/') && !dirLower.startsWith(rootLower + '\\') && dirLower !== rootLower) {
			break;
		}
		out.push(path.basename(dir));
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return out;
}

/**
 * Placement of a path relative to enclosing project/feature folders.
 * Uses parent directories of `fsPath` (does not treat `fsPath` itself as an ancestor).
 *
 * @param {string} kbRootFs
 * @param {string} fsPath file or folder path
 * @returns {{ underProject: boolean, underFeature: boolean }}
 */
function getPathPlacement(kbRootFs, fsPath) {
	const parent = path.dirname(String(fsPath || ''));
	const names = ancestorFolderBasenames(kbRootFs, parent);
	let underProject = false;
	let underFeature = false;
	for (const name of names) {
		if (isDripProjectFolderName(name)) underProject = true;
		if (isDripFeatureFolderName(name)) underFeature = true;
	}
	return { underProject, underFeature };
}

/**
 * May create/convert a project folder at this path (parent must not be under/in a project).
 * @param {string} kbRootFs
 * @param {string} folderFsPath prospective or existing folder path
 */
function canPlaceProjectFolder(kbRootFs, folderFsPath) {
	const { underProject } = getPathPlacement(kbRootFs, folderFsPath);
	return !underProject;
}

/**
 * May create/convert a feature folder/file at this path (must be under a project, not under a feature).
 * @param {string} kbRootFs
 * @param {string} fsPath
 */
function canPlaceFeature(kbRootFs, fsPath) {
	const { underProject, underFeature } = getPathPlacement(kbRootFs, fsPath);
	return underProject && !underFeature;
}

/**
 * @param {string} kbRootFs
 * @param {string} fsPath
 * @returns {'outside' | 'inProject' | 'inFeature'}
 */
function placementZone(kbRootFs, fsPath) {
	const { underProject, underFeature } = getPathPlacement(kbRootFs, fsPath);
	if (underFeature) return 'inFeature';
	if (underProject) return 'inProject';
	return 'outside';
}

/**
 * First nested feature folder or feature note under `folderUri` (not the folder itself).
 * @param {import('vscode').Uri} folderUri
 * @param {string[]} [noteExtensions]
 * @returns {Promise<{ kind: 'folder'|'file', name: string, uri: import('vscode').Uri } | null>}
 */
async function findNestedFeature(folderUri, noteExtensions) {
	if (!folderUri) return null;
	const queue = [folderUri];
	while (queue.length) {
		const dir = queue.shift();
		let entries;
		try {
			entries = await vscode.workspace.fs.readDirectory(dir);
		} catch {
			continue;
		}
		for (const [name, type] of entries) {
			const child = vscode.Uri.joinPath(dir, name);
			if (type === vscode.FileType.Directory) {
				if (isDripFeatureFolderName(name)) {
					return { kind: 'folder', name, uri: child };
				}
				queue.push(child);
				continue;
			}
			if (type === vscode.FileType.File && isDripFeatureFileName(name, noteExtensions)) {
				return { kind: 'file', name, uri: child };
			}
		}
	}
	return null;
}

/**
 * First nested project folder under `folderUri` (not the folder itself).
 * @param {import('vscode').Uri} folderUri
 * @returns {Promise<{ kind: 'folder', name: string, uri: import('vscode').Uri } | null>}
 */
async function findNestedProject(folderUri) {
	if (!folderUri) return null;
	const queue = [folderUri];
	while (queue.length) {
		const dir = queue.shift();
		let entries;
		try {
			entries = await vscode.workspace.fs.readDirectory(dir);
		} catch {
			continue;
		}
		for (const [name, type] of entries) {
			if (type !== vscode.FileType.Directory) continue;
			const child = vscode.Uri.joinPath(dir, name);
			if (isDripProjectFolderName(name)) {
				return { kind: 'folder', name, uri: child };
			}
			queue.push(child);
		}
	}
	return null;
}

/**
 * True if this folder may be converted to a feature (placement OK and no feature descendants).
 * @param {string} kbRootFs
 * @param {import('vscode').Uri} folderUri
 * @param {string[]} [noteExtensions]
 */
async function canConvertFolderToFeature(kbRootFs, folderUri, noteExtensions) {
	if (!folderUri || !canPlaceFeature(kbRootFs, folderUri.fsPath)) return false;
	const hit = await findNestedFeature(folderUri, noteExtensions);
	return !hit;
}

/**
 * True if this folder may be converted to a project (placement OK and no project descendants).
 * @param {string} kbRootFs
 * @param {import('vscode').Uri} folderUri
 */
async function canConvertFolderToProject(kbRootFs, folderUri) {
	if (!folderUri || !canPlaceProjectFolder(kbRootFs, folderUri.fsPath)) return false;
	const hit = await findNestedProject(folderUri);
	return !hit;
}

/**
 * Allowed direct children of a project folder (`Name.p/`).
 * See `.cursor/rules/context/drip-project-structure.mdc`.
 *
 * @param {string} childBasename
 * @param {vscode.FileType | number} fileType
 * @returns {boolean}
 */
function isAllowedProjectFolderChild(childBasename, fileType) {
	const name = String(childBasename || '').trim();
	if (!name || name === '.' || name === '..') return false;
	const isDir =
		fileType === vscode.FileType.Directory ||
		(typeof fileType === 'number' && (fileType & vscode.FileType.Directory) !== 0);

	if (isDir) {
		return isDripFeatureFolderName(name);
	}
	if (isProjectIssuesFileName(name)) return true;
	if (isProjectIndexFileName(name) && /\.p\.d\.(txt|md)$/i.test(name)) return true;
	if (isDripFeatureFileName(name)) return true;
	if (isFeatureInboxFileName(name)) return false;
	return false;
}

/**
 * @param {string} childBasename
 * @param {vscode.FileType | number} fileType
 * @returns {string | null} null if allowed
 */
function projectFolderChildRejectReason(childBasename, fileType) {
	if (isAllowedProjectFolderChild(childBasename, fileType)) return null;
	return (
		`Project folders may only contain: the project index (_Name.p.d.txt / _Name.p.d.md), ` +
		`_issues.d.txt, and feature folders (*.f) or feature notes (*.f.d.txt).`
	);
}

/**
 * Plain note files (`*.d.txt` / `*.md`) must not be created directly inside a project folder
 * (`Name.p/`) nor in any non-feature folder nested under it. The project root and its plain
 * subfolders are reserved for the index note, `_issues.d.txt`, and feature folders/files.
 * Notes are only allowed inside a feature folder (`.f`) or outside any project.
 *
 * @param {string} kbRootFs knowledge base root path
 * @param {string} folderFsPath target folder path
 * @returns {string | null} block reason, or null when creation is allowed here
 */
function noteCreationBlockReason(kbRootFs, folderFsPath) {
	// Nearest-first basenames of the target folder and all its ancestors up to the KB root.
	const names = ancestorFolderBasenames(kbRootFs, folderFsPath);
	for (const name of names) {
		if (isDripFeatureFolderName(name)) return null; // inside a feature folder → allowed
		if (isDripProjectFolderName(name)) {
			return (
				'Notes can only be created inside a feature folder (.f). ' +
				'They are not allowed directly in a project folder (.p) or its plain subfolders.'
			);
		}
	}
	return null; // outside any project → allowed
}

module.exports = {
	ancestorFolderBasenames,
	getPathPlacement,
	canPlaceProjectFolder,
	canPlaceFeature,
	placementZone,
	findNestedFeature,
	findNestedProject,
	canConvertFolderToFeature,
	canConvertFolderToProject,
	isAllowedProjectFolderChild,
	projectFolderChildRejectReason,
	noteCreationBlockReason
};
