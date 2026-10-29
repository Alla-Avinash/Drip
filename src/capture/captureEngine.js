'use strict';

/**
 * Quick Capture pipeline:
 *   note text → semantic search top-N headings → read each heading's body
 *   → classify via the user's own LLM (append | merge | new) → apply surgically.
 * "new" (no close match) always asks the user before creating anything.
 */

const vscode = require('vscode');
const { searchHeadingsByEmbedding } = require('../indexing/embeddings/headingEmbeddingSearch');
const { readHeadingBlock, appendToHeading, mergeHeadingBody } = require('./headingContent');
const { getLlmConfig, getLlmApiKey } = require('../llm/llmSettings');
const { chatComplete } = require('../llm/llmClient');
const { readChatMemoryItems, applyChatMemoryOps, formatMemoryForPrompt } = require('../llm/chatMemory');
const { readTextFile, writeTextFile, buildNewNoteFile } = require('../document/dripNoteKbOps.js');
const { buildNoteFileName } = require('../document/model/dripNoteFileTypes.js');

const TOP_N = 5;
const BODY_CHAR_LIMIT = 600;
const LAST_EXCHANGE_CHAR_LIMIT = 300;
/** A merged body shorter than this share of the original means the LLM dropped text → append instead. */
const MERGE_MIN_KEEP_RATIO = 0.9;
const SHORT_TERM_CHAR_LIMIT = 500;
/** max_tokens is only a ceiling (billing is per generated token); reasoning models also spend it on hidden thinking. */
const REPLY_TOKEN_FLOOR = 2048;
const RETRY_TOKEN_CAP = 8192;
/** Section + note larger than this can't be re-written within RETRY_TOKEN_CAP (~3 chars/token) → append. */
const MERGE_MAX_CHARS = RETRY_TOKEN_CAP * 3;
/** Pure memory instructions skip heading search, so no candidate text is sent. */
const MEMORY_REQUEST_RE = /^\s*(please\s+)?(remember|forget|from now on)\b/i;

/**
 * @param {import('vscode').Uri} uri
 * @returns {import('vscode').TextDocument | undefined}
 */
function openDocumentFor(uri) {
	const key = uri.fsPath.toLowerCase();
	return vscode.workspace.textDocuments.find(d => d.uri.fsPath.toLowerCase() === key);
}

/**
 * Live editor text when the note is open (may be unsaved), else disk.
 * @param {import('vscode').Uri} uri
 */
async function readNoteText(uri) {
	const doc = openDocumentFor(uri);
	return doc ? doc.getText().replace(/\r\n/g, '\n') : readTextFile(uri);
}

/**
 * Write through the open editor (keeps undo) or to disk.
 * @param {import('vscode').Uri} uri
 * @param {string} text
 */
async function writeNoteText(uri, text) {
	const doc = openDocumentFor(uri);
	if (!doc) {
		await writeTextFile(uri, text);
		return;
	}
	const edit = new vscode.WorkspaceEdit();
	const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
	edit.replace(doc.uri, full, text);
	await vscode.workspace.applyEdit(edit);
	await doc.save();
}

/**
 * @param {import('vscode').Uri} uri
 */
