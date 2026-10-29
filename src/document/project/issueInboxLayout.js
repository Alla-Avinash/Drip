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
	normalizeIssueEntityId,
	parseIssueTitleEntityId
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
 *   shift by the same number of tabs (identity lines move with the heading).
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
		if (!s.trim()) return s;
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
	const chunk = [''];
	chunk.push(...block);
	if (at < lines.length && String(lines[at]).trim()) chunk.push('');
	return [...lines.slice(0, at), ...chunk, ...lines.slice(at)];
}

/**
 * Hidden uid from an issue block (`uid: …` metadata or a markdown comment field).
 * @param {string[]} blockLines
 * @returns {string}
 */
function uidFromIssueBlock(blockLines) {
	for (const line of blockLines || []) {
		const m = String(line || '').match(/(?:^|\|\s*)uid\s*:\s*(\S+)/i);
		if (m && String(m[1] || '').trim()) return String(m[1]).trim();
	}
	return '';
}

/**
 * Put `# _inbox` children in hidden-uid order so every peer reprints the same file.
 * Nested children stay under their parent. Other sections are left in place.
 *
 * @param {string} text
 * @param {string} [sectionTitle]
 * @param {string} [format]
 * @returns {string}
 */
function sortInboxChildrenByUid(text, sectionTitle = PROJECT_ISSUES_INBOX_HEADING_TITLE, format) {
	const ensured = ensureInboxSection(toLines(text), sectionTitle, format);
	const inboxLine = ensured.headingLine;
	const inboxLevel = headingLevelOf(ensured.lines[inboxLine], format);
	if (inboxLevel < 0) return fromLines(ensured.lines);
	const childLevel = inboxLevel + 1;
	const end = sectionEnd(ensured.lines, inboxLine, inboxLevel, format);

	/** @type {{ uid: string, block: string[] }[]} */
	const children = [];
	let prefixEnd = inboxLine + 1;
	let i = inboxLine + 1;
	let sawChild = false;
	while (i < end) {
		const ph = parseHeadingForFormat(ensured.lines[i], format);
		if (ph && ph.level === childLevel) {
			const start =
				i > 0 && IDENTITY_LINE_RE.test(String(ensured.lines[i - 1])) ? i - 1 : i;
			if (!sawChild) {
				prefixEnd = start;
				sawChild = true;
			}
			const blockEnd = sectionEnd(ensured.lines, i, ph.level, format);
			const block = ensured.lines.slice(start, blockEnd);
			while (block.length && !String(block[block.length - 1]).trim()) block.pop();
			children.push({ uid: uidFromIssueBlock(block), block });
			i = blockEnd;
			continue;
		}
		i += 1;
	}

	if (children.length < 2) return fromLines(ensured.lines);

	children.sort((a, b) => {
		if (!a.uid && !b.uid) return 0;
		if (!a.uid) return 1;
		if (!b.uid) return -1;
		return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
	});

	const prefix = ensured.lines.slice(inboxLine + 1, prefixEnd);
	while (prefix.length && !String(prefix[prefix.length - 1]).trim()) prefix.pop();

	const middle = [];
	for (const child of children) {
		if (middle.length) middle.push('');
		middle.push(...child.block);
	}

	const next = [
		...ensured.lines.slice(0, inboxLine + 1),
		...prefix,
		...(prefix.length && middle.length ? [''] : []),
		...middle,
		...ensured.lines.slice(end)
	];
	return fromLines(next);
}

function headingBlockStart(lines, headingLine) {
	return headingLine > 0 && IDENTITY_LINE_RE.test(String(lines[headingLine - 1]))
		? headingLine - 1
		: headingLine;
}

function trimHeadingBlock(block) {
	const out = (block || []).map(l => String(l));
	while (out.length && !String(out[out.length - 1]).trim()) out.pop();
	while (out.length && !String(out[0]).trim()) out.shift();
	return out;
}

/**
 * Direct children of a heading, plus a stable order so headings without a uid keep
 * their relative place. Persistent and non-persistent use the same rule.
 * @param {string[]} lines
 * @param {number} parentHeadingLine
 * @param {number} parentLevel
 * @param {number} parentEnd
 * @param {string} [format]
 */
