'use strict';

/**
 * Resolves the real theme colors for the nine DRIP "Doc Coloring" roles.
 *
 * The .d.txt editor color comes from VS Code resolving the semantic-token scopes in
 * `package.json` (`semanticTokenScopes`) against the active theme's TextMate rules
 * (`tokenColors`) plus `editor.tokenColorCustomizations` and
 * `editor.semanticTokenColorCustomizations`. Webviews cannot read those token colors
 * (VS Code does not expose them), so this module resolves them here in the extension
 * host and returns concrete hex colors for the settings webview to render — matching
 * the editor exactly, theme and any token-color customizations included.
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// Doc Coloring role -> semantic token type. See the `role` values in
// dripTxtColoringTokens.js and ROLE_TO_COLOR_KEY in dripTxtCustomDecorations.js.
const ROLE_TO_SEMANTIC_TYPE = {
	color1: 'metatype',
	color2: 'heading',
	color3: 'metakey',
	color4: 'relationkey',
	color5: 'metavalue',
	color6: 'fileidentity',
	color7: 'identityvalue',
	color8: 'typedvalue',
	color9: 'relationvalue'
};

// Semantic token types that render with the `declaration` (bold) modifier in the
// editor, so their color can also be overridden via `<type>.declaration`.
const DECLARATION_TYPES = new Set(['metatype', 'heading']);

function getSemanticScopes() {
	try {
		const pkg = require('../../../package.json');
		const list = pkg && pkg.contributes && pkg.contributes.semanticTokenScopes;
		const entry = Array.isArray(list) && list.find(s => s.language === 'dripnote');
		return (entry && entry.scopes) || {};
	} catch {
		return {};
	}
}

function normalizeHex(value) {
	const s = String(value || '').trim();
	if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
	if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
	if (/^#[0-9a-f]{8}$/i.test(s)) return s.slice(0, 7).toLowerCase();
	const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
	if (m) {
		return '#' + [m[1], m[2], m[3]].map(n => {
			const h = Number(n).toString(16);
			return h.length === 1 ? '0' + h : h;
		}).join('');
	}
	return '';
}

/** Build the ancestor scope stack (broadest -> most specific) for a scope string. */
function scopeStack(scope) {
	const parts = String(scope || '').split('.').filter(Boolean);
	const stack = [];
	for (let i = 1; i <= parts.length; i++) stack.push(parts.slice(0, i).join('.'));
	return stack;
}

function scopeElementMatches(element, selectorPath) {
	return element === selectorPath || element.startsWith(selectorPath + '.');
}

/** Score a TextMate scope selector against a scope stack; -1 means no match. */
function selectorScore(selector, stack) {
	if (!selector) return -1;
	let best = -1;
	const chunks = String(selector).split(',').map(s => s.trim()).filter(Boolean);
	for (const chunk of chunks) {
		const parts = chunk.split(/\s+/).filter(Boolean);
		const positives = [];
		const negatives = [];
		for (const p of parts) {
			if (p.startsWith('-') && p.length > 1) negatives.push(p.slice(1));
			else positives.push(p);
		}
		let si = 0;
		let score = 0;
		let ok = true;
		for (const p of positives) {
			let found = false;
			while (si < stack.length) {
				if (scopeElementMatches(stack[si], p)) { score += p.length; si++; found = true; break; }
				si++;
			}
			if (!found) { ok = false; break; }
		}
		if (ok) {
			for (const n of negatives) {
				for (const el of stack) if (scopeElementMatches(el, n)) { ok = false; break; }
				if (!ok) break;
			}
		}
		if (ok && score > best) best = score;
	}
	return best;
}

/** Best matching `foreground` among an ordered list of TextMate rules (later wins ties). */
function bestRuleForeground(rules, scope) {
	const stack = scopeStack(scope);
	let bestScore = -1;
	let bestColor = '';
	for (const rule of rules) {
		const fg = rule && rule.settings && rule.settings.foreground;
		if (!fg) continue;
		const sels = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
		let ruleScore = -1;
		for (const sel of sels) {
			const s = selectorScore(sel, stack);
			if (s > ruleScore) ruleScore = s;
		}
		if (ruleScore >= 0 && ruleScore >= bestScore) {
			bestScore = ruleScore;
			bestColor = normalizeHex(fg) || bestColor;
		}
	}
	return bestColor;
}

/** Find a color theme contribution by its id or label across all extensions. */
function findThemeContribution(wanted) {
	if (!wanted) return null;
	for (const ext of vscode.extensions.all) {
		const themes = ext.packageJSON && ext.packageJSON.contributes && ext.packageJSON.contributes.themes;
		if (!Array.isArray(themes)) continue;
		for (const t of themes) {
			if (t.id === wanted || t.label === wanted) {
				return { extensionPath: ext.extensionPath, theme: t };
			}
		}
	}
	return null;
}

