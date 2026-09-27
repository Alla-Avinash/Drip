'use strict';

/**
 * Text layout for placing issue blocks (pure — no vscode):
 * - `_issues.d.txt` keeps new issues under a plain `# recents` section (2 blank lines under `---`),
 *   newest last.
 * - Sub-issues go under their parent heading, one tab deeper, as the parent's last child.
 */

const {
	PROJECT_ISSUES_RECENTS_HEADING_TITLE,
	normalizeIssueEntityId
} = require('./projectStructureRules');

const HEADING_LINE_RE = /^(\s*)#{1,6}\s+\S/;
const IDENTITY_LINE_RE = /^\s*@+\s*f\d+\s*:\s*h\d+\b/i;

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
 * End (exclusive) of the section owned by the heading at `start`: stops before the next heading
 * at same-or-shallower indent, and never swallows that heading's identity line or the blank gap.
 *
 * @param {string[]} lines
 * @param {number} start heading line
 * @param {number} indent tab count of that heading
 * @returns {number}
 */
function sectionEnd(lines, start, indent) {
	let end = lines.length;
	for (let j = start + 1; j < lines.length; j++) {
		const hm = String(lines[j]).match(HEADING_LINE_RE);
		if (hm && (hm[1] || '').length <= indent) {
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
 * @returns {number}
 */
function findRecentsHeadingLine(lines) {
	const esc = PROJECT_ISSUES_RECENTS_HEADING_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(`^#\\s+${esc}\\s*$`, 'i');
	return lines.findIndex(l => re.test(String(l)));
}

/**
 * Ensure the `# recents` section exists: 2 blank lines under the first `---`, or at the end.
 *
 * @param {string[]} lines
 * @returns {{ lines: string[], headingLine: number }}
 */
function ensureRecentsSection(lines) {
	const existing = findRecentsHeadingLine(lines);
	if (existing >= 0) return { lines, headingLine: existing };
	const out = lines.slice();
	const heading = `# ${PROJECT_ISSUES_RECENTS_HEADING_TITLE}`;
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
 * Append an issue block (lines at indent 0) as the last child of `# recents`.
 *
 * @param {string} text
 * @param {string[]} block
 * @returns {string}
 */
function appendIssueToRecents(text, block) {
	const ensured = ensureRecentsSection(toLines(text));
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

module.exports = {
	findIssueHeadingBlock,
	appendIssueToRecents,
	appendSubIssueUnderParent
};
