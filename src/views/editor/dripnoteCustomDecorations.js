'use strict';

const vscode = require('vscode');
const { getMetadataSettings } = require('../../document/model/dripnoteMetadataTemplates');
const { splitFileTopRegion } = require('../../document/parse/dripnoteCanvasParse');
const { isRefLine } = require('../../document/parse/dripnoteRefLinks');
const tagGraphStore = require('../../graph/tagGraphStore');

const HEADING_RE = /^\s*#{1,6}\s+/;
const COMMENT_RE = /^\s*\/\//;
const TYPE_LINE_RE = /^\s*\.[a-z][a-z0-9_-]*\b/i;
const KEY_VALUE_RE = /^\s*([a-z][a-z0-9_-]*)\s*:\s*(.+)$/i;
const RELATION_RE = /^\s*([a-z][a-z0-9_-]*)\s*:\s*\[[^\]]*\]\s*$/i;

function getCustomColorMap() {
	const cfg = vscode.workspace.getConfiguration('drip');
	const raw = cfg.get('dripnoteCustomColors', {});
	const out = new Map();
	if (!raw || typeof raw !== 'object') return out;
	for (const [k, v] of Object.entries(raw)) {
		const key = String(k || '').trim().toLowerCase();
		const color = String(v || '').trim();
		if (!key || !color) continue;
		out.set(key, color);
	}
	return out;
}

function getMetadataColorSettings() {
	const cfg = vscode.workspace.getConfiguration('drip');
	const useCustom = !!cfg.get('metadataUseCustomColors', false);
	const keyColor = String(cfg.get('metadataKeyColor', '') || '').trim();
	const valueColor = String(cfg.get('metadataValueColor', '') || '').trim();
	const rawTypeColors = cfg.get('metadataTypeColors', {});
	/** @type {Map<string, string>} */
	const typeColors = new Map();
	if (rawTypeColors && typeof rawTypeColors === 'object') {
		for (const [k, v] of Object.entries(rawTypeColors)) {
			const id = String(k || '').trim().toLowerCase();
			const color = String(v || '').trim();
			if (id && color) typeColors.set(id, color);
		}
	}
	return { useCustom, keyColor, valueColor, typeColors };
}

function getRefLinksColors() {
	const cfg = vscode.workspace.getConfiguration('drip');
	const refCfg = cfg.get('refLinksConfig', {});
	return {
		refKeywordColor: String((refCfg && refCfg.refKeywordColor) || '').trim(),
		refValueColor: String((refCfg && refCfg.refValueColor) || '').trim()
	};
}

function getRelationsKeywordColors() {
	const cfg = vscode.workspace.getConfiguration('drip');
	const relCfg = cfg.get('tagsRelationsConfig', {});
	return {
		relationKeywordColor: String((relCfg && relCfg.relationKeywordColor) || '').trim(),
		tagsKeywordColor: String((relCfg && relCfg.tagsKeywordColor) || '').trim()
	};
}

