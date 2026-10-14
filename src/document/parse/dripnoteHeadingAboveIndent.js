'use strict';

/**
 * Heading outline depth checks (Problems panel only).
 *
 * With the `#` / `#1` / `#2` marker format, heading depth is the marker number, so there is
 * no indentation-based hierarchy to validate. The one check that still applies is: consecutive
 * headings may only deepen by one level at a time (`#1` → `#2` is fine, `#1` → `#3` is not).
 * Jumping back to a shallower heading may skip any number of levels.
 *
 * Depends on `parseHeadingForValidation` from `dripnoteHeadingParse`.
 */

const { parseHeadingForValidation } = require('./dripnoteHeadingParse');

/**
 * Successive headings by line order: depth may drop by any amount; if it rises, only +1 per step.
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
					'This heading is more than one level deeper than the previous heading; add one heading level at a time (`#1` → `#2`). Jumping back to a shallower heading can skip any number of levels.'
			});
		}
	}
	return out;
}

/**
 * Kept for call-site compatibility — returns the marker-depth jump errors (the only
 * heading-depth diagnostic left in the `#`/`#1`/`#2` format).
 * @param {string[]} lines
 * @returns {{ lineIndex: number, message: string }[]}
 */
function collectHeadingVersusAboveLineIndentErrors(lines) {
	return collectConsecutiveHeadingDepthJumpErrors(lines);
}

module.exports = {
	collectHeadingVersusAboveLineIndentErrors,
	collectConsecutiveHeadingDepthJumpErrors
};
