'use strict';

/**
 * Ensure project index notes for `.p` folders and watch create/rename.
 *
 * Edit here when changing how project folders bootstrap their `_name.p.d.txt` index.
 */

const path = require('path');
const vscode = require('vscode');
const {
	isDripProjectFolderName,
	projectDisplayNameFromFolderName,
	projectIndexFileName,
	CONCEPTS_SUBFOLDER_NAME,
	DECISIONS_SUBFOLDER_NAME,
	ARCHIVE_SUBFOLDER_NAME
} = require('../document/model/dripNoteProjectFolder.js');
const { canPlaceProjectFolder } = require('../document/model/dripNoteKbFolderRules.js');
const { buildNewNoteFile, writeTextFile } = require('../document/dripNoteKbOps.js');
const { allocateNextEntityNumber, indexNewNoteImmediately } = require('../indexing/dripTxt/dripTxtIndex.js');

/** Prevent recursive create → watch → create loops. */
const ensuringKeys = new Set();
/** Join writes a full folder; do not scaffold an empty `_issues` over it. */
let suppressEnsure = 0;

function pauseProjectFolderEnsure() {
	suppressEnsure += 1;
}

function resumeProjectFolderEnsure() {
	suppressEnsure = Math.max(0, suppressEnsure - 1);
}

/**
 * @param {import('vscode').Uri} folderUri
 * @returns {Promise<boolean>}
 */
async function isDirectoryUri(folderUri) {
	try {
		const st = await vscode.workspace.fs.stat(folderUri);
		return (st.type & vscode.FileType.Directory) !== 0;
	} catch {
		return false;
	}
}

/**
 * Create the project-scoped subfolders (`_concepts`, `_decisions`, `_archive`) if missing.
 *
 * @param {import('vscode').Uri} folderUri
 * @returns {Promise<void>}
 */
async function ensureProjectSpecialFolders(folderUri) {
	if (!folderUri) return;
	for (const name of [CONCEPTS_SUBFOLDER_NAME, DECISIONS_SUBFOLDER_NAME, ARCHIVE_SUBFOLDER_NAME]) {
		const subUri = vscode.Uri.joinPath(folderUri, name);
		try {
			await vscode.workspace.fs.stat(subUri);
		} catch {
			await vscode.workspace.fs.createDirectory(subUri);
		}
	}
}

/**
 * Create `_DisplayName.p.d.txt` inside a `.p` folder if missing.
 * h0 uses `# .p <DisplayName>` (structural folder marker; file-level attrs stay in settings).
 *
 * @param {import('vscode').Uri} folderUri
 * @param {{ context?: import('vscode').ExtensionContext, kbRoot?: import('vscode').Uri, open?: boolean }} [options]
 * @returns {Promise<import('vscode').Uri | undefined>}
 */
async function ensureProjectIndexFile(folderUri, options = {}) {
	if (suppressEnsure > 0) return undefined;
	if (!folderUri) return undefined;
	const folderName = path.basename(folderUri.fsPath);
	if (!isDripProjectFolderName(folderName)) return undefined;

	const kbRoot = options.kbRoot;
	if (kbRoot && !canPlaceProjectFolder(kbRoot.fsPath, folderUri.fsPath)) {
		return undefined;
	}

	const key = folderUri.fsPath.replace(/\\/g, '/').toLowerCase();
	if (ensuringKeys.has(key)) return undefined;
	ensuringKeys.add(key);

	try {
		if (!(await isDirectoryUri(folderUri))) return undefined;

		await ensureProjectSpecialFolders(folderUri);

		const displayName = projectDisplayNameFromFolderName(folderName);
		const noteName = projectIndexFileName(folderName);
		const noteUri = vscode.Uri.joinPath(folderUri, noteName);
		const isDripMd = noteName.toLowerCase().endsWith('.d.md');

		try {
			await vscode.workspace.fs.stat(noteUri);
			try {
				const { ensureProjectIssuesFile } = require('../document/project/projectIssuesMailbox');
				await ensureProjectIssuesFile(folderUri, { context: options.context, kbRoot });
			} catch (err) {
				console.error('[DRIP] ensure _issues.d.txt', err);
			}
			return noteUri; // already present
		} catch {
			// create
		}

		let n = 0;
		if (kbRoot) {
			try {
				n = await allocateNextEntityNumber(kbRoot, noteUri);
			} catch (err) {
				console.error('[DRIP] allocate file id for project index', err);
			}
		}

		const text = buildNewNoteFile(
			{
				title: displayName,
				content: '',
				metadataFilename: displayName,
				typeId: 'project'
			},
			isDripMd
				? { fileEntityNumber: n, format: 'drip-md' }
				: { fileEntityNumber: n, h0TypeMarker: '.p' }
		);
		await writeTextFile(noteUri, text);

		if (kbRoot) {
			try {
				await indexNewNoteImmediately(kbRoot, noteUri, options.context);
			} catch (err) {
				console.error('[DRIP] index project index note', err);
			}
		}

		if (options.open) {
			await vscode.commands.executeCommand('vscode.open', noteUri);
		}
		try {
			const { ensureProjectIssuesFile } = require('../document/project/projectIssuesMailbox');
			await ensureProjectIssuesFile(folderUri, { context: options.context, kbRoot });
		} catch (err) {
			console.error('[DRIP] ensure _issues.d.txt', err);
		}
		return noteUri;
	} finally {
		ensuringKeys.delete(key);
	}
}