function collectChildHeadingBlocks(lines, parentHeadingLine, parentLevel, parentEnd, format) {
	/** @type {{ start: number, end: number, uid: string, order: number }[]} */
	const children = [];
	let i = parentHeadingLine + 1;
	while (i < parentEnd) {
		const ph = parseHeadingForFormat(lines[i], format);
		if (ph && ph.level === parentLevel + 1) {
			const start = headingBlockStart(lines, i);
			const end = sectionEnd(lines, i, ph.level, format);
			children.push({
				start,
				end,
				uid: uidFromIssueBlock(lines.slice(start, end)),
				order: children.length
			});
			i = end;
			continue;
		}
		i += 1;
	}
	return children;
}

function compareSiblingHeadings(a, b) {
	if (a.uid && b.uid) return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : a.order - b.order;
	if (a.uid && !b.uid) return -1;
	if (!a.uid && b.uid) return 1;
	return a.order - b.order;
}

function blockStartsWithH0(blockLines) {
	for (const line of blockLines || []) {
		const raw = String(line || '');
		if (!raw.trim()) continue;
		if (IDENTITY_LINE_RE.test(raw)) return /@h0\s*$/i.test(raw.trim());
		return false;
	}
	return false;
}

function compareRootHeadings(a, b) {
	const a0 = blockStartsWithH0(a.block);
	const b0 = blockStartsWithH0(b.block);
	if (a0 && !b0) return -1;
	if (!a0 && b0) return 1;
	return compareSiblingHeadings(a, b);
}

/**
 * One heading block: keep its own lines, then reprint children in uid order
 * with exactly one blank line between headings.
 * @param {string[]} blockLines
 * @param {string} [format]
 * @returns {string[]}
 */
function rewriteHeadingBlock(blockLines, format) {
	const lines = (blockLines || []).map(l => String(l));
	let headingLine = 0;
	if (lines.length && IDENTITY_LINE_RE.test(String(lines[0]))) headingLine = 1;
	const level = headingLevelOf(lines[headingLine], format);
	if (level < 0) return trimHeadingBlock(lines);
	const children = collectChildHeadingBlocks(lines, headingLine, level, lines.length, format);
	const headEnd = children.length ? children[0].start : lines.length;
	const head = trimHeadingBlock(lines.slice(0, headEnd));
	if (!children.length) return head;
	const childOut = [];
	const sorted = children
		.map((c, order) => ({
			...c,
			order,
			block: rewriteHeadingBlock(lines.slice(c.start, c.end), format)
		}))
		.sort(compareSiblingHeadings);
	for (const child of sorted) {
		if (childOut.length) childOut.push('');
		childOut.push(...child.block);
	}
	return [...head, '', ...childOut];
}

/**
 * Same reprint rule for every heading in the note: uid order (empty uid keeps
 * file order), one blank line between headings. Does not move a heading to
 * another file.
 * @param {string} text
 * @param {string} [format]
 * @returns {string}
 */
function headingHasIssueBody(blockLines) {
	return (blockLines || []).some(l => /^\s*\.issue\b/i.test(String(l)) || /(?:^|\|\s*)uid\s*:/i.test(String(l)));
}

/**
 * Feature-note repair: issues stay siblings of the file heading (`# .i-N`), not
 * nested `#1` children. An empty heading that only exists because a path crumb
 * reused an issue title is dropped and its children become siblings.
 * @param {string} text
 * @param {string} [format]
 */
