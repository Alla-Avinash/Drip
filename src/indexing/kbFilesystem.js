'use strict';

const path = require('path');
const vscode = require('vscode');
const { fileNameMatchesKbNote } = require('../document/model/noteFileTypes');

function isDotImgRasterImage(name) {
	return /\.(png|jpg|jpeg)$/i.test(name);
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
async function listImmediateFolderChildrenOfRoot(rootUri) {
	const folders = [];
	const entries = await vscode.workspace.fs.readDirectory(rootUri);

	for (const [name, type] of entries) {
		if (type !== vscode.FileType.Directory) {
			continue;
		}
		if (name === '.img') {
			continue;
		}

		const childUri = vscode.Uri.joinPath(rootUri, name);
		const relativePath = toRelativePath(rootUri, childUri);

		if (await isPathIgnored(rootUri, relativePath)) {
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
async function walkKbNoteFiles(rootUri, currentUri, visitor) {
	const entries = await vscode.workspace.fs.readDirectory(currentUri);

	for (const [name, type] of entries) {
		const childUri = vscode.Uri.joinPath(currentUri, name);
		const relativePath = toRelativePath(rootUri, childUri);

		if (await isPathIgnored(rootUri, relativePath)) {
			continue;
		}

		if (type === vscode.FileType.Directory) {
			await walkKbNoteFiles(rootUri, childUri, visitor);
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
async function walkKbNoteUris(rootUri, currentUri, visitor) {
	const entries = await vscode.workspace.fs.readDirectory(currentUri);

	for (const [name, type] of entries) {
		const childUri = vscode.Uri.joinPath(currentUri, name);
		const relativePath = toRelativePath(rootUri, childUri);

		if (await isPathIgnored(rootUri, relativePath)) {
			continue;
		}

		if (type === vscode.FileType.Directory) {
			await walkKbNoteUris(rootUri, childUri, visitor);
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
 * @param {{ yieldEvery?: number }} [options]
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
	});
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
async function isPathIgnored(rootUri, relativePath) {
	const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	if (!normalized) {
		return false;
	}

	const parts = normalized.split('/').filter(Boolean);
	const last = parts[parts.length - 1];

	// KB-internal DRIP storage — never show or scan.
	if (parts.some(p => String(p || '') === '.dripindex')) {
		return true;
	}

	// `.driplock` subfolders are hard boundaries: never show or scan anything inside them.
	// (Root itself is selected as the KB; relative paths never include the root folder name.)
	if (parts.some(p => String(p || '').toLowerCase().endsWith('.driplock'))) {
		return true;
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
	listImmediateFolderChildrenOfRoot,
	loadIgnoreMatchersAt,
	readFileHeaderSnippet,
	readTextFile,
	toRelativePath,
	walkKbNoteFiles,
	walkKbNoteUris,
	writeTextFile
};
