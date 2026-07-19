'use strict';

const { matchHeadingTitleTypePrefix } = require('./dripnoteMetadataTemplates');

/**
 * Persistent headings are either:
 * - a bare dot marker (`. Title` or `.`), stored with metadata_type NULL; or
 * - a configured metadata shortcut/marker (`.c`, `.task`, `.t1`, ...).
 *
 * Unknown dot-prefixed markers are ordinary document headings.
 *
 * @param {string} title heading title without the leading `#`
 * @param {{ types?: any[], typeByMarker?: Map<string, any>, typeByShortcut?: Map<string, any> }} settings
 * @returns {{ persistent: boolean, metadataType: string | null }}
 */
function classifyPersistentHeadingTitle(title, settings) {
	const normalized = String(title || '').trim();
	if (/^\.(?:\s|$)/.test(normalized)) {
		return { persistent: true, metadataType: null };
	}

	const matched = matchHeadingTitleTypePrefix(normalized, settings);
	if (matched.typeId && !matched.invalid) {
		return {
			persistent: true,
			metadataType: String(matched.typeId).trim().toLowerCase() || null
		};
	}

	return { persistent: false, metadataType: null };
}

module.exports = {
	classifyPersistentHeadingTitle
};