function repairIssueOutline(text, format) {
	if (isMarkdownFormat(format)) return String(text || '');
	let lines = toLines(text);
	const fileH = fileHeadingLineIndex(lines, format);
	if (fileH >= 0) {
		const fileLevel = headingLevelOf(lines[fileH], format);
		const fileEnd = sectionEnd(lines, fileH, fileLevel, format);
		const children = collectChildHeadingBlocks(lines, fileH, fileLevel, fileEnd, format);
		const promote = [];
		for (const ch of children) {
			let h = ch.start;
			if (h < ch.end && IDENTITY_LINE_RE.test(String(lines[h]))) h += 1;
			const ph = parseHeadingForFormat(lines[h], format);
			if (ph && parseIssueTitleEntityId(ph.title)) promote.push(ch);
		}
		if (promote.length) {
			const fileOwnEnd = children.length ? children[0].start : fileEnd;
			const keptKids = [];
			const chunks = [];
			for (const ch of children) {
				let h = ch.start;
				if (h < ch.end && IDENTITY_LINE_RE.test(String(lines[h]))) h += 1;
				const ph = parseHeadingForFormat(lines[h], format);
				if (ph && parseIssueTitleEntityId(ph.title)) {
					chunks.push(dedentToRoot(lines.slice(ch.start, ch.end), fileLevel + 1, format));
				} else {
					if (keptKids.length) keptKids.push('');
					keptKids.push(...lines.slice(ch.start, ch.end));
				}
			}
			const head = trimHeadingBlock(lines.slice(headingBlockStart(lines, fileH), fileOwnEnd));
			const after = lines.slice(fileEnd);
			const mid = [];
			for (const chunk of chunks) {
				if (mid.length) mid.push('');
				mid.push(...chunk);
			}
			lines = [
				...lines.slice(0, headingBlockStart(lines, fileH)),
				...head,
				...(keptKids.length ? ['', ...keptKids] : []),
				...(mid.length ? ['', ...mid] : []),
				...after
			];
		}
	}
	const next = [];
	let i = 0;
	while (i < lines.length) {
		const ph = parseHeadingForFormat(lines[i], format);
		if (!ph || !isIssueLikeHeadingTitle(ph.title)) {
			next.push(lines[i]);
			i += 1;
			continue;
		}
		const start = headingBlockStart(lines, i);
		const end = sectionEnd(lines, i, ph.level, format);
		const block = lines.slice(start, end);
		if (headingHasIssueBody(block)) {
			if (start < i) next.push(...lines.slice(start, i));
			next.push(lines[i]);
			i += 1;
			continue;
		}
		const kids = collectChildHeadingBlocks(lines, i, ph.level, end, format);
		if (!kids.length) {
			i = end;
			continue;
		}
		for (const kid of kids) {
			if (next.length && String(next[next.length - 1] || '').trim()) next.push('');
			next.push(...dedentToRoot(lines.slice(kid.start, kid.end), ph.level + 1, format));
		}
		i = end;
	}
	return fromLines(next);
}

function normalizeHeadingLayout(text, format) {
	const lines = toLines(repairIssueOutline(text, format));
	const sep = lines.findIndex(l => /^---\s*$/.test(String(l)));
	const header = sep >= 0 ? lines.slice(0, sep + 1) : [];
	const body = sep >= 0 ? lines.slice(sep + 1) : lines.slice();
	while (body.length && !String(body[0]).trim()) body.shift();

	const rootLevel = isMarkdownFormat(format) ? 1 : 0;
	/** @type {{ start: number, end: number, uid: string, order: number }[]} */
	const roots = [];
	let i = 0;
	while (i < body.length) {
		const ph = parseHeadingForFormat(body[i], format);
		if (ph && ph.level === rootLevel) {
			const start = headingBlockStart(body, i);
			const end = sectionEnd(body, i, ph.level, format);
			roots.push({
				start,
				end,
				uid: uidFromIssueBlock(body.slice(start, end)),
				order: roots.length
			});
			i = end;
			continue;
		}
		i += 1;
	}
	if (!roots.length) {
		return fromLines(sep >= 0 ? header.concat([''], body) : lines);
	}

	const prefix = trimHeadingBlock(body.slice(0, roots[0].start));
	const rootOut = [];
	const sorted = roots
		.map((c, order) => ({
			...c,
			order,
			block: rewriteHeadingBlock(body.slice(c.start, c.end), format)
		}))
		.sort(compareRootHeadings);
	for (const root of sorted) {
		if (rootOut.length) rootOut.push('');
		rootOut.push(...root.block);
	}
	const next =
		sep >= 0
			? [...header, '', ...(prefix.length ? [...prefix, ''] : []), ...rootOut]
			: [...(prefix.length ? [...prefix, ''] : []), ...rootOut];
	return fromLines(next);
}

