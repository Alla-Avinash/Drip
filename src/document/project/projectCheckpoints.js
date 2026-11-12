'use strict';

/**
 * Project checkpoints — changelog notes under `_archive/_checkpoints/`.
 * Named by date (`checkpoint-YYYY-MM-DD.d.txt`), with a free-form story plus a
 * single frozen list: `- [i-N] description` (no category/feature, no duplicate block).
 */

const path = require('path');
const crypto = require('crypto');
const vscode = require('vscode');
const { ARCHIVE_SUBFOLDER_NAME } = require('../model/dripNoteProjectFolder.js');
const { getDefaultNewNoteExtension } = require('../model/dripNoteFileTypes.js');
const { buildNewNoteFile, readTextFile, writeTextFile } = require('../dripNoteKbOps.js');
const { allocateNextEntityNumber, indexNewNoteImmediately } = require('../../indexing/dripTxt/dripTxtIndex.js');
const { formatDateTimeToMinute } = require('../parse/dripTxt/dripTxtDatetime.js');

const CHECKPOINTS_SUBFOLDER_NAME = '_checkpoints';
/** Legacy markdown heading — still accepted when reading older notes. */
const CHANGES_HEADING_MD = '## Changes';
/** Drip `.d.txt` marker-level heading for the frozen issue list. */
const CHANGES_HEADING_TXT = '#1 Changes';
/** Match either drip `#1 Changes` or legacy `## Changes`. */
const CHANGES_HEADING_RE = /^[ \t]*(?:#1|##)\s+Changes\s*$/im;
/** `- [i-12] description` */
const ISSUE_LINE_RE = /^-\s*\[(i-\d+)\]\s*(.*)$/i;
/** `checkpoint-2026-11-11.d.txt` or `checkpoint-2026-11-11-2.d.txt` */
const CHECKPOINT_FILE_RE = /^checkpoint-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.d\.(txt|md)$/i;
const IMAGE_MD_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {import('vscode').Uri} projectFolderUri
 * @returns {Promise<import('vscode').Uri>}
 */
async function ensureCheckpointsFolder(projectFolderUri) {
	const archive = vscode.Uri.joinPath(projectFolderUri, ARCHIVE_SUBFOLDER_NAME);
	await vscode.workspace.fs.createDirectory(archive);
	const dir = vscode.Uri.joinPath(archive, CHECKPOINTS_SUBFOLDER_NAME);
	await vscode.workspace.fs.createDirectory(dir);
	return dir;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizeIssueKey(raw) {
	const m = String(raw || '')
		.trim()
		.toLowerCase()
		.match(/^i-(\d+)$/);
	if (!m) return '';
	return `i-${parseInt(m[1], 10)}`;
}

/**
 * @param {string} raw
 * @returns {string} YYYY-MM-DD or ''
 */
function normalizeCheckpointDate(raw) {
	const s = String(raw || '').trim().slice(0, 10);
	return DATE_RE.test(s) ? s : '';
}

/**
 * @param {string} [raw]
 * @returns {string}
 */
function todayCheckpointDate(raw) {
	const fromArg = normalizeCheckpointDate(raw);
	if (fromArg) return fromArg;
	return formatDateTimeToMinute(new Date()).slice(0, 10);
}

/** Feature name for UI chips — never keep a trailing `.f`. */
function featureDisplayName(raw) {
	let s = String(raw || '').trim();
	s = s.replace(/^#+\s*/, '').replace(/^\.\s*f\b\s*/i, '');
	s = s.replace(/\/+$/, '').trim();
	const base = (s.split(/[/\\]/).pop() || s).trim();
	return (
		base
			.replace(/\.f\.d\.(txt|md)$/i, '')
			.replace(/\.f$/i, '')
			.trim() || 'Other'
	);
}

/** Category label for UI grouping. */
function categoryDisplayName(raw) {
	let s = String(raw || '').trim();
	if (!s || s === '(none)') return 'Other';
	return s.replace(/^#+\s*/, '').trim() || 'Other';
}

/**
 * Frozen-list heading for a new checkpoint note (drip `#1` for `.d.txt`, markdown `##` for `.d.md`).
 * @param {string} [ext]
 * @returns {string}
 */
function changesHeadingForExt(ext) {
	return /\.d\.md$/i.test(String(ext || '')) ? CHANGES_HEADING_MD : CHANGES_HEADING_TXT;
}

/**
 * Frozen issue rows from the Changes section (`#1 Changes` / `## Changes`).
 * @param {string} text
 * @returns {{ issueKey: string, description: string }[]}
 */
function parseIssueEntries(text) {
	/** @type {{ issueKey: string, description: string }[]} */
	const out = [];
	const seen = new Set();
	const parts = splitCheckpointParts(text);
	const block = parts.issuesBlock || String(text || '');
	for (const line of block.replace(/\r\n/g, '\n').split('\n')) {
		const m = String(line || '')
			.trim()
			.match(ISSUE_LINE_RE);
		if (!m) continue;
		const issueKey = normalizeIssueKey(m[1]);
		if (!issueKey || seen.has(issueKey)) continue;
		seen.add(issueKey);
		const description = String(m[2] || '').trim() || issueKey;
		out.push({ issueKey, description });
	}
	return out;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function extractIssueKeysFromText(text) {
	return parseIssueEntries(text).map(r => r.issueKey);
}

/**
 * Write the single frozen changes section.
 * @param {Array<{ issueKey?: string|null, title?: string, description?: string }>} issues
 * @param {string} [ext] Note extension (`.d.txt` / `.d.md`) so the heading matches the format.
 * @returns {string}
 */
function formatChangesSection(issues, ext) {
	/** @type {string[]} */
	const lines = [changesHeadingForExt(ext), ''];
	const seen = new Set();
	for (const issue of issues || []) {
		const key = normalizeIssueKey(issue && issue.issueKey);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		const desc =
			String((issue && (issue.description || issue.title)) || '').trim() || key;
		lines.push(`- [${key}] ${desc}`);
	}
	if (seen.size === 0) {
		lines.push('(none)');
	}
	return lines.join('\n').replace(/\n+$/, '') + '\n';
}

/**
 * Split note into write-up vs frozen Changes block (`#1 Changes` / `## Changes`).
 * @param {string} text
 * @returns {{ writeUp: string, issuesBlock: string, prefix: string }}
 */
function splitCheckpointParts(text) {
	const normalized = String(text || '').replace(/\r\n/g, '\n');
	const cut = normalized.search(CHANGES_HEADING_RE);
	if (cut < 0) {
		return {
			writeUp: stripLeakedChangesFromWriteUp(extractWriteUpFromBefore(normalized)),
			issuesBlock: '',
			prefix: ''
		};
	}
	const before = normalized.slice(0, cut);
	const issuesBlock = normalized.slice(cut).replace(/^\n+/, '');
	return {
		writeUp: stripLeakedChangesFromWriteUp(extractWriteUpFromBefore(before)),
		issuesBlock,
		prefix: before
	};
}

/**
 * @param {string} writeUp
 * @returns {string}
 */
function stripLeakedChangesFromWriteUp(writeUp) {
	const s = String(writeUp || '').replace(/\r\n/g, '\n');
	const cut = s.search(CHANGES_HEADING_RE);
	if (cut < 0) return s.replace(/^\n+/, '').replace(/\n+$/, '');
	return s.slice(0, cut).replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * Body after h0 title / date meta.
 * @param {string} beforeIssues
 * @returns {string}
 */
function extractWriteUpFromBefore(beforeIssues) {
	const lines = String(beforeIssues || '').replace(/\r\n/g, '\n').split('\n');
	let i = 0;
	while (i < lines.length) {
		const t = String(lines[i] || '').trim();
		if (t === '---') {
			i += 1;
			while (i < lines.length && !String(lines[i] || '').trim()) i += 1;
			if (i < lines.length && /^@h\d+\b/i.test(String(lines[i] || '').trim())) i += 1;
			if (i < lines.length && /^#\s/.test(String(lines[i] || '').trim())) i += 1;
			if (i < lines.length && /<!--\s*drip\s+h0\b/i.test(String(lines[i] || '').trim())) i += 1;
			while (i < lines.length) {
				const row = String(lines[i] || '').trim();
				if (!row) {
					i += 1;
					continue;
				}
				if (/^[a-z][a-z0-9_-]*\s*:/i.test(row)) {
					i += 1;
					continue;
				}
				if (row === '---') {
					i += 1;
					break;
				}
				break;
			}
			while (i < lines.length && !String(lines[i] || '').trim()) i += 1;
			break;
		}
		i += 1;
	}
	return lines.slice(i).join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * @param {string} text
 * @param {string} [fileName]
 * @returns {{ date: string, title: string, suffix: number }}
 */
function parseCheckpointHeader(text, fileName) {
	const normalized = String(text || '').replace(/\r\n/g, '\n');
	let date = '';
	let title = '';
	let suffix = 0;
	const dateM = normalized.match(/^\s*date\s*:\s*(.+)\s*$/im);
	if (dateM) date = normalizeCheckpointDate(dateM[1]) || String(dateM[1] || '').trim().slice(0, 10);
	const titleM = normalized.match(/^#\s+(?:\.\s*)?Checkpoint\s+(\d{4}-\d{2}-\d{2})(?:\s*#(\d+))?\b.*$/im);
	if (titleM) {
		if (!date) date = titleM[1];
		suffix = titleM[2] ? parseInt(titleM[2], 10) || 0 : 0;
		title = String(titleM[0] || '')
			.replace(/^#\s+(?:\.\s*)?/, '')
			.trim();
	}
	const fileM = String(fileName || '').match(CHECKPOINT_FILE_RE);
	if (fileM) {
		if (!date) date = fileM[1];
		if (!suffix && fileM[2]) suffix = parseInt(fileM[2], 10) || 0;
	}
	if (!title) {
		title = date
			? suffix > 1
				? `Checkpoint ${date} #${suffix}`
				: `Checkpoint ${date}`
			: 'Checkpoint';
	}
	return { date, title, suffix };
}

/**
 * Pick a free filename for this date under the checkpoints folder.
 * @param {import('vscode').Uri} dir
 * @param {string} date YYYY-MM-DD
 * @param {string} ext `.d.txt` | `.d.md`
 * @returns {Promise<{ fileName: string, stem: string, suffix: number }>}
 */
async function allocateCheckpointFileName(dir, date, ext) {
	const day = todayCheckpointDate(date);
	const e = ext === '.d.md' ? '.d.md' : '.d.txt';
	let suffix = 1;
	for (;;) {
		const stem = suffix === 1 ? `checkpoint-${day}` : `checkpoint-${day}-${suffix}`;
		const fileName = `${stem}${e}`;
		const dest = vscode.Uri.joinPath(dir, fileName);
		try {
			await vscode.workspace.fs.stat(dest);
			suffix += 1;
		} catch {
			return { fileName, stem, suffix };
		}
	}
}

/**
 * @param {import('vscode').Uri} projectFolderUri
 * @returns {Promise<{ date: string, title: string, suffix: number, rel: string, path: string, uri: import('vscode').Uri, issueKeys: string[] }[]>}
 */
async function listCheckpoints(projectFolderUri) {
	const dir = await ensureCheckpointsFolder(projectFolderUri);
	/** @type {{ date: string, title: string, suffix: number, rel: string, path: string, uri: import('vscode').Uri, issueKeys: string[] }[]} */
	const out = [];
	let entries = [];
	try {
		entries = await vscode.workspace.fs.readDirectory(dir);
	} catch {
		return out;
	}
	for (const [name, type] of entries) {
		if (type !== vscode.FileType.File) continue;
		if (!CHECKPOINT_FILE_RE.test(String(name))) continue;
		const uri = vscode.Uri.joinPath(dir, name);
		let text = '';
		try {
			text = await readTextFile(uri);
		} catch {
			continue;
		}
		const header = parseCheckpointHeader(text, name);
		const rel = path.relative(projectFolderUri.fsPath, uri.fsPath).replace(/\\/g, '/');
		out.push({
			date: header.date,
			title: header.title,
			suffix: header.suffix || 1,
			rel,
			path: rel,
			uri,
			issueKeys: extractIssueKeysFromText(text)
		});
	}
	out.sort(
		(a, b) =>
			String(b.date || '').localeCompare(String(a.date || '')) ||
			(b.suffix || 1) - (a.suffix || 1)
	);
	return out;
}

/**
 * Issue keys already frozen into any checkpoint note under `_checkpoints/`.
 * An issue is "claimed" if it appears in any checkpoint's `## Changes` list;
 * deleting that checkpoint (or removing the line) frees it again.
 * Checkpoint notes are the source of truth (the completed_issues index is only a
 * cache rebuilt after create/save/delete).
 * @param {import('vscode').Uri} projectFolderUri
 * @param {string} [exceptRel] skip this checkpoint path (when re-editing it)
 * @param {import('vscode').Uri} [_kbRootUri] unused — kept for call-site compatibility
 * @returns {Promise<Set<string>>}
 */
async function listClaimedIssueKeys(projectFolderUri, exceptRel, _kbRootUri) {
	const list = await listCheckpoints(projectFolderUri);
	const skip = String(exceptRel || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '')
		.toLowerCase();
	const claimed = new Set();
	for (const cp of list) {
		const rel = String(cp.rel || '')
			.replace(/\\/g, '/')
			.replace(/^\/+|\/+$/g, '')
			.toLowerCase();
		if (skip && rel === skip) continue;
		for (const key of cp.issueKeys || []) {
			const k = normalizeIssueKey(key);
			if (k) claimed.add(k);
		}
	}
	return claimed;
}

/**
 * Refresh `completed_issues.checkpoint_rel` from notes on disk (best-effort).
 * @param {import('vscode').Uri} [kbRootUri]
 * @param {import('vscode').Uri} projectFolderUri
 */
async function syncCheckpointClaimsIndex(kbRootUri, projectFolderUri) {
	if (!kbRootUri || !projectFolderUri) return;
	try {
		const { rebuildCheckpointClaims } = require('../../indexing/completedIssueIndex');
		await rebuildCheckpointClaims(kbRootUri, projectFolderUri);
	} catch (err) {
		console.warn('[DRIP] checkpoint claim index sync failed', err && err.message);
	}
}

/**
 * Live/UI tree: category → feature → issues (for compose / optional display enrich).
 * @param {Array<{ issueKey?: string|null, title?: string, description?: string, category?: string|null, feature?: string }>} issues
 * @returns {{ name: string, features: { name: string, issues: { issueKey: string, title: string }[] }[] }[]}
 */
function buildCheckpointIssueTree(issues) {
	/** @type {Map<string, Map<string, { issueKey: string, title: string }[]>>} */
	const byCat = new Map();
	for (const issue of issues || []) {
		const key = normalizeIssueKey(issue && issue.issueKey);
		if (!key) continue;
		const cat = categoryDisplayName((issue && issue.category) || '');
		const feat = featureDisplayName((issue && issue.feature) || '');
		if (!byCat.has(cat)) byCat.set(cat, new Map());
		const byFeat = byCat.get(cat);
		if (!byFeat.has(feat)) byFeat.set(feat, []);
		byFeat.get(feat).push({
			issueKey: key,
			title: String((issue && (issue.description || issue.title)) || key)
		});
	}
	const cats = Array.from(byCat.keys()).sort((a, b) => {
		if (a === 'Other') return 1;
		if (b === 'Other') return -1;
		return a.toLowerCase().localeCompare(b.toLowerCase());
	});
	return cats.map(cat => {
		const byFeat = byCat.get(cat);
		const feats = Array.from(byFeat.keys()).sort((a, b) =>
			a.toLowerCase().localeCompare(b.toLowerCase())
		);
		return {
			name: cat,
			features: feats.map(feat => ({
				name: feat,
				issues: byFeat.get(feat).sort((a, b) =>
					a.issueKey.localeCompare(b.issueKey, undefined, { numeric: true })
				)
			}))
		};
	});
}

/**
 * Tree from frozen file entries only (no live category/feature — one flat group).
 * @param {string} text
 * @returns {{ name: string, features: { name: string, issues: { issueKey: string, title: string }[] }[] }[]}
 */
function treeFromCheckpointText(text) {
	const entries = parseIssueEntries(text);
	if (!entries.length) return [];
	return [
		{
			name: 'Changes',
			features: [
				{
					name: 'Other',
					issues: entries.map(e => ({
						issueKey: e.issueKey,
						title: e.description
					}))
				}
			]
		}
	];
}

/**
 * @param {string} writeUp
 * @param {Array<{ issueKey?: string|null, title?: string, description?: string }>} issues
 * @param {string} date
 * @param {string} [ext]
 * @returns {string}
 */
function formatCheckpointContent(writeUp, issues, date, ext) {
	const notes = String(writeUp || '').replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '');
	const day = todayCheckpointDate(date);
	/** @type {string[]} */
	const parts = [`date: ${day}`, '---', ''];
	if (notes) {
		parts.push(notes);
		parts.push('');
	}
	parts.push(formatChangesSection(issues, ext).replace(/\n+$/, ''));
	parts.push('');
	return parts.join('\n');
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} projectFolderUri
 * @param {{ date?: string, writeUp?: string, issues: Array<{ issueKey?: string|null, title?: string, description?: string }> }} opts
 * @returns {Promise<{ uri: import('vscode').Uri, rel: string, date: string, title: string, suffix: number }>}
 */
async function createCheckpoint(kbRootUri, projectFolderUri, opts) {
	const date = todayCheckpointDate(opts && opts.date);
	const issues = Array.isArray(opts && opts.issues) ? opts.issues : [];
	const dir = await ensureCheckpointsFolder(projectFolderUri);
	const ext = getDefaultNewNoteExtension() === '.d.md' ? '.d.md' : '.d.txt';
	const content = formatCheckpointContent((opts && opts.writeUp) || '', issues, date, ext);
	const allocated = await allocateCheckpointFileName(dir, date, ext);
	const dest = vscode.Uri.joinPath(dir, allocated.fileName);
	const title =
		allocated.suffix > 1 ? `Checkpoint ${date} #${allocated.suffix}` : `Checkpoint ${date}`;

	let fileEntityNumber = 0;
	try {
		fileEntityNumber = await allocateNextEntityNumber(kbRootUri, dest);
	} catch {
		fileEntityNumber = 0;
	}

	const text = buildNewNoteFile(
		{
			title,
			content,
			metadataFilename: allocated.stem
		},
		{
			fileEntityNumber,
			format: ext === '.d.md' ? 'drip-md' : undefined
		}
	);

	const { markExpectedDiskWrite } = require('../../shared/documentEditGuard');
	markExpectedDiskWrite(dest);
	await vscode.workspace.fs.writeFile(dest, Buffer.from(text, 'utf8'));
	try {
		await indexNewNoteImmediately(kbRootUri, dest);
	} catch {
		/* index is best-effort */
	}

	const rel = path.relative(projectFolderUri.fsPath, dest.fsPath).replace(/\\/g, '/');
	// Claim index is best-effort — never fail create after the note is on disk.
	try {
		await syncCheckpointClaimsIndex(kbRootUri, projectFolderUri);
	} catch (err) {
		console.warn('[DRIP] checkpoint claim sync after create failed', err && err.message);
	}
	return { uri: dest, rel, date, title, suffix: allocated.suffix };
}

/**
 * @param {import('vscode').Uri} noteUri
 * @returns {Promise<{ date: string, title: string, suffix: number, writeUp: string, issueKeys: string[], entries: { issueKey: string, description: string }[], tree: ReturnType<typeof treeFromCheckpointText>, text: string, relName: string }>}
 */
async function readCheckpoint(noteUri) {
	const text = await readTextFile(noteUri);
	const relName = path.basename(noteUri.fsPath);
	const header = parseCheckpointHeader(text, relName);
	const parts = splitCheckpointParts(text);
	const entries = parseIssueEntries(text);
	return {
		date: header.date,
		title: header.title,
		suffix: header.suffix || 1,
		writeUp: parts.writeUp,
		issueKeys: entries.map(e => e.issueKey),
		entries,
		tree: treeFromCheckpointText(text),
		text,
		relName
	};
}

/**
 * @param {string} headerOnly
 * @param {string} date
 * @returns {string}
 */
function applyCheckpointDate(headerOnly, date) {
	const day = todayCheckpointDate(date);
	const src = String(headerOnly || '');
	if (/^\s*date\s*:/im.test(src)) {
		return src.replace(/^\s*date\s*:.*$/im, `date: ${day}`);
	}
	const lines = src.replace(/\r\n/g, '\n').split('\n');
	let insertAt = -1;
	let sawTitle = false;
	for (let i = 0; i < lines.length; i++) {
		const t = String(lines[i] || '').trim();
		if (/^#\s+(?:\.\s*)?Checkpoint\b/i.test(t)) sawTitle = true;
		if (sawTitle && t === '---') {
			insertAt = i;
			break;
		}
	}
	if (insertAt >= 0) {
		lines.splice(insertAt, 0, `date: ${day}`);
		return lines.join('\n');
	}
	return `${src.replace(/\n+$/, '')}\ndate: ${day}\n---\n`;
}

/**
 * @param {import('vscode').Uri} noteUri
 * @param {string} writeUp
 * @param {Array<{ issueKey?: string|null, title?: string, description?: string }>|null} [issues]
 * @param {string} [date]
 * @param {{ kbRootUri?: import('vscode').Uri, projectFolderUri?: import('vscode').Uri }} [opts]
 * @returns {Promise<string>}
 */
async function saveCheckpointWriteUp(noteUri, writeUp, issues, date, opts) {
	const text = await readTextFile(noteUri);
	const parts = splitCheckpointParts(text);
	const notes = String(writeUp || '').replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '');
	const noteExt = /\.d\.md$/i.test(noteUri.fsPath) ? '.d.md' : '.d.txt';
	let issuesBlock = parts.issuesBlock || formatChangesSection([], noteExt);
	if (issues != null) {
		issuesBlock = formatChangesSection(issues, noteExt);
	}

	let prefix = parts.prefix;
	const header = parseCheckpointHeader(text, path.basename(noteUri.fsPath));
	const day = todayCheckpointDate(date || header.date);
	if (!prefix || !String(prefix).trim()) {
		const cut = String(text).search(CHANGES_HEADING_RE);
		prefix = (cut >= 0 ? text.slice(0, cut) : text).replace(/\n+$/, '');
		if (!/Checkpoint\b/i.test(prefix)) {
			const stem = path.basename(noteUri.fsPath).replace(/\.d\.(txt|md)$/i, '');
			prefix =
				`filename: ${stem}\nfileid: @f0\nheadings: 0\n---\n\n@h0\n# . Checkpoint ${day}\n` +
				`date: ${day}\n---\n`;
		}
	}

	const writeUpInPrefix = extractWriteUpFromBefore(prefix);
	let headerOnly = prefix;
	if (writeUpInPrefix && prefix.endsWith(writeUpInPrefix)) {
		headerOnly = prefix.slice(0, prefix.length - writeUpInPrefix.length).replace(/\n+$/, '');
	} else {
		headerOnly = prefix.replace(/\n+$/, '');
		const wu = extractWriteUpFromBefore(prefix);
		if (wu) {
			const idx = prefix.lastIndexOf(wu);
			if (idx >= 0) headerOnly = prefix.slice(0, idx).replace(/\n+$/, '');
		}
	}

	headerOnly = applyCheckpointDate(headerOnly, day);
	// Keep the h0 title aligned with the date when it looks like a checkpoint title.
	headerOnly = headerOnly.replace(
		/^([ \t]*#\s+(?:\.\s*)?)Checkpoint\b.*$/im,
		`$1Checkpoint ${day}`
	);

	const next =
		`${headerOnly}\n\n${notes}${notes ? '\n\n' : ''}${issuesBlock}`.replace(/\n{3,}/g, '\n\n');
	const finalText = next.endsWith('\n') ? next : next + '\n';
	await writeTextFile(noteUri, finalText);
	const projectFolderUri =
		(opts && opts.projectFolderUri) ||
		vscode.Uri.joinPath(noteUri, '..', '..', '..');
	try {
		await syncCheckpointClaimsIndex(opts && opts.kbRootUri, projectFolderUri);
	} catch (err) {
		console.warn('[DRIP] checkpoint claim sync after save failed', err && err.message);
	}
	return finalText;
}

/**
 * @param {import('vscode').Uri} noteUri
 * @param {{ kbRootUri?: import('vscode').Uri, projectFolderUri?: import('vscode').Uri }} [opts]
 * @returns {Promise<void>}
 */
async function deleteCheckpoint(noteUri, opts) {
	const { markExpectedDiskWrite } = require('../../shared/documentEditGuard');
	const imgDir = vscode.Uri.joinPath(noteUri, '..', '.img');
	try {
		const text = await readTextFile(noteUri);
		const parts = splitCheckpointParts(text);
		const noteDir = vscode.Uri.joinPath(noteUri, '..');
		for (const rel of listWriteUpImageRels(parts.writeUp)) {
			if (!rel || rel.includes('..')) continue;
			try {
				const imgUri = vscode.Uri.joinPath(noteDir, ...String(rel).split('/').filter(Boolean));
				markExpectedDiskWrite(imgUri);
				await vscode.workspace.fs.delete(imgUri, { useTrash: false });
			} catch {
				/* image may already be gone */
			}
		}
	} catch {
		/* note unreadable — still try to delete the file */
	}
	markExpectedDiskWrite(noteUri);
	await vscode.workspace.fs.delete(noteUri, { useTrash: true });
	try {
		const left = await vscode.workspace.fs.readDirectory(imgDir);
		if (!left.length) {
			markExpectedDiskWrite(imgDir);
			await vscode.workspace.fs.delete(imgDir, { recursive: true, useTrash: false });
		}
	} catch {
		/* ignore */
	}
	const projectFolderUri =
		(opts && opts.projectFolderUri) ||
		vscode.Uri.joinPath(noteUri, '..', '..', '..');
	await syncCheckpointClaimsIndex(opts && opts.kbRootUri, projectFolderUri);
}

/**
 * @param {import('vscode').Uri} noteUri
 * @param {Uint8Array} bytes
 * @param {string} [ext]
 * @returns {Promise<{ markdown: string, rel: string, fileName: string }>}
 */
async function saveCheckpointImage(noteUri, bytes, ext) {
	const e = String(ext || '.png').startsWith('.') ? String(ext || '.png') : `.${ext || 'png'}`;
	const noteDir = vscode.Uri.joinPath(noteUri, '..');
	const imgDir = vscode.Uri.joinPath(noteDir, '.img');
	await vscode.workspace.fs.createDirectory(imgDir);
	const fileName = `pasted-image-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${e}`;
	const destUri = vscode.Uri.joinPath(imgDir, fileName);
	const { markExpectedDiskWrite } = require('../../shared/documentEditGuard');
	markExpectedDiskWrite(destUri);
	await vscode.workspace.fs.writeFile(destUri, bytes);
	const rel = `.img/${fileName}`;
	return { markdown: `![](${rel})`, rel, fileName };
}

/**
 * @param {string} writeUp
 * @returns {string[]}
 */
function listWriteUpImageRels(writeUp) {
	/** @type {string[]} */
	const out = [];
	const s = String(writeUp || '');
	let m;
	IMAGE_MD_RE.lastIndex = 0;
	while ((m = IMAGE_MD_RE.exec(s)) !== null) {
		const rel = String(m[1] || '').trim();
		if (rel) out.push(rel);
	}
	return out;
}

module.exports = {
	CHECKPOINTS_SUBFOLDER_NAME,
	CHANGES_HEADING: CHANGES_HEADING_TXT,
	CHANGES_HEADING_TXT,
	CHANGES_HEADING_MD,
	CHANGES_HEADING_RE,
	changesHeadingForExt,
	ensureCheckpointsFolder,
	listCheckpoints,
	listClaimedIssueKeys,
	syncCheckpointClaimsIndex,
	buildCheckpointIssueTree,
	treeFromCheckpointText,
	formatCheckpointContent,
	formatChangesSection,
	parseIssueEntries,
	createCheckpoint,
	readCheckpoint,
	saveCheckpointWriteUp,
	deleteCheckpoint,
	saveCheckpointImage,
	listWriteUpImageRels,
	extractIssueKeysFromText,
	normalizeIssueKey,
	normalizeCheckpointDate,
	todayCheckpointDate,
	featureDisplayName,
	categoryDisplayName
};
