'use strict';

/**
 * Text layout for issue blocks (pure — no vscode):
 * - A heading owns every following line indented deeper than itself; the first non-blank line
 *   (text, identity line or heading) at the same or a shallower indent ends it (`sectionEnd`).
 * - `_issues.d.txt` keeps new issues under a plain `# _inbox` section (2 blank lines under `---`),
 *   newest last; file features use `# _inbox` the same way.
 * - Sub-issues go under their parent heading, one tab deeper, as the parent's last child.
 */

const {
	PROJECT_ISSUES_INBOX_HEADING_TITLE,
	normalizeIssueEntityId
} = require('./projectStructureRules');

const IDENTITY_LINE_RE = /^\s*@+\s*f\d+\s*:\s*h\d+\b/i;

/**
 * Leading whitespace width (tabs in DRIP notes).
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
 * Whether `line` closes a heading section at `indent`: any non-blank line indented no deeper.
 * The `---` file-header separator never closes one (h0 stays the root above it).
 * @param {string} line
 * @param {number} indent
 */
function closesSection(line, indent) {
	const tr = String(line).trim();
	return !!tr && tr !== '---' && indentOf(line) <= indent;
}

/**
 * End (exclusive) of the section owned by the heading at `start`: the first line that
 * `closesSection`. Trailing blank lines stay outside the section.
 *
 * @param {string[]} lines
 * @param {number} start heading line
 * @param {number} indent indent width of that heading
 * @returns {number}
 */
