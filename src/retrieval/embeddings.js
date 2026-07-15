'use strict';

/** Default ONNX model (sentence embeddings, ~22M params). */
const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

const MAX_CHARS = 6000;

/** @type {Map<string, Promise<unknown>>} */
const pipelineCache = new Map();

/**
 * @param {string} [modelId]
 */
async function getEmbeddingPipeline(modelId = DEFAULT_MODEL_ID) {
	if (!pipelineCache.has(modelId)) {
		pipelineCache.set(
			modelId,
			(async () => {
				const { pipeline } = await import('@xenova/transformers');
				return pipeline('feature-extraction', modelId);
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

	lines(`Model: ${modelId}`);
	lines('First load downloads ~90MB of ONNX weights to the Hugging Face cache (one-time per machine).');
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
}

module.exports = {
	DEFAULT_MODEL_ID,
	getEmbeddingPipeline,
	warmupEmbeddingModel,
	batchCosineScores,
	rescorePoolWithEmbeddings,
	runEmbeddingBenchmark,
	resetEmbeddingPipelineForTests,
	truncate
};
