'use strict';

const vscode = require('vscode');
const tagGraphStore = require('../../../graph/tagGraphStore');
const { getMetadataTemplateConfig, resolveTypeFromMarkerOrHeading } = require('../../../document/model/dripNoteMetadataTemplates.js');

const INDIVIDUAL_TAGS_GRAPH_NAME = 'individual tags';
const DEFAULT_RELATION_KEY = 'tags';
const DEFAULT_ALLOWED_RELATION_KEYS = new Set(['tags', 'pre-req']);

/**
 * If cursor is inside a supported tag list (`key: [ ... ]` or `[ ... ]`)
 * and the line is within a valid metadata zone, returns opening `[` index.
 * @param {string} fullText
 * @param {number} offset
 * @returns {number | null}
 */
function tagsBracketOpenIndex(fullText, offset) {
	const text = String(fullText || '');
	const safeOffset = Math.max(0, Math.min(offset, text.length));
	const lineStart = text.lastIndexOf('\n', safeOffset - 1) + 1;
	const lineEndRaw = text.indexOf('\n', safeOffset);
	const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
	const lineText = text.slice(lineStart, lineEnd);
	const localOffset = safeOffset - lineStart;
	const trimmed = lineText.trim();
	const isShorthandLine = /^\[[^\]]*(?:\]\s*)?$/.test(trimmed);
	const isRelationLikeLine = /^[a-z][a-z0-9_-]*\s*:\s*\[[^\]]*(?:\]\s*)?$/i.test(trimmed);
	if (!isShorthandLine && !isRelationLikeLine) {
		return null;
	}

	// Find nearest '[' before cursor on this line.
	const beforeCursor = lineText.slice(0, localOffset);
	const localOpen = beforeCursor.lastIndexOf('[');
	if (localOpen < 0) {
		return null;
	}

	// Cursor must be before the first closing bracket after this '[' (or no closing bracket yet).
	const closeAfterOpen = lineText.indexOf(']', localOpen + 1);
	if (closeAfterOpen >= 0 && localOffset > closeAfterOpen) {
		return null;
	}
	return lineStart + localOpen;
}

/**
 * @param {string} fullText
 * @param {number} openBracket
 * @param {number} offset
 * @returns {{ fragment: string, tokenStartOffset: number }}
 */
function currentTagEditInfo(fullText, openBracket, offset) {
	const slice = fullText.slice(openBracket + 1, offset);
	const lastComma = slice.lastIndexOf(',');
	const afterComma = lastComma < 0 ? slice : slice.slice(lastComma + 1);
	const trimLeading = afterComma.length - afterComma.trimStart().length;
	const tokenStartOffset =
		openBracket + 1 + (lastComma < 0 ? 0 : lastComma + 1) + trimLeading;
	return {
		fragment: afterComma.trim(),
		tokenStartOffset
	};
}

/**
 * @param {string} fullText
 * @returns {string[]}
 */
function extractAllTagTokensFromText(fullText) {
	/** @type {string[]} */
	const out = [];
	const lines = String(fullText || '').split(/\r?\n/);
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const rawLine = lines[lineIndex];
		const line = String(rawLine || '');
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('//')) {
			continue;
		}
		const ctx = getMetadataContextAtLine(String(fullText || ''), lineIndex);
		const relationMatch = parseRelationListLine(trimmed, { allowUnclosed: false });
		if (relationMatch) {
			if (ctx.inMetadataZone && !ctx.activeRelationKeys.has(relationMatch.key)) {
				continue;
			}
			for (const token of tokenizeBracketList(relationMatch.inner)) {
				out.push(token);
			}
			continue;
		}
		// Heading shorthand tags line:
		//   [a, b, c]
		const shorthandMatch = trimmed.match(/^\[([^\]]*)\]\s*$/);
		if (shorthandMatch) {
			if (ctx.inMetadataZone && !ctx.activeRelationKeys.has(DEFAULT_RELATION_KEY)) {
				continue;
			}
			for (const token of tokenizeBracketList(shorthandMatch[1])) {
				out.push(token);
			}
		}
	}
	return out;
}

