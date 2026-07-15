'use strict';

const path = require('path');
const vscode = require('vscode');
const { KB_ROOT_KEY } = require('../shared/constants');
const { enumerateKbNoteUris, readFileHeaderSnippet } = require('./kbFilesystem');
const { extractFileIdFromHeader } = require('../graph/dripnoteReferenceSync');

function getKbRootUri(context) {
	const raw = context.workspaceState.get(KB_ROOT_KEY);
	return raw ? vscode.Uri.parse(raw) : undefined;
}

let cachedMap = /** @type {Map<string, import('vscode').Uri> | null} */ (null);
let cachedKbRoot = '';
let cachedAt = 0;
const CACHE_MS = 8000;

async function buildFileIdToUriMap(kbRoot) {
	const uris = await enumerateKbNoteUris(kbRoot);
	/** @type {Map<string, import('vscode').Uri>} */
	const map = new Map();
	const BATCH = 32;
	for (let i = 0; i < uris.length; i++) {
		const uri = uris[i];
		const base = path.basename(uri.fsPath).toLowerCase();
		if (base.startsWith('_index.')) {
			continue;
		}
		let head = '';
		try {
			head = await readFileHeaderSnippet(uri);
		} catch {
			continue;
		}
		const id = extractFileIdFromHeader(head);
		if (id) {
			map.set(id.toLowerCase(), uri);
		}
		if (i > 0 && i % BATCH === 0) {
			await new Promise(r => setImmediate(r));
		}
	}
	return map;
}

async function getFileIdMap(context) {
	const kbRoot = getKbRootUri(context);
	if (!kbRoot) {
		return { kbRoot: null, map: null };
	}
	const now = Date.now();
	const key = kbRoot.fsPath;
	if (cachedMap && cachedKbRoot === key && now - cachedAt < CACHE_MS) {
		return { kbRoot, map: cachedMap };
	}
	cachedMap = await buildFileIdToUriMap(kbRoot);
	cachedKbRoot = key;
	cachedAt = now;
	return { kbRoot, map: cachedMap };
}

function invalidateFileIdMapCache() {
	cachedMap = null;
	cachedAt = 0;
}

function registerDripnoteFileIdDefinitions(context) {
	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider({ language: 'dripnote', scheme: 'file' }, {
			async provideDefinition(document, position, token) {
				if (token.isCancellationRequested) {
					return null;
				}
				const { kbRoot, map } = await getFileIdMap(context);
				if (!kbRoot || !map) {
					return null;
				}
				const rel = path.relative(kbRoot.fsPath, document.uri.fsPath);
				if (rel.startsWith('..') || path.isAbsolute(rel)) {
					return null;
				}

				const line = document.lineAt(position.line).text;
				if (/^\s*fileid\s*:/i.test(line)) {
					return null;
				}
				if (!/^\s*L\./i.test(line)) {
					return null;
				}

				const re = /@([A-Za-z0-9_-]{3,})/g;
				let m;
				while ((m = re.exec(line)) !== null) {
					const full = `@${m[1]}`;
					const start = m.index;
					const end = start + full.length;
					if (position.character >= start && position.character <= end) {
						const uri = map.get(full.toLowerCase());
						if (!uri) {
							return null;
						}
						return new vscode.Location(uri, new vscode.Position(0, 0));
					}
				}
				return null;
			}
		})
	);
}

module.exports = {
	registerDripnoteFileIdDefinitions,
	getKbRootUri,
	getFileIdMap,
	invalidateFileIdMapCache
};
