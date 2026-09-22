'use strict';

const fs = require('fs');
const path = require('path');

/** Default ONNX model (sentence embeddings, ~22M params). */
const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

/** Relative to the DRIP extension root (survives node_modules reinstalls). */
const EMBEDDING_CACHE_REL = path.join('.cache', 'transformers');

const MAX_CHARS = 6000;

/** @type {Map<string, Promise<unknown>>} */
const pipelineCache = new Map();

/** @type {string | null} */
let configuredCacheDir = null;

/**
 * Extension root: `…/extensions/drip` (or packaged VSIX extract dir).
 * @param {string} [extensionPath] from `context.extensionPath` when available
 * @returns {string}
 */
function resolveExtensionRoot(extensionPath) {
	if (extensionPath && String(extensionPath).trim()) {
		return path.resolve(String(extensionPath));
	}
	// src/retrieval → extension root
	return path.resolve(__dirname, '..', '..');
}

/**
 * Absolute path for Transformers.js / HF model weights (DRIP-local, not system HF home).
 * @param {string} [extensionPath]
 * @returns {string}
 */
function getEmbeddingModelCacheDir(extensionPath) {
	return path.join(resolveExtensionRoot(extensionPath), EMBEDDING_CACHE_REL);
}

/**
 * Point @xenova/transformers at `<extension>/.cache/transformers` so weights stay with DRIP.
 * Safe to call more than once; call from activate before any encode.
 * @param {string} [extensionPath]
 * @returns {string} cache directory used
 */
function configureEmbeddingModelCache(extensionPath) {
	const cacheDir = getEmbeddingModelCacheDir(extensionPath);
	if (configuredCacheDir === cacheDir) {
		return cacheDir;
	}
	try {
		fs.mkdirSync(cacheDir, { recursive: true });
	} catch (err) {
		console.warn('[DRIP] could not create embedding cache dir', cacheDir, err && err.message);
	}
	// Also steer any HF tooling that reads process env (avoid user/system ~/.cache/huggingface).
	process.env.TRANSFORMERS_CACHE = cacheDir;
	process.env.HF_HOME = cacheDir;
	configuredCacheDir = cacheDir;
	console.log(`[DRIP] embedding model cache → ${cacheDir}`);
	return cacheDir;
}

/**
 * Apply cacheDir on the transformers env object (must run after dynamic import).
 * @param {{ cacheDir?: string, useFSCache?: boolean }} env
 */
function applyTransformersEnvCache(env) {
	const cacheDir = configuredCacheDir || configureEmbeddingModelCache();
	if (env && typeof env === 'object') {
		env.cacheDir = cacheDir;
		if ('useFSCache' in env) {
			env.useFSCache = true;
		}
	}
	return cacheDir;
}

/**
 * @param {string} [modelId]
 */
async function getEmbeddingPipeline(modelId = DEFAULT_MODEL_ID) {
	configureEmbeddingModelCache();
	if (!pipelineCache.has(modelId)) {
		pipelineCache.set(
			modelId,
			(async () => {
				const transformers = await import('@xenova/transformers');
				applyTransformersEnvCache(transformers.env);
				return transformers.pipeline('feature-extraction', modelId);
			})()
		);
	}
	return pipelineCache.get(modelId);
}

function truncate(text, max = MAX_CHARS) {
	return String(text || '').slice(0, max);
}

/**
 * @param {import('@xenova/transformers').Tensor} tensor
 * @returns {Float32Array[]}
 */
function tensorRowsToVectors(tensor) {
	const data = tensor.data;
	const dims = tensor.dims;
	if (dims.length === 1) {
		return [new Float32Array(data.buffer, data.byteOffset, data.length)];
	}
	const batch = dims[0];
	const dim = dims[1];
	const out = [];
	for (let i = 0; i < batch; i++) {
		out.push(data.subarray(i * dim, (i + 1) * dim));
	}
	return out;
}

/**
 * Cosine similarity for L2-normalized vectors (dot product).
 * @param {Float32Array} a
 * @param {Float32Array} b
 */
function cosineDot(a, b) {
	let s = 0;
	for (let i = 0; i < a.length; i++) {
		s += a[i] * b[i];
	}
	return s;
}