/**
 * Parse relation line like `tags: [a,b]`.
 * @param {string} trimmedLine
 * @param {{ allowUnclosed?: boolean }} [options]
 * @returns {{ key: string, inner: string } | null}
 */
function parseRelationListLine(trimmedLine, options) {
	const allowUnclosed = !!(options && options.allowUnclosed);
	const m = String(trimmedLine || '').match(
		allowUnclosed
			? /^([a-z][a-z0-9_-]*)\s*:\s*\[([^\]]*)(?:\]\s*)?$/i
			: /^([a-z][a-z0-9_-]*)\s*:\s*\[([^\]]*)\]\s*$/i
	);
	if (!m) return null;
	const key = String(m[1] || '').trim().toLowerCase();
	const allowed = getAllowedRelationKeys();
	if (!allowed.has(key)) return null;
	return { key, inner: String(m[2] || '') };
}

/**
 * Parse generic metadata key-value line.
 * @param {string} trimmedLine
 * @returns {{ key: string, value: string } | null}
 */
function parseMetadataKeyValueLine(trimmedLine) {
	const m = String(trimmedLine || '').match(/^([a-z][a-z0-9_-]*)\s*:\s*(.+)$/i);
	if (!m) return null;
	return { key: String(m[1] || '').trim().toLowerCase(), value: String(m[2] || '').trim() };
}

/**
 * Known relations + optional user-configured relation keys.
 * @returns {Set<string>}
 */
function getAllowedRelationKeys() {
	try {
		const cfg = getMetadataTemplateConfig();
		if (cfg && cfg.allowedRelations && cfg.allowedRelations.size) {
			return new Set(cfg.allowedRelations);
		}
	} catch {}
	return new Set(DEFAULT_ALLOWED_RELATION_KEYS);
}

/**
 * Evaluate metadata context for a given line.
 * Supports:
 * - file-level metadata before first `---` separator
 * - heading metadata block immediately after heading
 * Enforces single `.concept/.task/.project` and single instance per relation key.
 * @param {string} fullText
 * @param {number} targetLineIndex
 * @returns {{ inMetadataZone: boolean, activeRelationKeys: Set<string> }}
 */
function getMetadataContextAtLine(fullText, targetLineIndex) {
	const lines = String(fullText || '').split(/\r?\n/);
	const idx = Math.min(Math.max(targetLineIndex, 0), Math.max(0, lines.length - 1));
	const activeRelationKeys = new Set();
	let typeSeen = false;
	// file-level metadata area ends at first separator or first heading
	let sectionStart = 0;
	let nearestHeading = -1;
	for (let i = idx; i >= 0; i--) {
		const t = String(lines[i] || '').trim();
		if (isHeadingLine(t)) {
			nearestHeading = i;
			sectionStart = i + 1;
			break;
		}
		if (t === '---') {
			sectionStart = i + 1;
			break;
		}
	}
	let firstContentSeen = false;
	let metadataStarted = false;
	for (let i = sectionStart; i <= idx; i++) {
		const trimmed = String(lines[i] || '').trim();
		if (isHeadingLine(trimmed) || trimmed === '---') {
			return { inMetadataZone: false, activeRelationKeys };
		}
		if (!trimmed || trimmed.startsWith('//')) {
			if (!firstContentSeen && nearestHeading >= 0 && !trimmed) {
				// No blank line allowed between heading and metadata.
				return { inMetadataZone: false, activeRelationKeys };
			}
			// For heading blocks, stop metadata zone at first blank line after metadata starts.
			// For file-level metadata (no heading), allow blank lines in the top metadata area.
			if (nearestHeading >= 0 && firstContentSeen && metadataStarted && !trimmed) {
				return { inMetadataZone: false, activeRelationKeys };
			}
			continue;
		}
		if (!firstContentSeen) {
			firstContentSeen = true;
		}
		const typed = /^\.(?:concept|task|project|p|t)\b/i.test(trimmed);
		const relation = parseRelationListLine(trimmed, { allowUnclosed: true });
		const shorthand = /^\[[^\]]*\]\s*$/.test(trimmed);
		const metadataKeyValue = parseMetadataKeyValueLine(trimmed);
		if (!(typed || relation || shorthand || metadataKeyValue)) {
			return { inMetadataZone: false, activeRelationKeys };
		}
		metadataStarted = true;
		if (typed) {
			if (typeSeen) return { inMetadataZone: false, activeRelationKeys };
			typeSeen = true;
		}
		if (relation) {
			if (activeRelationKeys.has(relation.key)) {
				return { inMetadataZone: false, activeRelationKeys };
			}
			activeRelationKeys.add(relation.key);
		}
		if (shorthand) {
			if (activeRelationKeys.has(DEFAULT_RELATION_KEY)) {
				return { inMetadataZone: false, activeRelationKeys };
			}
			activeRelationKeys.add(DEFAULT_RELATION_KEY);
		}
	}
	return { inMetadataZone: metadataStarted || nearestHeading < 0, activeRelationKeys };
}

