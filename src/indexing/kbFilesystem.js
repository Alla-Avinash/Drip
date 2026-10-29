'use strict';

const path = require('path');
const vscode = require('vscode');
const { fileNameMatchesKbNote } = require('../document/model/dripNoteFileTypes.js');
const { DAILY_NOTES_DIR } = require('../shared/constants');
const { isHiddenProjectsHomeFolder } = require('../startup/projectsDrip');
const { isDripProjectFolderName } = require('../document/model/dripNoteProjectFolder.js');

function isDotImgRasterImage(name) {
	return /\.(png|jpg|jpeg)$/i.test(name);
}

/**
 * Hide `dailynotes.drip` from the Knowledge Base tree only (still indexed on disk).
 * @param {import('vscode').Uri} rootUri
 * @param {import('vscode').Uri} currentUri
 * @param {string} name
 */
function isHiddenDailyNotesFolder(rootUri, currentUri, name) {
	if (name !== DAILY_NOTES_DIR) return false;
	return path.resolve(rootUri.fsPath) === path.resolve(currentUri.fsPath);
}

async function getKnowledgeBaseTreeChildren(rootUri, currentUri) {
	const entries = await vscode.workspace.fs.readDirectory(currentUri);
	const items = [];
	const parentDirName = path.basename(currentUri.fsPath);

	for (const [name, type] of entries) {
		const childUri = vscode.Uri.joinPath(currentUri, name);
		const relativePath = toRelativePath(rootUri, childUri);

		if (await isPathIgnored(rootUri, relativePath)) {
			continue;
		}

		if (type === vscode.FileType.Directory) {
			if (isHiddenDailyNotesFolder(rootUri, currentUri, name)) {
				continue;
			}
			if (isHiddenProjectsHomeFolder(rootUri, currentUri, name)) {
				continue;
			}
			if (
				isDripProjectFolderName(name) &&
				path.resolve(rootUri.fsPath) === path.resolve(currentUri.fsPath)
			) {
				continue;
			}
			items.push({
				label: name,
				uri: childUri,
				kind: 'folder'
			});
			continue;
		}

		if (type !== vscode.FileType.File) {
			continue;
		}

		if (fileNameMatchesKbNote(name) || name === '.dripignore') {
			items.push({
				label: name,
				uri: childUri,
				kind: 'file'
			});
			continue;
		}

		if (parentDirName === '.img' && isDotImgRasterImage(name)) {
			items.push({
				label: name,
				uri: childUri,
				kind: 'image'
			});
		}
	}

	items.sort((left, right) => {
		const leftFolder = left.kind === 'folder';
		const rightFolder = right.kind === 'folder';
		if (leftFolder !== rightFolder) {
			return leftFolder ? -1 : 1;
		}

		return left.label.localeCompare(right.label);
	});

	return items;
}

/**
 * Direct subfolders of the KB root only (one hierarchy level). Excludes `.img` and ignored paths.
 * Deeper paths like `a/b` never appear here — user drills in via the next step.
 */
async function listImmediateFolderChildrenOfRoot(rootUri, corpusOpts) {
	const opts = normalizeCorpusOptions(corpusOpts);
	if (opts.corpus === 'custom' && !opts.customCorpusPaths.length) {
		return [];
	}
	const folders = [];
	const entries = await vscode.workspace.fs.readDirectory(rootUri);

	for (const [name, type] of entries) {
		if (type !== vscode.FileType.Directory) {
			continue;
		}
		if (name === '.img') {
			continue;
		}
		if (name === DAILY_NOTES_DIR) {
			continue;
		}

		const childUri = vscode.Uri.joinPath(rootUri, name);
		const relativePath = toRelativePath(rootUri, childUri);

		if (!(await isPathVisibleForCorpus(rootUri, relativePath, opts))) {
			continue;
		}

		folders.push({
			uri: childUri,
			relativePath,
			label: name
		});
	}

	return folders;
}

/**
 * Depth-first walk of KB note files (same ignore rules as scan). Does not retain all file bodies in one array.
 * @param {import('vscode').Uri} rootUri
 * @param {import('vscode').Uri} currentUri
 * @param {(note: { uri: import('vscode').Uri, relativePath: string, text: string }) => void | Promise<void>} visitor
 */
async function walkKbNoteFiles(rootUri, currentUri, visitor, options) {
	const entries = await vscode.workspace.fs.readDirectory(currentUri);

	for (const [name, type] of entries) {
		const childUri = vscode.Uri.joinPath(currentUri, name);
		const relativePath = toRelativePath(rootUri, childUri);

		if (await isPathIgnored(rootUri, relativePath, options)) {
			continue;
		}

		if (type === vscode.FileType.Directory) {
			await walkKbNoteFiles(rootUri, childUri, visitor, options);
			continue;
		}

		if (type === vscode.FileType.File && fileNameMatchesKbNote(name)) {
			const content = await readTextFile(childUri);
			await visitor({ uri: childUri, relativePath, text: content });
		}
	}
}

