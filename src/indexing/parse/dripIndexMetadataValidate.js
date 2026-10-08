'use strict';

const { getMetadataSettingsForIndex } = require('../../document/model/dripnoteMetadataTemplates');
const { parseFlexibleDateTime } = require('../../document/parse/dripnoteDatetime');
const {
	parseDurationValue,
	isValidDurationValue,
	resolveDurationUnits,
	normalizeDurationValue
} = require('../../document/parse/dripnoteDuration');

const KEY_VALUE_RE = /^\s*([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i;

/**
 * @param {string} key
 */
function normalizeMetadataKey(key) {
	return String(key || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ');
}

/**
 * @param {string[]} metaLines
 * @returns {Map<string, string>}
 */
function collectRawMetadataKeyValues(metaLines) {
	/** @type {Map<string, string>} */
	const out = new Map();
	for (const line of metaLines || []) {
		const trimmed = String(line || '').trim();
		if (!trimmed || trimmed === '---') continue;
		if (/^\s*\.(\w[\w-]*)/.test(trimmed)) continue;
		if (/^\s*ref\s*:/i.test(trimmed)) continue;
		if (/^\s*(tags|pre-req)\s*:\s*\[/i.test(trimmed)) continue;
		if (/^\s*\[[^\]]*\]\s*$/.test(trimmed)) continue;
		if (/^\s*@+\s*f\d+\s*:\s*h\d+/i.test(trimmed)) continue;

		const m = String(line || '').match(KEY_VALUE_RE);
		if (!m) continue;
		const key = normalizeMetadataKey(m[1]);
		const value = String(m[2] || '').trim();
		if (key) {
			out.set(key, value);
		}
	}
	return out;
}

/**
 * @param {string} value
 * @param {Date} [now]
 * @returns {number | null}
 */
function parseDatetimeToUnixSeconds(value, now) {
	const parsed = parseFlexibleDateTime(value, now);
	if (!parsed || Number.isNaN(parsed.getTime())) return null;
	return Math.floor(parsed.getTime() / 1000);
}

/**
 * Duration values are stored as total seconds (integer).
 * @param {string} value
 * @param {string[]} [allowedUnits]
 * @returns {number | null}
 */
function parseDurationToSeconds(value, allowedUnits) {
	const units = resolveDurationUnits(allowedUnits);
	const normalized = normalizeDurationValue(String(value || '').trim(), units);
	const parsed = parseDurationValue(normalized || String(value || '').trim());
	if (!parsed) return null;
	const amount = parsed.amount;
	const unit = String(parsed.unit || '').toLowerCase();
	if (unit === 'minute' || unit.startsWith('min')) return Math.round(amount * 60);
	if (unit === 'hour' || unit.startsWith('h')) return Math.round(amount * 3600);
	if (unit === 'day' || unit.startsWith('day')) return Math.round(amount * 86400);
	if (unit === 'week' || unit.startsWith('week')) return Math.round(amount * 604800);
	if (unit === 'month' || unit.startsWith('month')) return Math.round(amount * 2592000);
	if (unit === 'year' || unit.startsWith('year')) return Math.round(amount * 31536000);
	return null;
}

/**
 * Resolve one attribute for index storage (validated; invalid user values are dropped).
 *
 * @param {{ kind: string, values?: string[], default?: string }} rule
 * @param {string} rawValue
 * @param {Date} [now]
 * @returns {string | number | null | undefined} `undefined` = omit from index row
 */
function resolveValidatedAttributeValue(rule, rawValue, now) {
	const kind = String(rule.kind || 'enum').toLowerCase();
	const value = String(rawValue || '').trim();
	const fallback = String(rule.default || '').trim();

	if (!value) {
		if (!fallback) return null;
		return resolveValidatedAttributeValue(rule, fallback, now);
	}

	if (kind === 'enum') {
		const allowed = (Array.isArray(rule.values) ? rule.values : []).map(v => String(v).toLowerCase());
		const low = value.toLowerCase();
		if (allowed.length && !allowed.includes(low)) {
			return undefined;
		}
		return value;
	}

	if (kind === 'datetime') {
		const seconds = parseDatetimeToUnixSeconds(value, now);
		return seconds != null ? seconds : undefined;
	}

	if (kind === 'duration') {
		const units = resolveDurationUnits(undefined);
		if (!isValidDurationValue(value, units)) {
			return undefined;
		}
		const seconds = parseDurationToSeconds(value, units);
		return seconds != null ? seconds : undefined;
	}

	if (kind === 'issue_parent') {
		const m = value.match(/^i-(\d+)$/i);
		if (!m) return undefined;
		const n = parseInt(m[1], 10);
		if (!Number.isFinite(n) || n < 1) return undefined;
		return `i-${n}`;
	}

	return undefined;
}

/**
 * Validated metadata key values explicitly present in a heading metadata block.
 * Blank present keys may use a settings default; missing, null, and invalid keys are omitted.
 *
 * @param {string | null | undefined} metadataType
 * @param {string[]} metaLines
 * @returns {Map<string, string | number | null>}
 */
function collectValidatedMetadataKeyValues(metadataType, metaLines) {
	/** @type {Map<string, string | number | null>} */
	const out = new Map();
	const typeId = String(metadataType || '').trim().toLowerCase();
	if (!typeId) return out;

	const settings = getMetadataSettingsForIndex();
	const typeDef = settings.typeById.get(typeId);
	if (!typeDef) return out;

	const raw = collectRawMetadataKeyValues(metaLines);
	const now = new Date();

	// Only index keys explicitly present in this heading's metadata block.
	// A settings default may fill an explicitly written blank key, but a missing
	// key never creates a typed column value or an EAV row.
	for (const [rawKey, rawValue] of raw.entries()) {
		const normKey = normalizeMetadataKey(rawKey);
		const rule = typeDef.attributes && typeDef.attributes[normKey];
		if (!normKey || !rule) continue;
		const resolved = resolveValidatedAttributeValue(rule, rawValue, now);
		if (resolved === undefined || resolved === null) continue;
		out.set(normKey, resolved);
	}

	return out;
}

module.exports = {
	collectRawMetadataKeyValues,
	collectValidatedMetadataKeyValues,
	parseDatetimeToUnixSeconds,
	parseDurationToSeconds,
	resolveValidatedAttributeValue
};