async function uriExists(uri) {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {string} s
 * @param {number} n
 */
function truncate(s, n) {
	const t = String(s || '').trim();
	return t.length <= n ? t : `${t.slice(0, n)}…`;
}

/** Static instructions — identical on every call so providers can cache the prefix. */
const SYSTEM_PROMPT = `You are DRIP, a note-filing assistant for a personal knowledge base. Reply with ONLY one JSON object, no prose.

Fields:
action: "append" | "merge" | "new" | "none"
  append: the note is a distinct new point for candidate [target].
  merge: the note belongs inside candidate [target]'s existing text (it extends or corrects a point there).
  new: a note, but no candidate fits; suggestedTitle = short title.
  none: not a note (a remember/forget request, a question); just reply.
target: candidate index, or -1.
remove: sentences in the message that are requests to you rather than note content (e.g. "now help me put the above text in its right place"), copied exactly, so they are not filed. Omit if there are none.
ltAdd / ltRemove: long-term memory lines to add / delete (copy deleted lines exactly). ONLY when the user asks to remember, forget or change a lasting preference. Otherwise omit.
st: new short-term memory (max 3 short lines) for this session. ONLY when the working context changes (new topic, a decision to carry forward). Otherwise omit.
reply: one short sentence for the user.

Follow long-term memory when choosing where notes go. Use short-term memory and the previous exchange only to resolve references like "that" or "it".`;

/** Second call, only for "merge": sees the FULL text of the one chosen section. */
const MERGE_SYSTEM_PROMPT = `You merge a note into one section of a personal knowledge base. Reply with ONLY JSON: {"body":"..."}.
body = the section text with the note woven in where it fits best. Keep every existing line and its wording; only add the note's content and make small edits so it reads naturally. Keep the existing formatting (bullets, line breaks). Do not add headings.`;

/**
 * Only non-empty sections are sent.
 * @param {string} noteText
 * @param {Array<{ title: string, body: string }>} candidates
 * @param {{ longTerm: string, shortTerm: string, lastExchange: { user: string, assistant: string } | null }} ctx
 */
function buildUserPrompt(noteText, candidates, ctx) {
	const parts = [];
	if (ctx.longTerm) parts.push(`Long-term memory:\n${ctx.longTerm}`);
	if (ctx.shortTerm) parts.push(`Short-term memory:\n${truncate(ctx.shortTerm, SHORT_TERM_CHAR_LIMIT)}`);
	if (ctx.lastExchange) {
		parts.push(
			`Previous exchange:\nUser: ${truncate(ctx.lastExchange.user, LAST_EXCHANGE_CHAR_LIMIT)}\nDRIP: ${truncate(ctx.lastExchange.assistant, LAST_EXCHANGE_CHAR_LIMIT)}`
		);
	}
	if (candidates.length) {
		const listing = candidates
			.map((c, i) => `[${i}] ${c.title}\n${truncate(c.body, BODY_CHAR_LIMIT) || '(empty)'}`)
			.join('\n');
		parts.push(`Candidates:\n${listing}`);
	}
	parts.push(`Message:\n${noteText}`);
	return parts.join('\n\n');
}

/** @param {unknown} v */
function toStringList(v) {
	return Array.isArray(v) ? v.map(x => String(x || '').trim()).filter(Boolean) : [];
}

/**
 * Pull the JSON object out of an LLM reply; errors say what actually went wrong.
 * @param {{ content: string, finishReason: string }} reply
 * @returns {any}
 */
function parseJsonReply(reply) {
	const s = String(reply.content || '').trim();
	const cleaned = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
	const start = cleaned.indexOf('{');
	const end = cleaned.lastIndexOf('}');
	if (start >= 0 && end > start) {
		try {
			return JSON.parse(cleaned.slice(start, end + 1));
		} catch {
			/* fall through to the errors below */
		}
	}
	if (reply.finishReason === 'length') {
		const err = new Error(
			'The LLM ran out of output tokens before finishing its reply. If your model is a reasoning/thinking model ' +
				'(e.g. gpt-5, o-series, DeepSeek-R1, Qwen3), its hidden thinking uses up the limit — pick a non-reasoning model ' +
				'such as gpt-4o-mini in DRIP Settings → Lightweight LLM.'
		);
		/** @type {any} */ (err).cutOff = true;
		throw err;
	}
	throw new Error(`The LLM did not reply in the expected format. It said: "${truncate(s, 200) || '(empty)'}"`);
}

/** Reply ceiling: room to echo `chars` of text back plus JSON overhead, never below the floor. */
function replyTokenBudget(chars, cap) {
	return Math.min(cap, Math.max(REPLY_TOKEN_FLOOR, 300 + Math.ceil(chars / 2)));
}

/**
 * chatComplete in JSON mode; one retry with a larger ceiling if the reply was cut off.
 * @param {Parameters<typeof chatComplete>[0]} opts
 * @returns {Promise<any>} parsed JSON object
 */
async function completeJson(opts) {
	let reply = await chatComplete({ ...opts, json: true });
	const limit = opts.maxTokens || REPLY_TOKEN_FLOOR;
	if (reply.finishReason === 'length' && limit < RETRY_TOKEN_CAP) {
		reply = await chatComplete({ ...opts, json: true, maxTokens: RETRY_TOKEN_CAP });
	}
	return parseJsonReply(reply);
}

/**
 * @param {any} obj parsed JSON reply
 * @returns {{ action: string, target: number, remove: string[], suggestedTitle: string, ltAdd: string[], ltRemove: string[], st: string | undefined, reply: string }}
 */
function parseDecision(obj) {
	const action = String(obj.action || 'none').toLowerCase();
	if (action !== 'append' && action !== 'merge' && action !== 'new' && action !== 'none') {
		throw new Error(`Unknown action "${obj.action}".`);
	}
	return {
		action,
		target: Number.isFinite(Number(obj.target)) ? Number(obj.target) : -1,
		remove: toStringList(obj.remove),
		suggestedTitle: String(obj.suggestedTitle || '').trim(),
		ltAdd: toStringList(obj.ltAdd),
		ltRemove: toStringList(obj.ltRemove),
		st: typeof obj.st === 'string' ? obj.st.trim().slice(0, SHORT_TERM_CHAR_LIMIT) : undefined,
		reply: String(obj.reply || '').trim()
	};
}

/**
 * Cut the LLM-identified requests out of the user's own text (the note is never re-typed by the LLM).
 * @param {string} note
 * @param {string[]} remove
 */
function stripRequests(note, remove) {
	let out = note;
	for (const r of remove) {
		const i = out.toLowerCase().indexOf(r.toLowerCase());
		if (i >= 0) out = out.slice(0, i) + out.slice(i + r.length);
	}
	return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {import('vscode').Uri} uri
 * @param {import('vscode').ExtensionContext} context
 */
async function reindexNote(kbRoot, uri, context) {
	const { indexNewNoteImmediately } = require('../indexing/dripTxt/dripTxtIndex.js');
	try {
		await indexNewNoteImmediately(kbRoot, uri, context);
	} catch (err) {
		console.error('[DRIP] quick capture reindex', err);
	}
}

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {string} title
 * @param {string} noteText
 * @param {import('vscode').ExtensionContext} context
 * @returns {Promise<import('vscode').Uri>}
 */
async function createNewNote(kbRoot, title, noteText, context) {
	const { allocateNextEntityNumber, indexNewNoteImmediately } = require('../indexing/dripTxt/dripTxtIndex.js');
	const safeTitle =
		(String(title || '').trim() || String(noteText.split('\n')[0] || '').trim() || 'Untitled').slice(0, 80) ||
		'Untitled';
	let name = buildNoteFileName(safeTitle);
	let uri = vscode.Uri.joinPath(kbRoot, name);
	let n = 2;
	while (await uriExists(uri)) {
		const stem = name.replace(/\.d\.txt$/i, '');
		name = `${stem}-${n}.d.txt`;
		uri = vscode.Uri.joinPath(kbRoot, name);
		n += 1;
	}
	const entity = await allocateNextEntityNumber(kbRoot, uri);
	const text = buildNewNoteFile(
		{ title: safeTitle, content: noteText, metadataFilename: safeTitle },
		{ fileEntityNumber: entity }
	);
	await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
	await indexNewNoteImmediately(kbRoot, uri, context);
	return uri;
}

/**
 * @param {Array<{ title: string }>} candidates
 * @param {string} suggestedTitle
 * @returns {Promise<{ kind: 'existing', index: number } | { kind: 'new', title: string } | null>}
 */
async function promptWhereToCreate(candidates, suggestedTitle) {
	/** @type {Array<import('vscode').QuickPickItem & { _kind?: string, _index?: number, _title?: string }>} */
	const items = [];
	for (let i = 0; i < candidates.length; i++) {
		items.push({
			label: `$(arrow-down) Add to: ${candidates[i].title}`,
			_kind: 'existing',
			_index: i
		});
	}
	items.push({
		label: `$(new-file) Create new note${suggestedTitle ? `: ${suggestedTitle}` : ''}`,
		_kind: 'new',
		_title: suggestedTitle || ''
	});
	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: 'No close match. Where should this note go?'
	});
	if (!pick) return null;
	if (pick._kind === 'existing') return { kind: 'existing', index: Number(pick._index) || 0 };
	return { kind: 'new', title: String(pick._title || '').trim() };
}

