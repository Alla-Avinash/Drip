'use strict';

/**
 * Single source of truth for how a DRIP note is split into colored tokens.
 *
 * One pass walks the document and emits a flat list of non-overlapping tokens, each
 * tagged with a role. Callers paint these roles however they like:
 *   - the semantic-token provider maps role -> theme palette scope (theme default)
 *   - the decoration overlay maps role -> a user-overridden hex color (Doc Coloring)
 *
 * Roles:
 *   type           = metadata type name/shortcut (`.concept`, `.c`, `c`)      color1
 *   heading        = heading line text (bold)                                 color2
 *   metakey        = metadata keys (status, deadline, …)                       color3
 *   relationkey    = tag/relation keys (tags, pre-req, …)                      color4
 *   metavalue      = heading-special values + `---` separator                  color5
 *   fileidentity   = file-level identity fields (filename, fileid, headings)   color6
 *   identityvalue  = file identity values (filename/fileid/headings values)    color7
 *   typedvalue     = metadata type field values (status/deadline values)       color8
 *   relationvalue  = tag/relation list values (tags/pre-req list values)       color9
 */

const { getMetadataSettingsForIndex, matchHeadingTitleTypePrefix, HEADING_SPECIAL_KEYS } = require('../../document/model/dripnoteMetadataTemplates');

const HEADING_RE = /^\s*#\d*\s+/;
const SHORTHAND_TAGS_RE = /^\s*\[([^\]]*)\]\s*$/;
const FILE_IDENTITY_RE = /^\s*(filename|created|random|fileid|headings)\s*:\s*(.+)$/i;
const COMMENT_RE = /^\s*\/\//;

function push(tokens, line, start, length, role, bold) {
	if (!length || length <= 0 || start < 0) return;
	tokens.push({ line, start, length, role, bold: !!bold });
}

function leadingWhitespaceCount(line) {
	const m = String(line || '').match(/^\s*/);
	return m ? m[0].length : 0;
}

function getCustomTypeMarkers() {
	const raw = getConfig('dripnoteCustomTypeMarkers', []);
	const out = new Set(['concept', 'task', 'project', 'p', 't']);
	const meta = getMetadataSettingsForIndex();
	for (const t of meta.types || []) {
		const marker = String(t.marker || '').trim().toLowerCase().replace(/^\./, '');
		if (marker) out.add(marker);
		const shortcut = String(t.shortcut || '').trim().replace(/^\./, '');
		if (shortcut) out.add(shortcut);
	}
	for (const x of Array.isArray(raw) ? raw : []) {
		const k = String(x || '').trim().toLowerCase().replace(/^\./, '');
		if (k) out.add(k);
	}
	return out;
}

function getTypedFieldKeys() {
	const out = new Set(['status', 'deadline', 'priority']);
	const meta = getMetadataSettingsForIndex();
	for (const t of meta.types || []) {
		const attrs = t && t.attributes && typeof t.attributes === 'object' ? t.attributes : {};
		for (const key of Object.keys(attrs)) {
			const k = String(key || '').trim().toLowerCase();
			if (k) out.add(k);
		}
	}
	return out;
}

function getAllowedRelationKeys() {
	const relCfg = getConfig('tagsRelationsConfig', {});
	const out = new Set(['tags', 'pre-req']);
	for (const x of Array.isArray(relCfg && relCfg.allowed) ? relCfg.allowed : []) {
		const k = String(x || '').trim().toLowerCase();
		if (k && !['filename', 'created', 'fileid', 'headings'].includes(k)) out.add(k);
	}
	for (const row of Array.isArray(relCfg && relCfg.relations) ? relCfg.relations : []) {
		const k = String((row && row.name) || '').trim().toLowerCase();
		if (k && !['filename', 'created', 'fileid', 'headings'].includes(k)) out.add(k);
	}
	return out;
}

function getConfig(key, fallback) {
	const cfg = require('vscode').workspace.getConfiguration('drip');
	return cfg.get(key, fallback);
}

function isHeadingTypeLine(line, typeSet) {
	const matched = matchHeadingTitleTypePrefix(line, getMetadataSettingsForIndex());
	if (matched.typeId) return true;
	const trimmed = String(line || '').trim();
	if (!HEADING_RE.test(trimmed)) return false;
	for (const t of typeSet) {
		const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const re = new RegExp(`^\\s*#\\d*\\s+(?:\\.${esc}\\b|${esc}\\.)`);
		if (re.test(line)) return true;
	}
	return false;
}

/**
 * Plain heading shortcuts are display-only type hints (`# c Title`).
 * They do not create a typed metadata context or make the heading persistent.
 */
