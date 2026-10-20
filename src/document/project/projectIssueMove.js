'use strict';

/**
 * Project-scoped issue movement — the backend for the RHS "move issue" mode.
 *
 * Two jobs, kept together because they share the same project target model:
 *  1. Browse the project's destinations (project inbox → features → files/folders → issues),
 *     optionally ranked against the issue being moved using the same stored embeddings the
 *     RHS Storage suggestions use (heading vectors for issues, folder vectors for features).
 *  2. Perform the move (`moveIssueBlock`) once the user confirms a destination.
 *
 * The RHS Storage webview itself is untouched — this module only supplies data/moves.
 */

const vscode = require('vscode');
const path = require('path');
const { listProjectChildrenFromIndex } = require('../../indexing/projectViewQuery');
const { moveIssueBlock } = require('./projectIssuesMailbox');
const { collectSelfAndDescendants } = require('./issueParentLink');
const { normalizeIssueEntityId, parseIssueTitleEntityId, isFeatureInboxFileName } = require('./projectStructureRules');
const { fileNameMatchesKbNote } = require('../model/dripNoteFileTypes.js');
const { buildHeadingTreeFromBody, splitFileHeaderAndBody, readTextFile } = require('../dripNoteKbOps.js');
const { openDripIndexDb } = require('../../indexing/dripIndexDb');
const { encodeHeadingEmbeddingText } = require('../../indexing/embeddings/headingEmbeddingEncode');
const {
	getEmbeddingMeta,
	searchHeadingEmbeddingsExact
} = require('../../indexing/embeddings/headingEmbeddingStore');
const {
	loadCardsForEmbeddingIds,
	distanceToScore,
	computeWordScore
} = require('../../indexing/embeddings/headingEmbeddingSearch');
const { searchFolderEmbeddingsExact } = require('../../indexing/embeddings/folderEmbeddingStore');

/**
 * @param {string} p
 * @returns {string} slash-normalised, no trailing slash
 */
function normPath(p) {
	return String(p || '')
		.replace(/\\/g, '/')
		.replace(/\/+$/, '');
}

/**
 * Rank the project's features + issues against `query` using the stored embeddings,
 * with a word-score fallback. Returns score maps keyed by issue key and feature key.
 * @param {import('vscode').Uri} kbRoot
 * @param {any[]} features
 * @param {any[]} visibleIssues already excluding the moving issue + descendants
 * @param {string} query
 * @returns {Promise<{ issueScore: Map<string, number>, featureScore: Map<string, number> }>}
 */
async function rankProjectMoveTargets(kbRoot, features, visibleIssues, query) {
	const issueScore = new Map(); // issueKey (normalised) -> score
	const featureScore = new Map(); // folderPrefix|path -> score

	if (query) {
		try {
			let modelId = '';
			{
				const h = await openDripIndexDb(kbRoot);
				try {
					modelId = getEmbeddingMeta(h.db).model;
				} finally {
					h.close();
				}
			}
			const vector = await encodeHeadingEmbeddingText(query, { modelId });

			const handle = await openDripIndexDb(kbRoot);
			try {
				const db = handle.db;
				const issueByFileHeading = new Map();
				for (const i of visibleIssues) {
					issueByFileHeading.set(`${i.fileId}:${i.headingId}`, i);
				}
				const knn = searchHeadingEmbeddingsExact(db, vector, 200);
				const cards = loadCardsForEmbeddingIds(
					db,
					knn.map(k => k.embedding_id),
					kbRoot
				);
				for (const k of knn) {
					const card = cards.get(Number(k.embedding_id));
					if (!card) continue;
					const it = issueByFileHeading.get(
						`${Number(card.file_id)}:${Number(card.heading_id)}`
					);
					if (!it) continue;
					const s = distanceToScore(k.distance);
					const key = normalizeIssueEntityId(it.issueKey);
					if (key && (!issueScore.has(key) || s > issueScore.get(key))) {
						issueScore.set(key, s);
					}
				}

				const featureByFolder = new Map();
				for (const f of features) {
					if (f.folderPrefix) featureByFolder.set(normPath(f.folderPrefix), f);
				}
				for (const row of searchFolderEmbeddingsExact(db, vector, 100)) {
					const f = featureByFolder.get(normPath(row.folder_path || ''));
					if (!f) continue;
					const s = distanceToScore(row.distance);
					const key = f.folderPrefix || f.path;
					if (!featureScore.has(key) || s > featureScore.get(key)) featureScore.set(key, s);
				}
			} finally {
				handle.close();
			}
		} catch (err) {
			console.warn('[DRIP] project move embedding ranking failed; using word scores', err && err.message);
		}
	}

	const wordScore = title => (query ? computeWordScore({ title }, query) : 0);
	for (const i of visibleIssues) {
		const key = normalizeIssueEntityId(i.issueKey);
		if (key && !issueScore.has(key)) issueScore.set(key, wordScore(i.title));
	}
	for (const f of features) {
		const key = f.folderPrefix || f.path;
		if (!featureScore.has(key)) featureScore.set(key, wordScore(f.title));
	}
	return { issueScore, featureScore };
}

