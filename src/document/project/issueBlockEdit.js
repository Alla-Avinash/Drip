'use strict';

/**
 * Read / edit one issue heading block in note text (pure — no vscode).
 * Block shape:
 *   # .i-12 Title
 *   	.issue
 *   		status: to-do
 *   		priority: medium
 *
 *   	body text…
 *
 *   	# .i-13 child issue …
 */

const { findIssueHeadingBlock, sectionEnd, indentOf } = require('./issueInboxLayout');

const HEADING_LINE_RE = /^(\s*)#{1,6}\s+\S/;
const IDENTITY_LINE_RE = /^\s*@+\s*f\d+\s*:\s*h\d+\b/i;
const ISSUE_HEADING_RE = /^(\s*#{1,6}\s+)(\.i-\d+|\.i\s+i-\d+|i-\d+)\b\s*(.*)$/i;

/**
 * Metadata lines directly under the heading (until blank line / heading / body text).
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
 */
function ownContentEnd(found, from) {
	let end = found.end;
	for (let j = from; j < found.end; j++) {
		const hm = String(found.lines[j]).match(HEADING_LINE_RE);
		if (hm && (hm[1] || '').length > found.indent) {
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
 * @param {string} text
 * @param {string} issueId
 * @returns {{
 *   headingLine: number,
 *   title: string,
 *   attributes: Record<string, string>,
 *   body: string
 * } | null}
 */
function readIssueBlock(text, issueId) {
	const found = findIssueHeadingBlock(text, issueId);
	if (!found) return null;
	const { lines } = found;
	const hm = String(lines[found.start]).match(ISSUE_HEADING_RE);
	const title = hm ? String(hm[3] || '').trim() : '';
	const region = readMetaRegion(lines, found.start);
	/** @type {Record<string, string>} */
	const attributes = {};
	for (const [k, idx] of region.attrIdx) {
		attributes[k] = String(lines[idx]).replace(/^\s*[a-z][a-z0-9_-]*\s*:/i, '').trim();
	}
	const bodyStart = region.lastMeta + 1;
	const bodyEnd = ownContentEnd(found, bodyStart);
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
 * Heading line of an issue: the heading right under its `@f<fileId>:h<headingId>` identity line,
 * else the first `# .i-N` heading.
 * @param {string[]} lines
 * @param {string} issueId
 * @param {{ fileId?: number, headingId?: number }} ids
 */
function locateIssueHeading(lines, issueId, ids) {
	if (ids.fileId && ids.headingId != null) {
		const re = new RegExp(`^\\s*@+\\s*f${Number(ids.fileId)}\\s*:\\s*h${Number(ids.headingId)}\\b`, 'i');
		const k = lines.findIndex(l => re.test(String(l)));
		if (k >= 0 && k + 1 < lines.length && HEADING_LINE_RE.test(String(lines[k + 1]))) return k + 1;
	}
	const found = findIssueHeadingBlock(lines.join('\n'), issueId);
	return found ? found.start : -1;
}

/**
 * The issue's own body prose, bounded by its indentation (`sectionEnd`). The `# .i-N` heading and
 * its `.issue` metadata block are not returned as prose (they duplicate `title`/`attributes`).
 * Identity lines are dropped; nested sub-issue headings keep only their heading line (their
 * metadata, body and children are skipped); plain sub-headings keep their content. Lines are
 * de-indented so the issue body sits at column 0.
 *
 * @param {string} text
 * @param {string} issueId
 * @param {{ fileId?: number, headingId?: number }} [ids] index ids, for an exact match
 * @returns {{
 *   title: string,
 *   attributes: Record<string, string>,
 *   identity: string | null,
 *   content: string,
 *   subIssues: { id: string, title: string }[]
 * } | null}
 */
function readIssueContent(text, issueId, ids = {}) {
	const lines = String(text || '')
		.replace(/\r\n?/g, '\n')
		.split('\n');
	const start = locateIssueHeading(lines, issueId, ids);
	if (start < 0) return null;
	const indent = indentOf(lines[start]);
	const end = sectionEnd(lines, start, indent);

	const region = readMetaRegion(lines, start);
	/** @type {Record<string, string>} */
	const attributes = {};
	for (const [k, idx] of region.attrIdx) {
		attributes[k] = String(lines[idx]).replace(/^\s*[a-z][a-z0-9_-]*\s*:/i, '').trim();
	}

	// Body starts after the heading's own metadata block. The `# .i-N` heading and `.issue`
	// marker/attributes duplicate `title`/`attributes`, so they are not returned as prose.
	const bodyStart = region.lastMeta + 1;
	/** @type {string[]} */
	const out = [];
	/** @type {{ id: string, title: string }[]} */
	const subIssues = [];
	for (let j = bodyStart; j < end; j++) {
		const raw = String(lines[j]).replace(/\s+$/, '');
		if (IDENTITY_LINE_RE.test(raw)) continue;
		out.push(raw.slice(Math.min(indent, indentOf(raw))));
		const im = raw.match(ISSUE_HEADING_RE);
		if (im) {
			const idm = im[2].match(/i-\d+/i);
			subIssues.push({ id: idm ? idm[0].toLowerCase() : im[2], title: String(im[3] || '').trim() });
			j = Math.min(sectionEnd(lines, j, indentOf(raw)), end) - 1;
		}
	}
	const content = out
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	const hm = String(lines[start]).match(ISSUE_HEADING_RE);
	const idLine = start > 0 ? String(lines[start - 1]) : '';
	const identity = IDENTITY_LINE_RE.test(idLine) ? idLine.trim() : null;
	return { title: hm ? String(hm[3] || '').trim() : '', attributes, identity, content, subIssues };
}

/**
 * Update title and/or metadata attributes (value '' removes the line).
 * @param {string} text
 * @param {string} issueId
 * @param {{ title?: string, attributes?: Record<string, string> }} patch
 * @returns {{ ok: true, text: string } | { ok: false, error: string }}
 */
function updateIssueBlockText(text, issueId, patch) {
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
 * Append a paragraph to the issue's own body (after metadata/body, before sub-issues).
 * @param {string} text
 * @param {string} issueId
 * @param {string} note
 * @returns {{ ok: true, text: string } | { ok: false, error: string }}
 */
function appendIssueNoteText(text, issueId, note) {
	const found = findIssueHeadingBlock(text, issueId);
	if (!found) return { ok: false, error: `Issue ${issueId} not found in this file.` };
	const noteLines = String(note || '')
		.replace(/\r\n/g, '\n')
		.split('\n');
	while (noteLines.length && !noteLines[noteLines.length - 1].trim()) noteLines.pop();
	while (noteLines.length && !noteLines[0].trim()) noteLines.shift();
	if (!noteLines.length) return { ok: false, error: 'Note text is empty.' };
	const lines = found.lines.slice();
	const region = readMetaRegion(lines, found.start);
	const at = ownContentEnd(found, region.lastMeta + 1);
	const headInd = (String(lines[found.start]).match(/^(\s*)/) || ['', ''])[1];
	const chunk = [''].concat(noteLines.map(l => (l.trim() ? `${headInd}\t${l}` : '')));
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
