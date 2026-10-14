'use strict';

const vscode = require('vscode');
const { ensureDripIndexSkeleton } = require('./initializeDripIndex');
const {
	dripIndexNeedsRebuild,
	rebuildDripIndex,
	initEmptyDripIndexFile
} = require('../indexing/dripIndexDb');
const { initEmptyDripProjectsFile } = require('../indexing/dripProjectDb');
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
	await initEmptyDripProjectsFile(kbRootUri);

	const needsUpdate = force || (await dripIndexNeedsRebuild(kbRootUri));
	if (!needsUpdate) {
		const { repairHeadingEmbeddingsInBackground } = require('../indexing/embeddings/headingEmbeddingSync');
		void repairHeadingEmbeddingsInBackground(kbRootUri).catch(err => {
			console.error('[DRIP] heading embedding repair failed', err);
		});
		const { repairFolderEmbeddingsInBackground } = require('../indexing/embeddings/folderEmbeddingSync');
		void repairFolderEmbeddingsInBackground(kbRootUri).catch(err => {
			console.error('[DRIP] folder embedding repair failed', err);
		});
		if (!quiet) {
			void vscode.window.showInformationMessage('DRIP knowledge base index is up to date.');
		}
		return { ok: true, updated: false };
	}

	await reconcileAllKbNoteHeadingIdentities(kbRootUri, context);
	await rebuildDripIndex(kbRootUri, context);

	// Background: encode any headings missing vectors (full rebuild clears embeddings).
	const { repairHeadingEmbeddingsInBackground } = require('../indexing/embeddings/headingEmbeddingSync');
	void repairHeadingEmbeddingsInBackground(kbRootUri).catch(err => {
		console.error('[DRIP] heading embedding repair failed', err);
	});
	const { repairFolderEmbeddingsInBackground } = require('../indexing/embeddings/folderEmbeddingSync');
	void repairFolderEmbeddingsInBackground(kbRootUri).catch(err => {
		console.error('[DRIP] folder embedding repair failed', err);
	});

	if (!quiet) {
		void vscode.window.showInformationMessage('DRIP knowledge base index updated.');
	}
	return { ok: true, updated: true };
}

module.exports = {
	updateKnowledgeBase
};
