'use strict';

const path = require('path');
const vscode = require('vscode');
const { RECENTS_KEY, RECENTS_MAX } = require('../shared/constants');
const { ensureDripIndexSkeleton, getRecentsDripFileUri } = require('./initializeDripIndex');

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
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} fileUri
 * @returns {string | null} KB-relative path with forward slashes, or null if outside KB
 */
function toKbRelativePath(kbRootUri, fileUri) {
	const root = path.resolve(kbRootUri.fsPath);
	const file = path.resolve(fileUri.fsPath);
	const rel = path.relative(root, file);
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
		return null;
	}
	return rel.replace(/\\/g, '/');
}

/**
 * @param {unknown} raw
 * @returns {{ relPath: string, label: string }[]}
 */
function normalizeRecentsList(raw) {
	const list = Array.isArray(raw)
		? raw
		: raw && typeof raw === 'object' && Array.isArray(raw.files)
			? raw.files
			: [];
	/** @type {{ relPath: string, label: string }[]} */
	const out = [];
	const seen = new Set();
	for (const entry of list) {
		const relPath = String((entry && (entry.relPath || entry.path)) || '')
			.trim()
			.replace(/\\/g, '/');
		if (!relPath || seen.has(relPath.toLowerCase())) continue;
		if (!relPath.toLowerCase().endsWith('.d.txt')) continue;
		seen.add(relPath.toLowerCase());
		const label =
			String((entry && entry.label) || '').trim() || path.basename(relPath) || relPath;
		out.push({ relPath, label });
		if (out.length >= RECENTS_MAX) break;
	}
	return out;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<{ relPath: string, label: string }[]>}
 */
async function loadRecentsFromDripIndex(kbRootUri) {
	await ensureDripIndexSkeleton(kbRootUri);
	const fileUri = getRecentsDripFileUri(kbRootUri);
	if (!(await uriExists(fileUri))) {
		return [];
	}
	try {
		const buf = await vscode.workspace.fs.readFile(fileUri);
		const parsed = JSON.parse(Buffer.from(buf).toString('utf8'));
		return normalizeRecentsList(parsed);
	} catch {
		return [];
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {{ relPath: string, label: string }[]} files
 */
async function saveRecentsToDripIndex(kbRootUri, files) {
	await ensureDripIndexSkeleton(kbRootUri);
	const fileUri = getRecentsDripFileUri(kbRootUri);
	const normalized = normalizeRecentsList(files);
	const envelope = {
		format: 'drip-recents',
		version: 1,
		updatedAt: new Date().toISOString(),
		files: normalized
	};
	await vscode.workspace.fs.writeFile(
		fileUri,
		Buffer.from(JSON.stringify(envelope, null, 2), 'utf8')
	);
	return normalized;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} fileUri
 * @returns {Promise<{ relPath: string, label: string }[]>}
 */
async function touchRecentInDripIndex(kbRootUri, fileUri) {
	const relPath = toKbRelativePath(kbRootUri, fileUri);
	if (!relPath) {
		return loadRecentsFromDripIndex(kbRootUri);
	}
	const label = path.basename(relPath);
	const prev = await loadRecentsFromDripIndex(kbRootUri);
	const next = [{ relPath, label }, ...prev.filter(e => e.relPath !== relPath)].slice(
		0,
		RECENTS_MAX
	);
	return saveRecentsToDripIndex(kbRootUri, next);
}

/**
 * One-time move from workspaceState into `.dripindex/recents.drip.json`.
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').Uri} kbRootUri
 */
async function migrateWorkspaceRecentsToDripIndex(context, kbRootUri) {
	const existing = await loadRecentsFromDripIndex(kbRootUri);
	if (existing.length) {
		return existing;
	}
	const raw = context.workspaceState.get(RECENTS_KEY, []);
	if (!Array.isArray(raw) || !raw.length) {
		return [];
	}
	/** @type {{ relPath: string, label: string }[]} */
	const migrated = [];
	for (const entry of raw) {
		try {
			const uri = vscode.Uri.parse(String((entry && entry.uri) || '').trim());
			const relPath = toKbRelativePath(kbRootUri, uri);
			if (!relPath) continue;
			migrated.push({
				relPath,
				label: String((entry && entry.label) || '').trim() || path.basename(relPath)
			});
		} catch {
			/* skip */
		}
	}
	if (!migrated.length) {
		return [];
	}
	const saved = await saveRecentsToDripIndex(kbRootUri, migrated);
	await context.workspaceState.update(RECENTS_KEY, undefined);
	return saved;
}

module.exports = {
	toKbRelativePath,
	loadRecentsFromDripIndex,
	saveRecentsToDripIndex,
	touchRecentInDripIndex,
	migrateWorkspaceRecentsToDripIndex
};
