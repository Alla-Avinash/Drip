'use strict';

/**
 * Embedding model change (Step 9).
 *
 * Changing the model:
 * - Deletes heading + folder vectors only
 * - Deletes FAISS sidecar
 * - Updates index_meta.embedding_model + bumps embedding_generation
 * - Background-rebuilds heading and folder embeddings
 *
 * Preserves files, headings, tags, metadata, and other index rows.
 */

const vscode = require('vscode');
const { openDripIndexDb } = require('../dripIndexDb');
const {
	getEmbeddingMeta,
	setEmbeddingModelMeta,
	clearAllHeadingEmbeddings,
	DEFAULT_EMBEDDING_MODEL
} = require('./headingEmbeddingStore');
const { clearAllFolderEmbeddings } = require('./folderEmbeddingStore');
const { deleteFaissArtifacts, clearFaissSession } = require('./headingEmbeddingFaiss');
const {
	clearHeadingEmbeddingSearchLock,
	lockHeadingEmbeddingSearchMethod
} = require('./headingEmbeddingSearchMethod');
const { repairHeadingEmbeddingsInBackground } = require('./headingEmbeddingSync');
const { repairFolderEmbeddingsInBackground } = require('./folderEmbeddingSync');

/** Suppress config-watch rebuild while we apply a confirmed change ourselves. */
let suppressConfigWatch = 0;

/**
 * @param {string | null | undefined} modelId
 * @returns {string}
 */
function normalizeEmbeddingModelId(modelId) {
	const t = String(modelId || '').trim();
	return t || DEFAULT_EMBEDDING_MODEL;
}

/**
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withSuppressedEmbeddingModelConfigWatch(fn) {
	suppressConfigWatch += 1;
	try {
		return await fn();
	} finally {
		suppressConfigWatch = Math.max(0, suppressConfigWatch - 1);
	}
}

function isEmbeddingModelConfigWatchSuppressed() {
	return suppressConfigWatch > 0;
}

/**
 * Apply model id to index.drip and wipe/rebuild embedding tables only.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} newModelId
 * @returns {Promise<{ ok: boolean, model: string, generation: string, skipped?: boolean }>}
 */
async function applyEmbeddingModelChange(kbRootUri, newModelId) {
	const model = normalizeEmbeddingModelId(newModelId);
	if (!kbRootUri) {
		return { ok: false, model, generation: '0' };
	}

	const handle = await openDripIndexDb(kbRootUri);
	let meta;
	try {
		const prev = getEmbeddingMeta(handle.db);
		if (prev.model === model) {
			return { ok: true, model, generation: prev.generation, skipped: true };
		}
		meta = setEmbeddingModelMeta(handle.db, model);
		clearAllHeadingEmbeddings(handle.db);
		clearAllFolderEmbeddings(handle.db);
	} finally {
		handle.close();
	}

	try {
		deleteFaissArtifacts(kbRootUri);
	} catch (err) {
		console.warn('[DRIP] FAISS cleanup after model change failed', err && err.message);
	}
	clearFaissSession(kbRootUri);
	clearHeadingEmbeddingSearchLock(kbRootUri);

	try {
		await repairHeadingEmbeddingsInBackground(kbRootUri);
	} catch (err) {
		console.error('[DRIP] heading embedding rebuild after model change failed', err);
	}
	try {
		await repairFolderEmbeddingsInBackground(kbRootUri);
	} catch (err) {
		console.error('[DRIP] folder embedding rebuild after model change failed', err);
	}
	// Vectors are empty until drain finishes; lock will become exact/faiss on later search/startup.
	void lockHeadingEmbeddingSearchMethod(kbRootUri, { force: true }).catch(() => {});

	console.log(
		`[DRIP] embedding model changed → ${meta.model} (generation=${meta.generation}); vectors cleared, rebuild queued`
	);
	return { ok: true, model: meta.model, generation: meta.generation };
}