/** List folders + KB note files directly inside a folder (feature folder or a subfolder). */
async function readFeatureDir(folderUri) {
	const entries = await vscode.workspace.fs.readDirectory(folderUri);
	const folders = [];
	const files = [];
	for (const [name, type] of entries) {
		if (type === vscode.FileType.Directory) {
			if (name === '.img') continue;
			folders.push({ name, uri: vscode.Uri.joinPath(folderUri, name).toString() });
		} else if (type === vscode.FileType.File && fileNameMatchesKbNote(name)) {
			// Picking the feature directly routes to its `_inbox` mailbox, so the mailbox note
			// and the folder's `_Name.f.d.txt` / `_Name.f.d.md` index note are redundant here — hide them.
			if (isFeatureInboxFileName(name)) continue;
			if (/^_.+\.f\.d\.(txt|md)$/i.test(name)) continue;
			files.push({ name, uri: vscode.Uri.joinPath(folderUri, name).toString() });
		}
	}
	folders.sort((a, b) => a.name.localeCompare(b.name));
	files.sort((a, b) => a.name.localeCompare(b.name));
	return { folders, files };
}

/**
 * Build the full heading tree of a note (persistent `# .…` + non-persistent `# …` headings),
 * annotated with move metadata: which nodes are issue headings, their score, and which are hidden
 * (the moving issue or its descendants).
 * @param {import('vscode').Uri} fileUri
 * @param {Set<string>} forbidden issue keys to hide
 * @param {Map<string, number>} issueScore issue key → similarity score
 */
async function buildMoveHeadingTree(fileUri, forbidden, issueScore) {
	const text = await readTextFile(fileUri);
	const { body } = splitFileHeaderAndBody(text);
	const isMd = path.basename(fileUri.fsPath).toLowerCase().endsWith('.md');
	const tree = buildHeadingTreeFromBody(body, { atxMarkdown: isMd });
	return annotateHeadingNodes(tree, forbidden, issueScore);
}

function annotateHeadingNodes(nodes, forbidden, issueScore) {
	return (nodes || []).map(n => {
		const title = String(n.title || '');
		const parsed = parseIssueTitleEntityId(title);
		const issueKey = parsed ? normalizeIssueEntityId(parsed.id) : null;
		const isIssue = !!issueKey;
		const persistent = title.trim().startsWith('.');
		return {
			title,
			path: String(n.path || ''),
			persistent,
			isIssue,
			issueKey,
			hidden: isIssue && forbidden.has(issueKey),
			score: issueKey ? Number(issueScore.get(issueKey)) || 0 : 0,
			children: annotateHeadingNodes(n.children || [], forbidden, issueScore)
		};
	});
}

/**
 * One node of the move browse. Levels mirror the RHS Storage picker but are project-scoped:
 *   root    → project inbox + features (features highlighted by the UI)
 *   feature → "move into this feature" + its files/folders (or its headings for a file feature)
 *   folder  → sub-folders + files
 *   file    → the note's heading tree (persistent `# .…` + non-persistent `# …`); any heading
 *             (issue or plain) is a valid "move under" target
 *
 * The issue being moved and its descendants are excluded everywhere.
 * @param {import('vscode').Uri} kbRoot
 * @param {string} projectFolderPrefix e.g. `App.p`
 * @param {{ kind: 'root' } | { kind: 'feature', folderPrefix: string | null, path: string, isFolderIndex: boolean } | { kind: 'folder', uri: string } | { kind: 'file', uri: string }} node
 * @param {{ issueId?: string, title?: string, rank?: boolean }} [options]
 */
