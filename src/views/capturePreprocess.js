'use strict';

/**
 * Capture preprocessing for the Composer — the public entry into the neutral note
 * draft format shared by `.d.txt` and `.d.md` (see `../capture/noteDraft.js`).
 *
 * The old string-based helpers (`splitSelectionForCapture`, `preprocessSelectionForCapture`)
 * remain for any legacy callers and now serialize the neutral draft back to a `.d.txt`-style
 * "title + metadata/body" string.
 */

const { parseSelectionToDraft, draftToTxtMetadata } = require('../capture/noteDraft.js');

/**
 * Parse a selection (either format) into the neutral draft shape the Composer edits:
 * `{ title, typeId, fields, content }`.
 *
 * @param {string} rawText
 * @param {'drip-md' | 'md' | 'drip-txt'} [sourceFormat]
 * @returns {{ title: string, typeId: string, fields: { key: string, value: string }[], content: string }}
 */
function parseSelectionForComposer(rawText, sourceFormat) {
	return parseSelectionToDraft(rawText, sourceFormat);
}

/**
 * Legacy helper: title + combined metadata/body.
 * @param {string} rawText
 * @returns {{ title: string, content: string }}
 */
function splitSelectionForCapture(rawText) {
	const draft = parseSelectionToDraft(rawText);
	const meta = draftToTxtMetadata(draft.typeId, draft.fields);
	const parts = [meta, draft.content].filter(Boolean);
	return { title: draft.title, content: parts.join('\n\n') };
}

/**
 * Legacy helper: title + combined metadata/body, collapsed into one string.
 * @param {string} rawText
 * @returns {string}
 */
function preprocessSelectionForCapture(rawText) {
	const { title, content } = splitSelectionForCapture(rawText);
	if (!title) return content || '';
	if (!content) return title;
	return `${title}\n${content}`;
}

module.exports = {
	preprocessSelectionForCapture,
	splitSelectionForCapture,
	parseSelectionForComposer,
	parseSelectionToDraft
};
