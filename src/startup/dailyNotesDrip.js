'use strict';

const path = require('path');
const vscode = require('vscode');
const { buildNewNoteFile } = require('../document/kbNoteOps');
const { allocateNextEntityNumber, indexNewNoteImmediately } = require('../indexing/dripnoteIndex');
const { normalizeNoteIdentityFile } = require('../indexing/dripnoteFileIdentity');
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
 * Display folder name e.g. "January 2026".
 * @param {number} year
 * @param {number} month 0-based
 */
function monthFolderName(year, month) {
	return `${MONTH_NAMES[month]} ${year}`;
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
 * DB / KB-relative path: `dailynotes.drip/<year>/<Month YYYY>/<file>`.
 * @param {Date} date
 */
function dailyNoteRelPath(date) {
	const [year, folder, file] = dailyNotePathSegments(date);
	return `${DAILY_NOTES_DIR}/${year}/${folder}/${file}`;
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
 * `buildNewNoteFile` + fileid allocation path as normal KB notes.
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
	const n = await allocateNextEntityNumber(kbRootUri);
	const text = buildNewNoteFile(
		{ title: label, content: '', metadataFilename: label },
		{ fileEntityNumber: n }
	);
	await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
	await normalizeNoteIdentityFile(uri, { context: options.context, kbRoot: kbRootUri });
	try {
		await indexNewNoteImmediately(kbRootUri, uri, options.context);
	} catch (err) {
		console.error('[DRIP] immediate index after daily note create', err);
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
 * @param {string} folderName
 * @returns {{ year: number, month0: number } | null}
 */
function parseMonthFolderName(folderName) {
	const m = String(folderName || '').match(/^([A-Za-z]+)\s+(\d{4})$/);
	if (!m) return null;
	const monthIdx = MONTH_NAMES.findIndex(n => n.toLowerCase() === m[1].toLowerCase());
	if (monthIdx < 0) return null;
	return { year: parseInt(m[2], 10), month0: monthIdx };
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
	/** @type {{ kind: 'dailyMonth', label: string, uri: import('vscode').Uri }[]} */
	const result = [];
	for (const [name, kind] of entries) {
		if (kind !== vscode.FileType.Directory) continue;
		if (!parseMonthFolderName(name)) continue;
		result.push({ kind: 'dailyMonth', label: name, uri: vscode.Uri.joinPath(yearUri, name) });
	}
	result.sort((a, b) => {
		const pa = parseMonthFolderName(a.label);
		const pb = parseMonthFolderName(b.label);
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
		if (kind !== vscode.FileType.File || !name.toLowerCase().endsWith('.d.txt')) continue;
		const label = name.replace(/\.d\.txt$/i, '');
		result.push({
			kind: 'dailyNote',
			label,
			uri: vscode.Uri.joinPath(monthUri, name),
			date: label
		});
	}
	result.sort((a, b) => b.label.localeCompare(a.label));
	return result;
}

module.exports = {
	DAILY_NOTES_DIR,
	getDailyNotesRootUri,
	dailyNoteUri,
	dailyNoteRelPath,
	dailyNoteFilename,
	isDailyNoteUri,
	toRelPath,
	isDailyNoteUnchangedFromCreate,
	ensureTodayDailyNote,
	loadDailyNotesTree,
	loadDailyMonthNodes,
	loadDailyNoteNodes,
	parseMonthFolderName
};
