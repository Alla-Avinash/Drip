'use strict';

/** @type {Record<string, unknown>} */
const DEFAULT_KB_SETTINGS = require('./defaultKnowledgeBaseSettings.json');

/**
 * Deep-cloned default `drip.*` settings for a new knowledge base.
 * Source: `cursor/settings.drip.json` (sync manually when that template changes).
 * @returns {Record<string, unknown>}
 */
function getDefaultKnowledgeBaseSettingsObject() {
	return JSON.parse(JSON.stringify(DEFAULT_KB_SETTINGS));
}

module.exports = {
	DEFAULT_KB_SETTINGS,
	getDefaultKnowledgeBaseSettingsObject
};
