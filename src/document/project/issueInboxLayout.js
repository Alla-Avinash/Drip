'use strict';

/**
 * Text layout for issue blocks (pure — no vscode):
 * - A heading owns every following line until the next heading at the same or a shallower
 *   level. `.d.txt` uses marker levels (`#` = 0, `#1` = 1, `#2` = 2) with tab-indented
 *   body/metadata; `.d.md` uses markdown hash levels (`#` = 1, `##` = 2) with flush-left
 *   body and a hidden `<!-- drip hN -->` comment carrying the metadata.
 * - `_issues.d.txt` keeps new issues under a plain `# _inbox` section (2 blank lines under `---`),
 *   newest last; file features use `# _inbox` the same way.
 * - Sub-issues go under their parent heading, one level deeper, as the parent's last child.
 *
 * Every function takes an optional trailing `format` argument (`'drip-md'` for `.d.md`, anything
 * else = `.d.txt`). `.d.txt` behaviour is unchanged when the argument is omitted.
 */

const { parseHeadingForValidation } = require('../parse/dripTxt/dripTxtHeadingParse.js');
const { parseMarkdownHeading } = require('../parse/dripMd/dripMdHeadingParse.js');
const {
	PROJECT_ISSUES_INBOX_HEADING_TITLE,
	normalizeIssueEntityId
} = require('./projectStructureRules');

const FORMAT_DRIP_MD = 'drip-md';
const FORMAT_DRIP_TXT = 'drip-txt';

const IDENTITY_LINE_RE = /^\s*@+\s*h\d+\s*$/i;

/**
 * True when `format` denotes a `.d.md` note (markdown headings, hidden-comment metadata).
 * @param {string} [format]
 * @returns {boolean}
 */
function isMarkdownFormat(format) {
	return format === FORMAT_DRIP_MD;
}

/**
 * Format for a file path: `.md` → markdown, otherwise `.d.txt` marker/indent rules.
 * @param {string} fsPath
 * @returns {string}
 */
function formatFromPath(fsPath) {
	return /\.md$/i.test(String(fsPath || '')) ? FORMAT_DRIP_MD : FORMAT_DRIP_TXT;
}

/**
 * Heading node for a line, per format (`null` when not a heading). `.d.txt` levels are the
 * marker number (`#` = 0); `.d.md` levels are the hash count (`#` = 1).
 * @param {string} line
 * @param {string} [format]
 * @returns {{ tabDepth: number, level: number, title: string } | null}
 */
function parseHeadingForFormat(line, format) {
	return isMarkdownFormat(format) ? parseMarkdownHeading(line) : parseHeadingForValidation(line);
}

/**
 * Heading level of a line (`#` = 0 / `#1` = 1 for `.d.txt`; `#` = 1 / `##` = 2 for `.d.md`),
 * or -1 when not a heading.
 * @param {string} line
 * @param {string} [format]
 * @returns {number}
 */
function headingLevelOf(line, format) {
	const ph = parseHeadingForFormat(line, format);
	return ph ? ph.level : -1;
}

/**
 * Leading whitespace width (tabs/spaces). `.d.txt` uses it for body/metadata de-indent;
 * `.d.md` body is flush-left so it returns 0.
 * @param {string} line
 * @param {string} [format]
 * @returns {number}
 */
