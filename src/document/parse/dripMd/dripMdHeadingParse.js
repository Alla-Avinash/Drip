'use strict';

// `.d.md` heading parsing — markdown `#`…`######` depth detection. The `.d.md`
// counterpart to the `.d.txt` `#`/`#N` marker parser in dripTxtHeadingParse.js.

/**
 * Markdown heading detection for `.d.md` notes (`#`…`######`). `.d.md` keeps standard
 * markdown headings, so its depth comes from the `#` count plus leading whitespace — the
 * opposite of `.d.txt`'s `#`/`#1`/`#2` markers. Used only by the `.d.md` side.
 * @param {string} line
 * @returns {{ tabDepth: number, level: number, title: string, usesNonTabIndent: boolean } | null}
 */
function parseMarkdownHeading(line) {
	const m = String(line || '').match(/^(\s*)(#{1,6})\s+(.*)$/);
	if (!m) return null;
	const ind = m[1] || '';
	if (ind.length > 0 && /[^\t\s]/.test(ind)) return null;
	const usesNonTabIndent = ind.length > 0 && !/^\t+$/.test(ind);
	return {
		tabDepth: ind.length,
		level: m[2].length,
		title: String(m[3] || '').trim(),
		usesNonTabIndent
	};
}

module.exports = {
	parseMarkdownHeading
};
