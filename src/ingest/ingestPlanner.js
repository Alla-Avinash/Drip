'use strict';

/**
 * LLM ingest planner: one small LLM call picks where a note goes from the local candidates
 * (4 folders, 8 files, 12 headings — paths only, no bodies) and may suggest splitting a note
 * that mixes unrelated topics. Nothing is written here; Storage shows the proposal and the
 * user's Ingest click applies it.
 */

const vscode = require('vscode');
const path = require('path');
const { getLlmConfig, getLlmApiKey } = require('../llm/llmSettings');
const { completeJson } = require('../llm/llmJson');
const { findIngestCandidates, kbUri } = require('./ingestCandidates');
const { findHeadingByIdentity } = require('../capture/headingContent');
const {
	readTextFile,
	extractHeadingPathsFromDripFile,
	splitFileHeaderAndBody,
	buildHeadingTreeFromBody,
	parseType1HeadingRecords
} = require('../document/kbNoteOps');

const TITLE_FALLBACK_CHARS = 60;

/** Static instructions — identical on every call so providers can cache the prefix. */
const SYSTEM_PROMPT = `You choose where a note goes in a personal knowledge base. Reply with ONLY one JSON object.

You get the note as numbered paragraphs and the closest existing folders [F#], files [f#] and headings [h#] with their paths.

action:
  "append": the note continues the topic of an existing heading; target = "h#".
  "new_heading": the note is a new sub-topic inside an existing file or heading; target = "f#" (top level of that file) or "h#" (nested under that heading).
  "new_file": no file fits but a folder does; target = "F#".
  "new_folder": nothing listed fits; target = "F#" (parent of the new folder) or "root"; folder = new folder name.
Prefer existing places. Create a file or folder only when nothing listed fits.
title: short, specific heading/file title for the note. Required unless action is "append". If the note already has a heading, reuse it.
reason: one short sentence.
split: ONLY when the note mixes clearly unrelated topics with no connecting flow. List every paragraph exactly once: [{"paras":[1,2],"title":"..."}]. Otherwise omit.`;

const ACTIONS = new Set(['append', 'new_heading', 'new_file', 'new_folder']);

/**
 * Paragraphs (blank-line separated); a single block of several lines is split by line.
 * @param {string} content
 * @returns {string[]}
 */
function splitIntoUnits(content) {
	const text = String(content || '').replace(/\r\n/g, '\n').trim();
	if (!text) return [];
	const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
	if (paras.length === 1) {
		const lines = paras[0].split('\n').map(l => l.trim()).filter(Boolean);
		if (lines.length > 3) return lines;
	}
	return paras;
}

/** @param {string} rel */
function displayFolder(rel) {
	return !rel || rel === '.' ? '(root)' : rel;
}

/**
 * @param {string} noteTitle
 * @param {string[]} units
 * @param {Awaited<ReturnType<typeof findIngestCandidates>>} c
 */
function buildUserPrompt(noteTitle, units, c) {
	const parts = [];
	if (noteTitle) parts.push(`Note heading: ${noteTitle}`);
	parts.push(`Note:\n${units.map((u, i) => `[${i + 1}] ${u}`).join('\n')}`);
	if (c.folders.length) parts.push(`Folders:\n${c.folders.map((f, i) => `[F${i + 1}] ${displayFolder(f.path)}`).join('\n')}`);
	if (c.files.length) parts.push(`Files:\n${c.files.map((f, i) => `[f${i + 1}] ${f.path}`).join('\n')}`);
	if (c.headings.length) {
		parts.push(
			`Headings:\n${c.headings
				.map((h, i) => `[h${i + 1}] ${[h.path, h.parentTitle, h.title].filter(Boolean).join(' › ')}`)
				.join('\n')}`
		);
	}
	return parts.join('\n\n');
}

/**
 * @param {string} ref e.g. "h3", "f1", "F2", "root"
 * @param {Awaited<ReturnType<typeof findIngestCandidates>>} c
 * @returns {{ kind: 'heading'|'file'|'folder', item: any } | null}
 */
function resolveTarget(ref, c) {
	const m = String(ref || '').trim().match(/^\[?([hfF])(\d+)\]?$/);
	if (!m) return String(ref || '').trim().toLowerCase() === 'root' ? { kind: 'folder', item: { path: '.' } } : null;
	const list = m[1] === 'h' ? c.headings : m[1] === 'f' ? c.files : c.folders;
	const item = list[Number(m[2]) - 1];
	if (!item) return null;
	return { kind: m[1] === 'h' ? 'heading' : m[1] === 'f' ? 'file' : 'folder', item };
}

/**
 * @param {any} raw
 * @param {string[]} units
 * @returns {{ title: string, paras: number[], text: string }[] | null}
 */
