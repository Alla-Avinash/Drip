'use strict';

/**
 * Project-owned `@fN` file ids. Each `.p` folder has its own sequence (starts at 0).
 * The knowledge-base file-id pool is not used, and a project number is never rewritten
 * just because a KB note already has the same `@fN`.
 */

const vscode = require('vscode');
const {
	projectFolderPrefixForPath,
	projectFolderUriFromPrefix,
	readProjectRecord,
	writeProjectRecord,
	emptyProjectRecord,
	isProjectShared
} = require('../../peer/projectSidecar');

const FILEID_RE = /^\s*fileid\s*:\s*@f(\d+)\s*$/i;

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @returns {boolean}
 */
function isNoteInProject(kbRootUri, noteUri) {
	if (!kbRootUri || !noteUri) return false;
	return Boolean(projectFolderPrefixForPath(kbRootUri.fsPath, noteUri.fsPath));
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @returns {import('vscode').Uri | null}
 */
function projectFolderUriForNote(kbRootUri, noteUri) {
	if (!kbRootUri || !noteUri) return null;
	const prefix = projectFolderPrefixForPath(kbRootUri.fsPath, noteUri.fsPath);
	if (!prefix) return null;
	return projectFolderUriFromPrefix(kbRootUri, prefix);
}

/**
 * Heading-allocator scope for this note. Empty for knowledge-base notes.
 * Project notes use the `.p` folder prefix so two `@f0` files do not share a pot.
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @returns {string}
 */
function headingAllocScopeForNote(kbRootUri, noteUri) {
	if (!kbRootUri || !noteUri) return '';
	return projectFolderPrefixForPath(kbRootUri.fsPath, noteUri.fsPath) || '';
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @returns {Promise<boolean>}
 */
async function isSharedProjectNote(kbRootUri, noteUri) {
	const folderUri = projectFolderUriForNote(kbRootUri, noteUri);
	if (!folderUri) return false;
	return isProjectShared(folderUri);
}

/**
 * @param {string} text
 * @returns {number | null}
 */
function parseFileIdFromNoteText(text) {
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	for (let i = 0; i < Math.min(lines.length, 40); i++) {
		const line = String(lines[i] || '');
		if (/^\s*---\s*$/.test(line)) break;
		const m = line.match(FILEID_RE);
		if (m) {
			const n = parseInt(m[1], 10);
			return Number.isFinite(n) && n >= 0 ? n : null;
		}
		const md = line.match(/fileid:\s*@f(\d+)/i);
		if (md) {
			const n = parseInt(md[1], 10);
			return Number.isFinite(n) && n >= 0 ? n : null;
		}
	}
	return null;
}

/**
 * Highest `@fN` already written in notes under this project folder.
 * @param {import('vscode').Uri} projectFolderUri
 * @returns {Promise<number>}
 */
async function scanMaxProjectFileId(projectFolderUri) {
	let max = -1;
	async function walk(dir) {
		let entries;
		try {
			entries = await vscode.workspace.fs.readDirectory(dir);
		} catch {
			return;
		}
		for (const [name, type] of entries) {
			if (!name || name.startsWith('.')) continue;
			const uri = vscode.Uri.joinPath(dir, name);
			if (type === vscode.FileType.Directory) {
				await walk(uri);
				continue;
			}
			if (!/\.d\.(txt|md)$/i.test(name)) continue;
			try {
				const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
				const n = parseFileIdFromNoteText(text);
				if (n != null && n > max) max = n;
			} catch {
				/* skip unreadable */
			}
		}
	}
	if (projectFolderUri) await walk(projectFolderUri);
	return max;
}

/**
 * @param {import('vscode').Uri} projectFolderUri
 * @param {number} used
 */
async function bumpProjectFileHighWater(projectFolderUri, used) {
	const n = Math.floor(Number(used));
	if (!projectFolderUri || !Number.isFinite(n) || n < 0) return;
	let rec = await readProjectRecord(projectFolderUri);
	if (!rec) rec = emptyProjectRecord();
	const current = Math.floor(Number(rec.highWater && rec.highWater.file));
	const last = Number.isFinite(current) ? current : -1;
	if (n <= last) return;
	rec.highWater = rec.highWater || {};
	rec.highWater.file = n;
	await writeProjectRecord(projectFolderUri, rec);
}

/**
 * Next unused project-local `@fN` number. First file is 0.
 * @param {import('vscode').Uri} projectFolderUri
 * @returns {Promise<number>}
 */
async function allocateProjectFileNumber(projectFolderUri) {
	let rec = await readProjectRecord(projectFolderUri);
	if (!rec) rec = emptyProjectRecord();
	const stored = Math.floor(Number(rec.highWater && rec.highWater.file));
	let last = Number.isFinite(stored) ? stored : -1;
	const scanned = await scanMaxProjectFileId(projectFolderUri);
	if (scanned > last) last = scanned;
	const n = last + 1;
	rec.highWater = rec.highWater || {};
	rec.highWater.file = n;
	await writeProjectRecord(projectFolderUri, rec);
	return n;
}

/**
 * Allocate from the project pool when this note lives in a `.p` folder.
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @returns {Promise<number | null>}
 */
async function allocateFileNumberForNote(kbRootUri, noteUri) {
	const folderUri = projectFolderUriForNote(kbRootUri, noteUri);
	if (!folderUri) return null;
	return allocateProjectFileNumber(folderUri);
}

/**
 * Remember a claimed project `@fN` so later allocates stay above it.
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @param {number} fileNum
 */
async function recordProjectFileNumber(kbRootUri, noteUri, fileNum) {
	const folderUri = projectFolderUriForNote(kbRootUri, noteUri);
	if (!folderUri) return;
	await bumpProjectFileHighWater(folderUri, fileNum);
}

module.exports = {
	isNoteInProject,
	projectFolderUriForNote,
	headingAllocScopeForNote,
	isSharedProjectNote,
	parseFileIdFromNoteText,
	allocateProjectFileNumber,
	allocateFileNumberForNote,
	recordProjectFileNumber
};
