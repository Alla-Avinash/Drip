'use strict';

const vscode = require('vscode');
const path = require('path');
const { DRAFTS_KEY, KB_ROOT_KEY, RETRIEVER_UI_STATE_KEY } = require('../shared/constants');
const {
	buildNoteFileName,
	fileNameMatchesKbNote,
	getExtensionFromFileName,
	getKbNoteExtensions,
	stemFromNotePath,
	stripKbNoteExtension
} = require('../document/model/noteFileTypes');
const {
	buildAppendedNote,
	buildHeadingTreeFromBody,
	buildNewNoteFile,
	chooseTargetFolder,
	getKnowledgeBaseTreeChildren,
	extractHeadingPathsFromDripFile,
	bestHeadingPathForNote,
	isPathIgnored,
	rankDeepStorageCandidates,
	rankFolderCandidates,
	rankSubfoldersAndFilesInFolder,
	readTextFile,
	reorderSiblingHeadingSectionsInBody,
	scanKnowledgeBaseNotes,
	similarityScore,
	splitFileHeaderAndBody,
	writeTextFile
} = require('../document/kbNoteOps');
const { normalizeNoteIdentityFile } = require('../indexing/dripnoteFileIdentity');
const {
	extractFileIdFromHeader,
	updateRefsOnRename,
	removeRefsOnDelete
} = require('../graph/dripnoteReferenceSync');
const { allocateNextEntityNumber, indexNewNoteImmediately } = require('../indexing/dripnoteIndex');
const { updateNoteInDripIndex } = require('../indexing/sync/dripnoteIndexUpdate');
const { removeFileFromDripIndex } = require('../indexing/dripIndexDb');
const { getKbNoteTreeIcon } = require('../views/lhs/knowledgebase/kbTreeIcon');
const { pickAndBindKnowledgeBase } = require('../startup/selectKnowledgeBase');
const {
	loadDraftsFromDripIndex,
	saveDraftToDripIndex,
	deleteDraftFromDripIndex
} = require('../startup/draftsDrip');
const {
	loadRecentsFromDripIndex,
	touchRecentInDripIndex,
	migrateWorkspaceRecentsToDripIndex
} = require('../startup/recentsDrip');
const { getDraftsDripDirectoryUri } = require('../startup/initializeDripIndex');

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {import('vscode').Uri} folderUri
 * @returns {{ label: string, folderUri: string }[]}
 */
function kbPathSegments(kbRoot, folderUri) {
	const relFolder = path.relative(kbRoot.fsPath, folderUri.fsPath).replace(/\\/g, '/');
	const segments = [{ label: '(root)', folderUri: kbRoot.toString() }];
	if (!relFolder || relFolder === '.') {
		return segments;
	}
	let cursor = kbRoot;
	for (const part of relFolder.split('/').filter(Boolean)) {
		cursor = vscode.Uri.joinPath(cursor, part);
		segments.push({ label: part, folderUri: cursor.toString() });
	}
	return segments;
}

class DripState {
	constructor(context) {
		this.context = context;
		/** @type {any[]} */
		this._tagGraphUndo = [];
		/** @type {any[]} */
		this._tagGraphRedo = [];
		this._tagGraphHistoryMax = 100;
		/** @type {any | null} Last-opened snapshot for this graph slot; used before switching graphs. */
		this._tagGraphCheckpoint = null;
		/** @type {any[] | null} */
		this._draftsCache = null;
		/** @type {(() => void) | null} */
		this._draftsRefreshListener = null;
		/** @type {{ uri: string, label: string, relPath: string }[] | null} */
		this._recentsCache = null;
		/** @type {(() => void) | null} */
		this._recentsRefreshListener = null;
	}

	setDraftsRefreshListener(listener) {
		this._draftsRefreshListener = typeof listener === 'function' ? listener : null;
	}

	setRecentsRefreshListener(listener) {
		this._recentsRefreshListener = typeof listener === 'function' ? listener : null;
	}

	_notifyDraftsRefresh() {
		if (this._draftsRefreshListener) {
			this._draftsRefreshListener();
		}
	}

	_notifyRecentsRefresh() {
		if (this._recentsRefreshListener) {
			this._recentsRefreshListener();
		}
	}

	/**
	 * @returns {{ uri: string, label: string, relPath?: string }[]}
	 */
	getRecentFiles() {
		if (this._recentsCache != null) {
			return this._recentsCache;
		}
		return [];
	}

	/**
	 * Reload recents from `.dripindex/recents.drip.json` for the current KB.
	 * @returns {Promise<{ uri: string, label: string, relPath: string }[]>}
	 */
	async refreshRecentsFromStorage() {
		const kbRoot = this.getKnowledgeBaseRoot();
		if (!kbRoot) {
			this._recentsCache = [];
			this._notifyRecentsRefresh();
			return this._recentsCache;
		}
		await migrateWorkspaceRecentsToDripIndex(this.context, kbRoot);
		const rows = await loadRecentsFromDripIndex(kbRoot);
		this._recentsCache = rows.map(row => ({
			relPath: row.relPath,
			label: row.label,
			uri: vscode.Uri.joinPath(kbRoot, ...row.relPath.split('/')).toString()
		}));
		this._notifyRecentsRefresh();
		return this._recentsCache;
	}

	/**
	 * Record a dripnote file as opened or modified. Persists under `.dripindex/recents.drip.json`.
	 * @param {import('vscode').Uri} uri
	 */
	async touchRecentFile(uri) {
		if (!uri || uri.scheme === 'untitled') return;
		const fsPath = String(uri.fsPath || '').toLowerCase();
		if (!fsPath.endsWith('.d.txt') && uri.path && !String(uri.path).toLowerCase().endsWith('.d.txt')) {
			return;
		}
		const kbRoot = this.getKnowledgeBaseRoot();
		if (!kbRoot) return;
		const rows = await touchRecentInDripIndex(kbRoot, uri);
		this._recentsCache = rows.map(row => ({
			relPath: row.relPath,
			label: row.label,
			uri: vscode.Uri.joinPath(kbRoot, ...row.relPath.split('/')).toString()
		}));
		this._notifyRecentsRefresh();
	}

