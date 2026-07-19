'use strict';

const {
	collectHeadingSequenceValidated,
	splitFileTopRegion
} = require('../parse/dripnoteCanvasParse');
const { getMetadataSettings } = require('../model/dripnoteMetadataTemplates');

function escapeRegex(value) {
	return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Numbered concepts use the configured shortcut for metadata type `concept`.
 * A leading dot is optional and is preserved by reconciliation.
 * @returns {string}
 */
function getConceptShortcut() {
	const settings = getMetadataSettings();
	const concept = settings.typeById?.get('concept');
	return String(concept?.shortcut || '').trim().replace(/\./g, '');
}

/**
 * @param {string} title
 * @param {string} shortcut
 * @returns {{ dotted: boolean, oldNumber: number | null } | null}
 */
function parseMarkedConceptTitle(title, shortcut) {
	if (!shortcut) return null;
	const re = new RegExp(`^(\\.?${escapeRegex(shortcut)})(#|\\d+)(?=\\s|$)`);
	const match = String(title || '').trim().match(re);
	if (!match) return null;
	const oldNumber = match[2] === '#' ? null : parseInt(match[2], 10);
	return {
		dotted: match[1].startsWith('.'),
		oldNumber: Number.isFinite(oldNumber) && oldNumber > 0 ? oldNumber : null
	};
}

/**
 * @param {string} line
 * @param {string} shortcut
 * @param {number} number
 * @returns {string}
 */
function writeConceptNumberToHeadingLine(line, shortcut, number) {
	const heading = String(line || '').match(/^(\s*#{1,6}\s+)(.*)$/);
	if (!heading) return String(line || '');
	const title = String(heading[2] || '');
	const leading = title.match(/^\s*/)?.[0] || '';
	const trimmed = title.slice(leading.length);
	const re = new RegExp(`^(\\.?${escapeRegex(shortcut)})(#|\\d+)(?=\\s|$)`);
	const nextTitle = trimmed.replace(re, (_all, prefix) => `${prefix}${number}`);
	return heading[1] + leading + nextTitle;
}

/**
 * Dense, file-order concept numbering shared by dotted and plain marked concepts.
 * Unmarked concept headings are intentionally ignored.
 *
 * @param {string} text
 * @returns {{ text: string, changed: boolean }}
 */
function reconcileConceptNumbersInText(text) {
	const normalized = String(text || '').replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');
	const shortcut = getConceptShortcut();
	if (!shortcut) return { text: normalized, changed: false };

	const { topEnd } = splitFileTopRegion(lines);
	const { nodes } = collectHeadingSequenceValidated(lines, topEnd);
	const marked = nodes.filter(
		node => node.valid !== false && parseMarkedConceptTitle(node.title, shortcut)
	);
	let changed = false;
	for (let index = 0; index < marked.length; index++) {
		const node = marked[index];
		const before = lines[node.lineIndex];
		const after = writeConceptNumberToHeadingLine(before, shortcut, index + 1);
		if (after !== before) {
			lines[node.lineIndex] = after;
			changed = true;
		}
	}
	return { text: lines.join('\n'), changed };
}

/**
 * True when a `shortcut#` marker or user-edited number needs dense reconciliation.
 * @param {string} text
 * @returns {boolean}
 */
function needsImmediateConceptNumbering(text) {
	const normalized = String(text || '').replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');
	const shortcut = getConceptShortcut();
	if (!shortcut) return false;

	const { topEnd } = splitFileTopRegion(lines);
	const { nodes } = collectHeadingSequenceValidated(lines, topEnd);
	let expected = 1;
	for (const node of nodes) {
		if (node.valid === false) continue;
		const marked = parseMarkedConceptTitle(node.title, shortcut);
		if (!marked) continue;
		if (marked.oldNumber !== expected) return true;
		expected += 1;
	}
	return false;
}

module.exports = {
	getConceptShortcut,
	parseMarkedConceptTitle,
	writeConceptNumberToHeadingLine,
	reconcileConceptNumbersInText,
	needsImmediateConceptNumbering
};
