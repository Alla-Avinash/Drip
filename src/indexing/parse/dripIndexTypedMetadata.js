'use strict';

const { collectValidatedMetadataKeyValues, parseDatetimeToUnixSeconds } = require('./dripIndexMetadataValidate');

/** Metadata type id → SQLite typed table (schema v6). */
const METADATA_TYPE_TABLE = {
	issue: 'issue_metadata',
	task: 'issue_metadata',
	project: 'project_metadata',
	concept: 'concept_metadata'
};

/** Normalized metadata key → `issue_metadata` column. */
const ISSUE_COLUMN_BY_KEY = {
	status: 'status',
	priority: 'priority',
	deadline: 'deadline',
	work_time: 'work_minutes',
	'work-time': 'work_minutes',
	worktime: 'work_minutes',
	'work-minutes': 'work_minutes',
	'work minutes': 'work_minutes',
	duration: 'work_minutes'
};

/** Normalized metadata key → `project_metadata` column. */
const PROJECT_COLUMN_BY_KEY = {
	status: 'status'
};

/** Normalized metadata key → `concept_metadata` column. */
const CONCEPT_COLUMN_BY_KEY = {
	difficulty: 'difficulty'
};

/**
 * @param {string} metadataType
 * @param {Map<string, string | number | null>} keyValues
 * @returns {{ table: string, row: Record<string, string | number | null> } | null}
 */
function buildTypedMetadataRow(metadataType, keyValues) {
	const typeId = String(metadataType || '').trim().toLowerCase();
	const table = METADATA_TYPE_TABLE[typeId];
	if (!table || !keyValues || !keyValues.size) {
		return null;
	}

	/** @type {Record<string, string | number | null>} */
	const row = {};

	if (table === 'issue_metadata') {
		for (const [key, value] of keyValues.entries()) {
			const col = ISSUE_COLUMN_BY_KEY[key.replace(/\s+/g, ' ')] || ISSUE_COLUMN_BY_KEY[key.replace(/\s+/g, '_')];
			if (!col) continue;
			if (col === 'deadline' || col === 'work_minutes') {
				row[col] = value != null ? Number(value) : null;
			} else {
				row[col] = value != null ? String(value) : null;
			}
		}
	} else if (table === 'project_metadata') {
		for (const [key, value] of keyValues.entries()) {
			const col = PROJECT_COLUMN_BY_KEY[key];
			if (col) row[col] = value != null ? String(value) : null;
		}
	} else if (table === 'concept_metadata') {
		for (const [key, value] of keyValues.entries()) {
			const col = CONCEPT_COLUMN_BY_KEY[key];
			if (col) row[col] = value != null ? String(value) : null;
		}
	}

	if (!Object.keys(row).length) {
		return null;
	}
	return { table, row };
}

/**
 * @param {number} headingId
 * @param {string | null | undefined} metadataType
 * @param {string[]} metaLines
 * @returns {{ heading_id: number, metadata_type: string, table: string, fields: Record<string, string | number | null> } | null}
 */
function parseTypedMetadataForHeading(headingId, metadataType, metaLines) {
	const typeId = String(metadataType || '').trim().toLowerCase();
	if (!typeId) return null;
	const keyValues = collectValidatedMetadataKeyValues(metadataType, metaLines);
	const built = buildTypedMetadataRow(typeId, keyValues);
	if (!built) return null;
	return {
		heading_id: headingId,
		metadata_type: typeId,
		table: built.table,
		fields: built.row
	};
}

module.exports = {
	METADATA_TYPE_TABLE,
	collectValidatedMetadataKeyValues,
	parseTypedMetadataForHeading,
	parseDatetimeToUnixSeconds
};