	async refreshDraftsFromStorage() {
		const kbRoot = this.getKnowledgeBaseRoot();
		if (kbRoot) {
			this._draftsCache = await loadDraftsFromDripIndex(kbRoot);
		} else {
			this._draftsCache = this.context.globalState.get(DRAFTS_KEY, []);
		}
		this._notifyDraftsRefresh();
		return this._draftsCache;
	}

	getDrafts() {
		if (this._draftsCache != null) {
			return this._draftsCache;
		}
		return this.context.globalState.get(DRAFTS_KEY, []);
	}

	getDraftById(draftId) {
		return this.getDrafts().find(draft => draft.id === draftId);
	}

	async saveDraft(input) {
		const kbRoot = this.getKnowledgeBaseRoot();
		const drafts = kbRoot ? await loadDraftsFromDripIndex(kbRoot) : this.getDrafts();
		const now = new Date().toISOString();
		const normalized = {
			id: input.id || `draft-${Date.now()}`,
			title: (input.title || 'Untitled Draft').trim(),
			priority: input.priority || 'Medium',
			headings: input.headings || '',
			content: input.content || '',
			metadataFilename: (input.metadataFilename || '').trim(),
			updatedAt: now,
			status: input.status || 'draft'
		};

		const nextDrafts = [normalized, ...drafts.filter(draft => draft.id !== normalized.id)].slice(0, 20);

		if (kbRoot) {
			await saveDraftToDripIndex(kbRoot, normalized);
			const keepIds = new Set(nextDrafts.map(d => String(d.id)));
			const draftsDir = getDraftsDripDirectoryUri(kbRoot);
			try {
				const entries = await vscode.workspace.fs.readDirectory(draftsDir);
				for (const [name, kind] of entries) {
					if (kind !== vscode.FileType.File || !name.toLowerCase().endsWith('.json')) {
						continue;
					}
					const id = name.slice(0, -5);
					if (!keepIds.has(id)) {
						await deleteDraftFromDripIndex(kbRoot, id);
					}
				}
			} catch {
				// drafts dir missing is fine
			}
			this._draftsCache = nextDrafts;
			this._notifyDraftsRefresh();
		} else {
			await this.context.globalState.update(DRAFTS_KEY, nextDrafts);
			this._draftsCache = nextDrafts;
		}

		return normalized;
	}

	async markDraftIngested(draftId) {
		const draft = this.getDraftById(draftId);
		if (!draft) {
			return;
		}

		const kbRoot = this.getKnowledgeBaseRoot();
		if (kbRoot) {
			const remaining = this.getDrafts().filter(d => d.id !== draftId);
			await deleteDraftFromDripIndex(kbRoot, draftId);
			this._draftsCache = remaining;
			this._notifyDraftsRefresh();
			return;
		}

		const remaining = this.getDrafts().filter(d => d.id !== draftId);
		await this.context.globalState.update(DRAFTS_KEY, remaining);
		this._draftsCache = remaining;
	}

	getKnowledgeBaseRoot() {
		const value = this.context.workspaceState.get(KB_ROOT_KEY);
		return value ? vscode.Uri.parse(value) : undefined;
	}

	/**
	 * Retriever / heading scans: persisted KB folder, or a workspace folder when none was pinned.
	 * Prefers the folder that contains the active editor (multi-root), then the first workspace folder.
	 * @returns {{ uri: import('vscode').Uri | undefined, usedWorkspaceFallback: boolean }}
	 */
	getRetrieverKnowledgeBaseRoot() {
		const explicit = this.getKnowledgeBaseRoot();
		if (explicit) {
			return { uri: explicit, usedWorkspaceFallback: false };
		}
		const ed = vscode.window.activeTextEditor;
		if (ed && ed.document && ed.document.uri.scheme === 'file') {
			const wf = vscode.workspace.getWorkspaceFolder(ed.document.uri);
			if (wf && wf.uri && wf.uri.scheme === 'file') {
				return { uri: wf.uri, usedWorkspaceFallback: true };
			}
		}
		const w = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (w && w.scheme === 'file') {
			return { uri: w, usedWorkspaceFallback: true };
		}
		// Single-file window (no folder open): scan the directory that contains the active drip note
		if (ed && ed.document && ed.document.uri.scheme === 'file') {
			const bn = path.basename(ed.document.uri.fsPath);
			if (fileNameMatchesKbNote(bn)) {
				return {
					uri: vscode.Uri.file(path.dirname(ed.document.uri.fsPath)),
					usedWorkspaceFallback: true
				};
			}
		}
		return { uri: undefined, usedWorkspaceFallback: false };
	}

	async pickKnowledgeBaseFolder() {
		return pickAndBindKnowledgeBase(this.context);
	}

	async ensureKnowledgeBaseRoot() {
		return this.getKnowledgeBaseRoot() || this.pickKnowledgeBaseFolder();
	}

	async getSidebarState() {
		const rk = this.getRetrieverKnowledgeBaseRoot();
		return {
			kbRootPath: rk.uri ? rk.uri.fsPath : '',
			drafts: this.getDrafts()
		};
	}

	async getKnowledgeBaseTreeChildren(currentUri) {
		let kbRoot = this.getKnowledgeBaseRoot();
		if (!kbRoot && typeof this.getRetrieverKnowledgeBaseRoot === 'function') {
			const rk = this.getRetrieverKnowledgeBaseRoot();
			kbRoot = rk && rk.uri ? rk.uri : undefined;
		}
		if (!kbRoot) {
			return [];
		}

		const nodes = await getKnowledgeBaseTreeChildren(kbRoot, currentUri);
		return Promise.all(nodes.map(async node => {
			if (node.kind === 'folder') {
				const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
				item.kind = 'folder';
				item.uri = node.uri;
				item.resourceUri = node.uri;
				item.contextValue = 'dripFolder';
				item.iconPath = new vscode.ThemeIcon('folder');
				return item;
			}

			if (node.kind === 'image') {
				const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
				item.kind = 'image';
				item.uri = node.uri;
				item.resourceUri = node.uri;
				item.command = {
					command: 'vscode.open',
					title: 'Open File',
					arguments: [node.uri]
				};
				item.contextValue = 'dripImageFile';
				item.iconPath = new vscode.ThemeIcon('file');
				return item;
			}

			const displayLabel =
				node.label !== '.dripignore' && getExtensionFromFileName(node.label) === '.d.txt'
					? stripKbNoteExtension(node.label)
					: node.label;
			const item = new vscode.TreeItem(displayLabel, vscode.TreeItemCollapsibleState.None);
			item.kind = 'file';
			item.uri = node.uri;
			item.resourceUri = node.uri;
			item.command = {
				command: 'vscode.open',
				title: 'Open File',
				arguments: [node.uri]
			};
			item.contextValue = node.label === '.dripignore' ? 'dripIgnoreFile' : 'dripNoteFile';
			if (node.label !== '.dripignore') {
				item.iconPath = getKbNoteTreeIcon(this.context.extensionUri);
			}
			return item;
		}));
	}

