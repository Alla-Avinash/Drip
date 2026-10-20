'use strict';

const { collectHeadingSequenceValidated } = require('../document/parse/dripTxt/dripTxtHeadingParse.js');
const { getMetadataSettingsForIndex } = require('../document/model/dripNoteMetadataTemplates.js');
const {
	classifyPersistentHeadingTitle,
	stripHeadingTitleTypePrefix
} = require('../document/model/dripTxt/dripTxtPersistentHeading.js');
const { parseFileEntityIdNumber } = require('./dripTxt/dripTxtEntityIds.js');
const { parseTypedMetadataForHeading } = require('./parse/dripIndexTypedMetadata');
const {
	getKnownMetadataTypeIds,
	normalizeMetadataTypeForIndex
} = require('./parse/dripIndexMetadataType');
const {
	changeRangesAffectFileHeader,
	computeHeadingSpans,
	headingStructureChanged,
	mergeParsedNoteWithCache,
	resolveReparsedNodeIndices
} = require('./parse/dripIndexIncrementalParse');

/**
 * @param {string} text
 */
function splitHeaderAndBody(text) {
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	const sep = lines.findIndex(line => String(line || '').trim() === '---');
	if (sep < 0) {
		return { headerLines: [], bodyLines: lines };
	}
	return { headerLines: lines.slice(0, sep), bodyLines: lines.slice(sep + 1) };
}

/**
 * @param {string[]} headerLines
 */
function parseFileIdFromHeader(headerLines) {
	for (const line of headerLines) {
		const m = String(line || '').match(/^\s*fileid\s*:\s*(.+)\s*$/i);
		if (m) {
			return parseFileEntityIdNumber(String(m[1] || '').trim());
		}
	}
	return null;
}

/**
 * @param {string[]} metaLines
 */
function parseHeadingMetaBlock(metaLines) {
	let headingIdNum = null;
	let metadataType = '';

	for (const line of metaLines || []) {
		const idMatch = String(line || '').match(/@\s*h(\d+)/i);
		if (idMatch) {
			headingIdNum = parseInt(idMatch[1], 10);
		}

		const typeMatch = String(line || '').match(/^\s*\.(\w[\w-]*)/);
		if (typeMatch) {
			metadataType = String(typeMatch[1] || '').toLowerCase();
		}
	}

	return { headingIdNum, metadataType };
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
function parseBracketTokens(raw) {
	return String(raw || '')
		.split(',')
		.map(x => String(x || '').trim())
		.filter(Boolean);
}

const BRACKET_RELATION_LINE_RE = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*\[([^\]]*)\]\s*$/i;
const SHORT_BRACKET_LINE_RE = /^\s*\[([^\]]+)\]\s*$/;
const TAGS_RELATION_KEY = 'tags';
const HEADING_IDENTITY_LINE_RE = /^\s*@+\s*h(\d+)\s*$/i;

/**
 * @param {string[]} lines
 * @param {number} headingLineIndex
 * @returns {{ headingIdNum: number } | null}
 */
function parseHeadingIdentityAbove(lines, headingLineIndex) {
	for (let j = headingLineIndex - 1; j >= 0; j--) {
		const line = String(lines[j] || '');
		if (!line.trim()) continue;
		const m = HEADING_IDENTITY_LINE_RE.exec(line);
		if (m) {
			const headingIdNum = parseInt(m[1], 10);
			if (!Number.isFinite(headingIdNum)) return null;
			return { headingIdNum };
		}
		break;
	}
	return null;
}

/**
 * Parse searchable tag lines: `tags: [a, b]` or shorthand `[a, b]`.
 * Tokens are always plain text tag names.
 *
 * @param {string[]} lines
 * @param {number} sourceHeadingId heading that owns this metadata block
 * @param {Set<string> | undefined} knownTagsLower tags present in KB tag graph (lowercase)
 * @returns {{ source_heading_id: number, tag_name: string }[]}
 */
