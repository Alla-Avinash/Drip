'use strict';

const { collectValidatedMetadataKeyValues, parseDatetimeToUnixSeconds } = require('./dripIndexMetadataValidate');

/** Metadata type id → typed SQLite table (schema v10). Types without a table use EAV only. */
const METADATA_TYPE_TABLE = {
	concept: 'concept_metadata',
	project: 'project_metadata',
	task: 'task_metadata',
	issue: 'issue_metadata',
	decision: 'decision_metadata'
};

/**
 * Hot keys stored as typed columns. Everything else → metadata_remaining_keys.
 * Values: 'text' | 'int' (unix deadline / numeric).
 * @type {Record<string, Record<string, 'text' | 'int'>>}
 */
const TYPED_COLUMNS_BY_TYPE = {
	concept: { status: 'text' },
	project: { status: 'text', deadline: 'int' },
	task: { status: 'text', category: 'text', deadline: 'int', priority: 'text' },
	issue: { status: 'text', category: 'text', deadline: 'int', priority: 'text' },
	decision: { category: 'text' }
};

/**
 * @param {string} key
 * @returns {string}
 */
function normalizeKey(key) {
	return String(key || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ');
}

/**
 * @param {string | number | null} value
 * @param {'text' | 'int'} kind
 * @returns {string | number | null}
 */
function coerceTypedValue(value, kind) {
	if (value == null) return null;
	if (kind === 'int') {
		const n = Number(value);
		return Number.isFinite(n) ? n : null;
	}
	return String(value);
}

/**
 * Split validated key/values into typed columns vs remaining EAV pairs.
 *
 * @param {string} metadataType
 * @param {Map<string, string | number | null>} keyValues
 * @returns {{
 *   table: string | null,
 *   row: Record<string, string | number | null>,
 *   remaining: { key: string, value: string | null }[]
 * }}
 */
function buildTypedMetadataSplit(metadataType, keyValues) {
	const typeId = String(metadataType || '').trim().toLowerCase();
	const table = METADATA_TYPE_TABLE[typeId] || null;
	const typedCols = TYPED_COLUMNS_BY_TYPE[typeId] || null;

	/** @type {Record<string, string | number | null>} */
	const row = {};
	/** @type {{ key: string, value: string | null }[]} */
	const remaining = [];

	if (!keyValues || !keyValues.size) {
		return { table, row, remaining };
	}

	for (const [rawKey, value] of keyValues.entries()) {
		const key = normalizeKey(rawKey);
		const colKind = typedCols ? typedCols[key] : undefined;
		if (colKind) {
			const coerced = coerceTypedValue(value, colKind);
			if (coerced == null) {
				continue;
			}
			if (typeof coerced === 'string' && !coerced.trim()) {
				continue;
			}
			row[key] = coerced;
			continue;
		}
		// EAV: only store keys that have a real value — never null/empty placeholders.
		if (value == null) {
			continue;
		}
		const asText = String(value).trim();
		if (!asText) {
			continue;
		}
		remaining.push({
			key,
			value: asText
		});
	}

	return { table, row, remaining };
}

/**
 * @param {number} headingId
 * @param {string | null | undefined} metadataType
 * @param {string[]} metaLines
 * @returns {{
 *   heading_id: number,
 *   metadata_type: string,
 *   table: string | null,
 *   fields: Record<string, string | number | null>,
 *   remaining: { key: string, value: string | null }[]
 * } | null}
 */
function parseTypedMetadataForHeading(headingId, metadataType, metaLines) {
	const typeId = String(metadataType || '').trim().toLowerCase();
	if (!typeId) return null;
	const keyValues = collectValidatedMetadataKeyValues(metadataType, metaLines);
	const built = buildTypedMetadataSplit(typeId, keyValues);
	if (!Object.keys(built.row).length && !built.remaining.length) {
		return null;
	}
	return {
		heading_id: headingId,
		metadata_type: typeId,
		table: built.table,
		fields: built.row,
		remaining: built.remaining
	};
}

module.exports = {
	METADATA_TYPE_TABLE,
	TYPED_COLUMNS_BY_TYPE,
	collectValidatedMetadataKeyValues,
	buildTypedMetadataSplit,
	parseTypedMetadataForHeading,
	parseDatetimeToUnixSeconds
};
