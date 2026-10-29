'use strict';

/**
 * Canonical reprint of a project note so every peer writes the same text
 * from the same operations: LF line breaks, fileuid present, missing `@hN`
 * filled (existing ids kept), every heading in the same uid order, and
 * exactly one blank line between headings.
 */

const { ensureFileUidInHeader } = require('../../peer/projectHiddenIds');
const { stampMissingHeadingIdentitiesInText } = require('../../indexing/dripTxt/dripTxtHeadingIdentity.js');
const { formatFromPath, normalizeHeadingLayout, glueHeadingIdentities } = require('./issueInboxLayout');

/**
 * @param {string} text
 * @param {string} [format]
 * @returns {string}
 */
function reprintProjectNoteText(text, format, opts) {
	const stamped = ensureFileUidInHeader(String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
	let next = glueHeadingIdentities(stamped.text, format);
	if (format !== 'drip-md' && !(opts && opts.allocateHeadingIds === false)) {
		next = stampMissingHeadingIdentitiesInText(next).text;
	}
	return glueHeadingIdentities(normalizeHeadingLayout(next, format), format);
}

/**
 * @param {string} text
 * @param {string} [format]
 * @returns {string}
 */
function reprintProjectIssueFile(text, format, opts) {
	return reprintProjectNoteText(text, format, opts);
}

/**
 * @param {string} text
 * @param {string} fsPath
 * @returns {string}
 */
function reprintProjectIssueFileAtPath(text, fsPath, opts) {
	return reprintProjectNoteText(text, formatFromPath(fsPath), opts);
}

module.exports = {
	reprintProjectNoteText,
	reprintProjectIssueFile,
	reprintProjectIssueFileAtPath
};
