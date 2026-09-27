'use strict';

const vscode = require('vscode');
const {
	DRIP_SETTINGS_KEYS,
	buildFreshKnowledgeBaseSettingsObject,
	buildDefaultSettingsSnapshot,
	ensureDripIndexSkeleton,
	getSettingsDripFileUri
} = require('./initializeDripIndex');

const LEGACY_SETTINGS_FILE = 'settings.drip';

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
 * @param {unknown} parsed
 * @returns {Record<string, unknown> | null}
 */
function extractSettingsObject(parsed) {
	if (!parsed || typeof parsed !== 'object') {
		return null;
	}
	const envelope = /** @type {{ settings?: Record<string, unknown> }} */ (parsed);
	if (envelope.settings && typeof envelope.settings === 'object') {
		return envelope.settings;
	}
	return null;
}

/**
 * @param {import('vscode').Uri} fileUri
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function readSettingsObjectFromFile(fileUri) {
	try {
		const buf = await vscode.workspace.fs.readFile(fileUri);
		const parsed = JSON.parse(Buffer.from(buf).toString('utf8'));
		return extractSettingsObject(parsed);
	} catch (err) {
		console.error('[DRIP] read settings file failed', fileUri.toString(), err);
		return null;
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<import('vscode').Uri | undefined>}
 */
async function resolveKbSettingsFileUri(kbRootUri) {
	const primary = getSettingsDripFileUri(kbRootUri);
	if (await uriExists(primary)) {
		return primary;
	}
	const legacy = vscode.Uri.joinPath(kbRootUri, '.dripindex', LEGACY_SETTINGS_FILE);
	if (await uriExists(legacy)) {
		return legacy;
	}
	return undefined;
}

/**
 * @param {Record<string, unknown>} settings
 */
async function applySettingsObjectToWorkspace(settings) {
	const cfg = vscode.workspace.getConfiguration('drip');
	for (const key of DRIP_SETTINGS_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(settings, key)) {
			continue;
		}
		try {
			await cfg.update(key, settings[key], vscode.ConfigurationTarget.Workspace);
		} catch (err) {
			console.error('[DRIP] apply settings key failed', key, err);
		}
	}
}

/**
 * @returns {Record<string, unknown>}
 */
function readWorkspaceDripSettingsObject() {
	const cfg = vscode.workspace.getConfiguration('drip');
	/** @type {Record<string, unknown>} */
	const settings = {};
	for (const key of DRIP_SETTINGS_KEYS) {
		settings[key] = cfg.get(key);
	}
	return settings;
}

/**
 * Apply `settings.drip.json` values into workspace `drip.*` configuration.
 * When no KB settings file exists, applies DRIP defaults (does not create a file).
 * @param {import('vscode').Uri} kbRootUri
 */
async function loadSettingsFromDripIndex(kbRootUri) {
	await ensureDripIndexSkeleton(kbRootUri);
	const settingsUri = await resolveKbSettingsFileUri(kbRootUri);
	if (!settingsUri) {
		await applySettingsObjectToWorkspace(buildFreshKnowledgeBaseSettingsObject());
		return { loaded: 'defaults' };
	}

	const settings = await readSettingsObjectFromFile(settingsUri);
	if (!settings) {
		await applySettingsObjectToWorkspace(buildFreshKnowledgeBaseSettingsObject());
		return { loaded: 'defaults' };
	}

	await applySettingsObjectToWorkspace(settings);
	return { loaded: 'file', fileUri: settingsUri };
}

/**
 * KB-only keys stored in settings.drip.json but not as `drip.*` VS Code config.
 * Must be preserved when rewriting the file from workspace settings.
 * @param {import('vscode').Uri} settingsUri
 * @returns {Promise<Record<string, unknown>>}
 */
async function readPreservedKbOnlySettings(settingsUri) {
	/** @type {Record<string, unknown>} */
	const preserved = {};
	const existing = await readSettingsObjectFromFile(settingsUri);
	if (existing && existing.githubBackup != null) {
		preserved.githubBackup = existing.githubBackup;
	}
	return preserved;
}

