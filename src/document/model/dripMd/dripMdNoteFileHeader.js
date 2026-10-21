'use strict';

/**
 * `.d.md` note file header — parse, validate, and rebuild the hidden header comment
 * plus the h0 title heading that sit at the top of a note.
 *
 * A `.d.md` note keeps its file-level identity in one HTML comment at the very top,
 * followed by a `---` separator and two blank lines before the visible h0 heading
 * (which carries its own `<!-- drip h0 … -->` metadata comment), so a plain markdown
 * editor shows only clean content:
 *
 *     <!-- drip-file filename: "My Note" | fileid: @f23 | headings: 5 -->
 *     ---
 *
 *
 *     # My Note
 *     <!-- drip h0 | persistent | tags: [a, b] -->
 *
 *     <body>
 *
 *   - `filename` the file stem (title), quoted because it may contain spaces
 *   - `fileid`   the sequential per-KB id (`@fN`)
 *   - `headings` count of persistent (`.…`) headings in the body (the h0 is never counted)
 *
 * The two blank lines between the `---` and the h0 are fixed breathing room — the
 * reconcile always restores them so the file-level identity never crowds the title.
 *
 * This module is pure string logic. It never touches the database — fileid allocation
 * and uniqueness checking are a separate DB phase, injected here as the `fileid`
 * argument. When `fileid` is empty the field is simply omitted from the comment.
 */

const { parseMarkdownHeading } = require('../../parse/dripMd/dripMdHeadingParse.js');
const { isHeadingComment, parseHeadingComment, formatHeadingComment } = require('./dripMdNoteComment.js');
const { parseFileEntityIdNumber } = require('../../../indexing/dripTxt/dripTxtEntityIds.js');

/** `<!-- drip-file filename: "…" | fileid: @fN | headings: N -->` */
const FILE_HEADER_COMMENT_RE = /^<!--\s*drip-file\b\s*(.*?)\s*-->$/i;

/**
 * Strip the `.d.md` extension from a file basename. This is separate from
 * `stripKbNoteExtension` because `.md` alone would leave a stray `.d` in the stem.
 * @param {string} basename
 * @returns {string}
 */
