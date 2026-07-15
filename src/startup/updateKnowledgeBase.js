'use strict';

const vscode = require('vscode');
const { ensureDripIndexSkeleton } = require('./initializeDripIndex');
const { normalizeAllNoteIdentities } = require('../indexing/dripnoteFileIdentity');
const {
	dripIndexNeedsRebuild,
	rebuildDripIndex,
	initEmptyDripIndexFile
} = require('../indexing/dripIndexDb');
const { reconcileAllKbNoteHeadingIdentities } = require('../indexing/dripnoteHeadingIdentityReconcile');

/**
 * User-triggered KB update (update icon) and post-bind initial index build.
 *
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').Uri} kbRootUri
 * @param {{ force?: boolean, quiet?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, updated: boolean }>}
 */
async function updateKnowledgeBase(context, kbRootUri, options) {
	const force = !!(options && options.force);
	const quiet = !!(options && options.quiet);

	await ensureDripIndexSkeleton(kbRootUri);
	await initEmptyDripIndexFile(kbRootUri);

	const needsUpdate = force || (await dripIndexNeedsRebuild(kbRootUri));
	if (!needsUpdate) {
		if (!quiet) {
			void vscode.window.showInformationMessage('DRIP knowledge base index is up to date.');
		}
		return { ok: true, updated: false };
	}

	await normalizeAllNoteIdentities(kbRootUri, context);
	await reconcileAllKbNoteHeadingIdentities(kbRootUri, context);
	await rebuildDripIndex(kbRootUri, context);

	if (!quiet) {
		void vscode.window.showInformationMessage('DRIP knowledge base index updated.');
	}
	return { ok: true, updated: true };
}

module.exports = {
	updateKnowledgeBase
};
