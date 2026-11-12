'use strict';

/**
 * Today notes — personal day logs and day-tasks under `.drip.dailynotes/`.
 * Indexed only in `today.drip` (never in index.drip / per-project DBs).
 */

const path = require('path');
const vscode = require('vscode');
const { buildNewNoteFile } = require('../document/dripNoteKbOps.js');
const { allocateNextEntityNumber, indexNewNoteImmediately } = require('../indexing/dripTxt/dripTxtIndex.js');
const { DAILY_NOTES_DIR } = require('../shared/constants');

const MONTH_NAMES = [
	'January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December'
];

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {import('vscode').Uri}
 */
function getDailyNotesRootUri(kbRootUri) {
	return vscode.Uri.joinPath(kbRootUri, DAILY_NOTES_DIR);
}

/**
 * Month folder name under the year folder, e.g. "November".
 * @param {number} _year unused (year is the parent folder)
 * @param {number} month 0-based
 */
function monthFolderName(_year, month) {
	return MONTH_NAMES[month] || 'Unknown';
}

/**
 * @param {Date} date
 * @returns {string} e.g. "01-23-2026.d.txt"
 */
function dailyNoteFilename(date) {
	const mm = String(date.getMonth() + 1).padStart(2, '0');
	const dd = String(date.getDate()).padStart(2, '0');
	const yyyy = date.getFullYear();
	return `${mm}-${dd}-${yyyy}.d.txt`;
}

/**
 * @param {Date} date
 * @returns {[string, string, string]} [year, "Month YYYY", filename]
 */
function dailyNotePathSegments(date) {
	const year = String(date.getFullYear());
	const folder = monthFolderName(date.getFullYear(), date.getMonth());
	const file = dailyNoteFilename(date);
	return [year, folder, file];
}

/**
 * DB / KB-relative path: `.drip.dailynotes/<year>/<Month YYYY>/<file>`.
 * @param {Date} date
 */
function dailyNoteRelPath(date) {
	const [year, folder, file] = dailyNotePathSegments(date);
	return `${DAILY_NOTES_DIR}/${year}/${folder}/${file}`;
}

/**
 * Friendly day label for Today UI, e.g. "5 November 2026"
 * from `…/2026/November/11-05-2026.d.txt`.
 * @param {string} relPath
 */
