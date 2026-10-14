'use strict';

/**
 * Knowledge-base note file types: configurable extensions (.d.txt, .md, …).
 * Other modules should use this module instead of hard-coding `.d.txt`.
 */

const path = require('path');
const vscode = require('vscode');
const { slugify } = require('../../shared/utils');

/** Default when settings are empty or invalid */
const DEFAULT_KB_EXTENSIONS = Object.freeze(['.d.txt', '.md']);

let _cacheKey = '';
/** @type {string[] | null} */
let _cacheExts = null;

/**
 * @param {unknown} s
 * @returns {string}
 */
function normalizeExtensionEntry(s) {
	if (typeof s !== 'string') {
		return '';
	}
	const t = s.trim().toLowerCase();
	if (!t) {
		return '';
	}
	return t.startsWith('.') ? t : `.${t}`;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeExtensionList(raw) {
	let arr = [];
	if (Array.isArray(raw)) {
		arr = raw;
	} else if (typeof raw === 'string') {
		arr = raw.split(/[,\s]+/);
	}
	const out = [];
	const seen = new Set();
	for (const x of arr) {
		const n = normalizeExtensionEntry(String(x));
		if (n && !seen.has(n)) {
			seen.add(n);
			out.push(n);
		}
	}
	return out.length ? out : [...DEFAULT_KB_EXTENSIONS];
}

/**
 * Extensions (lowercase, leading dot) shown as notes in the KB and included in scans.
 */
function getKbNoteExtensions() {
	const cfg = vscode.workspace.getConfiguration('drip');
	const raw = cfg.get('knowledgeBaseFileExtensions', [...DEFAULT_KB_EXTENSIONS]);
	const key = JSON.stringify(raw);
	if (key === _cacheKey && _cacheExts) {
		return _cacheExts;
	}
	_cacheExts = normalizeExtensionList(raw);
	_cacheKey = key;
	return _cacheExts;
}

function invalidateKbNoteExtensionsCache() {
	_cacheKey = '';
	_cacheExts = null;
}

/**
 * Longest suffix first so `.d.txt` wins over `.txt` when both are configured.
 * @param {string[]} extensions
 */
function extensionsForSuffixMatch(extensions) {
	return [...extensions].sort((a, b) => b.length - a.length);
}

/**
 * @param {string} fileName
 * @param {string[] | undefined} extensions
 */
function fileNameMatchesKbNote(fileName, extensions) {
	const exts = extensionsForSuffixMatch(extensions || getKbNoteExtensions());
	const lower = fileName.toLowerCase();
	return exts.some(e => lower.endsWith(e.toLowerCase()));
}

/**
 * @param {string} fileName
 * @param {string[] | undefined} extensions
 * @returns {string} matched extension (lowercase) or ''
 */
function getExtensionFromFileName(fileName, extensions) {
	const exts = extensionsForSuffixMatch(extensions || getKbNoteExtensions());
	const lower = fileName.toLowerCase();
	for (const ext of exts) {
		const e = ext.toLowerCase();
		if (lower.endsWith(e)) {
			return e;
		}
	}
	return '';
}

/**
 * @param {string} fileName
 * @param {string[] | undefined} extensions
 */
function stripKbNoteExtension(fileName, extensions) {
	const ext = getExtensionFromFileName(fileName, extensions);
	if (!ext) {
		return fileName;
	}
	return fileName.slice(0, -ext.length);
}

/**
 * Extension used for newly created notes from the KB / picker when not overridden.
 */
function getDefaultNewNoteExtension() {
	const exts = getKbNoteExtensions();
	const cfg = vscode.workspace.getConfiguration('drip');
	const pref = normalizeExtensionEntry(String(cfg.get('defaultNewNoteExtension', '.d.txt') || ''));
	if (pref && exts.includes(pref)) {
		return pref;
	}
	if (exts.includes('.d.txt')) {
		return '.d.txt';
	}
	return exts[0] || '.d.txt';
}

/**
 * @param {string} title
 * @param {string | undefined} extension optional; defaults via getDefaultNewNoteExtension()
 */
function buildNoteFileName(title, extension) {
	const ext = extension ? normalizeExtensionEntry(extension) || getDefaultNewNoteExtension() : getDefaultNewNoteExtension();
	return `${slugify(title) || `note-${Date.now()}`}${ext}`;
}

/**
 * Basename stem for a path if it matches a KB note extension.
 * @param {string} fsPath
 */
function stemFromNotePath(fsPath, extensions) {
	const base = path.basename(fsPath);
	return stripKbNoteExtension(base, extensions);
}

/**
 * Canonical note format for a path: `drip-md` (`.d.md` markdown notes with hidden
 * comments), `md` (plain markdown), or `drip-txt` (`.d.txt` type-1 notes). Order matters
 * — `.d.md` must be checked before `.md`.
 * @param {string} fsPath
 * @returns {'drip-md' | 'md' | 'drip-txt'}
 */
function noteFormatForPath(fsPath) {
	const base = String(fsPath || '').toLowerCase();
	if (base.endsWith('.d.md')) return 'drip-md';
	if (base.endsWith('.md')) return 'md';
	return 'drip-txt';
}

module.exports = {
	DEFAULT_KB_EXTENSIONS,
	getKbNoteExtensions,
	invalidateKbNoteExtensionsCache,
	normalizeExtensionList,
	fileNameMatchesKbNote,
	getExtensionFromFileName,
	stripKbNoteExtension,
	getDefaultNewNoteExtension,
	buildNoteFileName,
	stemFromNotePath,
	noteFormatForPath
};
