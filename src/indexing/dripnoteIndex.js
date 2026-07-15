'use strict';

const path = require('path');
const vscode = require('vscode');
const { forEachKnowledgeBaseNote, forEachKnowledgeBaseNotePath, readTextFile, writeTextFile } = require('../document/kbNoteOps');
const { getKbNoteExtensions } = require('../document/model/noteFileTypes');
const tagGraphStore = require('../graph/tagGraphStore');

const INDEX_FILE_STEM = '_index';

// Root `_index` stores shared entity id allocator state (files + headings later).
// Kept in the preamble so rebuilds preserve it.
const ENTITY_NEXT_RE = /^\s*entity-next\s*:\s*(\d+)\s*$/i;
const ENTITY_FREE_RE = /^\s*entity-free\s*:\s*\[([^\]]*)\]\s*$/i;

function parseEntityFreeList(raw) {
	return String(raw || '')
		.split(',')
		.map(x => parseInt(String(x || '').trim(), 10))
		.filter(n => Number.isFinite(n) && n >= 0);
}

function formatEntityFreeList(nums) {
	const list = (Array.isArray(nums) ? nums : [])
		.map(n => Math.max(0, Math.floor(Number(n) || 0)))
		.sort((a, b) => a - b);
	return `[${list.join(', ')}]`;
}

/**
 * @param {string} indexText
 * @returns {{ next: number, free: number[] }}
 */
function readEntityAllocatorState(indexText) {
  let next = 1;
  let free = [];
  for (const raw of String(indexText || '').split(/\r?\n/)) {
    const line = String(raw || '');
    const mNext = ENTITY_NEXT_RE.exec(line);
    if (mNext) {
      const n = parseInt(mNext[1], 10);
      if (Number.isFinite(n) && n >= 0) next = n;
      continue;
    }
    const mFree = ENTITY_FREE_RE.exec(line);
    if (mFree) {
      free = parseEntityFreeList(mFree[1]);
      continue;
    }
    // Stop scanning once we hit the body marker.
    if (/^#\s+DRIP Index\s*$/i.test(line.trim())) break;
  }
  return { next, free };
}

/**
 * Replace or insert `entity-next`/`entity-free` in the preamble (above `# DRIP Index`).
 * @param {string} indexText
 * @param {{ next: number, free: number[] }} state
 */
function writeEntityAllocatorState(indexText, state) {
  const lines = String(indexText || '').split(/\r?\n/);
  const bodyIdx = lines.findIndex(l => /^#\s+DRIP Index\s*$/.test(String(l || '').trim()));
  const preEnd = bodyIdx >= 0 ? bodyIdx : lines.length;
  let sawNext = false;
  let sawFree = false;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || '');
    if (i < preEnd) {
      if (ENTITY_NEXT_RE.test(line)) {
        out.push(`entity-next: ${Math.max(0, Math.floor(Number(state.next) || 0))}`);
        sawNext = true;
        continue;
      }
      if (ENTITY_FREE_RE.test(line)) {
        out.push(`entity-free: ${formatEntityFreeList(state.free)}`);
        sawFree = true;
        continue;
      }
      out.push(line);
      continue;
    }
    out.push(line);
  }
  if (!sawNext || !sawFree) {
    // Insert just after `kind: drip-index` if possible, else at top of preamble.
    const kindIdx = out.findIndex(l => /^\s*kind\s*:\s*drip-index\s*$/i.test(String(l || '').trim()));
    const insertAt = kindIdx >= 0 ? kindIdx + 1 : 0;
    const chunk = [];
    if (!sawNext) chunk.push(`entity-next: ${Math.max(0, Math.floor(Number(state.next) || 0))}`);
    if (!sawFree) chunk.push(`entity-free: ${formatEntityFreeList(state.free)}`);
    out.splice(insertAt, 0, ...chunk);
  }
  return out.join('\n');
}

function parseBracketTokens(raw) {
	return String(raw || '')
		.split(',')
		.map(x => String(x || '').trim())
		.filter(Boolean);
}

function extractFileId(text) {
	const m = String(text || '').match(/^\s*fileid\s*:\s*(@[A-Za-z0-9_-]+)/im);
	return m ? String(m[1]) : '';
}

/** @typedef {{ oldId: string, newId: string, relPath: string }} PendingIdMigration */

