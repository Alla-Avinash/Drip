'use strict';

/**
 * DRIP Settings → Keyboard Shortcuts: read / change DRIP command keybindings.
 * VS Code has no API to set keybindings, so this edits the user's `keybindings.json`
 * in place (only DRIP command entries are touched; other entries and comments are kept).
 * VS Code watches that file, so changes apply immediately.
 */

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

/** Commands listed in the settings panel (order = display order). Titles come from package.json. */
const SHORTCUT_COMMAND_IDS = [
	'drip.openComposer',
	'drip.captureSelectionToComposer',
	'drip.focusChat',
	'drip.addSelectionToChat',
	'drip.openRetriever',
	'drip.retrieverQuickOpen',
	'drip.openTagsPanel',
	'drip.openProjectView',
	'drip.openKbEditor',
	'drip.openTodayDailyNote',
	'drip.openDripSettingsView',
	'drip.selectKnowledgeBase'
];

/**
 * `<userData>/User/globalStorage/<ext>` → `<userData>/User/keybindings.json`
 * @param {import('vscode').ExtensionContext} context
 */
function getUserKeybindingsPath(context) {
	return path.join(path.dirname(path.dirname(context.globalStorageUri.fsPath)), 'keybindings.json');
}

/**
 * Remove // and /* *\/ comments and trailing commas so JSON.parse can read JSONC.
 * @param {string} text
 */
function stripJsonc(text) {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (ch === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++;
		} else if (ch === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? text.length : end + 2;
		} else {
			out += ch;
			i++;
		}
	}
	return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Locate the top-level array and the text span of each `{…}` element (comment/string aware).
 * @param {string} text
 * @returns {{ open: number, close: number, elements: Array<{ start: number, end: number, value: any }> } | null}
 */
function scanKeybindingsArray(text) {
	let open = -1;
	let depth = 0;
	let elStart = -1;
	/** @type {Array<{ start: number, end: number, value: any }>} */
	const elements = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
			i = j + 1;
			continue;
		}
		if (ch === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++;
			continue;
		}
		if (ch === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? text.length : end + 2;
			continue;
		}
		if (ch === '[' && open < 0) {
			open = i;
		} else if (open >= 0 && ch === '{') {
			if (depth === 0) elStart = i;
			depth++;
		} else if (open >= 0 && ch === '}') {
			depth--;
			if (depth === 0 && elStart >= 0) {
				let value = null;
				try {
					value = JSON.parse(stripJsonc(text.slice(elStart, i + 1)));
				} catch {
					value = null;
				}
				elements.push({ start: elStart, end: i + 1, value });
				elStart = -1;
			}
		} else if (open >= 0 && depth === 0 && ch === ']') {
			return { open, close: i, elements };
		}
		i++;
	}
	return null;
}

/** @param {string} key */
function normalizeKey(key) {
	return String(key || '')
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.join(' ');
}

/**
 * @param {string} p
 * @returns {Promise<string>}
 */
async function readKeybindingsText(p) {
	try {
		return await fs.promises.readFile(p, 'utf8');
	} catch {
		return '[\n]\n';
	}
}

/**
 * Default keybindings + titles from this extension's package.json.
 * @param {import('vscode').ExtensionContext} context
 */
