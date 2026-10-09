'use strict';

/**
 * Logical issue parent (`parent: i-N`) rules — one place for RHS, diagnostics, index, Project View.
 *
 * - Locked: issue sits inside another issue's indented section in the same file → parent is that
 *   issue (nearest outline ancestor issue; plain headings in between are skipped; sections end as
 *   in `issueInboxLayout.sectionEnd`, so text at the parent's indent closes it). Implied only:
 *   no `parent:` line is written and the RHS hides the field.
 * - Free: no issue above it in the outline → optional `parent:` may be any existing issue in
 *   the same project (any file / feature / folder), except itself or its own sub-issues.
 */

const {
	ISSUE_PARENT_META_KEY,
	parseIssueTitleEntityId,
	parseIssueTypePrefix,
	normalizeIssueEntityId
} = require('./projectStructureRules');

/**
 * Issue id from a heading title (`.i-4 Fix`, legacy `.i i-4 Fix`, or index form `i-4 Fix`).
 * @param {string} title
 * @returns {string | null}
 */
function issueIdFromHeadingTitle(title) {
	const t = String(title || '').trim();
	const prefixMatch = t.match(/^(\.i-\d+)\b/i);
	if (prefixMatch) {
		const id = parseIssueTypePrefix(prefixMatch[1]);
		if (id) return id;
	}
	const legacy = parseIssueTitleEntityId(t.replace(/^\.i\s+/i, '').trim());
	return legacy ? legacy.id : null;
}

/**
 * Nearest outline-ancestor issue id (`i-N`) for a heading line, or null.
 *
 * @param {string} docText
 * @param {number} targetHeadingLine 0-based
 * @returns {string | null}
 */
function findNearestOutlineAncestorIssueId(docText, targetHeadingLine) {
	const { parseHeadingForValidation } = require('../parse/dripnoteHeadingParse');
	const { outlineParentsByLine } = require('./issueInboxLayout');
	const target = Math.floor(Number(targetHeadingLine));
	if (!Number.isFinite(target) || target < 0) return null;
	const lines = String(docText || '')
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.split('\n')
		.slice(0, target + 1);
	/** @type {Map<number, string | null>} heading line → issue id (null for plain headings) */
	const issueIdByLine = new Map();
	lines.forEach((line, i) => {
		const ph = parseHeadingForValidation(line);
		if (ph && !ph.usesNonTabIndent) issueIdByLine.set(i, issueIdFromHeadingTitle(ph.title));
	});
	if (!issueIdByLine.has(target)) return null;
	const parents = outlineParentsByLine(lines, new Set(issueIdByLine.keys()));
	let cur = parents.get(target);
	while (cur != null) {
		const id = issueIdByLine.get(cur);
		if (id) return id;
		cur = parents.get(cur);
	}
	return null;
}

/**
 * Same walk as above, over index rows (heading_id → outline parent heading_id).
 *
 * @param {number} headingId
 * @param {Map<number, number|null|undefined>} parentByHeadingId
 * @param {Map<number, string>} issueKeyByHeadingId issue headings only
 * @returns {string | null}
 */
function nearestOutlineParentIssueKey(headingId, parentByHeadingId, issueKeyByHeadingId) {
	const start = Math.floor(Number(headingId));
	if (!Number.isFinite(start)) return null;
	let cur = parentByHeadingId.get(start);
	const seen = new Set();
	while (cur != null && Number.isFinite(Number(cur)) && !seen.has(Number(cur))) {
		const id = Math.floor(Number(cur));
		seen.add(id);
		const key = issueKeyByHeadingId.get(id);
		if (key) return normalizeIssueEntityId(key);
		cur = parentByHeadingId.get(id);
	}
	return null;
}

/**
 * Nested issues get their parent from indentation, so `parent:` is dropped (never repeated).
 * Free issues keep whatever the user set (optional).
 *
 * @param {Record<string, unknown>} attributes
 * @param {string} docText
 * @param {number} headingLine
 * @returns {Record<string, unknown>}
 */
function ensureIssueParentAttribute(attributes, docText, headingLine) {
	const attrs = attributes && typeof attributes === 'object' ? { ...attributes } : {};
	if (findNearestOutlineAncestorIssueId(docText, headingLine)) {
		attrs[ISSUE_PARENT_META_KEY] = '';
		return attrs;
	}
	const existing = normalizeIssueEntityId(String(attrs[ISSUE_PARENT_META_KEY] || ''));
	attrs[ISSUE_PARENT_META_KEY] = existing || String(attrs[ISSUE_PARENT_META_KEY] || '').trim();
	return attrs;
}

/**
 * Keys that are `selfKey` or below it in the issue tree (cannot become its parent).
 *
 * @param {string} selfKey
 * @param {{ issueKey: string, parentIssueKey: string | null }[]} issues
 * @returns {Set<string>}
 */
function collectSelfAndDescendants(selfKey, issues) {
	const self = normalizeIssueEntityId(selfKey);
	/** @type {Set<string>} */
	const out = new Set();
	if (!self) return out;
	/** @type {Map<string, string[]>} */
	const children = new Map();
	for (const iss of issues || []) {
		const k = normalizeIssueEntityId(iss.issueKey);
		const p = normalizeIssueEntityId(iss.parentIssueKey || '');
		if (!k || !p) continue;
		if (!children.has(p)) children.set(p, []);
		children.get(p).push(k);
	}
	const queue = [self];
	while (queue.length) {
		const k = /** @type {string} */ (queue.shift());
		if (out.has(k)) continue;
		out.add(k);
		for (const c of children.get(k) || []) queue.push(c);
	}
	return out;
}

