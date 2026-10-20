'use strict';

const {
	getMetadataSettings,
	getSpecialMetadataSettings
} = require('../../document/model/dripNoteMetadataTemplates.js');

/**
 * Document + special (project/feature) type ids allowed in index.drip.
 * @returns {Set<string>}
 */
function getKnownMetadataTypeIds() {
	const doc = getMetadataSettings();
	const special = getSpecialMetadataSettings();
	const ids = new Set();
	for (const t of doc.types || []) {
		const id = String(t.id || '').trim().toLowerCase();
		if (id) ids.add(id);
	}
	for (const t of special.types || []) {
		const id = String(t.id || '').trim().toLowerCase();
		if (id) ids.add(id);
	}
	return ids;
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