function collectSearchTagsFromLines(lines, sourceHeadingId, knownTagsLower) {
	/** @type {{ source_heading_id: number, tag_name: string }[]} */
	const searchtags = [];

	for (const line of lines || []) {
		let inner = '';
		const bracket = String(line || '').match(BRACKET_RELATION_LINE_RE);
		if (bracket) {
			const key = String(bracket[1] || '').trim().toLowerCase();
			if (key !== TAGS_RELATION_KEY) {
				continue;
			}
			inner = bracket[2];
		} else {
			const short = String(line || '').match(SHORT_BRACKET_LINE_RE);
			if (!short) {
				continue;
			}
			inner = short[1];
		}

		for (const token of parseBracketTokens(inner)) {
			const tagName = String(token || '').trim();
			if (!tagName) {
				continue;
			}
			if (knownTagsLower && knownTagsLower.size && !knownTagsLower.has(tagName.toLowerCase())) {
				continue;
			}
			searchtags.push({ source_heading_id: sourceHeadingId, tag_name: tagName });
		}
	}

	return searchtags;
}

/**
 * Parse relation lines like `pre-req: [react, javascript]`.
 * Tokens are plain text tag names (same as searchable tags).
 *
 * @param {string[]} lines
 * @param {number} sourceHeadingId
 * @param {Set<string> | undefined} knownTagsLower
 * @returns {{ source_heading_id: number, relation_type: string, tag_name: string }[]}
 */
function collectRelationsFromLines(lines, sourceHeadingId, knownTagsLower) {
	/** @type {{ source_heading_id: number, relation_type: string, tag_name: string }[]} */
	const relations = [];

	for (const line of lines || []) {
		const bracket = String(line || '').match(BRACKET_RELATION_LINE_RE);
		if (!bracket) {
			continue;
		}

		const relationType = String(bracket[1] || '').trim().toLowerCase();
		if (!relationType || relationType === TAGS_RELATION_KEY || relationType === 'parent') {
			continue;
		}

		for (const token of parseBracketTokens(bracket[2])) {
			const tagName = String(token || '').trim();
			if (!tagName) {
				continue;
			}
			if (knownTagsLower && knownTagsLower.size && !knownTagsLower.has(tagName.toLowerCase())) {
				continue;
			}
			relations.push({
				source_heading_id: sourceHeadingId,
				relation_type: relationType,
				tag_name: tagName
			});
		}
	}

	return relations;
}

/**
 * @deprecated Use collectSearchTagsFromLines + collectRelationsFromLines.
 */
function collectTagsAndRelationsFromLines(lines, sourceHeadingId, knownTagsLower) {
	return {
		searchtags: collectSearchTagsFromLines(lines, sourceHeadingId, knownTagsLower),
		relations: collectRelationsFromLines(lines, sourceHeadingId, knownTagsLower)
	};
}

/**
 * Parse one heading node into index rows (heading + scoped edges).
 *
 * @param {string[]} lines
 * @param {import('../document/parse/dripTxt/dripTxtHeadingParse.js').HeadingNodeFlat} node
 * @param {Set<string> | undefined} knownTagsLower
 * @param {number} nextAutoHeadingId
 * @param {{ includeDetails?: boolean, metadataType?: string | null, headingIdOverride?: number | null }} [options]
 */
function parseHeadingNodeForIndex(lines, node, knownTagsLower, nextAutoHeadingId, options) {
	const includeDetails = !options || options.includeDetails !== false;

	const above = parseHeadingIdentityAbove(lines, node.lineIndex);
	const meta = parseHeadingMetaBlock(node.metaLines || []);
	let headingId = options?.headingIdOverride ?? above?.headingIdNum ?? meta.headingIdNum;
	if (headingId == null || !Number.isFinite(headingId)) {
		headingId = nextAutoHeadingId;
		nextAutoHeadingId += 1;
	} else {
		nextAutoHeadingId = Math.max(nextAutoHeadingId, headingId + 1);
	}

	const metadataType = normalizeMetadataTypeForIndex(
		options?.metadataType,
		options?.knownMetadataTypeIds || getKnownMetadataTypeIds()
	);

	const heading = {
		heading_id: headingId,
		// File keeps `# .c Title`; index stores clean words only (type lives in metadata_type_id).
		title: stripHeadingTitleTypePrefix(node.title),
		tab_depth: node.tabDepth,
		metadata_type: metadataType
	};

	/** @type {{ source_heading_id: number, tag_name: string }[]} */
	const searchtags = [];
	/** @type {{ source_heading_id: number, relation_type: string, tag_name: string }[]} */
	const relations = [];
	/** @type {{ heading_id: number, metadata_type: string, table: string | null, fields: Record<string, string | number | null>, remaining: { key: string, value: string | null }[] }[]} */
	const typedMetadata = [];

	if (includeDetails) {
		searchtags.push(...collectSearchTagsFromLines(node.metaLines || [], headingId, knownTagsLower));
		relations.push(...collectRelationsFromLines(node.metaLines || [], headingId, knownTagsLower));
		const typed = parseTypedMetadataForHeading(headingId, metadataType, node.metaLines || []);
		if (typed) {
			typedMetadata.push(typed);
		}
	}

	return {
		heading,
		searchtags,
		relations,
		typedMetadata,
		nextAutoHeadingId
	};
}