	async previewTargets(noteInput) {
		const kbRoot = await this.ensureKnowledgeBaseRoot();
		if (!kbRoot) {
			return {
				kbRootPath: '',
				topFolders: [],
				suggestedDefault: undefined,
				warning: 'Select a knowledge base folder first.'
			};
		}

		const normalizedNoteInput = {
			...noteInput,
			headings: noteInput?.headings || ''
		};

		const cfg = vscode.workspace.getConfiguration('drip');
		const useEmbeddings = cfg.get('experimentalEmbeddings', false);
		const embeddingModelId = cfg.get('embeddingModel', 'Xenova/all-MiniLM-L6-v2');

		const topFolders = await rankFolderCandidates(kbRoot, normalizedNoteInput, 3, {
			useEmbeddings,
			embeddingModelId
		});

		const suggestedDefault = topFolders[0]
			? {
					targetType: 'folder',
					uri: topFolders[0].uri.toString(),
					fileName: normalizedNoteInput.title || 'new-note'
				}
			: undefined;

		return {
			kbRootPath: kbRoot.fsPath,
			topFolders: topFolders.map(folder => ({
				type: 'folder',
				uri: folder.uri.toString(),
				label: folder.label,
				score: folder.score
			})),
			suggestedDefault,
			warning: ''
		};
	}

	async previewFolderFiles(noteInput, folderUriStr) {
		const kbRoot = await this.ensureKnowledgeBaseRoot();
		if (!kbRoot) {
			throw new Error('No knowledge base folder selected.');
		}

		const folderUri = vscode.Uri.parse(folderUriStr);
		const rel = path.relative(kbRoot.fsPath, folderUri.fsPath);
		if (rel.startsWith('..') || path.isAbsolute(rel)) {
			throw new Error('Folder is outside the knowledge base.');
		}

		const normalizedNoteInput = {
			...noteInput,
			headings: noteInput?.headings || ''
		};

		const relFolder = rel.replace(/\\/g, '/');
		const displayPath = relFolder && relFolder !== '.' ? relFolder : '(root)';
		const cfg = vscode.workspace.getConfiguration('drip');
		const useEmbeddings = cfg.get('experimentalEmbeddings', false);
		const embeddingModelId = cfg.get('embeddingModel', 'Xenova/all-MiniLM-L6-v2');

		const suggestions = await rankSubfoldersAndFilesInFolder(
			kbRoot,
			folderUri,
			normalizedNoteInput,
			3,
			{ useEmbeddings, embeddingModelId }
		);
		const files = suggestions.filter(s => s.type === 'file');
		return {
			suggestions,
			files,
			folderUri: folderUri.toString(),
			displayPath,
			pathSegments: kbPathSegments(kbRoot, folderUri)
		};
	}

	async deepAiSuggestions(noteInput) {
		const kbRoot = await this.ensureKnowledgeBaseRoot();
		if (!kbRoot) {
			return {
				kbRootPath: '',
				paths: [],
				warning: 'Select a knowledge base folder first.'
			};
		}

		const normalizedNoteInput = {
			...noteInput,
			headings: noteInput?.headings || ''
		};

		const cfg = vscode.workspace.getConfiguration('drip');
		const useEmbeddings = cfg.get('experimentalEmbeddings', false);
		const embeddingModelId = cfg.get('embeddingModel', 'Xenova/all-MiniLM-L6-v2');

		const raw = await rankDeepStorageCandidates(kbRoot, normalizedNoteInput, 3, {
			useEmbeddings,
			embeddingModelId
		});

		const paths = raw.map(entry => {
			if (entry.targetType === 'folder') {
				const folderUri = vscode.Uri.parse(entry.folderUri);
				return {
					targetType: 'folder',
					score: entry.scoreValue.toFixed(2),
					uri: entry.folderUri,
					label: entry.label,
					displayPath: entry.displayPath,
					pathSegments: kbPathSegments(kbRoot, folderUri)
				};
			}

			const parentUri = vscode.Uri.parse(entry.parentFolderUri);
			const parentRel = path.relative(kbRoot.fsPath, parentUri.fsPath).replace(/\\/g, '/');
			const parentDisplay = parentRel && parentRel !== '.' ? parentRel : '(root)';

			return {
				targetType: 'file',
				score: entry.scoreValue.toFixed(2),
				uri: entry.fileUri,
				label: entry.label,
				headingPath: entry.headingPath || '',
				headingPaths: entry.headingPaths || [],
				headingTree: entry.headingTree || [],
				displayPath: entry.displayPath,
				parentFolderUri: entry.parentFolderUri,
				parentDisplayPath: parentDisplay,
				pathSegments: kbPathSegments(kbRoot, parentUri)
			};
		});

		return {
			kbRootPath: kbRoot.fsPath,
			paths,
			warning: paths.length ? '' : 'No matches found. Try adding title or headings to your draft.'
		};
	}

	async getFileHeadingMeta(fileUriStr, noteInput) {
		const kbRoot = await this.ensureKnowledgeBaseRoot();
		if (!kbRoot) {
			throw new Error('No knowledge base folder selected.');
		}

		const uri = vscode.Uri.parse(fileUriStr);
		const rel = path.relative(kbRoot.fsPath, uri.fsPath);
		if (rel.startsWith('..') || path.isAbsolute(rel)) {
			throw new Error('File is outside the knowledge base.');
		}

		const text = await readTextFile(uri);
		const headingPaths = extractHeadingPathsFromDripFile(text, { fileFsPath: uri.fsPath });
		const { body } = splitFileHeaderAndBody(text);
		const isMd = path.basename(uri.fsPath).toLowerCase().endsWith('.md');
		const headingTree = buildHeadingTreeFromBody(body, { atxMarkdown: isMd });
		const normalized = {
			title: noteInput?.title || '',
			headings: noteInput?.headings || '',
			content: noteInput?.content || ''
		};
		const suggestedHeadingPath = headingPaths.length
			? bestHeadingPathForNote(normalized, headingPaths)
			: '';

		return {
			uri: uri.toString(),
			label: path.basename(uri.fsPath),
			headingPaths,
			suggestedHeadingPath,
			headingTree
		};
	}

