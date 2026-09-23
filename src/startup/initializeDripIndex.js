'use strict';

const vscode = require('vscode');
const { emptyGraph } = require('../graph/tagGraphStore');
const { getDefaultKnowledgeBaseSettingsObject, buildBundledKnowledgeBaseSettingsSnapshot } = require('./defaultKnowledgeBaseSettings');

const DRIPINDEX_DIR = '.dripindex';
const INDEX_FILE = 'index.drip';
const GRAPHS_DIR = 'graphs.drip';
const SETTINGS_FILE = 'settings.drip.json';
const DRAFTS_DIR = 'drafts.drip';
const RECENTS_FILE = 'recents.drip.json';
const DEFAULT_GRAPH_ID = 'default';
const DEFAULT_GRAPH_NAME = 'Default';

/** Keys mirrored into `settings.drip` (must match `package.json` `drip.*` properties). */
const DRIP_SETTINGS_KEYS = [
	'autoOpenComposerOnSidebarReveal',
	'knowledgeBaseFileExtensions',
	'defaultNewNoteExtension',
	'editHeadingsInFile',
	'editHeadingsViaRhs',
	'experimentalEmbeddings',
	'embeddingModel',
	'dripnoteAllowedMetadataKeys',
	'dripnoteCustomTypeMarkers',
	'dripnoteCustomColors',
	'metadataTemplatesEnabled',
	'metadataStrictValidation',
	'metadataIgnoreErrors',
	'metadataAutoInsertTemplate',
	'metadataShowIndentErrors',
	'showHeadingHierarchyIndentErrors',
	'metadataUseCustomColors',
	'metadataTypes',
	'metadataTypeColors',
	'tagsRelationsConfig',
	'refLinksConfig',
	'dripMetadataMarks',
	'metadataKeyColor',
	'metadataValueColor',
	'canvasVisibleTypeIds',
	'canvasShowHeadingsWithoutType'
];

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {import('vscode').Uri}
 */
