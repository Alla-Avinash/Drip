'use strict';

const { loadSettingsFromDripIndex } = require('./settingsDrip');
const { invalidateKbNoteExtensionsCache } = require('../document/model/noteFileTypes');
const { loadDraftsFromDripIndex, migrateGlobalDraftsToDripIndex } = require('./draftsDrip');
const tagGraphStore = require('../graph/tagGraphStore');

/**
 * Load KB-scoped sidecar data from `.dripindex/` (settings, drafts, tag graphs).
 *
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').Uri} kbRootUri
 * @param {{ refreshDrafts?: () => Promise<void> }} [hooks]
 */
async function loadKbSidecar(context, kbRootUri, hooks) {
	await loadSettingsFromDripIndex(kbRootUri);
	invalidateKbNoteExtensionsCache();
	await migrateGlobalDraftsToDripIndex(context, kbRootUri);
	if (hooks && typeof hooks.refreshDrafts === 'function') {
		await hooks.refreshDrafts();
	} else {
		await loadDraftsFromDripIndex(kbRootUri);
	}
	await tagGraphStore.reloadTagGraphsForKnowledgeBase(context, kbRootUri);
}

module.exports = {
	loadKbSidecar
};
