'use strict';

/**
 * DRIP Chat long-term memory: one plain-text file per KB at `.dripindex/chat-memory.md`.
 * Sent with every chat request; changed only when the user asks DRIP to remember / forget
 * something (LLM returns ltAdd/ltRemove) or edits it in the chat Memory panel.
 * Short-term (session) memory lives in `src/views/rhs/chat/panel.js` and is cleared on reload.
 */

const vscode = require('vscode');
const { getDripIndexRootUri } = require('../startup/initializeDripIndex');

const MEMORY_FILE = 'chat-memory.md';
/** Cap on memory text sent to the LLM (keeps every request small). */
const MEMORY_PROMPT_CHAR_LIMIT = 1500;
const HEADER = '# DRIP chat memory\n# One item per line. DRIP adds/removes lines when you ask it to remember or forget something; you can edit this file directly.\n';

/** @param {import('vscode').Uri} kbRoot */
function getChatMemoryUri(kbRoot) {
	return vscode.Uri.joinPath(getDripIndexRootUri(kbRoot), MEMORY_FILE);
}

/**
 * @param {import('vscode').Uri} kbRoot
 * @returns {Promise<string[]>} memory items (header/comment lines and `- ` bullets stripped)
 */
async function readChatMemoryItems(kbRoot) {
	let text = '';
	try {
		text = Buffer.from(await vscode.workspace.fs.readFile(getChatMemoryUri(kbRoot))).toString('utf8');
	} catch {
		return [];
	}
	return text
		.replace(/\r\n/g, '\n')
		.split('\n')
		.map(l => l.trim())
		.filter(l => l && !l.startsWith('#'))
		.map(l => l.replace(/^[-*]\s+/, '').trim())
		.filter(Boolean);
}

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {string[]} items
 */
async function writeChatMemoryItems(kbRoot, items) {
	const body = items.map(i => `- ${i}`).join('\n');
	await vscode.workspace.fs.createDirectory(getDripIndexRootUri(kbRoot));
	await vscode.workspace.fs.writeFile(getChatMemoryUri(kbRoot), Buffer.from(`${HEADER}\n${body}${body ? '\n' : ''}`, 'utf8'));
}

/** @param {string} s */
function normalizeItem(s) {
	return String(s || '')
		.replace(/^[-*]\s+/, '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ');
}

/**
 * Apply LLM memory ops. `remove` entries match existing items by normalized text.
 * @param {import('vscode').Uri} kbRoot
 * @param {{ add?: string[], remove?: string[] }} ops
 * @returns {Promise<{ added: string[], removed: string[], items: string[] }>}
 */
async function applyChatMemoryOps(kbRoot, ops) {
	const items = await readChatMemoryItems(kbRoot);
	const removeKeys = new Set((ops.remove || []).map(normalizeItem).filter(Boolean));
	const removed = items.filter(i => removeKeys.has(normalizeItem(i)));
	const kept = items.filter(i => !removeKeys.has(normalizeItem(i)));
	const existing = new Set(kept.map(normalizeItem));
	const added = [];
	for (const raw of ops.add || []) {
		const item = String(raw || '').replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
		if (!item || existing.has(normalizeItem(item))) continue;
		existing.add(normalizeItem(item));
		kept.push(item);
		added.push(item);
	}
	if (added.length || removed.length) await writeChatMemoryItems(kbRoot, kept);
	return { added, removed, items: kept };
}

/**
 * Memory block for the prompt (numbered, capped).
 * @param {string[]} items
 */
function formatMemoryForPrompt(items) {
	if (!items.length) return '(empty)';
	let out = '';
	for (const item of items) {
		const line = `- ${item}\n`;
		if (out.length + line.length > MEMORY_PROMPT_CHAR_LIMIT) {
			out += '- …(older memory truncated)\n';
			break;
		}
		out += line;
	}
	return out.trimEnd();
}

/**
 * Save user-edited memory text (one item per line; `- ` bullets optional).
 * @param {import('vscode').Uri} kbRoot
 * @param {string} text
 * @returns {Promise<string[]>}
 */
async function saveChatMemoryText(kbRoot, text) {
	const items = String(text || '')
		.replace(/\r\n/g, '\n')
		.split('\n')
		.map(l => l.trim())
		.filter(l => l && !l.startsWith('#'))
		.map(l => l.replace(/^[-*]\s+/, '').trim())
		.filter(Boolean);
	await writeChatMemoryItems(kbRoot, items);
	return items;
}

/**
 * Open the memory file in the editor (creates it if missing).
 * @param {import('vscode').Uri} kbRoot
 */
async function openChatMemoryFile(kbRoot) {
	const uri = getChatMemoryUri(kbRoot);
	try {
		await vscode.workspace.fs.stat(uri);
	} catch {
		await writeChatMemoryItems(kbRoot, []);
	}
	await vscode.window.showTextDocument(uri);
}

module.exports = {
	getChatMemoryUri,
	readChatMemoryItems,
	applyChatMemoryOps,
	saveChatMemoryText,
	formatMemoryForPrompt,
	openChatMemoryFile
};
