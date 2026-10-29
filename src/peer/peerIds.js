'use strict';

/**
 * Shared id helpers for peer identity and project operations.
 */

const crypto = require('crypto');

/**
 * @param {string} prefix e.g. `peer`, `proj`, `iss`, `op`
 * @returns {string}
 */
function newPrefixedId(prefix) {
	const p = String(prefix || 'id')
		.trim()
		.replace(/[^a-z0-9]/gi, '')
		.toLowerCase() || 'id';
	return `${p}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizeId(raw) {
	return String(raw || '').trim();
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
function isPrefixedId(raw, prefix) {
	const p = String(prefix || '').trim().toLowerCase();
	const v = normalizeId(raw);
	return p ? v.toLowerCase().startsWith(`${p}_`) && v.length > p.length + 1 : v.length > 0;
}

module.exports = {
	newPrefixedId,
	normalizeId,
	isPrefixedId
};
