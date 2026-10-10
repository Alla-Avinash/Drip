'use strict';

/**
 * Local (zero-token) retrieval for LLM ingest: the closest folders, files and headings
 * to a note, each with its KB path. One query vector, exact sqlite-vec scoring.
 *
 * Heading score mixes the heading's own vector with its file's path vector so the
 * heading leads and the file location breaks ties:
 *   score = HEADING_WEIGHT · sim(note, heading) + (1 − HEADING_WEIGHT) · sim(note, file)
 *
 * Project folders (`*.p`) are excluded — they follow the project / issue workflow.
 */

const vscode = require('vscode');
const { openDripIndexDb } = require('../indexing/dripIndexDb');
const { encodeHeadingEmbeddingText } = require('../indexing/embeddings/headingEmbeddingEncode');
const { getEmbeddingMeta, searchHeadingEmbeddingsExact } = require('../indexing/embeddings/headingEmbeddingStore');
const { loadCardsForEmbeddingIds, distanceToScore } = require('../indexing/embeddings/headingEmbeddingSearch');
const { searchFolderEmbeddingsExact } = require('../indexing/embeddings/folderEmbeddingStore');
const { scoreAllFileEmbeddings } = require('../indexing/embeddings/fileEmbeddingStore');
const { syncFileEmbeddings } = require('../indexing/embeddings/fileEmbeddingSync');
const { normalizeCorpusOptions, isPathVisibleForCorpus } = require('../indexing/kbFilesystem');
const { isDripProjectFolderName } = require('../document/model/dripProjectFolder');

const FOLDER_LIMIT = 4;
const FILE_LIMIT = 8;
const HEADING_LIMIT = 12;
const HEADING_WEIGHT = 0.7;
/** Heading KNN pool before re-ranking with the file score. */
const HEADING_POOL = 60;
const QUERY_CHAR_LIMIT = 2000;

/**
 * @typedef {{ path: string, score: number }} FolderCandidate
 * @typedef {{ path: string, fileId: number, score: number }} FileCandidate
 * @typedef {{ path: string, fileId: number, headingId: number, title: string, parentTitle: string, score: number }} HeadingCandidate
 */

/** @param {string} rel */
function inProjectFolder(rel) {
	return String(rel || '').split('/').some(seg => isDripProjectFolderName(seg));
}

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {string} rel
 * @param {ReturnType<typeof normalizeCorpusOptions>} corpusOpts
 */
async function visible(kbRoot, rel, corpusOpts) {
	if (inProjectFolder(rel)) return false;
	if (!rel || rel === '.') return true;
	return isPathVisibleForCorpus(kbRoot, rel, corpusOpts);
}

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {string} queryText note title + body
 * @param {unknown} [corpusRaw] Storage corpus selector payload
 * @returns {Promise<{ folders: FolderCandidate[], files: FileCandidate[], headings: HeadingCandidate[], timings: { syncMs: number, encodeMs: number, searchMs: number } }>}
 */
async function findIngestCandidates(kbRoot, queryText, corpusRaw) {
	const timings = { syncMs: 0, encodeMs: 0, searchMs: 0 };
	const q = String(queryText || '').trim().slice(0, QUERY_CHAR_LIMIT);
	if (!q) return { folders: [], files: [], headings: [], timings };
	const corpusOpts = normalizeCorpusOptions(corpusRaw);

	let t = Date.now();
	await syncFileEmbeddings(kbRoot);
	timings.syncMs = Date.now() - t;
	t = Date.now();

	let modelId = '';
	{
		const handle = await openDripIndexDb(kbRoot);
		try {
			modelId = getEmbeddingMeta(handle.db).model;
		} finally {
			handle.close();
		}
	}
	const vector = await encodeHeadingEmbeddingText(q, { modelId });
	timings.encodeMs = Date.now() - t;
	t = Date.now();

	const handle = await openDripIndexDb(kbRoot);
	try {
		const db = handle.db;

		/** @type {Map<string, { fileId: number, score: number }>} */
		const fileScores = new Map();
		const idByPath = new Map(
			db.native
				.prepare(`SELECT id, path FROM files`)
				.all()
				.map(r => [String(r.path || '').replace(/\\/g, '/'), Number(r.id)])
		);
		for (const row of scoreAllFileEmbeddings(db, vector)) {
			if (!idByPath.has(row.file_path)) continue;
			fileScores.set(row.file_path, { fileId: idByPath.get(row.file_path), score: distanceToScore(row.distance) });
		}

		/** @type {FileCandidate[]} */
		const files = [];
		for (const [p, f] of fileScores) {
			if (files.length >= FILE_LIMIT) break;
			if (await visible(kbRoot, p, corpusOpts)) files.push({ path: p, fileId: f.fileId, score: f.score });
		}

		const knn = searchHeadingEmbeddingsExact(db, vector, HEADING_POOL);
		const cards = loadCardsForEmbeddingIds(db, knn.map(k => k.embedding_id), kbRoot);
		/** @type {HeadingCandidate[]} */
		const pool = [];
		for (const k of knn) {
			const card = cards.get(Number(k.embedding_id));
			if (!card || Number(card.heading_id) <= 0) continue;
			if (!(await visible(kbRoot, card.relPath, corpusOpts))) continue;
			const fileScore = (fileScores.get(card.relPath) || { score: 0 }).score;
			pool.push({
				path: card.relPath,
				fileId: Number(card.file_id),
				headingId: Number(card.heading_id),
				title: card.title,
				parentTitle: '',
				score: HEADING_WEIGHT * distanceToScore(k.distance) + (1 - HEADING_WEIGHT) * fileScore
			});
		}
		pool.sort((a, b) => b.score - a.score);
		const headings = pool.slice(0, HEADING_LIMIT);

		// Parent titles are display-only for the LLM prompt, so fetch them for the
		// finalists only (up to HEADING_LIMIT) — not the whole pool.
		const parentStmt = db.native.prepare(
			`SELECT p.title AS title FROM headings h
			JOIN headings p ON p.file_id = h.file_id AND p.heading_id = h.parent
			WHERE h.file_id = ? AND h.heading_id = ? AND p.heading_id > 0`
		);
		for (const h of headings) {
			const parent = parentStmt.get(h.fileId, h.headingId);
			h.parentTitle = parent ? String(parent.title || '') : '';
		}

		/** @type {FolderCandidate[]} */
		const folders = [];
		for (const row of searchFolderEmbeddingsExact(db, vector, FOLDER_LIMIT * 4)) {
			if (folders.length >= FOLDER_LIMIT) break;
			const p = String(row.folder_path || '.');
			if (await visible(kbRoot, p, corpusOpts)) folders.push({ path: p, score: distanceToScore(row.distance) });
		}

		timings.searchMs = Date.now() - t;
		return { folders, files, headings, timings };
	} finally {
		handle.close();
	}
}

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {string} rel KB-relative path (`.` = root)
 */
function kbUri(kbRoot, rel) {
	const parts = String(rel || '').split('/').filter(p => p && p !== '.');
	return parts.length ? vscode.Uri.joinPath(kbRoot, ...parts) : kbRoot;
}

module.exports = { findIngestCandidates, kbUri, FOLDER_LIMIT, FILE_LIMIT, HEADING_LIMIT, HEADING_WEIGHT };