/**
 * Depth-first walk of KB note file URIs only (no file content reads).
 * @param {import('vscode').Uri} rootUri
 * @param {import('vscode').Uri} currentUri
 * @param {(note: { uri: import('vscode').Uri, relativePath: string }) => void | Promise<void>} visitor
 */
async function walkKbNoteUris(rootUri, currentUri, visitor, options) {
	const entries = await vscode.workspace.fs.readDirectory(currentUri);

	for (const [name, type] of entries) {
		const childUri = vscode.Uri.joinPath(currentUri, name);
		const relativePath = toRelativePath(rootUri, childUri);

		if (await isPathIgnored(rootUri, relativePath, options)) {
			continue;
		}

		if (type === vscode.FileType.Directory) {
			await walkKbNoteUris(rootUri, childUri, visitor, options);
			continue;
		}

		if (type === vscode.FileType.File && fileNameMatchesKbNote(name)) {
			await visitor({ uri: childUri, relativePath });
		}
	}
}

/**
 * Visit each KB note path without reading file content.
 * @param {import('vscode').Uri} rootUri
 * @param {(note: { uri: import('vscode').Uri, relativePath: string }) => void | Promise<void>} visitor
 * @param {{ yieldEvery?: number, respectDripignore?: boolean }} [options]
 */
async function forEachKnowledgeBaseNotePath(rootUri, visitor, options) {
	const yieldEvery = options && options.yieldEvery > 0 ? options.yieldEvery : 50;
	let n = 0;
	await walkKbNoteUris(rootUri, rootUri, async note => {
		await visitor(note);
		n += 1;
		if (n % yieldEvery === 0) {
			await new Promise(r => setImmediate(r));
		}
	}, options);
}

/**
 * @param {import('vscode').Uri} kbRoot
 * @returns {Promise<import('vscode').Uri[]>}
 */
async function enumerateKbNoteUris(kbRoot) {
	const uris = [];
	await walkKbNoteUris(kbRoot, kbRoot, async ({ uri }) => {
		uris.push(uri);
	});
	return uris;
}

const HEADER_SNIPPET_MAX = 4096;

/**
 * Read enough of a note file to parse `fileid:` from the header.
 * @param {import('vscode').Uri} uri
 */
async function readFileHeaderSnippet(uri) {
	const bytes = await vscode.workspace.fs.readFile(uri);
	const text = Buffer.from(bytes).toString('utf8');
	const fence = text.indexOf('\n---\n');
	if (fence >= 0 && fence < HEADER_SNIPPET_MAX) {
		return text.slice(0, fence + 5);
	}
	return text.slice(0, HEADER_SNIPPET_MAX);
}

async function loadIgnoreMatchersAt(dirUri) {
	const ignoreUri = vscode.Uri.joinPath(dirUri, '.dripignore');

	try {
		const raw = await readTextFile(ignoreUri);
		return raw
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line && !line.startsWith('#'))
			.map(line => line.replace(/\\/g, '/'));
	} catch {
		return [];
	}
}

/**
 * Nested .dripignore: each directory may contain `.dripignore`. Patterns are relative to that directory.
 * When testing path `rel` from KB root, we merge rules from root down through each ancestor directory.
 */
/**
 * Always skip `.dripindex/` and nested `.driplock` folders (not `.dripignore`).
 * @param {string} relativePath
 */
