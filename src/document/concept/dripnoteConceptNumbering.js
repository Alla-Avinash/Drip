'use strict';

const { collectHeadingSequenceValidated } = require('../parse/dripnoteCanvasParse');
const { getMetadataSettings } = require('../model/dripnoteMetadataTemplates');

/** Product default when concept type has no shortcut configured. */
const DEFAULT_CONCEPT_SHORTCUT = 'c';

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
	const concept = settings.typeById && settings.typeById.get('concept');
	let shortcut = String((concept && concept.shortcut) || '')
		.trim()
		.replace(/\./g, '');
	if (shortcut) return shortcut;

	const map = settings.typeByShortcut;
	if (map && typeof map.entries === 'function') {
		for (const [key, type] of map.entries()) {
			if (!type || String(type.id || '').toLowerCase() !== 'concept') continue;
			const fromKey = String(key || '')
				.trim()
				.replace(/^\.+/, '');
			if (fromKey) return fromKey;
		}
	}
	return DEFAULT_CONCEPT_SHORTCUT;
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
 * File-order marked concept headings (`c#` / `.c#` / `c12`).
 * Scans the whole note (not only post-`---`) so hierarchy parents above the
 * separator still count, and numbering does not depend on outline validity.
 *
 * @param {string[]} lines
 * @param {string} shortcut
 * @returns {{ lineIndex: number, title: string }[]}
 */
function collectMarkedConceptNodes(lines, shortcut) {
	const { nodes } = collectHeadingSequenceValidated(lines, 0);
	/** @type {{ lineIndex: number, title: string }[]} */
	const marked = [];
	for (const node of nodes) {
		if (!parseMarkedConceptTitle(node.title, shortcut)) continue;
		marked.push(node);
	}
	return marked;
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

	const marked = collectMarkedConceptNodes(lines, shortcut);
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

	const marked = collectMarkedConceptNodes(lines, shortcut);
	for (let index = 0; index < marked.length; index++) {
		const parsed = parseMarkedConceptTitle(marked[index].title, shortcut);
		if (!parsed || parsed.oldNumber !== index + 1) return true;
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
