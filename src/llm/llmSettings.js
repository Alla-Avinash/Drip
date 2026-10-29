'use strict';

/**
 * DRIP LLM settings: multiple named OpenAI-compatible provider profiles.
 *
 * Non-secret config (name, base URL, model, enabled) lives in extension
 * globalState; each profile's API key lives in Secret Storage (never in
 * settings JSON) — same pattern as the GitHub backup PAT. One profile is
 * "active" at a time; Quick Capture, ingest, and chat all use the active one.
 *
 * Legacy single-config installs (`drip.llm.*` settings + the `drip.llm.apiKey`
 * secret) are migrated once into a "Default" profile on first load.
 */

const vscode = require('vscode');

const PROFILES_KEY = 'drip.llm.profiles.v1';
const ACTIVE_PROFILE_KEY = 'drip.llm.activeProfileId.v1';
const LEGACY_SECRET = 'drip.llm.apiKey';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

/** @param {string} id */
function profileSecretKey(id) {
	return `drip.llm.apiKey.${id}`;
}

function newProfileId() {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** @type {Set<() => void>} */
const _settingsListeners = new Set();

/**
 * Subscribe to LLM settings changes (profiles, active profile, enabled flag,
 * or API key). The chat re-reads its config through this so it never keeps a
 * stale "LLM is off" state after the user enables a provider or saves a key.
 * @param {() => void} fn
 * @returns {{ dispose: () => void }}
 */
function onLlmSettingsChanged(fn) {
	_settingsListeners.add(fn);
	return { dispose: () => _settingsListeners.delete(fn) };
}

/** @returns {void} */
function emitLlmSettingsChanged() {
	for (const fn of _settingsListeners) fn();
}

/**
 * Normalize a raw profile into a safe shape, minting an id when missing.
 * @param {{ id?: string, name?: string, baseUrl?: string, model?: string, enabled?: boolean }} p
 * @returns {{ id: string, name: string, baseUrl: string, model: string, enabled: boolean }}
 */
function normalizeProfile(p) {
	const id = String((p && p.id) || '').trim() || newProfileId();
	return {
		id,
		name: String((p && p.name) || '').trim() || 'Provider',
		baseUrl: String((p && p.baseUrl) || '').trim() || DEFAULT_BASE_URL,
		model: String((p && p.model) || '').trim() || DEFAULT_MODEL,
		enabled: !!(p && p.enabled)
	};
}

/**
 * Read (and lazily seed) the profile list synchronously. The first call on a
 * legacy install builds a "Default" profile from the old `drip.llm.*` settings.
 * @param {import('vscode').ExtensionContext} context
 * @returns {Array<{ id: string, name: string, baseUrl: string, model: string, enabled: boolean }>}
 */
function readProfiles(context) {
	let profiles = context.globalState.get(PROFILES_KEY);
	if (!Array.isArray(profiles) || !profiles.length) {
		const c = vscode.workspace.getConfiguration('drip');
		profiles = [
			normalizeProfile({
				name: 'Default',
				baseUrl: c.get('llm.baseUrl', DEFAULT_BASE_URL),
				model: c.get('llm.model', DEFAULT_MODEL),
				enabled: c.get('llm.enabled', false) === true
			})
		];
		void context.globalState.update(PROFILES_KEY, profiles);
	}
	return profiles.map(normalizeProfile);
}

/** @param {import('vscode').ExtensionContext} context */
function getActiveProfileId(context) {
	const profiles = readProfiles(context);
	const saved = String(context.globalState.get(ACTIVE_PROFILE_KEY) || '').trim();
	if (saved && profiles.some(p => p.id === saved)) return saved;
	const first = profiles[0] ? profiles[0].id : '';
	if (first) void context.globalState.update(ACTIVE_PROFILE_KEY, first);
	return first;
}

/**
 * Active profile's non-secret config (sync). Capture, ingest, and chat read
 * `enabled / baseUrl / model` from here.
 * @param {import('vscode').ExtensionContext} context
 */
function getLlmConfig(context) {
	const profiles = readProfiles(context);
	const active = profiles.find(p => p.id === getActiveProfileId(context)) || profiles[0];
	if (!active) {
		return { enabled: false, baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL };
	}
	return { enabled: active.enabled, baseUrl: active.baseUrl, model: active.model };
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} [profileId] — defaults to the active profile.
 * @returns {Promise<string>}
 */
async function getLlmApiKey(context, profileId) {
	const id = profileId || getActiveProfileId(context);
	if (!id) {
		return String((await context.secrets.get(LEGACY_SECRET)) || '').trim();
	}
	let key = String((await context.secrets.get(profileSecretKey(id))) || '').trim();
	if (!key && !profileId) {
		// Safety net for pre-migration installs: fall back to the legacy secret.
		key = String((await context.secrets.get(LEGACY_SECRET)) || '').trim();
	}
	return key;
}

/**
 * Non-secret config for a specific profile (for the "test connection" flow).
 * @param {import('vscode').ExtensionContext} context
 * @param {string} profileId
 * @returns {{ enabled: boolean, baseUrl: string, model: string, name: string } | null}
 */
function getLlmConfigForProfile(context, profileId) {
	const p = readProfiles(context).find(x => x.id === profileId);
	if (!p) return null;
	return { enabled: p.enabled, baseUrl: p.baseUrl, model: p.model, name: p.name };
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} key
 * @param {string} [profileId]
 */
async function setLlmApiKey(context, key, profileId) {
	const id = profileId || getActiveProfileId(context);
	const v = String(key || '').trim();
	if (!id) {
		if (v) await context.secrets.store(LEGACY_SECRET, v);
		else await context.secrets.delete(LEGACY_SECRET);
		emitLlmSettingsChanged();
		return;
	}
	if (v) await context.secrets.store(profileSecretKey(id), v);
	else await context.secrets.delete(profileSecretKey(id));
	emitLlmSettingsChanged();
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} [profileId]
 */
async function clearLlmApiKey(context, profileId) {
	const id = profileId || getActiveProfileId(context);
	if (!id) {
		await context.secrets.delete(LEGACY_SECRET);
		emitLlmSettingsChanged();
		return;
	}
	await context.secrets.delete(profileSecretKey(id));
	emitLlmSettingsChanged();
}

/**
 * Full status for the Settings UI: every profile (with `hasKey`) + active id.
 * @param {import('vscode').ExtensionContext} context
 */
async function getLlmStatus(context) {
	const profiles = readProfiles(context);
	const activeProfileId = getActiveProfileId(context);
	const out = [];
	for (const p of profiles) {
		out.push({
			id: p.id,
			name: p.name,
			baseUrl: p.baseUrl,
			model: p.model,
			enabled: p.enabled,
			hasKey: !!(await context.secrets.get(profileSecretKey(p.id)))
		});
	}
	return { profiles: out, activeProfileId };
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {{ name?: string, baseUrl?: string, model?: string, enabled?: boolean }} profile
 */
async function addLlmProfile(context, profile) {
	const profiles = readProfiles(context);
	const created = normalizeProfile(profile || {});
	await context.globalState.update(PROFILES_KEY, [...profiles, created]);
	if (!getActiveProfileId(context)) {
		await context.globalState.update(ACTIVE_PROFILE_KEY, created.id);
	}
	emitLlmSettingsChanged();
	return created;
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} id
 * @param {{ name?: string, baseUrl?: string, model?: string, enabled?: boolean }} patch
 */
async function updateLlmProfile(context, id, patch) {
	const profiles = readProfiles(context);
	const next = profiles.map(p => {
		if (p.id !== id) return p;
		return normalizeProfile({ ...p, ...(patch || {}), id });
	});
	await context.globalState.update(PROFILES_KEY, next);
	emitLlmSettingsChanged();
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} id
 */
async function deleteLlmProfile(context, id) {
	const profiles = readProfiles(context);
	const next = profiles.filter(p => p.id !== id);
	await context.globalState.update(PROFILES_KEY, next);
	await context.secrets.delete(profileSecretKey(id));
	if (getActiveProfileId(context) === id) {
		await context.globalState.update(ACTIVE_PROFILE_KEY, next[0] ? next[0].id : '');
	}
	emitLlmSettingsChanged();
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} id
 */
async function setActiveLlmProfile(context, id) {
	if (!readProfiles(context).some(p => p.id === id)) return;
	await context.globalState.update(ACTIVE_PROFILE_KEY, id);
	emitLlmSettingsChanged();
}

/**
 * One-time migration: copy the legacy `drip.llm.apiKey` secret into the active
 * profile's slot, then clear the legacy slot so older installs keep their key.
 * @param {import('vscode').ExtensionContext} context
 */
async function migrateLegacyLlmSettings(context) {
	const legacy = String((await context.secrets.get(LEGACY_SECRET)) || '').trim();
	if (!legacy) return;
	const activeId = getActiveProfileId(context);
	if (!activeId) return;
	const existing = String((await context.secrets.get(profileSecretKey(activeId))) || '').trim();
	if (!existing) {
		await context.secrets.store(profileSecretKey(activeId), legacy);
	}
	await context.secrets.delete(LEGACY_SECRET);
	emitLlmSettingsChanged();
}

module.exports = {
	PROFILES_KEY,
	ACTIVE_PROFILE_KEY,
	DEFAULT_BASE_URL,
	DEFAULT_MODEL,
	onLlmSettingsChanged,
	getLlmConfig,
	getLlmConfigForProfile,
	getLlmApiKey,
	setLlmApiKey,
	clearLlmApiKey,
	getLlmStatus,
	addLlmProfile,
	updateLlmProfile,
	deleteLlmProfile,
	setActiveLlmProfile,
	migrateLegacyLlmSettings
};