/**
 * @param {string} trimmedLine
 * @returns {boolean}
 */
function isHeadingLine(trimmedLine) {
	return /^#{1,6}\s+/.test(trimmedLine);
}

function nearestHeadingLine(lines, lineIndex) {
	for (let i = Math.min(lineIndex, lines.length - 1); i >= 0; i--) {
		const t = String(lines[i] || '').trim();
		if (isHeadingLine(t)) return t;
		if (t === '---') return '';
	}
	return '';
}

function metadataCompletionContext(document, position) {
	const lineText = document.lineAt(position.line).text;
	const before = lineText.slice(0, position.character);
	if (!/^\s*[a-z0-9_-]*$/i.test(before)) return null;
	const fullText = document.getText();
	const ctx = getMetadataContextAtLine(fullText, position.line);
	if (!ctx.inMetadataZone) return null;
	const cfg = getMetadataTemplateConfig();
	if (!cfg.enabled) return null;
	const lines = fullText.split(/\r?\n/);
	const heading = nearestHeadingLine(lines, position.line);
	const type = resolveTypeFromMarkerOrHeading(heading, cfg);
	return { cfg, type, prefix: before.trim().toLowerCase() };
}

/**
 * @param {string} inner
 * @returns {string[]}
 */
function tokenizeBracketList(inner) {
	/** @type {string[]} */
	const out = [];
	for (const part of String(inner || '').split(',')) {
		const t = part.trim();
		if (t) {
			out.push(t);
		}
	}
	return out;
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @returns {Map<string, { label: string, sources: Set<string> }>}
 */
function aggregateLabelsByGraph(context) {
	const graphs = tagGraphStore.listStoredTagGraphs(context);
	/** @type {Map<string, { label: string, sources: Set<string> }>} */
	const byLower = new Map();
	for (const meta of graphs) {
		const g = tagGraphStore.loadStoredTagGraphById(context, meta.id);
		const gname = String(meta.name || meta.id);
		for (const n of g.nodes) {
			const lab = String(n.label || '').trim();
			if (!lab) {
				continue;
			}
			const low = lab.toLowerCase();
			if (!byLower.has(low)) {
				byLower.set(low, { label: lab, sources: new Set() });
			}
			byLower.get(low).sources.add(gname);
		}
	}
	return byLower;
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @returns {Set<string>}
 */
function allKnownLabelsLower(context) {
	const keys = aggregateLabelsByGraph(context).keys();
	return new Set(keys);
}

/**
 * Same label pool the in-editor tag completion uses (tag graphs + optional file tokens).
 * @param {import('vscode').ExtensionContext} context
 * @param {string} [fileText]
 * @returns {string[]}
 */
function listKnownTagLabelsForCompletion(context, fileText) {
	/** @type {Map<string, string>} */
	const byLower = new Map();
	if (context) {
		for (const { label } of aggregateLabelsByGraph(context).values()) {
			const t = String(label || '').trim();
			if (!t) continue;
			const low = t.toLowerCase();
			if (!byLower.has(low)) byLower.set(low, t);
		}
		for (const meta of tagGraphStore.listStoredTagGraphs(context)) {
			const gname = String(meta.name || '').trim();
			if (!gname) continue;
			const low = gname.toLowerCase();
			if (!byLower.has(low)) byLower.set(low, gname);
		}
	}
	for (const t of extractAllTagTokensFromText(fileText || '')) {
		const label = String(t || '').trim();
		if (!label) continue;
		const low = label.toLowerCase();
		if (!byLower.has(low)) byLower.set(low, label);
	}
	return [...byLower.values()].sort((a, b) =>
		a.localeCompare(b, undefined, { sensitivity: 'base' })
	);
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} wantedDisplayName
 * @returns {string | null}
 */
function findGraphIdByDisplayName(context, wantedDisplayName) {
	const w = String(wantedDisplayName || '')
		.trim()
		.toLowerCase();
	if (!w) {
		return null;
	}
	for (const g of tagGraphStore.listStoredTagGraphs(context)) {
		if (String(g.name || '')
			.trim()
			.toLowerCase() === w) {
			return String(g.id);
		}
	}
	return null;
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @returns {Promise<string>}
 */
async function ensureIndividualTagsGraphId(context) {
	let id = findGraphIdByDisplayName(context, INDIVIDUAL_TAGS_GRAPH_NAME);
	if (id) {
		return id;
	}
	return tagGraphStore.createStoredTagGraph(context, INDIVIDUAL_TAGS_GRAPH_NAME, { activate: false });
}

/** Characters that re-trigger completions while typing a tag token after `tags: [` */
const TAG_COMPLETION_EXTRA_TRIGGERS =
	'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./:&';

/**
 * @param {import('vscode').ExtensionContext} context
 */
function registerDripnoteTagCompletion(context) {
	let lastFolderSyncMs = 0;
	const completionProvider = {
		/**
		 * @param {import('vscode').TextDocument} document
		 * @param {import('vscode').Position} position
		 * @param {import('vscode').CancellationToken} _token
		 * @param {import('vscode').CompletionContext} _ctx
		 */
		async provideCompletionItems(document, position, _token, _ctx) {
			if (document.languageId !== 'dripnote') {
				return undefined;
			}
			try {
				const lineText = document.lineAt(position.line).text;
				const kv = lineText.match(/^\s*([a-z][a-z0-9_-]*)\s*:\s*([^#]*)$/i);
				if (kv && position.character >= lineText.indexOf(':') + 1) {
					const cfg = getMetadataTemplateConfig();
					const fullTextForValues = document.getText();
					const heading = nearestHeadingLine(fullTextForValues.split(/\r?\n/), position.line);
					const type = resolveTypeFromMarkerOrHeading(heading, cfg);
					const attrs = new Map();
					for (const a of ((type && type.attributes) || [])) attrs.set(String(a.key || '').toLowerCase(), a);
					const key = String(kv[1] || '').toLowerCase();
					const attr = attrs.get(key);
					if (attr && attr.type === 'enum') {
						const valStart = lineText.indexOf(':') + 1;
						const replaceRange = new vscode.Range(position.line, valStart, position.line, lineText.length);
						return (attr.values || []).map(v => {
							const item = new vscode.CompletionItem(String(v), vscode.CompletionItemKind.EnumMember);
							item.textEdit = vscode.TextEdit.replace(replaceRange, String(v));
							return item;
						});
					}
					if (attr && attr.type === 'datetime') {
						return ['45 min', '2 days', '2026-04-29 18:30'].map(v => {
							const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.Value);
							item.detail = 'Datetime value';
							return item;
						});
					}
				}
				const keyCtx = metadataCompletionContext(document, position);
				if (keyCtx && keyCtx.type) {
					/** @type {import('vscode').CompletionItem[]} */
					const keyItems = [];
					for (const a of (keyCtx.type.attributes || [])) {
						const k = String(a.key || '').toLowerCase();
						if (keyCtx.prefix && !k.startsWith(keyCtx.prefix)) continue;
						const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Property);
						item.detail = `${a.type} (${keyCtx.type.marker})`;
						item.insertText = `${k}: `;
						keyItems.push(item);
					}
					if (keyItems.length) return keyItems;
				}
				const now = Date.now();
				if (now - lastFolderSyncMs > 5000) {
					lastFolderSyncMs = now;
					await tagGraphStore.syncStoredGraphsFromFolder(context);
				}
				const fullText = document.getText();
				const offset = document.offsetAt(position);
				const openBracket = tagsBracketOpenIndex(fullText, offset);
				if (openBracket === null) {
					return undefined;
				}
				const zoneCtx = getMetadataContextAtLine(fullText, position.line);
				if (!zoneCtx.inMetadataZone) {
					return undefined;
				}
				const currentTrimmed = String(document.lineAt(position.line).text || '').trim();
				const currentRelation = parseRelationListLine(currentTrimmed, { allowUnclosed: true });
				const isShorthand = /^\[[^\]]*(?:\]\s*)?$/.test(currentTrimmed);
				if (!currentRelation && !isShorthand) {
					return undefined;
				}
				const { fragment, tokenStartOffset } = currentTagEditInfo(fullText, openBracket, offset);
				const fragLower = fragment.toLowerCase();
				const replaceRange = new vscode.Range(document.positionAt(tokenStartOffset), position);
				const agg = aggregateLabelsByGraph(context);
				/** @type {Set<string>} */
				const seenLower = new Set();
				/** @type {import('vscode').CompletionItem[]} */
				const items = [];
				for (const { label, sources } of agg.values()) {
					seenLower.add(label.toLowerCase());
					if (fragLower && !label.toLowerCase().startsWith(fragLower)) {
						continue;
					}
					const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Value);
					item.detail = [...sources].sort().join(', ');
					item.sortText = label.toLowerCase();
					item.textEdit = vscode.TextEdit.replace(replaceRange, label);
					items.push(item);
				}
				for (const meta of tagGraphStore.listStoredTagGraphs(context)) {
					const gname = String(meta.name || '').trim();
					if (!gname) {
						continue;
					}
					const low = gname.toLowerCase();
					if (seenLower.has(low)) {
						continue;
					}
					if (fragLower && !low.startsWith(fragLower)) {
						continue;
					}
					const item = new vscode.CompletionItem(gname, vscode.CompletionItemKind.Folder);
					item.detail = 'Tags graph name';
					item.sortText = low;
					item.textEdit = vscode.TextEdit.replace(replaceRange, gname);
					items.push(item);
				}
				const localSeen = new Set();
				for (const t of extractAllTagTokensFromText(fullText)) {
					const label = String(t || '').trim();
					const low = label.toLowerCase();
					if (!label || localSeen.has(low) || seenLower.has(low)) continue;
					if (fragLower && !low.startsWith(fragLower)) continue;
					localSeen.add(low);
					const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Value);
					item.detail = 'From current file';
					item.sortText = `zz-${low}`;
					item.textEdit = vscode.TextEdit.replace(replaceRange, label);
					items.push(item);
				}
				if (!items.length) {
					const placeholder = new vscode.CompletionItem('No tags found yet', vscode.CompletionItemKind.Text);
					placeholder.detail = 'Create tags in graph or current file';
					placeholder.insertText = '';
					placeholder.sortText = 'zzz';
					items.push(placeholder);
				}
				items.sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { sensitivity: 'base' }));
				return items;
			} catch (err) {
				console.error('[DRIP] tag completion provider failed', err);
				return [];
			}
		}
	};

	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider(
			{ language: 'dripnote' },
			completionProvider,
			'[',
			',',
			' ',
			...TAG_COMPLETION_EXTRA_TRIGGERS.split('')
		)
	);

}

module.exports = {
	registerDripnoteTagCompletion,
	tagsBracketOpenIndex,
	currentTagEditInfo,
	extractAllTagTokensFromText,
	listKnownTagLabelsForCompletion
};
