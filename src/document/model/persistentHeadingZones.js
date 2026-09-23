'use strict';

const { parseHeadingForValidation } = require('../parse/dripnoteCanvasParse');
const { classifyPersistentHeadingTitle } = require('./dripnotePersistentHeading');
const {
	getMetadataSettings,
	matchHeadingTitleTypePrefix,
	HEADING_SPECIAL_KEYS
} = require('./dripnoteMetadataTemplates');
const { parseHeadingIdentityLine } = require('../../indexing/dripnoteHeadingIdentity');

/**
 * @param {string} line
 * @returns {boolean}
 */
function isStructuredMetadataLine(line) {
	const t = String(line || '').trim();
	if (!t || t.startsWith('//')) return false;
	if (/^\.[a-zA-Z][a-zA-Z0-9_-]*\b/.test(t)) return true;
	if (/^\[[^\]]*\]\s*$/.test(t)) return true;
	if (/^[a-zA-Z][a-zA-Z0-9_-]*\s*:/.test(t)) return true;
	return false;
}

/**
 * Exclusive end index after the last contiguous structured meta line under a heading.
 * Leading blank lines after the heading are skipped and are NOT part of the lock span.
 * Trailing blanks / body / next heading stop the scan — those lines are never locked or rewritten.
 * @param {string[]} lines
 * @param {number} headingLine
 * @returns {number}
 */
function findMetadataBlockEndExclusive(lines, headingLine) {
	let j = headingLine + 1;
	let end = headingLine + 1;
	let sawMeta = false;
	while (j < lines.length) {
		const raw = String(lines[j] || '');
		const tr = raw.trim();
		if (parseHeadingForValidation(raw)) break;
		if (/^\s*@+/.test(raw) || parseHeadingIdentityLine(raw)) break;
		if (!tr || tr.startsWith('//')) {
			if (sawMeta) break;
			j += 1;
			continue;
		}
		if (!isStructuredMetadataLine(raw)) break;
		sawMeta = true;
		j += 1;
		end = j;
	}
	return end;
}

/**
 * @param {string} metaLine
 * @returns {{ kind: 'kv'|'tags'|'relation'|'type'|'other', key?: string, value?: string, tags?: string[] }}
 */
function classifyMetaLine(metaLine) {
	const t = String(metaLine || '').trim();
	if (/^\.[a-zA-Z][a-zA-Z0-9_-]*\b/.test(t) && !t.includes(':')) {
		return { kind: 'type', value: t };
	}
	const shorthand = t.match(/^\[([^\]]*)\]\s*$/);
	if (shorthand) {
		const tags = String(shorthand[1] || '')
			.split(',')
			.map(x => x.trim())
			.filter(Boolean);
		return { kind: 'tags', key: 'tags', tags };
	}
	const kv = t.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
	if (kv) {
		const key = String(kv[1] || '').toLowerCase();
		const rest = String(kv[2] || '').trim();
		const list = rest.match(/^\[([^\]]*)\]\s*$/);
		if (list) {
			const tags = String(list[1] || '')
				.split(',')
				.map(x => x.trim())
				.filter(Boolean);
			if (key === 'tags') return { kind: 'tags', key, tags };
			return { kind: 'relation', key, tags };
		}
		return { kind: 'kv', key, value: rest };
	}
	return { kind: 'other', value: t };
}

/**
 * Title text after `#` markers — keeps trailing spaces (parseHeadingForValidation trims them away).
 * @param {string} headingLine
 * @returns {string}
 */
