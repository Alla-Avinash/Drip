'use strict';

/**
 * Text layout for issue blocks (pure — no vscode):
 * - A heading owns every following line until the next heading at the same or a shallower
 *   marker level (`#` = 0, `#1` = 1, `#2` = 2). Section boundaries are marker-based, not
 *   indentation-based; body/metadata are tab-indented relative to their heading's level.
 * - `_issues.d.txt` keeps new issues under a plain `# _inbox` section (2 blank lines under `---`),
 *   newest last; file features use `# _inbox` the same way.
 * - Sub-issues go under their parent heading, one marker level deeper, as the parent's last child.
 */

const { parseHeadingForValidation } = require('../parse/dripnoteHeadingParse');
const {
	PROJECT_ISSUES_INBOX_HEADING_TITLE,
	normalizeIssueEntityId
} = require('./projectStructureRules');

const IDENTITY_LINE_RE = /^\s*@+\s*h\d+\s*$/i;

/**
 * Marker level of a heading line (`#` = 0, `#1` = 1, …), or -1 when not a heading.
 * @param {string} line
 * @returns {number}
 */
function headingLevelOf(line) {
	const ph = parseHeadingForValidation(line);
	return ph ? ph.level : -1;
}

/**
 * Leading whitespace width (tabs/spaces). Used for body/metadata de-indent widths.
 * @param {string} line
 * @returns {number}
 */
function indentOf(line) {
	return (String(line).match(/^[ \t]*/) || [''])[0].length;
}

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
 * @param {string[]} lines
 * @returns {string}
 */
function fromLines(lines) {
	const out = lines.slice();
	while (out.length && !String(out[out.length - 1]).trim()) out.pop();
	return out.join('\n') + '\n';
}

/**
 * Shift a block's marker levels by `delta`: headings `#`/`#N` move up/down a level, and
 * metadata/prose lines shift by the same number of tabs (identity lines stay at column 0).
 * Used to normalize a moved block to root and to place a root block at a target level.
 * @param {string[]} lines
 * @param {number} delta
 * @returns {string[]}
 */
function relevelBlock(lines, delta) {
	const d = Math.floor(Number(delta) || 0);
	if (d === 0) return (lines || []).slice();
	return (lines || []).map(line => {
		const s = String(line || '');
		const m = s.match(/^(\s*)#(\d*)(\s+)/);
		if (m) {
			const level = m[2] ? parseInt(m[2], 10) : 0;
			const newLevel = Math.max(0, level + d);
			const marker = newLevel === 0 ? '#' : `#${newLevel}`;
			return `${m[1]}${marker}${m[3]}`;
		}
		if (!s.trim() || IDENTITY_LINE_RE.test(s)) return s;
		if (d > 0) return '\t'.repeat(d) + s;
		let out = s;
		for (let t = 0; t < -d && out.startsWith('\t'); t++) out = out.slice(1);
		return out;
	});
}

/**
 * Whether `line` closes a heading section at marker `level`: a heading at the same or a
 * shallower marker level. Prose, metadata and identity lines never close a section.
 * The `---` file-header separator also never closes one (h0 stays the root above it).
 * @param {string} line
 * @param {number} level
 */
function closesSection(line, level) {
	const ph = parseHeadingForValidation(line);
	return !!ph && ph.level <= level;
}

/**
 * End (exclusive) of the section owned by the heading at `start`: the first heading at the
 * same or a shallower marker level. Trailing blank lines and the next heading's `@hN` identity
 * stay outside the section.
 *
 * @param {string[]} lines
 * @param {number} start heading line
 * @param {number} level marker level of that heading
 * @returns {number}
 */
function sectionEnd(lines, start, level) {
	let end = lines.length;
	for (let j = start + 1; j < lines.length; j++) {
		if (closesSection(lines[j], level)) {
			end = j;
			break;
		}
	}
	while (end - 1 > start) {
		const prev = String(lines[end - 1]);
		if (!prev.trim() || IDENTITY_LINE_RE.test(prev)) end -= 1;
		else break;
	}
	return end;
}

/**
 * Outline parent of each heading line under the same rule as `sectionEnd`: the nearest earlier
 * heading whose section still contains it (a heading with a strictly smaller marker level).
 *
 * @param {string[]} lines
 * @param {Set<number>} headingLines line indexes that can be parents / children
 * @returns {Map<number, number | null>} heading line → parent heading line (null = root)
 */
function outlineParentsByLine(lines, headingLines) {
	/** @type {Map<number, number | null>} */
	const parents = new Map();
	/** @type {{ line: number, level: number }[]} */
	const stack = [];
	for (let i = 0; i < lines.length; i++) {
		const line = String(lines[i] || '');
		const ph = parseHeadingForValidation(line);
		if (!ph) continue;
		while (stack.length && stack[stack.length - 1].level >= ph.level) stack.pop();
		if (!headingLines.has(i)) continue;
		parents.set(i, stack.length ? stack[stack.length - 1].line : null);
		stack.push({ line: i, level: ph.level });
	}
	return parents;
}

/**
 * Heading block of an issue (`#1 .i-12 …`, legacy `# .i i-12 …` / `# i-12 …`).
 *
 * @param {string} text
 * @param {string} issueId
 * @returns {{ start: number, end: number, indent: number, lines: string[] } | null}
 */
function findIssueHeadingBlock(text, issueId) {
	const id = normalizeIssueEntityId(issueId);
	if (!id) return null;
	const lines = toLines(text);
	const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(`^(\\s*)#\\d*\\s+(?:\\.${esc}\\b|\\.i\\s+${esc}\\b|${esc}\\b)`, 'i');
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(re);
		if (!m) continue;
		const level = headingLevelOf(lines[i]);
		return { start: i, end: sectionEnd(lines, i, level), indent: level, lines };
	}
	return null;
}