function isHardExcludedKbRelativePath(relativePath) {
	const normalized = String(relativePath || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	if (!normalized) {
		return false;
	}
	const parts = normalized.split('/').filter(Boolean);
	if (parts.some(p => String(p || '') === '.dripindex' || String(p || '') === '.drip')) {
		return true;
	}
	if (parts.some(p => String(p || '').toLowerCase().endsWith('.driplock'))) {
		return true;
	}
	return false;
}

async function isPathIgnored(rootUri, relativePath, options) {
	const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	if (!normalized) {
		return false;
	}

	const parts = normalized.split('/').filter(Boolean);
	const last = parts[parts.length - 1];

	if (isHardExcludedKbRelativePath(normalized)) {
		return true;
	}

	if (options && options.respectDripignore === false) {
		return false;
	}

	// Ignore rules must never hide `.dripignore` files (patterns like `.dripignore` would otherwise match self).
	if (last === '.dripignore') {
		return false;
	}

	const isNoteFile = fileNameMatchesKbNote(last);
	const depth = isNoteFile ? parts.length - 1 : parts.length;

	for (let d = 0; d <= depth; d++) {
		const dirUri = d === 0 ? rootUri : vscode.Uri.joinPath(rootUri, ...parts.slice(0, d));
		const dirRel = d === 0 ? '' : parts.slice(0, d).join('/');
		const patterns = await loadIgnoreMatchersAt(dirUri);

		for (const pattern of patterns) {
			const fullPattern = dirRel ? `${dirRel}/${pattern}` : pattern;
			if (matchesIgnorePattern(normalized, fullPattern)) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Normalize Storage/Retriever corpus payload.
 * Default: working set (respect `.dripignore`).
 * @param {{ corpus?: string, customCorpusPaths?: unknown, respectDripignore?: boolean }} [raw]
 * @returns {{ corpus: 'working'|'entire'|'custom', respectDripignore: boolean, customCorpusPaths: { path: string, kind: 'file'|'folder', name: string }[] }}
 */
function normalizeCorpusOptions(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const customCorpusPaths = normalizeCustomCorpusEntries(r.customCorpusPaths);
	let corpus = 'working';
	const c = String(r.corpus || '').toLowerCase();
	if (c === 'entire') corpus = 'entire';
	else if (c === 'custom') corpus = 'custom';
	else if (c === 'working') corpus = 'working';
	else if (r.respectDripignore === false) corpus = 'entire';
	const respectDripignore = corpus === 'working';
	return {
		corpus,
		respectDripignore,
		customCorpusPaths: corpus === 'custom' ? customCorpusPaths : []
	};
}

/**
 * @param {unknown} raw
 * @returns {{ path: string, kind: 'file'|'folder', name: string }[]}
 */
function normalizeCustomCorpusEntries(raw) {
	if (!Array.isArray(raw)) return [];
	/** @type {{ path: string, kind: 'file'|'folder', name: string }[]} */
	const out = [];
	const seen = new Set();
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const rec = /** @type {Record<string, unknown>} */ (item);
		const p = String(rec.path || '')
			.replace(/\\/g, '/')
			.replace(/^\/+/, '')
			.replace(/\/+$/, '')
			.trim();
		if (!p || p === '.' || seen.has(p.toLowerCase())) continue;
		seen.add(p.toLowerCase());
		const kind = String(rec.kind || '').toLowerCase() === 'folder' ? 'folder' : 'file';
		const name =
			String(rec.name || '').trim() ||
			(p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p);
		out.push({ path: p, kind, name });
	}
	return out;
}

/**
 * @param {string} relativePath
 * @param {{ path: string, kind: 'file'|'folder' }[]} entries
 */
function relPathInCustomCorpus(relativePath, entries) {
	const list = Array.isArray(entries) ? entries : [];
	if (!list.length) return false;
	const rel = String(relativePath || '')
		.replace(/\\/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
		.toLowerCase();
	if (!rel) return false;
	for (const e of list) {
		const p = String(e.path || '')
			.replace(/\\/g, '/')
			.replace(/\/+$/, '')
			.toLowerCase();
		if (!p) continue;
		if (e.kind === 'file') {
			if (rel === p) return true;
		} else if (rel === p || rel.startsWith(p + '/')) {
			return true;
		}
	}
	return false;
}

/**
 * Whether a KB-relative path is visible for the active corpus.
 * @param {import('vscode').Uri} rootUri
 * @param {string} relativePath
 * @param {{ corpus?: string, respectDripignore?: boolean, customCorpusPaths?: { path: string, kind: 'file'|'folder', name: string }[] }} [corpusOpts]
 */
async function isPathVisibleForCorpus(rootUri, relativePath, corpusOpts) {
	const opts = normalizeCorpusOptions(corpusOpts);
	const rel = String(relativePath || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	if (!rel) {
		return opts.corpus !== 'custom' || opts.customCorpusPaths.length > 0;
	}
	if (opts.corpus === 'custom') {
		if (!opts.customCorpusPaths.length) return false;
		if (!relPathInCustomCorpus(rel, opts.customCorpusPaths)) return false;
		return !(await isPathIgnored(rootUri, rel, { respectDripignore: false }));
	}
	return !(await isPathIgnored(rootUri, rel, { respectDripignore: opts.respectDripignore }));
}

function matchesIgnorePattern(relativePath, pattern) {
	const normalized = relativePath.replace(/\\/g, '/');
	const p = pattern.replace(/\\/g, '/');

	if (p.endsWith('/')) {
		return normalized === p.slice(0, -1) || normalized.startsWith(p);
	}

	return normalized === p || normalized.startsWith(`${p}/`);
}

function toRelativePath(rootUri, fileUri) {
	return path.relative(rootUri.fsPath, fileUri.fsPath).replace(/\\/g, '/');
}

async function readTextFile(uri) {
	const bytes = await vscode.workspace.fs.readFile(uri);
	return Buffer.from(bytes).toString('utf8');
}

async function writeTextFile(uri, content) {
	await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

module.exports = {
	enumerateKbNoteUris,
	forEachKnowledgeBaseNotePath,
	getKnowledgeBaseTreeChildren,
	isPathIgnored,
	isPathVisibleForCorpus,
	listImmediateFolderChildrenOfRoot,
	loadIgnoreMatchersAt,
	normalizeCorpusOptions,
	normalizeCustomCorpusEntries,
	relPathInCustomCorpus,
	readFileHeaderSnippet,
	readTextFile,
	toRelativePath,
	walkKbNoteFiles,
	walkKbNoteUris,
	writeTextFile
};
