'use strict';

/**
 * Timing + recall helpers for embedding benchmarks.
 */

/**
 * @param {() => Promise<T> | T} fn
 * @param {number} [runs]
 * @returns {Promise<{ msAvg: number, msMin: number, msMax: number, result: T }>}
 * @template T
 */
async function timeAsync(fn, runs = 3) {
	const n = Math.max(1, Number(runs) || 1);
	/** @type {number[]} */
	const samples = [];
	/** @type {T | undefined} */
	let result;
	for (let i = 0; i < n; i++) {
		const t0 = process.hrtime.bigint();
		result = await fn();
		const t1 = process.hrtime.bigint();
		samples.push(Number(t1 - t0) / 1e6);
	}
	samples.sort((a, b) => a - b);
	return {
		msAvg: samples.reduce((a, b) => a + b, 0) / samples.length,
		msMin: samples[0],
		msMax: samples[samples.length - 1],
		result: /** @type {T} */ (result)
	};
}

/**
 * Cosine distance for L2-normalized vectors ≈ 1 - dot; use L2 for FAISS/sqlite-vec style.
 * @param {Float32Array | number[]} a
 * @param {Float32Array | number[]} b
 */
function l2Distance(a, b) {
	let s = 0;
	const n = a.length;
	for (let i = 0; i < n; i++) {
		const d = Number(a[i]) - Number(b[i]);
		s += d * d;
	}
	return Math.sqrt(s);
}

/**
 * Brute-force exact top-k (ground truth for recall).
 * @param {Float32Array | number[]} query
 * @param {{ id: string, vector: Float32Array | number[] }[]} items
 * @param {number} k
 * @returns {{ id: string, distance: number }[]}
 */
function exactTopK(query, items, k) {
	const scored = items.map(it => ({
		id: it.id,
		distance: l2Distance(query, it.vector)
	}));
	scored.sort((a, b) => a.distance - b.distance);
	return scored.slice(0, Math.max(1, k));
}

/**
 * Recall@k: fraction of ground-truth top-k ids found in candidate top-k.
 * @param {string[]} truthIds
 * @param {string[]} candidateIds
 */
function recallAtK(truthIds, candidateIds) {
	if (!truthIds.length) return 1;
	const set = new Set(candidateIds);
	let hit = 0;
	for (const id of truthIds) {
		if (set.has(id)) hit += 1;
	}
	return hit / truthIds.length;
}

/**
 * @param {number} n
 * @param {number} digits
 */
function round(n, digits = 2) {
	const p = 10 ** digits;
	return Math.round(Number(n) * p) / p;
}

module.exports = {
	timeAsync,
	l2Distance,
	exactTopK,
	recallAtK,
	round
};
