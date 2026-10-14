'use strict';

const { parseHeadingForValidation } = require('../document/parse/dripnoteHeadingParse');
const {
	findMetadataBlockEndExclusive,
	isStructuredMetadataLine
} = require('../document/model/persistentHeadingZones');
const { isHeadingIdentityLine } = require('../indexing/dripnoteHeadingIdentity');

/**
 * @param {string} s
 * @returns {string}
 */
function normalizeLineEndings(s) {
	return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * @param {string} line
 * @returns {number}
 */
function leadingIndentLen(line) {
	const m = /^[ \t]*/.exec(line);
	return m ? m[0].length : 0;
}

/**
 * Dedent by the minimum shared leading indent on non-empty lines.
 * @param {string} bodyText
 * @returns {string}
 */
function dedentBodyLines(bodyText) {
	const lines = String(bodyText || '').split('\n');
	let min = Infinity;
	for (const line of lines) {
		if (!line.trim()) continue;
		const len = leadingIndentLen(line);
		if (len < min) min = len;
	}
	if (min === Infinity || min === 0) {
		return lines.join('\n');
	}
	return lines
		.map(line => {
			if (!line.trim()) return '';
			return line.slice(min);
		})
		.join('\n');
}

/**
 * Drop trailing `@hN` identity refs from a line.
 * @param {string} line
 * @returns {string}
 */
function stripTrailingIdentityRefs(line) {
	return String(line || '')
		.replace(/\s+@+h\d+\b/gi, '')
		.replace(/[ \t]+$/g, '');
}

/**
 * Remove identity-only lines and strip trailing `@h…` refs.
 * @param {string[]} lines
 * @returns {string[]}
 */
function cleanCaptureLines(lines) {
	/** @type {string[]} */
	const out = [];
	for (const raw of lines) {
		if (isHeadingIdentityLine(raw)) continue;
		const cleaned = stripTrailingIdentityRefs(raw);
		if (!cleaned.trim() && String(raw || '').trim()) continue;
		out.push(cleaned);
	}
	return out;
}

/**
 * Trim outer blanks and collapse runs of blank lines to a single blank.
 * @param {string[]} lines
 * @returns {string[]}
 */
function normalizeBlankLines(lines) {
	/** @type {string[]} */
	const out = [];
	let pendingBlank = false;
	for (const line of lines) {
		if (!String(line || '').trim()) {
			if (out.length === 0) continue;
			pendingBlank = true;
			continue;
		}
		if (pendingBlank) {
			out.push('');
			pendingBlank = false;
		}
		out.push(line);
	}
	return out;
}

/**
 * @returns {{ title: string, metadata: string, content: string }}
 */
function emptyCapture() {
	return { title: '', metadata: '', content: '' };
}

/**
 * Capture for Composer: strip `@h…` / heading ids and excess blank lines.
 * Split into heading title, freeform metadata block, and body — no type parsing.
 * Only a first line that is a real `#` heading becomes the title; otherwise everything is body.
 *
 * @param {string} rawText
 * @returns {{ title: string, metadata: string, content: string }}
 */
function parseSelectionForComposer(rawText) {
	const text = normalizeLineEndings(rawText);
	let lines = text.split('\n');
	lines = cleanCaptureLines(lines);
	lines = normalizeBlankLines(lines);
	if (!lines.length) return emptyCapture();

	const headingIdx = 0;
	if (!parseHeadingForValidation(lines[headingIdx])) {
		return {
			title: '',
			metadata: '',
			content: dedentBodyLines(lines.join('\n')).trim()
		};
	}

	const title = String(lines[headingIdx] || '').trim();
	const metaEnd = findMetadataBlockEndExclusive(lines, headingIdx);
	const metaLines = lines.slice(headingIdx + 1, metaEnd).filter(l => {
		const t = String(l || '').trim();
		return t && isStructuredMetadataLine(l);
	});
	const metadata = dedentBodyLines(metaLines.join('\n')).trim();
	const content = dedentBodyLines(lines.slice(metaEnd).join('\n')).trim();

	return { title, metadata, content };
}

/**
 * Legacy helper: title + combined metadata/body.
 * @param {string} rawText
 * @returns {{ title: string, content: string }}
 */
function splitSelectionForCapture(rawText) {
	const parsed = parseSelectionForComposer(rawText);
	const parts = [parsed.metadata, parsed.content].filter(Boolean);
	return { title: parsed.title, content: parts.join('\n\n') };
}

/**
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
	stripTrailingIdentityRefs,
	dedentBodyLines,
	normalizeBlankLines
};
