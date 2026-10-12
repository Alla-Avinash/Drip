'use strict';

/**
 * Path-aware tag scope for `.d.md` notes — where a note's tags live and which tags are
 * "known" for it.
 *
 * A note inside a project (`.p`) / feature (`.f`) folder uses that project's own tag
 * graph; a note anywhere else in the KB uses every KB tag graph (the "individual tags"
 * graph plus all others — project tags live in a separate per-project store and are
 * never included here). Both the editor dropdown and the one-time metadata validation
 * read the known tags from this module, so they always agree on the same set.
 */

const vscode = require('vscode');
const path = require('path');
const { KB_ROOT_KEY } = require('../shared/constants');
const tagGraphStore = require('./tagGraphStore');
const { loadProjectGraph, loadProjectTags, addProjectTag } = require('./projectTagStore');

/** The dedicated KB graph that holds notes' own (non-project) tags. */
const INDIVIDUAL_TAGS_GRAPH_NAME = 'individual tags';

/**
 * The verified KB root, read from workspace state (same source the tag stores use).
 * @param {import('vscode').ExtensionContext} context
 * @returns {import('vscode').Uri | undefined}
 */
function kbRootFor(context) {
	const raw = context.workspaceState.get(KB_ROOT_KEY);
	if (typeof raw !== 'string' || !raw.trim()) return undefined;
	try {
		return vscode.Uri.parse(raw);
	} catch {
		return undefined;
	}
}

/**
 * KB-relative folder prefix of the project (`.p`) / feature (`.f`) folder containing the
 * note, or '' when the note is not inside one. Forward slashes, no trailing slash.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} noteFsPath
 * @returns {string}
 */
function projectFolderPrefixForNote(kbRootUri, noteFsPath) {
	if (!kbRootUri || !noteFsPath) return '';
	const rel = path.relative(kbRootUri.fsPath, noteFsPath);
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
	let current = path.dirname(rel);
	if (current === '.') return '';
	for (;;) {
		const base = String(path.basename(current) || '').trim().toLowerCase();
		if (base.endsWith('.p') || base.endsWith('.f')) {
			return current.replace(/\\/g, '/');
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return '';
}

/**
 * Find a stored KB graph id by its display name (case-insensitive), or null.
 * @param {import('vscode').ExtensionContext} context
 * @param {string} name
 * @returns {string | null}
 */
function findGraphIdByName(context, name) {
	const want = String(name || '').trim().toLowerCase();
	if (!want) return null;
	for (const g of tagGraphStore.listStoredTagGraphs(context)) {
		if (String(g.name || '').trim().toLowerCase() === want) return String(g.id);
	}
	return null;
}

/**
 * The "individual tags" graph id, created on first use (without changing the active graph).
 * This is where a note's own KB tags live, kept separate from the tags graph the user is
 * currently looking at.
 * @param {import('vscode').ExtensionContext} context
 * @returns {Promise<string>}
 */
async function ensureIndividualTagsGraphId(context) {
	const existing = findGraphIdByName(context, INDIVIDUAL_TAGS_GRAPH_NAME);
	if (existing) return existing;
	return tagGraphStore.createStoredTagGraph(context, INDIVIDUAL_TAGS_GRAPH_NAME, { activate: false });
}

/**
 * All KB tags — every root label across every stored KB graph, deduped case-insensitively.
 * Project tags live in a separate per-project store, so they are never included here.
 * @param {import('vscode').ExtensionContext} context
 * @returns {string[]}
 */
function listAllKbTags(context) {
	/** @type {Map<string, string>} */
	const byLower = new Map();
	for (const meta of tagGraphStore.listStoredTagGraphs(context)) {
		const graph = tagGraphStore.loadStoredTagGraphById(context, meta.id);
		for (const n of graph.nodes || []) {
			if (n.parentId != null && n.parentId !== '') continue; // root tags only
			const label = String(n.label || '').trim();
			if (!label) continue;
			const low = label.toLowerCase();
			if (!byLower.has(low)) byLower.set(low, label);
		}
	}
	return [...byLower.values()];
}

/**
 * The tags to offer for the note: the per-project graph when the note is inside a
 * project/feature folder, otherwise every KB tag (all graphs, minus project tags).
 * @param {import('vscode').ExtensionContext} context
 * @param {string} noteFsPath
 * @returns {Promise<string[]>}
 */
async function listTagsForNote(context, noteFsPath) {
	const kbRoot = kbRootFor(context);
	const prefix = kbRoot ? projectFolderPrefixForNote(kbRoot, noteFsPath) : '';
	if (prefix) {
		const tags = await loadProjectTags(kbRoot, prefix);
		return tags.map(t => String(t.name || '').trim()).filter(Boolean);
	}
	return listAllKbTags(context);
}

/**
 * Create a tag in the right graph and return the refreshed tag list: the project graph
 * when the note is inside a project/feature folder, otherwise the KB "individual tags"
 * graph (never the active graph).
 * @param {import('vscode').ExtensionContext} context
 * @param {string} noteFsPath
 * @param {string} name
 * @returns {Promise<string[]>}
 */
async function createTagForNote(context, noteFsPath, name) {
	const kbRoot = kbRootFor(context);
	const prefix = kbRoot ? projectFolderPrefixForNote(kbRoot, noteFsPath) : '';
	if (prefix) {
		await addProjectTag(kbRoot, prefix, name);
	} else {
		const graphId = await ensureIndividualTagsGraphId(context);
		const graph = tagGraphStore.loadStoredTagGraphById(context, graphId);
		tagGraphStore.addTag(graph, name);
		await tagGraphStore.saveStoredTagGraphById(context, graphId, graph);
	}
	return listTagsForNote(context, noteFsPath);
}

/**
 * Every tag label (root and sub-tag) that is valid for the note, lowercased — the set the
 * one-time validation uses to drop tags that no longer exist in the note's graph. Project
 * notes resolve against their project graph; KB notes against all KB graphs.
 * @param {import('vscode').ExtensionContext} context
 * @param {string} noteFsPath
 * @returns {Promise<Set<string>>}
 */
async function knownTagsLowerForNote(context, noteFsPath) {
	const kbRoot = kbRootFor(context);
	const prefix = kbRoot ? projectFolderPrefixForNote(kbRoot, noteFsPath) : '';
	/** @type {Set<string>} */
	const out = new Set();
	if (prefix) {
		const graph = await loadProjectGraph(kbRoot, prefix);
		for (const n of graph.nodes || []) {
			const label = String(n.label || '').trim().toLowerCase();
			if (label) out.add(label);
		}
		return out;
	}
	for (const meta of tagGraphStore.listStoredTagGraphs(context)) {
		const graph = tagGraphStore.loadStoredTagGraphById(context, meta.id);
		for (const n of graph.nodes || []) {
			const label = String(n.label || '').trim().toLowerCase();
			if (label) out.add(label);
		}
	}
	return out;
}

module.exports = {
	kbRootFor,
	projectFolderPrefixForNote,
	listTagsForNote,
	createTagForNote,
	knownTagsLowerForNote
};
