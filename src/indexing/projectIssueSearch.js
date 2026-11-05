'use strict';

/**
 * Semantic + word search over a project's issues (Project View issue search bar).
 *
 * Issues live in `projects.drip`, so this mirrors the Retriever's hybrid ranking but
 * scoped to one project's issues and backed by project-zone heading embeddings
 * (stored in `projects.drip`). Word mode stays on the webview; the host only runs the
 * semantic / recommended paths.
 */

const { listProjectChildrenFromIndex } = require('./projectViewQuery');
const { openDripProjectsDb } = require('./dripProjectDb');
const { openDripIndexDb } = require('./dripIndexDb');
const { encodeHeadingEmbeddingText } = require('./embeddings/headingEmbeddingEncode');
const {
	getEmbeddingMeta,
	RECORDS_TABLE,
	VECTORS_TABLE
} = require('./embeddings/headingEmbeddingStore');
const { l2Squared, coerceVector } = require('./embeddings/vectorMath');
const {
	computeWordScore,
	distanceToScore,
	normalizeSearchEngine,
	mergeSearchEngineResults
} = require('./embeddings/headingEmbeddingSearch');

/** Top-N for project issue semantic/recommended search (user field defaults to 20). */
const MAX_TOP_EMBEDDINGS = 50;
const DEFAULT_TOP_EMBEDDINGS = 20;

/**
 * Rank embeddings for one project's issues only (no score cutoff — just top-N by distance).
 * Unlike a global KNN then filter, this scores every issue that has a vector in this project,
 * so other projects' headings cannot crowd the top-N out.
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {number[] | Float32Array} query
 * @param {Map<string, any>} byLoc `fileId:headingId` → issue
 * @param {number} topN
 * @returns {{ issue: any, distance: number }[]}
 */
function rankProjectIssueEmbeddings(db, query, byLoc, topN) {
	const { dimensions } = getEmbeddingMeta(db);
	const values = Array.from(query);
	if (values.length !== dimensions || !db.native || !byLoc.size) return [];

	/** @type {Map<number, { file_id: number, heading_id: number }>} */
	const records = new Map();
	for (const r of db.native.prepare(`SELECT embedding_id, file_id, heading_id FROM ${RECORDS_TABLE}`).all()) {
		const fileId = Number(r.file_id);
		const headingId = Number(r.heading_id);
		if (!byLoc.has(`${fileId}:${headingId}`)) continue;
		records.set(Number(r.embedding_id), { file_id: fileId, heading_id: headingId });
	}
	if (!records.size) return [];

	/** @type {{ issue: any, distance: number }[]} */
	const scored = [];
	for (const row of db.native.prepare(`SELECT embedding_id, embedding FROM ${VECTORS_TABLE}`).all()) {
		const embeddingId = Number(row.embedding_id);
		const rec = records.get(embeddingId);
		if (!rec) continue;
		const vec = coerceVector(row.embedding, dimensions);
		if (!vec || vec.length !== dimensions) continue;
		const issue = byLoc.get(`${rec.file_id}:${rec.heading_id}`);
		if (!issue) continue;
		scored.push({ issue, distance: l2Squared(values, vec) });
	}
	scored.sort((a, b) => a.distance - b.distance);
	return scored.slice(0, Math.max(1, topN));
}

/**
 * @param {unknown} k
 * @returns {string}
 */
function normalizeIssueKey(k) {
	return String(k || '')
		.trim()
		.toLowerCase()
		.replace(/^i-(\d+)$/i, (_, n) => `i-${parseInt(n, 10)}`);
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
function resolveTopN(raw) {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP_EMBEDDINGS;
	return Math.min(Math.floor(n), MAX_TOP_EMBEDDINGS);
}

/**
 * Rank a project's issues against a query using project embeddings + word scoring.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} projectFolderPrefix e.g. `App.p/`
 * @param {{ query?: string, searchEngine?: string, topN?: number, seq?: number }} [opts]
 * @returns {Promise<{ order: string[], searchEngine: 'word'|'semantic'|'recommended', query: string, seq: number }>}
 */
async function searchProjectIssues(kbRootUri, projectFolderPrefix, opts = {}) {
	const query = String(opts.query || '').trim();
	const engine = normalizeSearchEngine(opts.searchEngine || opts.engine);
	const topN = resolveTopN(opts.topN ?? opts.topEmbeddings);
	const seq = Number(opts.seq) || 0;

	const { issues } = await listProjectChildrenFromIndex(kbRootUri, projectFolderPrefix);
	if (!issues.length || !query) {
		return {
			order: issues.map(i => normalizeIssueKey(i.issueKey)).filter(Boolean),
			searchEngine: engine,
			query,
			seq
		};
	}

	// Word matches (title / path tokenized) — used by word mode, recommended, and as a
	// fallback when embeddings are missing or the semantic scan finds nothing.
	const wordWire = issues
		.map(i => ({
			...i,
			relPath: i.path,
			_wordScore: computeWordScore({ title: i.title, relPath: i.path }, query),
			_semanticScore: 0,
			_embeddingScore: 0,
			_relevanceScore: 0
		}))
		.filter(r => r._wordScore > 0)
		.sort((a, b) => (b._wordScore || 0) - (a._wordScore || 0));

	if (engine === 'word') {
		return {
			order: wordWire.map(r => normalizeIssueKey(r.issueKey)).filter(Boolean),
			searchEngine: engine,
			query,
			seq
		};
	}

	// Semantic matches: embed the query, then rank THIS project's issue vectors only.
	// No score threshold (nothing like "only above 50%") — just the closest top-N by L2.
	let semanticWire = [];
	try {
		let modelId = '';
		{
			const h = await openDripIndexDb(kbRootUri);
			try {
				modelId = getEmbeddingMeta(h.db).model;
			} finally {
				h.close();
			}
		}
		const vector = await encodeHeadingEmbeddingText(query, { modelId });

		const ph = openDripProjectsDb(kbRootUri);
		try {
			const byLoc = new Map();
			for (const i of issues) byLoc.set(`${i.fileId}:${i.headingId}`, i);
			const knn = rankProjectIssueEmbeddings(ph.db, vector, byLoc, topN);
			for (const k of knn) {
				const s = distanceToScore(k.distance);
				semanticWire.push({
					...k.issue,
					relPath: k.issue.path,
					_semanticScore: s,
					_embeddingScore: s,
					_wordScore: 0
				});
			}
		} finally {
			ph.close();
		}
	} catch (err) {
		console.warn('[DRIP] project issue semantic search failed; falling back to word', err && err.message);
		semanticWire = [];
	}

	if (engine === 'semantic') {
		semanticWire.sort((a, b) => (b._semanticScore || 0) - (a._semanticScore || 0));
		return {
			order: semanticWire.map(r => normalizeIssueKey(r.issueKey)).filter(Boolean),
			searchEngine: engine,
			query,
			seq
		};
	}

	// Recommended: semantic dominates (0.92) with word as a tie-breaker (0.08), so the
	// top embedding matches lead and any extra word-only matches follow.
	const merged = mergeSearchEngineResults(semanticWire, wordWire, 'recommended');
	return {
		order: merged.map(r => normalizeIssueKey(r.issueKey)).filter(Boolean),
		searchEngine: engine,
		query,
		seq
	};
}

module.exports = {
	searchProjectIssues,
	MAX_TOP_EMBEDDINGS,
	DEFAULT_TOP_EMBEDDINGS
};
