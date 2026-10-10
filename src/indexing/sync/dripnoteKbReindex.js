'use strict';

/**
 * KB-wide reindex using unwind `reconcileUpdate`.
 * Option 1: wipe `index.drip` then reconcile every note in the driplock folder (including dripignored).
 * Option 2: keep `index.drip` and reconcile only the current workspace notes (respects `.dripignore`).
 *
 * Reset (option 1) keeps the progress spinner up until heading + folder embeddings are fully encoded.
 */

const vscode = require('vscode');
const { forEachKnowledgeBaseNotePath } = require('../kbFilesystem');
const { resetDripIndexDatabase } = require('../dripIndexDb');
const { resetDripProjectsDatabase } = require('../dripProjectDb');
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
 *   token?: import('vscode').CancellationToken,
 *   progress?: import('vscode').Progress<{ message?: string, increment?: number }>,
 *   onReconcileDone?: (stats: { total: number, updated: number, unchanged: number, failed: number, cancelled: boolean, errors: { path: string, message: string }[] }) => void
 * }} options
 */
async function runKbReconcileReindex(kbRootUri, context, options) {
	const progress = options.progress;
	if (options.resetDatabase) {
		progress?.report({ message: 'Resetting index.drip…' });
		clearHeadingAllocCache();
		await resetDripIndexDatabase(kbRootUri);
		await resetDripProjectsDatabase(kbRootUri);
	}

	progress?.report({ message: 'Listing notes…' });
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
		progress?.report({
			message: `Reconciling notes… ${i + 1}/${notes.length}`
		});
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

	const cancelled = !!(options.token && options.token.isCancellationRequested);

	// Report the file-reconcile result first (before the slower embedding pass), so
	// the user sees how many notes were rewritten/unaffected right away.
	if (typeof options.onReconcileDone === 'function') {
		options.onReconcileDone({
			total: notes.length,
			updated,
			unchanged,
			failed,
			cancelled,
			errors
		});
	}

	// Full reset: block until every heading + folder vector is written, then report
	// the totals actually stored in `index.drip`.
	/** @type {{ headingsEncoded?: number, foldersEncoded?: number }} */
	const embedStats = {};
	if (options.resetDatabase && !cancelled) {
		try {
			const { awaitHeadingEmbeddingsReady } = require('../embeddings/headingEmbeddingSync');
			await awaitHeadingEmbeddingsReady(kbRootUri, {
				progress,
				token: options.token
			});
		} catch (err) {
			console.error('[DRIP] heading embedding await after reset failed', err);
			errors.push({
				path: '(embeddings/headings)',
				message: err && err.message ? String(err.message) : String(err)
			});
			failed += 1;
		}
		if (!(options.token && options.token.isCancellationRequested)) {
			try {
				const { awaitFolderEmbeddingsReady } = require('../embeddings/folderEmbeddingSync');
				await awaitFolderEmbeddingsReady(kbRootUri, {
					progress,
					token: options.token
				});
			} catch (err) {
				console.error('[DRIP] folder embedding await after reset failed', err);
				errors.push({
					path: '(embeddings/folders)',
					message: err && err.message ? String(err.message) : String(err)
				});
				failed += 1;
			}
		}
		try {
			const { openDripIndexDb } = require('../dripIndexDb');
			const { countHeadingEmbeddings } = require('../embeddings/headingEmbeddingStore');
			const { countFolderEmbeddings } = require('../embeddings/folderEmbeddingStore');
			const handle = await openDripIndexDb(kbRootUri);
			try {
				embedStats.headingsEncoded = countHeadingEmbeddings(handle.db);
				embedStats.foldersEncoded = countFolderEmbeddings(handle.db);
			} finally {
				handle.close();
			}
		} catch (err) {
			console.error('[DRIP] embedding count after reset failed', err);
		}
		progress?.report({ message: 'Embeddings complete' });
	}

	return {
		total: notes.length,
		updated,
		unchanged,
		failed,
		cancelled: !!(options.token && options.token.isCancellationRequested),
		errors,
		...embedStats
	};
}

/**
 * Option 2 — keep sqlite; reconcile notes shown in the working KB (`.dripignore` applied).
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').ExtensionContext | null | undefined} context
 * @param {import('vscode').CancellationToken} [token]
 * @param {import('vscode').Progress<{ message?: string, increment?: number }>} [progress]
 */
async function reindexCurrentKbWorkspace(kbRootUri, context, token, progress) {
	return runKbReconcileReindex(kbRootUri, context, {
		resetDatabase: false,
		respectDripignore: true,
		title: 'Update/reindex the current KB working space',
		token,
		progress
	});
}

/**
 * Option 1 — delete `index.drip`, recreate schema, reconcile every note, then encode all embeddings.
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').ExtensionContext | null | undefined} context
 * @param {import('vscode').CancellationToken} [token]
 * @param {import('vscode').Progress<{ message?: string, increment?: number }>} [progress]
 * @param {{ onReconcileDone?: (stats: { total: number, updated: number, unchanged: number, failed: number, cancelled: boolean, errors: { path: string, message: string }[] }) => void }} [opts]
 */
async function resetReindexEntireDriplockFolder(kbRootUri, context, token, progress, opts) {
	return runKbReconcileReindex(kbRootUri, context, {
		resetDatabase: true,
		respectDripignore: false,
		title: 'Reset/reindex the entire KB driplock folder',
		token,
		progress,
		onReconcileDone: opts && opts.onReconcileDone
	});
}

/**
 * @param {string} title
 * @param {(token: import('vscode').CancellationToken, progress: import('vscode').Progress<{ message?: string, increment?: number }>) => Promise<{ total: number, updated: number, unchanged: number, failed: number, cancelled: boolean, errors: { path: string, message: string }[], headingsEncoded?: number, foldersEncoded?: number }>} runner
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
function showReconcileResult(result, label) {
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
 * Report embedding totals stored after a reset (shown after the reconcile message).
 * @param {{ headingsEncoded?: number, foldersEncoded?: number }} result
 */
function showEmbeddingResult(result) {
	if (typeof result.headingsEncoded !== 'number' && typeof result.foldersEncoded !== 'number') {
		return;
	}
	void vscode.window.showInformationMessage(
		`Embeddings stored: ${result.headingsEncoded || 0} heading(s), ${result.foldersEncoded || 0} folder(s).`
	);
}

/**
 * @param {'workspace' | 'reset'} kind
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').ExtensionContext | null | undefined} context
 */
async function promptAndRunKbReindex(kind, kbRootUri, context) {
	if (kind === 'reset') {
		const pick = await vscode.window.showWarningMessage(
			'Reset/reindex the entire KB driplock folder? This deletes index.drip, rewrites note ids, and waits until all heading and folder embeddings are encoded.',
			{ modal: true },
			'Reset and reindex',
			'Cancel'
		);
		if (pick !== 'Reset and reindex') {
			return;
		}
		const result = await runReindexWithProgress(
			'Reset/reindex the entire KB driplock folder',
			(token, progress) =>
				resetReindexEntireDriplockFolder(kbRootUri, context, token, progress, {
					onReconcileDone: stats => showReconcileResult(stats, 'Reset/reindex')
				})
		);
		showEmbeddingResult(result);
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
		(token, progress) => reindexCurrentKbWorkspace(kbRootUri, context, token, progress)
	);
	showReconcileResult(result, 'Update/reindex');
}

module.exports = {
	reindexCurrentKbWorkspace,
	resetReindexEntireDriplockFolder,
	promptAndRunKbReindex,
	runReindexWithProgress,
	showReconcileResult,
	showEmbeddingResult
};
