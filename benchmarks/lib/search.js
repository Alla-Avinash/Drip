'use strict';

/**
 * Exact (brute / sqlite-vec) vs FAISS HNSW latency + recall@k.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { timeAsync, exactTopK, recallAtK, round } = require('./metrics');
const { DIM, fakeEmbed } = require('./encode');

/**
 * @param {number} n
 * @param {number} [dim]
 */
function makeSyntheticVectors(n, dim = DIM) {
	/** @type {{ id: string, vector: Float32Array }[]} */
	const items = [];
	for (let i = 0; i < n; i++) {
		items.push({ id: `v${i}`, vector: fakeEmbed(`synthetic-vector-${i}-seed`, dim) });
	}
	return items;
}

/**
 * @param {{ id: string, vector: Float32Array }[]} items
 * @param {Float32Array} query
 * @param {number} k
 * @param {number} runs
 */
async function benchBruteExact(items, query, k, runs) {
	return timeAsync(() => exactTopK(query, items, k), runs);
}

/**
 * @param {{ id: string, vector: Float32Array }[]} items
 * @param {Float32Array} query
 * @param {number} k
 * @param {number} runs
 */
async function benchFaissHnsw(items, query, k, runs) {
	let faiss;
	try {
		faiss = require('faiss-node');
	} catch (err) {
		return {
			msAvg: null,
			msMin: null,
			msMax: null,
			result: null,
			error: err && err.message ? String(err.message) : String(err)
		};
	}

	const { Index, MetricType } = faiss;
	const dim = items[0].vector.length;
	const index = Index.fromFactory(dim, 'HNSW32,Flat', MetricType.METRIC_L2);
	/** @type {number[]} */
	const flat = [];
	/** @type {string[]} */
	const ids = [];
	for (const it of items) {
		for (let i = 0; i < dim; i++) flat.push(it.vector[i]);
		ids.push(it.id);
	}
	if (typeof index.isTrained === 'function' && !index.isTrained()) {
		index.train(flat);
	}
	index.add(flat);

	const timed = await timeAsync(() => {
		const res = index.search(Array.from(query), k);
		const labels = res.labels || [];
		const distances = res.distances || [];
		/** @type {{ id: string, distance: number }[]} */
		const hits = [];
		for (let i = 0; i < labels.length; i++) {
			const lab = Number(labels[i]);
			if (!Number.isFinite(lab) || lab < 0) continue;
			hits.push({ id: ids[lab], distance: Number(distances[i]) });
		}
		return hits;
	}, runs);

	return { ...timed, error: null };
}

/**
 * @param {{ id: string, vector: Float32Array }[]} items
 * @param {Float32Array} query
 * @param {number} k
 * @param {number} runs
 */
async function benchSqliteVecExact(items, query, k, runs) {
	const Database = require('better-sqlite3');
	const { getLoadablePath } = require('sqlite-vec');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drip-bench-vec-'));
	const dbPath = path.join(dir, 'bench.db');
	const db = new Database(dbPath);
	try {
		db.loadExtension(getLoadablePath());
		const dim = query.length;
		db.exec(
			`CREATE VIRTUAL TABLE v USING vec0(id INTEGER PRIMARY KEY, embedding float[${dim}])`
		);
		const ins = db.prepare('INSERT INTO v(id, embedding) VALUES (?, ?)');
		const insertMany = db.transaction(rows => {
			for (let i = 0; i < rows.length; i++) {
				ins.run(BigInt(i + 1), JSON.stringify(Array.from(rows[i].vector)));
			}
		});
		insertMany(items);
		const qJson = JSON.stringify(Array.from(query));
		return await timeAsync(() => {
			return db
				.prepare(
					`
					SELECT id, distance
					FROM v
					WHERE embedding MATCH ?
					  AND k = ?
					ORDER BY distance
					`
				)
				.all(qJson, k);
		}, runs);
	} finally {
		try {
			db.close();
		} catch {
			/* ignore */
		}
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

/**
 * @param {{ sizes?: number[], k?: number, runs?: number }} [opts]
 */
async function runSearchScaleBenchmark(opts = {}) {
	const sizes = opts.sizes || [100, 500, 1000, 2000, 5000];
	const k = opts.k || 10;
	const runs = opts.runs || 5;
	/** @type {object[]} */
	const rows = [];

	for (const n of sizes) {
		const items = makeSyntheticVectors(n);
		const query = fakeEmbed(`query-for-n-${n}`);
		const truth = exactTopK(query, items, k);
		const brute = await benchBruteExact(items, query, k, runs);
		const faiss = await benchFaissHnsw(items, query, k, runs);
		const faissHits = faiss.result || [];

		rows.push({
			vectorCount: n,
			exactMsAvg: round(brute.msAvg, 3),
			faissMsAvg: faiss.msAvg == null ? null : round(faiss.msAvg, 3),
			speedup: faiss.msAvg && brute.msAvg ? round(brute.msAvg / faiss.msAvg, 2) : null,
			faissRecallAtK: faiss.result
				? round(
						recallAtK(
							truth.map(t => t.id),
							faissHits.map(h => h.id)
						),
						3
				  )
				: null,
			faissError: faiss.error || null,
			thresholdNote:
				n <= 1000
					? 'production locks exact (≤1000)'
					: 'production locks faiss (>1000)'
		});
	}

	return { kind: 'search_scale', k, runs, rows };
}

/**
 * @param {{ sizes?: number[], k?: number, runs?: number }} [opts]
 */
async function runSearchBackendsBenchmark(opts = {}) {
	const sizes = opts.sizes || [100, 1000, 2000];
	const k = opts.k || 10;
	const runs = opts.runs || 3;
	/** @type {object[]} */
	const rows = [];

	for (const n of sizes) {
		const items = makeSyntheticVectors(n);
		const query = fakeEmbed(`backend-query-${n}`);
		const truth = exactTopK(query, items, k);
		const brute = await benchBruteExact(items, query, k, runs);
		let sqliteVecMsAvg = null;
		let sqliteVecError = null;
		try {
			const sqlite = await benchSqliteVecExact(items, query, k, runs);
			sqliteVecMsAvg = round(sqlite.msAvg, 3);
		} catch (err) {
			sqliteVecError = String(err && err.message ? err.message : err);
		}
		const faiss = await benchFaissHnsw(items, query, k, runs);

		rows.push({
			vectorCount: n,
			bruteMsAvg: round(brute.msAvg, 3),
			sqliteVecMsAvg,
			sqliteVecError,
			faissMsAvg: faiss.msAvg == null ? null : round(faiss.msAvg, 3),
			faissRecallAtK: faiss.result
				? round(
						recallAtK(
							truth.map(t => t.id),
							faiss.result.map(h => h.id)
						),
						3
				  )
				: null,
			faissError: faiss.error || null
		});
	}

	return { kind: 'search_backends', k, runs, rows };
}

module.exports = {
	makeSyntheticVectors,
	runSearchScaleBenchmark,
	runSearchBackendsBenchmark,
	benchBruteExact,
	benchFaissHnsw,
	benchSqliteVecExact
};