function getMarkdownMarksSettings() {
	const cfg = vscode.workspace.getConfiguration('drip');
	const raw = cfg.get('dripMetadataMarks', { marks: [] });
	const marks = Array.isArray(raw && raw.marks) ? raw.marks : [];
	/** @type {Map<string, { markColor: string, textColor: string }>} */
	const out = new Map();
	for (const item of marks) {
		const name = String(item && item.name ? item.name : '').trim();
		if (!name) continue;
		const markColor = String((item && (item.markColor || item.color)) || '').trim();
		const textColor = String((item && item.textColor) || '').trim();
		out.set(name, { markColor, textColor });
	}
	return out;
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

function getAllowedRelationKeys() {
	const cfg = vscode.workspace.getConfiguration('drip');
	const relCfg = cfg.get('tagsRelationsConfig', {});
	const out = new Set(['tags', 'pre-req']);
	const fromAllowed = Array.isArray(relCfg && relCfg.allowed) ? relCfg.allowed : [];
	for (const x of fromAllowed) {
		const k = String(x || '').trim().toLowerCase();
		if (k && !['filename', 'created', 'fileid'].includes(k)) out.add(k);
	}
	const fromRows = Array.isArray(relCfg && relCfg.relations) ? relCfg.relations : [];
	for (const row of fromRows) {
		const k = String((row && row.name) || '').trim().toLowerCase();
		if (k && !['filename', 'created', 'fileid'].includes(k)) out.add(k);
	}
	return out;
}

function registerDripnoteCustomDecorations(context) {
	/** @type {Map<string, import('vscode').TextEditorDecorationType>} */
	const decoByColor = new Map();

	function decoForColor(color) {
		if (decoByColor.has(color)) return decoByColor.get(color);
		const d = vscode.window.createTextEditorDecorationType({ color });
		decoByColor.set(color, d);
		context.subscriptions.push(d);
		return d;
	}

	function applyForEditor(editor) {
		if (!editor || editor.document.languageId !== 'dripnote') return;
		const doc = editor.document;
		const lines = doc.getText().split(/\r?\n/);
		const colorMap = getCustomColorMap();
		const types = getCustomTypeMarkers();
		const relations = getAllowedRelationKeys();
		const metadataSettings = getMetadataSettings();
		const metadataColors = getMetadataColorSettings();
		const relColors = getRelationsKeywordColors();
		const refColors = getRefLinksColors();
		const markdownMarks = getMarkdownMarksSettings();
		const fallbackKeyColor = metadataColors.keyColor || '';
		const fallbackValueColor = metadataColors.valueColor || '';
		const relationKeywordColor = relColors.relationKeywordColor || fallbackKeyColor;
		const tagsKeywordColor = relColors.tagsKeywordColor || '';
		const refKeywordColor = refColors.refKeywordColor || fallbackKeyColor;
		const refValueColor = refColors.refValueColor || fallbackValueColor;
		/** @type {Set<string>} */
		const knownTagsLower = new Set();
		for (const meta of tagGraphStore.listStoredTagGraphs(context)) {
			const graph = tagGraphStore.loadStoredTagGraphById(context, meta.id);
			for (const node of (graph && graph.nodes) || []) {
				const label = String((node && node.label) || '').trim().toLowerCase();
				if (label) knownTagsLower.add(label);
			}
		}
		/** @type {Map<string, string>} */
		const typeIdByMarker = new Map();
		for (const t of metadataSettings.types || []) {
			const marker = String(t.marker || '').trim().toLowerCase().replace(/^\./, '');
			const typeId = String(t.id || '').trim().toLowerCase();
			if (marker && typeId) typeIdByMarker.set(marker, typeId);
		}
		/** @type {Map<import('vscode').TextEditorDecorationType, import('vscode').Range[]>} */
		const buckets = new Map();

		function addRangeForToken(lineNo, line, token, colorKey) {
			const color = colorMap.get(colorKey);
			if (!color) return;
			const idx = line.toLowerCase().indexOf(String(token || '').toLowerCase());
			if (idx < 0) return;
			const range = new vscode.Range(lineNo, idx, lineNo, idx + String(token).length);
			const deco = decoForColor(color);
			if (!buckets.has(deco)) buckets.set(deco, []);
			buckets.get(deco).push(range);
		}

		function addAbsoluteRange(lineNo, start, endExclusive, color) {
			if (!color || endExclusive <= start) return;
			const range = new vscode.Range(lineNo, start, lineNo, endExclusive);
			const deco = decoForColor(color);
			if (!buckets.has(deco)) buckets.set(deco, []);
			buckets.get(deco).push(range);
		}

		function addMetadataKeyValueColoring(lineNo, lineText) {
			if (!metadataColors.useCustom) return;
			const m = String(lineText || '').match(KEY_VALUE_RE);
			if (!m) return;
			const key = String(m[1] || '');
			const value = String(m[2] || '');
			if (metadataColors.keyColor) {
				const kStart = lineText.toLowerCase().indexOf(key.toLowerCase());
				if (kStart >= 0) addAbsoluteRange(lineNo, kStart, kStart + key.length, metadataColors.keyColor);
			}
			if (metadataColors.valueColor) {
				const vStart = lineText.indexOf(value);
				if (vStart >= 0) addAbsoluteRange(lineNo, vStart, vStart + value.length, metadataColors.valueColor);
			}
		}

		function addRelationListValueColoring(lineNo, lineText, relationKey) {
			const listMatch = String(lineText || '').match(/\[([^\]]*)\]/);
			if (!listMatch) return;
			const rawInner = String(listMatch[1] || '');
			if (!rawInner.trim()) return;
			const listStart = lineText.indexOf('[');
			if (listStart < 0) return;
			const absoluteInnerStart = listStart + 1;
			const re = /[^,\s\]]+/g;
			let m;
			while ((m = re.exec(rawInner)) !== null) {
				const token = String(m[0] || '');
				if (!token) continue;
				const tokenStart = absoluteInnerStart + m.index;
				const low = token.toLowerCase();
				const isKnownTag = knownTagsLower.has(low);
				let useColor = '';
				// Color list values only for tags relation or known tag labels.
				if (relationKey === 'tags' || isKnownTag) useColor = tagsKeywordColor;
				addAbsoluteRange(lineNo, tokenStart, tokenStart + token.length, useColor);
			}
		}

		function addRefLinksColoring(lineNo, lineText) {
			const trimmed = String(lineText || '').trim();
			if (!isRefLine(trimmed)) return;
			const key = 'ref';
			const kStart = lineText.toLowerCase().indexOf(key);
			if (kStart >= 0 && refKeywordColor) {
				addAbsoluteRange(lineNo, kStart, kStart + key.length, refKeywordColor);
			}
			const listMatch = String(lineText || '').match(/\[([^\]]*)\]/);
			if (!listMatch || !refValueColor) return;
			const rawInner = String(listMatch[1] || '');
			if (!rawInner.trim()) return;
			const listStart = lineText.indexOf('[');
			if (listStart < 0) return;
			const absoluteInnerStart = listStart + 1;
			const re = /[^,\s\]]+/g;
			let m;
			while ((m = re.exec(rawInner)) !== null) {
				const token = String(m[0] || '');
				if (!token) continue;
				const tokenStart = absoluteInnerStart + m.index;
				addAbsoluteRange(lineNo, tokenStart, tokenStart + token.length, refValueColor);
			}
		}

		function addRelationAndTagColoring(lineNo, lineText) {
			const trimmed = String(lineText || '').trim();
			if (isRefLine(trimmed)) {
				addRefLinksColoring(lineNo, lineText);
				return;
			}
			const relationMatch = trimmed.match(/^([a-z][a-z0-9_-]*)\s*:\s*\[[^\]]*\]\s*$/i);
			if (relationMatch) {
				const key = String(relationMatch[1] || '').toLowerCase();
				const kStart = lineText.toLowerCase().indexOf(key);
				if (kStart >= 0 && relationKeywordColor) {
					addAbsoluteRange(lineNo, kStart, kStart + key.length, relationKeywordColor);
				}
				addRelationListValueColoring(lineNo, lineText, key);
				return;
			}
			if (/^\[[^\]]*\]\s*$/.test(trimmed)) {
				addRelationListValueColoring(lineNo, lineText, 'tags');
			}
		}

		for (let i = 0; i < lines.length; i++) {
			const line = String(lines[i] || '');
			const trimmed = line.trim();
			const tm = trimmed.match(/^\.(\w[\w-]*)\b/i);
			if (tm) {
				const marker = String(tm[1] || '').toLowerCase();
				if (types.has(marker)) {
					addRangeForToken(i, line, `.${marker}`, `.${marker}`);
				}
				if (metadataColors.useCustom) {
					const typeId = typeIdByMarker.get(marker);
					const typeColor = typeId ? metadataColors.typeColors.get(typeId) : '';
					if (typeColor) {
						const markerToken = `.${marker}`;
						const idx = line.toLowerCase().indexOf(markerToken);
						if (idx >= 0) addAbsoluteRange(i, idx, idx + markerToken.length, typeColor);
					}
				}
			}
			const mm = line.match(/^(\s*)([A-Za-z][A-Za-z0-9_-]*)(\s*[:.])(\s*)(.*)$/);
			if (mm) {
				const mark = String(mm[2] || '').trim();
				const cfg = markdownMarks.get(mark);
				if (cfg) {
					const leading = String(mm[1] || '');
					const sep = String(mm[3] || '');
					const afterSepWs = String(mm[4] || '');
					const tail = String(mm[5] || '');
					const markStart = leading.length;
					const markColor = cfg.markColor || fallbackKeyColor;
					const textColor = cfg.textColor || fallbackValueColor;
					if (markStart >= 0 && markColor) {
						addAbsoluteRange(i, markStart, markStart + mark.length, markColor);
					}
					if (tail && textColor) {
						const tailStart = markStart + mark.length + sep.length + afterSepWs.length;
						if (tailStart >= 0) addAbsoluteRange(i, tailStart, tailStart + tail.length, textColor);
					}
				}
			}
		}

		const { topEnd } = splitFileTopRegion(lines);
		for (let i = 0; i < topEnd; i++) {
			const t = String(lines[i] || '').trim();
			if (!t || COMMENT_RE.test(t)) continue;
			if (metadataColors.useCustom && (TYPE_LINE_RE.test(t) || KEY_VALUE_RE.test(t) || RELATION_RE.test(t) || isRefLine(t))) {
				addMetadataKeyValueColoring(i, lines[i]);
			}
			addRelationAndTagColoring(i, lines[i]);
		}
		for (let i = 0; i < lines.length; i++) {
			const heading = String(lines[i] || '');
			if (!HEADING_RE.test(heading)) continue;
			let j = i + 1;
			let started = false;
			for (; j < lines.length; j++) {
				const t = String(lines[j] || '').trim();
				if (HEADING_RE.test(t) || t === '---') break;
				if (!started) {
					if (!t || COMMENT_RE.test(t)) break;
					started = true;
				}
				if (!t) break;
				if (TYPE_LINE_RE.test(t) || KEY_VALUE_RE.test(t) || RELATION_RE.test(t) || isRefLine(t) || /^\[[^\]]*\]\s*$/.test(t)) {
					if (metadataColors.useCustom && (TYPE_LINE_RE.test(t) || KEY_VALUE_RE.test(t) || RELATION_RE.test(t) || isRefLine(t))) {
						addMetadataKeyValueColoring(j, lines[j]);
					}
					addRelationAndTagColoring(j, lines[j]);
					continue;
				}
				break;
			}
		}

		for (const [deco, ranges] of buckets.entries()) {
			editor.setDecorations(deco, ranges);
		}
		for (const deco of decoByColor.values()) {
			if (!buckets.has(deco)) editor.setDecorations(deco, []);
		}
	}

	function refreshAll() {
		for (const e of vscode.window.visibleTextEditors) {
			applyForEditor(e);
		}
	}

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(e => {
			applyForEditor(e);
		}),
		vscode.workspace.onDidChangeTextDocument(ev => {
			for (const e of vscode.window.visibleTextEditors) {
				if (e.document.uri.toString() === ev.document.uri.toString()) applyForEditor(e);
			}
		}),
		vscode.workspace.onDidChangeConfiguration(ev => {
			if (
				ev.affectsConfiguration('drip.dripnoteCustomColors') ||
				ev.affectsConfiguration('drip.dripnoteCustomTypeMarkers') ||
				ev.affectsConfiguration('drip.dripnoteAllowedMetadataKeys') ||
				ev.affectsConfiguration('drip.metadataUseCustomColors') ||
				ev.affectsConfiguration('drip.metadataTypeColors') ||
				ev.affectsConfiguration('drip.metadataKeyColor') ||
				ev.affectsConfiguration('drip.metadataValueColor') ||
				ev.affectsConfiguration('drip.metadataTypes') ||
				ev.affectsConfiguration('drip.dripMetadataMarks') ||
				ev.affectsConfiguration('drip.tagsRelationsConfig') ||
				ev.affectsConfiguration('drip.refLinksConfig')
			) {
				refreshAll();
			}
		})
	);

	refreshAll();
}

module.exports = {
	registerDripnoteCustomDecorations,
	getMetadataColorSettings,
	getRelationsKeywordColors,
	getCustomColorMap
};

