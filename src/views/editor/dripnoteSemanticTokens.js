'use strict';

const vscode = require('vscode');
const { getMetadataSettings, matchHeadingTitleTypePrefix, HEADING_SPECIAL_KEYS } = require('../../document/model/dripnoteMetadataTemplates');

const tokenTypes = ['keyword', 'type', 'property', 'string'];
const legend = new vscode.SemanticTokensLegend(tokenTypes, []);

const HEADING_RE = /^\s*#{1,6}\s+/;
const SHORTHAND_TAGS_RE = /^\s*\[([^\]]*)\]\s*$/;
const FILE_HEADER_RE = /^\s*(filename|created|random|fileid)\s*:\s*(.+)$/i;
const COMMENT_RE = /^\s*\/\//;

function typeIndex(name) {
	return tokenTypes.indexOf(name);
}

function leadingWhitespaceCount(line) {
	const m = String(line || '').match(/^\s*/);
	return m ? m[0].length : 0;
}

function getCustomTypeMarkers() {
	const cfg = vscode.workspace.getConfiguration('drip');
	const raw = cfg.get('dripnoteCustomTypeMarkers', []);
	const out = new Set(['concept', 'task', 'project', 'p', 't']);
	const meta = getMetadataSettings();
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
	const out = new Set(['status', 'deadline', 'difficulty', 'priority', 'importance']);
	const meta = getMetadataSettings();
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
	const cfg = vscode.workspace.getConfiguration('drip');
	const raw = cfg.get('dripnoteAllowedMetadataKeys', []);
	const out = new Set(['tags', 'pre-req']);
	for (const x of Array.isArray(raw) ? raw : []) {
		const k = String(x || '').trim().toLowerCase();
		if (k && !['filename', 'created', 'fileid'].includes(k)) out.add(k);
	}
	return out;
}

function isHeadingTypeLine(line, typeSet) {
	const matched = matchHeadingTitleTypePrefix(line, getMetadataSettings());
	if (matched.typeId) return true;
	const trimmed = String(line || '').trim();
	if (!HEADING_RE.test(trimmed)) return false;
	for (const t of typeSet) {
		const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const re = new RegExp(`^\\s*#{1,6}\\s+(?:\\.${esc}\\b|${esc}\\.)`);
		if (re.test(line)) return true;
	}
	return false;
}

function addKeyValueTokens(builder, lineNo, line, key, tokenType) {
	const idx = line.toLowerCase().indexOf(String(key || '').toLowerCase());
	if (idx >= 0) {
		builder.push(lineNo, idx, String(key).length, typeIndex(tokenType), 0);
	}
	const colonIdx = line.indexOf(':');
	if (colonIdx >= 0 && colonIdx + 1 < line.length) {
		const value = line.slice(colonIdx + 1).trim();
		if (value) {
			const valueStart = line.indexOf(value, colonIdx + 1);
			if (valueStart >= 0) {
				builder.push(lineNo, valueStart, value.length, typeIndex('string'), 0);
			}
		}
	}
}