function indentOf(line, format) {
	if (isMarkdownFormat(format)) return 0;
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
 * Shift a block's heading levels by `delta`, per format.
 * - `.d.txt`: shift the `#`/`#N` marker and its leading indent (one tab per level); prose lines
 *   shift by the same number of tabs (identity lines stay at column 0).
 * - `.d.md`: shift the hash count (clamped 1..6); every other line is left untouched.
 *
 * @param {string[]} lines
 * @param {number} delta
 * @param {string} [format]
 * @returns {string[]}
 */
function relevelBlock(lines, delta, format) {
	const d = Math.floor(Number(delta) || 0);
	if (d === 0) return (lines || []).slice();
	if (isMarkdownFormat(format)) {
		return (lines || []).map(line => {
			const s = String(line || '');
			const m = s.match(/^(\s*)(#{1,6})\s+(.*)$/);
			if (!m) return s;
			const newLevel = Math.max(1, Math.min(6, m[2].length + d));
			return `${m[1]}${'#'.repeat(newLevel)} ${m[3]}`;
		});
	}
	return (lines || []).map(line => {
		const s = String(line || '');
		const m = s.match(/^(\s*)#(\d*)(\s+)/);
		if (m) {
			const level = m[2] ? parseInt(m[2], 10) : 0;
			const newLevel = Math.max(0, level + d);
			const marker = newLevel === 0 ? '#' : `#${newLevel}`;
			return `${shiftWhitespace(m[1], d)}${marker}${m[3]}${s.slice(m[0].length)}`;
		}
		if (!s.trim() || IDENTITY_LINE_RE.test(s)) return s;
		return shiftWhitespace(s, d);
	});
}

/**
 * Place a root-level block at `targetLevel` in `format`. Root is level 0 in `.d.txt` and level 1
 * in `.d.md`, so the shift is `targetLevel - rootLevel`.
 * @param {string[]} lines
 * @param {number} targetLevel
 * @param {string} [format]
 * @returns {string[]}
 */
function relevelToLevel(lines, targetLevel, format) {
	const root = isMarkdownFormat(format) ? 1 : 0;
	return relevelBlock(lines, Math.floor(Number(targetLevel) || 0) - root, format);
}

/**
 * Dedent a block sitting at `level` to its format's root level.
 * @param {string[]} lines
 * @param {number} level
 * @param {string} [format]
 * @returns {string[]}
 */
function dedentToRoot(lines, level, format) {
	const root = isMarkdownFormat(format) ? 1 : 0;
	return relevelBlock(lines, -(Math.floor(Number(level) || 0) - root), format);
}

/** Add/remove leading tabs by `d` (d > 0 indents, d < 0 outdents). */
function shiftWhitespace(s, d) {
	if (d > 0) return '\t'.repeat(d) + s;
	let out = s;
	for (let t = 0; t < -d && out.startsWith('\t'); t++) out = out.slice(1);
	return out;
}

/**
 * Whether `line` closes a heading section at `level`: a heading at the same or a shallower level.
 * Prose, metadata and identity lines never close a section. The `---` file-header separator also
 * never closes one (h0 stays the root above it).
 * @param {string} line
 * @param {number} level
 * @param {string} [format]
 */
function closesSection(line, level, format) {
	const ph = parseHeadingForFormat(line, format);
	return !!ph && ph.level <= level;
}

/**
 * End (exclusive) of the section owned by the heading at `start`: the first heading at the
 * same or a shallower level. Trailing blank lines and the next heading's `@hN` identity stay
 * outside the section.
 *
 * @param {string[]} lines
 * @param {number} start heading line
 * @param {number} level level of that heading
 * @param {string} [format]
 * @returns {number}
 */
function sectionEnd(lines, start, level, format) {
	let end = lines.length;
	for (let j = start + 1; j < lines.length; j++) {
		if (closesSection(lines[j], level, format)) {
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
 * heading whose section still contains it (a heading with a strictly smaller level).
 *
 * @param {string[]} lines
 * @param {Set<number>} headingLines line indexes that can be parents / children
 * @param {string} [format]
 * @returns {Map<number, number | null>} heading line → parent heading line (null = root)
 */
function outlineParentsByLine(lines, headingLines, format) {
	/** @type {Map<number, number | null>} */
	const parents = new Map();
	/** @type {{ line: number, level: number }[]} */
	const stack = [];
	for (let i = 0; i < lines.length; i++) {
		const line = String(lines[i] || '');
		const ph = parseHeadingForFormat(line, format);
		if (!ph) continue;
		while (stack.length && stack[stack.length - 1].level >= ph.level) stack.pop();
		if (!headingLines.has(i)) continue;
		parents.set(i, stack.length ? stack[stack.length - 1].line : null);
		stack.push({ line: i, level: ph.level });
	}
	return parents;
}

/**
 * Heading block of an issue.
 * - `.d.txt`: `#1 .i-12 …`, legacy `# .i i-12 …` / `# i-12 …`.
 * - `.d.md`: `# i-12 …` / `## i-12 …` (clean heading, id in the title).
 *
 * @param {string} text
 * @param {string} issueId
 * @param {string} [format]
 * @returns {{ start: number, end: number, indent: number, lines: string[] } | null}
 */
function findIssueHeadingBlock(text, issueId, format) {
	const id = normalizeIssueEntityId(issueId);
	if (!id) return null;
	const lines = toLines(text);
	const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = isMarkdownFormat(format)
		? new RegExp(`^(\\s*)(#{1,6})\\s+${esc}\\b`, 'i')
		: new RegExp(`^(\\s*)#\\d*\\s+(?:\\.${esc}\\b|\\.i\\s+${esc}\\b|${esc}\\b)`, 'i');
	for (let i = 0; i < lines.length; i++) {
		if (!re.test(lines[i])) continue;
		const level = headingLevelOf(lines[i], format);
		return { start: i, end: sectionEnd(lines, i, level, format), indent: level, lines };
	}
	return null;
}

/**
 * @param {string[]} lines
 * @param {string} title
 * @param {string} [format]
 * @returns {number}
 */
function findInboxHeadingLine(lines, title, format) {
	const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// `.d.txt` sections sit at column 0; `.d.md` allows up to 3 leading spaces before the `#`.
	const lead = isMarkdownFormat(format) ? '\\s*' : '';
	const re = new RegExp(`^${lead}#\\s+${esc}\\s*$`, 'i');
	return lines.findIndex(l => re.test(String(l)));
}

/**
 * Ensure a top-level `# <title>` section exists: 2 blank lines under the first `---` (`.d.txt`),
 * or at the end of the file (`.d.md` has no `---` separator).
 *
 * @param {string[]} lines
 * @param {string} title
 * @param {string} [format]
 * @returns {{ lines: string[], headingLine: number }}
 */
function ensureInboxSection(lines, title, format) {
	const existing = findInboxHeadingLine(lines, title, format);
	if (existing >= 0) return { lines, headingLine: existing };
	const out = lines.slice();
	const heading = `# ${title}`;
	if (isMarkdownFormat(format)) {
		while (out.length && !String(out[out.length - 1]).trim()) out.pop();
		out.push('', '', heading);
		return { lines: out, headingLine: out.length - 1 };
	}
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
 * Append an issue block (root-level) as the last child of `# _inbox` (or another top-level
 * section), i.e. one level under it.
 *
 * @param {string} text
 * @param {string[]} block
 * @param {string} [sectionTitle]
 * @param {string} [format]
 * @returns {string}
 */
function appendIssueToInbox(text, block, sectionTitle = PROJECT_ISSUES_INBOX_HEADING_TITLE, format) {
	const ensured = ensureInboxSection(toLines(text), sectionTitle, format);
	const inboxLevel = headingLevelOf(ensured.lines[ensured.headingLine], format);
	const end = sectionEnd(ensured.lines, ensured.headingLine, inboxLevel, format);
	return fromLines(
		insertBlock(ensured.lines, end, ensured.headingLine, relevelToLevel(block, inboxLevel + 1, format))
	);
}

/**
 * Append a sub-issue block (root-level) as the last child of `parentIssueId`, one level deeper
 * than the parent. Returns null when the parent heading is not in this text.
 *
 * @param {string} text
 * @param {string} parentIssueId
 * @param {string[]} block
 * @param {string} [format]
 * @returns {string | null}
 */
function appendSubIssueUnderParent(text, parentIssueId, block, format) {
	const found = findIssueHeadingBlock(text, parentIssueId, format);
	if (!found) return null;
	return fromLines(
		insertBlock(found.lines, found.end, found.start, relevelToLevel(block, found.indent + 1, format))
	);
}

/**
 * Insert a sibling issue block (root-level) directly above the issue at `issueId`, at the same
 * level. The identity line just above the issue is kept with it.
 *
 * @param {string} text
 * @param {string} issueId
 * @param {string[]} block
 * @param {string} [format]
 * @returns {string | null}
 */
function insertSiblingBeforeIssue(text, issueId, block, format) {
	const found = findIssueHeadingBlock(text, issueId, format);
	if (!found) return null;
	const start =
		found.start > 0 && IDENTITY_LINE_RE.test(String(found.lines[found.start - 1]))
			? found.start - 1
			: found.start;
	const out = found.lines.slice();
	out.splice(start, 0, '', ...relevelToLevel(block, found.indent, format), '');
	return fromLines(out);
}

/**
 * Insert a sibling issue block (root-level) directly below the issue at `issueId`, at the same
 * level.
 *
 * @param {string} text
 * @param {string} issueId
 * @param {string[]} block
 * @param {string} [format]
 * @returns {string | null}
 */
function insertSiblingAfterIssue(text, issueId, block, format) {
	const found = findIssueHeadingBlock(text, issueId, format);
	if (!found) return null;
	const out = found.lines.slice();
	out.splice(found.end, 0, '', ...relevelToLevel(block, found.indent, format), '');
	return fromLines(out);
}

/**
 * Find a heading (issue or plain) by its full title path (`A/B/C`) in note text.
 * Paths are built from heading levels (like the heading trees); header metadata carries no
 * headings, so scanning the full text yields the same paths as the body-only tree.
 *
 * @param {string} text
 * @param {string} headingPath
 * @param {string} [format]
 * @returns {{ start: number, end: number, indent: number, lines: string[] } | null}
 */
function findHeadingSectionByPath(text, headingPath, format) {
	const path = String(headingPath || '').trim();
	if (!path) return null;
	const lines = toLines(text);
	const stack = [];
	for (let i = 0; i < lines.length; i++) {
		const ph = parseHeadingForFormat(lines[i], format);
		if (!ph) continue;
		while (stack.length && stack[stack.length - 1].level >= ph.level) stack.pop();
		stack.push({ level: ph.level, title: ph.title });
		if (stack.map(s => s.title).join('/') === path) {
			return { start: i, end: sectionEnd(lines, i, ph.level, format), indent: ph.level, lines };
		}
	}
	return null;
}

/**
 * Append a block (root-level) as the last child of the heading at `headingPath`, one level
 * deeper. Returns null when not found.
 *
 * @param {string} text
 * @param {string} headingPath
 * @param {string[]} block
 * @param {string} [format]
 * @returns {string | null}
 */
function appendBlockUnderHeading(text, headingPath, block, format) {
	const found = findHeadingSectionByPath(text, headingPath, format);
	if (!found) return null;
	return fromLines(
		insertBlock(found.lines, found.end, found.start, relevelToLevel(block, found.indent + 1, format))
	);
}

/**
 * Insert a block (root-level) as a sibling directly before the heading at `headingPath`, at the
 * same level. Returns null when not found.
 *
 * @param {string} text
 * @param {string} headingPath
 * @param {string[]} block
 * @param {string} [format]
 * @returns {string | null}
 */
function insertSiblingBeforeHeading(text, headingPath, block, format) {
	const found = findHeadingSectionByPath(text, headingPath, format);
	if (!found) return null;
	const out = found.lines.slice();
	out.splice(found.start, 0, '', ...relevelToLevel(block, found.indent, format), '');
	return fromLines(out);
}

/**
 * Insert a block (root-level) as a sibling directly after the heading at `headingPath`, at the
 * same level. Returns null when not found.
 *
 * @param {string} text
 * @param {string} headingPath
 * @param {string[]} block
 * @param {string} [format]
 * @returns {string | null}
 */
function insertSiblingAfterHeading(text, headingPath, block, format) {
	const found = findHeadingSectionByPath(text, headingPath, format);
	if (!found) return null;
	const out = found.lines.slice();
	out.splice(found.end, 0, '', ...relevelToLevel(block, found.indent, format), '');
	return fromLines(out);
}

module.exports = {
	FORMAT_DRIP_MD,
	FORMAT_DRIP_TXT,
	isMarkdownFormat,
	formatFromPath,
	parseHeadingForFormat,
	headingLevelOf,
	indentOf,
	relevelBlock,
	relevelToLevel,
	dedentToRoot,
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
