'use strict';

/**
 * @typedef {{ tabDepth: number, level: number, title: string, lineIndex: number, metaLines: string[], valid?: boolean }} HeadingNodeFlat
 * @typedef {{ tabDepth: number, level: number, title: string, lineIndex: number, metaLines: string[], children: HeadingNode[] }} HeadingNode
 */

/**
 * Split file into the top region (file keys only: `filename` / `fileid` / `headings`) and the
 * body after `---`. When `---` is present, everything before it is top; the h0 heading lives
 * below `---`. Legacy notes without `---` fall back to metadata-only lines before the first `#`.
 * @param {string[]} lines
 * @returns {{ topEnd: number, fileSlice: string[] }}
 */
function splitFileTopRegion(lines) {
	let topEnd = lines.length;
	let sawSeparator = false;
	for (let i = 0; i < lines.length; i++) {
		const t = String(lines[i] || '').trim();
		if (t === '---') {
			topEnd = i;
			sawSeparator = true;
			break;
		}
	}
	if (!sawSeparator) {
		for (let i = 0; i < lines.length; i++) {
			if (parseHeadingForValidation(lines[i])) {
				topEnd = i;
				break;
			}
		}
	}
	return { topEnd, fileSlice: lines.slice(0, topEnd) };
}

/**
 * Heading detection for hierarchy validation and diagnostics. A heading is a `#` (root/h0)
 * or `#N` (level N) marker followed by a space and a title. Hierarchy is the marker number,
 * not indentation, so `#` = depth 0, `#1` = depth 1, `#2` = depth 2, and so on.
 * Accepts any leading whitespace before the marker (tabs, spaces, NBSP from paste).
 * @param {string} line
 * @returns {{ tabDepth: number, level: number, title: string, usesNonTabIndent: boolean } | null}
 */
function parseHeadingForValidation(line) {
	const m = String(line || '').match(/^(\s*)#(\d*)\s+(.*)$/);
	if (!m) return null;
	const ind = m[1] || '';
	if (ind.length > 0 && /[^\t\s]/.test(ind)) return null;
	const usesNonTabIndent = ind.length > 0 && !/^\t+$/.test(ind);
	const level = m[2] ? parseInt(m[2], 10) : 0;
	if (!Number.isFinite(level) || level < 0) return null;
	return {
		tabDepth: level,
		level,
		title: String(m[3] || '').trim(),
		usesNonTabIndent
	};
}

/**
 * Body = after file-level `---` / header slice. Validation uses {@link parseHeadingForValidation}.
 * Hierarchy comes from the heading marker number (`#` = depth 0, `#1` = depth 1, `#2` = depth 2).
 * A heading is invalid only when a non-root heading has no shallower parent in the outline.
 *
 * @param {string[]} lines
 * @param {number} startIdx
 * @returns {{ nodes: HeadingNodeFlat[], errors: { lineIndex: number, message: string }[] }}
 */
function collectHeadingSequenceValidated(lines, startIdx) {
	/** @type {HeadingNodeFlat[]} */
	const nodes = [];
	/** @type {{ lineIndex: number, message: string }[]} */
	const errors = [];
	/** @type {{ tabDepth: number; lineIndex: number }[]} */
	const stack = [];

	for (let i = startIdx; i < lines.length; i++) {
		const line = lines[i];

		const ph = parseHeadingForValidation(line);
		if (ph) {
			const { tabDepth, level, title } = ph;
			const lineIndex = i;

			let valid = true;
			while (stack.length && stack[stack.length - 1].tabDepth >= tabDepth) {
				stack.pop();
			}
			if (tabDepth > 0 && stack.length === 0) {
				valid = false;
				errors.push({
					lineIndex,
					message: `This heading is at level ${tabDepth}, but no shallower heading sits above it. Add a parent heading one level up first.`
				});
			}

			let j = i + 1;
			const metaLines = [];
			while (j < lines.length) {
				const nh = parseHeadingForValidation(lines[j]);
				/** Any following heading line starts a new node; do not swallow it into metaLines. */
				if (nh) {
					break;
				}
				const ml = lines[j];
				/** `@hN` between headings belongs to the next heading, not this metadata block. */
				if (/^\s*@+/.test(String(ml || ''))) {
					break;
				}
				metaLines.push(ml);
				j++;
			}

			nodes.push({
				tabDepth,
				level,
				title,
				lineIndex,
				metaLines,
				valid
			});

			if (valid) {
				stack.push({ tabDepth, lineIndex });
			}

			i = j - 1;
			continue;
		}

		// Blank, `---`, prose, or metadata lines never change the outline.
	}

	return { nodes, errors };
}

/**
 * @param {HeadingNodeFlat[]} flat
 * @returns {HeadingNode[]}
 */
function buildHeadingTree(flat) {
	/** @type {HeadingNode[]} */
	const roots = [];
	/** @type {HeadingNode[]} */
	const stack = [];
	for (const n of flat) {
		const node = {
			tabDepth: n.tabDepth,
			level: n.level,
			title: n.title,
			lineIndex: n.lineIndex,
			metaLines: n.metaLines,
			children: []
		};
		while (stack.length && stack[stack.length - 1].tabDepth >= n.tabDepth) {
			stack.pop();
		}
		if (!stack.length) {
			roots.push(node);
		} else {
			stack[stack.length - 1].children.push(node);
		}
		stack.push(node);
	}
	return roots;
}

/**
 * Infer metadata type marker from first `.type` line in meta block.
 * @param {string[]} metaLines
 * @returns {string}
 */
function inferMarkerFromMeta(metaLines) {
	for (const line of metaLines) {
		const t = String(line || '').trim();
		const m = t.match(/^\.([a-z][a-z0-9_-]*)\b/i);
		if (m) return `.${String(m[1] || '').toLowerCase()}`;
	}
	return '';
}

/**
 * @param {string} text full document
 * @returns {{ fileLines: string[], headingRoots: HeadingNode[], flat: HeadingNodeFlat[], hierarchyErrors: { lineIndex: number, message: string }[] }}
 */
function parseNoteHeadings(text) {
	const lines = String(text || '').split(/\r?\n/);
	const { topEnd, fileSlice } = splitFileTopRegion(lines);
	const { nodes: flat, errors: hierarchyErrors } = collectHeadingSequenceValidated(lines, topEnd);
	const headingRoots = buildHeadingTree(flat.filter(n => n.valid !== false));
	return {
		fileLines: fileSlice,
		headingRoots,
		flat,
		hierarchyErrors
	};
}

/**
 * Heading ancestry path for flat[idx] (indices up to idx-1).
 * @param {HeadingNodeFlat[]} flat
 * @param {number} idx
 * @returns {HeadingNodeFlat[]}
 */
function ancestorChain(flat, idx) {
	if (idx <= 0) return [];
	/** @type {HeadingNodeFlat[]} */
	const stack = [];
	for (let j = 0; j < idx; j++) {
		const n = flat[j];
		if (n.valid === false) continue;
		while (stack.length && stack[stack.length - 1].tabDepth >= n.tabDepth) stack.pop();
		stack.push(n);
	}
	return stack;
}

module.exports = {
	splitFileTopRegion,
	parseHeadingForValidation,
	parseNoteHeadings,
	inferMarkerFromMeta,
	collectHeadingSequenceValidated,
	ancestorChain
};