/**
 * Set `heading.parent` = nearest earlier indexed heading whose indented section still contains
 * this heading (same rule as issue blocks: text or plain headings at the same or a shallower
 * indent close a section — see `outlineParentsByLine`).
 *
 * @param {import('../document/parse/dripTxt/dripTxtHeadingParse.js').HeadingNodeFlat[]} nodes
 * @param {Map<number, number>} headingIdByNodeIndex
 * @param {{ heading_id: number, parent?: number | null }[]} headings
 */
function assignHeadingParentsFromIndent(nodes, headingIdByNodeIndex, headings) {
	/** @type {Map<number, { heading_id: number, parent?: number | null }>} */
	const byId = new Map();
	for (const h of headings || []) {
		if (h && h.heading_id != null) byId.set(Number(h.heading_id), h);
	}
	/** @type {Map<number, number>} line index → heading_id */
	const headingIdByLine = new Map();
	for (const [nodeIndex, headingId] of headingIdByNodeIndex) {
		const node = nodes[nodeIndex];
		if (node && byId.has(Number(headingId))) headingIdByLine.set(node.lineIndex, Number(headingId));
	}
	// Parent = nearest earlier heading with a strictly smaller marker level (tabDepth).
	/** @type {{ line: number, depth: number }[]} */
	const stack = [];
	for (const node of nodes) {
		const headingId = headingIdByLine.get(node.lineIndex);
		if (headingId == null) continue;
		const h = byId.get(headingId);
		if (!h) continue;
		while (stack.length && stack[stack.length - 1].depth >= node.tabDepth) stack.pop();
		const parentLine = stack.length ? stack[stack.length - 1].line : null;
		h.parent = parentLine == null ? null : headingIdByLine.get(parentLine) ?? null;
		stack.push({ line: node.lineIndex, depth: node.tabDepth });
	}
}

/**
 * @param {string[]} lines
 * @param {import('../document/parse/dripTxt/dripTxtHeadingParse.js').HeadingNodeFlat[]} nodes
 * @param {Set<string> | undefined} knownTagsLower
 * @param {{ onlyDetailForNodeIndices?: Set<number>, knownMetadataTypeIds?: Set<string> }} [options]
 */
function parseAllHeadingNodesForIndex(lines, nodes, knownTagsLower, options) {
	const onlyDetail = options && options.onlyDetailForNodeIndices;
	const knownMetadataTypeIds = options?.knownMetadataTypeIds || getKnownMetadataTypeIds();
	const metadataSettings = getMetadataSettingsForIndex();
	const separatorIndex = lines.findIndex(line => String(line || '').trim() === '---');
	const h0NodeIndex = nodes.findIndex(
		node =>
			node.valid !== false &&
			node.tabDepth === 0 &&
			(separatorIndex < 0 || node.lineIndex > separatorIndex)
	);

	/** @type {object[]} */
	const headings = [];
	/** @type {object[]} */
	const searchtags = [];
	/** @type {object[]} */
	const relations = [];
	/** @type {object[]} */
	const typedMetadata = [];
	/** @type {Map<number, number>} */
	const headingIdByNodeIndex = new Map();
	let nextAutoHeadingId = 1;
	for (const node of nodes) {
		const existingIdentity = parseHeadingIdentityAbove(lines, node.lineIndex);
		if (existingIdentity?.headingIdNum > 0) {
			nextAutoHeadingId = Math.max(nextAutoHeadingId, existingIdentity.headingIdNum + 1);
		}
	}

	for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
		const node = nodes[nodeIndex];
		if (node.valid === false) {
			continue;
		}
		const isH0 = nodeIndex === h0NodeIndex;
		const classification = classifyPersistentHeadingTitle(node.title, metadataSettings);
		if (!isH0 && !classification.persistent) {
			continue;
		}

		const includeDetails = !onlyDetail || onlyDetail.has(nodeIndex);
		const parsed = parseHeadingNodeForIndex(
			lines,
			node,
			knownTagsLower,
			nextAutoHeadingId,
			{
				includeDetails,
				knownMetadataTypeIds,
				metadataType: classification.metadataType,
				headingIdOverride: isH0 ? 0 : null
			}
		);
		nextAutoHeadingId = parsed.nextAutoHeadingId;
		headingIdByNodeIndex.set(nodeIndex, parsed.heading.heading_id);

		headings.push(parsed.heading);
		searchtags.push(...parsed.searchtags);
		relations.push(...parsed.relations);
		typedMetadata.push(...parsed.typedMetadata);
	}

	assignHeadingParentsFromIndent(nodes, headingIdByNodeIndex, headings);

	return { headings, searchtags, relations, typedMetadata, headingIdByNodeIndex };
}