async function listProjectMoveBrowse(kbRoot, projectFolderPrefix, node, options = {}) {
	const { features, issues } = await listProjectChildrenFromIndex(kbRoot, projectFolderPrefix);

	const forbidden = collectSelfAndDescendants(options.issueId || '', issues);
	const visible = issues.filter(i => !forbidden.has(normalizeIssueEntityId(i.issueKey)));

	let issueScore = new Map();
	let featureScore = new Map();
	if (options.rank) {
		const ranked = await rankProjectMoveTargets(
			kbRoot,
			features,
			visible,
			String(options.title || options.issueId || '').trim()
		);
		issueScore = ranked.issueScore;
		featureScore = ranked.featureScore;
	}

	/** Number of issues living directly in a feature (any file under it). */
	const featureIssueCount = f =>
		visible.filter(
			i =>
				i.featurePathPrefix &&
				(i.featurePathPrefix === f.folderPrefix || i.featurePathPrefix === f.path)
		).length;

	if (node.kind === 'root') {
		const inboxCount = visible.filter(i => i.inProjectInbox && !i.parentIssueKey).length;
		const feats = features.map(f => ({
			folderPrefix: f.folderPrefix,
			path: f.path,
			isFolderIndex: f.isFolderIndex,
			title: f.title,
			issueCount: featureIssueCount(f),
			score: Number(featureScore.get(f.folderPrefix || f.path)) || 0
		}));
		feats.sort((a, b) =>
			options.rank
				? b.score - a.score
				: String(a.title).toLowerCase().localeCompare(String(b.title).toLowerCase())
		);
		return { level: 'root', inboxCount, features: feats, projectIssues: visible.filter(i => i.inProjectInbox) };
	}

	if (node.kind === 'inbox-issues') {
		return { level: 'inbox-issues', issues: visible.filter(i => i.inProjectInbox) };
	}

	if (node.kind === 'feature') {
		const f =
			features.find(x => x.folderPrefix === node.folderPrefix && x.path === node.path) ||
			features.find(x => x.path === node.path);
		if (!f) throw new Error('Feature not found.');
		const featureMeta = {
			folderPrefix: f.folderPrefix,
			path: f.path,
			isFolderIndex: f.isFolderIndex,
			title: f.title
		};
		if (f.folderPrefix) {
			const folderUri = vscode.Uri.joinPath(
				kbRoot,
				...f.folderPrefix.replace(/\/+$/, '').split('/').filter(Boolean)
			);
			const { folders, files } = await readFeatureDir(folderUri);
			return { level: 'feature', isFolder: true, feature: featureMeta, folders, files };
		}
		// Standalone feature file: show its full heading tree (persistent + non-persistent).
		const fileUri = vscode.Uri.joinPath(kbRoot, ...String(f.path).split('/').filter(Boolean));
		const headings = await buildMoveHeadingTree(fileUri, forbidden, issueScore);
		return {
			level: 'feature',
			isFolder: false,
			feature: featureMeta,
			filePath: normPath(f.path),
			fileName: path.basename(fileUri.fsPath),
			headings
		};
	}

	if (node.kind === 'folder') {
		const folderUri = vscode.Uri.parse(node.uri);
		const { folders, files } = await readFeatureDir(folderUri);
		return { level: 'folder', folders, files };
	}

	if (node.kind === 'file') {
		const fileUri = vscode.Uri.parse(node.uri);
		const rel = normPath(path.relative(kbRoot.fsPath, fileUri.fsPath));
		const headings = await buildMoveHeadingTree(fileUri, forbidden, issueScore);
		return { level: 'file', filePath: rel, fileName: path.basename(fileUri.fsPath), headings };
	}

	throw new Error('Unknown browse node.');
}

