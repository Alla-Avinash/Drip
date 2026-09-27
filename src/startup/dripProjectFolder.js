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
	projectIndexFileName
} = require('../document/model/dripProjectFolder');
const { canPlaceProjectFolder } = require('../document/model/dripKbFolderRules');
const { buildNewNoteFile, writeTextFile } = require('../document/kbNoteOps');
const { allocateNextEntityNumber, indexNewNoteImmediately } = require('../indexing/dripnoteIndex');
const { normalizeNoteIdentityFile } = require('../indexing/dripnoteFileIdentity');

/** Prevent recursive create → watch → create loops. */
const ensuringKeys = new Set();

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
 * Create `_DisplayName.p.d.txt` inside a `.p` folder if missing.
 * h0 uses `# .p <DisplayName>` (structural folder marker; file-level attrs stay in settings).
 *
 * @param {import('vscode').Uri} folderUri
 * @param {{ context?: import('vscode').ExtensionContext, kbRoot?: import('vscode').Uri, open?: boolean }} [options]
 * @returns {Promise<import('vscode').Uri | undefined>}
 */
async function ensureProjectIndexFile(folderUri, options = {}) {
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

		const displayName = projectDisplayNameFromFolderName(folderName);
		const noteName = projectIndexFileName(folderName);
		const noteUri = vscode.Uri.joinPath(folderUri, noteName);

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
				n = await allocateNextEntityNumber(kbRoot);
			} catch (err) {
				console.error('[DRIP] allocate file id for project index', err);
			}
		}

		const text = buildNewNoteFile(
			{
				title: displayName,
				content: '',
				metadataFilename: displayName
			},
			{
				fileEntityNumber: n,
				h0TypeMarker: '.p'
			}
		);
		await writeTextFile(noteUri, text);

		if (kbRoot) {
			try {
				await normalizeNoteIdentityFile(noteUri, {
					context: options.context,
					kbRoot
				});
			} catch (err) {
				console.error('[DRIP] normalize project index identity', err);
			}
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
	ensureProjectIndexFile,
	handleProjectFolderRename,
	registerDripProjectFolderWatch
};
