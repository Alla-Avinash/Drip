'use strict';

/**
 * reconcile-update — unwired document + index repair pipeline.
 *
 * File-level layout (`filename` / `fileid` / `headings` / h0 / `---`) is shared with
 * live reconcile via `rebuildCanonicalFileLevelBlock` in `dripTxtHeadingIdentity.js`.
 *
 * Flow:
 * 1) Resolve `@fN` ownership against `files` in index.drip
 * 2) Fix file header (fileid, filename, headings) and keep h0 below `---`
 * 3) Rewrite heading identity lines (`@hN`)
 *    - reset (new id / reclaim / first insert): fresh 1..N below h0
 *    - existing: keep hM, fill missing
 * 4) Persist to index.drip immediately
 */

const path = require('path');
const vscode = require('vscode');
const { getMetadataSettings } = require('../../../document/model/dripNoteMetadataTemplates.js');
const { classifyPersistentHeadingTitle } = require('../../../document/model/dripTxt/dripTxtPersistentHeading.js');
const { collectHeadingSequenceValidated } = require('../../../document/parse/dripTxt/dripTxtHeadingParse.js');
const {
	allocateNextFileEntityNumber,
	applyParsedNoteToIndex,
	collectKnownTagNamesLower,
	lookupFileRowById,
	replaceParsedNoteAtFileId,
	syncFileHeadingAllocatorFromUsedIds
} = require('../../dripIndexDb');
const { parseNoteForIndex } = require('../../dripIndexParse');
const { formatFileEntityId } = require('../../dripTxt/dripTxtEntityIds.js');
const {
	findHeadingIdentityForNode,
	findOwnedIdentityLineIndex,
	findH0HeadingLine,
	formatHeadingIdentityLine,
	headingLineIndent,
	isH0HeadingNode,
	parseFileEntityFromLines,
	rebuildCanonicalFileLevelBlock,
	resolveFilenameStem
} = require('../../dripTxt/dripTxtHeadingIdentity.js');
const { applyReconciledTextToOpenNote } = require('../../dripTxt/dripTxtHeadingIdentityReconcile.js');
const { readTextFile, writeTextFile } = require('../../kbFilesystem');
const { classifyNoteZone } = require('../../projectIndex');
const {
	isNoteInProject,
	allocateFileNumberForNote,
	recordProjectFileNumber,
	isSharedProjectNote,
	headingAllocScopeForNote
} = require('../../../document/project/projectFileIds');

const MODE_EXISTING = 'existing';
const MODE_RECLAIM = 'reclaim';
const MODE_FIRST_INSERT = 'first-insert';
const MODE_CONFLICT_NEW_ID = 'conflict-new-id';

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 */
function relPathForNote(kbRootUri, noteUri) {
	return path.relative(kbRootUri.fsPath, noteUri.fsPath).replace(/\\/g, '/');
}

/**
 * @param {import('vscode').Uri} uri
 */
async function uriExists(uri) {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {import('vscode').Uri} noteUri
 */
async function readNoteTextPreferOpen(noteUri) {
	const key = noteUri.toString();
	const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key && !d.isClosed);
	if (doc) {
		return doc.getText();
	}
	return readTextFile(noteUri);
}

/**
 * @param {string[]} lines
 * @param {number} count
 * @returns {string[]}
 */
function writeHeadingsCountLine(lines, count) {
	const n = Math.max(0, Math.floor(Number(count) || 0));
	return (lines || []).map(line => {
		const m = String(line || '').match(/^(\s*)headings(\s*:\s*)(\d+)(.*)$/i);
		if (!m) return line;
		return `${m[1]}headings${m[2]}${n}${m[4] || ''}`;
	});
}

/**
 * @param {string[]} lines
 * @returns {{ h0LineIndex: number, nodes: object[] }}
 */
function headingWalk(lines) {
	const { nodes } = collectHeadingSequenceValidated(lines, 0);
	return { h0LineIndex: findH0HeadingLine(lines), nodes };
}