/**
 * Keep each `@hN` on the line immediately above its heading, at the same indent.
 * Drop identity lines that have no heading under them (they are leftovers from a move
 * or a reprint, and they break the next reprint).
 * @param {string} text
 * @param {string} [format]
 * @returns {string}
 */
function glueHeadingIdentities(text, format) {
	if (isMarkdownFormat(format)) return String(text || '');
	const lines = toLines(text);
	const out = [];
	let i = 0;
	while (i < lines.length) {
		const line = String(lines[i] || '');
		if (!IDENTITY_LINE_RE.test(line)) {
			out.push(line);
			i += 1;
			continue;
		}
		let ident = line;
		i += 1;
		while (i < lines.length && IDENTITY_LINE_RE.test(String(lines[i] || ''))) {
			ident = String(lines[i] || '');
			i += 1;
		}
		while (i < lines.length && !String(lines[i] || '').trim()) i += 1;
		const next = i < lines.length ? String(lines[i] || '') : '';
		if (parseHeadingForFormat(next, format)) {
			const indent = (next.match(/^(\s*)/) || ['', ''])[1];
			out.push(`${indent}${ident.trim()}`);
			out.push(next);
			i += 1;
			continue;
		}
	}
	return fromLines(out);
}

/**
 * Append an issue block (root-level) as the last child of `# _inbox` (or another top-level)
 * section), i.e. one level under it.
 *
 * @param {string} text
 * @param {string[]} block
 * @param {string} [sectionTitle]
 * @param {string} [format]
 * @returns {string}
 */
/**
 * Append a root-level issue after the last root heading. Used in a feature note
 * so the issue stays a sibling of the file heading, not a nested `#1` child.
 * @param {string} text
 * @param {string[]} block
 * @param {string} [format]
 */
function appendIssueAtFileRoot(text, block, format) {
	const lines = toLines(text);
	const root = isMarkdownFormat(format) ? 1 : 0;
	let insertAt = lines.length;
	for (let i = 0; i < lines.length; i++) {
		const ph = parseHeadingForFormat(lines[i], format);
		if (ph && ph.level === root) insertAt = sectionEnd(lines, i, ph.level, format);
	}
	return fromLines(insertBlock(lines, insertAt, insertAt, relevelToLevel(block, root, format)));
}

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
function formatPlainHeadingLine(title, level, format) {
	const t = String(title || '').trim() || 'Section';
	if (isMarkdownFormat(format)) {
		const n = Math.max(1, Math.min(6, Math.floor(Number(level) || 1)));
		return `${'#'.repeat(n)} ${t}`;
	}
	const depth = Math.max(0, Math.floor(Number(level) || 0));
	const marker = depth === 0 ? '#' : `#${depth}`;
	return `${'\t'.repeat(depth)}${marker} ${t}`;
}

/**
 * Title path of the section this issue sits under (`Notes/This week`). Empty when it
 * is a root heading. Persistent and plain headings both count — the path is titles only.
 * @param {string} text
 * @param {string} issueId
 * @param {string} [format]
 */
function fileHeadingLineIndex(lines, format) {
	const sep = (lines || []).findIndex(l => /^---\s*$/.test(String(l)));
	const from = sep >= 0 ? sep + 1 : 0;
	for (let i = from; i < (lines || []).length; i++) {
		if (parseHeadingForFormat(lines[i], format)) return i;
	}
	return -1;
}

function isIssueLikeHeadingTitle(title) {
	const t = String(title || '').trim();
	if (!t) return false;
	if (parseIssueTitleEntityId(t)) return true;
	return /^\.?i-\d+\b/i.test(t);
}

/**
 * `@hN` on the line above this issue, or 0 when it has none.
 * @param {string} text
 * @param {string} issueId
 * @param {string} [format]
 */
function headingNumForIssue(text, issueId, format) {
	const found = findIssueHeadingBlock(text, issueId, format);
	if (!found || found.start <= 0) return 0;
	const raw = String(found.lines[found.start - 1] || '');
	const m = IDENTITY_LINE_RE.test(raw) ? raw.match(/@h(\d+)/i) : null;
	const n = m ? parseInt(m[1], 10) : 0;
	return Number.isFinite(n) && n > 0 ? n : 0;
}