	/**
	 * Reorder sibling `#` sections in a note file (same parent in the heading path tree).
	 * @param {string} fileUriStr
	 * @param {string} parentPath empty for top-level siblings
	 * @param {string[]} orderedChildPaths
	 */
	async reorderHeadingSiblings(fileUriStr, parentPath, orderedChildPaths) {
		const kbRoot = await this.ensureKnowledgeBaseRoot();
		if (!kbRoot) {
			throw new Error('No knowledge base folder selected.');
		}
		const uri = vscode.Uri.parse(fileUriStr);
		const rel = path.relative(kbRoot.fsPath, uri.fsPath);
		if (rel.startsWith('..') || path.isAbsolute(rel)) {
			throw new Error('File is outside the knowledge base.');
		}
		const existingContent = await readTextFile(uri);
		const { headerMeta, body, hasFileMeta } = splitFileHeaderAndBody(existingContent);
		const newBody = reorderSiblingHeadingSectionsInBody(body, parentPath, orderedChildPaths);
		const normalizedBody = newBody.trimEnd();
		const out = hasFileMeta ? `${headerMeta}\n---\n${normalizedBody}\n` : `${normalizedBody}\n`;
		await writeTextFile(uri, out);
	}

	async browseKbList(folderUriStr) {
		const kbRoot = await this.ensureKnowledgeBaseRoot();
		if (!kbRoot) {
			throw new Error('No knowledge base folder selected.');
		}

		const folderUri = folderUriStr ? vscode.Uri.parse(folderUriStr) : kbRoot;
		const relFolder = path.relative(kbRoot.fsPath, folderUri.fsPath);
		if (relFolder.startsWith('..') || path.isAbsolute(relFolder)) {
			throw new Error('Invalid folder.');
		}

		let parentUri = '';
		if (folderUri.fsPath !== kbRoot.fsPath) {
			parentUri = vscode.Uri.file(path.dirname(folderUri.fsPath)).toString();
		}

		const entries = await vscode.workspace.fs.readDirectory(folderUri);
		const folders = [];
		const files = [];

		for (const [name, type] of entries) {
			const child = vscode.Uri.joinPath(folderUri, name);
			const rel = path.relative(kbRoot.fsPath, child.fsPath).replace(/\\/g, '/');

			if (await isPathIgnored(kbRoot, rel)) {
				continue;
			}

			if (type === vscode.FileType.Directory) {
				if (name === '.img') {
					continue;
				}
				folders.push({ name, uri: child.toString(), relativePath: rel });
			} else if (type === vscode.FileType.File && fileNameMatchesKbNote(name)) {
				files.push({ name, uri: child.toString(), relativePath: rel });
			}
		}

		folders.sort((a, b) => a.name.localeCompare(b.name));
		files.sort((a, b) => a.name.localeCompare(b.name));

		const displayPath = relFolder ? relFolder.replace(/\\/g, '/') : '(root)';

		return {
			kbRootPath: kbRoot.fsPath,
			folderUri: folderUri.toString(),
			parentUri,
			displayPath,
			pathSegments: kbPathSegments(kbRoot, folderUri),
			folders,
			files
		};
	}

	async createNoteInFolderFromPicker(folderUriStr, title) {
		const kbRoot = await this.ensureKnowledgeBaseRoot();
		if (!kbRoot) {
			throw new Error('No knowledge base folder selected.');
		}

		const baseUri = await this.resolveTargetFolder(vscode.Uri.parse(folderUriStr));
		const t = String(title || '').trim();
		if (!t) {
			throw new Error('Enter a note title.');
		}

		const fileUri = vscode.Uri.joinPath(baseUri, buildNoteFileName(t));
		const n = await allocateNextEntityNumber(kbRoot);
		await writeTextFile(
			fileUri,
			buildNewNoteFile({
				title: t,
				content: '',
				metadataFilename: t
			}, { fileEntityNumber: n })
		);
		await normalizeNoteIdentityFile(fileUri, { context: this.context });
		try {
			await indexNewNoteImmediately(kbRoot, fileUri, this.context);
		} catch (err) {
			console.error('[DRIP] immediate index after createNoteInFolderFromPicker', err);
		}

		return fileUri.toString();
	}

	async createSubfolderFromPicker(parentUriStr, name) {
		const kbRoot = await this.ensureKnowledgeBaseRoot();
		if (!kbRoot) {
			throw new Error('No knowledge base folder selected.');
		}

		const baseUri = await this.resolveTargetFolder(vscode.Uri.parse(parentUriStr));
		const trimmed = String(name || '').trim();
		if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) {
			throw new Error('Invalid folder name.');
		}

		const folderUri = vscode.Uri.joinPath(baseUri, trimmed);
		let exists = false;
		try {
			await vscode.workspace.fs.stat(folderUri);
			exists = true;
		} catch {
			exists = false;
		}
		if (exists) {
			throw new Error(`"${trimmed}" already exists.`);
		}

