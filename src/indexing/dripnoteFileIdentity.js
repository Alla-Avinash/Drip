'use strict';

/**
 * Phase 1 — Reproducible file identity
 * - fileid = SHA1( filenameStem + "|" + createdTimeMs ) (first 10 hex chars, @-prefixed)
 * - `created` is stored in the note header as ISO-8601 (includes ms); the hash uses the ms epoch integer.
 *
 * Phase 2 — Index alignment (this module)
 * - detectFileIdDrift / forceCanonicalFileId: realign stored fileid to canonical hash when needed.
 *
 * Phase 3 — Link rewrites + go-to-definition on L. [@fileid] (not implemented here).
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const {
	readTextFile,
	writeTextFile,
	forEachKnowledgeBaseNote
} = require('../document/kbNoteOps');
const { stripKbNoteExtension, fileNameMatchesKbNote } = require('../document/model/noteFileTypes');
const { isFileEntityIdLine } = require('./dripnoteEntityIds');
const CREATED_STORE_KEY = 'drip.noteIdentity.createdByUri.v1';
const FILEID_STORE_KEY = 'drip.noteIdentity.fileIdByUri.v1';

function formatCreatedIso(createdMs) {
	return new Date(createdMs).toISOString();
}

/** @param {string|number} s */
function parseCreatedToMs(s) {
	if (s === undefined || s === null) return NaN;
	const t = String(s).trim();
	if (!t) return NaN;
	if (/^\d+$/.test(t)) {
		const n = parseInt(t, 10);
		return Number.isFinite(n) ? n : NaN;
	}
	const p = Date.parse(t);
	return Number.isFinite(p) ? p : NaN;
}

/**
 * @param {string} filenameStem note name without extension
 * @param {number} createdMs file creation time in milliseconds (UTC epoch)
 */
function makeFileId(filenameStem, createdMs) {
	if (!Number.isFinite(createdMs) || createdMs < 0) {
		createdMs = Date.now();
	}
	const seed = `${filenameStem}|${createdMs}`;
	return `@${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 10)}`;
}

function computeExpectedFileId(filenameStem, createdMs) {
	return makeFileId(filenameStem, createdMs);
}

function isIdentityFieldLine(line) {
	return /^\s*(filename|created|random|fileid|headings)\s*:/i.test(String(line || ''));
}

function parseIdentityFields(lines) {
	const out = { filename: '', created: '', random: '', fileid: '', headings: '' };
	for (const line of lines) {
		const m = String(line || '').match(/^\s*(filename|created|random|fileid|headings)\s*:\s*(.*)\s*$/i);
		if (!m) continue;
		out[String(m[1] || '').toLowerCase()] = String(m[2] || '').trim();
	}
	return out;
}

function splitTopSection(text) {
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	const sepIdx = lines.findIndex(line => String(line || '').trim() === '---');
	if (sepIdx < 0) {
		return { topLines: [], bodyLines: lines };
	}
	return {
		topLines: lines.slice(0, sepIdx),
		bodyLines: lines.slice(sepIdx + 1)
	};
}

/**
 * @param {import('vscode').Uri} fileUri
 */
async function readCreatedMsFromDisk(fileUri) {
	try {
		const diskText = await readTextFile(fileUri);
		const { topLines } = splitTopSection(diskText);
		const parsed = parseIdentityFields(topLines);
		return parseCreatedToMs(parsed.created);
	} catch {
		return NaN;
	}
}

/**
 * @param {import('vscode').Uri} fileUri
 */
async function getFileCreatedMsFromFs(fileUri) {
	try {
		const st = await fs.stat(fileUri.fsPath);
		const t = st.birthtimeMs ?? st.ctimeMs ?? st.mtimeMs;
		if (typeof t === 'number' && Number.isFinite(t) && t > 0) {
			return Math.floor(t);
		}
	} catch {
		// ignore
	}
	return NaN;
}

