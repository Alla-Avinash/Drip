'use strict';

const vscode = require('vscode');
const { tokenizeDripnote } = require('./dripnoteColoringTokens');

/**
 * Editor decoration overlays on top of the semantic-token theme base:
 *   1. Doc Coloring — the nine role colors, applied only where the user set a custom hex
 *      (empty = follow the theme palette handled by dripnoteSemanticTokens.js).
 *   2. Markdown marks — the user-assigned mark/text colors (empty = plain text).
 */

// Doc Coloring role -> setting key mapping (see dripnoteColoringTokens.js for roles).
const ROLE_TO_COLOR_KEY = {
	type: 'color1',
	heading: 'color2',
	metakey: 'color3',
	relationkey: 'color4',
	metavalue: 'color5',
	fileidentity: 'color6',
	identityvalue: 'color7',
	typedvalue: 'color8',
	relationvalue: 'color9'
};

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

function getDocColors() {
	const cfg = vscode.workspace.getConfiguration('drip');
	const raw = cfg.get('dripnoteDocColors', {}) || {};
	/** @type {Record<string, string>} */
	const out = {};
	for (let i = 1; i <= 9; i++) {
		const key = `color${i}`;
		out[key] = String((raw && raw[key]) || '').trim();
	}
	return out;
}

function registerDripnoteCustomDecorations(context) {
	/** @type {Map<string, import('vscode').TextEditorDecorationType>} */
	const decoCache = new Map();

	function decoFor(color, bold) {
		const key = `${bold ? 'b' : ''}${color}`;
		if (decoCache.has(key)) return decoCache.get(key);
		const opts = {};
		if (color) opts.color = color;
		if (bold) opts.fontWeight = 'bold';
		const d = vscode.window.createTextEditorDecorationType(opts);
		decoCache.set(key, d);
		context.subscriptions.push(d);
		return d;
	}

	function applyForEditor(editor) {
		if (!editor || editor.document.languageId !== 'dripnote') return;
		const doc = editor.document;
		const lines = doc.getText().split(/\r?\n/);
		/** @type {Map<import('vscode').TextEditorDecorationType, import('vscode').Range[]>} */
		const buckets = new Map();

		function addRange(lineNo, start, end, color, bold) {
			if (end <= start) return;
			if (!color && !bold) return;
			const deco = decoFor(color, bold);
			if (!buckets.has(deco)) buckets.set(deco, []);
			buckets.get(deco).push(new vscode.Range(lineNo, start, lineNo, end));
		}

		// Doc Coloring: heading-line tokens are always bold (reliable across themes);
		// a role's color is applied only where the user set a custom hex override.
		const docColors = getDocColors();
		for (const t of tokenizeDripnote(lines)) {
			const key = ROLE_TO_COLOR_KEY[t.role];
			const color = key ? docColors[key] : '';
			if (color || t.bold) addRange(t.line, t.start, t.start + t.length, color, !!t.bold);
		}

		// Markdown marks (L:, Q:, R:, …).
		const markdownMarks = getMarkdownMarksSettings();
		for (let i = 0; i < lines.length; i++) {
			const line = String(lines[i] || '');
			const mm = line.match(/^(\s*)([A-Za-z][A-Za-z0-9_-]*)(\s*[:.])(\s*)(.*)$/);
			if (!mm) continue;
			const mark = String(mm[2] || '').trim();
			const cfg = markdownMarks.get(mark);
			if (!cfg) continue;
			const leading = String(mm[1] || '');
			const sep = String(mm[3] || '');
			const afterSepWs = String(mm[4] || '');
			const tail = String(mm[5] || '');
			const markStart = leading.length;
			if (cfg.markColor) {
				addRange(i, markStart, markStart + mark.length, cfg.markColor, false);
			}
			if (tail && cfg.textColor) {
				const tailStart = markStart + mark.length + sep.length + afterSepWs.length;
				addRange(i, tailStart, tailStart + tail.length, cfg.textColor, false);
			}
		}

		for (const [deco, ranges] of buckets.entries()) {
			editor.setDecorations(deco, ranges);
		}
		for (const deco of decoCache.values()) {
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
				ev.affectsConfiguration('drip.dripnoteDocColors') ||
				ev.affectsConfiguration('drip.dripMetadataMarks') ||
				ev.affectsConfiguration('drip.metadataTypes') ||
				ev.affectsConfiguration('drip.tagsRelationsConfig') ||
				ev.affectsConfiguration('drip.dripnoteCustomTypeMarkers')
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
