'use strict';

const vscode = require('vscode');
const { DRAFTS_KEY } = require('../shared/constants');
const { ensureDripIndexSkeleton, getDraftsDripDirectoryUri } = require('./initializeDripIndex');

const DRAFT_FILE_SUFFIX = '.json';
const MAX_DRAFTS = 20;

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

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown> | null}
 */
function normalizeDraftRecord(raw) {
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const id = String(raw.id || '').trim();
	if (!id) {
		return null;
	}
	return {
		id,
		title: String(raw.title || 'Untitled Draft').trim(),
		priority: String(raw.priority || 'Medium'),
		headings: String(raw.headings || ''),
		metadata: String(raw.metadata || ''),
		content: String(raw.content || ''),
		metadataFilename: String(raw.metadataFilename || '').trim(),
		updatedAt: String(raw.updatedAt || new Date().toISOString()),
		status: String(raw.status || 'draft')
	};
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function loadDraftsFromDripIndex(kbRootUri) {
	await ensureDripIndexSkeleton(kbRootUri);
	const draftsDir = getDraftsDripDirectoryUri(kbRootUri);
	let entries = [];
	try {
		entries = await vscode.workspace.fs.readDirectory(draftsDir);
	} catch {
		return [];
	}

	/** @type {Record<string, unknown>[]} */
	const drafts = [];
	for (const [name, kind] of entries) {
		if (kind !== vscode.FileType.File || !name.toLowerCase().endsWith(DRAFT_FILE_SUFFIX)) {
			continue;
		}
		const fileUri = vscode.Uri.joinPath(draftsDir, name);
		try {
			const buf = await vscode.workspace.fs.readFile(fileUri);
			const parsed = JSON.parse(Buffer.from(buf).toString('utf8'));
			const draft =
				parsed && parsed.format === 'drip-draft'
					? normalizeDraftRecord(parsed)
					: normalizeDraftRecord(parsed);
			if (draft) {
				drafts.push(draft);
			}
		} catch {
			// skip invalid draft files
		}
	}

	drafts.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
	return drafts.slice(0, MAX_DRAFTS);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {Record<string, unknown>} draft
 */
async function saveDraftToDripIndex(kbRootUri, draft) {
	await ensureDripIndexSkeleton(kbRootUri);
	const normalized = normalizeDraftRecord(draft);
	if (!normalized) {
		throw new Error('Invalid draft payload.');
	}

	const draftsDir = getDraftsDripDirectoryUri(kbRootUri);
	const fileUri = vscode.Uri.joinPath(draftsDir, `${normalized.id}${DRAFT_FILE_SUFFIX}`);
	const envelope = {
		format: 'drip-draft',
		version: 1,
		...normalized
	};
	await vscode.workspace.fs.writeFile(
		fileUri,
		Buffer.from(JSON.stringify(envelope, null, 2), 'utf8')
	);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} draftId
 */
async function deleteDraftFromDripIndex(kbRootUri, draftId) {
	const id = String(draftId || '').trim();
	if (!id) {
		return;
	}
	const fileUri = vscode.Uri.joinPath(
		getDraftsDripDirectoryUri(kbRootUri),
		`${id}${DRAFT_FILE_SUFFIX}`
	);
	try {
		await vscode.workspace.fs.delete(fileUri, { useTrash: false });
	} catch {
		// missing file is fine
	}
}

/**
 * One-time migration from extension globalState drafts into `drafts.drip/`.
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').Uri} kbRootUri
 */
async function migrateGlobalDraftsToDripIndex(context, kbRootUri) {
	const globalDrafts = context.globalState.get(DRAFTS_KEY, []);
	if (!Array.isArray(globalDrafts) || !globalDrafts.length) {
		return;
	}

	const existing = await loadDraftsFromDripIndex(kbRootUri);
	if (existing.length) {
		return;
	}

	for (const draft of globalDrafts) {
		const normalized = normalizeDraftRecord(draft);
		if (!normalized) {
			continue;
		}
		await saveDraftToDripIndex(kbRootUri, normalized);
	}
	await context.globalState.update(DRAFTS_KEY, []);
}

module.exports = {
	deleteDraftFromDripIndex,
	loadDraftsFromDripIndex,
	migrateGlobalDraftsToDripIndex,
	saveDraftToDripIndex
};
