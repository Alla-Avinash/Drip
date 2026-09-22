'use strict';

/**
 * Encode corpus texts with a field recipe (real MiniLM) or deterministic fake vectors (--fast).
 */

const path = require('path');
const { buildTextForFields } = require('../recipes');
const { timeAsync, exactTopK, round } = require('./metrics');

const DIM = 384;

/**
 * @param {string} text
 * @param {number} [dim]
 * @returns {Float32Array}
 */
function fakeEmbed(text, dim = DIM) {
	const v = new Float32Array(dim);
	const s = String(text || ' ');
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	const i0 = Math.abs(h) % dim;
	v[i0] = 1;
	v[(i0 + 17) % dim] = 0.35;
	v[(i0 + 41) % dim] = 0.15;
	let norm = 0;
	for (let i = 0; i < dim; i++) norm += v[i] * v[i];
	norm = Math.sqrt(norm) || 1;
	for (let i = 0; i < dim; i++) v[i] /= norm;
	return v;
}

/**
 * @param {boolean} useReal
 * @returns {Promise<(text: string) => Promise<Float32Array>>}
 */
async function getEncoder(useReal) {
	if (!useReal) {
		return async text => fakeEmbed(text);
	}
	const { encodeHeadingEmbeddingText } = require('../../src/indexing/embeddings/headingEmbeddingEncode');
	const { configureEmbeddingModelCache } = require('../../src/retrieval/embeddings');
	configureEmbeddingModelCache(path.resolve(__dirname, '..', '..'));
	return async text => {
		const vec = await encodeHeadingEmbeddingText(text);
		return vec instanceof Float32Array ? vec : new Float32Array(vec);
	};
}

/**
 * @param {import('../corpus').BenchDoc[]} docs
 * @param {import('../recipes').EmbeddingRecipe} recipe
 * @param {{ realModel?: boolean, encodeRuns?: number }} [opts]
 */
async function embedCorpusWithRecipe(docs, recipe, opts = {}) {
	const encode = await getEncoder(!!opts.realModel);
	const encodeRuns = opts.encodeRuns != null ? opts.encodeRuns : 1;
	/** @type {{ id: string, text: string, vector: Float32Array, chars: number }[]} */
	const items = [];
	let totalEncodeMs = 0;

	for (const doc of docs) {
		const text = buildTextForFields(doc, recipe.fields);
		const timed = await timeAsync(() => encode(text || ' '), encodeRuns);
		totalEncodeMs += timed.msAvg;
		items.push({ id: doc.id, text, vector: timed.result, chars: text.length });
	}

	return {
		recipeId: recipe.id,
		recipeLabel: recipe.label,
		fields: recipe.fields.slice(),
		docCount: docs.length,
		avgChars: round(items.reduce((s, it) => s + it.chars, 0) / Math.max(1, items.length), 1),
		avgEncodeMsPerDoc: round(totalEncodeMs / Math.max(1, docs.length), 2),
		totalEncodeMs: round(totalEncodeMs, 2),
		items
	};
}

/**
 * @param {import('../corpus').BenchDoc[]} docs
 * @param {import('../recipes').EmbeddingRecipe} recipe
 * @param {{ id: string, vector: Float32Array }[]} embeddedItems
 * @param {{ realModel?: boolean }} [opts]
 */
async function measureProbeRetrieval(docs, recipe, embeddedItems, opts = {}) {
	const encode = await getEncoder(!!opts.realModel);
	/** @type {{ id: string, rank: number, distance: number, hitAt1: boolean, hitAt3: boolean }[]} */
	const rows = [];

	for (const doc of docs) {
		const queryText = buildTextForFields(
			{
				title: doc.probeQuery,
				tags: recipe.fields.includes('tags') ? doc.tags : [],
				ancestors: recipe.fields.includes('ancestors') ? doc.ancestors : [],
				body: ''
			},
			recipe.fields.filter(f => f !== 'body')
		);
		const qVec = await encode(queryText || doc.probeQuery || ' ');
		const top = exactTopK(
			qVec,
			embeddedItems.map(it => ({ id: it.id, vector: it.vector })),
			5
		);
		const rankIdx = top.findIndex(h => h.id === doc.id);
		rows.push({
			id: doc.id,
			rank: rankIdx < 0 ? -1 : rankIdx + 1,
			distance: rankIdx < 0 ? Infinity : top[rankIdx].distance,
			hitAt1: rankIdx === 0,
			hitAt3: rankIdx >= 0 && rankIdx < 3
		});
	}

	const hit1 = rows.filter(x => x.hitAt1).length;
	const hit3 = rows.filter(x => x.hitAt3).length;
	const ranked = rows.filter(x => x.rank > 0);
	const avgRank =
		ranked.length > 0 ? ranked.reduce((s, x) => s + x.rank, 0) / ranked.length : null;

	return {
		probeCount: rows.length,
		hitAt1: hit1,
		hitAt3: hit3,
		hitAt1Rate: round(hit1 / Math.max(1, rows.length), 3),
		hitAt3Rate: round(hit3 / Math.max(1, rows.length), 3),
		avgRank: avgRank == null ? null : round(avgRank, 2),
		perDoc: rows
	};
}

module.exports = {
	DIM,
	fakeEmbed,
	getEncoder,
	embedCorpusWithRecipe,
	measureProbeRetrieval
};
