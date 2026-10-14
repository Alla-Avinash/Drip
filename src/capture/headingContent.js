'use strict';

/**
 * Read / append / merge a single heading's body text in a `.d.txt` note (pure — no vscode).
 * Locates the heading by its identity line (`@hN`) so the search index's headingId maps
 * directly onto disk content. Reuses the same section rule as `issueInboxLayout.sectionEnd`.
 */

const { parseHeadingIdentityLine } = require('../indexing/dripnoteHeadingIdentity');
const { sectionEnd, headingLevelOf } = require('../document/project/issueInboxLayout');
const { findMetadataBlockEndExclusive } = require('../document/model/persistentHeadingZones');

const HEADING_LINE_RE = /^\s*#\d*\s+\S/;

/**
 * @param {string} text
 * @returns {string[]}
 */
function toLines(text) {
	return String(text || '')
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.split('\n');
}

/**
 * Find a heading line by its `@hN` identity line (the heading directly below it).
 * `fileId` is kept for call-site compatibility — identity no longer carries a file id.
 * @param {string[]} lines
 * @param {string|number} _fileId
 * @param {string|number} headingId
 * @returns {{ headingLine: number, identityLine: number, indent: number, title: string } | null}
 */
function findHeadingByIdentity(lines, _fileId, headingId) {
	const hid = String(headingId);
	for (let i = 0; i < lines.length; i++) {
		const parsed = parseHeadingIdentityLine(lines[i]);
		if (!parsed) continue;
		if (String(parsed.headingNum) !== hid) continue;
		for (let j = i + 1; j < lines.length; j++) {
			const raw = String(lines[j] || '');
			if (!raw.trim()) continue;
			if (HEADING_LINE_RE.test(raw)) {
				const m = raw.match(/^\s*#\d*\s+(.*)$/);
				return {
					headingLine: j,
					identityLine: i,
					indent: headingLevelOf(raw),
					title: (m ? String(m[1]) : '').trim()
				};
			}
			break;
		}
	}
	return null;
}

/**
 * Read a heading's OWN body prose: after its metadata block, up to (not including) the first
 * child heading, identity line or `---`. Child sections are never part of the body, so
 * merge/append can not touch them. De-indented; blank runs collapsed.
 * @param {string} text
 * @param {string|number} fileId
 * @param {string|number} headingId
 * @returns {{ headingLine: number, identityLine: number, indent: number, title: string, bodyStart: number, ownEnd: number, end: number, body: string, lines: string[] } | null}
 */
function readHeadingBlock(text, fileId, headingId) {
	const lines = toLines(text);
	const found = findHeadingByIdentity(lines, fileId, headingId);
	if (!found) return null;
	return blockAt(lines, found);
}

/**
 * @param {string[]} lines
 * @param {{ headingLine: number, indent: number }} found
 */
function blockAt(lines, found) {
	const { headingLine, indent } = found;
	const end = sectionEnd(lines, headingLine, indent);
	let bodyStart = findMetadataBlockEndExclusive(lines, headingLine);
	while (bodyStart < end && !String(lines[bodyStart]).trim()) bodyStart += 1;
	let ownEnd = bodyStart;
	while (ownEnd < end) {
		const raw = String(lines[ownEnd]);
		if (HEADING_LINE_RE.test(raw) || parseHeadingIdentityLine(raw) || raw.trim() === '---') break;
		ownEnd += 1;
	}
	while (ownEnd > bodyStart && !String(lines[ownEnd - 1]).trim()) ownEnd -= 1;
	const strip = indent + 1;
	const body = lines
		.slice(bodyStart, ownEnd)
		.map(l => {
			let out = String(l);
			for (let t = 0; t < strip && out.startsWith('\t'); t++) out = out.slice(1);
			return out;
		})
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return { ...found, bodyStart, ownEnd, end, body, lines };
}

/**
 * Insert `chunk` at `at`, keeping one blank line between it and surrounding text.
 * @param {string[]} lines
 * @param {number} at
 * @param {string[]} chunk
 * @param {boolean} blankBefore
 */
function insertChunk(lines, at, chunk, blankBefore) {
	const pieces = (blankBefore ? [''] : []).concat(chunk);
	if (at < lines.length && String(lines[at]).trim()) pieces.push('');
	return [...lines.slice(0, at), ...pieces, ...lines.slice(at)];
}

/**
 * @param {string[]} lines
 * @param {string} text
 * @returns {string[]} non-empty content lines with no leading/trailing blanks
 */
function contentLinesOf(text) {
	const out = toLines(text);
	while (out.length && !out[0].trim()) out.shift();
	while (out.length && !out[out.length - 1].trim()) out.pop();
	return out;
}

/**
 * Append a paragraph to the end of a heading's own prose (before any child headings).
 * @param {string} text
 * @param {string|number} fileId
 * @param {string|number} headingId
 * @param {string} noteText
 * @returns {string | null} new file text, or null if the heading was not found
 */
function appendToHeading(text, fileId, headingId, noteText) {
	const block = readHeadingBlock(text, fileId, headingId);
	if (!block) return null;
	return appendToBlock(block, noteText);
}

/**
 * Same as appendToHeading, for a heading found by line number (no identity line needed).
 * @param {string} text
 * @param {number} headingLine 0-based line of the `#` heading in `text`
 * @param {string} noteText
 * @returns {string | null}
 */
function appendToHeadingAtLine(text, headingLine, noteText) {
	const lines = toLines(text);
	const raw = String(lines[headingLine] || '');
	if (!HEADING_LINE_RE.test(raw)) return null;
	return appendToBlock(blockAt(lines, { headingLine, indent: headingLevelOf(raw) }), noteText);
}

/**
 * @param {ReturnType<typeof blockAt>} block
 * @param {string} noteText
 */
function appendToBlock(block, noteText) {
	const prefix = '\t'.repeat(block.indent + 1);
	const noteLines = contentLinesOf(noteText);
	if (!noteLines.length) return block.lines.join('\n');
	const chunk = noteLines.map(l => (l.trim() ? prefix + l : ''));
	const hasProse = block.ownEnd > block.bodyStart;
	return insertChunk(block.lines, hasProse ? block.ownEnd : block.bodyStart, chunk, hasProse).join('\n');
}

/**
 * Replace a heading's own prose with merged prose (metadata block and child headings untouched).
 * @param {string} text
 * @param {string|number} fileId
 * @param {string|number} headingId
 * @param {string} newBodyText
 * @returns {string | null}
 */
function mergeHeadingBody(text, fileId, headingId, newBodyText) {
	const block = readHeadingBlock(text, fileId, headingId);
	if (!block) return null;
	const prefix = '\t'.repeat(block.indent + 1);
	const newLines = contentLinesOf(newBodyText).map(l => (l.trim() ? prefix + l : ''));
	if (!newLines.length) return block.lines.join('\n');
	const lines = [...block.lines.slice(0, block.bodyStart), ...block.lines.slice(block.ownEnd)];
	return insertChunk(lines, block.bodyStart, newLines, false).join('\n');
}

module.exports = { readHeadingBlock, appendToHeading, appendToHeadingAtLine, mergeHeadingBody, findHeadingByIdentity };
