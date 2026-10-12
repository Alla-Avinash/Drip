'use strict';

/**
 * `.d.md` note metadata comments — parse, validate, and format the hidden HTML
 * comments that carry a heading's identity and metadata.
 *
 * A `.d.md` note keeps its metadata in a one-line HTML comment placed directly
 * under a persistent heading, so a plain markdown editor shows only clean text:
 *
 *     <!-- drip h12 | concept | status: in-progress | deadline: 2026-04-29 18:30 | tags: [a, b, c] -->
 *
 *   - `drip`     literal marker (case-insensitive)
 *   - `h12`      per-file heading number
 *   - `concept`  metadata type id (omitted for untyped headings)
 *   - `key: value` fields, split by `|`
 *
 * This module is pure string/schema logic. It never touches the database or the
 * legacy `.d.txt` hash identity, so it can be tested in isolation.
 */

const vscode = require('vscode');
const {
	getMetadataSettings,
	getTypeRule,
	matchHeadingTitleTypePrefix
} = require('./dripnoteMetadataTemplates');
const { isValidDurationValue } = require('../parse/dripnoteDuration');

/** `<!-- drip h12 | … -->` (the `h` token distinguishes it from the `drip-file` header). */
const HEADING_COMMENT_RE = /^<!--\s*drip\s+h(\d+)\b\s*(.*?)\s*-->$/i;

/** A field token without a `:` — the optional metadata type id. */
const TYPE_TOKEN_RE = /^[a-z][a-z0-9_-]*$/i;

/** An empty value, including an empty bracketed list (`tags: []`). */
const EMPTY_LIST_RE = /^\[\s*\]$/;

/**
 * @param {string} line
 * @returns {boolean}
 */
function isHeadingComment(line) {
	return HEADING_COMMENT_RE.test(String(line || '').trim());
}

/**
 * Split a comment body into trimmed, non-empty `|`-separated tokens.
 * @param {string} body
 * @returns {string[]}
 */
function splitBody(body) {
	return String(body || '')
		.split('|')
		.map(token => token.trim())
		.filter(Boolean);
}

/**
 * @typedef {{ key: string, value: string }} MdNoteField
 */

/**
 * Parse a heading comment into its heading number, type id, and ordered fields.
 *
 * The first token that has no `:` is treated as the type id (type ids never
 * contain `:`); every other token is a `key: value` field. Values may contain
 * `:` and spaces (e.g. `deadline: 2026-04-29 18:30`) but not `|`.
 *
 * @param {string} line
 * @returns {{ headingNum: number, typeId: string, fields: MdNoteField[] } | null}
 */
function parseHeadingComment(line) {
	const m = HEADING_COMMENT_RE.exec(String(line || '').trim());
	if (!m) return null;

	const headingNum = parseInt(m[1], 10);
	if (!Number.isFinite(headingNum) || headingNum < 0) return null;

	let typeId = '';
	/** @type {MdNoteField[]} */
	const fields = [];
	for (const token of splitBody(m[2])) {
		const colonAt = token.indexOf(':');
		if (colonAt < 0) {
			// No colon → type id. Only the first such token is honored; the heading
			// line is authoritative anyway, so later stray tokens are ignored.
			if (!typeId && TYPE_TOKEN_RE.test(token)) {
				typeId = token.toLowerCase();
			}
			continue;
		}
		const key = token.slice(0, colonAt).trim().toLowerCase();
		const value = token.slice(colonAt + 1).trim();
		if (!key) continue;
		fields.push({ key, value });
	}

	return { headingNum, typeId, fields };
}

/**
 * Format a clean heading comment.
 * @param {number} headingNum
 * @param {string} typeId
 * @param {MdNoteField[]} fields
 * @returns {string}
 */
function formatHeadingComment(headingNum, typeId, fields) {
	const parts = [`drip h${Math.max(0, Math.floor(Number(headingNum) || 0))}`];
	const type = String(typeId || '').trim().toLowerCase();
	if (type) parts.push(type);
	for (const field of fields || []) {
		parts.push(`${field.key}: ${field.value}`);
	}
	return `<!-- ${parts.join(' | ')} -->`;
}

/**
 * @param {string} value
 * @returns {boolean} true when the value carries nothing worth keeping
 */
function isEmptyValue(value) {
	const v = String(value || '').trim();
	if (!v) return true;
	return EMPTY_LIST_RE.test(v);
}

/**
 * Split a bracketed list value (`[a, b, c]`) into its trimmed, non-empty items.
 * @param {string} value
 * @returns {string[]}
 */
function parseTagList(value) {
	return String(value || '')
		.replace(/^\[|\]$/g, '')
		.split(',')
		.map(item => item.trim())
		.filter(Boolean);
}

/**
 * Strict canonical datetime check: `YYYY-MM-DD HH:mm` with real calendar ranges.
 * The chip picker always emits this shape, so anything else is a hand-edit to drop.
 * @param {string} value
 * @returns {boolean}
 */
function isCanonicalMinuteDateTime(value) {
	const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(value || '').trim());
	if (!m) return false;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const hour = Number(m[4]);
	const minute = Number(m[5]);
	const d = new Date(year, month - 1, day, hour, minute, 0, 0);
	return (
		d.getFullYear() === year &&
		d.getMonth() === month - 1 &&
		d.getDate() === day &&
		d.getHours() === hour &&
		d.getMinutes() === minute
	);
}

