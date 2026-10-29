'use strict';

/**
 * Per-project tag graphs.
 *
 * Each project (a `.p` folder) keeps its own tag graph with the same shape as the global
 * KB tag graph (nodes + links + relation types + groups), plus an optional per-node
 * `description` used by the Project View's flat "Tags" popover.
 *
 * Stored in the project's `.drip/tags.json` when that sidecar exists (shared projects),
 * otherwise as one JSON file under `<kb>/.dripindex/project-tags.drip/` keyed by the
 * folder-prefix slug. A project's flat tag list is derived from its root nodes
 * (`parentId === null`), so the graph and the flat list stay in sync.
 */

const vscode = require('vscode');
const tagGraphStore = require('./tagGraphStore');
const { getDripIndexRootUri } = require('../startup/initializeDripIndex');

const PROJECT_TAGS_DIR = 'project-tags.drip';

/** @param {import('vscode').Uri} kbRootUri */
function projectTagsDirUri(kbRootUri) {
	return vscode.Uri.joinPath(getDripIndexRootUri(kbRootUri), PROJECT_TAGS_DIR);
}

/**
 * Stable file slug for a project folder prefix (e.g. `App.p/` → `app-p`).
 * @param {string} folderPrefix
 * @returns {string}
 */
function slugForProject(folderPrefix) {
	const joined = String(folderPrefix || '')
		.replace(/\\/g, '/')
		.replace(/\/+$/, '')
		.split('/')
		.filter(Boolean)
		.join('-');
	const slug = joined
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || 'project';
}

