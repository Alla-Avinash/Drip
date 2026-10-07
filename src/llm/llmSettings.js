'use strict';

/**
 * DRIP LLM settings: provider-agnostic OpenAI-compatible config.
 * Non-secret config lives in VS Code `drip.llm.*` settings; the API key lives in
 * Secret Storage (never in settings JSON) — same pattern as the GitHub backup PAT.
 */

const vscode = require('vscode');

const API_KEY_SECRET = 'drip.llm.apiKey';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * @returns {{ enabled: boolean, baseUrl: string, model: string }}
 */
function getLlmConfig() {
	const c = vscode.workspace.getConfiguration('drip');
	return {
		enabled: c.get('llm.enabled', false) === true,
		baseUrl: String(c.get('llm.baseUrl', DEFAULT_BASE_URL) || '').trim() || DEFAULT_BASE_URL,
		model: String(c.get('llm.model', DEFAULT_MODEL) || '').trim() || DEFAULT_MODEL
	};
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @returns {Promise<string>}
 */
async function getLlmApiKey(context) {
	try {
		return String((await context.secrets.get(API_KEY_SECRET)) || '').trim();
	} catch {
		return '';
	}
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} key
 */
async function setLlmApiKey(context, key) {
	const v = String(key || '').trim();
	if (!v) await context.secrets.delete(API_KEY_SECRET);
	else await context.secrets.store(API_KEY_SECRET, v);
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
async function clearLlmApiKey(context) {
	await context.secrets.delete(API_KEY_SECRET);
}

module.exports = {
	API_KEY_SECRET,
	DEFAULT_BASE_URL,
	DEFAULT_MODEL,
	getLlmConfig,
	getLlmApiKey,
	setLlmApiKey,
	clearLlmApiKey
};
