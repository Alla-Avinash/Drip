'use strict';

const { updateRefsOnFileIdChange } = require('../../graph/dripTxtReferenceSync.js');
const {
	createOrUpdateIndexForFolder,
	findNearestIndexFolder,
	findParentIndexFolder,
	countLRefMentionsInKb
} = require('./dripTxtIndex.js');

/**
 * After a note's file id changes: rewrite other notes that reference the old id,
 * record any remaining pending L. mentions in the nearest `_index` so a later pass
 * can finish the migration, then refresh the affected index notes.
 *
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').Uri} kbRoot
 * @param {import('vscode').Uri} targetUri
 * @param {{ oldId: string, newId: string, relPath?: string }} migration
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

module.exports = {
	propagateFileIdDrift
};