function rawTitleFromHeadingLine(headingLine) {
	const m = String(headingLine || '').match(/^(\s*)(#{1,6})\s+(.*)$/);
	return m ? String(m[3] || '') : '';
}

/**
 * Split persistent title into type prefix + display text.
 * Pass `rawTitle` (untrimmed) so a trailing space after `.c` / `.` counts as ready for RHS.
 * @param {string} title trimmed title (from parseHeadingForValidation)
 * @param {string} [rawTitle] optional raw title after `# ` (may end with spaces)
 * @returns {{ typePrefix: string, titleDisplay: string, readyForRhs: boolean }}
 */
function splitPersistentHeadingTitle(title, rawTitle) {
	const raw = rawTitle != null ? String(rawTitle) : String(title || '');
	const t = String(title || '').trim();
	const readyFromRaw =
		/^\.\s/.test(raw) || /^\.([A-Za-z][A-Za-z0-9_-]*)(#|\d+)?\s/.test(raw);

	if (!t.startsWith('.')) {
		return { typePrefix: '', titleDisplay: t, readyForRhs: false };
	}
	if (t === '.') {
		return { typePrefix: '.', titleDisplay: '', readyForRhs: readyFromRaw };
	}
	if (/^\.\s/.test(t) || /^\.\s/.test(raw)) {
		return {
			typePrefix: '.',
			titleDisplay: t.replace(/^\.\s*/, '').trim() || raw.replace(/^\.\s*/, '').trim(),
			readyForRhs: true
		};
	}
	const m = t.match(/^(\.([A-Za-z][A-Za-z0-9_-]*)(#|\d+)?)(?:\s+|$)(.*)$/);
	const mRaw = raw.match(/^(\.([A-Za-z][A-Za-z0-9_-]*)(#|\d+)?)(\s+)(.*)$/);
	if (mRaw) {
		return {
			typePrefix: mRaw[1],
			titleDisplay: String(mRaw[5] || '').trim(),
			readyForRhs: true
		};
	}
	if (m && readyFromRaw) {
		return {
			typePrefix: m[1],
			titleDisplay: String(m[4] || '').trim(),
			readyForRhs: true
		};
	}
	const incomplete = t.match(/^(\.([A-Za-z][A-Za-z0-9_-]*)(#|\d+)?)$/);
	if (incomplete) {
		return { typePrefix: incomplete[1], titleDisplay: '', readyForRhs: readyFromRaw };
	}
	return {
		typePrefix: '.',
		titleDisplay: t.replace(/^\./, '').trim(),
		readyForRhs: readyFromRaw
	};
}

/**
 * @param {string} titleOrHeadingLine trimmed title or full heading line
 * @returns {boolean}
 */
function isPersistentHeadingReadyForRhs(titleOrHeadingLine) {
	const s = String(titleOrHeadingLine || '');
	if (/^\s*#{1,6}\s+/.test(s)) {
		const ph = parseHeadingForValidation(s);
		return splitPersistentHeadingTitle(ph ? ph.title : '', rawTitleFromHeadingLine(s)).readyForRhs;
	}
	return splitPersistentHeadingTitle(s, s).readyForRhs;
}

/**
 * @typedef {{
 *   headingLine: number,
 *   identityLine: number,
 *   lockStart: number,
 *   lockEndExclusive: number,
 *   safeLineAfter: number,
 *   level: number,
 *   tabDepth: number,
 *   titleRaw: string,
 *   titleDisplay: string,
 *   typePrefix: string,
 *   readyForRhs: boolean,
 *   typeId: string | null,
 *   persistent: boolean,
 *   identityText: string,
 *   attributes: Record<string, string>,
 *   tags: string[],
 *   relations: { type: string, tags: string[] }[],
 *   special: Record<string, string>
 * }} PersistentHeadingZone
 */

/**
 * @param {string} text
 * @param {{ types?: any[], typeByMarker?: Map<string, any>, typeByShortcut?: Map<string, any> }} [settings]
 * @returns {PersistentHeadingZone[]}
 */
function findPersistentHeadingZones(text, settings) {
	const s = settings || getMetadataSettings();
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	/** @type {PersistentHeadingZone[]} */
	const out = [];

	for (let i = 0; i < lines.length; i++) {
		const ph = parseHeadingForValidation(lines[i]);
		if (!ph) continue;
		const classification = classifyPersistentHeadingTitle(ph.title, s);
		if (!classification.persistent) continue;

		const matched = matchHeadingTitleTypePrefix(ph.title, s);
		let identityLine = -1;
		if (i > 0 && parseHeadingIdentityLine(lines[i - 1])) {
			identityLine = i - 1;
		}
		const lockStart = identityLine >= 0 ? identityLine : i;
		const lockEndExclusive = findMetadataBlockEndExclusive(lines, i);
		const safeLineAfter = lockEndExclusive;

		/** @type {Record<string, string>} */
		const attributes = {};
		/** @type {string[]} */
		let tags = [];
		/** @type {{ type: string, tags: string[] }[]} */
		const relations = [];
		/** @type {Record<string, string>} */
		const special = {};

		for (let j = i + 1; j < lockEndExclusive; j++) {
			const c = classifyMetaLine(lines[j]);
			if (c.kind === 'tags') {
				tags = c.tags || [];
			} else if (c.kind === 'relation' && c.key) {
				relations.push({ type: c.key, tags: c.tags || [] });
			} else if (c.kind === 'kv' && c.key) {
				if (HEADING_SPECIAL_KEYS.has(c.key)) {
					special[c.key] = String(c.value || '');
				} else {
					attributes[c.key] = String(c.value || '');
				}
			}
		}

		const rawTitle = rawTitleFromHeadingLine(lines[i]);
		const split = splitPersistentHeadingTitle(ph.title, rawTitle);
		// Prefer classified type; fall back to prefix match so RHS gets template fields for `.c` / `.t1` / `.c#`.
		let typeId = classification.metadataType || null;
		if (!typeId && matched.typeId && !matched.invalid) {
			typeId = matched.typeId;
		}
		if (!typeId && split.typePrefix && split.typePrefix !== '.') {
			const again = matchHeadingTitleTypePrefix(split.typePrefix, s);
			if (again.typeId && !again.invalid) typeId = again.typeId;
		}

		out.push({
			headingLine: i,
			identityLine,
			lockStart,
			lockEndExclusive,
			safeLineAfter,
			level: ph.level,
			tabDepth: ph.tabDepth,
			titleRaw: ph.title,
			titleDisplay: split.titleDisplay,
			typePrefix: split.typePrefix,
			readyForRhs: split.readyForRhs,
			typeId: typeId ? String(typeId).trim().toLowerCase() : null,
			persistent: true,
			identityText: identityLine >= 0 ? String(lines[identityLine] || '').trim() : '',
			attributes,
			tags,
			relations,
			special
		});
	}
	return out;
}

/**
 * @param {string} text
 * @param {number} lineIndex
 * @param {{ types?: any[] }} [settings]
 * @returns {PersistentHeadingZone | null}
 */
function findPersistentZoneAtLine(text, lineIndex, settings) {
	const zones = findPersistentHeadingZones(text, settings);
	const line = Math.max(0, Number(lineIndex) || 0);
	for (const z of zones) {
		if (!z.persistent) continue;
		if (line === z.headingLine) return z;
		if (z.identityLine >= 0 && line === z.identityLine) return z;
		// Structured meta only — blank gaps between heading and meta are not "in zone".
		if (line > z.headingLine && line < z.lockEndExclusive) {
			const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
			if (isStructuredMetadataLine(lines[line])) return z;
		}
	}
	return null;
}

/**
 * Serialize form model back into heading + metadata lines (no identity line).
 * @param {{
 *   level: number,
 *   tabDepth: number,
 *   typeId: string | null,
 *   typePrefix?: string,
 *   titleDisplay: string,
 *   attributes: Record<string, string>,
 *   tags: string[],
 *   relations: { type: string, tags: string[] }[],
 *   special?: Record<string, string>
 * }} model
 * @param {{ types?: any[], typeById?: Map<string, any> }} settings
 * @returns {string[]}
 */
function serializePersistentHeadingBlock(model, settings) {
	const s = settings || getMetadataSettings();
	const level = Math.min(6, Math.max(1, Number(model.level) || 1));
	const tabs = '\t'.repeat(Math.max(0, Number(model.tabDepth) || 0));
	const typeId = String(model.typeId || '').trim().toLowerCase();
	const typeDef =
		(s.typeById && s.typeById.get(typeId)) ||
		(s.types || []).find(t => String(t.id || '').toLowerCase() === typeId);
	let prefix = '.';
	if (typeDef) {
		const sc = String(typeDef.shortcut || '').trim();
		prefix = sc ? (sc.startsWith('.') ? sc : `.${sc}`) : String(typeDef.marker || `.${typeId}`);
	} else if (typeId) {
		prefix = `.${typeId}`;
	}
	const titlePart = String(model.titleDisplay || '').trim();
	const titleLine = `${tabs}${'#'.repeat(level)} ${prefix}${titlePart ? ` ${titlePart}` : ' '}`;

	const metaIndent = `${tabs}\t`;
	const attrIndent = `${tabs}\t\t`;
	/** @type {string[]} */
	const meta = [];
	if (typeDef) {
		const marker = String(typeDef.marker || `.${typeId}`).trim();
		if (marker) meta.push(`${metaIndent}${marker}`);
	} else if (typeId) {
		meta.push(`${metaIndent}.${typeId}`);
	}
	const special = model.special && typeof model.special === 'object' ? model.special : {};
	for (const key of Object.keys(special)) {
		const v = String(special[key] || '').trim();
		if (v) meta.push(`${attrIndent}${key}: ${v}`);
	}
	const attrs = model.attributes && typeof model.attributes === 'object' ? model.attributes : {};
	const attrKeys =
		typeDef && typeDef.attributes
			? Object.keys(typeDef.attributes)
			: Object.keys(attrs);
	for (const key of attrKeys) {
		const v = String(attrs[key] != null ? attrs[key] : '').trim();
		if (v) meta.push(`${attrIndent}${key}: ${v}`);
	}
	for (const key of Object.keys(attrs)) {
		if (attrKeys.includes(key)) continue;
		const v = String(attrs[key] || '').trim();
		if (v) meta.push(`${attrIndent}${key}: ${v}`);
	}
	const tags = Array.isArray(model.tags) ? model.tags.map(t => String(t || '').trim()).filter(Boolean) : [];
	if (tags.length) meta.push(`${metaIndent}tags: [${tags.join(', ')}]`);
	const rels = Array.isArray(model.relations) ? model.relations : [];
	for (const r of rels) {
		const rt = String(r && r.type ? r.type : '')
			.trim()
			.toLowerCase();
		if (!rt || rt === 'tags') continue;
		const rts = Array.isArray(r.tags) ? r.tags.map(t => String(t || '').trim()).filter(Boolean) : [];
		if (!rts.length) continue;
		meta.push(`${metaIndent}${rt}: [${rts.join(', ')}]`);
	}
	return [titleLine, ...meta];
}

/**
 * Count persistent headings in text.
 * @param {string} text
 * @returns {number}
 */
function countPersistentHeadings(text) {
	return findPersistentHeadingZones(text).length;
}

module.exports = {
	findPersistentHeadingZones,
	findPersistentZoneAtLine,
	findMetadataBlockEndExclusive,
	serializePersistentHeadingBlock,
	countPersistentHeadings,
	isStructuredMetadataLine,
	classifyMetaLine,
	splitPersistentHeadingTitle,
	isPersistentHeadingReadyForRhs,
	rawTitleFromHeadingLine
};
