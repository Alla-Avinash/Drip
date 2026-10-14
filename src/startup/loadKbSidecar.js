'use strict';

const { loadSettingsFromDripIndex } = require('./settingsDrip');
const { invalidateKbNoteExtensionsCache } = require('../document/model/noteFileTypes');
const { loadProjectMetadataSettings } = require('../document/model/dripnoteProjectMetadata');
const { loadDraftsFromDripIndex, migrateGlobalDraftsToDripIndex } = require('./draftsDrip');
const { migrateWorkspaceRecentsToDripIndex, loadRecentsFromDripIndex } = require('./recentsDrip');
const tagGraphStore = require('../graph/tagGraphStore');

/**
 * Load KB-scoped sidecar data from `.dripindex/` (settings, drafts, recents, tag graphs).
 *
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').Uri} kbRootUri
 * @param {{ refreshDrafts?: () => Promise<void>, refreshRecents?: () => Promise<void> }} [hooks]
 */
async function loadKbSidecar(context, kbRootUri, hooks) {
	await loadSettingsFromDripIndex(kbRootUri);
	invalidateKbNoteExtensionsCache();
	await loadProjectMetadataSettings(kbRootUri);
	await migrateGlobalDraftsToDripIndex(context, kbRootUri);
	if (hooks && typeof hooks.refreshDrafts === 'function') {
		await hooks.refreshDrafts();
	} else {
		await loadDraftsFromDripIndex(kbRootUri);
	}
	await migrateWorkspaceRecentsToDripIndex(context, kbRootUri);
	if (hooks && typeof hooks.refreshRecents === 'function') {
		await hooks.refreshRecents();
	} else {
		await loadRecentsFromDripIndex(kbRootUri);
	}
	await tagGraphStore.reloadTagGraphsForKnowledgeBase(context, kbRootUri);
}

module.exports = {
	loadKbSidecar
};
