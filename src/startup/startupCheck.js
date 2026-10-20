'use strict';

const vscode = require('vscode');
const { KB_ROOT_KEY } = require('../shared/constants');
const { isDriplockKnowledgeBaseUri } = require('./selectKnowledgeBase');
const { ensureDripIndexSkeleton } = require('./initializeDripIndex');
const { loadKbSidecar } = require('./loadKbSidecar');
const { updateKnowledgeBase } = require('./updateKnowledgeBase');
const { processAllPendingLinkMigrations } = require('../indexing/dripTxt/dripTxtReferencePhase3.js');
const { initEmptyDripIndexFile, getIndexDbUri } = require('../indexing/dripIndexDb');
const { ensureKbEditorNote } = require('./kbEditorNote');

const STARTUP_CHECK_COMPLETE_KEY = 'drip.startupCheckComplete';

/** Which KB folder path was checked this session (resets if KB changes). */
let reconciledStartupKbFsPath = '';
let startupCheckWarned = false;
/** @type {boolean} */
let startupCheckComplete = false;
/** @type {Promise<{ ok: boolean, kbRoot?: import('vscode').Uri, issues?: string[] }> | null} */
let startupCheckInFlight = null;
let startupCheckGeneration = 0;

/**
 * @param {boolean} complete
 */
async function setStartupCheckCompleteContext(complete) {
	startupCheckComplete = !!complete;
	await vscode.commands.executeCommand('setContext', STARTUP_CHECK_COMPLETE_KEY, startupCheckComplete);
}

/**
 * @param {import('vscode').Uri} uri
 * @returns {Promise<boolean>}
 */
