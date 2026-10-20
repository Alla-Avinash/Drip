'use strict';

/**
 * Sequential entity IDs for DRIP notes (shared counter for files + headings in later steps).
 * Canonical format: "@f123" (file) and "@h456" (heading).
 * Parsers stay tolerant of legacy spaced variants like "@ f123".
 */

const FILE_ENTITY_RE = /^@\s*f(\d+)\s*$/i;
const HEADING_ENTITY_RE = /^@\s*h(\d+)\s*$/i;

/**
 * @param {number} n
 * @returns {string}
 */
function formatFileEntityId(n) {
	const k = Math.max(0, Math.floor(Number(n) || 0));
	return `@f${k}`;
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatHeadingEntityId(n) {
	const k = Math.max(0, Math.floor(Number(n) || 0));
	return `@h${k}`;
}

/**
 * @param {string} s
 * @returns {boolean}
 */
function isFileEntityIdLine(s) {
	return FILE_ENTITY_RE.test(String(s || '').trim());
}

/**
 * @param {string} s
 * @returns {boolean}
 */
function isHeadingEntityIdLine(s) {
	return HEADING_ENTITY_RE.test(String(s || '').trim());
}

/**
 * @param {string} s
 * @returns {number | null}
 */
function parseFileEntityIdNumber(s) {
	const m = FILE_ENTITY_RE.exec(String(s || '').trim());
	if (!m) return null;
	const n = parseInt(m[1], 10);
	return Number.isFinite(n) ? n : null;
}

/**
 * @param {string} s
 * @returns {number | null}
 */
function parseHeadingEntityIdNumber(s) {
	const m = HEADING_ENTITY_RE.exec(String(s || '').trim());
	if (!m) return null;
	const n = parseInt(m[1], 10);
	return Number.isFinite(n) ? n : null;
}

module.exports = {
	formatFileEntityId,
	formatHeadingEntityId,
	isFileEntityIdLine,
	isHeadingEntityIdLine,
	parseFileEntityIdNumber,
	parseHeadingEntityIdNumber,
	FILE_ENTITY_RE,
	HEADING_ENTITY_RE
};