function extractPendingMigrationsFromIndexText(text) {
	const lines = String(text || '').split(/\r?\n/);
	/** @type {PendingIdMigration[]} */
	const out = [];
	let inSection = false;
	for (const raw of lines) {
		const line = String(raw || '');
		if (/^##\s+Pending id migrations\s*$/i.test(line)) {
			inSection = true;
			continue;
		}
		if (inSection && /^##\s+/.test(line)) {
			break;
		}
		if (!inSection) {
			continue;
		}
		const m = line.match(/^\-\s+(@\S+)\s*→\s*(@\S+)\s*\|\s*(.+)$/);
		if (m) {
			out.push({
				oldId: String(m[1] || '').trim(),
				newId: String(m[2] || '').trim(),
				relPath: String(m[3] || '').trim()
			});
		}
	}
	return out;
}

/**
 * @param {PendingIdMigration[]} a
 * @param {PendingIdMigration[]} b
 */
function mergePendingMigrationLists(a, b) {
	const seen = new Set();
	/** @type {PendingIdMigration[]} */
	const out = [];
	for (const arr of [a || [], b || []]) {
		for (const p of arr) {
			const key = `${p.oldId}|${p.newId}|${p.relPath}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			out.push(p);
		}
	}
	return out;
}

function isLikelyCanonicalFileId(value) {
	return /^@[a-f0-9]{10}$/i.test(String(value || '').trim());
}

function isValidPendingMigration(m) {
	if (!m || typeof m !== 'object') return false;
	const oldId = String(m.oldId || '').trim();
	const newId = String(m.newId || '').trim();
	const relPath = String(m.relPath || '').trim().replace(/\\/g, '/');
	if (!oldId || !newId || !relPath) return false;
	if (oldId === newId) return false;
	// Ignore malformed/manual ids (for example @d) and index-file self migrations.
	if (!isLikelyCanonicalFileId(oldId) || !isLikelyCanonicalFileId(newId)) return false;
	const base = path.basename(relPath).toLowerCase();
	if (base === '_index.d.txt' || base.startsWith(`${INDEX_FILE_STEM}.`)) return false;
	return true;
}

function filterPendingMigrations(pending) {
	return (Array.isArray(pending) ? pending : []).filter(isValidPendingMigration);
}

function extractFileLevelTags(text) {
	const src = String(text || '');
	const lines = src.split(/\r?\n/);
	const out = [];
	for (const line of lines) {
		if (/^\s*#/.test(line)) {
			break;
		}
		const m = line.match(/^\s*tags\s*:\s*\[([^\]]*)\]/i);
		if (!m) continue;
		out.push(...parseBracketTokens(m[1]));
	}
	return out;
}

function extractFileLevelRelations(text) {
	const src = String(text || '');
	const lines = src.split(/\r?\n/);
	/** @type {Map<string,string[]>} */
	const rel = new Map();
	for (const raw of lines) {
		const line = String(raw || '');
		if (/^\s*#/.test(line)) {
			break;
		}
		const trimmed = line.trim();
		if (!trimmed || /^\s*\/\//.test(trimmed)) {
			continue;
		}
		const m = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*\[([^\]]*)\]\s*$/);
		if (m) {
			const key = String(m[1] || '').trim().toLowerCase();
			const vals = parseBracketTokens(m[2]);
			if (!rel.has(key)) rel.set(key, []);
			rel.get(key).push(...vals);
			continue;
		}
		const short = trimmed.match(/^\[([^\]]*)\]\s*$/);
		if (short) {
			if (!rel.has('tags')) rel.set('tags', []);
			rel.get('tags').push(...parseBracketTokens(short[1]));
		}
	}
	/** @type {Map<string,string[]>} */
	const out = new Map();
	for (const [k, vals] of rel.entries()) {
		out.set(k, uniqueCaseInsensitive(vals));
	}
	return out;
}

function extractAllTags(text) {
	const src = String(text || '');
	const out = [];
	const relationLineRe = /^\s*[A-Za-z][A-Za-z0-9_-]*\s*:\s*\[([^\]]*)\]/gm;
	let m;
	while ((m = relationLineRe.exec(src)) !== null) {
		out.push(...parseBracketTokens(m[1]));
	}
	const shortTagRe = /^\s*\[([^\]]+)\]\s*$/gm;
	while ((m = shortTagRe.exec(src)) !== null) {
		out.push(...parseBracketTokens(m[1]));
	}
	return out;
}

function getKnownTagLowerSet(context) {
	const out = new Set();
	if (!context) return out;
	for (const meta of tagGraphStore.listStoredTagGraphs(context)) {
		const g = tagGraphStore.loadStoredTagGraphById(context, meta.id);
		for (const n of g.nodes || []) {
			const label = String(n.label || '').trim().toLowerCase();
			if (label) out.add(label);
		}
	}
	return out;
}

function filterKnownTags(tags, knownLowerSet) {
	if (!knownLowerSet || !knownLowerSet.size) return tags;
	return tags.filter(t => knownLowerSet.has(String(t || '').trim().toLowerCase()));
}

function uniqueCaseInsensitive(values) {
	const seen = new Set();
	const out = [];
	for (const v of values) {
		const s = String(v || '').trim();
		if (!s) continue;
		const low = s.toLowerCase();
		if (seen.has(low)) continue;
		seen.add(low);
		out.push(s);
	}
	return out;
}

function extractMentionedFileIds(text) {
	const src = String(text || '');
	const out = [];
	const lines = src.split(/\r?\n/);
	for (const line of lines) {
		if (!/^\s*L\./i.test(line)) continue;
		// Tolerant parsing for references:
		// L. ![name - @id](path)
		// L. [@id]
		// L. @id
		const re = /@([A-Za-z0-9][A-Za-z0-9_-]{2,})/g;
		let m;
		while ((m = re.exec(line)) !== null) {
			out.push(`@${m[1]}`);
		}
	}
	return out;
}

function extractIndexSignals(text, context) {
	const known = getKnownTagLowerSet(context);
	const fileTags = uniqueCaseInsensitive(filterKnownTags(extractFileLevelTags(text), known));
	const allTags = uniqueCaseInsensitive(filterKnownTags(extractAllTags(text), known));
	const links = uniqueCaseInsensitive(extractMentionedFileIds(text));
	return JSON.stringify({ fileTags, allTags, links });
}

function normalizeRelPath(fromRootFsPath, targetFsPath) {
	return path.relative(fromRootFsPath, targetFsPath).replace(/\\/g, '/');
}

function pickIndexExtension() {
	const exts = getKbNoteExtensions();
	if (exts.includes('.d.txt')) {
		return '.d.txt';
	}
	return exts[0] || '.d.txt';
}

/**
 * Header + optional pending migrations (everything above `# DRIP Index`).
 * @param {string} folderRelPath
 * @param {string} createdIso
 * @param {PendingIdMigration[]} pendingMigrations
 */
function buildIndexPreamble(folderRelPath, createdIso, pendingMigrations) {
	const lines = [];
	lines.push(`filename: _index (${folderRelPath || '.'})`);
	lines.push(`created: ${createdIso}`);
	lines.push('kind: drip-index');
	// Root index owns the shared entity allocator state.
	if (String(folderRelPath || '.').trim() === '.') {
		lines.push('entity-next: 1');
		lines.push('entity-free: []');
	}
	lines.push('');
	const pending = Array.isArray(pendingMigrations) ? pendingMigrations : [];
	if (pending.length) {
		lines.push('## Pending id migrations');
		for (const p of pending) {
			lines.push(`- ${p.oldId} → ${p.newId} | ${p.relPath}`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

function buildIndexText(folderRelPath, entries, pendingMigrations, delegatedIndexes) {
	const now = new Date().toISOString();
	const preamble = buildIndexPreamble(folderRelPath, now, pendingMigrations);
	const folderDisplay = String(folderRelPath || '.').trim() === '.' ? '(root)' : String(folderRelPath || '.');
	const lines = [];
	lines.push('# DRIP Index');
	lines.push(`folder: ${folderDisplay}`);
	lines.push(`files: ${entries.length}`);
	const delegated = Array.isArray(delegatedIndexes) ? delegatedIndexes : [];
	lines.push('delegated-indexes:');
	if (delegated.length) {
		for (const d of delegated) {
			lines.push(`\t- folder: ${d.folderRelPath} | index: ${d.indexRelPath}`);
		}
	} else {
		lines.push('\t—');
	}
	lines.push('');
	for (const entry of entries) {
		lines.push(`## ${entry.relativePath}`);
		lines.push(`fileId: ${entry.fileId || '—'}`);
		lines.push('file-level-relations:');
		if (entry.fileLevelRelations && entry.fileLevelRelations.length) {
			for (const rel of entry.fileLevelRelations) {
				lines.push(`\t${rel.key}: [ ${rel.values.join(', ')} ]`);
			}
		} else {
			lines.push('\t—');
		}
		lines.push(`all-tags: [ ${entry.allTags.join(', ')} ]`);
		lines.push(`children-links: [ ${entry.childLinkFileIds.join(', ')} ]`);
		lines.push(`parent-links: [ ${entry.parentLinkFileIds.join(', ')} ]`);
		lines.push('');
	}
	return `${preamble}\n${lines.join('\n')}`;
}

async function listDelegatedChildIndexes(kbRoot, folderUri) {
	const folders = await listIndexOwnerFolders(kbRoot);
	/** @type {{ folderRelPath: string, indexRelPath: string }[]} */
	const out = [];
	for (const f of folders) {
		if (!f || f.fsPath === folderUri.fsPath) continue;
		const parent = await findParentIndexFolder(kbRoot, f);
		if (!parent || parent.fsPath !== folderUri.fsPath) continue;
		const folderRel = normalizeRelPath(kbRoot.fsPath, f.fsPath) || '.';
		const idxUri = await indexUriForFolder(kbRoot, f);
		const idxRel = normalizeRelPath(kbRoot.fsPath, idxUri.fsPath);
		out.push({
			folderRelPath: folderRel,
			indexRelPath: idxRel
		});
	}
	out.sort((a, b) => a.folderRelPath.localeCompare(b.folderRelPath));
	return out;
}

/**
 * @param {string} prevText
 * @returns {string|null}
 */
function extractIndexBodyAfterDripMarker(prevText) {
	const lines = String(prevText || '').split(/\r?\n/);
	const idx = lines.findIndex(l => /^#\s+DRIP Index\s*$/.test(String(l || '').trim()));
	if (idx < 0) {
		return null;
	}
	return lines.slice(idx).join('\n');
}

function extractIndexedRelativePathsFromIndexText(text) {
	const body = extractIndexBodyAfterDripMarker(text);
	if (!body) return [];
	const out = [];
	for (const line of String(body).split(/\r?\n/)) {
		const m = String(line || '').match(/^##\s+(.+)\s*$/);
		if (!m) continue;
		const rel = String(m[1] || '').trim().replace(/\\/g, '/');
		if (rel) out.push(rel);
	}
	return out;
}

/**
 * Parse each `## rel path` section’s `all-tags:` line from a DRIP index body.
 * @param {string} indexFileText full `_index` file text
 * @returns {Map<string, string[]>} normalized rel path → lowercase tags from index
 */
function extractIndexedFileTagsFromIndexText(indexFileText) {
	const body = extractIndexBodyAfterDripMarker(indexFileText);
	if (!body) return new Map();
	/** @type {Map<string, string[]>} */
	const map = new Map();
	const lines = String(body).split(/\r?\n/);
	let currentPath = '';
	for (const raw of lines) {
		const line = String(raw || '');
		const hm = line.match(/^##\s+(.+)\s*$/);
		if (hm) {
			currentPath = String(hm[1] || '').trim().replace(/\\/g, '/');
			continue;
		}
		const tm = line.match(/^\s*all-tags:\s*\[([^\]]*)\]/i);
		if (tm && currentPath) {
			const tags = parseBracketTokens(tm[1]).map(t => String(t || '').trim().toLowerCase()).filter(Boolean);
			map.set(currentPath, tags);
		}
	}
	return map;
}

function extractCreatedLineFromIndex(prevText) {
	const m = String(prevText || '').match(/^created:\s*(.+)$/m);
	return m ? String(m[1]).trim() : new Date().toISOString();
}

/**
 * Replace preamble only; keeps `# DRIP Index` body unchanged (avoids full KB rescan).
 * @param {string} prevText
 * @param {string} folderRelPath
 * @param {PendingIdMigration[]} pendingMigrations
 * @returns {string|null}
 */
function replaceIndexPreambleKeepingBody(prevText, folderRelPath, pendingMigrations) {
	const body = extractIndexBodyAfterDripMarker(prevText);
	if (!body) {
		return null;
	}
	const createdIso = extractCreatedLineFromIndex(prevText);
	const preamble = buildIndexPreamble(folderRelPath, createdIso, pendingMigrations);
	return `${preamble}\n${body}`;
}

/**
 * Merge a migration into ancestor `_index` files (parent folders) without rebuilding entries.
 * @param {import('vscode').Uri} kbRoot
 * @param {import('vscode').Uri} noteUri
 * @param {import('vscode').Uri} nearestIndexFolder index owner for this note (full rebuild already done there)
 * @param {PendingIdMigration} migration
 * @param {import('vscode').ExtensionContext} [context]
 */
async function propagatePendingMigrationToAncestorIndexes(kbRoot, noteUri, nearestIndexFolder, migration, context) {
	const kbFs = kbRoot.fsPath;
	const nearestFs = nearestIndexFolder.fsPath;
	let cur = path.dirname(noteUri.fsPath);
	while (true) {
		const rel = path.relative(kbFs, cur);
		if (rel.startsWith('..')) {
			break;
		}
		const folderUri = vscode.Uri.file(cur);
		if (folderUri.fsPath !== nearestFs && (await hasIndexAtFolder(folderUri))) {
			await mergePendingIntoIndexPreambleOnly(kbRoot, folderUri, migration, context);
		}
		if (cur === kbFs) {
			break;
		}
		const parent = path.dirname(cur);
		if (!parent || parent === cur) {
			break;
		}
		cur = parent;
	}
}

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {import('vscode').Uri} indexFolderUri
 * @param {PendingIdMigration} migration
 * @param {import('vscode').ExtensionContext} [context]
 */
async function mergePendingIntoIndexPreambleOnly(kbRoot, indexFolderUri, migration, context) {
	const ext = pickIndexExtension();
	const indexUri = vscode.Uri.joinPath(indexFolderUri, `${INDEX_FILE_STEM}${ext}`);
	let prevText;
	try {
		prevText = await readTextFile(indexUri);
	} catch {
		return;
	}
	const folderRelPath = normalizeRelPath(kbRoot.fsPath, indexFolderUri.fsPath);
	const existing = extractPendingMigrationsFromIndexText(prevText);
	const merged = mergePendingMigrationLists(existing, [migration]);
	const next = replaceIndexPreambleKeepingBody(prevText, folderRelPath, merged);
	if (!next) {
		await createOrUpdateIndexForFolder(kbRoot, indexFolderUri, { context, mergePendingMigrations: [migration] });
		return;
	}
	await writeTextFile(indexUri, `${next.replace(/\n+$/, '')}\n`);
}

/**
 * @param {import('vscode').Uri} kbRoot
 */
async function listIndexOwnerFolders(kbRoot) {
	const ext = pickIndexExtension();
	const pattern = new vscode.RelativePattern(kbRoot, `**/${INDEX_FILE_STEM}${ext}`);
	const uris = await vscode.workspace.findFiles(pattern, null, 2000);
	/** @type {Map<string, import('vscode').Uri>} */
	const byDir = new Map();
	for (const u of uris) {
		const dir = path.dirname(u.fsPath);
		if (!byDir.has(dir)) {
			byDir.set(dir, vscode.Uri.file(dir));
		}
	}
	return Array.from(byDir.values());
}

function indexFolderDepth(kbRoot, folderUri) {
	const rel = path.relative(kbRoot.fsPath, folderUri.fsPath);
	if (!rel || rel === '.') {
		return 0;
	}
	return rel.split(path.sep).filter(Boolean).length;
}

/**
 * Rebuild every `_index` from deepest folder to root so ownership entries stay consistent.
 * @param {import('vscode').Uri} kbRoot
 * @param {import('vscode').ExtensionContext} [context]
 */
async function reconcileAllIndexFiles(kbRoot, context) {
	const folders = await listIndexOwnerFolders(kbRoot);
	folders.sort((a, b) => indexFolderDepth(kbRoot, b) - indexFolderDepth(kbRoot, a));
	/** Rebuild each index without holding every note body in RAM at once (streaming walk per rebuild). */
	for (let i = 0; i < folders.length; i++) {
		try {
			await createOrUpdateIndexForFolder(kbRoot, folders[i], { context });
		} catch (err) {
			console.error('[DRIP] reconcileAllIndexFiles: folder failed', folders[i] && folders[i].fsPath, err);
		}
		if (i % 2 === 1) {
			await new Promise(r => setImmediate(r));
		}
	}
}

async function listOwnedRelativePathsForFolder(kbRoot, folderUri) {
	const folderRoot = folderUri.fsPath;
	/** @type {string[]} */
	const out = [];
	await forEachKnowledgeBaseNotePath(
		kbRoot,
		async note => {
			if (!note?.uri?.fsPath) return;
			const fspath = note.uri.fsPath;
			const baseName = path.basename(fspath).toLowerCase();
			if (baseName === '_index.d.txt' || baseName.startsWith(`${INDEX_FILE_STEM}.`)) return;
			const relToFolder = path.relative(folderRoot, fspath);
			if (relToFolder.startsWith('..') || path.isAbsolute(relToFolder)) return;
			const ownerFolder = await findNearestIndexFolder(kbRoot, note.uri);
			if (!ownerFolder || ownerFolder.fsPath !== folderUri.fsPath) return;
			out.push(normalizeRelPath(kbRoot.fsPath, fspath));
		},
		{ yieldEvery: 60 }
	);
	out.sort((a, b) => a.localeCompare(b));
	return out;
}

async function reconcileIndexPathsLightweight(kbRoot, context) {
	const folders = await listIndexOwnerFolders(kbRoot);
	folders.sort((a, b) => indexFolderDepth(kbRoot, b) - indexFolderDepth(kbRoot, a));
	for (const folder of folders) {
		const idxUri = await indexUriForFolder(kbRoot, folder);
		let idxText = '';
		try {
			idxText = await readTextFile(idxUri);
		} catch {
			continue;
		}
		const indexed = uniqueCaseInsensitive(extractIndexedRelativePathsFromIndexText(idxText));
		const owned = uniqueCaseInsensitive(await listOwnedRelativePathsForFolder(kbRoot, folder));
		const indexedKey = JSON.stringify(indexed);
		const ownedKey = JSON.stringify(owned);
		if (indexedKey !== ownedKey) {
			await createOrUpdateIndexForFolder(kbRoot, folder, { context });
		}
	}
}

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {import('vscode').Uri} indexFolderUri
 * @param {PendingIdMigration} migration
 * @param {import('vscode').ExtensionContext} [context]
 */
async function appendPendingIdMigration(kbRoot, indexFolderUri, migration, context) {
	await createOrUpdateIndexForFolder(kbRoot, indexFolderUri, {
		context,
		mergePendingMigrations: [migration]
	});
}

async function buildIndexEntries(kbRoot, folderUri, options) {
	const context = options && options.context ? options.context : null;
	const known = getKnownTagLowerSet(context);
	const opts = options || {};
	const folderRoot = folderUri.fsPath;
	const list = [];
	/** @type {Map<string, string[]>} */
	const outboundByFileId = new Map();

	const assumeIndexFolderFsPath =
		opts && opts.assumeIndexFolderFsPath ? String(opts.assumeIndexFolderFsPath) : '';

	async function consumeNote(note) {
		if (!note || !note.uri || !note.text) {
			return;
		}
		const fspath = note.uri.fsPath;
		const baseName = path.basename(fspath).toLowerCase();
		if (baseName === '_index.d.txt' || baseName.startsWith(`${INDEX_FILE_STEM}.`)) {
			return;
		}
		const relToFolder = path.relative(folderRoot, fspath);
		if (relToFolder.startsWith('..') || path.isAbsolute(relToFolder)) {
			return;
		}
		const noteDirFs = path.dirname(note.uri.fsPath);
		const ownerFolder =
			assumeIndexFolderFsPath &&
			(noteDirFs === assumeIndexFolderFsPath || noteDirFs.startsWith(`${assumeIndexFolderFsPath}${path.sep}`))
				? vscode.Uri.file(assumeIndexFolderFsPath)
				: await findNearestIndexFolder(kbRoot, note.uri);
		if (!ownerFolder || ownerFolder.fsPath !== folderUri.fsPath) {
			return;
		}
		const fileId = extractFileId(note.text);
		const fileLevelRelationsRaw = extractFileLevelRelations(note.text);
		/** @type {{ key: string, values: string[] }[]} */
		const fileLevelRelations = [];
		for (const [key, values] of fileLevelRelationsRaw.entries()) {
			fileLevelRelations.push({
				key,
				values: uniqueCaseInsensitive(filterKnownTags(values, known))
			});
		}
		fileLevelRelations.sort((a, b) => a.key.localeCompare(b.key));
		const allTags = uniqueCaseInsensitive(filterKnownTags(extractAllTags(note.text), known));
		let linkFileIds = uniqueCaseInsensitive(extractMentionedFileIds(note.text));
		if (fileId) {
			const self = fileId.toLowerCase();
			linkFileIds = linkFileIds.filter(x => x.toLowerCase() !== self);
		}
		const childLinks = uniqueCaseInsensitive(linkFileIds);
		if (fileId) {
			outboundByFileId.set(fileId.toLowerCase(), childLinks);
		}
		list.push({
			relativePath: normalizeRelPath(kbRoot.fsPath, fspath),
			fileId,
			fileLevelRelations,
			allTags,
			childLinkFileIds: childLinks,
			parentLinkFileIds: []
		});
	}

	if (Array.isArray(opts.cachedNotes)) {
		for (const note of opts.cachedNotes) {
			await consumeNote(note);
		}
	} else {
		await forEachKnowledgeBaseNote(kbRoot, consumeNote, { yieldEvery: 20 });
	}
	// Build parent-link sets from outbound edges.
	const inboundByFileId = new Map();
	for (const [srcFileId, targets] of outboundByFileId.entries()) {
		for (const t of targets) {
			const k = String(t || '').toLowerCase();
			if (!k) continue;
			if (!inboundByFileId.has(k)) inboundByFileId.set(k, new Set());
			inboundByFileId.get(k).add(`@${srcFileId.replace(/^@/, '')}`);
		}
	}
	for (const entry of list) {
		const k = String(entry.fileId || '').toLowerCase();
		const inbound = inboundByFileId.get(k);
		entry.parentLinkFileIds = inbound ? Array.from(inbound.values()).sort((a, b) => a.localeCompare(b)) : [];
	}
	list.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
	return list;
}

async function createOrUpdateIndexForFolder(kbRoot, folderUri, options) {
	const ext = pickIndexExtension();
	const indexUri = vscode.Uri.joinPath(folderUri, `${INDEX_FILE_STEM}${ext}`);
	const opts = options || {};
	/** @type {PendingIdMigration[]} */
	let pending = [];
	/** @type {{ next: number, free: number[] } | null} */
	let entityState = null;
	try {
		const prevText = await readTextFile(indexUri);
		pending = filterPendingMigrations(extractPendingMigrationsFromIndexText(prevText));
		if (folderUri.fsPath === kbRoot.fsPath) {
			entityState = readEntityAllocatorState(prevText);
		}
	} catch {
		// no previous index
	}
	if (opts.mergePendingMigrations && opts.mergePendingMigrations.length) {
		pending = filterPendingMigrations(mergePendingMigrationLists(pending, opts.mergePendingMigrations));
	}
	const entries = await buildIndexEntries(kbRoot, folderUri, {
		...opts
	});
	const delegated = await listDelegatedChildIndexes(kbRoot, folderUri);
	const folderRelPath = normalizeRelPath(kbRoot.fsPath, folderUri.fsPath);
	let nextText = `${buildIndexText(folderRelPath, entries, pending, delegated)}\n`;
	if (folderUri.fsPath === kbRoot.fsPath) {
		const st = entityState || { next: 1, free: [] };
		nextText = `${writeEntityAllocatorState(nextText, st)}\n`;
	}
	await writeTextFile(indexUri, nextText);
	return indexUri;
}

/**
 * Allocate the next shared file entity number from index.drip.
 * @param {import('vscode').Uri} kbRoot
 * @returns {Promise<number>}
 */
async function allocateNextEntityNumber(kbRoot) {
	const { allocateNextFileEntityNumber, initEmptyDripIndexFile } = require('./dripIndexDb');
	await initEmptyDripIndexFile(kbRoot);
	return allocateNextFileEntityNumber(kbRoot);
}

async function ensureRootIndexIfMissing(kbRoot) {
	const ext = pickIndexExtension();
	const indexUri = vscode.Uri.joinPath(kbRoot, `${INDEX_FILE_STEM}${ext}`);
	try {
		await readTextFile(indexUri);
		return indexUri;
	} catch {
		return createOrUpdateIndexForFolder(kbRoot, kbRoot);
	}
}

async function findNearestIndexFolder(kbRoot, noteUri) {
	const ext = pickIndexExtension();
	let cursor = vscode.Uri.file(path.dirname(noteUri.fsPath));
	while (true) {
		const rel = path.relative(kbRoot.fsPath, cursor.fsPath);
		if (rel.startsWith('..') || path.isAbsolute(rel)) {
			return kbRoot;
		}
		const idxUri = vscode.Uri.joinPath(cursor, `${INDEX_FILE_STEM}${ext}`);
		try {
			await readTextFile(idxUri);
			return cursor;
		} catch {
			// keep walking up
		}
		if (cursor.fsPath === kbRoot.fsPath) break;
		const parentFs = path.dirname(cursor.fsPath);
		if (!parentFs || parentFs === cursor.fsPath) break;
		cursor = vscode.Uri.file(parentFs);
	}
	return kbRoot;
}

async function syncNearestIndexForNote(context, kbRoot, noteUri) {
	const base = path.basename(noteUri.fsPath).toLowerCase();
	if (base.startsWith(`${INDEX_FILE_STEM}.`) || base === '_index.d.txt') {
		return null;
	}
	const folder = await findNearestIndexFolder(kbRoot, noteUri);
	return createOrUpdateIndexForFolder(kbRoot, folder, { context });
}

async function indexUriForFolder(_kbRoot, folderUri) {
	const ext = pickIndexExtension();
	// Index is stored directly on the folder, not under kbRoot/tag-graphs subdirs.
	return vscode.Uri.joinPath(folderUri, `${INDEX_FILE_STEM}${ext}`);
}

async function hasIndexAtFolder(folderUri) {
	const idx = await indexUriForFolder(undefined, folderUri);
	try {
		await readTextFile(idx);
		return true;
	} catch {
		return false;
	}
}

async function findParentIndexFolder(kbRoot, folderUri) {
	// Find the closest ancestor (strict parent chain) that already has an index file.
	let cursor = vscode.Uri.file(path.dirname(folderUri.fsPath));
	while (true) {
		if (cursor.fsPath === kbRoot.fsPath) {
			return (await hasIndexAtFolder(cursor)) ? cursor : null;
		}
		if (!cursor || cursor.fsPath.length < kbRoot.fsPath.length) {
			return null;
		}
		if (await hasIndexAtFolder(cursor)) {
			return cursor;
		}
		const parentFs = path.dirname(cursor.fsPath);
		if (!parentFs || parentFs === cursor.fsPath) {
			return null;
		}
		cursor = vscode.Uri.file(parentFs);
	}
}

async function removeIndexForFolder(kbRoot, folderUri, options) {
	const ext = pickIndexExtension();
	const idxUri = vscode.Uri.joinPath(folderUri, `${INDEX_FILE_STEM}${ext}`);
	const isRoot = folderUri.fsPath === kbRoot.fsPath;
	if (isRoot) {
		throw new Error('Cannot remove root _index.');
	}
	const parent = await findParentIndexFolder(kbRoot, folderUri);
	if (!parent) {
		throw new Error('Cannot remove index here because there is no parent _index in the hierarchy.');
	}
	try {
		await vscode.workspace.fs.delete(idxUri, { useTrash: false });
	} catch {
		// already missing is fine
	}
	// Rebuild parent (merge behavior).
	await createOrUpdateIndexForFolder(kbRoot, parent, options || {});
	// Root rebuild as safety (keeps ownership stable).
	await createOrUpdateIndexForFolder(kbRoot, kbRoot, options || {});
}

/**
 * @param {PendingIdMigration} a
 * @param {PendingIdMigration} b
 */
function pendingMigrationEquals(a, b) {
	return (
		String(a.oldId || '') === String(b.oldId || '') &&
		String(a.newId || '') === String(b.newId || '') &&
		String(a.relPath || '') === String(b.relPath || '')
	);
}

/**
 * Drop one resolved migration line from every `_index` preamble (deduped across hierarchy).
 * @param {import('vscode').Uri} kbRoot
 * @param {PendingIdMigration} migration
 * @param {import('vscode').ExtensionContext} [context]
 */
async function removePendingMigrationFromAllIndices(kbRoot, migration, context) {
	const folders = await listIndexOwnerFolders(kbRoot);
	for (const folder of folders) {
		const ext = pickIndexExtension();
		const indexUri = vscode.Uri.joinPath(folder, `${INDEX_FILE_STEM}${ext}`);
		let prevText;
		try {
			prevText = await readTextFile(indexUri);
		} catch {
			continue;
		}
		const existing = extractPendingMigrationsFromIndexText(prevText);
		const filtered = existing.filter(p => !pendingMigrationEquals(p, migration));
		if (filtered.length === existing.length) {
			continue;
		}
		const folderRelPath = normalizeRelPath(kbRoot.fsPath, folder.fsPath);
		const next = replaceIndexPreambleKeepingBody(prevText, folderRelPath, filtered);
		if (!next) {
			await createOrUpdateIndexForFolder(kbRoot, folder, { context });
			continue;
		}
		await writeTextFile(indexUri, `${next.replace(/\n+$/, '')}\n`);
	}
}

module.exports = {
	INDEX_FILE_STEM,
	pickIndexExtension,
	indexUriForFolder,
	extractIndexBodyAfterDripMarker,
	extractIndexedFileTagsFromIndexText,
	extractIndexedRelativePathsFromIndexText,
	extractIndexSignals,
	allocateNextEntityNumber,
	createOrUpdateIndexForFolder,
	ensureRootIndexIfMissing,
	findNearestIndexFolder,
	syncNearestIndexForNote,
	removeIndexForFolder,
	findParentIndexFolder,
	listIndexOwnerFolders,
	listOwnedRelativePathsForFolder,
	hasIndexAtFolder,
	reconcileIndexPathsLightweight,
	reconcileAllIndexFiles,
	appendPendingIdMigration,
	propagatePendingMigrationToAncestorIndexes,
	removePendingMigrationFromAllIndices,
	extractPendingMigrationsFromIndexText,
	mergePendingMigrationLists
};