/**
 * @param {string[]} lines
 * @param {string} title
 * @returns {number}
 */
function findInboxHeadingLine(lines, title) {
	const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(`^#\\s+${esc}\\s*$`, 'i');
	return lines.findIndex(l => re.test(String(l)));
}

/**
 * Ensure a top-level `# <title>` section exists: 2 blank lines under the first `---`, or at the end.
 *
 * @param {string[]} lines
 * @param {string} title
 * @returns {{ lines: string[], headingLine: number }}
 */
function ensureInboxSection(lines, title) {
	const existing = findInboxHeadingLine(lines, title);
	if (existing >= 0) return { lines, headingLine: existing };
	const out = lines.slice();
	const heading = `# ${title}`;
	const sep = out.findIndex(l => /^---\s*$/.test(String(l)));
	if (sep < 0) {
		while (out.length && !String(out[out.length - 1]).trim()) out.pop();
		out.push('', '', heading);
		return { lines: out, headingLine: out.length - 1 };
	}
	let after = sep + 1;
	while (after < out.length && !String(out[after]).trim()) after += 1;
	const hasMore = after < out.length;
	out.splice(sep + 1, after - (sep + 1), '', '', heading, ...(hasMore ? [''] : []));
	return { lines: out, headingLine: sep + 3 };
}

/**
 * Insert `block` at `at`, separated from neighbouring content by one blank line
 * (no gap directly under the owning heading).
 *
 * @param {string[]} lines
 * @param {number} at
 * @param {number} ownerHeadingLine
 * @param {string[]} block
 * @returns {string[]}
 */
function insertBlock(lines, at, ownerHeadingLine, block) {
	const chunk = [];
	if (at - 1 !== ownerHeadingLine) chunk.push('');
	chunk.push(...block);
	if (at < lines.length && String(lines[at]).trim()) chunk.push('');
	return [...lines.slice(0, at), ...chunk, ...lines.slice(at)];
}

/**
 * Append an issue block (root-level: `# .i-N` with 1/2-tab metadata) as the last child of
 * `# _inbox` (or another top-level section), i.e. one marker level under it.
 *
 * @param {string} text
 * @param {string[]} block
 * @param {string} [sectionTitle]
 * @returns {string}
 */
function appendIssueToInbox(text, block, sectionTitle = PROJECT_ISSUES_INBOX_HEADING_TITLE) {
	const ensured = ensureInboxSection(toLines(text), sectionTitle);
	const end = sectionEnd(ensured.lines, ensured.headingLine, 0);
	return fromLines(insertBlock(ensured.lines, end, ensured.headingLine, relevelBlock(block, 1)));
}

/**
 * Append a sub-issue block (root-level) as the last child of `parentIssueId`, one marker level
 * deeper than the parent. Returns null when the parent heading is not in this text.
 *
 * @param {string} text
 * @param {string} parentIssueId
 * @param {string[]} block
 * @returns {string | null}
 */
function appendSubIssueUnderParent(text, parentIssueId, block) {
	const found = findIssueHeadingBlock(text, parentIssueId);
	if (!found) return null;
	return fromLines(insertBlock(found.lines, found.end, found.start, relevelBlock(block, found.indent + 1)));
}