function sectionEnd(lines, start, indent) {
	let end = lines.length;
	for (let j = start + 1; j < lines.length; j++) {
		if (closesSection(lines[j], indent)) {
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
 * heading (from `headingLines`) whose section still contains it. Lines not in `headingLines`
 * (text, identity lines, headings left out by the caller) still close sections.
 *
 * @param {string[]} lines
 * @param {Set<number>} headingLines line indexes that can be parents / children
 * @returns {Map<number, number | null>} heading line → parent heading line (null = root)
 */
function outlineParentsByLine(lines, headingLines) {
	/** @type {Map<number, number | null>} */
	const parents = new Map();
	/** @type {{ line: number, indent: number }[]} */
	const stack = [];
	for (let i = 0; i < lines.length; i++) {
		const line = String(lines[i] || '');
		const tr = line.trim();
		if (!tr || tr === '---') continue;
		const indent = indentOf(line);
		while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
		if (!headingLines.has(i)) continue;
		parents.set(i, stack.length ? stack[stack.length - 1].line : null);
		stack.push({ line: i, indent });
	}
	return parents;
}

/**
 * Heading block of an issue (`# .i-12 …`, legacy `# .i i-12 …` / `# i-12 …`).
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
	const re = new RegExp(`^(\\s*)#\\s+(?:\\.${esc}\\b|\\.i\\s+${esc}\\b|${esc}\\b)`, 'i');
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(re);
		if (!m) continue;
		const indent = (m[1] || '').length;
		return { start: i, end: sectionEnd(lines, i, indent), indent, lines };
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
 * @param {string[]} block lines at indent 0
 * @param {string} prefix
 * @returns {string[]}
 */
function indentBlock(block, prefix) {
	return block.map(l => (String(l).trim() ? prefix + l : ''));
}

/**
 * Append an issue block (lines at indent 0) as the last child of `# _inbox`
 * (or another top-level section, e.g. a file feature's `# _inbox`).
 *
 * @param {string} text
 * @param {string[]} block
 * @param {string} [sectionTitle]
 * @returns {string}
 */
function appendIssueToInbox(text, block, sectionTitle = PROJECT_ISSUES_INBOX_HEADING_TITLE) {
	const ensured = ensureInboxSection(toLines(text), sectionTitle);
	const end = sectionEnd(ensured.lines, ensured.headingLine, 0);
	return fromLines(insertBlock(ensured.lines, end, ensured.headingLine, indentBlock(block, '\t')));
}

/**
 * Append a sub-issue block (lines at indent 0) as the last child of `parentIssueId`.
 * Returns null when the parent heading is not in this text.
 *
 * @param {string} text
 * @param {string} parentIssueId
 * @param {string[]} block
 * @returns {string | null}
 */
function appendSubIssueUnderParent(text, parentIssueId, block) {
	const found = findIssueHeadingBlock(text, parentIssueId);
	if (!found) return null;
	const prefix = '\t'.repeat(found.indent + 1);
	return fromLines(insertBlock(found.lines, found.end, found.start, indentBlock(block, prefix)));
}

/**
 * Insert a sibling issue block (lines at indent 0) directly above the issue at `issueId`, at the
 * same indent. The identity line just above the issue is kept with it.
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
	const prefix = '\t'.repeat(found.indent);
	const out = found.lines.slice();
	out.splice(start, 0, '', ...indentBlock(block, prefix), '');
	return fromLines(out);
}

/**
 * Insert a sibling issue block (lines at indent 0) directly below the issue at `issueId`, at the
 * same indent.
 *
 * @param {string} text
 * @param {string} issueId
 * @param {string[]} block
 * @returns {string | null}
 */
function insertSiblingAfterIssue(text, issueId, block) {
	const found = findIssueHeadingBlock(text, issueId);
	if (!found) return null;
	const prefix = '\t'.repeat(found.indent);
	const out = found.lines.slice();
	out.splice(found.end, 0, '', ...indentBlock(block, prefix), '');
	return fromLines(out);
}

/**
 * Find a heading (issue or plain) by its full title path (`A/B/C`) in note text.
 * Mirrors the path built by the heading trees (`buildHeadingTreeFromBody`): tab/space
 * indentation plus `#` level, titles joined with `/`. Header metadata carries no `#`
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
		const m = String(lines[i] || '').match(/^([\t ]*)(#{1,6})\s+(.+)$/);
		if (!m) continue;
		let tabCount = 0;
		let spaceCount = 0;
		for (const ch of m[1]) {
			if (ch === '\t') tabCount++;
			else if (ch === ' ') spaceCount++;
		}
		const indentLevel = tabCount + Math.floor(spaceCount / 4);
		const level = indentLevel + (m[2].length - 1);
		const title = m[3].trim();
		while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
		stack.push({ level, title });
		if (stack.map(s => s.title).join('/') === path) {
			const indent = (m[1] || '').length;
			const end = sectionEnd(lines, i, indent);
			return { start: i, end, indent, lines };
		}
	}
	return null;
}

/**
 * Append a block (lines at indent 0) as the last child of the heading at `headingPath`,
 * whether that heading is an issue or a plain heading. Returns null when not found.
 *
 * @param {string} text
 * @param {string} headingPath
 * @param {string[]} block
 * @returns {string | null}
 */
function appendBlockUnderHeading(text, headingPath, block) {
	const found = findHeadingSectionByPath(text, headingPath);
	if (!found) return null;
	const prefix = '\t'.repeat(found.indent + 1);
	return fromLines(insertBlock(found.lines, found.end, found.start, indentBlock(block, prefix)));
}

/**
 * Insert a block (lines at indent 0) as a sibling directly before the heading at `headingPath`,
 * at the same indent. Returns null when not found.
 *
 * @param {string} text
 * @param {string} headingPath
 * @param {string[]} block
 * @returns {string | null}
 */
function insertSiblingBeforeHeading(text, headingPath, block) {
	const found = findHeadingSectionByPath(text, headingPath);
	if (!found) return null;
	const prefix = '\t'.repeat(found.indent);
	const out = found.lines.slice();
	out.splice(found.start, 0, '', ...indentBlock(block, prefix), '');
	return fromLines(out);
}

/**
 * Insert a block (lines at indent 0) as a sibling directly after the heading at `headingPath`,
 * at the same indent. Returns null when not found.
 *
 * @param {string} text
 * @param {string} headingPath
 * @param {string[]} block
 * @returns {string | null}
 */
function insertSiblingAfterHeading(text, headingPath, block) {
	const found = findHeadingSectionByPath(text, headingPath);
	if (!found) return null;
	const prefix = '\t'.repeat(found.indent);
	const out = found.lines.slice();
	out.splice(found.end, 0, '', ...indentBlock(block, prefix), '');
	return fromLines(out);
}

module.exports = {
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