async function uriExists(uri) {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

function resetStartupCheckCache() {
	startupCheckGeneration += 1;
	reconciledStartupKbFsPath = '';
	startupCheckWarned = false;
	void setStartupCheckCompleteContext(false);
}

function isStartupCheckReady() {
	return startupCheckComplete;
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {{
 *   getKnowledgeBaseRoot: () => import('vscode').Uri | undefined,
 *   setVerifiedKnowledgeBaseRoot: (uri: import('vscode').Uri | undefined) => void
 * }} state
 * @returns {Promise<{ ok: boolean, kbRoot?: import('vscode').Uri, issues?: string[] }>}
 */
async function runStartupCheck(context, state) {
	if (startupCheckInFlight) {
		return startupCheckInFlight;
	}
	startupCheckInFlight = runStartupCheckInner(context, state).finally(() => {
		startupCheckInFlight = null;
	});
	return startupCheckInFlight;
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {{
 *   getKnowledgeBaseRoot: () => import('vscode').Uri | undefined,
 *   setVerifiedKnowledgeBaseRoot: (uri: import('vscode').Uri | undefined) => void,
 *   refreshDraftsFromStorage?: () => Promise<unknown>,
 *   refreshRecentsFromStorage?: () => Promise<unknown>
 * }} state
 * @returns {Promise<{ ok: boolean, kbRoot?: import('vscode').Uri, issues?: string[] }>}
 */
async function runStartupCheckInner(context, state) {
	const generation = startupCheckGeneration;
	const kbRoot = state.getKnowledgeBaseRoot();
	if (!kbRoot) {
		state.setVerifiedKnowledgeBaseRoot(undefined);
		await setStartupCheckCompleteContext(true);
		return { ok: true };
	}

	const key = kbRoot.fsPath;
	if (reconciledStartupKbFsPath === key && startupCheckComplete) {
		return { ok: true, kbRoot };
	}

	await setStartupCheckCompleteContext(false);

	if (!(await uriExists(kbRoot))) {
		await handleStartupCheckFailure(context, state, 'The saved knowledge base folder no longer exists on disk.');
		return { ok: false, issues: ['kb-missing'] };
	}

	if (!isDriplockKnowledgeBaseUri(kbRoot)) {
		await handleStartupCheckFailure(
			context,
			state,
			'The saved knowledge base path is not a .driplock folder.'
		);
		return { ok: false, issues: ['not-driplock'] };
	}

	// The saved folder is a real `.driplock` KB. Promote it so dependent views (Daily Notes,
	// Drafts, Project View) can use it. We re-verify on every startup so a stale/invalid saved
	// path never leaks to the rest of the UI.
	state.setVerifiedKnowledgeBaseRoot(kbRoot);

	try {
		await ensureDripIndexSkeleton(kbRoot);
		await ensureKbEditorNote(kbRoot, context);
		await initEmptyDripIndexFile(kbRoot);
		await loadKbSidecar(context, kbRoot, {
			refreshDrafts:
				typeof state.refreshDraftsFromStorage === 'function'
					? () => state.refreshDraftsFromStorage()
					: undefined,
			refreshRecents:
				typeof state.refreshRecentsFromStorage === 'function'
					? () => state.refreshRecentsFromStorage()
					: undefined
		});

		const indexUri = getIndexDbUri(kbRoot);
		if (!(await uriExists(indexUri))) {
			const pick = await vscode.window.showWarningMessage(
				'Knowledge base has no index.drip database yet.',
				'Build index now',
				'Select another KB folder',
				'Later'
			);
			if (pick === 'Select another KB folder') {
				await vscode.commands.executeCommand('drip.selectKnowledgeBase');
				return { ok: false, issues: ['missing-index-drip'] };
			}
			if (pick !== 'Build index now') {
				return { ok: false, issues: ['missing-index-drip'] };
			}
			await updateKnowledgeBase(context, kbRoot, { force: true, quiet: true });
		}

		await processAllPendingLinkMigrations(kbRoot, context);

		if (generation !== startupCheckGeneration) {
			return { ok: false, issues: ['stale-check'] };
		}

		// Fill missing heading vectors without blocking startup completion.
		const { repairHeadingEmbeddingsInBackground } = require('../indexing/embeddings/headingEmbeddingSync');
		void repairHeadingEmbeddingsInBackground(kbRoot).catch(err => {
			console.error('[DRIP] startup heading embedding repair failed', err);
		});
		const { repairFolderEmbeddingsInBackground } = require('../indexing/embeddings/folderEmbeddingSync');
		void repairFolderEmbeddingsInBackground(kbRoot).catch(err => {
			console.error('[DRIP] startup folder embedding repair failed', err);
		});
		const { repairFileEmbeddingsInBackground } = require('../indexing/embeddings/fileEmbeddingSync');
		void repairFileEmbeddingsInBackground(kbRoot).catch(err => {
			console.error('[DRIP] startup file embedding repair failed', err);
		});

		reconciledStartupKbFsPath = key;
		await setStartupCheckCompleteContext(true);
		return { ok: true, kbRoot };
	} catch (err) {
		console.error('[DRIP] startup_check failed', err);
		reconciledStartupKbFsPath = '';
		const msg = err && err.message ? String(err.message) : String(err);
		await handleStartupCheckFailure(context, state, `Startup knowledge base check failed (${msg}).`);
		return { ok: false, issues: ['check-failed'] };
	}
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {{
 *   getKnowledgeBaseRoot?: () => import('vscode').Uri | undefined,
 *   setVerifiedKnowledgeBaseRoot: (uri: import('vscode').Uri | undefined) => void
 * }} state
 * @param {string} message
 */
async function handleStartupCheckFailure(context, state, message) {
	await setStartupCheckCompleteContext(false);
	state.setVerifiedKnowledgeBaseRoot(undefined);
	if (startupCheckWarned) {
		return;
	}
	startupCheckWarned = true;
	const pick = await vscode.window.showWarningMessage(
		message,
		'Build index now',
		'Select another KB folder',
		'Later'
	);
	const kbRootRaw = context.workspaceState.get(KB_ROOT_KEY);
	const kbUri = kbRootRaw ? vscode.Uri.parse(String(kbRootRaw)) : undefined;
	if (pick === 'Build index now' && kbUri) {
		try {
			await updateKnowledgeBase(context, kbUri, { force: true, quiet: true });
			reconciledStartupKbFsPath = kbUri.fsPath;
			if (isDriplockKnowledgeBaseUri(kbUri)) {
				state.setVerifiedKnowledgeBaseRoot(kbUri);
			}
			await setStartupCheckCompleteContext(true);
		} catch (e) {
			console.error('[DRIP] startup_check recovery', e);
		}
	} else if (pick === 'Select another KB folder') {
		await vscode.commands.executeCommand('drip.selectKnowledgeBase');
	}
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {{
 *   getKnowledgeBaseRoot: () => import('vscode').Uri | undefined,
 *   setVerifiedKnowledgeBaseRoot: (uri: import('vscode').Uri | undefined) => void
 * }} state
 * @param {() => void} [onComplete] Called after each startup check settles, so views can refresh.
 */
function registerStartupCheck(context, state, onComplete) {
	void setStartupCheckCompleteContext(false);

	void runStartupCheck(context, state).then(() => {
		if (typeof onComplete === 'function') {
			onComplete();
		}
	});
	void (async () => {
		await new Promise(r => setTimeout(r, 2000));
		await runStartupCheck(context, state);
		if (typeof onComplete === 'function') {
			onComplete();
		}
	})();
}

module.exports = {
	STARTUP_CHECK_COMPLETE_KEY,
	isStartupCheckReady,
	registerStartupCheck,
	resetStartupCheckCache,
	runStartupCheck
};