/**
 * @param {{ kind?: string, values?: string[] }} rule
 * @param {string} value
 * @returns {boolean}
 */
function isValueValidForRule(rule, value) {
	const kind = String((rule && rule.kind) || 'enum').toLowerCase();
	if (kind === 'enum') {
		const allowed = (Array.isArray(rule.values) ? rule.values : []).map(v => String(v).toLowerCase());
		if (!allowed.length) return true; // empty enum = no constraint (e.g. free domain)
		return allowed.includes(value.toLowerCase());
	}
	if (kind === 'datetime') {
		return isCanonicalMinuteDateTime(value);
	}
	if (kind === 'duration') {
		return isValidDurationValue(value);
	}
	if (kind === 'issue_parent') {
		const m = String(value || '').trim().match(/^i-(\d+)$/i);
		const n = m ? parseInt(m[1], 10) : NaN;
		return !!m && Number.isFinite(n) && n >= 1;
	}
	return true;
}

/**
 * Extra metadata keys the user allowed outside any type (same setting `.d.txt` uses).
 * @returns {Set<string>}
 */
function getConfiguredAllowedMetadataKeys() {
	const cfg = vscode.workspace.getConfiguration('drip');
	const raw = cfg.get('dripnoteAllowedMetadataKeys', []);
	const out = new Set();
	for (const item of Array.isArray(raw) ? raw : []) {
		const key = String(item || '').trim().toLowerCase();
		if (key) out.add(key);
	}
	return out;
}

/**
 * Validate a heading comment against its own type.
 *
 * Rules (mirroring the `.d.txt` diagnostics, applied one-time on file open):
 *   - The comment's type token is the authority; fields that don't belong to that type
 *     are dropped. A comment with no type falls back to the legacy heading-line prefix.
 *   - Unknown keys (not a type attribute, relation, or allowed custom key) are removed.
 *   - Empty values (including `[]`) are removed.
 *   - enum / datetime / duration / issue_parent values that fail their rule are removed.
 *   - `tags` items not present in the note's tag graph are removed (when a known set is
 *     supplied); a `tags` field left empty by that is dropped.
 *
 * @param {string} commentLine the raw `<!-- drip … -->` line
 * @param {string} headingLine the heading line above it (e.g. `# My Concept`)
 * @param {Set<string>} [knownTagsLower] lowercase tag labels valid for this note's graph
 * @returns {{ text: string | null, changed: boolean, removed: string[] }}
 *   `text` is `null` when the line is not a heading comment (caller leaves it alone).
 */
function validateHeadingComment(commentLine, headingLine, knownTagsLower) {
	const parsed = parseHeadingComment(commentLine);
	if (!parsed) return { text: null, changed: false, removed: [] };

	const settings = getMetadataSettings();
	// Type authority: the comment itself. In the `.d.md` format the heading line carries
	// no type prefix (`# .c Foo`), so the type lives only in the comment — `persistent`
	// for untyped-but-indexed headings. Fall back to the legacy heading-line prefix only
	// when the comment has no type yet (pre-migration notes still using `.c`/`.task`/`.i-N`).
	let authoritativeType = String(parsed.typeId || '').toLowerCase();
	if (!authoritativeType) {
		const headingMatch = matchHeadingTitleTypePrefix(headingLine, settings);
		authoritativeType = headingMatch.typeId ? String(headingMatch.typeId).toLowerCase() : '';
	}

	const relationKeys = settings.allowedRelations || new Set();
	const customKeys = getConfiguredAllowedMetadataKeys();

	let typeChanged = parsed.typeId !== authoritativeType;
	/** @type {string[]} */
	const removed = [];
	/** @type {MdNoteField[]} */
	const kept = [];

	for (const field of parsed.fields) {
		const rule = authoritativeType ? getTypeRule(settings, authoritativeType, field.key) : null;

		/** @type {'attribute' | 'relation' | 'custom' | 'unknown'} */
		let category = 'unknown';
		if (rule) category = 'attribute';
		else if (relationKeys.has(field.key)) category = 'relation';
		else if (customKeys.has(field.key)) category = 'custom';

		if (category === 'unknown') {
			removed.push(field.key);
			continue;
		}
		if (isEmptyValue(field.value)) {
			removed.push(field.key);
			continue;
		}
		// Tags: drop any item that no longer exists in the note's tag graph (deleted
		// tags). Only applied when a known set is supplied and non-empty — an empty graph
		// means "nothing to validate against", so the field is left alone.
		if (category === 'relation' && field.key === 'tags' && knownTagsLower && knownTagsLower.size) {
			const items = parseTagList(field.value);
			const keptItems = items.filter(item => knownTagsLower.has(item.toLowerCase()));
			if (keptItems.length !== items.length) {
				if (keptItems.length === 0) {
					removed.push(field.key);
					continue;
				}
				kept.push({ key: field.key, value: `[${keptItems.join(', ')}]` });
				continue;
			}
		}
		if (category === 'attribute' && !isValueValidForRule(rule, field.value)) {
			removed.push(field.key);
			continue;
		}
		kept.push(field);
	}

	if (!typeChanged && removed.length === 0) {
		return { text: commentLine, changed: false, removed: [] };
	}

	return {
		text: formatHeadingComment(parsed.headingNum, authoritativeType, kept),
		changed: true,
		removed
	};
}

module.exports = {
	isHeadingComment,
	parseHeadingComment,
	formatHeadingComment,
	validateHeadingComment
};
