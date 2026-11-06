'use strict';

/**
 * Word / semantic / recommended search over Today day-note headings (`today.drip`).
 * Mirrors Project View issue search: word stays lexical; semantic ranks Today
 * heading vectors only; recommended mixes both (92% semantic / 8% word).
 */

const { openDripTodayDb } = require('./dripTodayDb');
const { openDripIndexDb } = require('./dripIndexDb');
const { todayDisplayPath } = require('../startup/dailyNotesDrip');
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

const MAX_TOP_EMBEDDINGS = 50;
const DEFAULT_TOP_EMBEDDINGS = 20;
const MAX_RESULTS = 100;

/**
 * @param {unknown} raw
 * @returns {'all' | 'task' | 'other'}
 */
function normalizeHeadingKind(raw) {
	const v = String(raw || '')
		.trim()
		.toLowerCase();
	if (v === 'task' || v === 'tasks') return 'task';
	if (v === 'other' || v === 'heading' || v === 'headings' || v === 'concept') return 'other';
	return 'all';
}

/**
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @returns {{ fileId: number, headingId: number, title: string, type: string, path: string, displayPath: string }[]}
 */
function listTodayHeadings(db) {
	const stmt = db.prepare(`
		SELECT h.file_id, h.heading_id, h.title,
		       COALESCE(mt.metadata_type_name, ''), f.path
		FROM headings h
		JOIN files f ON f.id = h.file_id
		LEFT JOIN metadata_types mt ON mt.metadata_type_id = h.metadata_type_id
		WHERE h.heading_id <> 0
		ORDER BY f.path ASC, h.heading_id ASC
	`);
	/** @type {{ fileId: number, headingId: number, title: string, type: string, path: string, displayPath: string }[]} */
	const out = [];
	try {
		while (stmt.step()) {
			const r = stmt.get();
			const path = String(r[4] || '').replace(/\\/g, '/');
			out.push({
				fileId: Number(r[0]),
				headingId: Number(r[1]),
				title: String(r[2] || ''),
				type: String(r[3] || ''),
				path,
				displayPath: todayDisplayPath(path)
			});
		}
	} finally {
		stmt.free();
	}
	return out;
}

/**
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {number[] | Float32Array} query
 * @param {Map<string, any>} byLoc
 * @param {number} topN
 * @returns {{ heading: any, distance: number }[]}
 */
function rankTodayHeadingEmbeddings(db, query, byLoc, topN) {
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

	/** @type {{ heading: any, distance: number }[]} */
	const scored = [];
	for (const row of db.native.prepare(`SELECT embedding_id, embedding FROM ${VECTORS_TABLE}`).all()) {
		const embeddingId = Number(row.embedding_id);
		const rec = records.get(embeddingId);
		if (!rec) continue;
		const vec = coerceVector(row.embedding, dimensions);
		if (!vec || vec.length !== dimensions) continue;
		const heading = byLoc.get(`${rec.file_id}:${rec.heading_id}`);
		if (!heading) continue;
		scored.push({ heading, distance: l2Squared(values, vec) });
	}
	scored.sort((a, b) => a.distance - b.distance);
	return scored.slice(0, Math.max(1, topN));
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
 * @param {any} row
 * @returns {{ fileId: number, headingId: number, title: string, type: string, path: string, displayPath: string, score?: number }}
 */
function toResultRow(row) {
	const path = String(row.path || row.relPath || '').replace(/\\/g, '/');
	return {
		fileId: Number(row.fileId),
		headingId: Number(row.headingId),
		title: String(row.title || ''),
		type: String(row.type || ''),
		path,
		displayPath: String(row.displayPath || todayDisplayPath(path)),
		score: Number(row._relevanceScore || row._embeddingScore || row._wordScore || 0) || undefined
	};
}

/**
 * @param {{ type?: string }} h
 * @param {'all' | 'task' | 'other'} kind
 */
function matchesHeadingKind(h, kind) {
	if (kind === 'all') return true;
	const type = String((h && h.type) || '')
		.trim()
		.toLowerCase();
	if (kind === 'task') return type === 'task';
	return type !== 'task';
}

/**
 * Rank Today headings against a query (word / semantic / recommended).
 * Skips h0 (date shell headings). Optional kind filter: all | task | other.
 * @param {import('vscode').Uri} kbRootUri
 * @param {{ query?: string, searchEngine?: string, topN?: number, seq?: number, limit?: number, headingKind?: string }} [opts]
 * @returns {Promise<{ rows: ReturnType<typeof toResultRow>[], searchEngine: 'word'|'semantic'|'recommended', query: string, seq: number, headingKind: 'all'|'task'|'other' }>}
 */
async function searchTodayHeadingsHybrid(kbRootUri, opts = {}) {
	const query = String(opts.query || '').trim();
	const engine = normalizeSearchEngine(opts.searchEngine || opts.engine);
	const topN = resolveTopN(opts.topN ?? opts.topEmbeddings);
	const seq = Number(opts.seq) || 0;
	const limit = Math.max(1, Math.min(MAX_RESULTS, Number(opts.limit) || 40));
	const headingKind = normalizeHeadingKind(opts.headingKind);

	if (!query) {
		return { rows: [], searchEngine: engine, query, seq, headingKind };
	}

	const handle = openDripTodayDb(kbRootUri);
	try {
		const headings = listTodayHeadings(handle.db).filter(h => matchesHeadingKind(h, headingKind));
		if (!headings.length) {
			return { rows: [], searchEngine: engine, query, seq, headingKind };
		}

		const wordWire = headings
			.map(h => ({
				...h,
				relPath: h.path,
				_wordScore: computeWordScore({ title: h.title, relPath: h.path }, query),
				_semanticScore: 0,
				_embeddingScore: 0,
				_relevanceScore: 0
			}))
			.filter(r => r._wordScore > 0)
			.sort((a, b) => (b._wordScore || 0) - (a._wordScore || 0));

		if (engine === 'word') {
			return {
				rows: wordWire.slice(0, limit).map(toResultRow),
				searchEngine: engine,
				query,
				seq,
				headingKind
			};
		}

		/** @type {any[]} */
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
			const byLoc = new Map();
			for (const h of headings) byLoc.set(`${h.fileId}:${h.headingId}`, h);
			const knn = rankTodayHeadingEmbeddings(handle.db, vector, byLoc, topN);
			for (const k of knn) {
				const s = distanceToScore(k.distance);
				semanticWire.push({
					...k.heading,
					relPath: k.heading.path,
					_semanticScore: s,
					_embeddingScore: s,
					_wordScore: 0
				});
			}
		} catch (err) {
			console.warn('[DRIP] today heading semantic search failed; falling back to word', err && err.message);
			semanticWire = [];
		}

		if (engine === 'semantic') {
			semanticWire.sort((a, b) => (b._semanticScore || 0) - (a._semanticScore || 0));
			const rows = (semanticWire.length ? semanticWire : wordWire).slice(0, limit).map(toResultRow);
			return { rows, searchEngine: engine, query, seq, headingKind };
		}

		const merged = mergeSearchEngineResults(semanticWire, wordWire, 'recommended');
		return {
			rows: merged.slice(0, limit).map(toResultRow),
			searchEngine: engine,
			query,
			seq,
			headingKind
		};
	} finally {
		handle.close();
	}
}

module.exports = {
	searchTodayHeadingsHybrid,
	MAX_TOP_EMBEDDINGS,
	DEFAULT_TOP_EMBEDDINGS
};