/**
 * After a folder rename into/out of `.p`, ensure index note (and rename old index if possible).
 *
 * @param {import('vscode').Uri} oldUri
 * @param {import('vscode').Uri} newUri
 * @param {{ context?: import('vscode').ExtensionContext, kbRoot?: import('vscode').Uri }} [options]
 */
async function handleProjectFolderRename(oldUri, newUri, options = {}) {
	if (!newUri) return;
	const newName = path.basename(newUri.fsPath);
	const oldName = oldUri ? path.basename(oldUri.fsPath) : '';

	if (!isDripProjectFolderName(newName)) return;
	if (!(await isDirectoryUri(newUri))) return;

	// Folder rename keeps children: old index may sit under newUri as `_Old.p.d.txt`.
	if (oldUri && isDripProjectFolderName(oldName)) {
		const oldNoteName = projectIndexFileName(oldName);
		const newNoteName = projectIndexFileName(newName);
		if (oldNoteName === newNoteName) return;
		const maybeOldInNew = vscode.Uri.joinPath(newUri, oldNoteName);
		const newNote = vscode.Uri.joinPath(newUri, newNoteName);
		try {
			await vscode.workspace.fs.stat(maybeOldInNew);
			try {
				await vscode.workspace.fs.stat(newNote);
			} catch {
				await vscode.workspace.fs.rename(maybeOldInNew, newNote, { overwrite: false });
				return;
			}
		} catch {
			/* fall through to ensure */
		}
	}

	await ensureProjectIndexFile(newUri, options);
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {{ getKnowledgeBaseRoot: () => import('vscode').Uri | undefined }} state
 */
function registerDripProjectFolderWatch(context, state) {
	context.subscriptions.push(
		vscode.workspace.onDidCreateFiles(async e => {
			const kbRoot = state.getKnowledgeBaseRoot && state.getKnowledgeBaseRoot();
			for (const uri of e.files || []) {
				const base = path.basename(uri.fsPath);
				if (!isDripProjectFolderName(base)) continue;
				if (!(await isDirectoryUri(uri))) continue;
				try {
					await ensureProjectIndexFile(uri, { context, kbRoot });
				} catch (err) {
					console.error('[DRIP] ensure project index on create', err);
				}
			}
		}),
		vscode.workspace.onDidRenameFiles(async e => {
			const kbRoot = state.getKnowledgeBaseRoot && state.getKnowledgeBaseRoot();
			for (const f of e.files || []) {
				try {
					await handleProjectFolderRename(f.oldUri, f.newUri, { context, kbRoot });
				} catch (err) {
					console.error('[DRIP] ensure project index on rename', err);
				}
			}
		})
	);
}

module.exports = {
	ensureProjectSpecialFolders,
	ensureProjectIndexFile,
	handleProjectFolderRename,
	registerDripProjectFolderWatch,
	pauseProjectFolderEnsure,
	resumeProjectFolderEnsure
};