/**
 * Move an issue to a destination the user picked in the RHS move mode.
 * @param {import('vscode').Uri} kbRoot
 * @param {string} projectFolderPrefix
 * @param {string} issueId e.g. `i-3`
 * @param {{ kind: 'inbox' } | { kind: 'feature', folderPrefix: string | null, path: string, isFolderIndex: boolean } | { kind: 'issue', issueKey: string, position?: 'before' | 'after' | 'under' } | { kind: 'heading', headingPath: string, position?: 'before' | 'after' | 'under', filePath: string } | { kind: 'file', position: 'top' | 'bottom', filePath: string }} target
 * @param {{ context?: import('vscode').ExtensionContext, removeParent?: boolean }} [options]
 * @returns {Promise<{ issueId: string, mailboxUri: import('vscode').Uri }>}
 */
async function moveProjectIssue(kbRoot, projectFolderPrefix, issueId, target, options = {}) {
	const folderUri = vscode.Uri.joinPath(
		kbRoot,
		...String(projectFolderPrefix).replace(/\/+$/, '').split('/').filter(Boolean)
	);

	const { issues } = await listProjectChildrenFromIndex(kbRoot, projectFolderPrefix);
	const issue = issues.find(i => String(i.issueKey || '').toLowerCase() === issueId.toLowerCase());
	if (!issue) throw new Error(`Issue ${issueId} not found.`);
	const sourceUri = vscode.Uri.joinPath(
		kbRoot,
		...String(issue.path || '').split('/').filter(Boolean)
	);

	/** @type {{ kind: 'feature', featureUri: import('vscode').Uri } | { kind: 'inbox' } | { kind: 'issue', issueId: string, fileUri: import('vscode').Uri } | { kind: 'heading', headingPath: string, fileUri: import('vscode').Uri } | { kind: 'file', position: 'top' | 'bottom', fileUri: import('vscode').Uri }} */
	let spec;
	if (target.kind === 'inbox') {
		spec = { kind: 'inbox' };
	} else if (target.kind === 'file') {
		const rel = String(target.filePath || '').replace(/\/+$/, '');
		if (!rel) throw new Error('No file selected.');
		spec = {
			kind: 'file',
			position: target.position === 'top' ? 'top' : 'bottom',
			fileUri: vscode.Uri.joinPath(kbRoot, ...rel.split('/').filter(Boolean))
		};
	} else if (target.kind === 'feature') {
		const rel = target.isFolderIndex
			? String(target.folderPrefix || '').replace(/\/+$/, '')
			: String(target.path || '');
		spec = {
			kind: 'feature',
			featureUri: vscode.Uri.joinPath(kbRoot, ...rel.split('/').filter(Boolean))
		};
	} else if (target.kind === 'heading') {
		const headingPath = String(target.headingPath || '').trim();
		if (!headingPath) throw new Error('No heading selected.');
		const rel = String(target.filePath || '').replace(/\/+$/, '');
		if (!rel) throw new Error('No file selected.');
		spec = {
			kind: 'heading',
			headingPath,
			position: target.position === 'before' || target.position === 'after' ? target.position : 'under',
			fileUri: vscode.Uri.joinPath(kbRoot, ...rel.split('/').filter(Boolean))
		};
	} else {
		const parentId = normalizeIssueEntityId(target.issueKey);
		if (!parentId) throw new Error(`Invalid parent issue ${target.issueKey}.`);
		const parent = issues.find(i => String(i.issueKey || '').toLowerCase() === parentId);
		if (!parent) throw new Error(`Parent issue ${parentId} not found.`);
		const forbidden = collectSelfAndDescendants(issueId, issues);
		if (forbidden.has(parentId)) {
			throw new Error(`Cannot move ${issueId} under itself or its sub-issues.`);
		}
		spec = {
			kind: 'issue',
			issueId: parentId,
			position: target.position === 'before' || target.position === 'after' ? target.position : 'under',
			fileUri: vscode.Uri.joinPath(kbRoot, ...String(parent.path || '').split('/').filter(Boolean))
		};
	}

	return moveIssueBlock(kbRoot, sourceUri, folderUri, spec, issueId, {
		context: options.context,
		removeParent: options.removeParent === true
	});
}

module.exports = {
	rankProjectMoveTargets,
	listProjectMoveBrowse,
	moveProjectIssue
};
