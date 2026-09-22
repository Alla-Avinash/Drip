'use strict';

/**
 * Heading semantic search over `index.drip` vectors.
 *
 * Exact path (≤1000 locked): embed query once → sqlite-vec KNN → join card fields from SQLite.
 * FAISS path (>1000 locked): embed query → HNSW ANN (`.dripindex/heading-embeddings.faiss`) → cards.
 * Never opens `.d.txt` files to build results.
 */

const path = require('path');
const vscode = require('vscode');
const { openDripIndexDb } = require('../dripIndexDb');
const { encodeHeadingEmbeddingText } = require('./headingEmbeddingEncode');
const {
	getEmbeddingMeta,
	searchHeadingEmbeddingsExact,
	RECORDS_TABLE
} = require('./headingEmbeddingStore');
const {
	lockHeadingEmbeddingSearchMethod,
	getLockedHeadingEmbeddingSearchMethod
} = require('./headingEmbeddingSearchMethod');

/**
 * @typedef {{
 *   embedding_id: number,
 *   distance: number,
 *   score: number,
 *   file_id: number,
 *   heading_id: number,
 *   title: string,
 *   relPath: string,
 *   fileName: string,
 *   typeId: string,
 *   tags: string[],
 *   relations?: Record<string, string[]>,
 *   metadataKv?: Record<string, string>,
 *   uri: string,
 *   id: string,
 *   line: number,
 *   fileId: string,
 *   mtime: number
 * }} HeadingEmbeddingSearchHit
 */

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeLowerIdList(raw) {
	if (!Array.isArray(raw)) return [];
	/** @type {string[]} */
	const out = [];
	const seen = new Set();
	for (const x of raw) {
		const id = String(x || '')
			.trim()
			.toLowerCase();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/**
 * @param {unknown} payload
 */
function normalizeRetrieverIndexQuery(payload) {
	const p = payload && typeof payload === 'object' ? /** @type {Record<string, unknown>} */ (payload) : {};
	const offsetRaw = Number(p.offset);
	const limitRaw = Number(p.limit);
	const sortRaw = String(p.sortBy || 'relevance').toLowerCase();
	// Browse-only sort leftover; ranking for queries uses searchEngine.
	const sortBy = sortRaw === 'title' ? 'title' : 'relevance';
	const searchEngine = normalizeSearchEngine(p.searchEngine ?? p.search_engine);
	const tagMode = 'relevant';
	const corpusRaw = String(p.corpus || '').toLowerCase();
	const customCorpusPaths = normalizeCustomCorpusEntries(p.customCorpusPaths ?? p.customPaths);
	const isCustomCorpus = corpusRaw === 'custom' || customCorpusPaths.length > 0;
	// Working set = honor .dripignore. Entire KB / custom path set = do not apply dripignore.
	const respectDripignore =
		isCustomCorpus || p.respectDripignore === false || corpusRaw === 'entire'
			? false
			: p.respectDripignore === true || corpusRaw === 'working'
				? true
				: true;
	const relationMode = 'relevant';
	const relationFilters = normalizeRelationFilters(
		p.selectedRelations ?? p.relationFilters,
		p.relationType ?? p.selectedRelationType,
		p.selectedRelationTags ?? p.relationTags
	);
	const relationType = relationFilters.length ? relationFilters[0].type : '';
	const relationTags = relationFilters.length ? relationFilters[0].tags.slice() : [];
	/** Mutual-exclusive scope: `scope: 'files'|'headings'` wins; else legacy checkboxes (default headings). */
	const scopeRaw = String(p.scope || '').trim().toLowerCase();
	let scopeFiles = false;
	let scopeHeadings = true;
	if (scopeRaw === 'files' || scopeRaw === 'file') {
		scopeFiles = true;
		scopeHeadings = false;
	} else if (scopeRaw === 'headings' || scopeRaw === 'heading') {
		scopeFiles = false;
		scopeHeadings = true;
	} else if (p.scopeFiles === true && p.scopeHeadings === false) {
		scopeFiles = true;
		scopeHeadings = false;
	} else if (p.scopeFiles === false && p.scopeHeadings === true) {
		scopeFiles = false;
		scopeHeadings = true;
	} else if (p.scopeFiles === true && p.scopeHeadings === true) {
		// Legacy both-on → headings (new default)
		scopeFiles = false;
		scopeHeadings = true;
	} else if (p.scopeFiles === false && p.scopeHeadings === false) {
		scopeFiles = false;
		scopeHeadings = false;
	}
	return {
		q: typeof p.q === 'string' ? p.q : '',
		typeIds: normalizeLowerIdList(p.selectedTypeIds ?? p.typeIds),
		tags: normalizeLowerIdList(p.selectedTags ?? p.tags),
		tagMode,
		relationType,
		relationTags,
		relationFilters,
		relationMode,
		scopeFiles,
		scopeHeadings,
		scope: scopeFiles && !scopeHeadings ? 'files' : 'headings',
		sortBy,
		searchEngine,
		offset: Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0,
		limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 100,
		corpus: isCustomCorpus ? 'custom' : corpusRaw === 'entire' ? 'entire' : 'working',
		customCorpusPaths,
		respectDripignore
	};
}

/**
 * @param {unknown} raw
 * @returns {{ path: string, kind: 'file'|'folder', name: string }[]}
 */
function normalizeCustomCorpusEntries(raw) {
	if (!Array.isArray(raw)) return [];
	/** @type {{ path: string, kind: 'file'|'folder', name: string }[]} */
	const out = [];
	const seen = new Set();
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const rec = /** @type {Record<string, unknown>} */ (item);
		const p = String(rec.path || '')
			.replace(/\\/g, '/')
			.replace(/^\/+/, '')
			.replace(/\/+$/, '')
			.trim();
		if (!p || p === '.' || seen.has(p.toLowerCase())) continue;
		seen.add(p.toLowerCase());
		const kind = String(rec.kind || '').toLowerCase() === 'folder' ? 'folder' : 'file';
		const name =
			String(rec.name || '').trim() ||
			(p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p);
		out.push({ path: p, kind, name });
	}
	return out;
}

/**
 * Keep rows under custom corpus file/folder paths (KB-relative).
 * @template {{ relPath?: string }} T
 * @param {T[]} rows
 * @param {{ path: string, kind: 'file'|'folder' }[]} entries
 * @returns {T[]}
 */
function filterWireRowsByCustomCorpus(rows, entries) {
	const list = Array.isArray(entries) ? entries : [];
	if (!list.length) return Array.isArray(rows) ? rows : [];
	const norms = list.map(e => ({
		path: String(e.path || '')
			.replace(/\\/g, '/')
			.replace(/\/+$/, '')
			.toLowerCase(),
		kind: e.kind === 'folder' ? 'folder' : 'file'
	})).filter(e => e.path);
	if (!norms.length) return Array.isArray(rows) ? rows : [];
	return (Array.isArray(rows) ? rows : []).filter(row => {
		const rel = String((row && row.relPath) || '')
			.replace(/\\/g, '/')
			.replace(/^\/+/, '')
			.toLowerCase();
		if (!rel) return false;
		for (const e of norms) {
			if (e.kind === 'file') {
				if (rel === e.path) return true;
			} else if (rel === e.path || rel.startsWith(e.path + '/')) {
				return true;
			}
		}
		return false;
	});
}

/**
 * Drop rows whose `relPath` is ignored by nested `.dripignore` (and hard excludes).
 * @template {{ relPath?: string }} T
 * @param {import('vscode').Uri} kbRootUri
 * @param {T[]} rows
 * @param {boolean} respectDripignore
 * @returns {Promise<T[]>}
 */
async function filterWireRowsByDripignore(kbRootUri, rows, respectDripignore) {
	if (!respectDripignore || !rows || !rows.length) {
		return rows || [];
	}
	const { isPathIgnored } = require('../kbFilesystem');
	/** @type {Map<string, boolean>} */
	const cache = new Map();
	/** @type {T[]} */
	const out = [];
	for (const row of rows) {
		const rel = String((row && row.relPath) || '')
			.replace(/\\/g, '/')
			.replace(/^\/+/, '');
		if (!rel) {
			out.push(row);
			continue;
		}
		let ignored = cache.get(rel);
		if (ignored === undefined) {
			ignored = await isPathIgnored(kbRootUri, rel);
			cache.set(rel, ignored);
		}
		if (!ignored) out.push(row);
	}
	return out;
}

/**
 * @param {{ tags?: string[] }} row
 * @param {string[]} selectedTags
 * @returns {number}
 */
function tagIntersectionCount(row, selectedTags) {
	if (!selectedTags || !selectedTags.length) return 0;
	const have = new Set(
		(Array.isArray(row && row.tags) ? row.tags : []).map(t =>
			String(t || '')
				.trim()
				.toLowerCase()
		)
	);
	let n = 0;
	for (const need of selectedTags) {
		if (have.has(need)) n += 1;
	}
	return n;
}

/**
 * @param {unknown} raw
 * @param {unknown} legacyType
 * @param {unknown} legacyTags
 * @returns {{ type: string, tags: string[] }[]}
 */
function normalizeRelationFilters(raw, legacyType, legacyTags) {
	/** @type {{ type: string, tags: string[] }[]} */
	const out = [];
	const seen = new Set();
	if (Array.isArray(raw)) {
		for (const item of raw) {
			if (!item || typeof item !== 'object') continue;
			const rec = /** @type {Record<string, unknown>} */ (item);
			const type = String(rec.type || rec.relationType || '')
				.trim()
				.toLowerCase();
			if (!type || type === 'tags' || seen.has(type)) continue;
			const tags = normalizeLowerIdList(rec.tags ?? rec.relationTags);
			if (!tags.length) continue;
			seen.add(type);
			out.push({ type, tags });
		}
	}
	if (!out.length) {
		const type = String(legacyType || '')
			.trim()
			.toLowerCase();
		const tags = normalizeLowerIdList(legacyTags);
		if (type && type !== 'tags' && tags.length) out.push({ type, tags });
	}
	return out;
}

/**
 * Overlap of selected relation tags for one relation type on a wire row.
 * @param {{ relations?: Record<string, string[]> }} row
 * @param {string} relationType
 * @param {string[]} relationTags
 * @returns {number}
 */
function relationIntersectionCount(row, relationType, relationTags) {
	if (!relationType || !relationTags || !relationTags.length) return 0;
	const bag =
		row && row.relations && typeof row.relations === 'object'
			? row.relations[relationType]
			: null;
	const have = new Set(
		(Array.isArray(bag) ? bag : []).map(t =>
			String(t || '')
				.trim()
				.toLowerCase()
		)
	);
	let n = 0;
	for (const need of relationTags) {
		if (have.has(need)) n += 1;
	}
	return n;
}

/**
 * Sum of tag overlaps across all relation filters.
 * @param {{ relations?: Record<string, string[]> }} row
 * @param {{ type: string, tags: string[] }[]} filters
 */
function relationFiltersOverlapCount(row, filters) {
	let n = 0;
	for (const f of Array.isArray(filters) ? filters : []) {
		n += relationIntersectionCount(row, f.type, f.tags);
	}
	return n;
}

/**
 * Type: OR of selected ids (`__none__` = no metadata type).
 * Tags: Exact = must include every selected tag; Relevant = no hard filter (rank by overlap).
 * Relations: AND across types; Exact = all tags per type; Relevant = no hard filter.
 * @param {{ typeId?: string, tags?: string[], relations?: Record<string, string[]> }} row
 * @param {{
 *   typeIds: string[],
 *   tags: string[],
 *   tagMode?: string,
 *   relationType?: string,
 *   relationTags?: string[],
 *   relationFilters?: { type: string, tags: string[] }[],
 *   relationMode?: string
 * }} filters
 */
function rowMatchesTypeTagFilters(row, filters) {
	if (filters.typeIds.length) {
		const tid = String((row && row.typeId) || '')
			.trim()
			.toLowerCase();
		const wantsNone = filters.typeIds.includes('__none__');
		const typed = filters.typeIds.filter(x => x !== '__none__');
		let ok = false;
		if (wantsNone && !tid) ok = true;
		if (typed.length && tid && typed.includes(tid)) ok = true;
		if (!ok) return false;
	}
	if (filters.tags.length && filters.tagMode !== 'relevant') {
		// Exact: every selected tag must be present.
		if (tagIntersectionCount(row, filters.tags) < filters.tags.length) return false;
	}
	const relFilters =
		Array.isArray(filters.relationFilters) && filters.relationFilters.length
			? filters.relationFilters
			: filters.relationType && Array.isArray(filters.relationTags) && filters.relationTags.length
				? [{ type: filters.relationType, tags: filters.relationTags }]
				: [];
	if (relFilters.length && filters.relationMode !== 'relevant') {
		for (const f of relFilters) {
			if (relationIntersectionCount(row, f.type, f.tags) < f.tags.length) return false;
		}
	}
	return true;
}

/**
 * Keep first row per note path (embedding rank / browse order).
 * @template {{ relPath?: string }} T
 * @param {T[]} rows
 * @returns {T[]}
 */
function dedupeOnePerFile(rows) {
	const seen = new Set();
	/** @type {T[]} */
	const out = [];
	for (const row of rows || []) {
		const rel = String((row && row.relPath) || '');
		if (seen.has(rel)) continue;
		seen.add(rel);
		out.push(row);
	}
	return out;
}

/**
 * Rank for display: relation overlap → tag overlap → relevance score.
 * @param {ReturnType<typeof embeddingHitsToRetrieverWireRows>} rows
 * @param {{
 *   tags: string[],
 *   sortBy?: 'relevance'|'title',
 *   relationType?: string,
 *   relationTags?: string[],
 *   relationFilters?: { type: string, tags: string[] }[]
 * }} opts
 */
function rankWireRows(rows, opts) {
	const relFilters =
		Array.isArray(opts.relationFilters) && opts.relationFilters.length
			? opts.relationFilters
			: opts.relationType && Array.isArray(opts.relationTags) && opts.relationTags.length
				? [{ type: opts.relationType, tags: opts.relationTags }]
				: [];
	const list = (Array.isArray(rows) ? rows : []).map(r => ({
		...r,
		_tagOverlap: tagIntersectionCount(r, opts.tags || []),
		_relationOverlap: relationFiltersOverlapCount(r, relFilters)
	}));
	const wantTitle = opts.sortBy === 'title';
	const hasTags = (opts.tags || []).length > 0;
	const hasRel = relFilters.length > 0;
	list.sort((a, b) => {
		if (hasRel) {
			const ra = Number(a._relationOverlap) || 0;
			const rb = Number(b._relationOverlap) || 0;
			if (ra !== rb) return rb - ra;
		}
		if (hasTags) {
			const ia = Number(a._tagOverlap) || 0;
			const ib = Number(b._tagOverlap) || 0;
			if (ia !== ib) return ib - ia;
		}
		if (wantTitle) {
			return String((a && a.title) || '').localeCompare(String((b && b.title) || ''), undefined, {
				sensitivity: 'base'
			});
		}
		const sa =
			Number(a && a._relevanceScore) ||
			Number(a && a._embeddingScore) ||
			0;
		const sb =
			Number(b && b._relevanceScore) ||
			Number(b && b._embeddingScore) ||
			0;
		if (sa !== sb) return sb - sa;
		return String((a && a.title) || '').localeCompare(String((b && b.title) || ''), undefined, {
			sensitivity: 'base'
		});
	});
	return list;
}

/**
 * @deprecated use rankWireRows — kept for callers
 * @param {ReturnType<typeof embeddingHitsToRetrieverWireRows>} rows
 * @param {'relevance'|'title'|'recent'|'path'} sortBy
 */
function sortWireRows(rows, sortBy) {
	return rankWireRows(rows, {
		tags: [],
		sortBy: sortBy === 'title' ? 'title' : 'relevance'
	});
}

/**
 * @param {unknown} raw
 * @returns {'recommended'|'semantic'|'word'}
 */
function normalizeSearchEngine(raw) {
	const v = String(raw || '')
		.trim()
		.toLowerCase();
	if (v === 'semantic' || v === 'embedding' || v === 'only-semantic' || v === 'only_semantic') {
		return 'semantic';
	}
	if (v === 'word' || v === 'lexical' || v === 'text' || v === 'only-word' || v === 'only_word') {
		return 'word';
	}
	// recommended | hybrid | default
	return 'recommended';
}

/** Recommended mix: semantic dominates; word is a light tie-breaker / exact-match nudge. */
const RECOMMENDED_SEMANTIC_WEIGHT = 0.92;
const RECOMMENDED_WORD_WEIGHT = 0.08;

/** Tiny tokens that explode OR recall without adding meaning. */
const WORD_SEARCH_STOP = new Set([
	'a',
	'an',
	'the',
	'of',
	'to',
	'in',
	'on',
	'at',
	'for',
	'and',
	'or',
	'is',
	'are',
	'be',
	'as',
	'by',
	'it',
	'its',
	'vs'
]);

/**
 * @param {string} queryText
 * @returns {string[]}
 */
function tokenizeWordQuery(queryText) {
	const raw = String(queryText || '')
		.trim()
		.toLowerCase()
		.split(/[^a-z0-9_./+-]+/i)
		.map(t => t.trim())
		.filter(t => t.length > 0);
	const filtered = raw.filter(t => t.length >= 2 && !WORD_SEARCH_STOP.has(t));
	// If filtering wiped everything (e.g. query is only "a"), fall back to raw tokens.
	return filtered.length ? filtered : raw;
}

/**
 * Word-match score in [0, 1] (OR retrieval).
 * Any token in title/path can qualify; more title hits → higher score.
 * @param {{ title?: string, relPath?: string }} row
 * @param {string} queryText
 * @returns {number}
 */
function computeWordScore(row, queryText) {
	const nq = String(queryText || '')
		.trim()
		.toLowerCase();
	const tokens = tokenizeWordQuery(nq);
	if (!tokens.length) return 0;
	const title = String((row && row.title) || '').toLowerCase();
	const relPath = String((row && row.relPath) || '').toLowerCase();

	let titleHits = 0;
	let pathHits = 0;
	let anyHit = false;
	for (const t of tokens) {
		const inTitle = title.includes(t);
		const inPath = relPath.includes(t);
		if (inTitle || inPath) anyHit = true;
		if (inTitle) titleHits += 1;
		if (inPath) pathHits += 1;
	}
	if (!anyHit) return 0;

	const n = tokens.length;
	const titleFrac = titleHits / n;
	const pathFrac = pathHits / n;
	// Title coverage is the main signal; path is a small bonus.
	let score = 0.88 * titleFrac + 0.12 * pathFrac;
	if (title === nq) score = 1;
	else if (title.startsWith(nq) || title.includes(nq)) score = Math.min(1, score + 0.1);
	// Prefer denser title coverage when fractions tie (e.g. 2/2 vs 1/1 already equal).
	if (titleHits > 0) score = Math.min(1, score + 0.02 * Math.min(titleHits, 3));
	return Math.max(0, Math.min(1, score));
}

/**
 * Escape LIKE wildcards for SQLite.
 * @param {string} s
 */
function escapeLikePattern(s) {
	return String(s || '')
		.replace(/\\/g, '\\\\')
		.replace(/%/g, '\\%')
		.replace(/_/g, '\\_');
}

/**
 * Lexical / word search over heading titles + file paths in `index.drip`.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} queryText
 * @param {{ limit?: number, includeRelations?: boolean }} [opts]
 * @returns {Promise<ReturnType<typeof embeddingHitsToRetrieverWireRows>>}
 */
async function searchHeadingsByWord(kbRootUri, queryText, opts) {
	const tokens = tokenizeWordQuery(queryText);
	if (!tokens.length) return [];
	const limitRaw = Number(opts && opts.limit);
	const limit =
		Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 200;
	const includeRelations = Boolean(opts && opts.includeRelations);

	const handle = await openDripIndexDb(kbRootUri);
	try {
		if (!handle.db.native) return [];
		/** @type {string[]} */
		const whereParts = [];
		/** @type {unknown[]} */
		const params = [];
		for (const t of tokens) {
			const pat = `%${escapeLikePattern(t)}%`;
			whereParts.push(`(LOWER(h.title) LIKE ? ESCAPE '\\' OR LOWER(f.path) LIKE ? ESCAPE '\\')`);
			params.push(pat, pat);
		}
		// OR across tokens: any token can qualify; ranking prefers titles with more hits.
		const whereSql = whereParts.length ? `WHERE (${whereParts.join(' OR ')})` : '';
		const rows = handle.db.native
			.prepare(
				`
				SELECT
					COALESCE(r.embedding_id, 0) AS embedding_id,
					h.file_id AS file_id,
					h.heading_id AS heading_id,
					h.title AS title,
					f.path AS path,
					f.name AS file_name,
					COALESCE(f.updated_at, 0) AS updated_at,
					COALESCE(mt.metadata_type_name, '') AS type_name
				FROM headings h
				JOIN files f ON f.id = h.file_id
				LEFT JOIN ${RECORDS_TABLE} r
					ON r.file_id = h.file_id AND r.heading_id = h.heading_id
				LEFT JOIN metadata_types mt ON mt.metadata_type_id = h.metadata_type_id
				${whereSql}
				ORDER BY LOWER(h.title), f.path, h.heading_id
				LIMIT ?
				`
			)
			.all(...params, Math.min(2000, limit * 8));

		const embeddingIds = rows
			.map(r => Number(r.embedding_id) || 0)
			.filter(id => id > 0);
		const cards =
			embeddingIds.length > 0
				? loadCardsForEmbeddingIds(handle.db, embeddingIds, kbRootUri, {
						includeRelations
					})
				: new Map();

		/** @type {ReturnType<typeof embeddingHitsToRetrieverWireRows>} */
		const wire = [];
		const seen = new Set();
		for (const row of rows) {
			const fid = String(row.file_id || '');
			const hid = Number(row.heading_id) || 0;
			const key = `${fid}:${hid}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const eid = Number(row.embedding_id) || 0;
			const card = eid > 0 ? cards.get(eid) : null;
			const relPath = String((card && card.relPath) || row.path || '')
				.replace(/\\/g, '/')
				.replace(/^\/+/, '');
			const title = String((card && card.title) || row.title || '');
			const wordScore = computeWordScore({ title, relPath }, queryText);
			if (wordScore <= 0) continue;
			if (card) {
				wire.push({
					id: card.id,
					uri: card.uri,
					line: card.line,
					title: card.title,
					breadcrumbs: [],
					metadataKv: card.metadataKv && typeof card.metadataKv === 'object' ? card.metadataKv : {},
					typeId: card.typeId,
					marker: card.typeId ? `.${card.typeId}` : '',
					tags: card.tags,
					relations: card.relations && typeof card.relations === 'object' ? card.relations : {},
					validHeading: true,
					relPath: card.relPath,
					mtime: Number(card.mtime) || 0,
					fileId: card.fileId,
					headingId: Number(card.heading_id) || hid,
					_embeddingScore: 0,
					_embeddingDistance: undefined,
					_wordScore: wordScore,
					_semanticScore: 0,
					_relevanceScore: wordScore
				});
			} else {
				const fileIdStr = String(row.file_id || '');
				const uri = vscode.Uri.joinPath(kbRootUri, ...relPath.split('/').filter(Boolean)).toString();
				wire.push({
					id: `${fileIdStr}:h${hid}`,
					uri,
					line: 1,
					title,
					breadcrumbs: [],
					metadataKv: {},
					typeId: String(row.type_name || '')
						.trim()
						.toLowerCase(),
					marker: row.type_name ? `.${String(row.type_name).trim().toLowerCase()}` : '',
					tags: [],
					relations: {},
					validHeading: true,
					relPath,
					mtime: Number(row.updated_at) || 0,
					fileId: fileIdStr,
					headingId: hid,
					_embeddingScore: 0,
					_wordScore: wordScore,
					_semanticScore: 0,
					_relevanceScore: wordScore
				});
			}
			if (wire.length >= limit) break;
		}
		wire.sort((a, b) => (Number(b._wordScore) || 0) - (Number(a._wordScore) || 0));
		return wire;
	} finally {
		handle.close();
	}
}

/**
 * Merge semantic + word candidate sets and assign relevance per searchEngine.
 * @param {ReturnType<typeof embeddingHitsToRetrieverWireRows>} semanticWire
 * @param {ReturnType<typeof embeddingHitsToRetrieverWireRows>} wordWire
 * @param {'recommended'|'semantic'|'word'} searchEngine
 */
function mergeSearchEngineResults(semanticWire, wordWire, searchEngine) {
	/** @param {any} r */
	const rowKey = r =>
		`${String((r && r.fileId) || '')}:${Number((r && r.headingId) || 0)}:${String((r && r.relPath) || '')}`;

	if (searchEngine === 'semantic') {
		return (Array.isArray(semanticWire) ? semanticWire : []).map(r => {
			const sem = Number(r && r._embeddingScore) || 0;
			return {
				...r,
				_semanticScore: sem,
				_wordScore: 0,
				_relevanceScore: sem,
				_embeddingScore: sem
			};
		});
	}
	if (searchEngine === 'word') {
		return (Array.isArray(wordWire) ? wordWire : []).map(r => {
			const w = Number(r && r._wordScore) || 0;
			return {
				...r,
				_semanticScore: 0,
				_wordScore: w,
				_relevanceScore: w,
				_embeddingScore: w
			};
		});
	}

	/** @type {Map<string, any>} */
	const byKey = new Map();
	for (const r of Array.isArray(semanticWire) ? semanticWire : []) {
		const sem = Number(r && r._embeddingScore) || 0;
		byKey.set(rowKey(r), {
			...r,
			_semanticScore: sem,
			_wordScore: 0
		});
	}
	for (const r of Array.isArray(wordWire) ? wordWire : []) {
		const k = rowKey(r);
		const w = Number(r && r._wordScore) || 0;
		if (byKey.has(k)) {
			const cur = byKey.get(k);
			cur._wordScore = Math.max(Number(cur._wordScore) || 0, w);
		} else {
			byKey.set(k, {
				...r,
				_semanticScore: 0,
				_wordScore: w,
				_embeddingScore: 0
			});
		}
	}

	const out = [...byKey.values()].map(r => {
		const sem = Number(r._semanticScore) || 0;
		const w = Number(r._wordScore) || 0;
		const relevance = RECOMMENDED_SEMANTIC_WEIGHT * sem + RECOMMENDED_WORD_WEIGHT * w;
		return {
			...r,
			_relevanceScore: relevance,
			_embeddingScore: relevance
		};
	});
	out.sort((a, b) => (Number(b._relevanceScore) || 0) - (Number(a._relevanceScore) || 0));
	return out;
}

/**
 * @param {number} distance L2 distance from sqlite-vec (lower = closer)
 * @returns {number} higher = better for UI ranking
 */
function distanceToScore(distance) {
	const d = Number(distance);
	if (!Number.isFinite(d) || d < 0) {
		return 0;
	}
	return 1 / (1 + d);
}

/**
 * Load card fields for embedding_ids from index only (no file I/O).
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number[]} embeddingIds
 * @param {import('vscode').Uri} kbRootUri
 * @param {{ includeRelations?: boolean }} [opts]
 * @returns {Map<number, Omit<HeadingEmbeddingSearchHit, 'distance' | 'score'>>}
 */
function loadCardsForEmbeddingIds(db, embeddingIds, kbRootUri, opts) {
	/** @type {Map<number, Omit<HeadingEmbeddingSearchHit, 'distance' | 'score'>>} */
	const map = new Map();
	if (!embeddingIds.length || !db.native) {
		return map;
	}
	const includeRelations = Boolean(opts && opts.includeRelations);

	const placeholders = embeddingIds.map(() => '?').join(',');
	const rows = db.native
		.prepare(
			`
			SELECT
				r.embedding_id AS embedding_id,
				r.file_id AS file_id,
				r.heading_id AS heading_id,
				h.title AS title,
				f.path AS path,
				f.name AS file_name,
				COALESCE(f.updated_at, 0) AS updated_at,
				COALESCE(mt.metadata_type_name, '') AS type_name
			FROM ${RECORDS_TABLE} r
			JOIN headings h ON h.file_id = r.file_id AND h.heading_id = r.heading_id
			JOIN files f ON f.id = r.file_id
			LEFT JOIN metadata_types mt ON mt.metadata_type_id = h.metadata_type_id
			WHERE r.embedding_id IN (${placeholders})
			`
		)
		.all(...embeddingIds.map(id => Number(id)));

	const tagStmt = db.native.prepare(
		`
		SELECT t.tag_name AS tag_name
		FROM searchtags s
		JOIN tags t ON t.tag_id = s.tag_id
		WHERE s.file_id = ? AND s.heading_id = ?
		ORDER BY LOWER(t.tag_name), t.tag_name
		`
	);
	let relStmt = null;
	if (includeRelations) {
		try {
			relStmt = db.native.prepare(
				`
				SELECT LOWER(rt.relation_type_name) AS relation_type, LOWER(t.tag_name) AS tag_name
				FROM relations r
				JOIN relation_types rt ON rt.relation_type_id = r.relation_type_id
				JOIN tags t ON t.tag_id = r.tag_id
				WHERE r.from_file_id = ? AND r.from_heading_id = ?
					AND LOWER(rt.relation_type_name) != 'tags'
				ORDER BY LOWER(rt.relation_type_name), LOWER(t.tag_name)
				`
			);
		} catch {
			relStmt = null;
		}
	}
	let kvStmt = null;
	try {
		kvStmt = db.native.prepare(
			`
			SELECT key AS k, value AS v
			FROM metadata_remaining_keys
			WHERE file_id = ? AND heading_id = ?
			ORDER BY key
			LIMIT 12
			`
		);
	} catch {
		kvStmt = null;
	}

	for (const row of rows) {
		const embeddingId = Number(row.embedding_id);
		const fileId = Number(row.file_id);
		const headingId = Number(row.heading_id);
		const relPath = String(row.path || '').replace(/\\/g, '/');
		const title = String(row.title || '');
		const typeId = String(row.type_name || '')
			.trim()
			.toLowerCase();
		const tagRows = tagStmt.all(fileId, headingId);
		const tags = tagRows.map(t => String(t.tag_name || '').toLowerCase()).filter(Boolean);
		/** @type {Record<string, string[]>} */
		const relations = {};
		if (relStmt) {
			try {
				for (const rr of relStmt.all(fileId, headingId)) {
					const rt = String(rr.relation_type || '')
						.trim()
						.toLowerCase();
					const tn = String(rr.tag_name || '')
						.trim()
						.toLowerCase();
					if (!rt || !tn) continue;
					if (!relations[rt]) relations[rt] = [];
					if (!relations[rt].includes(tn)) relations[rt].push(tn);
				}
			} catch {
				// older indexes
			}
		}
		/** @type {Record<string, string>} */
		const metadataKv = {};
		if (kvStmt) {
			try {
				for (const kv of kvStmt.all(fileId, headingId)) {
					const k = String(kv.k || '').trim();
					const v = String(kv.v || '').trim();
					if (k && v) metadataKv[k] = v;
				}
			} catch {
				// older indexes may lack the table
			}
		}
		const fileUri = vscode.Uri.joinPath(kbRootUri, ...relPath.split('/').filter(Boolean));
		map.set(embeddingId, {
			embedding_id: embeddingId,
			file_id: fileId,
			heading_id: headingId,
			title,
			relPath,
			fileName: String(row.file_name || path.basename(relPath)),
			typeId,
			tags,
			relations,
			metadataKv,
			uri: fileUri.toString(),
			id: `f${fileId}:h${headingId}`,
			// Line unknown without opening the note; open at top of file for now.
			line: 1,
			fileId: fileId >= 0 ? String(fileId) : '',
			mtime: Number(row.updated_at) || 0
		});
	}
	return map;
}

/**
 * Exact sqlite-vec search + DB card join.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} queryText
 * @param {{ limit?: number, modelId?: string, includeRelations?: boolean }} [opts]
 * @returns {Promise<HeadingEmbeddingSearchHit[]>}
 */
async function searchHeadingsExact(kbRootUri, queryText, opts) {
	const limit = Math.max(1, Math.min(Number(opts?.limit) || 20, 200));
	const q = String(queryText || '').trim();
	if (!q) {
		return [];
	}

	let modelId = opts?.modelId;
	let vector;
	{
		const handle = await openDripIndexDb(kbRootUri);
		try {
			if (!modelId) {
				modelId = getEmbeddingMeta(handle.db).model;
			}
		} finally {
			handle.close();
		}
	}

	vector = await encodeHeadingEmbeddingText(q, { modelId });

	const handle = await openDripIndexDb(kbRootUri);
	try {
		const knn = searchHeadingEmbeddingsExact(handle.db, vector, limit);
		const cards = loadCardsForEmbeddingIds(
			handle.db,
			knn.map(h => h.embedding_id),
			kbRootUri,
			{ includeRelations: Boolean(opts && opts.includeRelations) }
		);
		/** @type {HeadingEmbeddingSearchHit[]} */
		const hits = [];
		for (const row of knn) {
			const card = cards.get(Number(row.embedding_id));
			if (!card) {
				continue;
			}
			hits.push({
				...card,
				distance: Number(row.distance),
				score: distanceToScore(row.distance)
			});
		}
		return hits;
	} finally {
		handle.close();
	}
}

/**
 * FAISS ANN search (locked when vectorCount > 1000).
 * Falls back to exact sqlite-vec if FAISS is missing/corrupt while a rebuild is kicked.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} queryText
 * @param {{ limit?: number, modelId?: string }} [opts]
 * @returns {Promise<HeadingEmbeddingSearchHit[]>}
 */
async function searchHeadingsFaiss(kbRootUri, queryText, opts) {
	const limit = Math.max(1, Math.min(Number(opts?.limit) || 20, 200));
	const q = String(queryText || '').trim();
	if (!q) {
		return [];
	}

	let modelId = opts?.modelId;
	{
		const handle = await openDripIndexDb(kbRootUri);
		try {
			if (!modelId) {
				modelId = getEmbeddingMeta(handle.db).model;
			}
		} finally {
			handle.close();
		}
	}

	const vector = await encodeHeadingEmbeddingText(q, { modelId });

	const { searchFaiss, loadFaissModule, scheduleDebouncedRebuild } = require('./headingEmbeddingFaiss');
	if (!loadFaissModule()) {
		console.warn('[DRIP] FAISS unavailable; falling back to exact sqlite-vec for this query');
		return searchHeadingsExact(kbRootUri, queryText, { ...opts, modelId });
	}

	const handle = await openDripIndexDb(kbRootUri);
	try {
		let knn = [];
		let usedFaiss = false;
		try {
			knn = searchFaiss(kbRootUri, handle.db, vector, limit);
			usedFaiss = true;
		} catch (err) {
			console.warn('[DRIP] FAISS search failed; exact fallback + rebuild', err && err.message);
			scheduleDebouncedRebuild(kbRootUri);
		}

		if (!usedFaiss || !knn.length) {
			if (usedFaiss && !knn.length) {
				scheduleDebouncedRebuild(kbRootUri);
			}
			knn = searchHeadingEmbeddingsExact(handle.db, vector, limit);
		}

		const cards = loadCardsForEmbeddingIds(
			handle.db,
			knn.map(h => h.embedding_id),
			kbRootUri,
			{ includeRelations: Boolean(opts && opts.includeRelations) }
		);
		/** @type {HeadingEmbeddingSearchHit[]} */
		const hits = [];
		for (const row of knn) {
			const card = cards.get(Number(row.embedding_id));
			if (!card) {
				continue;
			}
			hits.push({
				...card,
				distance: Number(row.distance),
				score: distanceToScore(row.distance)
			});
		}
		return hits;
	} finally {
		handle.close();
	}
}

/**
 * Search using the **locked** method for this KB (locks on first call if needed).
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} queryText
 * @param {{ limit?: number, modelId?: string, includeRelations?: boolean }} [opts]
 * @returns {Promise<{ method: string, hits: HeadingEmbeddingSearchHit[] }>}
 */
async function searchHeadingsByEmbedding(kbRootUri, queryText, opts) {
	let lock = getLockedHeadingEmbeddingSearchMethod(kbRootUri);
	if (!lock) {
		lock = await lockHeadingEmbeddingSearchMethod(kbRootUri);
	}

	if (lock.method === 'none') {
		return { method: 'none', hits: [] };
	}
	if (lock.method === 'faiss') {
		const hits = await searchHeadingsFaiss(kbRootUri, queryText, opts);
		return { method: 'faiss', hits };
	}

	const hits = await searchHeadingsExact(kbRootUri, queryText, opts);
	return { method: 'exact', hits };
}

/**
 * Map embedding hits → Retriever wire rows (no file open).
 * @param {HeadingEmbeddingSearchHit[]} hits
 */
function embeddingHitsToRetrieverWireRows(hits) {
	return (hits || []).map(h => ({
		id: h.id,
		uri: h.uri,
		line: h.line,
		title: h.title,
		breadcrumbs: [],
		metadataKv: h.metadataKv && typeof h.metadataKv === 'object' ? h.metadataKv : {},
		typeId: h.typeId,
		marker: h.typeId ? `.${h.typeId}` : '',
		tags: h.tags,
		relations: h.relations && typeof h.relations === 'object' ? h.relations : {},
		validHeading: true,
		relPath: h.relPath,
		mtime: Number(h.mtime) || 0,
		fileId: h.fileId,
		headingId: Number(h.heading_id) || 0,
		_embeddingScore: h.score,
		_embeddingDistance: h.distance
	}));
}

/**
 * List heading cards from `index.drip` only (no `.d.txt` reads). Used for empty-query browse.
 * Honors type (OR), tags (AND), sort, scope, and pagination.
 * @param {import('vscode').Uri} kbRootUri
 * @param {{
 *   limit?: number,
 *   offset?: number,
 *   typeIds?: string[],
 *   tags?: string[],
 *   selectedTypeIds?: string[],
 *   selectedTags?: string[],
 *   sortBy?: string,
 *   scopeFiles?: boolean,
 *   scopeHeadings?: boolean,
 *   corpus?: 'working'|'entire',
 *   respectDripignore?: boolean
 * }} [opts]
 * @returns {Promise<{ rows: ReturnType<typeof embeddingHitsToRetrieverWireRows>, total: number }>}
 */
async function listHeadingsFromIndex(kbRootUri, opts) {
	const rawOpts = opts && typeof opts === 'object' ? opts : {};
	const q = normalizeRetrieverIndexQuery(rawOpts);
	q.preferFileOrder = Boolean(rawOpts.preferFileOrder);
	if (!q.scopeFiles && !q.scopeHeadings) {
		return { rows: [], total: 0 };
	}

	const handle = await openDripIndexDb(kbRootUri);
	try {
		if (!handle.db.native) {
			return { rows: [], total: 0 };
		}

		// When honoring .dripignore, SQL OFFSET/COUNT cannot see ignore rules — scan a window then filter.
		const sqlOffset = q.respectDripignore ? 0 : q.offset;
		const sqlLimit = q.respectDripignore
			? Math.min(5000, Math.max(500, (q.offset + q.limit) * 12))
			: q.limit;

		/** @type {string[]} */
		const whereParts = [];
		/** @type {unknown[]} */
		const filterParams = [];
		if (q.typeIds.length) {
			const wantsNone = q.typeIds.includes('__none__');
			const typed = q.typeIds.filter(id => id !== '__none__');
			/** @type {string[]} */
			const typeOr = [];
			if (wantsNone) typeOr.push('(h.metadata_type_id IS NULL)');
			if (typed.length) {
				typeOr.push(
					`LOWER(COALESCE(mt.metadata_type_name, '')) IN (${typed.map(() => '?').join(',')})`
				);
				filterParams.push(...typed);
			}
			if (typeOr.length) whereParts.push(`(${typeOr.join(' OR ')})`);
		}
		if (q.tags.length && q.tagMode !== 'relevant') {
			// Exact: every selected tag must be present (AND).
			for (const tag of q.tags) {
				whereParts.push(`EXISTS (
				SELECT 1 FROM searchtags s
				JOIN tags t ON t.tag_id = s.tag_id
				WHERE s.file_id = h.file_id AND s.heading_id = h.heading_id
					AND LOWER(t.tag_name) = ?
			)`);
				filterParams.push(tag);
			}
		} else if (q.tags.length && q.tagMode === 'relevant') {
			// Relevant: no hard filter — overlap ranking still applies in ORDER BY.
		}
		if (q.relationFilters.length && q.relationMode !== 'relevant') {
			for (const f of q.relationFilters) {
				for (const tag of f.tags) {
					whereParts.push(`EXISTS (
				SELECT 1 FROM relations rr
				JOIN relation_types rrt ON rrt.relation_type_id = rr.relation_type_id
				JOIN tags rtt ON rtt.tag_id = rr.tag_id
				WHERE rr.from_file_id = h.file_id AND rr.from_heading_id = h.heading_id
					AND LOWER(rrt.relation_type_name) = ?
					AND LOWER(rtt.tag_name) = ?
			)`);
					filterParams.push(f.type, tag);
				}
			}
		}

		const filesOnly = q.scopeFiles && !q.scopeHeadings;
		const headingsOnly = q.scopeHeadings && !q.scopeFiles;
		if (headingsOnly) {
			whereParts.push('h.heading_id > 0');
		}
		if (filesOnly) {
			// One row per note: prefer file-level heading_id 0, else earliest heading.
			whereParts.push(`h.heading_id = (
				SELECT COALESCE(
					(SELECT hz.heading_id FROM headings hz WHERE hz.file_id = h.file_id AND hz.heading_id = 0 LIMIT 1),
					MIN(hpick.heading_id)
				)
				FROM headings hpick
				WHERE hpick.file_id = h.file_id
			)`);
		}

		const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

		/** @type {unknown[]} */
		const orderParams = [];
		let orderSql = 'ORDER BY LOWER(h.title), f.path, h.heading_id';
		if (q.preferFileOrder) {
			orderSql = 'ORDER BY f.path, h.heading_id';
		}
		const orderBits = [];
		if (q.relationFilters.length) {
			/** @type {string[]} */
			const relExprs = [];
			for (const f of q.relationFilters) {
				relExprs.push(`(
				SELECT COUNT(*) FROM relations ro
				JOIN relation_types rot ON rot.relation_type_id = ro.relation_type_id
				JOIN tags rotags ON rotags.tag_id = ro.tag_id
				WHERE ro.from_file_id = h.file_id AND ro.from_heading_id = h.heading_id
					AND LOWER(rot.relation_type_name) = ?
					AND LOWER(rotags.tag_name) IN (${f.tags.map(() => '?').join(',')})
			)`);
				orderParams.push(f.type, ...f.tags);
			}
			orderBits.push(`(${relExprs.join(' + ')}) DESC`);
		}
		if (q.tags.length) {
			const overlapExpr = `(
				SELECT COUNT(*) FROM searchtags so
				JOIN tags tovl ON tovl.tag_id = so.tag_id
				WHERE so.file_id = h.file_id AND so.heading_id = h.heading_id
					AND LOWER(tovl.tag_name) IN (${q.tags.map(() => '?').join(',')})
			)`;
			orderBits.push(`${overlapExpr} DESC`);
			orderParams.push(...q.tags);
		}
		if (orderBits.length) {
			if (q.sortBy === 'title') {
				orderSql = `ORDER BY ${orderBits.join(', ')}, LOWER(h.title), f.path, h.heading_id`;
			} else {
				orderSql = `ORDER BY ${orderBits.join(', ')}, COALESCE(f.updated_at, 0) DESC, LOWER(h.title)`;
			}
		} else if (q.sortBy === 'title') {
			orderSql = 'ORDER BY LOWER(h.title), f.path, h.heading_id';
		} else {
			// Relevance with no query + no tags: recent-ish then title
			orderSql = 'ORDER BY COALESCE(f.updated_at, 0) DESC, LOWER(h.title), f.path';
		}

		const fromSql = `
			FROM headings h
			JOIN files f ON f.id = h.file_id
			LEFT JOIN metadata_types mt ON mt.metadata_type_id = h.metadata_type_id
			${whereSql}
		`;

		const countRow = handle.db.native
			.prepare(`SELECT COUNT(*) AS n ${fromSql}`)
			.get(...filterParams);
		const sqlTotal = Number(countRow && countRow.n) || 0;

		const rows = handle.db.native
			.prepare(
				`
				SELECT
					h.file_id AS file_id,
					h.heading_id AS heading_id,
					h.title AS title,
					f.path AS path,
					f.name AS file_name,
					COALESCE(f.updated_at, 0) AS updated_at,
					COALESCE(mt.metadata_type_name, '') AS type_name
				${fromSql}
				${orderSql}
				LIMIT ? OFFSET ?
				`
			)
			.all(...filterParams, ...orderParams, sqlLimit, sqlOffset);

		const tagStmt = handle.db.native.prepare(
			`
			SELECT t.tag_name AS tag_name
			FROM searchtags s
			JOIN tags t ON t.tag_id = s.tag_id
			WHERE s.file_id = ? AND s.heading_id = ?
			ORDER BY LOWER(t.tag_name), t.tag_name
			`
		);
		let relStmt = null;
		if (q.relationFilters.length) {
			try {
				relStmt = handle.db.native.prepare(
					`
					SELECT LOWER(rt.relation_type_name) AS relation_type, LOWER(t.tag_name) AS tag_name
					FROM relations r
					JOIN relation_types rt ON rt.relation_type_id = r.relation_type_id
					JOIN tags t ON t.tag_id = r.tag_id
					WHERE r.from_file_id = ? AND r.from_heading_id = ?
						AND LOWER(rt.relation_type_name) != 'tags'
					ORDER BY LOWER(rt.relation_type_name), LOWER(t.tag_name)
					`
				);
			} catch {
				relStmt = null;
			}
		}
		let kvStmt = null;
		try {
			kvStmt = handle.db.native.prepare(
				`
				SELECT key AS k, value AS v
				FROM metadata_remaining_keys
				WHERE file_id = ? AND heading_id = ?
				ORDER BY key
				LIMIT 12
				`
			);
		} catch {
			kvStmt = null;
		}

		/** @type {HeadingEmbeddingSearchHit[]} */
		const hits = [];
		for (const row of rows) {
			const fileId = Number(row.file_id);
			const headingId = Number(row.heading_id);
			const relPath = String(row.path || '').replace(/\\/g, '/');
			const typeId = String(row.type_name || '')
				.trim()
				.toLowerCase();
			const tags = tagStmt
				.all(fileId, headingId)
				.map(t => String(t.tag_name || '').toLowerCase())
				.filter(Boolean);
			/** @type {Record<string, string[]>} */
			const relations = {};
			if (relStmt) {
				try {
					for (const rr of relStmt.all(fileId, headingId)) {
						const rt = String(rr.relation_type || '')
							.trim()
							.toLowerCase();
						const tn = String(rr.tag_name || '')
							.trim()
							.toLowerCase();
						if (!rt || !tn) continue;
						if (!relations[rt]) relations[rt] = [];
						if (!relations[rt].includes(tn)) relations[rt].push(tn);
					}
				} catch {
					// ignore
				}
			}
			/** @type {Record<string, string>} */
			const metadataKv = {};
			if (kvStmt) {
				try {
					for (const kv of kvStmt.all(fileId, headingId)) {
						const k = String(kv.k || '').trim();
						const v = String(kv.v || '').trim();
						if (k && v) metadataKv[k] = v;
					}
				} catch {
					// ignore
				}
			}
			const fileUri = vscode.Uri.joinPath(kbRootUri, ...relPath.split('/').filter(Boolean));
			hits.push({
				embedding_id: 0,
				distance: 0,
				score: 0,
				file_id: fileId,
				heading_id: headingId,
				title: String(row.title || ''),
				relPath,
				fileName: String(row.file_name || path.basename(relPath)),
				typeId,
				tags,
				relations,
				metadataKv,
				uri: fileUri.toString(),
				id: `f${fileId}:h${headingId}`,
				line: 1,
				fileId: fileId >= 0 ? String(fileId) : '',
				mtime: Number(row.updated_at) || 0
			});
		}
		let wire = embeddingHitsToRetrieverWireRows(hits);
		if (q.respectDripignore) {
			wire = await filterWireRowsByDripignore(kbRootUri, wire, true);
			const page = wire.slice(q.offset, q.offset + q.limit);
			const hitCap = hits.length >= sqlLimit;
			const total = hitCap
				? Math.max(wire.length, q.offset + page.length + (page.length >= q.limit ? 1 : 0))
				: wire.length;
			return { rows: page, total };
		}
		return { rows: wire, total: sqlTotal };
	} finally {
		handle.close();
	}
}

/**
 * Files scope: rank notes by file-level (h0) relevance score, then nest headings
 * sorted by heading relevance. Pagination counts headings (not files).
 * @param {ReturnType<typeof embeddingHitsToRetrieverWireRows>} wire
 * @param {{
 *   tags: string[],
 *   sortBy?: 'relevance'|'title',
 *   relationType?: string,
 *   relationTags?: string[]
 * }} rankOpts
 */
function assembleFilesScopeHeadingRows(wire, rankOpts) {
	/** @type {Map<string, {
	 *   fileScore: number,
	 *   hasFileEmbedding: boolean,
	 *   headings: ReturnType<typeof embeddingHitsToRetrieverWireRows>
	 * }>} */
	const byRel = new Map();
	for (const row of wire || []) {
		const rel = String((row && row.relPath) || '');
		if (!rel) continue;
		if (!byRel.has(rel)) {
			byRel.set(rel, { fileScore: 0, hasFileEmbedding: false, headings: [] });
		}
		const bucket = byRel.get(rel);
		const hid = Number(row && row.headingId) || 0;
		const score =
			Number(row && row._relevanceScore) ||
			Number(row && row._embeddingScore) ||
			0;
		if (hid === 0) {
			bucket.hasFileEmbedding = true;
			bucket.fileScore = score;
		} else {
			bucket.headings.push(row);
		}
	}

	for (const bucket of byRel.values()) {
		bucket.headings = rankWireRows(bucket.headings, rankOpts);
	}

	const filesOrdered = [...byRel.entries()].sort((a, b) => {
		const ba = a[1];
		const bb = b[1];
		if (ba.hasFileEmbedding !== bb.hasFileEmbedding) {
			return ba.hasFileEmbedding ? -1 : 1;
		}
		if (rankOpts.sortBy === 'title') {
			return a[0].localeCompare(b[0], undefined, { sensitivity: 'base' });
		}
		if (ba.fileScore !== bb.fileScore) return bb.fileScore - ba.fileScore;
		return a[0].localeCompare(b[0], undefined, { sensitivity: 'base' });
	});

	/** @type {ReturnType<typeof embeddingHitsToRetrieverWireRows>} */
	const flat = [];
	for (const [rel, bucket] of filesOrdered) {
		if (!bucket.headings.length) continue;
		for (const h of bucket.headings) {
			flat.push({
				...h,
				_fileEmbeddingScore: bucket.hasFileEmbedding ? bucket.fileScore : undefined,
				_scopeMode: 'files',
				_fileGroupKey: rel
			});
		}
	}
	return flat;
}

/**
 * Full Retriever query against `index.drip` only: embedding search (when `q` set) or browse,
 * then type/tag/scope filters and sort. Never opens `.d.txt` files.
 * @param {import('vscode').Uri} kbRootUri
 * @param {unknown} payload webview `retrieverQuery` / suggest payload
 * @returns {Promise<{
 *   rows: ReturnType<typeof embeddingHitsToRetrieverWireRows>,
 *   totalMatched: number,
 *   truncated: boolean,
 *   offset: number,
 *   loadedThrough: number,
 *   pageSize: number,
 *   searchMethod: string
 * }>}
 */
async function queryRetrieverFromIndex(kbRootUri, payload) {
	const q = normalizeRetrieverIndexQuery(payload);
	if (!q.scopeFiles && !q.scopeHeadings) {
		return {
			rows: [],
			totalMatched: 0,
			truncated: false,
			offset: q.offset,
			loadedThrough: q.offset,
			pageSize: 0,
			searchMethod: 'none'
		};
	}

	const filesScope = q.scopeFiles && !q.scopeHeadings;
	const qTrim = String(q.q || '').trim();
	const customPaths = Array.isArray(q.customCorpusPaths) ? q.customCorpusPaths : [];
	const useCustomCorpus = q.corpus === 'custom' && customPaths.length > 0;

	// Selected custom corpus with no paths yet — never fall back to full KB.
	if (q.corpus === 'custom' && !customPaths.length) {
		return {
			rows: [],
			totalMatched: 0,
			truncated: false,
			offset: q.offset,
			loadedThrough: q.offset,
			pageSize: 0,
			searchMethod: 'custom-corpus-empty'
		};
	}

	if (!qTrim) {
		const listed = await listHeadingsFromIndex(kbRootUri, {
			limit: useCustomCorpus
				? Math.min(5000, Math.max(500, (q.offset + q.limit) * 15))
				: q.limit,
			offset: useCustomCorpus ? 0 : q.offset,
			typeIds: q.typeIds,
			tags: q.tags,
			tagMode: q.tagMode,
			relationType: q.relationType,
			relationTags: q.relationTags,
			relationFilters: q.relationFilters,
			relationMode: q.relationMode,
			sortBy: q.sortBy,
			// Empty Files scope: list section headings ordered by file path (UI file buckets).
			scopeFiles: false,
			scopeHeadings: true,
			preferFileOrder: filesScope || useCustomCorpus,
			respectDripignore: q.respectDripignore,
			corpus: q.corpus
		});
		let rows = listed.rows.map(r => ({
			...r,
			_tagOverlap: tagIntersectionCount(r, q.tags),
			_relationOverlap: relationFiltersOverlapCount(r, q.relationFilters),
			...(filesScope
				? {
						_scopeMode: 'files',
						_fileGroupKey: String(r.relPath || '')
					}
				: {})
		}));
		if (filesScope) {
			rows = rows.filter(r => Number(r.headingId) > 0);
		}
		if (useCustomCorpus) {
			rows = filterWireRowsByCustomCorpus(rows, customPaths);
			const totalMatched = rows.length;
			const page = rows.slice(q.offset, q.offset + q.limit);
			return {
				rows: page,
				totalMatched,
				truncated: q.offset + page.length < totalMatched,
				offset: q.offset,
				loadedThrough: q.offset + page.length,
				pageSize: page.length,
				searchMethod: 'index-browse'
			};
		}
		return {
			rows,
			totalMatched: listed.total,
			truncated: q.offset + listed.rows.length < listed.total,
			offset: q.offset,
			loadedThrough: q.offset + listed.rows.length,
			pageSize: listed.rows.length,
			searchMethod: 'index-browse'
		};
	}

	async function fetchSearchEngineWire(fetchN) {
		const includeRelations = q.relationFilters.length > 0;
		const engine = q.searchEngine || 'recommended';
		/** @type {ReturnType<typeof embeddingHitsToRetrieverWireRows>} */
		let semanticWire = [];
		/** @type {ReturnType<typeof embeddingHitsToRetrieverWireRows>} */
		let wordWire = [];
		/** @type {string} */
		let method = engine;

		if (engine === 'semantic' || engine === 'recommended') {
			const { hits, method: m } = await searchHeadingsByEmbedding(kbRootUri, qTrim, {
				limit: fetchN,
				includeRelations
			});
			method = engine === 'recommended' ? `recommended:${m}` : m;
			semanticWire = embeddingHitsToRetrieverWireRows(hits);
		}
		if (engine === 'word' || engine === 'recommended') {
			wordWire = await searchHeadingsByWord(kbRootUri, qTrim, {
				limit: fetchN,
				includeRelations
			});
			if (engine === 'word') method = 'word';
		}

		let wire = mergeSearchEngineResults(semanticWire, wordWire, engine);
		wire = await filterWireRowsByDripignore(kbRootUri, wire, q.respectDripignore);
		if (useCustomCorpus) wire = filterWireRowsByCustomCorpus(wire, customPaths);
		return { wire, method, candidateCount: Math.max(semanticWire.length, wordWire.length) };
	}

	if (filesScope) {
		const need = q.offset + q.limit;
		const fetchN = Math.min(500, Math.max(need * 10, 250));
		const { wire, method, candidateCount } = await fetchSearchEngineWire(fetchN);
		// Keep h0 for file ranking; filter types/tags only on heading rows after assemble.
		const assembled = assembleFilesScopeHeadingRows(wire, {
			tags: q.tags,
			sortBy: 'relevance',
			relationFilters: q.relationFilters,
			relationType: q.relationType,
			relationTags: q.relationTags
		}).filter(row => rowMatchesTypeTagFilters(row, q));

		const maybeMoreInIndex = candidateCount >= fetchN;
		const totalMatched = maybeMoreInIndex
			? Math.max(assembled.length, q.offset + Math.min(q.limit, assembled.length - q.offset) + 1)
			: assembled.length;
		const page = assembled.slice(q.offset, q.offset + q.limit);
		const truncated = q.offset + page.length < assembled.length || maybeMoreInIndex;

		return {
			rows: page,
			totalMatched,
			truncated,
			offset: q.offset,
			loadedThrough: q.offset + page.length,
			pageSize: page.length,
			searchMethod: method
		};
	}

	const need = q.offset + q.limit;
	const hasFilters =
		q.typeIds.length > 0 ||
		q.tags.length > 0 ||
		q.relationFilters.length > 0 ||
		useCustomCorpus ||
		q.respectDripignore;
	const fetchN = Math.min(200, Math.max(need, hasFilters ? need * 5 : need));
	const { wire: rawWire, method, candidateCount } = await fetchSearchEngineWire(fetchN);
	let wire = rawWire.filter(row => rowMatchesTypeTagFilters(row, q));
	if (q.scopeHeadings && !q.scopeFiles) {
		wire = wire.filter(r => Number(r.headingId) > 0);
	}
	wire = rankWireRows(wire, {
		tags: q.tags,
		sortBy: 'relevance',
		relationFilters: q.relationFilters,
		relationType: q.relationType,
		relationTags: q.relationTags
	});

	const maybeMoreInIndex = candidateCount >= fetchN;
	const totalMatched = maybeMoreInIndex
		? Math.max(wire.length, q.offset + Math.min(q.limit, wire.length - q.offset) + 1)
		: wire.length;
	const page = wire.slice(q.offset, q.offset + q.limit);
	const truncated = q.offset + page.length < wire.length || maybeMoreInIndex;

	return {
		rows: page,
		totalMatched,
		truncated,
		offset: q.offset,
		loadedThrough: q.offset + page.length,
		pageSize: page.length,
		searchMethod: method
	};
}

/**
 * Tag labels stored in `index.drip` (for Retriever chips — no file walk).
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<{ allTags: string[], tagCounts: { tag: string, count: number }[] }>}
 */
async function listTagsFromIndex(kbRootUri) {
	const handle = await openDripIndexDb(kbRootUri);
	try {
		if (!handle.db.native) {
			return { allTags: [], tagCounts: [] };
		}
		const rows = handle.db.native
			.prepare(
				`
				SELECT t.tag_name AS tag_name, COUNT(s.tag_id) AS c
				FROM tags t
				LEFT JOIN searchtags s ON s.tag_id = t.tag_id
				GROUP BY t.tag_id
				ORDER BY c DESC, LOWER(t.tag_name), t.tag_name
				`
			)
			.all();
		const tagCounts = rows.map(r => ({
			tag: String(r.tag_name || '')
				.trim()
				.toLowerCase(),
			count: Number(r.c) || 0
		}));
		return {
			allTags: tagCounts.map(t => t.tag).filter(Boolean),
			tagCounts
		};
	} finally {
		handle.close();
	}
}

/**
 * Relation type names in `index.drip` (excludes searchable `tags`), merged with Settings allowed keys.
 * No usage counts — one heading with three `pre-req` tags must not inflate the dropdown.
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<{ id: string, label: string }[]>}
 */
async function listRelationTypesFromIndex(kbRootUri) {
	/** @type {Map<string, { id: string, label: string }>} */
	const byId = new Map();
	try {
		const { getMetadataSettings } = require('../../document/model/dripnoteMetadataTemplates');
		const settings = getMetadataSettings();
		for (const name of settings.allowedRelations || []) {
			const id = String(name || '')
				.trim()
				.toLowerCase();
			if (!id || id === 'tags') continue;
			byId.set(id, { id, label: id });
		}
	} catch {
		// ignore
	}
	const handle = await openDripIndexDb(kbRootUri);
	try {
		if (!handle.db.native) {
			return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
		}
		let rows = [];
		try {
			rows = handle.db.native
				.prepare(
					`
					SELECT LOWER(rt.relation_type_name) AS name
					FROM relation_types rt
					WHERE LOWER(rt.relation_type_name) != 'tags'
					ORDER BY name
					`
				)
				.all();
		} catch {
			rows = [];
		}
		for (const r of rows) {
			const id = String(r.name || '')
				.trim()
				.toLowerCase();
			if (!id) continue;
			if (!byId.has(id)) byId.set(id, { id, label: id });
		}
	} finally {
		handle.close();
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Metadata types that actually appear on headings in `index.drip` (no settings-only stubs).
 * Markers come from drip settings when available.
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<{ id: string, label: string, marker: string, count: number }[]>}
 */
async function listMetadataTypesFromIndex(kbRootUri) {
	const handle = await openDripIndexDb(kbRootUri);
	try {
		if (!handle.db.native) {
			return [];
		}
		const rows = handle.db.native
			.prepare(
				`
				SELECT
					LOWER(TRIM(mt.metadata_type_name)) AS type_name,
					COUNT(*) AS c
				FROM headings h
				JOIN metadata_types mt ON mt.metadata_type_id = h.metadata_type_id
				WHERE mt.metadata_type_name IS NOT NULL AND TRIM(mt.metadata_type_name) != ''
				GROUP BY LOWER(TRIM(mt.metadata_type_name))
				ORDER BY type_name
				`
			)
			.all();

		/** @type {Map<string, { label: string, marker: string }>} */
		let settingsById = new Map();
		try {
			const { getMetadataSettings } = require('../../document/model/dripnoteMetadataTemplates');
			const types = getMetadataSettings().types || [];
			settingsById = new Map(
				types.map(t => {
					const id = String(t.id || '')
						.trim()
						.toLowerCase();
					return [
						id,
						{
							label: String(t.label || t.id || id).trim() || id,
							marker: String(t.marker || '').trim() || (id ? `.${id}` : '')
						}
					];
				})
			);
		} catch {
			settingsById = new Map();
		}

		return rows
			.map(r => {
				const id = String(r.type_name || '')
					.trim()
					.toLowerCase();
				if (!id) return null;
				const fromSettings = settingsById.get(id);
				return {
					id,
					label: (fromSettings && fromSettings.label) || id,
					marker: (fromSettings && fromSettings.marker) || `.${id}`,
					count: Number(r.c) || 0
				};
			})
			.filter(Boolean);
	} finally {
		handle.close();
	}
}

module.exports = {
	distanceToScore,
	searchHeadingsExact,
	searchHeadingsFaiss,
	searchHeadingsByEmbedding,
	embeddingHitsToRetrieverWireRows,
	loadCardsForEmbeddingIds,
	listHeadingsFromIndex,
	listTagsFromIndex,
	listRelationTypesFromIndex,
	listMetadataTypesFromIndex,
	queryRetrieverFromIndex,
	normalizeRetrieverIndexQuery,
	filterWireRowsByDripignore,
	filterWireRowsByCustomCorpus,
	normalizeCustomCorpusEntries,
	normalizeSearchEngine,
	rowMatchesTypeTagFilters,
	tagIntersectionCount,
	relationIntersectionCount,
	relationFiltersOverlapCount,
	normalizeRelationFilters,
	rankWireRows,
	dedupeOnePerFile,
	sortWireRows,
	searchHeadingsByWord,
	computeWordScore,
	mergeSearchEngineResults,
	RECOMMENDED_SEMANTIC_WEIGHT,
	RECOMMENDED_WORD_WEIGHT
};