/** @returns {string} */
function newTagId() {
	return `pt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @returns {import('vscode').Uri}
 */
function projectTagsFileUri(kbRootUri, folderPrefix) {
	return vscode.Uri.joinPath(projectTagsDirUri(kbRootUri), `${slugForProject(folderPrefix)}.json`);
}

/** A fresh, empty per-project graph (same shape as the global KB graph). */
function emptyProjectGraph() {
	return {
		version: 2,
		nodes: [],
		links: [],
		groups: []
	};
}

/**
 * Migrate a legacy flat project-tags payload (`{ version: 1, tags: [{id,name,description}] }`)
 * into a graph: each flat tag becomes one root node carrying its description.
 * @param {unknown} raw
 * @returns {ReturnType<typeof emptyProjectGraph>}
 */
function migrateLegacyFlatProjectTags(raw) {
	const nodes = [];
	const tags = raw && Array.isArray(raw.tags) ? raw.tags : [];
	for (const t of tags) {
		if (!t || typeof t !== 'object') continue;
		const id = String(t.id || '').trim() || newTagId();
		const label = String(t.name || '').trim() || 'tag';
		const node = { id, label, parentId: null, x: undefined, y: undefined, nest: { x: 0, y: 0 }, groupId: '' };
		if (typeof t.description === 'string' && t.description.trim()) {
			node.description = String(t.description).trim();
		}
		nodes.push(node);
	}
	return tagGraphStore.normalizeGraph({
		version: 2,
		nodes,
		links: [],
		groups: []
	});
}

/**
 * @param {unknown} raw
 * @returns {ReturnType<typeof emptyProjectGraph>}
 */
function normalizeProjectGraph(raw) {
	if (!raw || typeof raw !== 'object') return emptyProjectGraph();
	// Legacy v1 flat list (or any payload carrying a `tags` array).
	if (Array.isArray(raw.tags) && !Array.isArray(raw.nodes)) {
		return migrateLegacyFlatProjectTags(raw);
	}
	return tagGraphStore.normalizeGraph(raw);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @returns {Promise<ReturnType<typeof emptyProjectGraph>>}
 */
async function loadProjectGraph(kbRootUri, folderPrefix) {
	if (!kbRootUri) return emptyProjectGraph();
	try {
		const { projectFolderUriFromPrefix, readTagsFile } = require('../peer/projectSidecar');
		const sidecar = await readTagsFile(projectFolderUriFromPrefix(kbRootUri, folderPrefix));
		if (sidecar) return normalizeProjectGraph(sidecar);
	} catch {
		/* fall through to the legacy KB-level file */
	}
	try {
		const buf = await vscode.workspace.fs.readFile(projectTagsFileUri(kbRootUri, folderPrefix));
		const parsed = JSON.parse(Buffer.from(buf).toString('utf8'));
		return normalizeProjectGraph(parsed);
	} catch {
		return emptyProjectGraph();
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {ReturnType<typeof emptyProjectGraph>} graph
 */
async function saveProjectGraph(kbRootUri, folderPrefix, graph) {
	const norm = normalizeProjectGraph(graph);
	const payload = {
		version: 2,
		folderPrefix: String(folderPrefix || '').replace(/\\/g, '/'),
		nodes: norm.nodes,
		links: norm.links,
		groups: norm.groups
	};
	try {
		const { projectFolderUriFromPrefix, isProjectShared, writeTagsFile, readTagsFile } = require('../peer/projectSidecar');
		const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
		if ((await isProjectShared(folderUri)) || (await readTagsFile(folderUri))) {
			await writeTagsFile(folderUri, payload);
			return;
		}
	} catch {
		/* fall through */
	}
	const dir = projectTagsDirUri(kbRootUri);
	await vscode.workspace.fs.createDirectory(dir);
	await vscode.workspace.fs.writeFile(
		projectTagsFileUri(kbRootUri, folderPrefix),
		Buffer.from(JSON.stringify(payload, null, 2), 'utf8')
	);
}

/**
 * Flat tag list for a project, derived from its root nodes (name + description).
 * Used by the Project View's "Tags" popover; sub-tags are graph-only and not listed.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @returns {Promise<{ id: string, name: string, description: string }[]>}
 */
async function loadProjectTags(kbRootUri, folderPrefix) {
	if (!kbRootUri) return [];
	const graph = await loadProjectGraph(kbRootUri, folderPrefix);
	return graph.nodes
		.filter(n => n.parentId == null || n.parentId === '')
		.map(n => ({
			id: String(n.id || ''),
			name: String(n.label || ''),
			description: String(n.description || '')
		}))
		.filter(t => t.name.trim());
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} name
 * @param {string} [description]
 */
async function addProjectTag(kbRootUri, folderPrefix, name, description) {
	const graph = await loadProjectGraph(kbRootUri, folderPrefix);
	const trimmed = String(name || '').trim();
	if (!trimmed) return loadProjectTags(kbRootUri, folderPrefix);
	const node = {
		id: newTagId(),
		label: trimmed,
		parentId: null,
		x: undefined,
		y: undefined,
		nest: { x: 0, y: 0 },
		groupId: ''
	};
	if (String(description || '').trim()) node.description = String(description).trim();
	graph.nodes.push(node);
	await saveProjectGraph(kbRootUri, folderPrefix, graph);
	return loadProjectTags(kbRootUri, folderPrefix);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} tagId
 * @param {string} name
 */
async function renameProjectTag(kbRootUri, folderPrefix, tagId, name) {
	const graph = await loadProjectGraph(kbRootUri, folderPrefix);
	const trimmed = String(name || '').trim();
	if (!trimmed) return loadProjectTags(kbRootUri, folderPrefix);
	tagGraphStore.renameNode(graph, String(tagId || ''), trimmed);
	await saveProjectGraph(kbRootUri, folderPrefix, graph);
	return loadProjectTags(kbRootUri, folderPrefix);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} tagId
 * @param {string} description
 */
async function setProjectTagDescription(kbRootUri, folderPrefix, tagId, description) {
	const graph = await loadProjectGraph(kbRootUri, folderPrefix);
	const node = tagGraphStore.findNode(graph, String(tagId || ''));
	if (node) {
		const trimmed = String(description || '').trim();
		if (trimmed) node.description = trimmed;
		else delete node.description;
		await saveProjectGraph(kbRootUri, folderPrefix, graph);
	}
	return loadProjectTags(kbRootUri, folderPrefix);
}

/**
 * Delete a project tag and its nested sub-tags and links (cascade).
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} tagId
 */
async function deleteProjectTag(kbRootUri, folderPrefix, tagId) {
	const graph = await loadProjectGraph(kbRootUri, folderPrefix);
	tagGraphStore.removeTag(graph, String(tagId || ''));
	await saveProjectGraph(kbRootUri, folderPrefix, graph);
	return loadProjectTags(kbRootUri, folderPrefix);
}

module.exports = {
	projectTagsDirUri,
	slugForProject,
	loadProjectGraph,
	saveProjectGraph,
	loadProjectTags,
	addProjectTag,
	renameProjectTag,
	setProjectTagDescription,
	deleteProjectTag
};
