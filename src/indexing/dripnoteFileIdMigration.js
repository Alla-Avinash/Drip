'use strict';

const path = require('path');
const vscode = require('vscode');
const { enumerateKbNoteUris } = require('./kbFilesystem');
const { updateRefsOnFileIdChange } = require('../graph/dripnoteReferenceSync');
const {
	createOrUpdateIndexForFolder,
	findNearestIndexFolder,
	findParentIndexFolder,
	countLRefMentionsInKb,
	collectFoldersWithIndex,
	ensureRootIndexIfMissing
} = require('./dripnoteIndex');

/**
 * After drift correction: rewrite other notes, record pending in nearest _index until no in-KB L. mentions of old id remain.
 */
async function propagateFileIdDrift(context, kbRoot, targetUri, migration) {
	const { oldId, newId, relPath } = migration;
	if (!oldId || !newId || oldId === newId || !kbRoot) {
		return;
	}

	await updateRefsOnFileIdChange(kbRoot, oldId, newId);

	const remaining = await countLRefMentionsInKb(kbRoot, oldId);
	const folder = await findNearestIndexFolder(kbRoot, targetUri);
	const pendingAddon = remaining > 0 && relPath ? [{ relPath, oldId, newId }] : [];

	await createOrUpdateIndexForFolder(kbRoot, folder, {
		context,
		pendingFileIdAddons: pendingAddon
	});
	const parentFolder = await findParentIndexFolder(kbRoot, folder);
	if (parentFolder) {
		await createOrUpdateIndexForFolder(kbRoot, parentFolder, { context });
	}
	await createOrUpdateIndexForFolder(kbRoot, kbRoot, { context });
}

/**
 * Try to clear pending rows whose old id no longer appears on any L. line in the KB.
 */
async function pruneResolvedPendingMigrations(kbRoot, context) {
	const uris = await enumerateKbNoteUris(kbRoot);
	for (const uri of uris) {
		const base = path.basename(uri.fsPath).toLowerCase();
		if (!base.startsWith('_index.')) {
			continue;
		}
		const folder = vscode.Uri.file(path.dirname(uri.fsPath));
		await createOrUpdateIndexForFolder(kbRoot, folder, { context, prunePendingFileIds: true });
	}
}

/**
 * Scan all notes: normalize identity (recompute fileid if needed) and propagate drift.
 * Yields to the event loop every batch to reduce extension-host spikes (OOM / UI freeze).
 */
async function reconcileAllNoteFileIdsInKb(kbRoot, context, progress) {
	const { normalizeNoteIdentityFile } = require('./dripnoteFileIdentity');
	const uris = await enumerateKbNoteUris(kbRoot);
	const BATCH = 14;
	let done = 0;
	const total = uris.length;
	for (const uri of uris) {
		const base = path.basename(uri.fsPath).toLowerCase();
		if (base === '_index.d.txt' || base.startsWith('_index.')) {
			continue;
		}
		await normalizeNoteIdentityFile(uri, { context, kbRoot });
		done += 1;
		if (progress && done % 25 === 0) {
			progress.report({ message: `Notes ${done} / ~${total}` });
		}
		if (done % BATCH === 0) {
			await new Promise(r => setImmediate(r));
		}
	}
}

/**
 * Startup / manual reconcile: refresh every _index, prune stale pending rows, normalize all identities and references.
 */
async function reconcileKbIndicesAndFileIds(kbRoot, context, progress) {
	const report = msg => {
		if (progress) {
			progress.report({ message: msg });
		}
	};

	await ensureRootIndexIfMissing(kbRoot);
	report('Rebuilding index files…');
	let folders = await collectFoldersWithIndex(kbRoot);
	const seen = new Set(folders.map(f => f.fsPath));
	if (!seen.has(kbRoot.fsPath)) {
		folders = [kbRoot, ...folders];
	}
	for (const folder of folders) {
		await createOrUpdateIndexForFolder(kbRoot, folder, { context });
	}
	report('Pruning resolved pending migrations…');
	await pruneResolvedPendingMigrations(kbRoot, context);
	report('Normalizing file identities…');
	await reconcileAllNoteFileIdsInKb(kbRoot, context, progress);
	folders = await collectFoldersWithIndex(kbRoot);
	const seen2 = new Set(folders.map(f => f.fsPath));
	if (!seen2.has(kbRoot.fsPath)) {
		folders = [kbRoot, ...folders];
	}
	report('Refreshing indexes after ID sync…');
	for (const folder of folders) {
		await createOrUpdateIndexForFolder(kbRoot, folder, { context });
	}
}

/**
 * Deferred startup job so activation stays fast; skips work if no KB root is configured yet.
 */
function scheduleKbStartupReconcile(context, getKbRoot) {
	const delayMs = 2800;
	const timer = setTimeout(() => {
		void (async () => {
			const kbRoot = typeof getKbRoot === 'function' ? getKbRoot() : getKbRoot;
			if (!kbRoot) {
				return;
			}
			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'DRIP: syncing indexes and file IDs…',
						cancellable: false
					},
					async progress => {
						await reconcileKbIndicesAndFileIds(kbRoot, context, progress);
					}
				);
				void vscode.window.showInformationMessage('DRIP knowledge base indexes are in sync.');
			} catch (err) {
				console.error('[DRIP] startup reconcile', err);
				void vscode.window.showWarningMessage(
					`DRIP index sync failed: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		})();
	}, delayMs);

	context.subscriptions.push({
		dispose: () => clearTimeout(timer)
	});
}

module.exports = {
	propagateFileIdDrift,
	pruneResolvedPendingMigrations,
	reconcileAllNoteFileIdsInKb,
	reconcileKbIndicesAndFileIds,
	scheduleKbStartupReconcile
};
