'use strict';

/**
 * Convert an issue block (heading + metadata + body + nested sub-headings) between `.d.txt`
 * and `.d.md` syntax. Blocks are always root-level (the heading sits at the format's root
 * level); placement depth is applied afterwards by `issueInboxLayout.relevelToLevel`.
 *
 * `.d.txt` block:
 *     # .i-12 Fix login
 *     	.issue
 *     		status: to-do
 *
 * `.d.md` block:
 *     # i-12 Fix login
 *     <!-- drip h0 | issue | status: to-do -->
 */

const { isMarkdownFormat } = require('./issueInboxLayout');
const { parseIssueTitleEntityId } = require('./projectStructureRules');
const { getMetadataSettings } = require('../model/dripNoteMetadataTemplates.js');
const {
	parseHeadingComment,
	isHeadingComment,
	formatHeadingComment
} = require('../model/dripMd/dripMdNoteComment.js');

const ISSUE_TYPE_ID = 'issue';

/**
 * Strip a leading `.d.txt` type shortcut from a heading title (`.c Concept` → `Concept`).
 * @param {string} title
 * @returns {string}
 */
function stripDripTxtTypeShortcut(title) {
	return String(title || '').trim().replace(/^\.[a-z][a-z0-9_-]*\s+/, '').trim();
}

/**
 * Map a `.d.txt` metadata marker (`.issue`, `.concept`, …) to its type id.
 * @param {string} marker
 * @returns {string}
 */
function typeIdFromMarker(marker) {
	const m = String(marker || '').trim().toLowerCase();
	if (!m.startsWith('.')) return m;
	const t = getMetadataSettings().typeByMarker.get(m);
	return t ? t.id : m.slice(1);
}

/**
 * Read the `.d.txt` metadata block right below a heading line: a `.marker` line followed by
 * `key: value` lines until a blank line or the next heading.
 * @param {string[]} lines
 * @param {number} startIdx first line after the heading
 * @returns {{ typeId: string, fields: { key: string, value: string }[], end: number }}
 */
function readTxtHeadingMeta(lines, startIdx) {
	let typeId = '';
	/** @type {{ key: string, value: string }[]} */
	const fields = [];
	let j = startIdx;
	for (; j < lines.length; j++) {
		const t = String(lines[j] || '').trim();
		if (!t) break;
		if (/^\s*#\d*\s/.test(String(lines[j]))) break; // next heading
		if (/^\.[a-z][a-z0-9_-]*$/i.test(t)) {
			typeId = typeIdFromMarker(t);
			continue;
		}
		const km = t.match(/^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i);
		if (km) {
			fields.push({ key: km[1].toLowerCase(), value: km[2].trim() });
			continue;
		}
		break;
	}
	return { typeId, fields, end: j };
}

/**
 * Convert a root-level `.d.txt` issue block into `.d.md` lines.
 * @param {string[]} blockLines
 * @returns {string[]}
 */
function txtIssueBlockToMdLines(blockLines) {
	const lines = (blockLines || []).map(l => String(l));
	const out = [];
	let i = 0;
	while (i < lines.length) {
		const raw = lines[i];
		const hm = raw.match(/^(\s*)#(\d*)\s+(.*)$/);
		if (hm) {
			const level = hm[2] ? parseInt(hm[2], 10) : 0;
			const titleRaw = String(hm[3] || '').trim();
			const hashes = '#'.repeat(Math.min(6, level + 1));
			const issueParsed = parseIssueTitleEntityId(titleRaw);
			const title = issueParsed
				? issueParsed.rest
					? `${issueParsed.id} ${issueParsed.rest}`
					: issueParsed.id
				: stripDripTxtTypeShortcut(titleRaw);
			out.push(`${hashes} ${title}`);
			const meta = readTxtHeadingMeta(lines, i + 1);
			if (meta.typeId) out.push(formatHeadingComment(0, meta.typeId, meta.fields));
			i = meta.end;
			continue;
		}
		out.push(raw.replace(/^\t+/, ''));
		i += 1;
	}
	return out;
}

/**
 * Convert a root-level `.d.md` issue block into `.d.txt` lines.
 * @param {string[]} blockLines
 * @returns {string[]}
 */
function mdIssueBlockToTxtLines(blockLines) {
	const lines = (blockLines || []).map(l => String(l));
	const out = [];
	let i = 0;
	let currentLevel = 0;
	while (i < lines.length) {
		const raw = lines[i];
		const hm = raw.match(/^(\s*)(#{1,6})\s+(.*)$/);
		if (hm) {
			const level = hm[2].length;
			currentLevel = level - 1;
			const marker = currentLevel === 0 ? '#' : `#${currentLevel}`;
			const tabs = '\t'.repeat(currentLevel);
			const titleRaw = String(hm[3] || '').trim();
			const issueParsed = parseIssueTitleEntityId(titleRaw);
			const title = issueParsed
				? issueParsed.rest
					? `.${issueParsed.id} ${issueParsed.rest}`
					: `.${issueParsed.id}`
				: titleRaw;
			out.push(`${tabs}${marker} ${title}`);

			let typeId = '';
			/** @type {{ key: string, value: string }[]} */
			let fields = [];
			if (i + 1 < lines.length && isHeadingComment(lines[i + 1])) {
				const c = parseHeadingComment(lines[i + 1]);
				if (c) {
					typeId = c.typeId;
					fields = c.fields;
				}
				i += 1; // skip the comment line
			}
			if (typeId && typeId !== 'persistent') {
				out.push(`${tabs}\t.${typeId}`);
				for (const f of fields) out.push(`${tabs}\t\t${f.key}: ${f.value}`);
			}
			i += 1;
			continue;
		}
		if (!raw.trim()) {
			out.push('');
			i += 1;
			continue;
		}
		out.push('\t'.repeat(currentLevel + 1) + raw);
		i += 1;
	}
	return out;
}

/**
 * Convert a root-level issue block between the two formats (no-op when the formats match).
 * @param {string[]} blockLines
 * @param {string} fromFormat
 * @param {string} toFormat
 * @returns {string[]}
 */
function convertIssueBlockLines(blockLines, fromFormat, toFormat) {
	const fromMd = isMarkdownFormat(fromFormat);
	const toMd = isMarkdownFormat(toFormat);
	if (fromMd === toMd) return (blockLines || []).slice();
	return toMd ? txtIssueBlockToMdLines(blockLines) : mdIssueBlockToTxtLines(blockLines);
}

module.exports = {
	ISSUE_TYPE_ID,
	convertIssueBlockLines,
	txtIssueBlockToMdLines,
	mdIssueBlockToTxtLines
};
