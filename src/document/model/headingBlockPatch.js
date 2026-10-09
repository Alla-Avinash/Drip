'use strict';

/**
 * Surgical patches for persistent heading blocks.
 * Never rewrites blank lines or body prose — only the heading line and structured meta lines.
 */

const {
	getMetadataSettings
} = require('./dripnoteMetadataTemplates');
const { classifyMetaLine, isStructuredMetadataLine } = require('./persistentHeadingZones');
const { parseHeadingForValidation } = require('../parse/dripnoteHeadingParse');

/**
 * @param {string[]} lines
 * @param {number} headingLine
 * @returns {{ metaLineIndexes: number[], lastStructuredLine: number }}
 */
function listStructuredMetaLines(lines, headingLine) {
	/** @type {number[]} */
	const metaLineIndexes = [];
	let lastStructuredLine = headingLine;
	for (let j = headingLine + 1; j < lines.length; j++) {
		const raw = String(lines[j] || '');
		const tr = raw.trim();
		if (parseHeadingForValidation(raw)) break;
		if (/^\s*@/.test(raw)) break;
		if (!tr) {
			// Blank: stop scanning for contiguous structured meta (blanks stay untouched).
			if (metaLineIndexes.length) break;
			continue;
		}
		if (tr.startsWith('//')) continue;
		if (!isStructuredMetadataLine(raw)) break;
		metaLineIndexes.push(j);
		lastStructuredLine = j;
	}
	return { metaLineIndexes, lastStructuredLine };
}

/**
 * @param {{
 *   level: number,
 *   tabDepth: number,
 *   typePrefix?: string,
 *   typeId?: string | null,
 *   titleDisplay: string
 * }} model
 * @param {{ types?: any[], typeById?: Map<string, any> }} settings
 * @param {string} [existingHeadingLine] used to preserve `#` count / indent when level omitted
 */
function buildHeadingTitleLine(model, settings, existingHeadingLine) {
	const s = settings || getMetadataSettings();
	const existing = parseHeadingForValidation(existingHeadingLine || '');
	const level = Math.min(
		6,
		Math.max(1, Number(model.level) || (existing && existing.level) || 1)
	);
	const tabDepth = Math.max(
		0,
		Number.isFinite(Number(model.tabDepth))
			? Number(model.tabDepth)
			: existing
				? existing.tabDepth
				: 0
	);
	const tabs = '\t'.repeat(tabDepth);
	const typeId = String(model.typeId || '').trim().toLowerCase();
	const typeDef =
		(s.typeById && s.typeById.get(typeId)) ||
		(s.types || []).find(t => String(t.id || '').toLowerCase() === typeId);

	// Always derive shortcut from the selected type so RHS type changes rewrite a misspelled prefix.
	let prefix = '.';
	if (typeDef) {
		const sc = String(typeDef.shortcut || '').trim();
		prefix = sc ? (sc.startsWith('.') ? sc : `.${sc}`) : String(typeDef.marker || `.${typeId}`);
	} else if (typeId) {
		prefix = `.${typeId}`;
	} else {
		// Untyped persistent: bare `.` (ignore stale/wrong typePrefix from a prior misspell).
		const rawPrefix = String(model.typePrefix || '').trim();
		prefix = rawPrefix === '.' || rawPrefix === '' ? '.' : '.';
	}

	let titlePart = String(model.titleDisplay || '').trim();

	// Issues keep a durable `.i-N` type prefix (never rewrite to bare `.i` on RHS apply).
	if (typeId === 'issue') {
		const {
			parseIssueTypePrefix,
			formatIssueTypePrefix,
			parseIssueTitleEntityId,
			normalizeIssueEntityId
		} = require('../project/projectStructureRules');
		const fromPrefix = parseIssueTypePrefix(model.typePrefix);
		const fromModelId = model.issueEntityId
			? normalizeIssueEntityId(model.issueEntityId)
			: null;
		const legacy = parseIssueTitleEntityId(titlePart);
		const issueId = fromPrefix || fromModelId || (legacy ? legacy.id : null);
		if (issueId) {
			const tp = formatIssueTypePrefix(issueId);
			if (tp) prefix = tp;
		}
		if (legacy) titlePart = legacy.rest;
	}

	// Keep a trailing space after prefix when title is empty so the heading stays "ready" for RHS.
	return `${tabs}${'#'.repeat(level)} ${prefix}${titlePart ? ` ${titlePart}` : ' '}`;
}

/**
 * Desired structured meta lines (indent relative to heading), in order. Empty values omitted.
 * Spec shape:
 *   .concept
 *     difficulty: hard
 *   tags: [a, b]
 *   pre-req: [x]
 * @param {object} model
 * @param {{ types?: any[], typeById?: Map<string, any> }} settings
 * @param {number} tabDepth
 */