function stripMdNoteExtension(basename) {
	return String(basename || '').replace(/\.d\.md$/i, '');
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isFileHeaderComment(line) {
	return FILE_HEADER_COMMENT_RE.test(String(line || '').trim());
}

/**
 * @typedef {{ filename: string, fileid: string, headings: number | null }} MdNoteFileHeader
 */

/**
 * Parse a `<!-- drip-file … -->` comment into its fields.
 * @param {string} line
 * @returns {MdNoteFileHeader | null}
 */
function parseFileHeaderComment(line) {
	const m = FILE_HEADER_COMMENT_RE.exec(String(line || '').trim());
	if (!m) return null;

	let filename = '';
	let fileid = '';
	let headings = null;
	for (const token of m[1].split('|').map(t => t.trim()).filter(Boolean)) {
		const colonAt = token.indexOf(':');
		if (colonAt < 0) continue;
		const key = token.slice(0, colonAt).trim().toLowerCase();
		const value = token.slice(colonAt + 1).trim();
		if (!key) continue;

		if (key === 'filename') {
			filename = value.replace(/^"|"$/g, '').trim();
		} else if (key === 'fileid') {
			fileid = value;
		} else if (key === 'headings') {
			const n = parseInt(value, 10);
			if (Number.isFinite(n) && n >= 0) headings = n;
		}
	}
	return { filename, fileid, headings };
}

/**
 * Format a clean file header comment.
 * @param {{ filename: string, fileid: string, headings: number }} fields
 * @returns {string}
 */
function formatFileHeaderComment(fields) {
	const parts = [`filename: "${String(fields.filename || '').trim()}"`];
	const fileid = String(fields.fileid || '').trim();
	if (fileid) parts.push(`fileid: ${fileid}`);
	parts.push(`headings: ${Math.max(0, Math.floor(Number(fields.headings) || 0))}`);
	return `<!-- drip-file ${parts.join(' | ')} -->`;
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @returns {number} index of the first non-blank line at/after `start`
 */
function firstNonBlankLineIndex(lines, start) {
	for (let i = start; i < lines.length; i++) {
		if (String(lines[i] || '').trim()) return i;
	}
	return lines.length;
}

/**
 * Count persistent headings (the `.…` family) in the body lines. The h0 heading is
 * part of the header, never the body, so every heading here is a real heading.
 * @param {string[]} bodyLines
 * @returns {number}
 */
function countPersistentHeadings(bodyLines) {
	let count = 0;
	for (let i = 0; i < bodyLines.length; i++) {
		const parsed = parseMarkdownHeading(bodyLines[i]);
		if (!parsed || !String(parsed.title || '').trim()) continue;
		// Persistent = a hidden `<!-- drip hN -->` comment directly under the heading.
		const hasComment = i + 1 < bodyLines.length && isHeadingComment(bodyLines[i + 1]);
		if (hasComment) {
			count += 1;
		}
	}
	return count;
}

/**
 * Reconcile the top of a `.d.md` note into the canonical header shape.
 *
 * Strategy: the first heading in the file (or, when a header comment exists, the
 * first heading after it) is treated as the h0 title and is rewritten to equal the
 * file stem; everything below it — after the separating blank line — is preserved
 * verbatim as the body. The fileid is preserved when it is a valid `@fN` and no
 * override is provided; otherwise it is omitted (allocation is the DB phase).
 *
 * @param {string} text
 * @param {{ fileStem?: string, fileid?: string | null }} [opts]
 * @returns {{ headerLines: string[], bodyStartLineIndex: number, changed: boolean }}
 *   `headerLines` is the canonical header block (comment, `---`, two blank lines, h0,
 *   h0 metadata comment, blank line). The host replaces the original lines
 *   `[0, bodyStartLineIndex)` with it.
 */
function reconcileMdNoteFileHeader(text, opts) {
	const options = opts || {};
	const fileStem = String(options.fileStem || '').trim() || 'Untitled';
	const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

	// Locate the header comment and the first heading. The comment only counts when it
	// sits before the first heading.
	let headerCommentIndex = -1;
	let firstHeadingIndex = -1;
	for (let i = 0; i < lines.length; i++) {
		if (firstHeadingIndex < 0 && parseMarkdownHeading(lines[i])) firstHeadingIndex = i;
		if (headerCommentIndex < 0 && isFileHeaderComment(lines[i])) headerCommentIndex = i;
	}

	// Determine where the body begins (preserved verbatim from here on).
	let h0Index = -1;
	let bodyStartLineIndex;
	if (headerCommentIndex >= 0 && (firstHeadingIndex < 0 || headerCommentIndex < firstHeadingIndex)) {
		// Header comment present: the h0 is the first heading after it.
		for (let i = headerCommentIndex + 1; i < lines.length; i++) {
			if (parseMarkdownHeading(lines[i])) {
				h0Index = i;
				break;
			}
		}
		bodyStartLineIndex = h0Index >= 0 ? firstNonBlankLineIndex(lines, h0Index + 1) : firstNonBlankLineIndex(lines, headerCommentIndex + 1);
	} else if (firstHeadingIndex >= 0) {
		// No header comment, but there is a heading — treat the first heading as the title.
		h0Index = firstHeadingIndex;
		bodyStartLineIndex = firstNonBlankLineIndex(lines, firstHeadingIndex + 1);
	} else {
		// No heading at all: everything is body, header is prepended (leading blanks fold
		// into the canonical separator).
		bodyStartLineIndex = firstNonBlankLineIndex(lines, 0);
	}

	// The h0 title always carries its metadata in a `<!-- drip h0 | … -->` comment. When one
	// is present, keep it glued to the title (it is part of the header — a blank separator
	// would push it into the body and hide the h0 chips). Look past any blank separator left
	// by an older reconcile for the h0's own comment (it is the only comment numbered `h0`).
	let h0CommentLine = '';
	if (h0Index >= 0) {
		const firstAfterH0 = firstNonBlankLineIndex(lines, h0Index + 1);
		if (firstAfterH0 < lines.length && isHeadingComment(lines[firstAfterH0])) {
			const parsed = parseHeadingComment(lines[firstAfterH0]);
			if (parsed && parsed.headingNum === 0) {
				h0CommentLine = lines[firstAfterH0];
				bodyStartLineIndex = firstNonBlankLineIndex(lines, firstAfterH0 + 1);
			}
		}
	}
	// Untyped h0 titles default to the `persistent` marker so the title always shows its chips.
	if (!h0CommentLine) {
		h0CommentLine = formatHeadingComment(0, 'persistent', []);
	}

	const bodyLines = lines.slice(bodyStartLineIndex);

	// Preserve a valid existing fileid unless an override is supplied.
	const existing = headerCommentIndex >= 0 ? parseFileHeaderComment(lines[headerCommentIndex]) : null;
	let fileid = '';
	if (options.fileid != null && String(options.fileid).trim()) {
		fileid = String(options.fileid).trim();
	} else if (existing && existing.fileid && parseFileEntityIdNumber(existing.fileid) != null) {
		fileid = existing.fileid;
	}

	const headings = countPersistentHeadings(bodyLines);
	// Canonical header: file identity, a `---` separator, two blank lines of breathing room,
	// then the h0 title with its metadata comment. The gap is fixed and never collapses.
	const headerLines = [
		formatFileHeaderComment({ filename: fileStem, fileid, headings }),
		'---',
		'',
		'',
		`# ${fileStem}`,
		h0CommentLine,
		''
	];

	// Changed when the header block differs, or the body would shift (e.g. a heading was
	// consumed into the header that didn't match the stem, or the separator changed).
	const before = lines.slice(0, bodyStartLineIndex);
	const changed =
		before.length !== headerLines.length ||
		headerLines.some((h, i) => h !== before[i]);

	return { headerLines, bodyStartLineIndex, changed };
}

module.exports = {
	stripMdNoteExtension,
	isFileHeaderComment,
	parseFileHeaderComment,
	formatFileHeaderComment,
	countPersistentHeadings,
	reconcileMdNoteFileHeader
};
