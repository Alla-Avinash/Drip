'use strict';

/** Canonical new-KB template: `src/startup/settings.drip.json` (full `drip-settings` envelope). */
const DEFAULT_SETTINGS_ENVELOPE = require('./settings.drip.json');

/**
 * @param {unknown} envelope
 * @returns {Record<string, unknown>}
 */
function settingsObjectFromEnvelope(envelope) {
	if (!envelope || typeof envelope !== 'object') {
		return {};
	}
	const body = /** @type {{ settings?: Record<string, unknown> }} */ (envelope);
	if (body.settings && typeof body.settings === 'object') {
		return body.settings;
	}
	return /** @type {Record<string, unknown>} */ (envelope);
}

/** @type {Record<string, unknown>} */
const DEFAULT_KB_SETTINGS = settingsObjectFromEnvelope(DEFAULT_SETTINGS_ENVELOPE);

/**
 * Deep-cloned default `drip.*` settings for a new `.driplock` knowledge base.
 * @returns {Record<string, unknown>}
 */
function getDefaultKnowledgeBaseSettingsObject() {
	return JSON.parse(JSON.stringify(DEFAULT_KB_SETTINGS));
}

/**
 * Full envelope written to `.dripindex/settings.drip.json` when missing (new or repaired KB).
 * Copies bundled template; refreshes `savedAt` only — never overwrites an existing file.
 * @returns {Record<string, unknown>}
 */
function buildBundledKnowledgeBaseSettingsSnapshot() {
	const snapshot = JSON.parse(JSON.stringify(DEFAULT_SETTINGS_ENVELOPE));
	snapshot.savedAt = new Date().toISOString();
	return snapshot;
}

module.exports = {
	DEFAULT_KB_SETTINGS,
	getDefaultKnowledgeBaseSettingsObject,
	buildBundledKnowledgeBaseSettingsSnapshot
};
