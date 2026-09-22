'use strict';

/**
 * Deterministic embedding input text for a KB folder.
 *
 * Policy (keep simple; matches product decision):
 * - Folder path (relative to KB root)
 * - Folder's h0 title — h0 of the folder's representative note, if any
 *
 * Representative note (first match wins):
 * 1. `{folder}/{folderBasename}.d.txt` (or other KB note extension)
 * 2. Otherwise none → h0 title omitted (path alone)
 *
 * Root folder path is `.`
 */

const path = require('path');

/**
 * @param {string | null | undefined} folderPath
 * @returns {string} normalized relative folder path (`.` for KB root)
 */
function normalizeFolderPath(folderPath) {
	let p = String(folderPath || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '')
		.trim();
	if (!p || p === '.') {
		return '.';
	}
	return p;
}

/**
 * @param {string} folderPath normalized
 * @returns {string}
 */
function folderBasename(folderPath) {
	const p = normalizeFolderPath(folderPath);
	if (p === '.') {
		return '.';
	}
	const parts = p.split('/').filter(Boolean);
	return parts[parts.length - 1] || '.';
}

/**
 * @param {{ folderPath?: string, h0Title?: string }} input
 * @returns {string}
 */
function buildFolderEmbeddingText(input) {
	const folderPath = normalizeFolderPath(input && input.folderPath);
	const h0Title = String(input && input.h0Title != null ? input.h0Title : '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!h0Title) {
		return folderPath;
	}
	return `${folderPath}\n${h0Title}`;
}

/**
 * Parent directory of a note relative path (`.` for notes at KB root).
 * @param {string} noteRelPath
 * @returns {string}
 */
function parentFolderPathOfNote(noteRelPath) {
	const rel = String(noteRelPath || '')
		.replace(/\\/g, '/')
		.replace(/^\/+/, '');
	const dir = path.posix.dirname(rel);
	return normalizeFolderPath(dir === '.' || dir === '' ? '.' : dir);
}

/**
 * All ancestor folder paths for a note (root → immediate parent), inclusive.
 * @param {string} noteRelPath
 * @returns {string[]}
 */
function ancestorFolderPathsOfNote(noteRelPath) {
	const parent = parentFolderPathOfNote(noteRelPath);
	if (parent === '.') {
		return ['.'];
	}
	const parts = parent.split('/').filter(Boolean);
	/** @type {string[]} */
	const out = ['.'];
	for (let i = 0; i < parts.length; i++) {
		out.push(parts.slice(0, i + 1).join('/'));
	}
	return out;
}

/**
 * Distinct folder paths implied by indexed note paths (ancestors of every file).
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @returns {string[]}
 */
function listFolderPathsFromFiles(db) {
	const stmt = db.prepare(`SELECT path FROM files`);
	stmt.bind([]);
	/** @type {Set<string>} */
	const set = new Set();
	while (stmt.step()) {
		const notePath = String(stmt.get()[0] || '');
		for (const fp of ancestorFolderPathsOfNote(notePath)) {
			set.add(fp);
		}
	}
	stmt.free();
	if (set.size === 0) {
		set.add('.');
	}
	return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Stem of a note file name (handles `.d.txt` before single-suffix extensions).
 * @param {string} fileName
 * @returns {string}
 */
function noteFileStem(fileName) {
	const name = String(fileName || '');
	const lower = name.toLowerCase();
	for (const ext of ['.d.txt', '.md', '.txt']) {
		if (lower.endsWith(ext)) {
			return name.slice(0, name.length - ext.length);
		}
	}
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * h0 title of the representative note for a folder, if present in `index.drip`.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {string} folderPath
 * @returns {string}
 */
function getFolderH0TitleFromDb(db, folderPath) {
	const folder = normalizeFolderPath(folderPath);
	const base = folderBasename(folder);
	const stmt = db.prepare(`SELECT id, path, name FROM files`);
	stmt.bind([]);
	/** @type {{ id: number, path: string, name: string }[]} */
	const direct = [];
	while (stmt.step()) {
		const row = stmt.get();
		const filePath = String(row[1] || '').replace(/\\/g, '/');
		const parent = parentFolderPathOfNote(filePath);
		if (parent !== folder) {
			continue;
		}
		direct.push({
			id: Number(row[0]),
			path: filePath,
			name: String(row[2] || path.posix.basename(filePath))
		});
	}
	stmt.free();
	if (!direct.length) {
		return '';
	}

	const baseLower = base.toLowerCase();
	let chosen = direct.find(f => noteFileStem(f.name).toLowerCase() === baseLower);
	if (!chosen && folder === '.') {
		// No strong representative at root — leave empty unless a single note exists.
		chosen = direct.length === 1 ? direct[0] : undefined;
	}
	if (!chosen) {
		return '';
	}

	const hStmt = db.prepare(
		`SELECT title FROM headings WHERE file_id = ? AND heading_id = 0`
	);
	hStmt.bind([chosen.id]);
	if (!hStmt.step()) {
		hStmt.free();
		return '';
	}
	const title = String(hStmt.get()[0] || '')
		.replace(/\s+/g, ' ')
		.trim();
	hStmt.free();
	return title;
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {string} folderPath
 * @returns {string}
 */
function buildFolderEmbeddingTextFromDb(db, folderPath) {
	const folder = normalizeFolderPath(folderPath);
	return buildFolderEmbeddingText({
		folderPath: folder,
		h0Title: getFolderH0TitleFromDb(db, folder)
	});
}

module.exports = {
	normalizeFolderPath,
	folderBasename,
	buildFolderEmbeddingText,
	parentFolderPathOfNote,
	ancestorFolderPathsOfNote,
	listFolderPathsFromFiles,
	getFolderH0TitleFromDb,
	buildFolderEmbeddingTextFromDb,
	noteFileStem
};
