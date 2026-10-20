'use strict';

const vscode = require('vscode');
const { updateNoteInDripIndex } = require('./dripTxtIndexUpdate.js');
const { accumulateContentChangeRanges } = require('../../parse/dripIndexIncrementalParse');

/** Trailing debounce before `index.drip` writes during active editing (ms). */
const INDEX_UPDATE_BUFFER_MS = 6_000;

/**
 * In-memory buffer for index updates — coalesces rapid edits into one DB write per note.
 *
 * Flow: `scheduleNoteUpdate` → wait {@link INDEX_UPDATE_BUFFER_MS} with no new edits →
 * parse + hash signature compare → write only when signature changed.
 *
 * Immediate flush: `flushNoteUpdate`, `flushAllPending`, or `scheduleNoteUpdate(..., { immediate: true })`.
 *
 * @param {{
 *   debounceMs?: number,
 *   context: import('vscode').ExtensionContext,
 *   getKnowledgeBaseRoot: () => import('vscode').Uri | undefined
 * }} options
 */
function createDripnoteIndexUpdateQueue(options) {
	const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : INDEX_UPDATE_BUFFER_MS;
	const context = options.context;
	const getKnowledgeBaseRoot = options.getKnowledgeBaseRoot;

	/** @type {Map<string, { noteUri: import('vscode').Uri, force?: boolean, changeRanges?: { start: number, end: number }[] }>} */
	const pending = new Map();
	/** @type {Map<string, ReturnType<typeof setTimeout>>} */
	const timers = new Map();
	/** @type {Map<string, string>} */
	const lastPersistedSignature = new Map();
	/** @type {Map<string, object>} */
	const lastParsedByDoc = new Map();
	let disposed = false;

	/**
	 * @param {import('vscode').Uri} noteUri
	 * @returns {string}
	 */
	function uriKey(noteUri) {
		return noteUri.toString();
	}

	/**
	 * @param {import('vscode').Uri} noteUri
	 * @returns {string | undefined}
	 */
	function readNoteTextForIndex(noteUri) {
		const key = uriKey(noteUri);
		const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
		if (open && !open.isClosed) {
			return open.getText().replace(/\r\n/g, '\n');
		}
		return undefined;
	}

	/**
	 * @param {import('vscode').Uri} noteUri
	 */
	function clearTimer(noteUri) {
		const key = uriKey(noteUri);
		const timer = timers.get(key);
		if (timer) {
			clearTimeout(timer);
			timers.delete(key);
		}
	}

	/**
	 * @param {import('vscode').Uri} noteUri
	 * @param {{ force?: boolean }} [opts]
	 * @returns {Promise<{ updated: boolean, signature: string }>}
	 */
	async function flushNoteUpdate(noteUri, opts) {
		const key = uriKey(noteUri);
		const pendingEntry = pending.get(key);
		const force = !!(opts && opts.force) || !!(pendingEntry && pendingEntry.force);
		const changeRanges =
			pendingEntry && pendingEntry.changeRanges ? pendingEntry.changeRanges : undefined;
		clearTimer(noteUri);
		pending.delete(key);

		const kbRoot = getKnowledgeBaseRoot();
		if (!kbRoot) {
			return { updated: false, signature: '' };
		}

		const text = readNoteTextForIndex(noteUri);
		const prev = lastPersistedSignature.get(key);
		const previousParse = force ? null : lastParsedByDoc.get(key) || null;
		try {
			const result = await updateNoteInDripIndex(kbRoot, noteUri, context, {
				text,
				skipIfSignatureMatches: force ? undefined : prev,
				force,
				changeRanges: force ? undefined : changeRanges,
				previousParse
			});
			if (result.signature) {
				lastPersistedSignature.set(key, result.signature);
			}
			if (result.parsed) {
				const { _parseMode, ...cached } = result.parsed;
				lastParsedByDoc.set(key, cached);
			}
			return { updated: result.updated, signature: result.signature };
		} catch (err) {
			console.error('[DRIP] buffered index flush failed', key, err);
			return { updated: false, signature: prev || '' };
		}
	}

	/**
	 * @param {import('vscode').Uri} noteUri
	 * @param {{ immediate?: boolean, force?: boolean, contentChanges?: import('vscode').TextDocumentContentChangeEvent[] }} [opts]
	 */
	function scheduleNoteUpdate(noteUri, opts) {
		if (disposed) {
			return;
		}
		const key = uriKey(noteUri);
		const force = !!(opts && opts.force);
		const immediate = !!(opts && opts.immediate);
		const existing = pending.get(key);
		const changeRanges = accumulateContentChangeRanges(
			existing && existing.changeRanges ? existing.changeRanges : undefined,
			opts && opts.contentChanges ? opts.contentChanges : []
		);

		if (immediate || force) {
			clearTimer(noteUri);
			pending.delete(key);
			void flushNoteUpdate(noteUri, { force: true }).catch(err => {
				console.error('[DRIP] immediate index update failed', err);
			});
			return;
		}

		pending.set(key, { noteUri, force: false, changeRanges });
		clearTimer(noteUri);
		timers.set(
			key,
			setTimeout(() => {
				timers.delete(key);
				if (!pending.has(key)) {
					return;
				}
				void flushNoteUpdate(noteUri).catch(err => {
					console.error('[DRIP] debounced index update failed', err);
				});
			}, debounceMs)
		);
	}

	/**
	 * @returns {Promise<void>}
	 */
	async function flushAllPending() {
		const uris = [...pending.values()].map(entry => entry.noteUri);
		for (const noteUri of uris) {
			await flushNoteUpdate(noteUri);
		}
	}

	/**
	 * @param {import('vscode').Uri} noteUri
	 */
	function cancelNoteUpdate(noteUri) {
		const key = uriKey(noteUri);
		clearTimer(noteUri);
		pending.delete(key);
		lastPersistedSignature.delete(key);
		lastParsedByDoc.delete(key);
	}

	/**
	 * @param {import('vscode').Uri} noteUri
	 * @param {string} signature
	 */
	function seedPersistedSignature(noteUri, signature) {
		if (signature) {
			lastPersistedSignature.set(uriKey(noteUri), signature);
		}
	}

	function dispose() {
		disposed = true;
		for (const timer of timers.values()) {
			clearTimeout(timer);
		}
		timers.clear();
		pending.clear();
		lastParsedByDoc.clear();
	}

	return {
		INDEX_UPDATE_BUFFER_MS: debounceMs,
		scheduleNoteUpdate,
		flushNoteUpdate,
		flushAllPending,
		cancelNoteUpdate,
		seedPersistedSignature,
		getPersistedSignature: noteUri => lastPersistedSignature.get(uriKey(noteUri)),
		dispose
	};
}

module.exports = {
	INDEX_UPDATE_BUFFER_MS,
	createDripnoteIndexUpdateQueue
};