function buildDesiredMetaLines(model, settings, tabDepth) {
	const s = settings || getMetadataSettings();
	const typeId = String(model.typeId || '').trim().toLowerCase();
	const typeDef =
		(s.typeById && s.typeById.get(typeId)) ||
		(s.types || []).find(t => String(t.id || '').toLowerCase() === typeId);
	const depth = Math.max(0, Number(tabDepth) || 0);
	const baseIndent = '\t'.repeat(depth + 1);
	const attrIndent = '\t'.repeat(depth + 2);
	/** @type {{ key: string, text: string }[]} */
	const out = [];

	if (typeDef) {
		const marker = String(typeDef.marker || `.${typeId}`).trim();
		if (marker) out.push({ key: 'type-marker', text: `${baseIndent}${marker}` });
	} else if (typeId) {
		out.push({ key: 'type-marker', text: `${baseIndent}.${typeId}` });
	}

	const special = model.special && typeof model.special === 'object' ? model.special : {};
	for (const key of Object.keys(special)) {
		// Issue `parent: i-N` lives in attributes only (workflow special parent is for tasks).
		if (typeId === 'issue' && String(key).toLowerCase() === 'parent') continue;
		const v = String(special[key] || '').trim();
		if (v) out.push({ key, text: `${attrIndent}${key}: ${v}` });
	}
	const attrs = model.attributes && typeof model.attributes === 'object' ? model.attributes : {};
	const attrKeys =
		typeDef && typeDef.attributes ? Object.keys(typeDef.attributes) : Object.keys(attrs);
	for (const key of attrKeys) {
		const v = String(attrs[key] != null ? attrs[key] : '').trim();
		if (v) out.push({ key, text: `${attrIndent}${key}: ${v}` });
	}
	for (const key of Object.keys(attrs)) {
		if (attrKeys.includes(key)) continue;
		const v = String(attrs[key] || '').trim();
		if (v) out.push({ key, text: `${attrIndent}${key}: ${v}` });
	}
	const tags = Array.isArray(model.tags)
		? model.tags.map(t => String(t || '').trim()).filter(Boolean)
		: [];
	if (tags.length) out.push({ key: 'tags', text: `${baseIndent}tags: [${tags.join(', ')}]` });
	const rels = Array.isArray(model.relations) ? model.relations : [];
	for (const r of rels) {
		const rt = String(r && r.type ? r.type : '')
			.trim()
			.toLowerCase();
		if (!rt || rt === 'tags') continue;
		const rts = Array.isArray(r.tags) ? r.tags.map(t => String(t || '').trim()).filter(Boolean) : [];
		if (!rts.length) continue;
		out.push({ key: `rel:${rt}`, text: `${baseIndent}${rt}: [${rts.join(', ')}]` });
	}
	return out;
}

/**
 * @param {string} line
 * @returns {string}
 */
function metaLineKey(line) {
	const c = classifyMetaLine(line);
	if (c.kind === 'tags') return 'tags';
	if (c.kind === 'relation' && c.key) return `rel:${c.key}`;
	if (c.kind === 'kv' && c.key) return c.key;
	if (c.kind === 'type') return 'type-marker';
	return '';
}

/**
 * Compute surgical edits. Blank lines and body are never in the patch.
 * Structured meta under the heading is rewritten as an ordered block (type marker → attrs → tags → relations)
 * so `.concept` / indent / `tags:` stay correct without touching body prose.
 * @param {string[]} lines
 * @param {{ headingLine: number, identityLine: number, tabDepth: number, level: number }} zone
 * @param {object} model
 * @param {object} [settings]
 * @returns {{
 *   titleLine: number,
 *   titleText: string,
 *   lineReplacements: { line: number, text: string }[],
 *   insertsAfter: { line: number, texts: string[] } | null,
 *   metaBlockReplace: { startLine: number, endLineInclusive: number, texts: string[] } | null,
 *   unchanged: boolean
 * }}
 */
function planPersistentHeadingPatch(lines, zone, model, settings) {
	const s = settings || getMetadataSettings();
	const headingLine = zone.headingLine;
	const titleText = buildHeadingTitleLine(
		{ ...model, level: model.level || zone.level, tabDepth: model.tabDepth ?? zone.tabDepth },
		s,
		lines[headingLine]
	);
	const { metaLineIndexes, lastStructuredLine } = listStructuredMetaLines(lines, headingLine);
	const desired = buildDesiredMetaLines(model, s, zone.tabDepth);
	const desiredTexts = desired.map(d => d.text);

	/** @type {{ line: number, text: string }[]} */
	const lineReplacements = [];
	if (String(lines[headingLine] || '') !== titleText) {
		lineReplacements.push({ line: headingLine, text: titleText });
	}

	/** @type {{ line: number, texts: string[] } | null} */
	let insertsAfter = null;
	/** @type {{ startLine: number, endLineInclusive: number, texts: string[] } | null} */
	let metaBlockReplace = null;

	if (metaLineIndexes.length === 0) {
		if (desiredTexts.length) {
			insertsAfter = { line: headingLine, texts: desiredTexts };
		}
	} else {
		const existing = metaLineIndexes.map(i => String(lines[i] || ''));
		const same =
			existing.length === desiredTexts.length &&
			existing.every((t, i) => t === desiredTexts[i]);
		if (!same) {
			metaBlockReplace = {
				startLine: metaLineIndexes[0],
				endLineInclusive: lastStructuredLine,
				texts: desiredTexts
			};
		}
	}

	const unchanged =
		lineReplacements.length === 0 && !insertsAfter && !metaBlockReplace;

	return {
		titleLine: headingLine,
		titleText,
		lineReplacements,
		insertsAfter,
		metaBlockReplace,
		unchanged
	};
}

module.exports = {
	listStructuredMetaLines,
	buildHeadingTitleLine,
	buildDesiredMetaLines,
	planPersistentHeadingPatch,
	metaLineKey
};