/** Read a theme JSON file, following `include` (base themes), returning rules + colors. */
function readThemeJson(baseDir, themePath, depth) {
	if (depth > 5) return { rules: [], colors: {} };
	const full = path.isAbsolute(themePath) ? themePath : path.join(baseDir, themePath);
	try {
		const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
		let rules = Array.isArray(parsed.tokenColors) ? parsed.tokenColors.slice() : [];
		let colors = parsed.colors && typeof parsed.colors === 'object' ? parsed.colors : {};
		if (parsed.include && typeof parsed.include === 'string') {
			const base = readThemeJson(path.dirname(full), parsed.include, depth + 1);
			rules = base.rules.concat(rules);
			colors = Object.assign({}, base.colors, colors);
		}
		return { rules, colors };
	} catch (err) {
		console.error('[DRIP] read theme failed', full, err);
		return { rules: [], colors: {} };
	}
}

function getActiveThemeRules() {
	const wanted = String(vscode.workspace.getConfiguration('workbench').get('colorTheme', '') || '');
	const contrib = findThemeContribution(wanted);
	if (!contrib) return { rules: [], editorForeground: '' };
	const loaded = readThemeJson(contrib.extensionPath, contrib.theme.path, 0);
	const editorFg = normalizeHex(loaded.colors && loaded.colors['editor.foreground']);
	return { rules: loaded.rules, editorForeground: editorFg };
}

/** `editor.tokenColorCustomizations` rules (shorthand scopes + textMateRules). */
function getTokenColorCustomizationRules() {
	const v = vscode.workspace.getConfiguration('editor').get('tokenColorCustomizations');
	const rules = [];
	if (typeof v === 'string' && v) {
		const contrib = findThemeContribution(v);
		if (contrib) rules.push(...readThemeJson(contrib.extensionPath, contrib.theme.path, 0).rules);
	} else if (v && typeof v === 'object') {
		for (const [k, val] of Object.entries(v)) {
			if (k === 'textMateRules' || k === 'comments') continue;
			if (typeof val === 'string') rules.push({ scope: k, settings: { foreground: val } });
			else if (val && typeof val === 'object' && val.foreground) rules.push({ scope: k, settings: { foreground: val.foreground } });
		}
		if (Array.isArray(v.textMateRules)) {
			for (const r of v.textMateRules) rules.push({ scope: r.scope, settings: r.settings || {} });
		}
	}
	return rules;
}

/** `editor.semanticTokenColorCustomizations` keyed by semantic token type. */
function getSemanticTokenColorCustomizations() {
	const v = vscode.workspace.getConfiguration('editor').get('semanticTokenColorCustomizations');
	const map = {};
	if (!v || typeof v !== 'object') return map;
	const rules = v.rules && typeof v.rules === 'object' ? v.rules : v;
	for (const [k, val] of Object.entries(rules)) {
		if (k === 'enabled') continue;
		let color = '';
		if (typeof val === 'string') color = val;
		else if (val && typeof val === 'object' && val.foreground) color = val.foreground;
		const hex = normalizeHex(color);
		if (hex) map[k] = hex;
	}
	return map;
}

function defaultForeground() {
	const k = vscode.window.activeColorTheme.kind;
	if (k === vscode.ColorThemeKind.Light || k === vscode.ColorThemeKind.HighContrastLight) return '#333333';
	if (k === vscode.ColorThemeKind.HighContrast) return '#ffffff';
	return '#cccccc';
}

/**
 * @returns {Record<string, string>} `{ color1..color9: hex }` resolved from the active
 * theme (with token/semantic color customizations). Empty string when unknown.
 */
function getDocRoleThemeColors() {
	const scopes = getSemanticScopes();
	const semantic = getSemanticTokenColorCustomizations();
	const theme = getActiveThemeRules();
	const rules = theme.rules.concat(getTokenColorCustomizationRules());
	const editorFg = theme.editorForeground || defaultForeground();

	const out = {};
	for (const key of Object.keys(ROLE_TO_SEMANTIC_TYPE)) {
		const type = ROLE_TO_SEMANTIC_TYPE[key];
		let color = '';
		if (DECLARATION_TYPES.has(type)) {
			color = semantic[type + '.declaration'] || semantic[type] || '';
		} else {
			color = semantic[type] || '';
		}
		if (!color) {
			const scopeList = scopes[type];
			const scope = Array.isArray(scopeList) && scopeList.length ? scopeList[0] : scopeList;
			if (scope) color = bestRuleForeground(rules, scope);
		}
		out[key] = color || editorFg || '';
	}
	return out;
}

module.exports = {
	getDocRoleThemeColors
};
