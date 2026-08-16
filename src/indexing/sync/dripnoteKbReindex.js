'use strict';

/**
 * KB-wide reindex using unwind `reconcileUpdate`.
 * Option 1: wipe `index.drip` then reconcile every note in the driplock folder (including dripignored).
 * Option 2: keep `index.drip` and reconcile only the current workspace notes (respects `.dripignore`).
 */

const vscode = require('vscode');
const { forEachKnowledgeBaseNotePath } = require('../kbFilesystem');
const { resetDripIndexDatabase } = require('../dripIndexDb');
const { clearHeadingAllocCache } = require('../dripnoteHeadingIdentity');
const { reconcileUpdate } = require('./dripnoteReconcileUpdate');

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {{ respectDripignore: boolean }} options
 * @returns {Promise<{ uri: import('vscode').Uri, relativePath: string }[]>}
 */
async function listNotesForReindex(kbRootUri, options) {
	/** @type {{ uri: import('vscode').Uri, relativePath: string }[]} */
	const notes = [];
	await forEachKnowledgeBaseNotePath(
		kbRootUri,
		async note => {
			notes.push(note);
		},
		{ yieldEvery: 40, respectDripignore: options.respectDripignore !== false }
	);
	notes.sort((a, b) => String(a.relativePath || '').localeCompare(String(b.relativePath || '')));
	return notes;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').ExtensionContext | null | undefined} context
 * @param {{
 *   resetDatabase: boolean,
 *   respectDripignore: boolean,
 *   title: string,
 *   token?: import('vscode').CancellationToken
 * }} options
 */
async function runKbReconcileReindex(kbRootUri, context, options) {
	if (options.resetDatabase) {
		clearHeadingAllocCache();
		await resetDripIndexDatabase(kbRootUri);
	}

	const notes = await listNotesForReindex(kbRootUri, {
		respectDripignore: options.respectDripignore
	});

	let updated = 0;
	let unchanged = 0;
	let failed = 0;
	/** @type {{ path: string, message: string }[]} */
	const errors = [];

	for (let i = 0; i < notes.length; i++) {
		if (options.token && options.token.isCancellationRequested) {
			break;
		}
		const note = notes[i];
		try {
			const result = await reconcileUpdate(kbRootUri, note.uri, {
				context,
				applyToEditor: true,
				writeToDisk: true,
				persistIndex: true
			});
			if (result.changed) {
				updated += 1;
			} else {
				unchanged += 1;
			}
		} catch (err) {
			failed += 1;
			errors.push({
				path: note.relativePath,
				message: err && err.message ? String(err.message) : String(err)
			});
			console.error('[DRIP] reconcile-update reindex failed', note.relativePath, err);
		}
	}

	return {
		total: notes.length,
		updated,
		unchanged,
		failed,
		cancelled: !!(options.token && options.token.isCancellationRequested),
		errors
	};
}

/**
 * Option 2 — keep sqlite; reconcile notes shown in the working KB (`.dripignore` applied).
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').ExtensionContext | null | undefined} context
 * @param {import('vscode').CancellationToken} [token]
 */
async function reindexCurrentKbWorkspace(kbRootUri, context, token) {
	return runKbReconcileReindex(kbRootUri, context, {
		resetDatabase: false,
		respectDripignore: true,
		title: 'Update/reindex the current KB working space',
		token
	});
}

/**
 * Option 1 — delete `index.drip`, recreate schema, reconcile every note in the driplock folder.
 * Colliding `@fN` values get new ids because the DB is empty and files are processed in path order.
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').ExtensionContext | null | undefined} context
 * @param {import('vscode').CancellationToken} [token]
 */
async function resetReindexEntireDriplockFolder(kbRootUri, context, token) {
	return runKbReconcileReindex(kbRootUri, context, {
		resetDatabase: true,
		respectDripignore: false,
		title: 'Reset/reindex the entire KB driplock folder',
		token
	});
}

/**
 * @param {string} title
 * @param {(token: import('vscode').CancellationToken, progress: import('vscode').Progress<{ message?: string, increment?: number }>) => Promise<{ total: number, updated: number, unchanged: number, failed: number, cancelled: boolean, errors: { path: string, message: string }[] }>} runner
 */
async function runReindexWithProgress(title, runner) {
	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title,
			cancellable: true
		},
		async (progress, token) => {
			progress.report({ message: 'Starting…' });
			const result = await runner(token, progress);
			return result;
		}
	);
}

/**
 * @param {{ total: number, updated: number, unchanged: number, failed: number, cancelled?: boolean, errors?: { path: string, message: string }[] }} result
 * @param {string} label
 */
function showReindexResult(result, label) {
	const cancelled = result.cancelled ? ' (cancelled)' : '';
	const summary = `${label}: ${result.updated} note(s) rewritten, ${result.unchanged} unchanged, ${result.failed} failed, ${result.total} in scope${cancelled}.`;
	const errors = result.errors || [];
	if (result.failed > 0) {
		const extra = errors
			.slice(0, 6)
			.map(e => `${e.path}: ${e.message}`)
			.join(' | ');
		void vscode.window.showWarningMessage(extra ? `${summary} ${extra}` : summary);
		return;
	}
	void vscode.window.showInformationMessage(summary);
}

/**
 * @param {'workspace' | 'reset'} kind
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').ExtensionContext | null | undefined} context
 */
async function promptAndRunKbReindex(kind, kbRootUri, context) {
	if (kind === 'reset') {
		const pick = await vscode.window.showWarningMessage(
			'Reset/reindex the entire KB driplock folder? This deletes index.drip and rewrites note file/heading ids where needed, including files hidden by .dripignore.',
			{ modal: true },
			'Reset and reindex',
			'Cancel'
		);
		if (pick !== 'Reset and reindex') {
			return;
		}
		const result = await runReindexWithProgress(
			'Reset/reindex the entire KB driplock folder',
			token => resetReindexEntireDriplockFolder(kbRootUri, context, token)
		);
		showReindexResult(result, 'Reset/reindex');
		return;
	}

	const pick = await vscode.window.showInformationMessage(
		'Update/reindex the current KB working space? This keeps index.drip and reconcile-updates notes that are not ignored by .dripignore.',
		{ modal: true },
		'Update working space',
		'Cancel'
	);
	if (pick !== 'Update working space') {
		return;
	}
	const result = await runReindexWithProgress(
		'Update/reindex the current KB working space',
		token => reindexCurrentKbWorkspace(kbRootUri, context, token)
	);
	showReindexResult(result, 'Update/reindex');
}

module.exports = {
	reindexCurrentKbWorkspace,
	resetReindexEntireDriplockFolder,
	promptAndRunKbReindex,
	runReindexWithProgress,
	showReindexResult
};