/**
 * Local embedding search → top headings with their body text (no LLM tokens spent here).
 * @param {import('vscode').Uri} kbRoot
 * @param {string} note
 * @returns {Promise<Array<{ title: string, body: string, uri: import('vscode').Uri, relPath: string, fileId: string|number, headingId: string|number }>>}
 */
async function findCandidates(kbRoot, note) {
	const candidates = [];
	try {
		const { hits } = await searchHeadingsByEmbedding(kbRoot, note, { limit: TOP_N });
		for (const h of hits || []) {
			if (!h.heading_id || !h.fileId || !h.relPath) continue;
			const uri = vscode.Uri.joinPath(kbRoot, ...String(h.relPath).split('/').filter(Boolean));
			let text;
			try {
				text = await readNoteText(uri);
			} catch {
				continue;
			}
			const block = readHeadingBlock(text, h.fileId, h.heading_id);
			if (!block) continue;
			candidates.push({
				title: block.title || String(h.title || 'Untitled'),
				body: block.body,
				uri,
				relPath: h.relPath,
				fileId: h.fileId,
				headingId: h.heading_id
			});
		}
	} catch (err) {
		console.warn('[DRIP] quick capture search failed', err && err.message);
	}
	return candidates;
}

/**
 * @param {{
 *   kbRoot: import('vscode').Uri,
 *   noteText: string,
 *   context: import('vscode').ExtensionContext,
 *   shortTerm?: string,
 *   lastExchange?: { user: string, assistant: string } | null,
 *   onStatus?: (msg: string) => void
 * }} opts
 * @returns {Promise<{ ok: boolean, message: string, action?: string, file?: string, shortTerm?: string }>}
 */