/**
 * Rewrite `@hN` lines. h0 stays h0. Fresh numbering is 1..N in file order for
 * persistent headings below `---`. Existing mode keeps hM and fills gaps.
 *
 * @param {string[]} lines
 * @param {string} fileEntityId unused (heading identity carries no file id)
 * @param {{ freshNumbers: boolean }} options
 * @returns {{ lines: string[], nonH0Count: number, usedNonH0Ids: number[] }}
 */
function rewriteHeadingIdentities(lines, fileEntityId, options) {
	const next = [...(lines || [])];
	const settings = getMetadataSettings();
	const { h0LineIndex, nodes } = headingWalk(next);
	const titled = (nodes || []).filter(node => /\S/.test(String(node.title || '').trim()));
	const freshNumbers = options && options.freshNumbers === true;

	/** @type {Set<number>} */
	const removeIdentityForHeadingLines = new Set();
	/** @type {Map<number, string>} */
	const wantLineByIndex = new Map();
	/** @type {number[]} */
	const usedNonH0Ids = [];

	let nextNum = 1;
	if (!freshNumbers) {
		let max = 0;
		for (const node of titled) {
			if (isH0HeadingNode(node, h0LineIndex)) continue;
			const attached = findHeadingIdentityForNode(next, node);
			const num = attached ? attached.parsed.headingNum : 0;
			if (num > max) max = num;
		}
		nextNum = max + 1;
	}

	for (const node of titled) {
		const isH0 = isH0HeadingNode(node, h0LineIndex);
		const classification = classifyPersistentHeadingTitle(node.title, settings);
		if (!isH0 && !classification.persistent) {
			if (findHeadingIdentityForNode(next, node)) {
				removeIdentityForHeadingLines.add(node.lineIndex);
			}
			continue;
		}

		let headingNum = 0;
		if (!isH0) {
			if (freshNumbers) {
				headingNum = nextNum;
				nextNum += 1;
			} else {
				const attached = findHeadingIdentityForNode(next, node);
				const prev = attached ? attached.parsed.headingNum : 0;
				if (prev > 0) {
					headingNum = prev;
				} else {
					headingNum = nextNum;
					nextNum += 1;
				}
			}
			usedNonH0Ids.push(headingNum);
		}

		const indent = headingLineIndent(next, node.lineIndex);
		wantLineByIndex.set(
			node.lineIndex,
			`${indent}${formatHeadingIdentityLine(headingNum)}`
		);
	}

	const sorted = [...titled].sort((a, b) => b.lineIndex - a.lineIndex);
	for (const node of sorted) {
		const headingLine = node.lineIndex;
		const idLine = findOwnedIdentityLineIndex(next, headingLine);
		if (removeIdentityForHeadingLines.has(headingLine)) {
			if (idLine >= 0) {
				next.splice(idLine, 1);
			}
			continue;
		}
		const wantLine = wantLineByIndex.get(headingLine);
		if (!wantLine) continue;
		if (idLine >= 0) {
			if (String(next[idLine] || '') !== wantLine) {
				next[idLine] = wantLine;
			}
			continue;
		}
		next.splice(headingLine, 0, wantLine);
	}

	return {
		lines: next,
		nonH0Count: usedNonH0Ids.length,
		usedNonH0Ids
	};
}

/**
 * Query index.drip for the claimed `@fN` and decide keep / reclaim / allocate.
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @param {number | null} claimedFileId
 * @returns {Promise<{ fileId: number, fileEntityId: string, mode: string, indexedPath: string | null }>}
 */