function headingPathAboveIssue(text, issueId, format) {
	const found = findIssueHeadingBlock(text, issueId, format);
	if (!found) return '';
	const fileH = fileHeadingLineIndex(found.lines, format);
	const stack = [];
	for (let i = 0; i < found.start; i++) {
		if (i === fileH) continue;
		const ph = parseHeadingForFormat(found.lines[i], format);
		if (!ph) continue;
		while (stack.length && stack[stack.length - 1].level >= ph.level) stack.pop();
		stack.push({ level: ph.level, title: ph.title });
	}
	while (stack.length && stack[stack.length - 1].level >= found.indent) stack.pop();
	return stack.map(s => s.title).filter(Boolean).join('/');
}

/**
 * Make every crumb of `headingPath` exist as a heading (create missing ones as plain
 * sections). Used so a typed-under-this-section create can land on a machine that
 * does not have that section — or that file — yet.
 * @param {string} text
 * @param {string} headingPath
 * @param {string} [format]
 */
function ensureHeadingPath(text, headingPath, format) {
	const crumbs = String(headingPath || '')
		.split('/')
		.map(s => s.trim())
		.filter(Boolean)
		.filter(c => !isIssueLikeHeadingTitle(c));
	if (!crumbs.length) return String(text || '');
	const fileH = fileHeadingLineIndex(toLines(text), format);
	if (fileH >= 0) {
		const fileTitle = (parseHeadingForFormat(toLines(text)[fileH], format) || {}).title || '';
		if (fileTitle && crumbs[0] && String(crumbs[0]).trim() === String(fileTitle).trim()) {
			crumbs.shift();
		}
	}
	if (!crumbs.length) return String(text || '');
	let next = String(text || '');
	for (let i = 0; i < crumbs.length; i++) {
		const prefix = crumbs.slice(0, i + 1).join('/');
		if (findHeadingSectionByPath(next, prefix, format)) continue;
		const title = crumbs[i];
		if (i === 0) {
			const lines = toLines(next);
			const root = isMarkdownFormat(format) ? 1 : 0;
			lines.push('', formatPlainHeadingLine(title, root, format), '');
			next = fromLines(lines);
			continue;
		}
		const parent = crumbs.slice(0, i).join('/');
		const parentFound = findHeadingSectionByPath(next, parent, format);
		if (!parentFound) continue;
		next = fromLines(
			insertBlock(
				parentFound.lines,
				parentFound.end,
				parentFound.start,
				[formatPlainHeadingLine(title, parentFound.indent + 1, format)]
			)
		);
	}
	return next;
}

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
function headingOwnBodyRange(found, format) {
	let bodyStart = found.start + 1;
	if (isMarkdownFormat(format)) {
		if (bodyStart < found.end && /<!--\s*drip\b/i.test(String(found.lines[bodyStart] || ''))) {
			bodyStart += 1;
		}
	} else {
		let j = bodyStart;
		while (j < found.end) {
			const raw = String(found.lines[j] || '');
			const tr = raw.trim();
			if (IDENTITY_LINE_RE.test(raw)) {
				j += 1;
				bodyStart = j;
				continue;
			}
			if (!tr) break;
			if (parseHeadingForFormat(raw, format)) break;
			if (tr.startsWith('//') || /^\[/.test(tr) || /^\.[a-z][\w-]*\b/i.test(tr) || /^[a-z][a-z0-9_-]*\s*:/i.test(tr)) {
				j += 1;
				bodyStart = j;
				continue;
			}
			break;
		}
		bodyStart = j;
	}
	let bodyEnd = found.end;
	for (let j = bodyStart; j < found.end; j++) {
		const ph = parseHeadingForFormat(found.lines[j], format);
		if (ph && ph.level > found.indent) {
			bodyEnd = j;
			break;
		}
	}
	while (bodyEnd > bodyStart && !String(found.lines[bodyEnd - 1] || '').trim()) bodyEnd -= 1;
	return { bodyStart, bodyEnd };
}

/**
 * Own prose under a heading (not child headings, not issues). Used for sync.
 * @param {string} text
 * @param {string} headingPath
 * @param {string} [format]
 */
function readHeadingOwnBody(text, headingPath, format) {
	const found = findHeadingSectionByPath(text, headingPath, format);
	if (!found) return '';
	const { bodyStart, bodyEnd } = headingOwnBodyRange(found, format);
	const pad = isMarkdownFormat(format) ? 0 : found.indent + 1;
	const lines = [];
	for (let j = bodyStart; j < bodyEnd; j++) {
		const raw = String(found.lines[j] || '');
		if (IDENTITY_LINE_RE.test(raw)) continue;
		lines.push(isMarkdownFormat(format) ? raw : raw.slice(Math.min(pad, indentOf(raw, format))));
	}
	return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

/**
 * Replace a heading's own prose. Child headings stay.
 * @param {string} text
 * @param {string} headingPath
 * @param {string} body
 * @param {string} [format]
 */
function replaceHeadingOwnBody(text, headingPath, body, format) {
	const found = findHeadingSectionByPath(text, headingPath, format);
	if (!found) return null;
	const { bodyStart, bodyEnd } = headingOwnBodyRange(found, format);
	const raw = String(body || '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
	const bodyLines = raw ? raw.split('\n') : [];
	const headInd = isMarkdownFormat(format) ? '' : '\t'.repeat(found.indent + 1);
	const chunk = bodyLines.length
		? ['', ...bodyLines.map(l => (l.trim() && headInd ? `${headInd}${l}` : l)), '']
		: [''];
	const lines = found.lines.slice();
	lines.splice(bodyStart, Math.max(0, bodyEnd - bodyStart), ...chunk);
	return fromLines(lines);
}

/**
 * Drop a heading and its own prose. Child headings stay in the file.
 * @param {string} text
 * @param {string} headingPath
 * @param {string} [format]
 */
function removeHeadingKeepChildren(text, headingPath, format) {
	const found = findHeadingSectionByPath(text, headingPath, format);
	if (!found) return null;
	const { bodyEnd } = headingOwnBodyRange(found, format);
	let start = found.start;
	if (start > 0 && IDENTITY_LINE_RE.test(String(found.lines[start - 1]))) start -= 1;
	const lines = found.lines.slice();
	lines.splice(start, Math.max(0, bodyEnd - start));
	return fromLines(lines);
}

/**
 * Non-issue headings in a note (plain and persistent) with their own body.
 * @param {string} text
 * @param {string} [format]
 * @returns {{ path: string, title: string, persistent: boolean, body: string }[]}
 */
function listSectionHeadings(text, format) {
	const lines = toLines(text);
	const fileH = fileHeadingLineIndex(lines, format);
	const stack = [];
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const ph = parseHeadingForFormat(lines[i], format);
		if (!ph) continue;
		if (i === fileH) continue;
		while (stack.length && stack[stack.length - 1].level >= ph.level) stack.pop();
		stack.push({ level: ph.level, title: ph.title });
		if (parseIssueTitleEntityId(ph.title)) continue;
		const path = stack.map(s => s.title).filter(Boolean).join('/');
		if (!path) continue;
		out.push({
			path,
			title: ph.title,
			persistent: /^\s*\./.test(ph.title),
			body: readHeadingOwnBody(fromLines(lines), path, format)
		});
	}
	return out;
}

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
	findInboxHeadingLine,
	uidFromIssueBlock,
	sortInboxChildrenByUid,
	normalizeHeadingLayout,
	glueHeadingIdentities,
	appendIssueAtFileRoot,
	appendIssueToInbox,
	headingNumForIssue,
	isIssueLikeHeadingTitle,
	appendSubIssueUnderParent,
	insertSiblingBeforeIssue,
	insertSiblingAfterIssue,
	headingPathAboveIssue,
	ensureHeadingPath,
	findHeadingSectionByPath,
	appendBlockUnderHeading,
	insertSiblingBeforeHeading,
	insertSiblingAfterHeading,
	listSectionHeadings,
	readHeadingOwnBody,
	replaceHeadingOwnBody,
	removeHeadingKeepChildren
};
