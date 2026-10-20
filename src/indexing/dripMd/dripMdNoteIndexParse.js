'use strict';

/**
 * `.d.md` note parser → the same `parsed` shape the `.d.txt` index pipeline writes,
 * so `applyParsedNoteToIndex` / `replaceParsedNoteAtFileId` handle `.d.md` notes with
 * zero changes to the database layer.
 *
 * A `.d.md` note looks like:
 *
 *     <!-- drip-file filename: "My Note" | fileid: @f23 | headings: 2 -->
 *     # My Note
 *
 *     # .c Concept
 *     <!-- drip h1 | concept | status: in-progress | tags: [a, b] -->
 *
 * This module is pure text → rows. It reads heading ids straight from the `<!-- drip hN -->`
 * comments; when a comment is missing the heading has no id yet (the sync driver allocates
 * one, rewrites the comment, then re-parses). Nothing here touches the database.
 */

const { parseMarkdownHeading } = require('../../document/parse/dripMd/dripMdHeadingParse.js');
const { parseFileEntityIdNumber } = require('../dripTxt/dripTxtEntityIds.js');
const { parseFileHeaderComment, isFileHeaderComment } = require('../../document/model/dripMd/dripMdNoteFileHeader.js');
const { parseHeadingComment, isHeadingComment } = require('../../document/model/dripMd/dripMdNoteComment.js');
const { normalizeMetadataTypeForIndex, getKnownMetadataTypeIds } = require('../parse/dripIndexMetadataType');
const {
	collectSearchTagsFromLines,
	collectRelationsFromLines
} = require('../dripIndexParse');
const { parseTypedMetadataForHeading } = require('../parse/dripIndexTypedMetadata');

/**
 * @param {string} text
 * @returns {string[]}
 */
function toLines(text) {
	return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/**
 * Walk every heading line in a `.d.md` note and attach the `<!-- drip hN -->` comment
 * that sits directly below it (if any). The first heading is the h0 title; the rest are
 * body headings classified against the metadata settings.
 *
 * @param {string[]} lines
 * @returns {{
 *   lineIndex: number,
 *   commentLineIndex: number,
 *   tabDepth: number,
 *   level: number,
 *   title: string,
 *   cleanTitle: string,
 *   persistent: boolean,
 *   typeId: string,
 *   comment: { headingNum: number, typeId: string, fields: { key: string, value: string }[] } | null
 * }[]}
 */
function walkDripMdNoteHeadings(lines) {
	const headings = [];
	for (let i = 0; i < lines.length; i++) {
		const parsed = parseMarkdownHeading(lines[i]);
		if (!parsed) continue;

		let commentLineIndex = -1;
		if (i + 1 < lines.length && isHeadingComment(lines[i + 1])) {
			commentLineIndex = i + 1;
		}
		const comment = commentLineIndex >= 0 ? parseHeadingComment(lines[commentLineIndex]) : null;

		// Persistence comes only from the hidden comment: a heading is indexed when a
		// `<!-- drip hN -->` comment sits directly under it, and its type is the comment's
		// type token.
		headings.push({
			lineIndex: i,
			commentLineIndex,
			tabDepth: parsed.tabDepth,
			level: parsed.level,
			// Nesting depth: indentation + `#` level, so both `## …` and `\t# …` nest one level.
			depth: parsed.tabDepth + (parsed.level - 1),
			title: parsed.title,
			cleanTitle: parsed.title,
			persistent: !!comment,
			typeId: comment ? comment.typeId : '',
			comment
		});
	}
	return headings;
}

/**
 * Parse a `.d.md` note into index rows (headings + tags + relations + typed metadata).
 *
 * @param {string} text
 * @param {string} relPath KB-relative path (forward slashes)
 * @param {string} fileName basename
 * @param {{ ctimeMs?: number, mtimeMs?: number }} [times]
 * @param {{ knownTagsLower?: Set<string> }} [options]
 * @returns {{
 *   fileId: number | null,
 *   file: { path: string, name: string, created_at: number, updated_at: number },
 *   headings: { heading_id: number | null, title: string, tab_depth: number, metadata_type: string | null, parent: number | null }[],
 *   searchtags: { source_heading_id: number, tag_name: string }[],
 *   relations: { source_heading_id: number, relation_type: string, tag_name: string }[],
 *   typedMetadata: object[],
 *   _parseMode: 'full',
 *   _dirtyHeadingIds: []
 * }}
 */
function parseDripMdNoteForIndex(text, relPath, fileName, times, options) {
	const knownTagsLower = options && options.knownTagsLower ? options.knownTagsLower : undefined;
	const knownMetadataTypeIds = getKnownMetadataTypeIds();
	const lines = toLines(text);

	const headerIdx = lines.findIndex(isFileHeaderComment);
	const header = headerIdx >= 0 ? parseFileHeaderComment(lines[headerIdx]) : null;
	const fileId = header ? parseFileEntityIdNumber(header.fileid) : null;

	const nowSec = Math.floor(Date.now() / 1000);
	const created = times && Number.isFinite(times.ctimeMs) ? Math.floor(times.ctimeMs / 1000) : nowSec;
	const updated = times && Number.isFinite(times.mtimeMs) ? Math.floor(times.mtimeMs / 1000) : nowSec;

	const walked = walkDripMdNoteHeadings(lines);

	const headings = [];
	const searchtags = [];
	const relations = [];
	const typedMetadata = [];
	// Parent = nearest earlier persistent heading at a shallower depth. In markdown the
	// nesting follows heading depth only — prose and metadata comments never close a
	// section, so a plain heading stack is enough (and the h0 title never owns a section).
	const parentStack = [];

	for (let ni = 0; ni < walked.length; ni++) {
		const w = walked[ni];
		const isH0 = ni === 0;
		if (!isH0 && !w.persistent) continue;

		const metadataType = isH0 ? null : normalizeMetadataTypeForIndex(w.typeId, knownMetadataTypeIds);
		const comment = isH0 ? null : w.comment;
		const headingId = isH0 ? 0 : comment && comment.headingNum > 0 ? comment.headingNum : null;
		const fields = comment ? comment.fields : [];
		const metaLines = fields.map(f => `${f.key}: ${f.value}`);

		let parent = null;
		if (!isH0) {
			while (parentStack.length && parentStack[parentStack.length - 1].depth >= w.depth) {
				parentStack.pop();
			}
			parent = parentStack.length ? parentStack[parentStack.length - 1].heading_id : null;
			parentStack.push({ heading_id: headingId, depth: w.depth });
		}

		headings.push({
			heading_id: headingId,
			title: w.cleanTitle,
			tab_depth: w.tabDepth,
			metadata_type: metadataType,
			parent
		});

		if (!isH0 && headingId != null) {
			searchtags.push(...collectSearchTagsFromLines(metaLines, headingId, knownTagsLower));
			relations.push(...collectRelationsFromLines(metaLines, headingId, knownTagsLower));
			const typed = parseTypedMetadataForHeading(headingId, metadataType, metaLines);
			if (typed) typedMetadata.push(typed);
		}
	}

	return {
		fileId,
		file: {
			path: relPath.replace(/\\/g, '/'),
			name: fileName,
			created_at: created,
			updated_at: updated
		},
		headings,
		searchtags,
		relations,
		typedMetadata,
		_parseMode: 'full',
		_dirtyHeadingIds: []
	};
}

module.exports = {
	toLines,
	walkDripMdNoteHeadings,
	parseDripMdNoteForIndex
};
