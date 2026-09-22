'use strict';

/**
 * Encode heading embedding input text → Float32Array via Transformers.js.
 * Reuses `src/retrieval/embeddings.js` (same MiniLM pipeline / cache).
 */

const {
	DEFAULT_MODEL_ID,
	getEmbeddingPipeline,
	truncate
} = require('../../retrieval/embeddings');
const { DEFAULT_EMBEDDING_DIMENSIONS } = require('./headingEmbeddingStore');

/**
 * @param {string} text
 * @param {{ modelId?: string }} [opts]
 * @returns {Promise<Float32Array>}
 */
async function encodeHeadingEmbeddingText(text, opts = {}) {
	const modelId = opts.modelId || DEFAULT_MODEL_ID;
	const pipe = await getEmbeddingPipeline(modelId);
	const input = truncate(String(text || '').trim() || ' ');
	const tensor = await pipe(input, { pooling: 'mean', normalize: true });
	const data = tensor.data;
	const dims = tensor.dims;
	let vec;
	if (dims.length === 1) {
		vec = new Float32Array(data.buffer, data.byteOffset, data.length);
	} else {
		const dim = dims[dims.length - 1];
		vec = data.subarray(0, dim);
	}
	if (vec.length !== DEFAULT_EMBEDDING_DIMENSIONS) {
		// Soft check — store upsert will hard-fail on mismatch with index_meta dims.
		console.warn(
			`[DRIP] encodeHeadingEmbeddingText: got ${vec.length} dims (meta default ${DEFAULT_EMBEDDING_DIMENSIONS})`
		);
	}
	return vec instanceof Float32Array ? vec : new Float32Array(vec);
}

module.exports = {
	encodeHeadingEmbeddingText
};
