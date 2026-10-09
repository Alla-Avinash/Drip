'use strict';

/**
 * Plain-JS vector math for embedding storage/search.
 *
 * Replaces sqlite-vec (`vec0`) and FAISS with ordinary SQLite tables that store
 * each vector as a Float32 BLOB. Search loads all vectors and scores them in JS.
 * Brute force is fast enough at DRIP's scale (thousands of vectors, ≤384 dims).
 */

/**
 * Squared L2 distance between two equal-length vectors.
 * Monotonic with L2, so it ranks identically without a sqrt.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
function l2Squared(a, b) {
	let s = 0;
	const n = a.length;
	for (let i = 0; i < n; i++) {
		const d = a[i] - b[i];
		s += d * d;
	}
	return s;
}

/**
 * Coerce a stored payload back into a `number[]`.
 * Accepts BLOB (Buffer / typed array / ArrayBuffer), `number[]`, or a JSON string.
 * @param {unknown} raw
 * @param {number} dimensions
 * @returns {number[] | null}
 */
function coerceVector(raw, dimensions) {
	if (raw == null) return null;
	if (typeof raw === 'string') {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) return parsed.map(Number);
		} catch {
			/* fall through */
		}
		return null;
	}
	if (Array.isArray(raw)) return raw.map(Number);
	if (raw instanceof Float32Array) return Array.from(raw);
	if (raw instanceof ArrayBuffer) return Array.from(new Float32Array(raw));
	if (ArrayBuffer.isView(raw)) {
		const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
		return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4)));
	}
	return null;
}

/**
 * Encode a `number[]` (or typed array) as a Float32 BLOB for storage.
 * @param {ArrayLike<number>} values
 * @returns {Buffer}
 */
function toBlob(values) {
	return Buffer.from(Float32Array.from(values).buffer);
}

module.exports = { l2Squared, coerceVector, toBlob };