function readPackageDefaults(context) {
	const pkg = context.extension ? context.extension.packageJSON : require('../../package.json');
	const contributes = (pkg && pkg.contributes) || {};
	/** @type {Record<string, string>} */
	const titles = {};
	for (const c of contributes.commands || []) {
		if (c && c.command) titles[c.command] = String(c.title || c.command).replace(/^DRIP:\s*/, '');
	}
	/** @type {Record<string, string>} */
	const defaults = {};
	const platformKey = process.platform === 'darwin' ? 'mac' : process.platform === 'linux' ? 'linux' : 'win';
	for (const kb of contributes.keybindings || []) {
		if (!kb || !kb.command) continue;
		const key = kb[platformKey] || kb.key;
		if (key) defaults[kb.command] = normalizeKey(key);
	}
	return { titles, defaults };
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @returns {Promise<{ rows: Array<{ id: string, title: string, defaultKey: string, keys: string[], customized: boolean, conflicts: string[] }>, keybindingsPath: string }>}
 */
async function getDripShortcuts(context) {
	const keybindingsPath = getUserKeybindingsPath(context);
	const text = await readKeybindingsText(keybindingsPath);
	const scanned = scanKeybindingsArray(text);
	const entries = scanned ? scanned.elements.map(e => e.value).filter(v => v && typeof v === 'object') : [];
	const { titles, defaults } = readPackageDefaults(context);

	/** @type {Map<string, string[]>} effective key → command ids */
	const byKey = new Map();
	const rows = SHORTCUT_COMMAND_IDS.map(id => {
		const userAdds = entries.filter(e => e.command === id && e.key).map(e => normalizeKey(e.key));
		const removesDefault = entries.some(
			e => e.command === `-${id}` && (!e.key || normalizeKey(e.key) === defaults[id])
		);
		const keys = [...userAdds];
		if (defaults[id] && !removesDefault && !keys.includes(defaults[id])) keys.unshift(defaults[id]);
		const customized = entries.some(e => e.command === id || e.command === `-${id}`);
		return { id, title: titles[id] || id, defaultKey: defaults[id] || '', keys, customized, conflicts: [] };
	});

	for (const row of rows) {
		for (const k of row.keys) {
			if (!byKey.has(k)) byKey.set(k, []);
			byKey.get(k).push(row.title);
		}
	}
	for (const e of entries) {
		if (!e.key || typeof e.command !== 'string' || e.command.startsWith('-') || e.command.startsWith('drip.')) continue;
		const k = normalizeKey(e.key);
		if (!byKey.has(k)) byKey.set(k, []);
		byKey.get(k).push(e.command);
	}
	for (const row of rows) {
		const others = new Set();
		for (const k of row.keys) {
			for (const who of byKey.get(k) || []) if (who !== row.title) others.add(`${k} → ${who}`);
		}
		row.conflicts = [...others];
	}
	return { rows, keybindingsPath };
}

/**
 * Replace every user entry for `commandId` with the given entries (text-preserving edit).
 * @param {string} text
 * @param {string} commandId
 * @param {Array<{ key: string, command: string }>} newEntries
 */
function rewriteCommandEntries(text, commandId, newEntries) {
	let scanned = scanKeybindingsArray(text);
	if (!scanned) {
		text = '[\n]\n';
		scanned = scanKeybindingsArray(text);
	}
	const doomed = scanned.elements
		.filter(e => e.value && (e.value.command === commandId || e.value.command === `-${commandId}`))
		.reverse();
	for (const el of doomed) {
		let start = el.start;
		let end = el.end;
		const after = /^\s*,/.exec(text.slice(end));
		if (after) {
			end += after[0].length;
		} else {
			const before = /,\s*$/.exec(text.slice(0, start));
			if (before) start -= before[0].length;
		}
		while (start > 0 && (text[start - 1] === '\t' || text[start - 1] === ' ')) start--;
		if (text[start - 1] === '\n' && text[end] === '\n') start--;
		text = text.slice(0, start) + text.slice(end);
	}
	if (!newEntries.length) return text;

	const chunk = newEntries
		.map(e => `\t{\n\t\t"key": ${JSON.stringify(e.key)},\n\t\t"command": ${JSON.stringify(e.command)}\n\t}`)
		.join(',\n');
	const again = scanKeybindingsArray(text);
	if (!again.elements.length) {
		return `${text.slice(0, again.open + 1)}\n${chunk}\n${text.slice(again.open + 1).replace(/^\s*\n?/, '')}`;
	}
	const last = again.elements[again.elements.length - 1];
	return `${text.slice(0, last.end)},\n${chunk}${text.slice(last.end)}`;
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} commandId
 * @param {'set'|'reset'|'remove'} mode
 * @param {string} [key] required for `set`
 */
async function updateDripShortcut(context, commandId, mode, key) {
	if (!SHORTCUT_COMMAND_IDS.includes(commandId)) throw new Error(`Unknown DRIP command: ${commandId}`);
	const { defaults } = readPackageDefaults(context);
	const def = defaults[commandId] || '';
	const k = normalizeKey(key);
	/** @type {Array<{ key: string, command: string }>} */
	const entries = [];
	if (mode === 'set') {
		if (!k) throw new Error('Press a key combination first.');
		if (def && def !== k) entries.push({ key: def, command: `-${commandId}` });
		if (def !== k) entries.push({ key: k, command: commandId });
	} else if (mode === 'remove') {
		if (def) entries.push({ key: def, command: `-${commandId}` });
	}
	const p = getUserKeybindingsPath(context);
	const text = await readKeybindingsText(p);
	const next = rewriteCommandEntries(text, commandId, entries);
	if (next === text) return;
	await fs.promises.mkdir(path.dirname(p), { recursive: true });
	await fs.promises.writeFile(p, next, 'utf8');
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
async function openUserKeybindingsFile(context) {
	const p = getUserKeybindingsPath(context);
	await vscode.window.showTextDocument(vscode.Uri.file(p));
}

module.exports = {
	SHORTCUT_COMMAND_IDS,
	getDripShortcuts,
	updateDripShortcut,
	openUserKeybindingsFile
};