/**
 * Insert a sibling issue block (root-level) directly above the issue at `issueId`, at the same
 * marker level. The identity line just above the issue is kept with it.
 *
 * @param {string} text
 * @param {string} issueId
 * @param {string[]} block
 * @returns {string | null}
 */
function insertSiblingBeforeIssue(text, issueId, block) {
	const found = findIssueHeadingBlock(text, issueId);
	if (!found) return null;
	const start =
		found.start > 0 && IDENTITY_LINE_RE.test(String(found.lines[found.start - 1]))
			? found.start - 1
			: found.start;
	const out = found.lines.slice();
	out.splice(start, 0, '', ...relevelBlock(block, found.indent), '');
	return fromLines(out);
}

/**
 * Insert a sibling issue block (root-level) directly below the issue at `issueId`, at the same
 * marker level.
 *
 * @param {string} text
 * @param {string} issueId
 * @param {string[]} block
 * @returns {string | null}
 */
function insertSiblingAfterIssue(text, issueId, block) {
	const found = findIssueHeadingBlock(text, issueId);
	if (!found) return null;
	const out = found.lines.slice();
	out.splice(found.end, 0, '', ...relevelBlock(block, found.indent), '');
	return fromLines(out);
}

/**
 * Find a heading (issue or plain) by its full title path (`A/B/C`) in note text.
 * Paths are built from marker levels (like the heading trees); header metadata carries no
 * headings, so scanning the full text yields the same paths as the body-only tree.
 *
 * @param {string} text
 * @param {string} headingPath
 * @returns {{ start: number, end: number, indent: number, lines: string[] } | null}
 */
function findHeadingSectionByPath(text, headingPath) {
	const path = String(headingPath || '').trim();
	if (!path) return null;
	const lines = toLines(text);
	const stack = [];
	for (let i = 0; i < lines.length; i++) {
		const ph = parseHeadingForValidation(lines[i]);
		if (!ph) continue;
		while (stack.length && stack[stack.length - 1].level >= ph.level) stack.pop();
		stack.push({ level: ph.level, title: ph.title });
		if (stack.map(s => s.title).join('/') === path) {
			return { start: i, end: sectionEnd(lines, i, ph.level), indent: ph.level, lines };
		}
	}
	return null;
}

/**
 * Append a block (root-level) as the last child of the heading at `headingPath`, one marker
 * level deeper. Returns null when not found.
 *
 * @param {string} text
 * @param {string} headingPath
 * @param {string[]} block
 * @returns {string | null}
 */
function appendBlockUnderHeading(text, headingPath, block) {
	const found = findHeadingSectionByPath(text, headingPath);
	if (!found) return null;
	return fromLines(insertBlock(found.lines, found.end, found.start, relevelBlock(block, found.indent + 1)));
}

/**
 * Insert a block (root-level) as a sibling directly before the heading at `headingPath`, at the
 * same marker level. Returns null when not found.
 *
 * @param {string} text
 * @param {string} headingPath
 * @param {string[]} block
 * @returns {string | null}
 */
function insertSiblingBeforeHeading(text, headingPath, block) {
	const found = findHeadingSectionByPath(text, headingPath);
	if (!found) return null;
	const out = found.lines.slice();
	out.splice(found.start, 0, '', ...relevelBlock(block, found.indent), '');
	return fromLines(out);
}

/**
 * Insert a block (root-level) as a sibling directly after the heading at `headingPath`, at the
 * same marker level. Returns null when not found.
 *
 * @param {string} text
 * @param {string} headingPath
 * @param {string[]} block
 * @returns {string | null}
 */
function insertSiblingAfterHeading(text, headingPath, block) {
	const found = findHeadingSectionByPath(text, headingPath);
	if (!found) return null;
	const out = found.lines.slice();
	out.splice(found.end, 0, '', ...relevelBlock(block, found.indent), '');
	return fromLines(out);
}

module.exports = {
	headingLevelOf,
	relevelBlock,
	indentOf,
	sectionEnd,
	outlineParentsByLine,
	findIssueHeadingBlock,
	appendIssueToInbox,
	appendSubIssueUnderParent,
	insertSiblingBeforeIssue,
	insertSiblingAfterIssue,
	findHeadingSectionByPath,
	appendBlockUnderHeading,
	insertSiblingBeforeHeading,
	insertSiblingAfterHeading
};
