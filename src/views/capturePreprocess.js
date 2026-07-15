'use strict';

/**
 * Normalize line endings to \n.
 * @param {string} s
 * @returns {string}
 */
function normalizeLineEndings(s) {
	return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Length of leading ASCII tabs and spaces only (stable for dedent; avoids full \s quirks).
 * @param {string} line
 * @returns {number}
 */
function leadingIndentLen(line) {
	const m = /^[ \t]*/.exec(line);
	return m ? m[0].length : 0;
}

/**
 * Remove the smallest leading indent shared by all non-empty body lines.
 * Blank and whitespace-only lines do not affect the minimum and become empty lines.
 * @param {string} bodyText
 * @returns {string}
 */
function dedentBodyLines(bodyText) {
	const lines = bodyText.split('\n');
	let min = Infinity;
	for (const line of lines) {
		if (!line.trim()) {
			continue;
		}
		const len = leadingIndentLen(line);
		if (len < min) {
			min = len;
		}
	}
	if (min === Infinity || min === 0) {
		return bodyText;
	}
	return lines
		.map(line => {
			if (!line.trim()) {
				return '';
			}
			return line.slice(min);
		})
		.join('\n');
}

/**
 * Prepare editor selection for capture / ingest-from-selection:
 * - Drop leading blank lines.
 * - Trim trailing blank lines.
 * - First line: trim (heading has no leading/trailing whitespace).
 * - Body: dedent by minimum shared leading tabs/spaces; relative hierarchy unchanged.
 *
 * @param {string} rawText
 * @returns {string} Single line or "title\nbody"
 */
function preprocessSelectionForCapture(rawText) {
	const text = normalizeLineEndings(rawText);
	let lines = text.split('\n');
	while (lines.length && lines[0].trim() === '') {
		lines.shift();
	}
	while (lines.length && lines[lines.length - 1].trim() === '') {
		lines.pop();
	}
	if (lines.length === 0) {
		return '';
	}
	const titleLine = lines[0].trim();
	const bodyLines = lines.slice(1);
	while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') {
		bodyLines.pop();
	}
	if (bodyLines.length === 0) {
		return titleLine;
	}
	const body = dedentBodyLines(bodyLines.join('\n'));
	return body ? `${titleLine}\n${body}` : titleLine;
}

/**
 * First line → note title, rest → draft body (after preprocessing).
 * @param {string} rawText
 * @returns {{ title: string, content: string }}
 */
function splitSelectionForCapture(rawText) {
	const processed = preprocessSelectionForCapture(rawText);
	if (!processed) {
		return { title: '', content: '' };
	}
	const idx = processed.indexOf('\n');
	if (idx === -1) {
		return { title: processed, content: '' };
	}
	return {
		title: processed.slice(0, idx),
		content: processed.slice(idx + 1)
	};
}

module.exports = {
	preprocessSelectionForCapture,
	splitSelectionForCapture
};
