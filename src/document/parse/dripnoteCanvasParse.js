'use strict';

/**
 * @typedef {{ tabDepth: number, level: number, title: string, lineIndex: number, metaLines: string[], valid?: boolean }} HeadingNodeFlat
 * @typedef {{ tabDepth: number, level: number, title: string, lineIndex: number, metaLines: string[], children: HeadingNode[] }} HeadingNode
 */

/**
 * Split file into top region (file keys + h0 block) and body after `---`.
 * When `---` is present, everything before it is top (including the h0 `#` heading).
 * Legacy notes without `---` fall back to metadata-only lines before the first `#` heading.
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
			if (/^\s*#{1,6}\s+/.test(lines[i] || '')) {
				topEnd = i;
				break;
			}
		}
	}
	return { topEnd, fileSlice: lines.slice(0, topEnd) };
}

/**
 * @param {string} line
 * @returns {{ tabDepth: number, level: number, title: string, raw: string } | null}
 */
function parseHeadingLine(line) {
	const m = String(line || '').match(/^(\t*)(#{1,6})\s+(.*)$/);
	if (!m) return null;
	return {
		tabDepth: m[1] ? m[1].length : 0,
		level: m[2].length,
		title: String(m[3] || '').trim(),
		raw: line
	};
}

/**
 * Heading detection for hierarchy validation and diagnostics. Accepts any leading whitespace
 * before `#` (tabs, spaces, NBSP from paste). Depth is the character length of that indent.
 * {@link parseHeadingLine} stays tab-only for strict note/canvas behavior elsewhere.
 * @param {string} line
 * @returns {{ tabDepth: number, level: number, title: string, usesNonTabIndent: boolean } | null}
 */
function parseHeadingForValidation(line) {
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

/**
 * Metadata / structured lines (not prose) — excluded when detecting column-0 body text.
 * @param {string} line
 */
function looksLikeMetadataOrStructuredLine(line) {
	const t = String(line || '').trim();
	if (!t || t === '---') return true;
	if (/^\s*\/\//.test(line)) return true;
	if (/^\s*\.(\w[\w-]*)\b/i.test(line)) return true;
	if (/^\s*(tags|pre-req|ref)\s*:\s*\[/i.test(line)) return true;
	if (/^\s*@+\s*f\d+\s*:\s*h\d+\b/i.test(line)) return true;
	if (/^\s*\[[^\]]*\]\s*$/.test(line)) return true;
	if (/^\s*[a-z][a-z0-9_-]*\s*:\s*.+$/i.test(line)) return true;
	return false;
}

/**
 * @param {string[]} lines
 * @returns {number}
 */
function findFirstHeadingLineIndex(lines) {
	for (let i = 0; i < lines.length; i++) {
		if (parseHeadingForValidation(lines[i])) return i;
	}
	return -1;
}

/**
 * Column-0 prose before the first heading would detach nested headings from a root #.
 * Lines before {@code startIdx} were previously skipped when the first markdown line was an indented {@code #}.
 * @param {string[]} lines
 * @returns {boolean}
 */
function computeDetachedFromTextBeforeFirstHeading(lines) {
	const firstH = findFirstHeadingLineIndex(lines);
	if (firstH <= 0) return false;

	const { topEnd } = splitFileTopRegion(lines);
	const atSplit = String(lines[topEnd] || '').trim();
	const scanFrom = atSplit === '---' ? topEnd + 1 : 0;

	let detached = false;
	for (let i = scanFrom; i < firstH; i++) {
		const line = lines[i];
		const trimmed = String(line || '').trim();
		if (!trimmed || trimmed === '---') continue;
		if (parseHeadingForValidation(line)) continue;
		if (looksLikeMetadataOrStructuredLine(line)) continue;
		if (/^\s*\/\//.test(line)) continue;
		if (!line.startsWith('\t')) {
			detached = true;
		}
	}
	return detached;
}

/**
 * Walk lines from startIdx; collect heading nodes with metadata lines until next heading
 * at same or lesser tab depth (sibling/parent). Does not validate hierarchy.
 * @deprecated Use collectHeadingSequenceValidated for parsing + validation.
 */
function collectHeadingSequence(lines, startIdx) {
	const { nodes } = collectHeadingSequenceValidated(lines, startIdx);
	return { nodes, nextIdx: lines.length };
}

/**
 * Body = after file-level `---` / header slice. Validation uses {@link parseHeadingForValidation}
 * so pasted spaces before `#` still participate in hierarchy checks (see also “non-tab indent” diagnostic).
 * Marks headings invalid when:
 * - (detached) non-heading line at column 0 (no leading tab) appeared after `---` or before the first heading, so a nested heading cannot attach; or
 * - stack has no shallower parent for a nested heading.
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

	let detachedFromRoot = computeDetachedFromTextBeforeFirstHeading(lines);
	/** @type {{ tabDepth: number; lineIndex: number }[]} */
	const stack = [];

	for (let i = startIdx; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = String(line || '').trim();

		const ph = parseHeadingForValidation(line);
		if (ph) {
			const { tabDepth, level, title } = ph;
			const lineIndex = i;

			if (tabDepth === 0) {
				detachedFromRoot = false;
			}

			let valid = true;
			if (tabDepth > 0 && detachedFromRoot) {
				valid = false;
				const hasParent = stack.length > 0;
				errors.push({
					lineIndex,
					message: hasParent
						? 'Plain paragraph above (no tabs), but this heading uses tabs before #. Either tab-indent that paragraph, or remove the tabs before # on this line so it matches the paragraph.'
						: 'You need a normal # heading (no tabs before #) higher up before this indented heading. Add one, or tab-indent the lines above.'
				});
			} else {
				while (stack.length && stack[stack.length - 1].tabDepth >= tabDepth) {
					stack.pop();
				}
				if (tabDepth > 0 && stack.length === 0) {
					valid = false;
					errors.push({
						lineIndex,
						message:
							'This heading uses tabs before # but nothing sits above it in the outline. Add a parent heading with fewer tabs before # first.'
					});
				}
			}

			let j = i + 1;
			const metaLines = [];
			while (j < lines.length) {
				const nh = parseHeadingForValidation(lines[j]);
				/** Any following line that is a # heading starts a new node; do not swallow deeper tab-indented headings into metaLines. */
				if (nh) {
					break;
				}
				const ml = lines[j];
				/** `@fN:hM` between headings belongs to the next heading, not this metadata block. */
				if (/^\s*@+/.test(String(ml || ''))) {
					break;
				}
				const tr = String(ml || '').trim();
				if (tr && tr !== '---' && !ml.startsWith('\t')) {
					detachedFromRoot = true;
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

		if (!trimmed) {
			continue;
		}
		if (trimmed === '---') {
			continue;
		}
		if (!line.startsWith('\t')) {
			detachedFromRoot = true;
		}
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
function parseNoteForCanvas(text) {
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
 * Find flat node index for heading at line (0-based).
 * @param {HeadingNodeFlat[]} flat
 * @param {number} lineIndex
 */
function findFlatIndexByLine(flat, lineIndex) {
	for (let i = 0; i < flat.length; i++) {
		if (flat[i].lineIndex === lineIndex) return i;
	}
	return -1;
}

/**
 * Subtree: node at flat[idx] and descendants in tree structure (clone shallow).
 * @param {HeadingNode[]} _roots unused; kept for API symmetry
 * @param {HeadingNodeFlat[]} flat
 * @param {number} lineIndex
 * @returns {HeadingNode[] | null}
 */
function extractSubtreeAtLine(_roots, flat, lineIndex) {
	const idx = findFlatIndexByLine(flat, lineIndex);
	if (idx < 0) return null;
	const target = flat[idx];
	if (target.valid === false) return null;
	/** @type {HeadingNodeFlat[]} */
	const slice = [target];
	for (let j = idx + 1; j < flat.length; j++) {
		if (flat[j].tabDepth <= target.tabDepth) break;
		if (flat[j].valid === false) continue;
		slice.push(flat[j]);
	}
	return buildHeadingTree(slice);
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
	parseHeadingLine,
	parseHeadingForValidation,
	parseNoteForCanvas,
	inferMarkerFromMeta,
	extractSubtreeAtLine,
	findFlatIndexByLine,
	buildHeadingTree,
	collectHeadingSequence,
	collectHeadingSequenceValidated,
	ancestorChain
};
