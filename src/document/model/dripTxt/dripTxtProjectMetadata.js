'use strict';

/**
 * Per-project metadata overrides.
 *
 * Project-scoped metadata (the `project`, `feature`, and `issue` types) can be
 * customized per project. Those overrides live in a single sidecar file at the
 * KB root — `.dripindex/settings-project.drip.json` — never inside the project
 * folder, so project directories stay clean and portable.
 *
 * The file is keyed by the project's folder prefix (e.g. `sample/kjh.p/`):
 *
 *   {
 *     "format": "drip-project-settings",
 *     "version": 1,
 *     "savedAt": "…",
 *     "projects": {
 *       "sample/kjh.p/": {
 *         "project": { "attributes": { … } },
 *         "feature":  { "attributes": { … } },
 *         "issue":    { "attributes": { … } }
 *       }
 *     }
 *   }
 *
 * A type override only needs to carry the attributes the user changed; the
 * default template fills in everything else at resolution time (see
 * `applyProjectOverrideToTypes` in `dripTxtMetadataTemplates.js`).
 */

const vscode = require('vscode');
const path = require('path');
const { isDripProjectFolderName } = require('../dripNoteProjectFolder.js');

const PROJECT_SETTINGS_FILE = 'settings-project.drip.json';

/** Active KB root (normalized fsPath). Only one KB is bound at a time. */
let activeKbRootPath = '';
/** @type {Record<string, Record<string, any>>} project prefix → { project?, feature?, issue? } */
let overridesByProject = {};

/**
 * @param {import('vscode').Uri} kbRoot
 * @returns {import('vscode').Uri}
 */
function getProjectSettingsFileUri(kbRoot) {
	return vscode.Uri.joinPath(kbRoot, '.dripindex', PROJECT_SETTINGS_FILE);
}

function normalizeKey(key) {
	return String(key || '').replace(/\\/g, '/');
}

/**
 * Load per-project overrides from the KB root into the in-memory cache.
 * Called at startup / KB switch; also re-called when the settings webview needs
 * the current map. Returns a plain object for easy JSON serialization.
 *
 * @param {import('vscode').Uri | undefined} kbRoot
 * @returns {Promise<Record<string, Record<string, any>>>}
 */
async function loadProjectMetadataSettings(kbRoot) {
	overridesByProject = {};
	if (!kbRoot) {
		activeKbRootPath = '';
		return overridesByProject;
	}
	activeKbRootPath = normalizeKey(kbRoot.fsPath);
	try {
		const buf = await vscode.workspace.fs.readFile(getProjectSettingsFileUri(kbRoot));
		const parsed = JSON.parse(Buffer.from(buf).toString('utf8'));
		const projects = parsed && parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {};
		for (const key of Object.keys(projects)) {
			overridesByProject[normalizeKey(key)] = projects[key];
		}
	} catch {
		// File missing or unreadable → empty map.
	}
	return overridesByProject;
}

/**
 * Persist one project's overrides into `settings-project.drip.json` (merging
 * with any existing entries) and update the in-memory cache.
 *
 * @param {import('vscode').Uri} kbRoot
 * @param {string} projectKey KB-relative folder prefix, e.g. `sample/kjh.p/`
 * @param {Record<string, any>} overrides { project?, feature?, issue? }
 */
async function saveProjectMetadataSettings(kbRoot, projectKey, overrides) {
	// Ensure `.dripindex/` exists before writing (the KB may not have been indexed yet).
	const dripIndexDir = vscode.Uri.joinPath(kbRoot, '.dripindex');
	try {
		await vscode.workspace.fs.stat(dripIndexDir);
	} catch {
		await vscode.workspace.fs.createDirectory(dripIndexDir);
	}
	const uri = getProjectSettingsFileUri(kbRoot);
	let parsed = {
		format: 'drip-project-settings',
		version: 1,
		savedAt: new Date().toISOString(),
		projects: {}
	};
	try {
		const buf = await vscode.workspace.fs.readFile(uri);
		const existing = JSON.parse(Buffer.from(buf).toString('utf8'));
		if (existing && typeof existing === 'object') {
			parsed = existing;
		}
	} catch {
		// Missing/unreadable → start fresh.
	}
	if (!parsed.projects || typeof parsed.projects !== 'object') {
		parsed.projects = {};
	}
	parsed.format = 'drip-project-settings';
	parsed.version = 1;
	parsed.savedAt = new Date().toISOString();
	parsed.projects[normalizeKey(projectKey)] = overrides || {};

	await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(parsed, null, 2), 'utf8'));
	overridesByProject[normalizeKey(projectKey)] = overrides || {};
}

/**
 * Synchronous lookup of one project's overrides from the in-memory cache.
 * @param {string} projectKey
 * @returns {Record<string, any> | null}
 */
function getProjectMetadataOverrides(projectKey) {
	if (!projectKey) return null;
	return overridesByProject[normalizeKey(projectKey)] || null;
}

/**
 * The KB-relative project folder prefix for an absolute note path, e.g.
 * `sample/kjh.p/`, or '' when the note is outside any project (or no KB root
 * is active).
 * @param {string} fsPath absolute file path
 * @returns {string}
 */
function projectKeyForFsPath(fsPath) {
	const root = activeKbRootPath;
	if (!root || !fsPath) return '';
	let rel = path.relative(root, fsPath);
	if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) return '';
	rel = rel.replace(/\\/g, '/');
	const parts = rel.split('/').filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		if (isDripProjectFolderName(parts[i])) {
			return parts.slice(0, i + 1).join('/') + '/';
		}
	}
	return '';
}

/** Clear the in-memory cache (used when the KB changes or settings reset). */
function invalidateProjectMetadataCache() {
	activeKbRootPath = '';
	overridesByProject = {};
}

module.exports = {
	PROJECT_SETTINGS_FILE,
	getProjectSettingsFileUri,
	loadProjectMetadataSettings,
	saveProjectMetadataSettings,
	getProjectMetadataOverrides,
	projectKeyForFsPath,
	invalidateProjectMetadataCache
};
