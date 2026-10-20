'use strict';

/**
 * Read / edit one issue heading block in note text (pure — no vscode).
 *
 * `.d.txt` block shape:
 *   # .i-12 Title
 *   	.issue
 *   		status: to-do
 *   		priority: medium
 *
 * `.d.md` block shape:
 *   # i-12 Title
 *   <!-- drip h0 | issue | status: to-do | priority: medium -->
 *
 * Every function takes an optional trailing `format` argument (`'drip-md'` for `.d.md`);
 * `.d.txt` behaviour is unchanged when omitted.
 */

const { parseHeadingForValidation } = require('../parse/dripTxt/dripTxtHeadingParse.js');
const { parseMarkdownHeading } = require('../parse/dripMd/dripMdHeadingParse.js');
const {
	isMarkdownFormat,
	findIssueHeadingBlock,
	sectionEnd,
	indentOf
} = require('./issueInboxLayout');
const { parseIssueTitleEntityId } = require('./projectStructureRules');
const {
	parseHeadingComment,
	isHeadingComment,
	formatHeadingComment
} = require('../model/dripMd/dripMdNoteComment.js');

const HEADING_LINE_RE = /^(\s*)#\d*\s+\S/;
const IDENTITY_LINE_RE = /^\s*@+\s*h\d+\s*$/i;
const ISSUE_HEADING_RE = /^(\s*#\d*\s+)(\.i-\d+|\.i\s+i-\d+|i-\d+)\b\s*(.*)$/i;

/**
 * Clean title of an issue heading (id stripped) for either format.
 * @param {string} line
 * @param {string} [format]
 * @returns {string}
 */
function readIssueTitle(line, format) {
	if (isMarkdownFormat(format)) {
		const ph = parseMarkdownHeading(line);
		const parsed = ph ? parseIssueTitleEntityId(ph.title) : null;
		return parsed ? parsed.rest : (ph ? ph.title : '');
	}
	const hm = String(line || '').match(ISSUE_HEADING_RE);
	return hm ? String(hm[3] || '').trim() : '';
}

/**
 * Metadata lines directly under a `.d.txt` heading (until blank line / heading / body text).
 * @param {string[]} lines
 * @param {number} headingLine
 */
function readMetaRegion(lines, headingLine) {
	let markerIdx = -1;
	let lastMeta = headingLine;
	/** @type {Map<string, number>} */
	const attrIdx = new Map();
	for (let j = headingLine + 1; j < lines.length; j++) {
		const raw = String(lines[j] || '');
		const tr = raw.trim();
		if (!tr) break;
		if (HEADING_LINE_RE.test(raw) || IDENTITY_LINE_RE.test(raw)) break;
		if (tr.startsWith('//') || /^\[/.test(tr)) {
			lastMeta = j;
			continue;
		}
		if (/^\.[a-z][\w-]*\b/i.test(tr)) {
			if (/^\.issue\b/i.test(tr)) markerIdx = j;
			lastMeta = j;
			continue;
		}
		const m = tr.match(/^([a-z][a-z0-9_-]*)\s*:/i);
		if (m) {
			const k = m[1].toLowerCase();
			if (!attrIdx.has(k)) attrIdx.set(k, j);
			lastMeta = j;
			continue;
		}
		break;
	}
	return { markerIdx, lastMeta, attrIdx };
}

/**
 * First line of the issue's own sub-headings (or block end), never inside an identity line/gap.
 * @param {{ start: number, end: number, indent: number, lines: string[] }} found
 * @param {number} from
 * @param {string} [format]
 */
function ownContentEnd(found, from, format) {
	let end = found.end;
	for (let j = from; j < found.end; j++) {
		const ph = isMarkdownFormat(format)
			? parseMarkdownHeading(found.lines[j])
			: parseHeadingForValidation(found.lines[j]);
		if (ph && ph.level > found.indent) {
			end = j;
			break;
		}
	}
	while (end > from) {
		const prev = String(found.lines[end - 1]);
		if (!prev.trim() || IDENTITY_LINE_RE.test(prev)) end -= 1;
		else break;
	}
	return end;
}

/**
 * Read a `.d.md` issue block (metadata from the hidden comment, body flush-left).
 * @param {{ start: number, end: number, lines: string[] }} found
 * @param {string} title
 */
function readMdIssueBlock(found, title) {
	const { lines, start, end } = found;
	/** @type {Record<string, string>} */
	const attributes = {};
	let bodyStart = start + 1;
	if (bodyStart < lines.length && isHeadingComment(lines[bodyStart])) {
		const c = parseHeadingComment(lines[bodyStart]);
		if (c) for (const f of c.fields) attributes[f.key] = f.value;
		bodyStart += 1;
	}
	const body = lines.slice(bodyStart, end).join('\n').trim();
	return { headingLine: start, title, attributes, body };
}

/**
 * @param {string} text
 * @param {string} issueId
 * @param {string} [format]
 * @returns {{
 *   headingLine: number,
 *   title: string,
 *   attributes: Record<string, string>,
 *   body: string
 * } | null}
 */
function readIssueBlock(text, issueId, format) {
	const found = findIssueHeadingBlock(text, issueId, format);
	if (!found) return null;
	const { lines } = found;
	const title = readIssueTitle(lines[found.start], format);
	if (isMarkdownFormat(format)) return readMdIssueBlock(found, title);

	const region = readMetaRegion(lines, found.start);
	/** @type {Record<string, string>} */
	const attributes = {};
	for (const [k, idx] of region.attrIdx) {
		attributes[k] = String(lines[idx]).replace(/^\s*[a-z][a-z0-9_-]*\s*:/i, '').trim();
	}
	const bodyStart = region.lastMeta + 1;
	const bodyEnd = ownContentEnd(found, bodyStart, format);
	const strip = found.indent + 1;
	const body = lines
		.slice(bodyStart, bodyEnd)
		.map(l => {
			let out = String(l);
			for (let t = 0; t < strip && out.startsWith('\t'); t++) out = out.slice(1);
			return out;
		})
		.join('\n')
		.trim();
	return { headingLine: found.start, title, attributes, body };
}

/**
 * Heading line of an issue: the heading right under its `@h<headingId>` identity line (`.d.txt`),
 * else the first issue heading.
 * @param {string[]} lines
 * @param {string} issueId
 * @param {{ fileId?: number, headingId?: number }} ids
 * @param {string} [format]
 */
function locateIssueHeading(lines, issueId, ids, format) {
	if (!isMarkdownFormat(format) && ids.headingId != null) {
		const re = new RegExp(`^\\s*@+\\s*h${Number(ids.headingId)}\\b`, 'i');
		const k = lines.findIndex(l => re.test(String(l)));
		if (k >= 0 && k + 1 < lines.length && HEADING_LINE_RE.test(String(lines[k + 1]))) return k + 1;
	}
	const found = findIssueHeadingBlock(lines.join('\n'), issueId, format);
	return found ? found.start : -1;
}

/**
 * The issue's own body prose, bounded by its level (`sectionEnd`). The heading and its metadata
 * are not returned as prose (they duplicate `title`/`attributes`). Identity lines are dropped;
 * nested sub-issue headings keep only their heading line (their metadata, body and children are
 * skipped); plain sub-headings keep their content. Lines are de-indented to column 0.
 *
 * @param {string} text
 * @param {string} issueId
 * @param {{ fileId?: number, headingId?: number }} [ids] index ids, for an exact match
 * @param {string} [format]
 * @returns {{
 *   title: string,
 *   attributes: Record<string, string>,
 *   identity: string | null,
 *   content: string,
 *   subIssues: { id: string, title: string }[]
 * } | null}
 */
function readIssueContent(text, issueId, ids = {}, format) {
	const lines = String(text || '')
		.replace(/\r\n?/g, '\n')
		.split('\n');
	const start = locateIssueHeading(lines, issueId, ids, format);
	if (start < 0) return null;
	const level = isMarkdownFormat(format) ? parseMarkdownHeading(lines[start]).level : parseHeadingForValidation(lines[start]).level;
	const end = sectionEnd(lines, start, level, format);

	const title = readIssueTitle(lines[start], format);
	/** @type {Record<string, string>} */
	const attributes = {};
	let bodyStart = start + 1;

	if (isMarkdownFormat(format)) {
		if (bodyStart < lines.length && isHeadingComment(lines[bodyStart])) {
			const c = parseHeadingComment(lines[bodyStart]);
			if (c) for (const f of c.fields) attributes[f.key] = f.value;
			bodyStart += 1;
		}
	} else {
		const region = readMetaRegion(lines, start);
		for (const [k, idx] of region.attrIdx) {
			attributes[k] = String(lines[idx]).replace(/^\s*[a-z][a-z0-9_-]*\s*:/i, '').trim();
		}
		bodyStart = region.lastMeta + 1;
	}

	/** @type {string[]} */
	const out = [];
	/** @type {{ id: string, title: string }[]} */
	const subIssues = [];
	for (let j = bodyStart; j < end; j++) {
		const raw = String(lines[j]).replace(/\s+$/, '');
		if (IDENTITY_LINE_RE.test(raw)) continue;
		out.push(raw.slice(Math.min(level + 1, indentOf(raw, format))));
		const im = raw.match(isMarkdownFormat(format) ? /^(\s*#{1,6}\s+)(i-\d+)\b\s*(.*)$/i : ISSUE_HEADING_RE);
		if (im) {
			const idm = im[2].match(/i-\d+/i);
			subIssues.push({ id: idm ? idm[0].toLowerCase() : im[2], title: String(im[3] || '').trim() });
			const subLevel = isMarkdownFormat(format) ? parseMarkdownHeading(raw).level : parseHeadingForValidation(raw).level;
			j = Math.min(sectionEnd(lines, j, subLevel, format), end) - 1;
		}
	}
	const content = out
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	const identity =
		!isMarkdownFormat(format) && start > 0 && IDENTITY_LINE_RE.test(String(lines[start - 1]))
			? String(lines[start - 1]).trim()
			: null;
	return { title, attributes, identity, content, subIssues };
}

/**
 * Update title and/or metadata attributes (value '' removes the line) in `.d.txt`.
 * @param {string} text
 * @param {string} issueId
 * @param {{ title?: string, attributes?: Record<string, string> }} patch
 */
function updateIssueBlockTextTxt(text, issueId, patch) {
	const found = findIssueHeadingBlock(text, issueId);
	if (!found) return { ok: false, error: `Issue ${issueId} not found in this file.` };
	const lines = found.lines.slice();

	if (patch.title != null) {
		const hm = String(lines[found.start]).match(ISSUE_HEADING_RE);
		if (!hm) return { ok: false, error: `Could not read heading of ${issueId}.` };
		const t = String(patch.title).replace(/\s+/g, ' ').trim();
		if (!t) return { ok: false, error: 'Title cannot be empty.' };
		lines[found.start] = `${hm[1]}${hm[2]} ${t}`;
	}

	const attrs = patch.attributes || {};
	const keys = Object.keys(attrs);
	if (keys.length) {
		const region = readMetaRegion(lines, found.start);
		if (region.markerIdx < 0) return { ok: false, error: `${issueId} has no .issue metadata line.` };
		const markerInd = (String(lines[region.markerIdx]).match(/^(\s*)/) || ['', ''])[1];
		/** @type {number[]} */
		const removals = [];
		/** @type {string[]} */
		const inserts = [];
		for (const rawKey of keys) {
			const key = rawKey.toLowerCase();
			const value = String(attrs[rawKey] == null ? '' : attrs[rawKey]).trim();
			const idx = region.attrIdx.get(key);
			if (idx != null) {
				if (value) {
					const ind = (String(lines[idx]).match(/^(\s*)/) || ['', ''])[1];
					lines[idx] = `${ind}${key}: ${value}`;
				} else {
					removals.push(idx);
				}
			} else if (value) {
				inserts.push(`${markerInd}\t${key}: ${value}`);
			}
		}
		if (inserts.length) lines.splice(region.lastMeta + 1, 0, ...inserts);
		removals
			.map(i => (i > region.lastMeta ? i + inserts.length : i))
			.sort((a, b) => b - a)
			.forEach(i => lines.splice(i, 1));
	}
	return { ok: true, text: lines.join('\n') };
}

/**
 * Update title and/or metadata attributes in `.d.md` (the hidden comment carries the fields).
 * @param {string} text
 * @param {string} issueId
 * @param {{ title?: string, attributes?: Record<string, string> }} patch
 */
function updateIssueBlockTextMd(text, issueId, patch) {
	const found = findIssueHeadingBlock(text, issueId, 'drip-md');
	if (!found) return { ok: false, error: `Issue ${issueId} not found in this file.` };
	const lines = found.lines.slice();

	if (patch.title != null) {
		const ph = parseMarkdownHeading(lines[found.start]);
		const parsed = ph ? parseIssueTitleEntityId(ph.title) : null;
		if (!parsed) return { ok: false, error: `Could not read heading of ${issueId}.` };
		const t = String(patch.title).replace(/\s+/g, ' ').trim();
		if (!t) return { ok: false, error: 'Title cannot be empty.' };
		lines[found.start] = `${'#'.repeat(ph.level)} ${parsed.id}${t ? ` ${t}` : ''}`;
	}

	const attrs = patch.attributes || {};
	const keys = Object.keys(attrs);
	if (keys.length) {
		const cIdx = found.start + 1;
		if (cIdx >= lines.length || !isHeadingComment(lines[cIdx])) {
			return { ok: false, error: `${issueId} has no drip metadata comment.` };
		}
		const c = parseHeadingComment(lines[cIdx]);
		if (!c) return { ok: false, error: `Could not read metadata comment of ${issueId}.` };
		const fields = c.fields.filter(f => !Object.prototype.hasOwnProperty.call(attrs, f.key));
		for (const rawKey of keys) {
			const value = String(attrs[rawKey] == null ? '' : attrs[rawKey]).trim();
			if (value) fields.push({ key: rawKey.toLowerCase(), value });
		}
		lines[cIdx] = formatHeadingComment(c.headingNum, c.typeId, fields);
	}
	return { ok: true, text: lines.join('\n') };
}

/**
 * Update title and/or metadata attributes (value '' removes the line).
 * @param {string} text
 * @param {string} issueId
 * @param {{ title?: string, attributes?: Record<string, string> }} patch
 * @param {string} [format]
 * @returns {{ ok: true, text: string } | { ok: false, error: string }}
 */
function updateIssueBlockText(text, issueId, patch, format) {
	return isMarkdownFormat(format)
		? updateIssueBlockTextMd(text, issueId, patch)
		: updateIssueBlockTextTxt(text, issueId, patch);
}

/**
 * Append a paragraph to the issue's own body (after metadata/body, before sub-issues).
 * @param {string} text
 * @param {string} issueId
 * @param {string} note
 * @param {string} [format]
 * @returns {{ ok: true, text: string } | { ok: false, error: string }}
 */
function appendIssueNoteText(text, issueId, note, format) {
	const found = findIssueHeadingBlock(text, issueId, format);
	if (!found) return { ok: false, error: `Issue ${issueId} not found in this file.` };
	const noteLines = String(note || '')
		.replace(/\r\n/g, '\n')
		.split('\n');
	while (noteLines.length && !noteLines[noteLines.length - 1].trim()) noteLines.pop();
	while (noteLines.length && !noteLines[0].trim()) noteLines.shift();
	if (!noteLines.length) return { ok: false, error: 'Note text is empty.' };
	const lines = found.lines.slice();

	if (isMarkdownFormat(format)) {
		// Body sits flush-left after the hidden comment / metadata.
		let at = found.start + 1;
		if (at < lines.length && isHeadingComment(lines[at])) at += 1;
		const chunk = [''].concat(noteLines.map(l => l));
		if (at < lines.length && String(lines[at]).trim()) chunk.push('');
		lines.splice(at, 0, ...chunk);
		return { ok: true, text: lines.join('\n') };
	}

	const region = readMetaRegion(lines, found.start);
	const at = ownContentEnd(found, region.lastMeta + 1, format);
	const headInd = '\t'.repeat(found.indent + 1);
	const chunk = [''].concat(noteLines.map(l => (l.trim() ? `${headInd}${l}` : '')));
	if (at < lines.length && String(lines[at]).trim()) chunk.push('');
	lines.splice(at, 0, ...chunk);
	return { ok: true, text: lines.join('\n') };
}

module.exports = {
	readIssueBlock,
	readIssueContent,
	updateIssueBlockText,
	appendIssueNoteText
};