/**
 * Confirm + apply when the user changes the model from DRIP Settings (or VS Code settings).
 * @param {import('vscode').Uri | undefined} kbRootUri
 * @param {string} newModelId
 * @param {{ previousModelId?: string, persistSetting?: (model: string) => Promise<void> }} [opts]
 * @returns {Promise<{ ok: boolean, cancelled?: boolean, model: string }>}
 */
async function confirmAndApplyEmbeddingModelChange(kbRootUri, newModelId, opts) {
	const next = normalizeEmbeddingModelId(newModelId);
	const previous = normalizeEmbeddingModelId(
		opts?.previousModelId != null
			? opts.previousModelId
			: vscode.workspace.getConfiguration('drip').get('embeddingModel', DEFAULT_EMBEDDING_MODEL)
	);

	if (next === previous) {
		if (opts?.persistSetting) {
			await withSuppressedEmbeddingModelConfigWatch(() => opts.persistSetting(next));
		}
		return { ok: true, model: next, cancelled: false };
	}

	const choice = await vscode.window.showWarningMessage(
		'Changing the embedding model will delete and rebuild all heading and folder embeddings. Files, heading IDs, metadata, and tags are kept.',
		{ modal: true },
		'Change & Rebuild',
		'Cancel'
	);
	if (choice !== 'Change & Rebuild') {
		return { ok: false, cancelled: true, model: previous };
	}

	if (!kbRootUri) {
		if (opts?.persistSetting) {
			await withSuppressedEmbeddingModelConfigWatch(() => opts.persistSetting(next));
		}
		void vscode.window.showInformationMessage(
			`Embedding model set to ${next}. Open a knowledge base to rebuild vectors.`
		);
		return { ok: true, model: next };
	}

	await withSuppressedEmbeddingModelConfigWatch(async () => {
		const result = await applyEmbeddingModelChange(kbRootUri, next);
		if (opts?.persistSetting) {
			await opts.persistSetting(next);
		}
		if (result.ok && !result.skipped) {
			void vscode.window.showInformationMessage(
				`Embedding model set to ${next}. Heading and folder vectors are rebuilding in the background.`
			);
		}
	});

	return { ok: true, model: next };
}

/**
 * If workspace `drip.embeddingModel` drifts from index_meta, prompt to rebuild or revert.
 * @param {import('vscode').Uri | undefined} kbRootUri
 */
async function reconcileEmbeddingModelSettingWithIndex(kbRootUri) {
	if (isEmbeddingModelConfigWatchSuppressed() || !kbRootUri) {
		return;
	}
	const desired = normalizeEmbeddingModelId(
		vscode.workspace.getConfiguration('drip').get('embeddingModel', DEFAULT_EMBEDDING_MODEL)
	);
	const handle = await openDripIndexDb(kbRootUri);
	let indexed;
	try {
		indexed = getEmbeddingMeta(handle.db).model;
	} finally {
		handle.close();
	}
	if (normalizeEmbeddingModelId(indexed) === desired) {
		return;
	}

	const choice = await vscode.window.showWarningMessage(
		`Settings embedding model (${desired}) differs from this knowledge base (${indexed}). Changing it rebuilds heading and folder embeddings only.`,
		{ modal: true },
		'Change & Rebuild',
		'Revert Setting'
	);
	if (choice === 'Change & Rebuild') {
		await withSuppressedEmbeddingModelConfigWatch(async () => {
			await applyEmbeddingModelChange(kbRootUri, desired);
		});
		return;
	}
	if (choice === 'Revert Setting') {
		await withSuppressedEmbeddingModelConfigWatch(async () => {
			await vscode.workspace
				.getConfiguration('drip')
				.update('embeddingModel', indexed, vscode.ConfigurationTarget.Workspace);
		});
	}
}

module.exports = {
	normalizeEmbeddingModelId,
	applyEmbeddingModelChange,
	confirmAndApplyEmbeddingModelChange,
	reconcileEmbeddingModelSettingWithIndex,
	isEmbeddingModelConfigWatchSuppressed,
	withSuppressedEmbeddingModelConfigWatch
};