function getDripIndexRootUri(kbRootUri) {
	return vscode.Uri.joinPath(kbRootUri, DRIPINDEX_DIR);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {import('vscode').Uri}
 */
function getGraphsDripDirectoryUri(kbRootUri) {
	return vscode.Uri.joinPath(getDripIndexRootUri(kbRootUri), GRAPHS_DIR);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {import('vscode').Uri}
 */
function getSettingsDripFileUri(kbRootUri) {
	return vscode.Uri.joinPath(getDripIndexRootUri(kbRootUri), SETTINGS_FILE);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {import('vscode').Uri}
 */
function getDraftsDripDirectoryUri(kbRootUri) {
	return vscode.Uri.joinPath(getDripIndexRootUri(kbRootUri), DRAFTS_DIR);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {import('vscode').Uri}
 */
function getRecentsDripFileUri(kbRootUri) {
	return vscode.Uri.joinPath(getDripIndexRootUri(kbRootUri), RECENTS_FILE);
}

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
 * Default `drip.*` values written into a new KB's `settings.drip.json`.
 * @returns {Record<string, unknown>}
 */
function buildFreshKnowledgeBaseSettingsObject() {
	return getDefaultKnowledgeBaseSettingsObject();
}

/**
 * Snapshot current workspace `drip.*` settings for export / save.
 * @returns {Record<string, unknown>}
 */
function buildDefaultSettingsSnapshot() {
	return {
		format: 'drip-settings',
		version: 1,
		savedAt: new Date().toISOString(),
		settings: (() => {
			const cfg = vscode.workspace.getConfiguration('drip');
			/** @type {Record<string, unknown>} */
			const settings = {};
			for (const key of DRIP_SETTINGS_KEYS) {
				settings[key] = cfg.get(key);
			}
			return settings;
		})()
	};
}

/**
 * Envelope written when a KB is first initialized.
 * @returns {Record<string, unknown>}
 */
function buildFreshKnowledgeBaseSettingsSnapshot() {
	return buildBundledKnowledgeBaseSettingsSnapshot();
}

/**
 * @param {ReturnType<typeof emptyGraph>} graph
 * @returns {Record<string, unknown>}
 */
function buildDefaultGraphEnvelope(graph) {
	return {
		dripTagGraphExport: true,
		exportFormat: 1,
		graphId: DEFAULT_GRAPH_ID,
		name: DEFAULT_GRAPH_NAME,
		savedAt: new Date().toISOString(),
		graph
	};
}

/**
 * Create `.dripindex/` skeleton under a `.driplock` KB root when missing.
 * Existing files and folders are never overwritten.
 *
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<{ created: boolean, dripIndexUri: import('vscode').Uri, createdParts: string[] }>}
 */
async function ensureDripIndexSkeleton(kbRootUri) {
	const dripIndexUri = getDripIndexRootUri(kbRootUri);
	const createdParts = [];

	const dripIndexExisted = await uriExists(dripIndexUri);
	if (!dripIndexExisted) {
		await vscode.workspace.fs.createDirectory(dripIndexUri);
		createdParts.push(DRIPINDEX_DIR);
	}

	const indexUri = vscode.Uri.joinPath(dripIndexUri, INDEX_FILE);
	const indexMissing = !(await uriExists(indexUri));
	if (indexMissing) {
		createdParts.push(`${DRIPINDEX_DIR}/${INDEX_FILE}`);
	}

	const graphsDirUri = vscode.Uri.joinPath(dripIndexUri, GRAPHS_DIR);
	if (!(await uriExists(graphsDirUri))) {
		await vscode.workspace.fs.createDirectory(graphsDirUri);
		createdParts.push(`${DRIPINDEX_DIR}/${GRAPHS_DIR}`);
	}

	const defaultGraphUri = vscode.Uri.joinPath(graphsDirUri, `${DEFAULT_GRAPH_ID}.json`);
	if (!(await uriExists(defaultGraphUri))) {
		const envelope = buildDefaultGraphEnvelope(emptyGraph());
		await vscode.workspace.fs.writeFile(
			defaultGraphUri,
			Buffer.from(JSON.stringify(envelope, null, 2), 'utf8')
		);
		createdParts.push(`${DRIPINDEX_DIR}/${GRAPHS_DIR}/${DEFAULT_GRAPH_ID}.json`);
	}

	const settingsUri = vscode.Uri.joinPath(dripIndexUri, SETTINGS_FILE);
	if (!(await uriExists(settingsUri))) {
		const snapshot = buildFreshKnowledgeBaseSettingsSnapshot();
		await vscode.workspace.fs.writeFile(
			settingsUri,
			Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8')
		);
		createdParts.push(`${DRIPINDEX_DIR}/${SETTINGS_FILE}`);
	}

	const draftsDirUri = vscode.Uri.joinPath(dripIndexUri, DRAFTS_DIR);
	if (!(await uriExists(draftsDirUri))) {
		await vscode.workspace.fs.createDirectory(draftsDirUri);
		createdParts.push(`${DRIPINDEX_DIR}/${DRAFTS_DIR}`);
	}

	const recentsUri = vscode.Uri.joinPath(dripIndexUri, RECENTS_FILE);
	if (!(await uriExists(recentsUri))) {
		await vscode.workspace.fs.writeFile(
			recentsUri,
			Buffer.from(
				JSON.stringify(
					{
						format: 'drip-recents',
						version: 1,
						updatedAt: new Date().toISOString(),
						files: []
					},
					null,
					2
				),
				'utf8'
			)
		);
		createdParts.push(`${DRIPINDEX_DIR}/${RECENTS_FILE}`);
	}

	if (indexMissing) {
		const { initEmptyDripIndexFile } = require('../indexing/dripIndexDb');
		await initEmptyDripIndexFile(kbRootUri);
	}

	return {
		created: createdParts.length > 0,
		dripIndexUri,
		createdParts
	};
}

module.exports = {
	DRIPINDEX_DIR,
	INDEX_FILE,
	GRAPHS_DIR,
	SETTINGS_FILE,
	DRAFTS_DIR,
	RECENTS_FILE,
	DRIP_SETTINGS_KEYS,
	buildDefaultSettingsSnapshot,
	buildFreshKnowledgeBaseSettingsObject,
	buildFreshKnowledgeBaseSettingsSnapshot,
	getDripIndexRootUri,
	getGraphsDripDirectoryUri,
	getSettingsDripFileUri,
	getDraftsDripDirectoryUri,
	getRecentsDripFileUri,
	ensureDripIndexSkeleton
};
