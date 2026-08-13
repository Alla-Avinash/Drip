'use strict';

/** `ref: [@f26 (topic), @f45]` — file-level references (optional topic label). */
const REF_LINE_RE = /^\s*ref\s*:\s*\[(.*)\]\s*$/i;

/** `@f23` or `@f23 (optional topic)`; heading targets `@fN:hM` are invalid. */
const REF_TARGET_RE = /^@+\s*f(\d+)(?:\s*\(([^)]*)\))?\s*$/i;

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
 * Split a `ref: […]` inner list on commas, ignoring commas inside `(…)`.
 * @param {string} inner
 * @returns {string[]}
 */
function splitRefListRespectingParens(inner) {
	const s = String(inner || '');
	/** @type {string[]} */
	const parts = [];
	let buf = '';
	let depth = 0;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === '(') {
			depth += 1;
			buf += ch;
			continue;
		}
		if (ch === ')') {
			depth = Math.max(0, depth - 1);
			buf += ch;
			continue;
		}
		if (ch === ',' && depth === 0) {
			parts.push(buf);
			buf = '';
			continue;
		}
		buf += ch;
	}
	if (buf.length || parts.length) parts.push(buf);
	return parts;
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
	for (const chunk of splitRefListRespectingParens(inner)) {
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
	REF_TARGET_RE,
	isRefLine,
	isValidRefTargetToken,
	parseRefTokenRangesFromLine,
	splitRefListRespectingParens
};
