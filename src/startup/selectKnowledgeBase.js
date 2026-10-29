'use strict';

const path = require('path');
const vscode = require('vscode');
const { KB_ROOT_KEY } = require('../shared/constants');
const { ensureDripIndexSkeleton } = require('./initializeDripIndex');
const { loadKbSidecar } = require('./loadKbSidecar');
const { ensureKbEditorNote } = require('./kbEditorNote');

const DRIPLOCK_SUFFIX = '.driplock';

/**
 * @param {string} folderName
 */
function isDriplockFolderName(folderName) {
	return String(folderName || '').toLowerCase().endsWith(DRIPLOCK_SUFFIX);
}

/**
 * @param {import('vscode').Uri} uri
 */
function isDriplockKnowledgeBaseUri(uri) {
	return uri && uri.scheme === 'file' && isDriplockFolderName(path.basename(uri.fsPath));
}

/**
 * Walk parent directories from `startUri` for a folder whose name ends with `.driplock`.
 * @param {import('vscode').Uri} startUri
 * @returns {Promise<import('vscode').Uri | undefined>}
 */
async function findParentDriplockFolder(startUri) {
	let current = path.dirname(startUri.fsPath);
	const fsRoot = path.parse(current).root.toLowerCase();

	while (current && current.toLowerCase() !== fsRoot) {
		if (isDriplockFolderName(path.basename(current))) {
			return vscode.Uri.file(current);
		}
		const parent = path.dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return undefined;
}

/**
 * Rename a plain folder to `{name}.driplock` (same parent directory).
 * @param {import('vscode').Uri} folderUri
 * @returns {Promise<import('vscode').Uri | undefined>}
 */
async function initializeFolderAsDriplock(folderUri) {
	const parentDir = path.dirname(folderUri.fsPath);
	const baseName = path.basename(folderUri.fsPath);
	const targetName = isDriplockFolderName(baseName) ? baseName : `${baseName}${DRIPLOCK_SUFFIX}`;
	const targetPath = path.join(parentDir, targetName);

	if (targetPath.toLowerCase() === folderUri.fsPath.toLowerCase()) {
		return folderUri;
	}

	try {
		await vscode.workspace.fs.stat(vscode.Uri.file(targetPath));
		await vscode.window.showErrorMessage(
			`DRIP: Cannot rename to "${targetName}" — a folder with that name already exists.`
		);
		return undefined;
	} catch {
		// target free
	}

	try {
		await vscode.workspace.fs.rename(folderUri, vscode.Uri.file(targetPath), { overwrite: false });
		return vscode.Uri.file(targetPath);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await vscode.window.showErrorMessage(`DRIP: Failed to initialize knowledge base folder: ${msg}`);
		return undefined;
	}
}

/**
 * Apply features.txt userflow for a folder picked in the open dialog.
 * @param {import('vscode').Uri} selectedUri
 * @returns {Promise<import('vscode').Uri | undefined>}
 */
async function resolveKnowledgeBaseFromSelection(selectedUri) {
	if (!selectedUri || selectedUri.scheme !== 'file') {
		return undefined;
	}

	if (isDriplockKnowledgeBaseUri(selectedUri)) {
		return selectedUri;
	}

	const parentDriplock = await findParentDriplockFolder(selectedUri);
	if (parentDriplock) {
		const label = path.basename(parentDriplock.fsPath);
		const pick = await vscode.window.showInformationMessage(
			`DRIP found a knowledge base folder in a parent directory: "${label}".`,
			{
				modal: true,
				detail: 'Use it as the knowledge base root?'
			},
			'Use parent .driplock',
			'Cancel'
		);
		if (pick === 'Use parent .driplock') {
			return parentDriplock;
		}
		return undefined;
	}

	const folderName = path.basename(selectedUri.fsPath);
	const targetName = `${folderName}${DRIPLOCK_SUFFIX}`;
	const pick = await vscode.window.showInformationMessage(
		`"${folderName}" is not a .driplock folder.`,
		{
			modal: true,
			detail: `Initialize it as a DRIP knowledge base? The folder will be renamed to "${targetName}".`
		},
		'Initialize as .driplock',
		'Cancel'
	);
	if (pick !== 'Initialize as .driplock') {
		return undefined;
	}

	return initializeFolderAsDriplock(selectedUri);
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').Uri} kbRootUri
 */
async function bindKnowledgeBaseRoot(context, kbRootUri) {
	if (!isDriplockKnowledgeBaseUri(kbRootUri)) {
		throw new Error('Knowledge base root must be a .driplock folder.');
	}
	await context.workspaceState.update(KB_ROOT_KEY, kbRootUri.toString());
	await ensureDripIndexSkeleton(kbRootUri);
	await loadKbSidecar(context, kbRootUri);
	await ensureKbEditorNote(kbRootUri, context);
	await require('./projectsDrip').ensureProjectsHome(kbRootUri);
	return kbRootUri;
}

/**
 * Open folder picker, resolve .driplock per userflow, persist KB root in workspace state.
 * @param {import('vscode').ExtensionContext} context
 * @returns {Promise<import('vscode').Uri | undefined>}
 */
async function pickAndBindKnowledgeBase(context) {
	const selected = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: 'Select DRIP knowledge base folder'
	});

	if (!selected || !selected.length) {
		return undefined;
	}

	const resolved = await resolveKnowledgeBaseFromSelection(selected[0]);
	if (!resolved) {
		return undefined;
	}

	await bindKnowledgeBaseRoot(context, resolved);
	return resolved;
}

module.exports = {
	bindKnowledgeBaseRoot,
	findParentDriplockFolder,
	isDriplockKnowledgeBaseUri,
	pickAndBindKnowledgeBase,
	resolveKnowledgeBaseFromSelection
};