async function runQuickCapture(opts) {
	const { kbRoot, noteText, context, onStatus } = opts;
	const note = String(noteText || '').trim();
	if (!note) return { ok: false, message: 'Note is empty.' };

	const cfg = getLlmConfig(context);
	if (!cfg.enabled) {
		return { ok: false, message: 'Quick Capture LLM is off. Turn it on in DRIP Settings → LLM.' };
	}
	const apiKey = await getLlmApiKey(context);

	let candidates = [];
	if (!MEMORY_REQUEST_RE.test(note)) {
		onStatus && onStatus('Searching for related headings…');
		candidates = await findCandidates(kbRoot, note);
	}

	const longTermItems = await readChatMemoryItems(kbRoot);
	onStatus && onStatus('Asking the LLM…');
	const raw = await completeJson({
		baseUrl: cfg.baseUrl,
		model: cfg.model,
		apiKey,
		temperature: 0,
		maxTokens: REPLY_TOKEN_FLOOR,
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{
				role: 'user',
				content: buildUserPrompt(note, candidates, {
					longTerm: longTermItems.length ? formatMemoryForPrompt(longTermItems) : '',
					shortTerm: String(opts.shortTerm || '').trim(),
					lastExchange: opts.lastExchange || null
				})
			}
		]
	});
	const decision = parseDecision(raw);

	/** @type {string[]} */
	const memoryLines = [];
	if (decision.ltAdd.length || decision.ltRemove.length) {
		const { added, removed } = await applyChatMemoryOps(kbRoot, { add: decision.ltAdd, remove: decision.ltRemove });
		for (const a of added) memoryLines.push(`+ long-term: ${a}`);
		for (const r of removed) memoryLines.push(`− long-term: ${r}`);
	}
	if (decision.st !== undefined) memoryLines.push('Short-term memory updated.');
	/** @param {{ ok: boolean, message: string, action?: string, file?: string }} r */
	const finish = r => ({
		...r,
		message: [r.message, ...memoryLines].filter(Boolean).join('\n'),
		shortTerm: decision.st
	});

	if (decision.action === 'none') {
		return finish({ ok: true, action: 'none', message: decision.reply || (memoryLines.length ? '' : 'Nothing to file.') });
	}

	const noteToFile = stripRequests(note, decision.remove) || note;

	if (decision.action === 'append' || decision.action === 'merge') {
		const target = candidates[decision.target];
		if (!target) return finish({ ok: false, message: 'LLM picked an invalid heading.' });
		const text = await readNoteText(target.uri);
		const block = readHeadingBlock(text, target.fileId, target.headingId);
		if (!block) return finish({ ok: false, message: 'Could not find the heading in its file (reindex may help).' });

		let action = decision.action;
		let fallbackNote = '';
		let next = null;
		if (action === 'merge' && block.body.length + noteToFile.length > MERGE_MAX_CHARS) {
			action = 'append';
			fallbackNote = 'The section is too long to merge in one LLM reply, so the note was appended instead.';
		} else if (action === 'merge' && block.body) {
			onStatus && onStatus(`Merging into “${target.title}”…`);
			let mergedBody = '';
			try {
				mergedBody = await mergeWithLlm(cfg, apiKey, target.title, block.body, noteToFile);
			} catch (err) {
				if (!(/** @type {any} */ (err).cutOff)) throw err;
			}
			if (!mergedBody) {
				action = 'append';
				fallbackNote = 'The LLM could not finish the merge, so the note was appended instead.';
			} else if (mergedBody.length < block.body.length * MERGE_MIN_KEEP_RATIO) {
				action = 'append';
				fallbackNote = 'The merge would have removed existing text, so the note was appended instead.';
			} else {
				next = mergeHeadingBody(text, target.fileId, target.headingId, mergedBody);
			}
		} else if (action === 'merge') {
			action = 'append';
		}
		if (action === 'append') next = appendToHeading(text, target.fileId, target.headingId, noteToFile);
		if (next == null) {
			return finish({ ok: false, message: 'Could not find the heading in its file (reindex may help).' });
		}
		await writeNoteText(target.uri, next);
		await reindexNote(kbRoot, target.uri, context);
		return finish({
			ok: true,
			action,
			message: [`${action === 'append' ? 'Appended to' : 'Merged into'} “${target.title}”`, fallbackNote]
				.filter(Boolean)
				.join('\n'),
			file: target.relPath
		});
	}

	// "new" — ask the user before creating anything.
	const choice = await promptWhereToCreate(candidates, decision.suggestedTitle);
	if (!choice) return finish({ ok: false, message: 'Cancelled.' });
	if (choice.kind === 'existing') {
		const target = candidates[choice.index];
		if (!target) return finish({ ok: false, message: 'Invalid selection.' });
		const text = await readNoteText(target.uri);
		const next = appendToHeading(text, target.fileId, target.headingId, noteToFile);
		if (next == null) return finish({ ok: false, message: 'Could not find the heading in its file.' });
		await writeNoteText(target.uri, next);
		await reindexNote(kbRoot, target.uri, context);
		return finish({ ok: true, action: 'append', message: `Appended to “${target.title}”`, file: target.relPath });
	}
	const uri = await createNewNote(kbRoot, choice.title, noteToFile, context);
	return finish({ ok: true, action: 'new', message: `Created note “${choice.title || 'Untitled'}”`, file: uri.fsPath });
}

/**
 * Second LLM call for "merge": full text of the one chosen section + the note.
 * @param {{ baseUrl: string, model: string }} cfg
 * @param {string} apiKey
 * @param {string} title
 * @param {string} body full own-prose of the section
 * @param {string} note
 * @returns {Promise<string>} merged section body
 */
async function mergeWithLlm(cfg, apiKey, title, body, note) {
	const obj = await completeJson({
		baseUrl: cfg.baseUrl,
		model: cfg.model,
		apiKey,
		temperature: 0,
		maxTokens: replyTokenBudget(body.length + note.length, RETRY_TOKEN_CAP),
		messages: [
			{ role: 'system', content: MERGE_SYSTEM_PROMPT },
			{ role: 'user', content: `Section: ${title}\n\n${body}\n\nNote:\n${note}` }
		]
	});
	return String(obj.body || '').trim();
}

module.exports = { runQuickCapture };
