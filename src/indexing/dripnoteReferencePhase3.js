'use strict';

/**
 * Phase 3 — Knowledge-base `L.` link updates after a file id change, and cleanup of index "pending" rows.
 */

const vscode = require('vscode');
const { readTextFile } = require('../indexing/kbFilesystem');
const {
	listIndexOwnerFolders,
	mergePendingMigrationLists,
	extractPendingMigrationsFromIndexText,
	extractIndexBodyAfterDripMarker,
	pickIndexExtension,
	syncNearestIndexForNote,
	removePendingMigrationFromAllIndices,
	INDEX_FILE_STEM
} = require('./dripnoteIndex');
const { updateRefsOnFileIdChange, kbHasLLineContainingFileId } = require('../graph/dripnoteReferenceSync');

/**
 * True if any `_index` body (below `# DRIP Index`) still mentions the id (stale entry or link list).
 * @param {import('vscode').Uri} kbRoot
 * @param {string} fileIdSubstring
 */
async function indexBodiesMentionFileId(kbRoot, fileIdSubstring) {
	if (!fileIdSubstring) {
		return false;
	}
	const folders = await listIndexOwnerFolders(kbRoot);
	const ext = pickIndexExtension();
	for (const folder of folders) {
		const indexUri = vscode.Uri.joinPath(folder, `${INDEX_FILE_STEM}${ext}`);
		let text;
		try {
			text = await readTextFile(indexUri);
		} catch {
			continue;
		}
		const body = extractIndexBodyAfterDripMarker(text);
		if (body && body.includes(fileIdSubstring)) {
			return true;
		}
	}
	return false;
}

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {string} relPosix path relative to KB root using `/`
 */
function noteUriFromKbRelPosix(kbRoot, relPosix) {
	const norm = String(relPosix || '')
		.replace(/\\/g, '/')
		.replace(/^\/+/, '');
	const parts = norm.split('/').filter(Boolean);
	let u = kbRoot;
	for (const p of parts) {
		u = vscode.Uri.joinPath(u, p);
	}
	return u;
}

/**
 * Rewrite every `L.` line in the KB that still mentions `oldId`, then drop the pending row from all `_index`
 * preambles when no `L.` line references `oldId` anymore.
 *
 * @param {import('vscode').Uri} kbRoot
 * @param {import('vscode').ExtensionContext} context
 * @param {{ oldId: string, newId: string, relPath: string }} migration
 * @param {import('vscode').Uri} targetNoteUri note whose identity changed (for markdown image alt + href)
 * @returns {Promise<import('vscode').Uri[]>} uris that were written
 */
async function applyFileIdLinkMigrationKb(kbRoot, context, migration, targetNoteUri) {
	const oldId = String(migration.oldId || '').trim();
	const newId = String(migration.newId || '').trim();
	if (!oldId || !newId || oldId === newId) {
		return [];
	}

	const changed = await updateRefsOnFileIdChange(kbRoot, oldId, newId, targetNoteUri);

	for (const u of changed) {
		try {
			await syncNearestIndexForNote(context, kbRoot, u);
		} catch (err) {
			console.error('[DRIP] Phase3 sync after L. rewrite', u.fsPath, err);
		}
	}
	try {
		await syncNearestIndexForNote(context, kbRoot, targetNoteUri);
	} catch (err) {
		console.error('[DRIP] Phase3 sync target note', err);
	}

	try {
		const stillInNotes = await kbHasLLineContainingFileId(kbRoot, oldId);
		const stillInIndex = await indexBodiesMentionFileId(kbRoot, oldId);
		if (!stillInNotes && !stillInIndex) {
			await removePendingMigrationFromAllIndices(kbRoot, migration, context);
		}
	} catch (err) {
		console.error('[DRIP] Phase3 pending cleanup', err);
	}

	return changed;
}

/**
 * Union of all `## Pending id migrations` rows across `_index` files (deduped).
 * @param {import('vscode').Uri} kbRoot
 */
async function collectAllPendingMigrations(kbRoot) {
	const folders = await listIndexOwnerFolders(kbRoot);
	const ext = pickIndexExtension();
	/** @type {{ oldId: string, newId: string, relPath: string }[]} */
	let merged = [];
	for (const folder of folders) {
		const indexUri = vscode.Uri.joinPath(folder, `${INDEX_FILE_STEM}${ext}`);
		let text;
		try {
			text = await readTextFile(indexUri);
		} catch {
			continue;
		}
		merged = mergePendingMigrationLists(merged, extractPendingMigrationsFromIndexText(text));
	}
	return merged;
}

/**
 * Process every pending migration listed in `_index` files: rewrite in-KB `L.` references where possible.
 * Migrations whose target note path no longer exists in the KB are skipped (pending rows are kept).
 *
 * @param {import('vscode').Uri} kbRoot
 * @param {import('vscode').ExtensionContext} context
 */
async function processAllPendingLinkMigrations(kbRoot, context) {
	const pending = await collectAllPendingMigrations(kbRoot);
	let applied = 0;
	let skipped = 0;
	for (const mig of pending) {
		const targetUri = noteUriFromKbRelPosix(kbRoot, mig.relPath);
		try {
			await vscode.workspace.fs.stat(targetUri);
		} catch {
			skipped += 1;
			continue;
		}
		try {
			await applyFileIdLinkMigrationKb(kbRoot, context, mig, targetUri);
			applied += 1;
		} catch (err) {
			console.error('[DRIP] processAllPendingLinkMigrations', mig, err);
			skipped += 1;
		}
		await new Promise(r => setImmediate(r));
	}
	return { total: pending.length, applied, skipped };
}

module.exports = {
	noteUriFromKbRelPosix,
	applyFileIdLinkMigrationKb,
	collectAllPendingMigrations,
	processAllPendingLinkMigrations
};
