'use strict';

const { matchHeadingTitleTypePrefix } = require('./dripnoteMetadataTemplates');

/**
 * Persistent headings are the `# .…` family (title starts with `.`):
 * - bare `.` / `. Title` → metadata_type NULL
 * - known shortcut/marker (`.c`, `.task`, `.t1`, …) → that type id
 * - unknown `.foo` → still persistent (id allocated), metadata_type NULL
 *
 * Plain `# Heading` / undotted `# c Title` are not persistent.
 *
 * @param {string} title heading title without the leading `#`
 * @param {{ types?: any[], typeByMarker?: Map<string, any>, typeByShortcut?: Map<string, any> }} settings
 * @returns {{ persistent: boolean, metadataType: string | null }}
 */
function classifyPersistentHeadingTitle(title, settings) {
	const normalized = String(title || '').trim();
	if (!normalized.startsWith('.')) {
		return { persistent: false, metadataType: null };
	}

	const matched = matchHeadingTitleTypePrefix(normalized, settings);
	if (matched.typeId && !matched.invalid) {
		return {
			persistent: true,
			metadataType: String(matched.typeId).trim().toLowerCase() || null
		};
	}

	return { persistent: true, metadataType: null };
}

module.exports = {
	classifyPersistentHeadingTitle
};
