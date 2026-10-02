'use strict';

/**
 * Heading outline indent (Problems panel only).
 *
 * (1) **Non-heading line above:** walk upward (skip blanks/`---`). If the first non-empty line R is
 * not a heading and is **strictly shallower** than this heading’s indent before `#`, report (body too
 * flat for this nested heading). If R is a heading, skip — no check here.
 *
 * (2) **Consecutive headings in file order:** if the next heading is **deeper** than the previous,
 * the increase must be **at most one** indent step. Decreasing (jumping back to a shallower heading)
 * may be by any amount.
 *
 * Depends on `parseHeadingForValidation` from `dripnoteCanvasParse`.
 */

const { parseHeadingForValidation } = require('./dripnoteCanvasParse');

/** Same leading-whitespace width as heading tabDepth (tabs, spaces, NBSP… per parseHeadingForValidation). */
function leadingWhitespaceIndentWidth(line) {
	const m = String(line || '').match(/^(\s*)/);
	if (!m) return 0;
	const ind = m[1] || '';
	if (ind.length > 0 && /[^\t\s]/.test(ind)) return 0;
	return ind.length;
}

/**
 * First non-empty line strictly above `headingLineIndex`, scanning up to line `minLine` (use 0 for whole file).
 * Blank lines, standalone `---`, and heading identity lines (`@fN:hM`, incl. in-progress `@…` slots) are
 * skipped — everything else (metadata, headings, tabbed text) counts as the reference line. Identity lines
 * are structural companions of the heading, not content, so they must not gate its indent.
 * @returns {number} line index or -1
 */
function findFirstNonEmptyLineAbove(lines, headingLineIndex, minLine) {
	let j = headingLineIndex - 1;
	while (j >= minLine) {
		const t = String(lines[j] || '').trim();
		if (!t || t === '---') {
			j--;
			continue;
		}
		if (/^@+/.test(t)) {
			j--;
			continue;
		}
		return j;
	}
	return -1;
}

/**
 * @param {string[]} lines
 * @returns {{ lineIndex: number, message: string }[]}
 */
function collectHeadingVersusAboveLineIndentErrors(lines) {
	/** @type {{ lineIndex: number, message: string }[]} */
	const out = [];

	for (let i = 0; i < lines.length; i++) {
		const ph = parseHeadingForValidation(lines[i]);
		if (!ph) continue;

		const refIdx = findFirstNonEmptyLineAbove(lines, i, 0);
		if (refIdx < 0) continue;

		const refRaw = lines[refIdx];
		if (parseHeadingForValidation(refRaw)) continue;

		const aboveIndent = leadingWhitespaceIndentWidth(refRaw);
		if (aboveIndent < ph.tabDepth) {
			out.push({
				lineIndex: i,
				message:
					'This heading is indented deeper than the non-heading line above it. Indent that line, or reduce indent before # here.'
			});
		}
	}

	for (const e of collectConsecutiveHeadingDepthJumpErrors(lines)) {
		out.push(e);
	}

	out.sort((a, b) => a.lineIndex - b.lineIndex);
	return out;
}

/**
 * Successive `#` headings by line order: depth may drop by any amount; if it rises, only +1 per step.
 * @param {string[]} lines
 * @returns {{ lineIndex: number, message: string }[]}
 */
function collectConsecutiveHeadingDepthJumpErrors(lines) {
	/** @type {number[]} */
	const idxs = [];
	for (let i = 0; i < lines.length; i++) {
		if (parseHeadingForValidation(lines[i])) idxs.push(i);
	}
	/** @type {{ lineIndex: number, message: string }[]} */
	const out = [];
	for (let k = 0; k + 1 < idxs.length; k++) {
		const phPrev = parseHeadingForValidation(lines[idxs[k]]);
		const phNext = parseHeadingForValidation(lines[idxs[k + 1]]);
		if (!phPrev || !phNext) continue;
		if (phNext.tabDepth > phPrev.tabDepth && phNext.tabDepth - phPrev.tabDepth > 1) {
			out.push({
				lineIndex: idxs[k + 1],
				message:
					'This heading is more than one indent level deeper than the previous heading; add one tab (or one step of spaces) at a time between consecutive headings. Jumping back to a shallower heading can skip any number of levels.'
			});
		}
	}
	return out;
}

module.exports = {
	collectHeadingVersusAboveLineIndentErrors,
	collectConsecutiveHeadingDepthJumpErrors,
	findFirstNonEmptyLineAbove,
	leadingWhitespaceIndentWidth
};