		await vscode.workspace.fs.createDirectory(folderUri);
		return folderUri.toString();
	}

	async ingestNote(noteInput, selection) {
		const normalizedNoteInput = {
			...noteInput,
			headings: noteInput?.headings || ''
		};

		const kbRoot = await this.ensureKnowledgeBaseRoot();
		if (!kbRoot) {
			throw new Error('No knowledge base folder selected.');
		}

		const draft = await this.saveDraft(normalizedNoteInput);

		let targetUri;
		let mode;

		// If the user picked an explicit file/folder, follow that.
		if (selection?.targetType === 'file' && selection.uri) {
			mode = 'append';
			targetUri = vscode.Uri.parse(selection.uri);

			const headingPathOverride = selection.headingPath || '';
			const existingContent = await readTextFile(targetUri);
			const fileStem = stemFromNotePath(targetUri.fsPath);
			const ingestExt = getExtensionFromFileName(path.basename(targetUri.fsPath));
			const useDripType1Indent = ingestExt !== '.md';
			await writeTextFile(
				targetUri,
				buildAppendedNote(existingContent, draft, headingPathOverride, {
					fileDisplayStem: fileStem,
					ingestDropRefPath: selection.ingestDropRefPath || '',
					ingestPosition: selection.ingestPosition || '',
					useDripType1Indent
				})
			);
		} else if (selection?.targetType === 'folder' && selection.uri) {
			mode = 'create';
			const targetFolder = vscode.Uri.parse(selection.uri);

			let fileName = String(selection.fileName || '').trim();
			if (!fileName) {
				throw new Error('Please provide a name for the new note file.');
			}
			if (fileNameMatchesKbNote(fileName)) {
				fileName = stripKbNoteExtension(fileName);
			}

			targetUri = vscode.Uri.joinPath(targetFolder, buildNoteFileName(fileName));
			const n = await allocateNextEntityNumber(kbRoot);
			await writeTextFile(targetUri, buildNewNoteFile(draft, { fileEntityNumber: n }));
			await normalizeNoteIdentityFile(targetUri, { context: this.context });
			try {
				await indexNewNoteImmediately(kbRoot, targetUri, this.context);
			} catch (err) {
				console.error('[DRIP] immediate index after composer create', err);
			}
		} else {
			// Backwards compatible path: auto-select best folder/file.
			const targetFolder = await chooseTargetFolder(kbRoot, normalizedNoteInput);
			const noteFiles = await scanKnowledgeBaseNotes(kbRoot);
			const ranked = noteFiles
				.map(file => ({
					file,
					score: similarityScore(normalizedNoteInput, file.searchText)
				}))
				.sort((left, right) => right.score - left.score);

			const bestMatch = ranked[0];
			if (bestMatch && bestMatch.score >= 0.18) {
				mode = 'append';
				targetUri = bestMatch.file.uri;

				const existingContent = await readTextFile(targetUri);
				const paths = extractHeadingPathsFromDripFile(existingContent, { fileFsPath: targetUri.fsPath });
				const headingPath = bestHeadingPathForNote(normalizedNoteInput, paths) || '';
				const fileStem = stemFromNotePath(targetUri.fsPath);
				const ingestExt = getExtensionFromFileName(path.basename(targetUri.fsPath));
				const useDripType1Indent = ingestExt !== '.md';
				await writeTextFile(
					targetUri,
					buildAppendedNote(existingContent, draft, headingPath, {
						fileDisplayStem: fileStem,
						useDripType1Indent
					})
				);
			} else {
				mode = 'create';
				targetUri = vscode.Uri.joinPath(targetFolder, buildNoteFileName(draft.title));
				const n = await allocateNextEntityNumber(kbRoot);
				await writeTextFile(targetUri, buildNewNoteFile(draft, { fileEntityNumber: n }));
				await normalizeNoteIdentityFile(targetUri, { context: this.context });
				try {
					await indexNewNoteImmediately(kbRoot, targetUri, this.context);
				} catch (err) {
					console.error('[DRIP] immediate index after auto-create', err);
				}
			}
		}

		await this.markDraftIngested(draft.id);

		return {
			draft,
			kbRootPath: kbRoot.fsPath,
			targetFolderPath: path.dirname(targetUri.fsPath),
			targetPath: targetUri.fsPath,
			mode
		};
	}

	async createNoteFile(targetUri) {
		const kbRoot = await this.ensureKnowledgeBaseRoot();
		if (!kbRoot) {
			throw new Error('No knowledge base folder selected.');
		}

		const baseUri = await this.resolveTargetFolder(targetUri);
		const title = await vscode.window.showInputBox({
			prompt: 'Enter a note title',
			placeHolder: 'Example: editor architecture'
		});

		if (!title) {
			return undefined;
		}

		const fileUri = vscode.Uri.joinPath(baseUri, buildNoteFileName(title));
		const n = await allocateNextEntityNumber(kbRoot);
		await writeTextFile(
			fileUri,
			buildNewNoteFile({
				title,
				content: '',
				metadataFilename: title
			}, { fileEntityNumber: n })
		);
		await normalizeNoteIdentityFile(fileUri, { context: this.context });
		try {
			await indexNewNoteImmediately(kbRoot, fileUri, this.context);
		} catch (err) {
			console.error('[DRIP] immediate index after createNoteFile', err);
		}

		await vscode.commands.executeCommand('vscode.open', fileUri);
		return fileUri;
	}

	async createMarkdownFile(targetUri) {
		const kbRoot = await this.ensureKnowledgeBaseRoot();
		if (!kbRoot) {
			throw new Error('No knowledge base folder selected.');
		}

		const baseUri = await this.resolveTargetFolder(targetUri);
		const title = await vscode.window.showInputBox({
			prompt: 'Enter a Markdown file title',
			placeHolder: 'Example: architecture notes'
		});

		if (!title) {
			return undefined;
		}

		const fileUri = vscode.Uri.joinPath(baseUri, buildNoteFileName(title, '.md'));
		await writeTextFile(
			fileUri,
			`# ${String(title).trim() || 'Untitled'}\n`
		);

		await vscode.commands.executeCommand('vscode.open', fileUri);
		return fileUri;
	}

	async createFolder(targetUri) {
		const kbRoot = await this.ensureKnowledgeBaseRoot();
		if (!kbRoot) {
			throw new Error('No knowledge base folder selected.');
		}

		const baseUri = await this.resolveTargetFolder(targetUri);
		const name = await vscode.window.showInputBox({
			prompt: 'New folder inside the knowledge base',
			placeHolder: 'Folder name',
			validateInput(value) {
				const v = (value || '').trim();
				if (!v) {
					return 'Enter a folder name.';
				}
				if (v !== path.basename(v) || v.includes('/') || v.includes(path.sep)) {
					return 'Use a single folder name only (no path separators).';
				}
				return undefined;
			}
		});

		if (!name) {
			return undefined;
		}

		const trimmed = name.trim();
		const folderUri = vscode.Uri.joinPath(baseUri, trimmed);

		try {
			await vscode.workspace.fs.stat(folderUri);
			await vscode.window.showErrorMessage(`A file or folder named "${trimmed}" already exists in this location.`);
			return undefined;
		} catch {
			// Path is free.
		}

		await vscode.workspace.fs.createDirectory(folderUri);
		return folderUri;
	}

	async ensureDripIgnoreFile(targetUri) {
		const kbRoot = await this.ensureKnowledgeBaseRoot();
		if (!kbRoot) {
			throw new Error('No knowledge base folder selected.');
		}

		const baseUri = await this.resolveTargetFolder(targetUri);
		const fileUri = vscode.Uri.joinPath(baseUri, '.dripignore');

		try {
			await readTextFile(fileUri);
		} catch {
			await writeTextFile(fileUri, '# Paths ignored by DRIP\n');
		}

		await vscode.commands.executeCommand('vscode.open', fileUri);
		return fileUri;
	}

	async addIgnoreEntry(item) {
		const kbRoot = this.getKnowledgeBaseRoot();
		if (!kbRoot) {
			throw new Error('No knowledge base folder selected.');
		}

		if (!item?.uri) {
			throw new Error('Select a folder or note file first.');
		}

		// Find the closest ancestor directory (starting at the selected folder, or the file's parent)
		// that already contains a `.dripignore`. If none exists, fall back to the KB root `.dripignore`.
		const startDirUri =
			item.kind === 'folder'
				? item.uri
				: vscode.Uri.file(path.dirname(item.uri.fsPath));

		let currentDirUri = startDirUri;
		let ignoreDirUri = undefined;
		let ignoreUri = undefined;

		while (true) {
			const candidateIgnoreUri = vscode.Uri.joinPath(currentDirUri, '.dripignore');
			try {
				await readTextFile(candidateIgnoreUri);
				ignoreDirUri = currentDirUri;
				ignoreUri = candidateIgnoreUri;
				break;
			} catch {
				// not found here
			}

			const relToKbRoot = path.relative(kbRoot.fsPath, currentDirUri.fsPath);
			if (relToKbRoot === '' || relToKbRoot === '.') {
				// reached KB root directory
				break;
			}

			if (relToKbRoot.startsWith('..')) {
				break;
			}

			const parentFsPath = path.dirname(currentDirUri.fsPath);
			if (!parentFsPath || parentFsPath === currentDirUri.fsPath) {
				break;
			}

			currentDirUri = vscode.Uri.file(parentFsPath);
		}

		if (!ignoreUri || !ignoreDirUri) {
			ignoreDirUri = kbRoot;
			ignoreUri = vscode.Uri.joinPath(kbRoot, '.dripignore');
		}

		let existing = '';
		try {
			existing = await readTextFile(ignoreUri);
		} catch {
			existing = '# Paths ignored by DRIP\n';
		}

		const relativePathFromIgnoreDir = path.relative(ignoreDirUri.fsPath, item.uri.fsPath).replace(/\\/g, '/');
		if (!relativePathFromIgnoreDir || relativePathFromIgnoreDir === '.') {
			await vscode.window.showWarningMessage('Cannot add an ignore rule for the `.dripignore` directory itself. Select a child file or folder.');
			return ignoreUri;
		}

		const entry = item.kind === 'folder' ? `${relativePathFromIgnoreDir}/` : relativePathFromIgnoreDir;
		const lines = new Set(
			existing
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(Boolean)
		);
		lines.add(entry);

		await writeTextFile(ignoreUri, `${Array.from(lines).join('\n')}\n`);
		await vscode.commands.executeCommand('vscode.open', ignoreUri);
		return ignoreUri;
	}

	async resolveTargetFolder(targetUri) {
		const kbRoot = this.getKnowledgeBaseRoot();
		if (!kbRoot) {
			throw new Error('No knowledge base folder selected.');
		}

		if (!targetUri) {
			return kbRoot;
		}

		try {
			const stat = await vscode.workspace.fs.stat(targetUri);
			if (stat.type === vscode.FileType.Directory) {
				return targetUri;
			}

			return vscode.Uri.file(path.dirname(targetUri.fsPath));
		} catch {
			return kbRoot;
		}
	}

	async copyPath(item) {
		if (!item?.uri) {
			if (item?.kind === 'draft' || item?.contextValue === 'dripDraft') {
				await vscode.window.showInformationMessage('Drafts are not files on disk; there is no path to copy.');
			}
			return;
		}

		await vscode.env.clipboard.writeText(item.uri.fsPath);
	}

	async renameItem(item) {
		if (!item?.uri) {
			if (item?.kind === 'draft' || item?.contextValue === 'dripDraft') {
				await vscode.window.showInformationMessage('Drafts are not files on disk; rename is only for knowledge base files and folders.');
			}
			return;
		}

		if (item.kind === 'kbRoot' || item.contextValue === 'dripKbRoot') {
			await vscode.window.showWarningMessage('Use your file explorer or another tool to rename the knowledge base root folder.');
			return;
		}

		if (item.kind === 'draftsRoot' || item.contextValue === 'dripDraftsRoot') {
			await vscode.window.showWarningMessage('The Drafts group cannot be renamed.');
			return;
		}

		if (item.kind === 'draft' || item.contextValue === 'dripDraft') {
			await vscode.window.showInformationMessage('Rename drafts from the composer by editing the title, or delete and create a new draft.');
			return;
		}

		const kbRoot = this.getKnowledgeBaseRoot();
		if (!kbRoot || !item.uri) {
			return;
		}

		const relative = path.relative(kbRoot.fsPath, item.uri.fsPath);
		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			await vscode.window.showWarningMessage('Only items inside the knowledge base can be renamed.');
			return;
		}

		const oldName = path.basename(item.uri.fsPath);
		const noteExt = getExtensionFromFileName(oldName);
		const isNoteFile =
			item.contextValue === 'dripNoteFile' && Boolean(noteExt) && oldName.length > noteExt.length;

		// If renaming a knowledge-base note, we must propagate reference updates.
		// References are stored as: `L. ![file name - @fileid](rel/path)`.
		let oldFileId = '';
		if (isNoteFile) {
			try {
				const oldText = await readTextFile(item.uri);
				oldFileId = extractFileIdFromHeader(oldText);
			} catch {
				// If file has no header yet, we skip reference rewriting.
			}
		}

		const inputValue = isNoteFile ? stripKbNoteExtension(oldName) : oldName;
		const answer = await vscode.window.showInputBox({
			title: isNoteFile ? 'Rename note' : 'Rename',
			prompt: isNoteFile
				? `Note name (the “${noteExt}” suffix is added automatically)`
				: 'New name',
			value: inputValue,
			validateInput(value) {
				const v = (value || '').trim();
				if (!v) {
					return 'Enter a name.';
				}
				if (v.includes('/') || v.includes('\\')) {
					return 'Use a file or folder name only (no path separators).';
				}
				if (isNoteFile) {
					const stem = v;
					if (stem.includes(path.sep)) {
						return 'Invalid name.';
					}
					const lower = stem.toLowerCase();
					for (const ext of getKbNoteExtensions()) {
						if (lower.endsWith(ext)) {
							return `Do not type "${ext}"; it is appended for you.`;
						}
					}
					return undefined;
				}
				if (v !== path.basename(v)) {
					return 'Use a file or folder name only (no path separators).';
				}
				return undefined;
			}
		});

		if (!answer) {
			return;
		}

		const trimmed = answer.trim();
		const finalName = isNoteFile && noteExt ? `${trimmed}${noteExt}` : trimmed;
		if (finalName === oldName) {
			return;
		}

		const parentDir = path.dirname(item.uri.fsPath);
		const newPath = path.join(parentDir, finalName);
		const newUri = vscode.Uri.file(newPath);

		try {
			await vscode.workspace.fs.stat(newUri);
			await vscode.window.showErrorMessage(`A file or folder named "${finalName}" already exists in this location.`);
			return;
		} catch {
			// Target does not exist — OK to rename.
		}

		await vscode.workspace.fs.rename(item.uri, newUri, { overwrite: false });
		if (isNoteFile) {
			await normalizeNoteIdentityFile(newUri, { context: this.context, forceRecomputeFileId: true });

			// Update all L.-based references that point to this file's old id.
			try {
				const newText = await readTextFile(newUri);
				const newFileId = extractFileIdFromHeader(newText);
				if (oldFileId && newFileId && oldFileId !== newFileId) {
					const changedNotes = await updateRefsOnRename(
						this.context,
						kbRoot,
						item.uri,
						newUri,
						oldFileId,
						newFileId
					);
					const oldRel = path.relative(kbRoot.fsPath, item.uri.fsPath).replace(/\\/g, '/');
					await removeFileFromDripIndex(kbRoot, oldRel);
					await updateNoteInDripIndex(kbRoot, newUri, this.context);
					for (const u of changedNotes || []) {
						await updateNoteInDripIndex(kbRoot, u, this.context);
					}
				}
			} catch {
				// Keep rename working even if reference propagation fails.
			}
		}
	}

	async deleteItem(item) {
		if (!item) {
			return;
		}

		if (item.kind === 'kbRoot' || item.contextValue === 'dripKbRoot') {
			await vscode.window.showWarningMessage('The knowledge base root cannot be deleted from here.');
			return;
		}

		if (item.kind === 'draftsRoot' || item.contextValue === 'dripDraftsRoot') {
			await vscode.window.showWarningMessage('The Drafts group cannot be deleted.');
			return;
		}

		if (item.kind === 'draft' || item.contextValue === 'dripDraft') {
			const draftId = item.draftId;
			if (!draftId) {
				return;
			}

			const confirm = await vscode.window.showWarningMessage('Delete this draft permanently?', { modal: true }, 'Delete');
			if (confirm !== 'Delete') {
				return;
			}

			const drafts = this.getDrafts().filter(draft => draft.id !== draftId);
			const kbRoot = this.getKnowledgeBaseRoot();
			if (kbRoot) {
				await deleteDraftFromDripIndex(kbRoot, draftId);
				this._draftsCache = drafts;
				this._notifyDraftsRefresh();
			} else {
				await this.context.globalState.update(DRAFTS_KEY, drafts);
				this._draftsCache = drafts;
			}
			return;
		}

		const kbRoot = this.getKnowledgeBaseRoot();
		if (!kbRoot || !item.uri) {
			return;
		}

		const relative = path.relative(kbRoot.fsPath, item.uri.fsPath);
		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			await vscode.window.showWarningMessage('Only items inside the knowledge base can be deleted.');
			return;
		}

		const label = path.basename(item.uri.fsPath);
		const noteExt = getExtensionFromFileName(label);
		const isNoteFile =
			(item.contextValue === 'dripNoteFile' || item.contextValue === 'dripDailyNote') &&
			Boolean(noteExt) &&
			label.length > noteExt.length;
		const isDailyFolder =
			item.contextValue === 'dripDailyYear' || item.contextValue === 'dripDailyMonth';

		let deletedFileId = '';
		if (isNoteFile) {
			try {
				const txt = await readTextFile(item.uri);
				deletedFileId = extractFileIdFromHeader(txt);
			} catch {
				// no header; proceed with deletion
			}
		}
		const confirm = await vscode.window.showWarningMessage(
			`Delete "${label}"? This cannot be undone.`,
			{ modal: true },
			'Delete'
		);

		if (confirm !== 'Delete') {
			return;
		}

		if (isNoteFile && deletedFileId) {
			try {
				const changedNotes = await removeRefsOnDelete(this.context, kbRoot, deletedFileId);
				const rel = path.relative(kbRoot.fsPath, item.uri.fsPath).replace(/\\/g, '/');
				await removeFileFromDripIndex(kbRoot, rel);
				for (const u of changedNotes || []) {
					await updateNoteInDripIndex(kbRoot, u, this.context);
				}
			} catch {
				// proceed with deletion
			}
		} else if (isDailyFolder) {
			try {
				await this._removeDailyNotesFolderFromIndex(kbRoot, item.uri);
			} catch {
				// proceed with deletion
			}
		} else if (isNoteFile) {
			try {
				const rel = path.relative(kbRoot.fsPath, item.uri.fsPath).replace(/\\/g, '/');
				await removeFileFromDripIndex(kbRoot, rel);
			} catch {
				// proceed
			}
		}
		await vscode.workspace.fs.delete(item.uri, { recursive: true });
	}

	/**
	 * Remove index rows for every `.d.txt` under a daily-notes year/month folder.
	 * @param {import('vscode').Uri} kbRoot
	 * @param {import('vscode').Uri} folderUri
	 */
	async _removeDailyNotesFolderFromIndex(kbRoot, folderUri) {
		const stack = [folderUri];
		while (stack.length) {
			const dir = stack.pop();
			let entries = [];
			try {
				entries = await vscode.workspace.fs.readDirectory(dir);
			} catch {
				continue;
			}
			for (const [name, kind] of entries) {
				const child = vscode.Uri.joinPath(dir, name);
				if (kind === vscode.FileType.Directory) {
					stack.push(child);
					continue;
				}
				if (kind !== vscode.FileType.File || !name.toLowerCase().endsWith('.d.txt')) continue;
				const rel = path.relative(kbRoot.fsPath, child.fsPath).replace(/\\/g, '/');
				try {
					await removeFileFromDripIndex(kbRoot, rel);
				} catch {
					/* best-effort */
				}
			}
		}
	}

	/** Standalone tag graph (not linked to note files yet). */
	getTagGraph() {
		const { loadTagGraph } = require('../graph/tagGraphStore');
		return loadTagGraph(this.context);
	}

	async saveTagGraph(graph) {
		const { saveTagGraph, normalizeGraph } = require('../graph/tagGraphStore');
		await saveTagGraph(this.context, normalizeGraph(graph));
	}

	syncTagGraphCheckpointFromStorage() {
		const tagGraphStore = require('../graph/tagGraphStore');
		const g = tagGraphStore.normalizeGraph(tagGraphStore.loadTagGraph(this.context));
		this._tagGraphCheckpoint = JSON.parse(JSON.stringify(g));
	}

	isTagGraphDirtyVsCheckpoint() {
		if (!this._tagGraphCheckpoint) {
			return false;
		}
		const tagGraphStore = require('../graph/tagGraphStore');
		const cur = tagGraphStore.normalizeGraph(tagGraphStore.loadTagGraph(this.context));
		return JSON.stringify(cur) !== JSON.stringify(this._tagGraphCheckpoint);
	}

	commitTagGraphCheckpoint() {
		this.syncTagGraphCheckpointFromStorage();
	}

	async revertTagGraphToCheckpoint() {
		if (!this._tagGraphCheckpoint) {
			return;
		}
		await this.saveTagGraph(this._tagGraphCheckpoint);
	}

	/**
	 * When switching graphs: if the slot changed since last checkpoint, ask what to do.
	 * @returns {Promise<'ok'|'cancel'>}
	 */
	async promptTagGraphSwitchOrCancel() {
		if (!this.isTagGraphDirtyVsCheckpoint()) {
			return 'ok';
		}
		const pick = await vscode.window.showWarningMessage(
			'This tags graph has changes since you last opened it (or last confirmed this slot). Save these edits to this slot and continue, discard them and restore the previous version, or cancel?',
			{ modal: true },
			'Save and continue',
			'Discard without saving',
			'Cancel'
		);
		if (pick === 'Cancel' || pick === undefined) {
			return 'cancel';
		}
		if (pick === 'Discard without saving') {
			await this.revertTagGraphToCheckpoint();
			return 'ok';
		}
		this.commitTagGraphCheckpoint();
		return 'ok';
	}

	clearTagGraphHistory() {
		this._tagGraphUndo.length = 0;
		this._tagGraphRedo.length = 0;
	}

	_clearTagGraphRedo() {
		this._tagGraphRedo.length = 0;
	}

	_pushTagGraphUndoSnapshot(graph) {
		// Graph is plain data; JSON clone is fine here.
		const snap = JSON.parse(JSON.stringify(graph));
		this._tagGraphUndo.push(snap);
		if (this._tagGraphUndo.length > this._tagGraphHistoryMax) {
			this._tagGraphUndo.splice(0, this._tagGraphUndo.length - this._tagGraphHistoryMax);
		}
	}

	_pushTagGraphRedoSnapshot(graph) {
		const snap = JSON.parse(JSON.stringify(graph));
		this._tagGraphRedo.push(snap);
		if (this._tagGraphRedo.length > this._tagGraphHistoryMax) {
			this._tagGraphRedo.splice(0, this._tagGraphRedo.length - this._tagGraphHistoryMax);
		}
	}

	async undoTagGraph() {
		if (!this._tagGraphUndo.length) {
			return this.getTagGraph();
		}
		const tagGraphStore = require('../graph/tagGraphStore');
		const current = tagGraphStore.normalizeGraph(tagGraphStore.loadTagGraph(this.context));
		const prev = this._tagGraphUndo.pop();
		this._pushTagGraphRedoSnapshot(current);
		await tagGraphStore.saveTagGraph(this.context, tagGraphStore.normalizeGraph(prev));
		return tagGraphStore.normalizeGraph(prev);
	}

	async redoTagGraph() {
		if (!this._tagGraphRedo.length) {
			return this.getTagGraph();
		}
		const tagGraphStore = require('../graph/tagGraphStore');
		const current = tagGraphStore.normalizeGraph(tagGraphStore.loadTagGraph(this.context));
		const next = this._tagGraphRedo.pop();
		this._pushTagGraphUndoSnapshot(current);
		await tagGraphStore.saveTagGraph(this.context, tagGraphStore.normalizeGraph(next));
		return tagGraphStore.normalizeGraph(next);
	}

	/**
	 * @param {(g: ReturnType<typeof import('../graph/tagGraphStore').loadTagGraph>) => void} mutator
	 * @param {{ recordHistory?: boolean }} [opts]
	 */
	async mutateTagGraph(mutator, opts) {
		const tagGraphStore = require('../graph/tagGraphStore');
		const recordHistory = opts && typeof opts.recordHistory === 'boolean' ? opts.recordHistory : true;
		const g = tagGraphStore.loadTagGraph(this.context);
		if (recordHistory) {
			this._pushTagGraphUndoSnapshot(tagGraphStore.normalizeGraph(g));
			this._clearTagGraphRedo();
		}
		mutator(g);
		await tagGraphStore.saveTagGraph(this.context, tagGraphStore.normalizeGraph(g));
		return tagGraphStore.normalizeGraph(g);
	}

	getRetrieverPersistedUi() {
		return this.context.workspaceState.get(RETRIEVER_UI_STATE_KEY, undefined);
	}

	/**
	 * @param {Record<string, unknown>} data
	 */
	async saveRetrieverPersistedUi(data) {
		await this.context.workspaceState.update(RETRIEVER_UI_STATE_KEY, data);
	}
}

function createEmptyDraft() {
	return {
		id: '',
		title: '',
		priority: 'Medium',
		headings: '',
		content: '',
		metadataFilename: '',
		status: 'draft'
	};
}

module.exports = {
	createEmptyDraft,
	DripState
};
