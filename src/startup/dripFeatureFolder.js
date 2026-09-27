'use strict';

/**
 * Ensure feature index notes for `.f` folders and watch create/rename.
 *
 * Edit here when changing how feature folders bootstrap their `_name.f.d.txt` index.
 */

const path = require('path');
const vscode = require('vscode');
const {
	isDripFeatureFolderName,
	featureDisplayNameFromFolderName,
	featureIndexFileName
} = require('../document/model/dripFeature');
const { canPlaceFeature } = require('../document/model/dripKbFolderRules');
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
 * Create `_DisplayName.f.d.txt` inside a `.f` folder if missing.
 * h0 uses `# .f <DisplayName>` (structural folder marker; file-level attrs stay in settings).
 *
 * @param {import('vscode').Uri} folderUri
 * @param {{ context?: import('vscode').ExtensionContext, kbRoot?: import('vscode').Uri, open?: boolean }} [options]
 * @returns {Promise<import('vscode').Uri | undefined>}
 */
async function ensureFeatureIndexFile(folderUri, options = {}) {
	if (!folderUri) return undefined;
	const folderName = path.basename(folderUri.fsPath);
	if (!isDripFeatureFolderName(folderName)) return undefined;

	const kbRoot = options.kbRoot;
	if (kbRoot && !canPlaceFeature(kbRoot.fsPath, folderUri.fsPath)) {
		return undefined;
	}

	const key = folderUri.fsPath.replace(/\\/g, '/').toLowerCase();
	if (ensuringKeys.has(key)) return undefined;
	ensuringKeys.add(key);

	try {
		if (!(await isDirectoryUri(folderUri))) return undefined;

		const displayName = featureDisplayNameFromFolderName(folderName);
		const noteName = featureIndexFileName(folderName);
		const noteUri = vscode.Uri.joinPath(folderUri, noteName);

		try {
			await vscode.workspace.fs.stat(noteUri);
			return noteUri;
		} catch {
			// create
		}

		let n = 0;
		if (kbRoot) {
			try {
				n = await allocateNextEntityNumber(kbRoot);
			} catch (err) {
				console.error('[DRIP] allocate file id for feature index', err);
			}
		}

		let featureEntityId = '';
		if (kbRoot) {
			try {
				const rel = path.relative(kbRoot.fsPath, folderUri.fsPath).replace(/\\/g, '/');
				const parts = rel.split('/').filter(Boolean);
				let projectPrefix = '';
				for (let i = 0; i < parts.length; i++) {
					if (/\.p$/i.test(parts[i])) {
						projectPrefix = parts.slice(0, i + 1).join('/') + '/';
						break;
					}
				}
				if (projectPrefix) {
					const { allocateNextFeatureEntityId } = require('../document/project/projectEntityIds');
					featureEntityId = await allocateNextFeatureEntityId(kbRoot, projectPrefix);
				}
			} catch (err) {
				console.error('[DRIP] allocate feature entity id', err);
			}
		}

		const h0Label = featureEntityId ? `${featureEntityId} ${displayName}` : displayName;
		const text = buildNewNoteFile(
			{
				title: h0Label,
				content: '',
				metadataFilename: displayName
			},
			{
				fileEntityNumber: n,
				h0TypeMarker: '.f'
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
				console.error('[DRIP] normalize feature index identity', err);
			}
			try {
				await indexNewNoteImmediately(kbRoot, noteUri, options.context);
			} catch (err) {
				console.error('[DRIP] index feature index note', err);
			}
		}

		if (options.open) {
			await vscode.commands.executeCommand('vscode.open', noteUri);
		}
		return noteUri;
	} finally {
		ensuringKeys.delete(key);
	}
}

/**
 * @param {import('vscode').Uri} oldUri
 * @param {import('vscode').Uri} newUri
 * @param {{ context?: import('vscode').ExtensionContext, kbRoot?: import('vscode').Uri }} [options]
 */
async function handleFeatureFolderRename(oldUri, newUri, options = {}) {
	if (!newUri) return;
	const newName = path.basename(newUri.fsPath);
	const oldName = oldUri ? path.basename(oldUri.fsPath) : '';

	if (!isDripFeatureFolderName(newName)) return;
	if (!(await isDirectoryUri(newUri))) return;

	if (oldUri && isDripFeatureFolderName(oldName)) {
		const oldNoteName = featureIndexFileName(oldName);
		const newNoteName = featureIndexFileName(newName);
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
			/* fall through */
		}
	}

	await ensureFeatureIndexFile(newUri, options);
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {{ getKnowledgeBaseRoot: () => import('vscode').Uri | undefined }} state
 */
function registerDripFeatureFolderWatch(context, state) {
	context.subscriptions.push(
		vscode.workspace.onDidCreateFiles(async e => {
			const kbRoot = state.getKnowledgeBaseRoot && state.getKnowledgeBaseRoot();
			for (const uri of e.files || []) {
				const base = path.basename(uri.fsPath);
				if (!isDripFeatureFolderName(base)) continue;
				if (!(await isDirectoryUri(uri))) continue;
				try {
					await ensureFeatureIndexFile(uri, { context, kbRoot });
				} catch (err) {
					console.error('[DRIP] ensure feature index on create', err);
				}
			}
		}),
		vscode.workspace.onDidRenameFiles(async e => {
			const kbRoot = state.getKnowledgeBaseRoot && state.getKnowledgeBaseRoot();
			for (const f of e.files || []) {
				try {
					await handleFeatureFolderRename(f.oldUri, f.newUri, { context, kbRoot });
				} catch (err) {
					console.error('[DRIP] ensure feature index on rename', err);
				}
			}
		})
	);
}

module.exports = {
	ensureFeatureIndexFile,
	handleFeatureFolderRename,
	registerDripFeatureFolderWatch
};
