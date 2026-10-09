'use strict';

/**
 * Incremental index parse helpers (spec §13).
 * Given edited line ranges, locate affected heading subtrees and merge with a cached parse.
 */

/**
 * @param {import('../../document/parse/dripnoteHeadingParse').HeadingNodeFlat[]} nodes
 * @param {string[]} lines
 * @returns {{ start: number, end: number }[]}
 */
function computeHeadingSpans(nodes, lines) {
	/** @type {{ start: number, end: number }[]} */
	const spans = [];
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		let start = node.lineIndex;
		for (let j = node.lineIndex - 1; j >= 0; j--) {
			const line = String(lines[j] || '');
			if (!line.trim()) continue;
			if (/^\s*@+\s*f\d+\s*:\s*h\d+\b/i.test(line)) {
				start = j;
			}
			break;
		}

		let end = lines.length - 1;
		for (let k = i + 1; k < nodes.length; k++) {
			if (nodes[k].tabDepth <= node.tabDepth) {
				end = nodes[k].lineIndex - 1;
				break;
			}
		}
		spans.push({ start, end: Math.max(start, end) });
	}
	return spans;
}

/**
 * @param {{ start: number, end: number }} a
 * @param {{ start: number, end: number }} b
 * @returns {boolean}
 */
function rangesOverlap(a, b) {
	return a.start <= b.end && b.start <= a.end;
}

/**
 * @param {{ start: number, end: number }[]} ranges
 * @returns {{ start: number, end: number }[]}
 */
function mergeOverlappingLineRanges(ranges) {
	const sorted = (ranges || [])
		.map(r => ({
			start: Math.max(0, Math.min(r.start, r.end)),
			end: Math.max(r.start, r.end)
		}))
		.sort((a, b) => a.start - b.start || a.end - b.end);
	if (!sorted.length) return [];

	/** @type {{ start: number, end: number }[]} */
	const out = [sorted[0]];
	for (let i = 1; i < sorted.length; i++) {
		const prev = out[out.length - 1];
		const cur = sorted[i];
		if (cur.start <= prev.end + 1) {
			prev.end = Math.max(prev.end, cur.end);
		} else {
			out.push(cur);
		}
	}
	return out;
}

/**
 * @param {import('vscode').TextDocumentContentChangeEvent} change
 * @returns {{ start: number, end: number }}
 */
function lineRangeFromContentChange(change) {
	const start = change.range.start.line;
	const insertedLines = String(change.text || '').split('\n').length - 1;
	const removedLines = change.range.end.line - change.range.start.line;
	const end = Math.max(change.range.end.line, start + insertedLines);
	return { start, end: Math.max(start, end) };
}

/**
 * @param {{ start: number, end: number }[] | undefined} existing
 * @param {import('vscode').TextDocumentContentChangeEvent[]} changes
 * @returns {{ start: number, end: number }[]}
 */
function accumulateContentChangeRanges(existing, changes) {
	/** @type {{ start: number, end: number }[]} */
	const next = existing ? existing.slice() : [];
	for (const change of changes || []) {
		next.push(lineRangeFromContentChange(change));
	}
	return mergeOverlappingLineRanges(next);
}

/**
 * @param {string[]} lines
 * @param {{ start: number, end: number }[]} changeRanges
 * @returns {boolean}
 */
function changeRangesAffectFileHeader(lines, changeRanges) {
	const sep = lines.findIndex(line => String(line || '').trim() === '---');
	const headerEnd = sep >= 0 ? sep : findFirstBodyHeadingLine(lines);
	if (headerEnd < 0) return false;
	for (const range of changeRanges || []) {
		if (range.start <= headerEnd) {
			return true;
		}
	}
	return false;
}

/**
 * @param {string[]} lines
 * @returns {number}
 */
function findFirstBodyHeadingLine(lines) {
	for (let i = 0; i < lines.length; i++) {
		if (/^(\s*)#{1,6}\s+/.test(String(lines[i] || ''))) {
			return i;
		}
	}
	return -1;
}

/**
 * @param {import('../../document/parse/dripnoteHeadingParse').HeadingNodeFlat[]} nodes
 * @param {{ start: number, end: number }[]} spans
 * @param {{ start: number, end: number }[]} changeRanges
 * @returns {number[]}
 */