/**
 * @param {string} text
 * @param {string} relPath
 * @param {string} fileName
 * @param {{ ctimeMs?: number, mtimeMs?: number }} [times]
 * @param {{
 *   knownTagsLower?: Set<string>,
 *   changeRanges?: { start: number, end: number }[],
 *   previousParse?: object | null
 * }} [options]
 */
function parseNoteForIndex(text, relPath, fileName, times, options) {
	const knownTagsLower = options && options.knownTagsLower ? options.knownTagsLower : undefined;
	const knownMetadataTypeIds = getKnownMetadataTypeIds();
	const changeRanges = options && options.changeRanges ? options.changeRanges : undefined;
	const previousParse = options && options.previousParse ? options.previousParse : null;
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	const headerFileId = parseFileIdFromHeader(lines);
	const { nodes } = collectHeadingSequenceValidated(lines, 0);

	const nowSec = Math.floor(Date.now() / 1000);
	const created = times && Number.isFinite(times.ctimeMs) ? Math.floor(times.ctimeMs / 1000) : nowSec;
	const updated = times && Number.isFinite(times.mtimeMs) ? Math.floor(times.mtimeMs / 1000) : nowSec;

	const fileEnvelope = {
		fileId: headerFileId,
		file: {
			path: relPath.replace(/\\/g, '/'),
			name: fileName,
			created_at: created,
			updated_at: updated
		}
	};

	const useIncremental =
		changeRanges &&
		changeRanges.length &&
		previousParse &&
		!changeRangesAffectFileHeader(lines, changeRanges);

	if (useIncremental) {
		const spans = computeHeadingSpans(nodes, lines);
		const reparsedNodeIndices = resolveReparsedNodeIndices(nodes, spans, changeRanges);
		if (reparsedNodeIndices.size) {
			const partial = parseAllHeadingNodesForIndex(lines, nodes, knownTagsLower, {
				onlyDetailForNodeIndices: reparsedNodeIndices,
				knownMetadataTypeIds
			});

			if (!headingStructureChanged(previousParse, partial)) {
				/** @type {Set<number>} */
				const reparsedHeadingIds = new Set();
				for (const idx of reparsedNodeIndices) {
					const headingId = partial.headingIdByNodeIndex.get(idx);
					if (headingId != null) {
						reparsedHeadingIds.add(headingId);
					}
				}

				return {
					...fileEnvelope,
					...mergeParsedNoteWithCache(previousParse, partial, reparsedHeadingIds),
					_parseMode: 'incremental-subtree',
					_dirtyHeadingIds: [...reparsedHeadingIds]
				};
			}
		}
	}

	const full = parseAllHeadingNodesForIndex(lines, nodes, knownTagsLower, { knownMetadataTypeIds });
	return {
		...fileEnvelope,
		...full,
		_parseMode: 'full',
		_dirtyHeadingIds: []
	};
}

module.exports = {
	parseNoteForIndex,
	parseAllHeadingNodesForIndex,
	parseHeadingNodeForIndex,
	assignHeadingParentsFromIndent,
	collectSearchTagsFromLines,
	collectRelationsFromLines,
	collectTagsAndRelationsFromLines
};