function buildNormalizedNoteText(fileUri, text, options) {
	const opts = options || {};
	const normalizedInput = String(text || '').replace(/\r\n/g, '\n');
	const actualName = stripKbNoteExtension(path.basename(fileUri.fsPath));
	const { topLines, bodyLines } = splitTopSection(normalizedInput);
	const existing = parseIdentityFields(topLines);
	let createdMs;
	if (Number.isFinite(opts.lockedCreatedMs)) {
		createdMs = /** @type {number} */ (opts.lockedCreatedMs);
	} else {
		const p = parseCreatedToMs(String(opts.lockedCreated || existing.created || '').trim());
		createdMs = Number.isFinite(p) ? p : Date.now();
	}
	const shouldRecompute = Boolean(opts.forceRecomputeFileId);
	const existingFileId = String(existing.fileid || '').trim();
	const lockedFileId = String(opts.lockedFileId || '').trim();
	const fileid =
		lockedFileId ||
		(!shouldRecompute && existingFileId
			? existingFileId
			: isFileEntityIdLine(existingFileId)
				? existingFileId
				: makeFileId(actualName, createdMs));

	// Preserve the user's whitespace/layout exactly:
	// - Do not delete blank lines anywhere (top block, after `---`, EOF).
	// - Only update existing identity field lines in-place; if missing, prepend them.
	/** @type {string[]} */
	const nextTop = [];
	let sawFilename = false;
	let sawFileid = false;
	let sawHeadings = false;
	for (const line of topLines) {
		const m = String(line || '').match(/^\s*(filename|created|fileid|headings)\s*:/i);
		if (!m) {
			nextTop.push(line);
			continue;
		}
		const k = String(m[1] || '').toLowerCase();
		if (k === 'filename') {
			nextTop.push(`filename: ${actualName}`);
			sawFilename = true;
		} else if (k === 'created') {
			// Legacy: strip `created` from file header (no longer part of the default format).
			continue;
		} else if (k === 'fileid') {
			nextTop.push(`fileid: ${fileid}`);
			sawFileid = true;
		} else if (k === 'headings') {
			nextTop.push(`headings: ${String(existing.headings || '0').trim() || '0'}`);
			sawHeadings = true;
		} else {
			nextTop.push(line);
		}
	}
	const missing = [];
	if (!sawFilename) missing.push(`filename: ${actualName}`);
	if (!sawFileid) missing.push(`fileid: ${fileid}`);
	if (!sawHeadings) missing.push('headings: 0');
	const finalTop = missing.length ? [...missing, ...nextTop] : nextTop;

	// If there was no `---` separator, keep behavior minimal: just return the updated top block + original body.
	// Otherwise preserve separator position and all body lines verbatim (including leading/trailing blank lines).
	return [...finalTop, '---', ...bodyLines].join('\n');
}

async function readCreatedStore(context) {
	if (!context || !context.globalState) return {};
	const raw = context.globalState.get(CREATED_STORE_KEY, {});
	return raw && typeof raw === 'object' ? raw : {};
}

async function writeCreatedStore(context, value) {
	if (!context || !context.globalState) return;
	await context.globalState.update(CREATED_STORE_KEY, value);
}

async function readFileIdStore(context) {
	if (!context || !context.globalState) return {};
	const raw = context.globalState.get(FILEID_STORE_KEY, {});
	return raw && typeof raw === 'object' ? raw : {};
}

async function writeFileIdStore(context, value) {
	if (!context || !context.globalState) return;
	await context.globalState.update(FILEID_STORE_KEY, value);
}

async function readFileIdFromDisk(fileUri) {
	try {
		const diskText = await readTextFile(fileUri);
		const { topLines } = splitTopSection(diskText);
		const parsed = parseIdentityFields(topLines);
		return String(parsed.fileid || '').trim();
	} catch {
		return '';
	}
}

async function resolveCreatedMsForIdentity(fileUri, text, context) {
	const { topLines } = splitTopSection(text);
	const existing = parseIdentityFields(topLines);
	const key = fileUri.toString();

	let createdMs = parseCreatedToMs(existing.created);
	const createdStore = await readCreatedStore(context);
	if (!Number.isFinite(createdMs) && createdStore && typeof createdStore[key] === 'string') {
		createdMs = parseCreatedToMs(createdStore[key]);
	}
	if (!Number.isFinite(createdMs)) {
		createdMs = await readCreatedMsFromDisk(fileUri);
	}
	if (!Number.isFinite(createdMs)) {
		createdMs = await getFileCreatedMsFromFs(fileUri);
	}
	if (!Number.isFinite(createdMs)) {
		createdMs = Date.now();
	}

	if (context) {
		createdStore[key] = String(createdMs);
		await writeCreatedStore(context, createdStore);
	}
	return createdMs;
}