function findAffectedSubtreeRootIndices(nodes, spans, changeRanges) {
	/** @type {Set<number>} */
	const roots = new Set();
	for (const range of changeRanges || []) {
		/** @type {number[]} */
		const hit = [];
		for (let i = 0; i < nodes.length; i++) {
			if (rangesOverlap(spans[i], range)) {
				hit.push(i);
			}
		}
		if (!hit.length) continue;
		let shallowest = hit[0];
		for (const idx of hit) {
			if (nodes[idx].tabDepth < nodes[shallowest].tabDepth) {
				shallowest = idx;
			} else if (
				nodes[idx].tabDepth === nodes[shallowest].tabDepth &&
				nodes[idx].lineIndex < nodes[shallowest].lineIndex
			) {
				shallowest = idx;
			}
		}
		roots.add(shallowest);
	}
	return [...roots].sort((a, b) => a - b);
}

/**
 * @param {import('../../document/parse/dripnoteHeadingParse').HeadingNodeFlat[]} nodes
 * @param {number} rootIndex
 * @returns {number[]}
 */
function collectSubtreeNodeIndices(nodes, rootIndex) {
	const root = nodes[rootIndex];
	if (!root) return [];
	/** @type {number[]} */
	const out = [rootIndex];
	for (let i = rootIndex + 1; i < nodes.length; i++) {
		if (nodes[i].tabDepth <= root.tabDepth) break;
		out.push(i);
	}
	return out;
}

/**
 * @param {import('../../document/parse/dripnoteHeadingParse').HeadingNodeFlat[]} nodes
 * @param {{ start: number, end: number }[]} spans
 * @param {{ start: number, end: number }[]} changeRanges
 * @returns {Set<number>}
 */
function resolveReparsedNodeIndices(nodes, spans, changeRanges) {
	/** @type {Set<number>} */
	const indices = new Set();
	const roots = findAffectedSubtreeRootIndices(nodes, spans, changeRanges);
	for (const rootIdx of roots) {
		for (const idx of collectSubtreeNodeIndices(nodes, rootIdx)) {
			indices.add(idx);
		}
	}
	return indices;
}

/**
 * @param {object | null | undefined} previousParse
 * @param {{ headings?: { heading_id: number }[] }} nextParse
 * @returns {boolean}
 */
function headingStructureChanged(previousParse, nextParse) {
	const prev = previousParse && Array.isArray(previousParse.headings) ? previousParse.headings : [];
	const next = nextParse && Array.isArray(nextParse.headings) ? nextParse.headings : [];
	if (prev.length !== next.length) return true;
	for (let i = 0; i < next.length; i++) {
		const a = prev[i];
		const b = next[i];
		if (!a || !b) return true;
		if (a.heading_id !== b.heading_id) return true;
		if ((a.tab_depth || 0) !== (b.tab_depth || 0)) return true;
		if ((a.parent == null ? null : Number(a.parent)) !== (b.parent == null ? null : Number(b.parent))) {
			return true;
		}
	}
	return false;
}

/**
 * Merge freshly parsed heading-scoped rows, keeping untouched headings from cache.
 *
 * @param {object} previousParse
 * @param {object} partialParse full headings list + detail only for reparsed ids
 * @param {Set<number>} reparsedHeadingIds
 * @returns {object}
 */
function mergeParsedNoteWithCache(previousParse, partialParse, reparsedHeadingIds) {
	const keep = row => !reparsedHeadingIds.has(row.source_heading_id);
	const keepTyped = row => !reparsedHeadingIds.has(row.heading_id);

	return {
		...partialParse,
		searchtags: [
			...(previousParse.searchtags || []).filter(keep),
			...(partialParse.searchtags || [])
		],
		relations: [
			...(previousParse.relations || []).filter(keep),
			...(partialParse.relations || [])
		],
		typedMetadata: [
			...(previousParse.typedMetadata || []).filter(keepTyped),
			...(partialParse.typedMetadata || [])
		]
	};
}

module.exports = {
	accumulateContentChangeRanges,
	changeRangesAffectFileHeader,
	collectSubtreeNodeIndices,
	computeHeadingSpans,
	findAffectedSubtreeRootIndices,
	headingStructureChanged,
	lineRangeFromContentChange,
	mergeOverlappingLineRanges,
	mergeParsedNoteWithCache,
	resolveReparsedNodeIndices
};