async function resolveFileIdOwnership(kbRootUri, noteUri, claimedFileId) {
	const currentPath = relPathForNote(kbRootUri, noteUri);

	if (isNoteInProject(kbRootUri, noteUri)) {
		if (claimedFileId == null || !Number.isFinite(claimedFileId) || claimedFileId < 0) {
			const allocated = await allocateFileNumberForNote(kbRootUri, noteUri);
			const fileId =
				allocated != null ? allocated : await allocateNextFileEntityNumber(kbRootUri);
			return {
				fileId,
				fileEntityId: formatFileEntityId(fileId),
				mode: MODE_FIRST_INSERT,
				indexedPath: null
			};
		}
		await recordProjectFileNumber(kbRootUri, noteUri, claimedFileId);
		const row = await lookupFileRowById(kbRootUri, claimedFileId);
		const indexedPath = row ? String(row.path || '').replace(/\\/g, '/') : null;
		// Keep the project's `@fN` even when a KB note already uses that number.
		return {
			fileId: claimedFileId,
			fileEntityId: formatFileEntityId(claimedFileId),
			mode: MODE_EXISTING,
			indexedPath
		};
	}

	if (claimedFileId == null || !Number.isFinite(claimedFileId) || claimedFileId < 0) {
		const fileId = await allocateNextFileEntityNumber(kbRootUri);
		return {
			fileId,
			fileEntityId: formatFileEntityId(fileId),
			mode: MODE_FIRST_INSERT,
			indexedPath: null
		};
	}

	const row = await lookupFileRowById(kbRootUri, claimedFileId);
	if (!row) {
		return {
			fileId: claimedFileId,
			fileEntityId: formatFileEntityId(claimedFileId),
			mode: MODE_FIRST_INSERT,
			indexedPath: null
		};
	}

	const indexedPath = String(row.path || '').replace(/\\/g, '/');
	if (indexedPath === currentPath) {
		return {
			fileId: claimedFileId,
			fileEntityId: formatFileEntityId(claimedFileId),
			mode: MODE_EXISTING,
			indexedPath
		};
	}

	const otherUri = vscode.Uri.joinPath(kbRootUri, ...indexedPath.split('/').filter(Boolean));
	if (await uriExists(otherUri)) {
		const fileId = await allocateNextFileEntityNumber(kbRootUri);
		return {
			fileId,
			fileEntityId: formatFileEntityId(fileId),
			mode: MODE_CONFLICT_NEW_ID,
			indexedPath
		};
	}

	return {
		fileId: claimedFileId,
		fileEntityId: formatFileEntityId(claimedFileId),
		mode: MODE_RECLAIM,
		indexedPath
	};
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @param {string} text
 * @param {number} fileId
 * @param {string} mode
 * @param {import('vscode').ExtensionContext | null | undefined} context
 */
async function persistReconcileUpdate(kbRootUri, noteUri, text, fileId, mode, context) {
	const relPath = relPathForNote(kbRootUri, noteUri);
	let stat;
	try {
		stat = await vscode.workspace.fs.stat(noteUri);
	} catch {
		stat = undefined;
	}
	const parsed = parseNoteForIndex(
		text,
		relPath,
		path.basename(noteUri.fsPath),
		{ ctimeMs: stat && stat.ctime, mtimeMs: stat && stat.mtime },
		{ knownTagsLower: collectKnownTagNamesLower(context) }
	);
	parsed.fileId = fileId;

	/** @type {{ fileId: number, headingId: number }[]} */
	const embeddingUpserts = [];
	const zone = classifyNoteZone(relPath);
	// Project notes upsert by path so a colliding KB `@fN` cannot steal that files row
	// or get written back into the project file header.
	let persistedId = fileId;
	if (mode === MODE_EXISTING || zone === 'project') {
		persistedId = await applyParsedNoteToIndex(kbRootUri, relPath, parsed, context, {
			incremental: true,
			embeddingUpserts
		});
	} else {
		persistedId = await replaceParsedNoteAtFileId(kbRootUri, fileId, parsed, context, { embeddingUpserts });
	}
	const { enqueueHeadingEmbeddingUpserts } = require('../../embeddings/headingEmbeddingSync');
	enqueueHeadingEmbeddingUpserts(kbRootUri, embeddingUpserts);
	const { enqueueFolderEmbeddingsForNotePath } = require('../../embeddings/folderEmbeddingSync');
	enqueueFolderEmbeddingsForNotePath(kbRootUri, relPath);

	const usedIds = (parsed.headings || [])
		.map(h => Number(h.heading_id))
		.filter(n => Number.isFinite(n) && n > 0);
	await syncFileHeadingAllocatorFromUsedIds(
		kbRootUri,
		fileId,
		usedIds,
		headingAllocScopeForNote(kbRootUri, noteUri)
	);
	return parsed;
}

/**
 * Unwired entry point for the planned feature.
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @param {{
 *   text?: string,
 *   context?: import('vscode').ExtensionContext | null,
 *   applyToEditor?: boolean,
 *   writeToDisk?: boolean,
 *   persistIndex?: boolean
 * }} [options]
 * @returns {Promise<{
 *   text: string,
 *   changed: boolean,
 *   fileId: number,
 *   fileEntityId: string,
 *   mode: string,
 *   indexedPath: string | null,
 *   appliedToEditor: boolean,
 *   wroteToDisk: boolean,
 *   indexUpdated: boolean
 * }>}
 */
async function reconcileUpdate(kbRootUri, noteUri, options = {}) {
	let text =
		options.text != null
			? String(options.text)
			: await readNoteTextPreferOpen(noteUri);
	const original = String(text || '').replace(/\r\n/g, '\n');
	if (await isSharedProjectNote(kbRootUri, noteUri)) {
		const claimed = parseFileEntityFromLines(original.split('\n'));
		const claimedFileId =
			claimed && Number.isFinite(claimed.fileNum) ? claimed.fileNum : null;
		const ownership = await resolveFileIdOwnership(kbRootUri, noteUri, claimedFileId);
		let indexUpdated = false;
		if (options.persistIndex !== false) {
			await persistReconcileUpdate(
				kbRootUri,
				noteUri,
				original,
				ownership.fileId,
				MODE_EXISTING,
				options.context
			);
			indexUpdated = true;
		}
		return {
			text: original,
			changed: false,
			fileId: ownership.fileId,
			fileEntityId: ownership.fileEntityId,
			mode: ownership.mode,
			indexedPath: ownership.indexedPath,
			appliedToEditor: false,
			wroteToDisk: false,
			indexUpdated
		};
	}
	let lines = original.split('\n');

	const claimed = parseFileEntityFromLines(lines);
	const claimedFileId =
		claimed && Number.isFinite(claimed.fileNum) ? claimed.fileNum : null;

	const ownership = await resolveFileIdOwnership(kbRootUri, noteUri, claimedFileId);
	// Prefer the note's human title (`filename:` header) so the rebuilt header/h0 keep the
	// user's spelling and casing. The on-disk file name is only a slugified fallback.
	const filenameStem = resolveFilenameStem(lines, { noteUri });
	const reset =
		ownership.mode === MODE_RECLAIM ||
		ownership.mode === MODE_FIRST_INSERT ||
		ownership.mode === MODE_CONFLICT_NEW_ID;

	lines = rebuildCanonicalFileLevelBlock(lines, {
		fileEntityId: ownership.fileEntityId,
		filename: filenameStem,
		noteFsPath: noteUri.fsPath
	});
	const identities = rewriteHeadingIdentities(lines, ownership.fileEntityId, {
		freshNumbers: reset
	});
	lines = writeHeadingsCountLine(identities.lines, identities.nonH0Count);

	const nextText = lines.join('\n');
	const changed = nextText !== original;

	let appliedToEditor = false;
	if (options.applyToEditor !== false && changed) {
		appliedToEditor = await applyReconciledTextToOpenNote(noteUri, nextText, {
			includeDirty: true
		});
	}

	let wroteToDisk = false;
	if (options.writeToDisk === true && changed) {
		const key = noteUri.toString();
		const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key && !d.isClosed);
		if (doc && appliedToEditor) {
			await doc.save();
		} else {
			await writeTextFile(noteUri, nextText);
		}
		wroteToDisk = true;
	}

	let indexUpdated = false;
	if (options.persistIndex !== false) {
		await persistReconcileUpdate(
			kbRootUri,
			noteUri,
			nextText,
			ownership.fileId,
			ownership.mode,
			options.context
		);
		indexUpdated = true;
	}

	return {
		text: nextText,
		changed,
		fileId: ownership.fileId,
		fileEntityId: ownership.fileEntityId,
		mode: ownership.mode,
		indexedPath: ownership.indexedPath,
		appliedToEditor,
		wroteToDisk,
		indexUpdated
	};
}

module.exports = {
	MODE_EXISTING,
	MODE_RECLAIM,
	MODE_FIRST_INSERT,
	MODE_CONFLICT_NEW_ID,
	reconcileUpdate,
	resolveFileIdOwnership
};