async function detectFileIdDrift(fileUri, text, context) {
	const createdMs = await resolveCreatedMsForIdentity(fileUri, text, context);
	const stem = stripKbNoteExtension(path.basename(fileUri.fsPath));
	const expectedId = makeFileId(stem, createdMs);
	const { topLines } = splitTopSection(text);
	const existing = parseIdentityFields(topLines);
	const currentId = String(existing.fileid || '').trim();
	if (isFileEntityIdLine(currentId)) {
		return { drift: false, expectedId: currentId, currentId, createdMs };
	}
	return {
		drift: currentId !== expectedId,
		expectedId,
		currentId,
		createdMs
	};
}

async function normalizeNoteIdentityText(fileUri, text, options) {
	const opts = options || {};
	const key = fileUri.toString();

	const createdMs = await resolveCreatedMsForIdentity(fileUri, text, opts.context);
	const { topLines } = splitTopSection(text);
	const existing = parseIdentityFields(topLines);

	const stem = stripKbNoteExtension(path.basename(fileUri.fsPath));
	const canonicalId = makeFileId(stem, createdMs);
	const headerId = String(existing.fileid || '').trim();
	const headerIsSequential = isFileEntityIdLine(headerId);
	const allowCorrect =
		!headerIsSequential &&
		Boolean(opts.allowAutoCorrectFileIdDrift) &&
		!opts.forceRecomputeFileId &&
		Boolean(headerId) &&
		headerId !== canonicalId;

	const fileIdStore = await readFileIdStore(opts.context);
	let lockedFileId = '';

	if (headerIsSequential && headerId) {
		lockedFileId = headerId;
	} else if (opts.forceRecomputeFileId || opts.forceCanonicalFileId || allowCorrect) {
		lockedFileId = canonicalId;
	} else if (fileIdStore && typeof fileIdStore[key] === 'string' && String(fileIdStore[key]).trim()) {
		lockedFileId = String(fileIdStore[key]).trim();
	} else {
		const diskFileId = await readFileIdFromDisk(fileUri);
		if (diskFileId) {
			lockedFileId = diskFileId;
		}
	}

	if (!lockedFileId) {
		if (String(existing.fileid || '').trim()) {
			lockedFileId = String(existing.fileid || '').trim();
		} else {
			lockedFileId = makeFileId(stem, createdMs);
		}
	}
	if (opts.context) {
		fileIdStore[key] = lockedFileId;
		await writeFileIdStore(opts.context, fileIdStore);
	}

	return buildNormalizedNoteText(fileUri, text, {
		lockedCreatedMs: createdMs,
		forceRecomputeFileId: Boolean(opts.forceRecomputeFileId || opts.forceCanonicalFileId || allowCorrect),
		lockedFileId
	});
}

async function normalizeNoteIdentityFile(fileUri, options) {
	const opts = options || {};
	const text = await readTextFile(fileUri);
	const next = await normalizeNoteIdentityText(fileUri, text, opts);
	if (next !== text.replace(/\r\n/g, '\n')) {
		await writeTextFile(fileUri, next);
	}
	return next;
}

async function normalizeAllNoteIdentities(kbRoot, context) {
	await forEachKnowledgeBaseNote(
		kbRoot,
		async note => {
			if (!note?.uri || !fileNameMatchesKbNote(path.basename(note.uri.fsPath))) {
				return;
			}
			await normalizeNoteIdentityFile(note.uri, { context });
		},
		{ yieldEvery: 15 }
	);
}

module.exports = {
	formatCreatedIso,
	/** @deprecated prefer formatCreatedIso(ms); kept for callers expecting a Date */
	formatCreatedDate(date) {
		const d = date instanceof Date ? date : new Date(date);
		return formatCreatedIso(d.getTime());
	},
	parseCreatedToMs,
	makeFileId,
	computeExpectedFileId,
	resolveCreatedMsForIdentity,
	detectFileIdDrift,
	buildNormalizedNoteText,
	normalizeNoteIdentityText,
	normalizeNoteIdentityFile,
	normalizeAllNoteIdentities
};
