'use strict';

/**
 * `search_tools` ranking: tool-card vectors from the **same embedding model DRIP uses**
 * (the open KB's `index_meta.embedding_model`, else the fixed default model).
 *
 * Vectors persist in `<globalStorage>/mcp/tool-embeddings.json` and are reused while the model id
 * is unchanged; only cards whose text changed are re-embedded. Queries use the same model.
 * Falls back to keyword ranking if the model cannot load.
 */

const fs = require('fs');
const path = require('path');
const { getEmbeddingPipeline, truncate, DEFAULT_MODEL_ID } = require('../../retrieval/embeddings');
const { listToolCards, cardSearchText, cardHash } = require('./toolCatalog');

const STORE_VERSION = 1;
const QUERY_CACHE_MAX = 64;
const SEMANTIC_WEIGHT = 0.7;

/** @type {string | null} */
let storeFile = null;
/** @type {{ modelId: string, vectors: Map<string, Float32Array> } | null} */
let loaded = null;
/** @type {Map<string, Promise<Map<string, Float32Array>>>} */
const building = new Map();
/** @type {Map<string, Float32Array>} */
const queryCache = new Map();

/**
 * @param {import('vscode').ExtensionContext} context
 */
function initToolEmbeddings(context) {
	storeFile = path.join(context.globalStorageUri.fsPath, 'mcp', 'tool-embeddings.json');
}

/**
 * @param {import('vscode').Uri | undefined} kbRoot
 * @returns {Promise<string>}
 */
async function resolveToolEmbeddingModelId(kbRoot) {
	if (kbRoot) {
		try {
			const { openDripIndexDb } = require('../../indexing/dripIndexDb');
			const { getEmbeddingMeta } = require('../../indexing/embeddings/headingEmbeddingStore');
			const handle = await openDripIndexDb(kbRoot);
			try {
				return getEmbeddingMeta(handle.db).model;
			} finally {
				handle.close();
			}
		} catch (err) {
			console.warn('[DRIP MCP] could not read KB embedding model; using default', err && err.message);
		}
	}
	return DEFAULT_MODEL_ID;
}

/**
 * @param {string} modelId
 * @param {string[]} texts
 * @returns {Promise<Float32Array[]>}
 */
async function encodeTexts(modelId, texts) {
	const pipe = await getEmbeddingPipeline(modelId);
	/** @type {Float32Array[]} */
	const out = [];
	for (let start = 0; start < texts.length; start += 12) {
		const slice = texts.slice(start, start + 12).map(t => truncate(t));
		const tensor = await pipe(slice, { pooling: 'mean', normalize: true });
		const dim = tensor.dims[tensor.dims.length - 1];
		const rows = tensor.dims.length === 1 ? 1 : tensor.dims[0];
		for (let i = 0; i < rows; i++) {
			out.push(Float32Array.from(tensor.data.subarray(i * dim, (i + 1) * dim)));
		}
	}
	return out;
}

/**
 * @returns {{ modelId: string, cards: Record<string, { hash: string, vector: number[] }> } | null}
 */
function readStore() {
	if (!storeFile) return null;
	try {
		const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
		if (raw && raw.version === STORE_VERSION && raw.cards && typeof raw.modelId === 'string') return raw;
	} catch {
		/* missing or corrupt → rebuild */
	}
	return null;
}

/**
 * @param {string} modelId
 * @param {Map<string, { hash: string, vector: Float32Array }>} entries
 */
function writeStore(modelId, entries) {
	if (!storeFile) return;
	/** @type {Record<string, { hash: string, vector: number[] }>} */
	const cards = {};
	for (const [name, e] of entries) {
		cards[name] = { hash: e.hash, vector: Array.from(e.vector, v => Math.round(v * 1e6) / 1e6) };
	}
	try {
		fs.mkdirSync(path.dirname(storeFile), { recursive: true });
		fs.writeFileSync(storeFile, JSON.stringify({ version: STORE_VERSION, modelId, cards }), 'utf8');
	} catch (err) {
		console.warn('[DRIP MCP] could not persist tool embeddings', err && err.message);
	}
}

/**
 * Card vectors for `modelId`: reuse persisted ones, embed only new/changed cards.
 * @param {string} modelId
 * @returns {Promise<Map<string, Float32Array>>}
 */
