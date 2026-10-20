'use strict';

/**
 * Storage placement ranking from `index.drip` embeddings (no full-KB file walk).
 * Embeddings are always used for ranking.
 *
 * - Top folders → folder vec search (exact sqlite-vec)
 * - Inside a folder → child folders + notes ranked by heading embeddings under that path
 * - Deep AI → merge folder + heading hits
 *
 * Returns `null` on empty/failure so callers keep token-overlap / legacy paths.
 */

const path = require('path');
const vscode = require('vscode');
const { searchFoldersExact } = require('../indexing/embeddings/folderEmbeddingSearch');
const { searchHeadingsByEmbedding } = require('../indexing/embeddings/headingEmbeddingSearch');
const {
	normalizeFolderPath,
	parentFolderPathOfNote
} = require('../indexing/embeddings/folderEmbeddingText');
const { readTextFile, toRelativePath, normalizeCorpusOptions, isPathVisibleForCorpus } = require('../indexing/kbFilesystem');

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {string} folderPathOrRel
 * @param {{ corpus?: string, respectDripignore?: boolean, customCorpusPaths?: unknown }} corpusOpts
 */
async function filterRelVisible(kbRoot, folderPathOrRel, corpusOpts) {
	const rel = String(folderPathOrRel || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	if (!rel || rel === '.') return true;
	return isPathVisibleForCorpus(kbRoot, rel, corpusOpts);
}

/**
 * @param {{ title?: string, headings?: string, content?: string }} noteInput
 */
function noteQueryText(noteInput) {
	return [noteInput && noteInput.title, noteInput && noteInput.headings, noteInput && noteInput.content]
		.map(x => String(x || '').trim())
		.filter(Boolean)
		.join('\n')
		.trim();
}

/**
 * @param {string} parentFolder normalized
 * @param {string} childFolder normalized
 */
function isDirectChildFolder(parentFolder, childFolder) {
	const parent = normalizeFolderPath(parentFolder);
	const child = normalizeFolderPath(childFolder);
	if (child === parent) return false;
	if (parent === '.') {
		return !child.includes('/');
	}
	if (!child.startsWith(parent + '/')) return false;
	const rest = child.slice(parent.length + 1);
	return rest.length > 0 && !rest.includes('/');
}

/**
 * @param {string} folderPath normalized
 * @param {string} noteRelPath
 */
function noteIsDirectlyInFolder(folderPath, noteRelPath) {
	return parentFolderPathOfNote(noteRelPath) === normalizeFolderPath(folderPath);
}

/**
 * Lazy hydrate placement fields for a shortlist of files (read only those notes).
 * @param {import('vscode').Uri} kbRoot
 * @param {string} fileUriStr
 * @param {{ title?: string, headings?: string, content?: string }} noteInput
 */
async function hydrateFilePlacementFields(kbRoot, fileUriStr, noteInput) {
	const {
		extractHeadingPathsFromDripFile,
		bestHeadingPathForNote,
		buildHeadingTreeFromBody,
		splitFileHeaderAndBody
	} = require('../document/dripNoteKbOps.js');

	const uri = vscode.Uri.parse(fileUriStr);
	let text = '';
	try {
		text = await readTextFile(uri);
	} catch {
		return {
			headingPaths: [],
			suggestedHeadingPath: '',
			headingTree: []
		};
	}
	const headingPaths = extractHeadingPathsFromDripFile(text, { fileFsPath: uri.fsPath });
	const suggestedHeadingPath = bestHeadingPathForNote(
		{
			title: (noteInput && noteInput.title) || '',
			headings: (noteInput && noteInput.headings) || '',
			content: (noteInput && noteInput.content) || ''
		},
		headingPaths
	);
	const headingTree = buildHeadingTreeFromBody(splitFileHeaderAndBody(text).body, {
		atxMarkdown: /\.md$/i.test(uri.fsPath)
	});
	return { headingPaths, suggestedHeadingPath, headingTree };
}

/**
 * Top folder suggestions from folder embeddings.
 * @param {import('vscode').Uri} kbRoot
 * @param {{ title?: string, headings?: string, content?: string }} noteInput
 * @param {number} limit
 * @param {{ embeddingModelId?: string, corpus?: string, respectDripignore?: boolean, customCorpusPaths?: unknown }} [options]
 * @returns {Promise<Array<{ uri: import('vscode').Uri, label: string, score: string, action: string }> | null>}
 */
async function rankFoldersFromIndex(kbRoot, noteInput, limit, options = {}) {
	const q = noteQueryText(noteInput);
	if (!q) return null;
	const corpusOpts = normalizeCorpusOptions(options);
	if (corpusOpts.corpus === 'custom' && !corpusOpts.customCorpusPaths.length) {
		return [];
	}
	try {
		const hits = await searchFoldersExact(kbRoot, q, {
			limit: Math.max(limit * 12, 40),
			modelId: options.embeddingModelId
		});
		if (!hits.length) return null;
		/** @type {Array<{ uri: import('vscode').Uri, label: string, score: string, action: string }>} */
		const out = [];
		for (const h of hits) {
			const folderPath = h.folderPath === '.' ? '' : String(h.folderPath || '');
			if (!(await filterRelVisible(kbRoot, folderPath || '.', corpusOpts))) continue;
			out.push({
				uri: vscode.Uri.parse(h.uri),
				label: h.folderPath === '.' ? '(root)' : h.folderPath,
				score: Number(h.score).toFixed(2),
				action: 'folder'
			});
			if (out.length >= limit) break;
		}
		return out.length ? out : null;
	} catch (err) {
		console.error('[DRIP] storage folder index rank failed', err);
		return null;
	}
}

/**
 * Child folders + notes under `folderUri`, ranked from index embeddings.
 * @param {import('vscode').Uri} kbRoot
 * @param {import('vscode').Uri} folderUri
 * @param {{ title?: string, headings?: string, content?: string }} noteInput
 * @param {number} limit
 * @param {{ embeddingModelId?: string, corpus?: string, respectDripignore?: boolean, customCorpusPaths?: unknown }} [options]
 * @returns {Promise<Array<Record<string, unknown>> | null>}
 */
async function rankChildrenFromIndex(kbRoot, folderUri, noteInput, limit, options = {}) {
	const q = noteQueryText(noteInput);
	if (!q) return null;
	const corpusOpts = normalizeCorpusOptions(options);
	if (corpusOpts.corpus === 'custom' && !corpusOpts.customCorpusPaths.length) {
		return [];
	}

	const folderRel = toRelativePath(kbRoot, folderUri).replace(/\\/g, '/');
	const folderPath = normalizeFolderPath(folderRel && folderRel !== '.' ? folderRel : '.');

	try {
		const [folderHits, headingResult] = await Promise.all([
			searchFoldersExact(kbRoot, q, {
				limit: Math.max(limit * 16, 48),
				modelId: options.embeddingModelId
			}),
			searchHeadingsByEmbedding(kbRoot, q, {
				limit: Math.max(limit * 20, 80),
				modelId: options.embeddingModelId
			})
		]);

		/** @type {Array<{ kind: string, uri: string, label: string, scoreValue: number, bestTitle?: string }>} */
		const mixed = [];

		for (const h of folderHits) {
			if (!isDirectChildFolder(folderPath, h.folderPath)) continue;
			if (!(await filterRelVisible(kbRoot, h.folderPath, corpusOpts))) continue;
			mixed.push({
				kind: 'folder',
				uri: h.uri,
				label: h.folderName === '.' ? '(root)' : h.folderName,
				scoreValue: Number(h.score) || 0
			});
		}

		/** @type {Map<string, { uri: string, label: string, scoreValue: number, title: string }>} */
		const byFile = new Map();
		for (const hit of headingResult.hits || []) {
			if (!noteIsDirectlyInFolder(folderPath, hit.relPath)) continue;
			if (!(await filterRelVisible(kbRoot, hit.relPath, corpusOpts))) continue;
			const prev = byFile.get(hit.relPath);
			const score = Number(hit.score) || 0;
			if (prev && prev.scoreValue >= score) continue;
			byFile.set(hit.relPath, {
				uri: hit.uri,
				label: path.posix.basename(hit.relPath),
				scoreValue: score,
				title: hit.title || ''
			});
		}
		for (const [, row] of byFile) {
			mixed.push({
				kind: 'file',
				uri: row.uri,
				label: row.label,
				scoreValue: row.scoreValue,
				bestTitle: row.title
			});
		}

		if (!mixed.length) return null;

		mixed.sort((a, b) => b.scoreValue - a.scoreValue);
		const top = mixed.slice(0, limit);
		/** @type {Array<Record<string, unknown>>} */
		const out = [];
		for (const c of top) {
			if (c.kind === 'folder') {
				out.push({
					type: 'folder',
					uri: c.uri,
					label: c.label,
					score: c.scoreValue.toFixed(2)
				});
				continue;
			}
			const hydrated = await hydrateFilePlacementFields(kbRoot, c.uri, noteInput);
			out.push({
				type: 'file',
				uri: c.uri,
				label: c.label,
				score: c.scoreValue.toFixed(2),
				headingPaths: hydrated.headingPaths,
				suggestedHeadingPath:
					hydrated.suggestedHeadingPath || (c.bestTitle ? String(c.bestTitle) : ''),
				headingTree: hydrated.headingTree
			});
		}
		return out;
	} catch (err) {
		console.error('[DRIP] storage children index rank failed', err);
		return null;
	}
}

/**
 * Deep AI suggestions from folder + heading embeddings (no tree walk).
 * @param {import('vscode').Uri} kbRoot
 * @param {{ title?: string, headings?: string, content?: string }} noteInput
 * @param {number} limit
 * @param {{ embeddingModelId?: string }} [options]
 * @returns {Promise<Array<Record<string, unknown>> | null>}
 */
async function rankDeepFromIndex(kbRoot, noteInput, limit, options = {}) {
	const q = noteQueryText(noteInput);
	if (!q) return null;

	try {
		const fetchN = Math.max(limit * 8, 24);
		const [folderHits, headingResult] = await Promise.all([
			searchFoldersExact(kbRoot, q, {
				limit: fetchN,
				modelId: options.embeddingModelId
			}),
			searchHeadingsByEmbedding(kbRoot, q, {
				limit: fetchN,
				modelId: options.embeddingModelId
			})
		]);

		/** @type {Array<Record<string, unknown> & { scoreValue: number }>} */
		const pool = [];

		for (const h of folderHits) {
			pool.push({
				targetType: 'folder',
				scoreValue: Number(h.score) || 0,
				folderUri: h.uri,
				label: h.folderName === '.' ? '(root)' : h.folderName,
				displayPath: h.folderPath === '.' ? '(root)' : h.folderPath
			});
		}

		/** @type {Map<string, { scoreValue: number, hit: any }>} */
		const bestFile = new Map();
		for (const hit of headingResult.hits || []) {
			const score = Number(hit.score) || 0;
			const prev = bestFile.get(hit.relPath);
			if (prev && prev.scoreValue >= score) continue;
			bestFile.set(hit.relPath, { scoreValue: score, hit });
		}

		for (const [relPath, { scoreValue, hit }] of bestFile) {
			const parentPath = parentFolderPathOfNote(relPath);
			const parentUri =
				parentPath === '.'
					? kbRoot
					: vscode.Uri.joinPath(kbRoot, ...parentPath.split('/').filter(Boolean));
			pool.push({
				targetType: 'file',
				scoreValue,
				fileUri: hit.uri,
				label: path.posix.basename(relPath),
				headingPath: hit.title || '',
				headingPaths: hit.title ? [hit.title] : [],
				headingTree: [],
				displayPath: relPath,
				parentFolderUri: parentUri.toString(),
				_needsHydrate: true
			});
		}

		if (!pool.length) return null;

		pool.sort((a, b) => b.scoreValue - a.scoreValue);
		const top = pool.slice(0, limit);

		for (const entry of top) {
			if (entry.targetType === 'file' && entry._needsHydrate) {
				const hydrated = await hydrateFilePlacementFields(
					kbRoot,
					String(entry.fileUri),
					noteInput
				);
				entry.headingPaths = hydrated.headingPaths.length
					? hydrated.headingPaths
					: entry.headingPaths;
				entry.headingPath = hydrated.suggestedHeadingPath || entry.headingPath || '';
				entry.headingTree = hydrated.headingTree;
				delete entry._needsHydrate;
			}
		}

		return top;
	} catch (err) {
		console.error('[DRIP] storage deep index rank failed', err);
		return null;
	}
}

module.exports = {
	noteQueryText,
	rankFoldersFromIndex,
	rankChildrenFromIndex,
	rankDeepFromIndex
};