function todayDisplayPath(relPath) {
	const p = String(relPath || '').replace(/\\/g, '/');
	const pre = `${DAILY_NOTES_DIR}/`;
	const rest = p.startsWith(pre) ? p.slice(pre.length) : p;
	const m = rest.match(/(?:^|\/)(\d{2})-(\d{2})-(\d{4})\.d\.(?:txt|md)$/i);
	if (m) {
		const month0 = parseInt(m[1], 10) - 1;
		const day = parseInt(m[2], 10);
		const year = parseInt(m[3], 10);
		if (month0 >= 0 && month0 < 12 && day >= 1 && day <= 31 && Number.isFinite(year)) {
			return `${day} ${MONTH_NAMES[month0]} ${year}`;
		}
	}
	return rest;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {Date} date
 */
function dailyNoteUri(kbRootUri, date) {
	const root = getDailyNotesRootUri(kbRootUri);
	const [year, folder, file] = dailyNotePathSegments(date);
	return vscode.Uri.joinPath(root, year, folder, file);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} fileUri
 */
function isDailyNoteUri(kbRootUri, fileUri) {
	const root = getDailyNotesRootUri(kbRootUri).fsPath.replace(/\\/g, '/');
	const fp = fileUri.fsPath.replace(/\\/g, '/');
	return fp === root || fp.startsWith(root + '/');
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} fileUri
 */
function toRelPath(kbRootUri, fileUri) {
	return path.relative(kbRootUri.fsPath, fileUri.fsPath).replace(/\\/g, '/');
}

async function uriExists(uri) {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensure year/month folders exist and open/create today's note using the same
 * `buildNewNoteFile` path as normal notes, but with Today file-id allocation.
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {Date} [now]
 * @param {{ context?: import('vscode').ExtensionContext }} [options]
 * @returns {Promise<{ uri: import('vscode').Uri, isNew: boolean, initialText: string }>}
 */
async function ensureTodayDailyNote(kbRootUri, now = new Date(), options = {}) {
	const uri = dailyNoteUri(kbRootUri, now);
	const [year, folder] = dailyNotePathSegments(now);
	const root = getDailyNotesRootUri(kbRootUri);
	const yearUri = vscode.Uri.joinPath(root, year);
	const monthUri = vscode.Uri.joinPath(root, year, folder);

	if (!(await uriExists(root))) {
		await vscode.workspace.fs.createDirectory(root);
	}
	if (!(await uriExists(yearUri))) {
		await vscode.workspace.fs.createDirectory(yearUri);
	}
	if (!(await uriExists(monthUri))) {
		await vscode.workspace.fs.createDirectory(monthUri);
	}

	if (await uriExists(uri)) {
		let existing = '';
		try {
			existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		} catch {
			/* ignore */
		}
		return { uri, isNew: false, initialText: existing };
	}

	const label = dailyNoteFilename(now).replace(/\.d\.txt$/i, '');
	const n = await allocateNextEntityNumber(kbRootUri, uri);
	const text = buildNewNoteFile(
		{ title: label, content: '', metadataFilename: label },
		{ fileEntityNumber: n }
	);
	await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
	try {
		await indexNewNoteImmediately(kbRootUri, uri, options.context);
	} catch (err) {
		console.error('[DRIP] immediate index after Today note create', err);
	}

	let initialText = text;
	try {
		initialText = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
	} catch {
		/* use pre-normalize text */
	}
	return { uri, isNew: true, initialText };
}

/**
 * True when buffer still matches what was written at first create (no user edits).
 * @param {string} text
 * @param {string} initialText
 */
function isDailyNoteUnchangedFromCreate(text, initialText) {
	return String(text || '').replace(/\r\n/g, '\n').trim() ===
		String(initialText || '').replace(/\r\n/g, '\n').trim();
}

/**
 * @param {string} folderName "November" or legacy "November 2026"
 * @param {number} [yearFromParent] year folder when name is month-only
 * @returns {{ year: number, month0: number } | null}
 */
function parseMonthFolderName(folderName, yearFromParent) {
	const raw = String(folderName || '').trim();
	const withYear = raw.match(/^([A-Za-z]+)\s+(\d{4})$/);
	if (withYear) {
		const monthIdx = MONTH_NAMES.findIndex(n => n.toLowerCase() === withYear[1].toLowerCase());
		if (monthIdx < 0) return null;
		return { year: parseInt(withYear[2], 10), month0: monthIdx };
	}
	const monthOnly = raw.match(/^([A-Za-z]+)$/);
	if (!monthOnly) return null;
	const monthIdx = MONTH_NAMES.findIndex(n => n.toLowerCase() === monthOnly[1].toLowerCase());
	if (monthIdx < 0) return null;
	const y = Number(yearFromParent);
	return {
		year: Number.isFinite(y) ? y : new Date().getFullYear(),
		month0: monthIdx
	};
}

/**
 * @param {import('vscode').Uri} kbRootUri
 */
async function loadDailyNotesTree(kbRootUri) {
	const root = getDailyNotesRootUri(kbRootUri);
	/** @type {{ kind: 'dailyYear', label: string, uri: import('vscode').Uri }[]} */
	const result = [];
	let yearEntries = [];
	try {
		yearEntries = await vscode.workspace.fs.readDirectory(root);
	} catch {
		return result;
	}
	yearEntries.sort((a, b) => Number(b[0]) - Number(a[0]));
	for (const [yearName, yearKind] of yearEntries) {
		if (yearKind !== vscode.FileType.Directory || isNaN(Number(yearName))) continue;
		result.push({
			kind: 'dailyYear',
			label: yearName,
			uri: vscode.Uri.joinPath(root, yearName)
		});
	}
	return result;
}

/**
 * @param {import('vscode').Uri} yearUri
 */
async function loadDailyMonthNodes(yearUri) {
	let entries = [];
	try {
		entries = await vscode.workspace.fs.readDirectory(yearUri);
	} catch {
		return [];
	}
	const yearFromParent = parseInt(path.basename(yearUri.fsPath), 10);
	/** @type {{ kind: 'dailyMonth', label: string, uri: import('vscode').Uri }[]} */
	const result = [];
	for (const [name, kind] of entries) {
		if (kind !== vscode.FileType.Directory) continue;
		if (!parseMonthFolderName(name, yearFromParent)) continue;
		result.push({ kind: 'dailyMonth', label: name, uri: vscode.Uri.joinPath(yearUri, name) });
	}
	result.sort((a, b) => {
		const pa = parseMonthFolderName(a.label, yearFromParent);
		const pb = parseMonthFolderName(b.label, yearFromParent);
		if (!pa || !pb) return 0;
		return pb.year * 12 + pb.month0 - (pa.year * 12 + pa.month0);
	});
	return result;
}

/**
 * @param {import('vscode').Uri} monthUri
 */
async function loadDailyNoteNodes(monthUri) {
	let entries = [];
	try {
		entries = await vscode.workspace.fs.readDirectory(monthUri);
	} catch {
		return [];
	}
	/** @type {{ kind: 'dailyNote', label: string, uri: import('vscode').Uri, date: string }[]} */
	const result = [];
	for (const [name, kind] of entries) {
		if (kind !== vscode.FileType.File) continue;
		const lower = name.toLowerCase();
		if (!lower.endsWith('.d.txt') && !lower.endsWith('.d.md')) continue;
		const stem = name.replace(/\.d\.(txt|md)$/i, '');
		const friendly = todayDisplayPath(`${DAILY_NOTES_DIR}/x/x/${name}`);
		result.push({
			kind: 'dailyNote',
			label: friendly.includes(' ') ? friendly : stem,
			uri: vscode.Uri.joinPath(monthUri, name),
			date: stem
		});
	}
	result.sort((a, b) => b.label.localeCompare(a.label));
	return result;
}

/**
 * Days in a month that have a Today note file (for the calendar).
 * @param {import('vscode').Uri} kbRootUri
 * @param {number} year
 * @param {number} month0
 * @returns {Promise<Set<number>>} day-of-month numbers that have a note
 */
async function listDaysWithNotes(kbRootUri, year, month0) {
	const folder = monthFolderName(year, month0);
	const monthUri = vscode.Uri.joinPath(getDailyNotesRootUri(kbRootUri), String(year), folder);
	/** @type {Set<number>} */
	const days = new Set();
	let entries = [];
	try {
		entries = await vscode.workspace.fs.readDirectory(monthUri);
	} catch {
		return days;
	}
	const prefix = `${String(month0 + 1).padStart(2, '0')}-`;
	const suffix = `-${year}`;
	for (const [name, kind] of entries) {
		if (kind !== vscode.FileType.File) continue;
		const lower = name.toLowerCase();
		if (!lower.endsWith('.d.txt') && !lower.endsWith('.d.md')) continue;
		const stem = name.replace(/\.d\.(txt|md)$/i, '');
		if (!stem.startsWith(prefix) || !stem.endsWith(suffix)) continue;
		const day = parseInt(stem.slice(3, 5), 10);
		if (Number.isFinite(day) && day >= 1 && day <= 31) days.add(day);
	}
	return days;
}

module.exports = {
	DAILY_NOTES_DIR,
	getDailyNotesRootUri,
	dailyNoteUri,
	dailyNoteRelPath,
	dailyNoteFilename,
	todayDisplayPath,
	isDailyNoteUri,
	toRelPath,
	isDailyNoteUnchangedFromCreate,
	ensureTodayDailyNote,
	loadDailyNotesTree,
	loadDailyMonthNodes,
	loadDailyNoteNodes,
	parseMonthFolderName,
	listDaysWithNotes,
	monthFolderName
};