function ensureToolVectors(modelId) {
	if (loaded && loaded.modelId === modelId && loaded.vectors.size === listToolCards().length) {
		return Promise.resolve(loaded.vectors);
	}
	const pending = building.get(modelId);
	if (pending) return pending;
	const job = (async () => {
		const store = readStore();
		const persisted = store && store.modelId === modelId ? store.cards : {};
		/** @type {Map<string, { hash: string, vector: Float32Array }>} */
		const entries = new Map();
		/** @type {import('./toolCatalog').ToolCard[]} */
		const stale = [];
		for (const card of listToolCards()) {
			const hash = cardHash(card);
			const p = persisted[card.name];
			if (p && p.hash === hash && Array.isArray(p.vector) && p.vector.length) {
				entries.set(card.name, { hash, vector: Float32Array.from(p.vector) });
			} else {
				stale.push(card);
			}
		}
		if (stale.length) {
			const vecs = await encodeTexts(modelId, stale.map(cardSearchText));
			stale.forEach((card, i) => entries.set(card.name, { hash: cardHash(card), vector: vecs[i] }));
		}
		const removedCards = Object.keys(persisted).some(n => !entries.has(n));
		if (stale.length || removedCards || !store || store.modelId !== modelId) writeStore(modelId, entries);
		const vectors = new Map([...entries].map(([n, e]) => [n, e.vector]));
		loaded = { modelId, vectors };
		return vectors;
	})();
	building.set(modelId, job);
	job.finally(() => building.delete(modelId)).catch(() => {});
	return job;
}

/**
 * @param {string} modelId
 * @param {string} query
 */
async function encodeQuery(modelId, query) {
	const key = `${modelId}\n${query}`;
	const hit = queryCache.get(key);
	if (hit) return hit;
	const [vec] = await encodeTexts(modelId, [query]);
	queryCache.set(key, vec);
	if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
	return vec;
}

const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'it', 'my', 'me', 'i', 'with', 'into', 'from']);

/** @param {string} s */
function tokens(s) {
	return String(s || '')
		.toLowerCase()
		.split(/[^a-z0-9-]+/)
		.flatMap(t => [t, ...t.split('-')])
		.filter(t => t.length > 1 && !STOP.has(t));
}

/**
 * @param {string[]} q
 * @param {import('./toolCatalog').ToolCard} card
 */
function keywordScore(q, card) {
	if (!q.length) return 0;
	const bag = new Set(tokens(cardSearchText(card)));
	const nameBag = new Set(tokens(card.name.replace(/_/g, ' ')));
	let s = 0;
	for (const t of q) {
		if (nameBag.has(t)) s += 1.5;
		else if (bag.has(t)) s += 1;
		else if ([...bag].some(b => b.length > 3 && (b.startsWith(t) || t.startsWith(b)))) s += 0.5;
	}
	return Math.min(1, s / (q.length * 1.5));
}

/**
 * Cosine for L2-normalized vectors.
 * @param {Float32Array} x
 * @param {Float32Array} y
 */
function dot(x, y) {
	let s = 0;
	const n = Math.min(x.length, y.length);
	for (let i = 0; i < n; i++) s += x[i] * y[i];
	return s;
}

/**
 * @param {string} query
 * @param {{ category?: string, limit?: number, kbRoot?: import('vscode').Uri }} opts
 * @returns {Promise<{ ranking: string, modelId: string, results: { card: import('./toolCatalog').ToolCard, score: number }[] }>}
 */
async function searchToolCards(query, opts = {}) {
	const q = String(query || '').trim();
	const limit = Math.max(1, Math.min(Number(opts.limit) || 5, 20));
	let cards = listToolCards();
	if (opts.category) cards = cards.filter(c => c.category === opts.category);
	const modelId = await resolveToolEmbeddingModelId(opts.kbRoot);
	if (!q) {
		return { ranking: 'category', modelId, results: cards.slice(0, limit).map(card => ({ card, score: 1 })) };
	}

	const qTokens = tokens(q);
	/** @type {Map<string, number>} */
	const semantic = new Map();
	let ranking = 'keyword';
	try {
		const [vectors, qVec] = await Promise.all([ensureToolVectors(modelId), encodeQuery(modelId, q)]);
		for (const card of cards) {
			const v = vectors.get(card.name);
			if (v) semantic.set(card.name, dot(qVec, v));
		}
		ranking = 'semantic+keyword';
	} catch (err) {
		console.warn('[DRIP MCP] tool embeddings unavailable; keyword ranking only', err && err.message);
	}

	const results = cards
		.map(card => {
			const kw = keywordScore(qTokens, card);
			const sem = semantic.get(card.name);
			return { card, score: sem == null ? kw : SEMANTIC_WEIGHT * sem + (1 - SEMANTIC_WEIGHT) * kw };
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
	return { ranking, modelId, results };
}

/**
 * Pre-compute / load card vectors in the background (called when the server starts).
 * @param {import('vscode').Uri | undefined} kbRoot
 */
async function warmToolEmbeddings(kbRoot) {
	try {
		await ensureToolVectors(await resolveToolEmbeddingModelId(kbRoot));
	} catch (err) {
		console.warn('[DRIP MCP] tool embedding warm-up failed', err && err.message);
	}
}

module.exports = {
	initToolEmbeddings,
	resolveToolEmbeddingModelId,
	searchToolCards,
	warmToolEmbeddings
};