/**
 * @param {{
 *   selfKey: string | null,
 *   candidate: string,
 *   lockedParent: string | null,
 *   projectIssues: { issueKey: string, parentIssueKey: string | null }[]
 * }} args
 * @returns {{ ok: boolean, value: string, error?: string }}
 */
function validateIssueParentChoice(args) {
	const raw = String(args.candidate || '').trim();
	if (args.lockedParent) {
		const locked = normalizeIssueEntityId(args.lockedParent) || args.lockedParent;
		if (!raw || normalizeIssueEntityId(raw) === locked) return { ok: true, value: '' };
		return {
			ok: false,
			value: '',
			error: `Parent is set by indentation (${locked}). Outdent this issue to choose a different parent.`
		};
	}
	if (!raw) return { ok: true, value: '' };
	const key = normalizeIssueEntityId(raw);
	if (!key) {
		return { ok: false, value: '', error: `"${raw}" is not an issue id. Use i-N (e.g. i-12).` };
	}
	const self = normalizeIssueEntityId(args.selfKey || '');
	if (self && key === self) {
		return { ok: false, value: '', error: 'An issue cannot be its own parent.' };
	}
	const known = new Set(
		(args.projectIssues || []).map(i => normalizeIssueEntityId(i.issueKey)).filter(Boolean)
	);
	if (!known.has(key)) {
		return { ok: false, value: '', error: `${key} is not an issue in this project.` };
	}
	if (self && collectSelfAndDescendants(self, args.projectIssues).has(key)) {
		return {
			ok: false,
			value: '',
			error: `${key} is a sub-issue of ${self} — choosing it would create a loop.`
		};
	}
	return { ok: true, value: key };
}

/**
 * Drop parents that don't resolve (missing, self, or part of a loop) so the tree stays valid.
 * Mutates `parentIssueKey` on the given rows.
 *
 * @param {{ issueKey: string | null, parentIssueKey: string | null }[]} issues
 */
function sanitizeIssueParents(issues) {
	/** @type {Map<string, { issueKey: string | null, parentIssueKey: string | null }>} */
	const byKey = new Map();
	for (const iss of issues || []) {
		const k = normalizeIssueEntityId(iss.issueKey || '');
		if (k) byKey.set(k, iss);
	}
	for (const iss of issues || []) {
		const self = normalizeIssueEntityId(iss.issueKey || '');
		const p = normalizeIssueEntityId(iss.parentIssueKey || '');
		if (!p || !byKey.has(p) || p === self) {
			iss.parentIssueKey = null;
			continue;
		}
		iss.parentIssueKey = p;
	}
	for (const iss of issues || []) {
		const self = normalizeIssueEntityId(iss.issueKey || '');
		if (!self || !iss.parentIssueKey) continue;
		const seen = new Set([self]);
		let cur = byKey.get(iss.parentIssueKey);
		while (cur && cur.parentIssueKey) {
			const ck = normalizeIssueEntityId(cur.issueKey || '');
			if (!ck || seen.has(ck)) break;
			seen.add(ck);
			if (cur.parentIssueKey === self) {
				iss.parentIssueKey = null;
				break;
			}
			cur = byKey.get(cur.parentIssueKey);
		}
	}
}

/**
 * Write (or replace) the `parent: i-N` line in an issue heading's metadata block.
 * Returns a new lines array; unchanged copy when the heading has no metadata marker.
 *
 * @param {string[]} lines
 * @param {number} headingLine
 * @param {string} parentId
 * @returns {string[]}
 */
function setIssueParentLineInLines(lines, headingLine, parentId) {
	const out = (lines || []).slice();
	const id = normalizeIssueEntityId(parentId);
	if (!id) return out;
	const head = String(out[headingLine] || '');
	const tabs = (head.match(/^(\t*)/) || ['', ''])[1];
	let markerIdx = -1;
	let parentIdx = -1;
	let lastMeta = -1;
	for (let j = headingLine + 1; j < out.length; j++) {
		const raw = String(out[j] || '');
		const tr = raw.trim();
		if (!tr) {
			if (lastMeta >= 0) break;
			continue;
		}
		if (/^\s*#{1,6}\s/.test(raw) || /^\s*@/.test(raw)) break;
		if (tr.startsWith('//')) continue;
		if (!/^(\.[a-z]|[a-z][a-z0-9_-]*\s*:|\[)/i.test(tr)) break;
		if (/^\.issue\b/i.test(tr)) markerIdx = j;
		if (/^parent\s*:/i.test(tr) && parentIdx < 0) parentIdx = j;
		lastMeta = j;
	}
	if (markerIdx < 0) return out;
	if (parentIdx >= 0) {
		const ind = (String(out[parentIdx]).match(/^(\s*)/) || ['', ''])[1];
		out[parentIdx] = `${ind}${ISSUE_PARENT_META_KEY}: ${id}`;
		return out;
	}
	const markerInd = (String(out[markerIdx]).match(/^(\t*)/) || ['', `${tabs}\t`])[1];
	out.splice(lastMeta + 1, 0, `${markerInd}\t${ISSUE_PARENT_META_KEY}: ${id}`);
	return out;
}

module.exports = {
	issueIdFromHeadingTitle,
	findNearestOutlineAncestorIssueId,
	nearestOutlineParentIssueKey,
	ensureIssueParentAttribute,
	collectSelfAndDescendants,
	validateIssueParentChoice,
	sanitizeIssueParents,
	setIssueParentLineInLines
};