function parseSplit(raw, units) {
	if (!Array.isArray(raw) || raw.length < 2) return null;
	const seen = new Set();
	const parts = [];
	for (const p of raw) {
		const paras = (Array.isArray(p && p.paras) ? p.paras : [])
			.map(Number)
			.filter(n => Number.isInteger(n) && n >= 1 && n <= units.length && !seen.has(n));
		if (!paras.length) continue;
		paras.forEach(n => seen.add(n));
		paras.sort((a, b) => a - b);
		parts.push({
			title: String((p && p.title) || '').trim(),
			paras,
			text: paras.map(n => units[n - 1]).join('\n\n')
		});
	}
	const missing = units.map((_, i) => i + 1).filter(n => !seen.has(n));
	if (missing.length && parts.length) {
		const last = parts[parts.length - 1];
		last.paras.push(...missing);
		last.text = last.paras.map(n => units[n - 1]).join('\n\n');
	}
	return parts.length >= 2 ? parts : null;
}

/**
 * Destination breadcrumbs for the proposal card: `{ label, kind }` from KB root down.
 * @param {string} rel KB-relative folder path
 */
function folderCrumbs(rel) {
	return String(rel || '')
		.split('/')
		.filter(p => p && p !== '.')
		.map(label => ({ label, kind: 'folder' }));
}

/** @param {string} relPath KB-relative file path */
function fileCrumbs(relPath) {
	return [...folderCrumbs(path.posix.dirname(relPath)), { label: path.posix.basename(relPath), kind: 'file' }];
}

/** @param {string} headingPath Storage heading path (`A/B/C`, titles may carry a `.type` marker) */
function headingCrumbs(headingPath) {
	return String(headingPath || '')
		.split('/')
		.filter(Boolean)
		.map(t => ({ label: t.replace(/^\.\S*\s+/, '') || t, kind: 'heading' }));
}

/**
 * Breadcrumb from KB root to a folder (Storage path bar).
 * @param {import('vscode').Uri} kbRoot
 * @param {string} rel
 */
function pathSegmentsFor(kbRoot, rel) {
	const segments = [{ label: '(root)', folderUri: kbRoot.toString() }];
	let cursor = kbRoot;
	for (const part of String(rel || '').split('/').filter(p => p && p !== '.')) {
		cursor = vscode.Uri.joinPath(cursor, part);
		segments.push({ label: part, folderUri: cursor.toString() });
	}
	return segments;
}

/**
 * Storage selection object (same shape as the AI paths list) for a file target.
 * @param {import('vscode').Uri} kbRoot
 * @param {string} relPath
 * @param {{ fileId: number, headingId: number, title: string } | null} heading
 */
async function fileStoragePath(kbRoot, relPath, heading) {
	const uri = kbUri(kbRoot, relPath);
	const text = (await readTextFile(uri)).replace(/\r\n/g, '\n');
	const isMd = relPath.toLowerCase().endsWith('.md');
	const { body, bodyStartLine } = splitFileHeaderAndBody(text);
	const headingPaths = extractHeadingPathsFromDripFile(text, { fileFsPath: uri.fsPath });
	let headingPath = '';
	if (heading) {
		const found = findHeadingByIdentity(text.split('\n'), heading.fileId, heading.headingId);
		const rec = found && parseType1HeadingRecords(body).headings.find(h => h.line === found.headingLine - bodyStartLine);
		headingPath = rec ? rec.path : headingPaths.find(p => p === heading.title || p.endsWith(`/${heading.title}`)) || '';
		if (!headingPath) throw new Error(`Could not find "${heading.title}" in ${relPath} (reindex may help).`);
	}
	const parentRel = path.posix.dirname(relPath);
	return {
		targetType: 'file',
		uri: uri.toString(),
		label: path.posix.basename(relPath),
		headingPath,
		headingPaths,
		headingTree: buildHeadingTreeFromBody(body, { atxMarkdown: isMd }),
		displayPath: relPath,
		parentFolderUri: kbUri(kbRoot, parentRel).toString(),
		parentDisplayPath: displayFolder(parentRel),
		pathSegments: pathSegmentsFor(kbRoot, parentRel)
	};
}

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {string} rel
 */
function folderStoragePath(kbRoot, rel) {
	const uri = kbUri(kbRoot, rel);
	return {
		targetType: 'folder',
		uri: uri.toString(),
		label: rel && rel !== '.' ? path.posix.basename(rel) : '(root)',
		displayPath: displayFolder(rel),
		pathSegments: pathSegmentsFor(kbRoot, rel)
	};
}

/**
 * @param {{
 *   kbRoot: import('vscode').Uri,
 *   note: { title?: string, content?: string },
 *   context: import('vscode').ExtensionContext,
 *   corpus?: unknown
 * }} opts
 */