function tokenizeMetadataBlockFromIndex(
	builder,
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

		const typeMatch = trimmed.match(/^\.(\w[\w-]*)\b/i);
		if (typeMatch && typeSet.has(String(typeMatch[1] || '').toLowerCase())) {
			if (typeConsumed) {
				if (initialTypedContext && !consumedHeadingShortcutMarker) {
					const marker = `.${String(typeMatch[1] || '').toLowerCase()}`;
					const markerStart = line.toLowerCase().indexOf(marker.toLowerCase());
					if (markerStart >= 0) builder.push(i, markerStart, marker.length, typeIndex('type'), 0);
					consumedHeadingShortcutMarker = true;
					i++;
					continue;
				}
				break;
			}
			const marker = `.${String(typeMatch[1] || '').toLowerCase()}`;
			const markerStart = line.toLowerCase().indexOf(marker.toLowerCase());
			if (markerStart >= 0) {
				builder.push(i, markerStart, marker.length, typeIndex('type'), 0);
			}
			typedContext = true;
			typeConsumed = true;
			i++;
			continue;
		}

		// Heading-special keys (workflow: / parent:) — always colored; do not end the meta zone.
		const specialMatch = line.match(/^\s*([a-z][a-z0-9_-]*)\s*:\s*(.+)$/i);
		if (specialMatch && HEADING_SPECIAL_KEYS.has(String(specialMatch[1] || '').toLowerCase())) {
			const specialKey = String(specialMatch[1] || '').toLowerCase();
			addKeyValueTokens(builder, i, line, specialKey, 'keyword');
			if (specialKey === 'parent') {
				const bracketStart = line.indexOf('[');
				const bracketEnd = line.lastIndexOf(']');
				if (bracketStart >= 0 && bracketEnd > bracketStart) {
					builder.push(i, bracketStart, bracketEnd - bracketStart + 1, typeIndex('string'), 0);
				}
			}
			i++;
			continue;
		}

		const relationMatch = line.match(/^\s*([a-z][a-z0-9_-]*)\s*:\s*\[([^\]]*)\]\s*$/i);
		if (relationMatch && relationSet.has(String(relationMatch[1] || '').toLowerCase())) {
			const relationKey = String(relationMatch[1] || '').toLowerCase();
			const relationStart = line.toLowerCase().indexOf(relationKey);
			if (!seenRelations.has(relationKey) && relationStart >= 0) {
				builder.push(i, relationStart, relationKey.length, typeIndex('property'), 0);
				const bracketStart = line.indexOf('[', relationStart);
				const bracketEnd = line.lastIndexOf(']');
				if (bracketStart >= 0 && bracketEnd > bracketStart) {
					builder.push(i, bracketStart, bracketEnd - bracketStart + 1, typeIndex('string'), 0);
				}
				seenRelations.add(relationKey);
			}
			i++;
			continue;
		}

		const shorthandMatch = line.match(SHORTHAND_TAGS_RE);
		if (shorthandMatch) {
			if (!seenRelations.has('tags')) {
				const bracketStart = line.indexOf('[');
				const bracketEnd = line.lastIndexOf(']');
				if (bracketStart >= 0 && bracketEnd > bracketStart) {
					builder.push(i, bracketStart, bracketEnd - bracketStart + 1, typeIndex('string'), 0);
				}
				seenRelations.add('tags');
			}
			i++;
			continue;
		}

		const fileHeaderMatch = line.match(FILE_HEADER_RE);
		if (fileHeaderMatch) {
			addKeyValueTokens(builder, i, line, fileHeaderMatch[1], 'keyword');
			i++;
			continue;
		}

		if ((typedContext || initialTypedContext) && leadingWhitespaceCount(line) > 0) {
			const kv = line.match(/^\s*([a-z][a-z0-9_-]*)\s*:\s*(.+)$/i);
			const key = kv ? String(kv[1] || '').toLowerCase() : '';
			if (key && typedFieldKeySet.has(key)) {
				addKeyValueTokens(builder, i, line, key, 'keyword');
				i++;
				continue;
			}
		}

		break;
	}
	return i;
}

function registerDripnoteSemanticTokens(context) {
	const emitter = new vscode.EventEmitter();
	const provider = {
		onDidChangeSemanticTokens: emitter.event,
		/**
		 * @param {import('vscode').TextDocument} document
		 * @returns {import('vscode').SemanticTokens}
		 */
		provideDocumentSemanticTokens(document) {
			if (document.languageId !== 'dripnote') {
				return new vscode.SemanticTokensBuilder(legend).build();
			}
			const builder = new vscode.SemanticTokensBuilder(legend);
			const lines = document.getText().split(/\r?\n/);
			const types = getCustomTypeMarkers();
			const relations = getAllowedRelationKeys();
			const typedKeys = getTypedFieldKeys();
			const settings = getMetadataSettings();
			tokenizeMetadataBlockFromIndex(builder, lines, 0, false, true, true, types, relations, typedKeys);
			for (let i = 0; i < lines.length; i++) {
				const line = String(lines[i] || '');
				if (!HEADING_RE.test(line)) continue;
				const matched = matchHeadingTitleTypePrefix(line, settings);
				if (matched.matchedPrefix) {
					const markerStart = line.indexOf(matched.matchedPrefix);
					if (markerStart >= 0) {
						builder.push(i, markerStart, matched.matchedPrefix.length, typeIndex('type'), 0);
					}
				} else {
					const headingMarker = line.match(/^\s*#{1,6}\s+(\.[a-zA-Z][a-zA-Z0-9_-]*)\b/);
					if (headingMarker) {
						const marker = String(headingMarker[1] || '');
						const markerStart = line.indexOf(marker);
						if (markerStart >= 0) builder.push(i, markerStart, marker.length, typeIndex('type'), 0);
					}
				}
				tokenizeMetadataBlockFromIndex(
					builder,
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
			return builder.build();
		}
	};

	context.subscriptions.push(
		vscode.languages.registerDocumentSemanticTokensProvider({ language: 'dripnote' }, provider, legend)
	);
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('drip')) emitter.fire();
		})
	);
	context.subscriptions.push(emitter);
}

module.exports = {
	registerDripnoteSemanticTokens
};