/**
 * @param {string} queryText
 * @param {string[]} candidateTexts
 * @param {{ batchSize?: number, modelId?: string }} [opts]
 * @returns {Promise<number[]>}
 */
async function batchCosineScores(queryText, candidateTexts, opts = {}) {
	const batchSize = opts.batchSize ?? 12;
	const pipe = await getEmbeddingPipeline(opts.modelId);
	const qTensor = await pipe(truncate(queryText), { pooling: 'mean', normalize: true });
	const qVec = tensorRowsToVectors(qTensor)[0];

	const scores = new Array(candidateTexts.length);
	for (let start = 0; start < candidateTexts.length; start += batchSize) {
		const slice = candidateTexts.slice(start, start + batchSize).map(t => truncate(t));
		const batched = await pipe(slice, { pooling: 'mean', normalize: true });
		const rows = tensorRowsToVectors(batched);
		for (let i = 0; i < rows.length; i++) {
			scores[start + i] = cosineDot(qVec, rows[i]);
		}
	}
	return scores;
}

/**
 * Warm up the model (downloads weights on first call — can take tens of seconds).
 * @param {string} [modelId]
 */
async function warmupEmbeddingModel(modelId) {
	await getEmbeddingPipeline(modelId || DEFAULT_MODEL_ID);
}

/**
 * @param {(line: string) => void} log
 * @param {string} [modelId]
 */
async function runEmbeddingBenchmark(log, modelId = DEFAULT_MODEL_ID) {
	const lines = typeof log === 'function' ? log : () => {};
	const cacheDir = configureEmbeddingModelCache();

	lines(`Model: ${modelId}`);
	lines(`Cache (DRIP extension-local): ${cacheDir}`);
	lines('First load downloads ~90MB of ONNX weights into that folder (reused for this extension install).');
	lines('');

	const tLoad = Date.now();
	const pipe = await getEmbeddingPipeline(modelId);
	lines(`Pipeline ready: ${Date.now() - tLoad} ms (includes download on cold start)`);

	const samples = [
		'implementation details for the storage API',
		'how to configure the knowledge base root folder',
		'random unrelated pizza recipe ingredients'
	];

	const t1 = Date.now();
	const q = await pipe('Where do I save notes in the project?', { pooling: 'mean', normalize: true });
	const qv = tensorRowsToVectors(q)[0];
	lines(`Single encode (query): ${Date.now() - t1} ms`);

	const t2 = Date.now();
	const docs = await pipe(samples, { pooling: 'mean', normalize: true });
	const rows = tensorRowsToVectors(docs);
	lines(`Batch encode (${samples.length} texts): ${Date.now() - t2} ms`);

	lines('');
	lines('Cosine similarities (higher = more similar to query):');
	for (let i = 0; i < samples.length; i++) {
		lines(`  ${cosineDot(qv, rows[i]).toFixed(4)}  ${samples[i].slice(0, 60)}${samples[i].length > 60 ? '…' : ''}`);
	}

	lines('');
	lines('Done. Compare timings with a second run (model cached) via the command again.');
}

/**
 * Re-score pool items using embeddings; falls back to existing scoreValue on failure.
 * @param {Array<{ scoreValue: number, candidateText?: string }>} pool
 * @param {string} queryText
 * @param {{ modelId?: string }} [opts]
 */
async function rescorePoolWithEmbeddings(pool, queryText, opts = {}) {
	const texts = pool.map(p => p.candidateText || '');
	if (!texts.length) {
		return;
	}
	try {
		const scores = await batchCosineScores(queryText, texts, { modelId: opts.modelId });
		for (let i = 0; i < pool.length; i++) {
			pool[i].scoreValue = scores[i];
		}
	} catch (err) {
		console.error('[DRIP embeddings]', err);
	}
}

function resetEmbeddingPipelineForTests() {
	pipelineCache.clear();
	configuredCacheDir = null;
}

module.exports = {
	DEFAULT_MODEL_ID,
	EMBEDDING_CACHE_REL,
	getEmbeddingModelCacheDir,
	configureEmbeddingModelCache,
	getEmbeddingPipeline,
	warmupEmbeddingModel,
	batchCosineScores,
	rescorePoolWithEmbeddings,
	runEmbeddingBenchmark,
	resetEmbeddingPipelineForTests,
	truncate
};
