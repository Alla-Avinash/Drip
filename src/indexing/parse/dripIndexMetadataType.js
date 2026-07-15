'use strict';

const { getMetadataSettings } = require('../../document/model/dripnoteMetadataTemplates');

/**
 * @returns {Set<string>}
 */
function getKnownMetadataTypeIds() {
	const settings = getMetadataSettings();
	return new Set(
		settings.types
			.map(t => String(t.id || '').trim().toLowerCase())
			.filter(Boolean)
	);
}

/**
 * Normalize a note marker type for index storage.
 * Unknown or missing types become `null` (SQL NULL) and are not stored as-is.
 *
 * @param {string | null | undefined} rawType
 * @param {Set<string>} [knownTypeIds]
 * @returns {string | null}
 */
function normalizeMetadataTypeForIndex(rawType, knownTypeIds) {
	const known = knownTypeIds || getKnownMetadataTypeIds();
	const id = String(rawType || '').trim().toLowerCase();
	if (!id || !known.has(id)) {
		return null;
	}
	return id;
}

module.exports = {
	getKnownMetadataTypeIds,
	normalizeMetadataTypeForIndex
};
