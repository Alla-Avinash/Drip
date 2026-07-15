'use strict';

/** `ref: [@f26, @f45:h18]` — cross-file / cross-heading references. */
const REF_LINE_RE = /^\s*ref\s*:\s*\[(.*)\]\s*$/i;

/** `@f23`, `@f45:h18`, `@f39:9` (tolerant of legacy spacing). */
const REF_TARGET_RE = /^@+\s*f(\d+)(?:\s*:\s*h?(\d+))?\s*$/i;

/**
 * @param {string} trimmed
 * @returns {boolean}
 */
function isRefLine(trimmed) {
	return REF_LINE_RE.test(String(trimmed || ''));
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isValidRefTargetToken(token) {
	return REF_TARGET_RE.test(String(token || '').trim());
}

/**
 * @param {string} line
 * @returns {{ label: string, start: number, end: number }[]}
 */
function parseRefTokenRangesFromLine(line) {
	const s = String(line || '');
	const open = s.indexOf('[');
	const close = s.lastIndexOf(']');
	if (open < 0 || close < 0 || close <= open) return [];
	const inner = s.slice(open + 1, close);
	/** @type {{ label: string, start: number, end: number }[]} */
	const out = [];
	let cursor = 0;
	for (const chunk of inner.split(',')) {
		const raw = String(chunk || '');
		const leftTrim = raw.length - raw.trimStart().length;
		const token = raw.trim();
		const start = open + 1 + cursor + leftTrim;
		const end = start + token.length;
		if (token) out.push({ label: token, start, end });
		cursor += raw.length + 1;
	}
	return out;
}

module.exports = {
	REF_LINE_RE,
	isRefLine,
	isValidRefTargetToken,
	parseRefTokenRangesFromLine
};