/**
 * Persist current workspace `drip.*` settings into `.dripindex/settings.drip.json`.
 * @param {import('vscode').Uri} kbRootUri
 */
async function saveSettingsToDripIndex(kbRootUri) {
	await ensureDripIndexSkeleton(kbRootUri);
	const settingsUri = getSettingsDripFileUri(kbRootUri);
	const preserved = await readPreservedKbOnlySettings(settingsUri);
	const snapshot = {
		format: 'drip-settings',
		version: 1,
		savedAt: new Date().toISOString(),
		settings: {
			...readWorkspaceDripSettingsObject(),
			...preserved
		}
	};
	await vscode.workspace.fs.writeFile(
		settingsUri,
		Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8')
	);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<import('vscode').Uri | undefined>}
 */
async function pickSettingsImportFile() {
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		openLabel: 'Import DRIP settings',
		filters: { 'DRIP settings': ['json'] }
	});
	return picked && picked.length ? picked[0] : undefined;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<import('vscode').Uri | undefined>}
 */
async function pickSettingsExportFile(kbRootUri) {
	const defaultUri = getSettingsDripFileUri(kbRootUri);
	const picked = await vscode.window.showSaveDialog({
		defaultUri,
		saveLabel: 'Export DRIP settings',
		filters: { 'DRIP settings': ['json'] }
	});
	return picked;
}

/**
 * Import settings from a user-selected `settings.drip.json` and save to the active KB.
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} [sourceUri]
 */
async function importSettingsToKnowledgeBase(kbRootUri, sourceUri) {
	const fromUri = sourceUri || (await pickSettingsImportFile());
	if (!fromUri) {
		return { ok: false, cancelled: true };
	}

	const settings = await readSettingsObjectFromFile(fromUri);
	if (!settings) {
		void vscode.window.showErrorMessage('DRIP could not read settings from the selected file.');
		return { ok: false };
	}

	await applySettingsObjectToWorkspace(settings);
	await saveSettingsToDripIndex(kbRootUri);
	// githubBackup is KB-file-only (not drip.* config); re-apply after workspace save.
	if (settings.githubBackup != null) {
		const settingsUri = getSettingsDripFileUri(kbRootUri);
		const envelope = {
			format: 'drip-settings',
			version: 1,
			savedAt: new Date().toISOString(),
			settings: {
				...(await readSettingsObjectFromFile(settingsUri)),
				githubBackup: settings.githubBackup
			}
		};
		await vscode.workspace.fs.writeFile(
			settingsUri,
			Buffer.from(JSON.stringify(envelope, null, 2), 'utf8')
		);
	}
	void vscode.window.showInformationMessage('DRIP settings imported into the current knowledge base.');
	return { ok: true };
}

/**
 * Export current workspace DRIP settings to a user-selected file.
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} [destUri]
 */
async function exportSettingsFromKnowledgeBase(kbRootUri, destUri) {
	const toUri = destUri || (await pickSettingsExportFile(kbRootUri));
	if (!toUri) {
		return { ok: false, cancelled: true };
	}

	const settingsUri = getSettingsDripFileUri(kbRootUri);
	const preserved = await readPreservedKbOnlySettings(settingsUri);
	const snapshot = {
		format: 'drip-settings',
		version: 1,
		savedAt: new Date().toISOString(),
		settings: {
			...readWorkspaceDripSettingsObject(),
			...preserved
		}
	};
	await vscode.workspace.fs.writeFile(
		toUri,
		Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8')
	);
	void vscode.window.showInformationMessage(`DRIP settings exported to ${toUri.fsPath}`);
	return { ok: true, fileUri: toUri };
}

module.exports = {
	loadSettingsFromDripIndex,
	saveSettingsToDripIndex,
	importSettingsToKnowledgeBase,
	exportSettingsFromKnowledgeBase,
	resolveKbSettingsFileUri,
	readWorkspaceDripSettingsObject
};
