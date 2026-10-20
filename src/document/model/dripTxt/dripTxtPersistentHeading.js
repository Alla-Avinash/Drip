'use strict';

const { matchHeadingTitleTypePrefix } = require('../dripNoteMetadataTemplates.js');

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

/**
 * Strip leading metadata type junk from a heading title at **index ingest** only.
 * File text keeps `# .c Title`; `headings.title` stores `Title` (type → metadata_type_id).
 *
 * Handles: `.c`, `.t4`, `.concept`, bare `. Title`, lone `.`.
 *
 * @param {string} title
 * @returns {string}
 */
function stripHeadingTitleTypePrefix(title) {
	let t = String(title || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!t.startsWith('.')) {
		return t;
	}
	if (t === '.') {
		return '';
	}
	// Bare untyped: ". Title" or ".  Title"
	if (/^\.\s+/.test(t)) {
		return t.replace(/^\.\s+/, '').trim();
	}
	// Numbered entity prefix: ".i-34 Title" → "i-34 Title" (keep id for Project View / mailbox)
	const hyp = t.match(/^\.([A-Za-z]+)-(\d+)(?:\s+|$)(.*)$/);
	if (hyp) {
		const id = `${hyp[1]}-${hyp[2]}`;
		const rest = String(hyp[3] || '').trim();
		return rest ? `${id} ${rest}` : id;
	}
	// Known-shaped marker/shortcut: ".c Title", ".t4 Title", ".concept Foo"
	const m = t.match(/^\.([A-Za-z][A-Za-z0-9_-]*)(?:\s+|$)(.*)$/);
	if (m) {
		return String(m[2] || '').trim();
	}
	// Fallback: drop leading dot only
	return t.replace(/^\./, '').trim();
}

module.exports = {
	classifyPersistentHeadingTitle,
	stripHeadingTitleTypePrefix
};