function matchPlainHeadingShortcut(line, settings) {
	const heading = String(line || '').match(/^\s*#\d*\s+([A-Za-z][A-Za-z0-9_-]*)(?=\s|$)/);
	if (!heading) return '';
	const token = String(heading[1] || '');
	const shortcuts = [...(settings.typeByShortcut?.keys() || [])]
		.map(value => String(value || ''))
		.filter(value => value && !value.includes('.'))
		.sort((a, b) => b.length - a.length);
	for (const shortcut of shortcuts) {
		if (token === shortcut) return token;
		const suffix = token.slice(shortcut.length);
		if (token.startsWith(shortcut) && /^\d+$/.test(suffix)) return token;
	}
	return '';
}

/**
 * Emit a heading line: the whole line (including `#` and the marker/shortcut) is bold.
 * The marker keeps its own type color; the `#` prefix and title take the heading color.
 */
function emitHeading(tokens, lineNo, line, settings) {
	const hashIdx = line.indexOf('#');
	if (hashIdx < 0) return;

	let markerStart = -1;
	let markerLen = 0;
	const matched = matchHeadingTitleTypePrefix(line, settings);
	if (matched.matchedPrefix) {
		const idx = line.indexOf(matched.matchedPrefix);
		if (idx >= 0) {
			markerStart = idx;
			markerLen = matched.matchedPrefix.length;
		}
	} else {
		const plainShortcut = matchPlainHeadingShortcut(line, settings);
		if (plainShortcut) {
			const idx = line.indexOf(plainShortcut);
			if (idx >= 0) {
				markerStart = idx;
				markerLen = plainShortcut.length;
			}
		} else {
			const headingMarker = line.match(/^\s*#\d*\s+(\.[a-zA-Z][a-zA-Z0-9_-]*)\b/);
			if (headingMarker) {
				const marker = String(headingMarker[1] || '');
				const idx = line.indexOf(marker);
				if (idx >= 0) {
					markerStart = idx;
					markerLen = marker.length;
				}
			}
		}
	}

	if (markerStart >= 0 && markerLen > 0) {
		if (markerStart > hashIdx) {
			push(tokens, lineNo, hashIdx, markerStart - hashIdx, 'heading', true);
		}
		push(tokens, lineNo, markerStart, markerLen, 'type', true);
		const titleStart = markerStart + markerLen;
		if (titleStart < line.length) {
			push(tokens, lineNo, titleStart, line.length - titleStart, 'heading', true);
		}
	} else {
		push(tokens, lineNo, hashIdx, line.length - hashIdx, 'heading', true);
	}
}

function addKeyValueTokens(tokens, lineNo, line, key, keyRole, valueRole) {
	const idx = line.toLowerCase().indexOf(String(key || '').toLowerCase());
	if (idx >= 0) {
		push(tokens, lineNo, idx, String(key).length, keyRole, false);
	}
	const colonIdx = line.indexOf(':');
	if (colonIdx >= 0 && colonIdx + 1 < line.length) {
		const value = line.slice(colonIdx + 1).trim();
		if (value) {
			const valueStart = line.indexOf(value, colonIdx + 1);
			if (valueStart >= 0) {
				push(tokens, lineNo, valueStart, value.length, valueRole, false);
			}
		}
	}
}

function addListValueTokens(tokens, lineNo, line, fromIndex, role) {
	const bracketStart = line.indexOf('[', fromIndex);
	const bracketEnd = line.lastIndexOf(']');
	if (bracketStart < 0 || bracketEnd <= bracketStart) return;
	push(tokens, lineNo, bracketStart, bracketEnd - bracketStart + 1, role || 'relationvalue', false);
}

function tokenizeMetadataBlockFromIndex(
	tokens,
	lines,
	startIndex,
	initialTypedContext,
	stopOnSeparator,
	allowBlankLinesAfterStart,
	typeSet,
	relationSet,
	typedFieldKeySet
) {
	let i = startIndex;
	let started = false;
	let typedContext = initialTypedContext;
	let typeConsumed = initialTypedContext;
	let consumedHeadingShortcutMarker = false;
	const seenRelations = new Set();

	while (i < lines.length) {
		const line = String(lines[i] || '');
		const trimmed = line.trim();
		if (HEADING_RE.test(trimmed)) break;
		if (stopOnSeparator && trimmed === '---') break;
		if (!started) {
			if (!trimmed || COMMENT_RE.test(trimmed)) {
				i++;
				continue;
			}
			started = true;
		}
		if (!trimmed) {
			if (allowBlankLinesAfterStart) {
				i++;
				continue;
			}
			break;
		}

		// Type marker line (`.concept`) — color1.
		const typeMatch = trimmed.match(/^\.(\w[\w-]*)\b/i);
		if (typeMatch && typeSet.has(String(typeMatch[1] || '').toLowerCase())) {
			if (typeConsumed) {
				if (initialTypedContext && !consumedHeadingShortcutMarker) {
					const marker = `.${String(typeMatch[1] || '').toLowerCase()}`;
					const markerStart = line.toLowerCase().indexOf(marker.toLowerCase());
					push(tokens, i, markerStart, marker.length, 'type', false);
					consumedHeadingShortcutMarker = true;
					i++;
					continue;
				}
				break;
			}
			const marker = `.${String(typeMatch[1] || '').toLowerCase()}`;
			const markerStart = line.toLowerCase().indexOf(marker.toLowerCase());
			push(tokens, i, markerStart, marker.length, 'type', false);
			typedContext = true;
			typeConsumed = true;
			i++;
			continue;
		}

		// Heading-special keys (workflow: / parent:) — always colored; do not end the meta zone.
		const specialMatch = line.match(/^\s*([a-z][a-z0-9_-]*)\s*:\s*(.+)$/i);
		if (specialMatch && HEADING_SPECIAL_KEYS.has(String(specialMatch[1] || '').toLowerCase())) {
			const specialKey = String(specialMatch[1] || '').toLowerCase();
			addKeyValueTokens(tokens, i, line, specialKey, 'metakey', 'metavalue');
			if (specialKey === 'parent') {
				addListValueTokens(tokens, i, line, 0, 'metavalue');
			}
			i++;
			continue;
		}

		// Tag / relation key: [values] — key color4, list values color9.
		const relationMatch = line.match(/^\s*([a-z][a-z0-9_-]*)\s*:\s*\[([^\]]*)\]\s*$/i);
		if (relationMatch && relationSet.has(String(relationMatch[1] || '').toLowerCase())) {
			const relationKey = String(relationMatch[1] || '').toLowerCase();
			const relationStart = line.toLowerCase().indexOf(relationKey);
			if (!seenRelations.has(relationKey) && relationStart >= 0) {
				push(tokens, i, relationStart, relationKey.length, 'relationkey', false);
				addListValueTokens(tokens, i, line, relationStart, 'relationvalue');
				seenRelations.add(relationKey);
			}
			i++;
			continue;
		}

		// Shorthand tag list `[a, b]` — color9.
		const shorthandMatch = line.match(SHORTHAND_TAGS_RE);
		if (shorthandMatch) {
			if (!seenRelations.has('tags')) {
				addListValueTokens(tokens, i, line, 0, 'relationvalue');
				seenRelations.add('tags');
			}
			i++;
			continue;
		}

		// File-level identity fields — key color6, value color7.
		const fileIdentityMatch = line.match(FILE_IDENTITY_RE);
		if (fileIdentityMatch) {
			addKeyValueTokens(tokens, i, line, fileIdentityMatch[1], 'fileidentity', 'identityvalue');
			i++;
			continue;
		}

		// Typed metadata field keys — key color3, value color8.
		if ((typedContext || initialTypedContext) && leadingWhitespaceCount(line) > 0) {
			const kv = line.match(/^\s*([a-z][a-z0-9_-]*)\s*:\s*(.+)$/i);
			const key = kv ? String(kv[1] || '').toLowerCase() : '';
			if (key && typedFieldKeySet.has(key)) {
				addKeyValueTokens(tokens, i, line, key, 'metakey', 'typedvalue');
				i++;
				continue;
			}
		}

		break;
	}
	return i;
}

/**
 * @param {string[]} lines
 * @returns {{ line: number, start: number, length: number, role: string, bold: boolean }[]}
 */
function tokenizeDripnote(lines) {
	const tokens = [];
	const types = getCustomTypeMarkers();
	const relations = getAllowedRelationKeys();
	const typedKeys = getTypedFieldKeys();
	const settings = getMetadataSettingsForIndex();

	// File header (identity) block before the first `---`.
	tokenizeMetadataBlockFromIndex(tokens, lines, 0, false, true, true, types, relations, typedKeys);

	// Headings, their metadata blocks, and `---` separators (color5).
	for (let i = 0; i < lines.length; i++) {
		const line = String(lines[i] || '');
		if (line.trim() === '---') {
			push(tokens, i, 0, line.length, 'metavalue', false);
			continue;
		}
		if (!HEADING_RE.test(line)) continue;
		emitHeading(tokens, i, line, settings);
		tokenizeMetadataBlockFromIndex(
			tokens,
			lines,
			i + 1,
			isHeadingTypeLine(line, types),
			true,
			false,
			types,
			relations,
			typedKeys
		);
	}
	return tokens;
}

module.exports = {
	tokenizeDripnote
};