async function planLlmIngest(opts) {
	const { kbRoot, context } = opts;
	const noteTitle = String((opts.note && opts.note.title) || '').trim();
	const units = splitIntoUnits(opts.note && opts.note.content);
	if (!units.length && !noteTitle) return { ok: false, message: 'The note is empty.' };

	const cfg = getLlmConfig();
	if (!cfg.enabled) return { ok: false, message: 'The LLM is off. Turn it on in DRIP Settings → Lightweight LLM.' };
	const apiKey = await getLlmApiKey(context);

	const query = [noteTitle, ...units].join('\n');
	const candidates = await findIngestCandidates(kbRoot, query, opts.corpus);

	const llmStart = Date.now();
	const obj = await completeJson({
		baseUrl: cfg.baseUrl,
		model: cfg.model,
		apiKey,
		temperature: 0,
		noThinking: true,
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: buildUserPrompt(noteTitle, units.length ? units : [noteTitle], candidates) }
		]
	});
	const timings = { ...candidates.timings, llmMs: Date.now() - llmStart };
	console.log(
		`[DRIP] LLM ingest: file sync ${timings.syncMs} ms, encode ${timings.encodeMs} ms, ` +
			`search ${timings.searchMs} ms, LLM (${cfg.model}) ${timings.llmMs} ms`
	);

	const action = String(obj.action || '').toLowerCase();
	if (!ACTIONS.has(action)) throw new Error(`The LLM returned an unknown action "${obj.action}".`);
	const target = resolveTarget(obj.target, candidates);
	const firstLine = String(units[0] || '').split('\n')[0].slice(0, TITLE_FALLBACK_CHARS);
	const title = String(obj.title || '').trim() || noteTitle || firstLine || 'Untitled';
	const folderName = String(obj.folder || '').trim().replace(/[\\/]/g, '-');
	const reason = String(obj.reason || '').trim();
	const split = parseSplit(obj.split, units);

	/** @param {string} msg */
	const bad = msg => ({ ok: false, message: `${msg} (LLM target "${obj.target}").` });

	let storagePath;
	/** @type {{ mode: string, noteTitle?: string, fileId?: number, headingId?: number, newFolderName?: string }} */
	let extras;
	let targetLabel;
	let actionLabel;
	/** @type {{ label: string, kind: string }[]} existing places, KB root → target */
	let crumbs;
	/** @type {{ label: string, kind: string }[]} what Ingest will create under the last crumb */
	let newItems = [];
	if (action === 'append') {
		if (!target || target.kind !== 'heading') return bad('Append needs an existing heading');
		const h = target.item;
		storagePath = await fileStoragePath(kbRoot, h.path, h);
		extras = { mode: 'append', fileId: h.fileId, headingId: h.headingId };
		actionLabel = 'Append to';
		targetLabel = [h.path, h.parentTitle, h.title].filter(Boolean).join(' › ');
		crumbs = [...fileCrumbs(h.path), ...headingCrumbs(storagePath.headingPath)];
	} else if (action === 'new_heading') {
		if (!target || (target.kind !== 'heading' && target.kind !== 'file')) return bad('A new heading needs a file or heading');
		const t = target.item;
		storagePath = await fileStoragePath(kbRoot, t.path, target.kind === 'heading' ? t : null);
		extras = { mode: 'new_heading', noteTitle: title };
		actionLabel = target.kind === 'heading' ? 'New heading under' : 'New heading in';
		targetLabel = target.kind === 'heading' ? [t.path, t.parentTitle, t.title].filter(Boolean).join(' › ') : t.path;
		crumbs = [...fileCrumbs(t.path), ...headingCrumbs(storagePath.headingPath)];
		newItems = [{ label: title, kind: 'heading' }];
	} else {
		let folderRel = target && target.kind === 'folder' ? target.item.path : '';
		if (target && target.kind === 'file') folderRel = path.posix.dirname(target.item.path);
		if (target && target.kind === 'heading') folderRel = path.posix.dirname(target.item.path);
		if (!target) return bad('A new file needs a folder');
		if (action === 'new_folder' && !folderName) return { ok: false, message: 'The LLM suggested a new folder but gave no name.' };
		storagePath = { ...folderStoragePath(kbRoot, folderRel), fileNameDefault: title };
		extras = action === 'new_folder' ? { mode: 'new_folder', noteTitle: title, newFolderName: folderName } : { mode: 'new_file', noteTitle: title };
		actionLabel = action === 'new_folder' ? 'New folder in' : 'New file in';
		targetLabel = displayFolder(folderRel);
		crumbs = folderCrumbs(folderRel);
		newItems =
			action === 'new_folder'
				? [{ label: folderName, kind: 'folder' }, { label: title, kind: 'file' }]
				: [{ label: title, kind: 'file' }];
	}

	return {
		ok: true,
		proposal: { action, actionLabel, targetLabel, title, folderName, reason, path: storagePath, extras, crumbs, newItems },
		split,
		counts: { folders: candidates.folders.length, files: candidates.files.length, headings: candidates.headings.length },
		timings,
		model: cfg.model
	};
}

module.exports = {
	planLlmIngest,
	fileStoragePath,
	folderStoragePath,
	splitIntoUnits,
	buildUserPrompt,
	resolveTarget,
	parseSplit,
	SYSTEM_PROMPT
};
