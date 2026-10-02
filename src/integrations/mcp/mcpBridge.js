'use strict';

/**
 * DRIP MCP lifecycle: settings (`drip.mcp.enabled`, `drip.mcp.port`), token in SecretStorage,
 * start/stop, and client-agnostic connection details for DRIP Settings → MCP connection.
 */

const crypto = require('crypto');
const vscode = require('vscode');
const { DripMcpServer } = require('./mcpServer');
const { initToolEmbeddings, warmToolEmbeddings } = require('./toolEmbeddings');
const { listToolCards } = require('./toolCatalog');

const TOKEN_SECRET_KEY = 'drip.mcp.token';
const DEFAULT_PORT = 39217;
const SERVER_NAME = 'drip';

/** @type {DripMcpServer | null} */
let running = null;
/** @type {string | null} */
let lastError = null;
/** @type {import('vscode').ExtensionContext | null} */
let extensionContext = null;
/** @type {Set<() => void>} */
const statusListeners = new Set();

function notifyStatusChange() {
	for (const fn of statusListeners) {
		try {
			fn();
		} catch (err) {
			console.error('[DRIP MCP] status listener', err);
		}
	}
}

/** @param {() => void} fn */
function onMcpStatusChange(fn) {
	statusListeners.add(fn);
	return { dispose: () => statusListeners.delete(fn) };
}

function readMcpSettings() {
	const c = vscode.workspace.getConfiguration('drip');
	const port = Number(c.get('mcp.port', DEFAULT_PORT));
	return {
		enabled: c.get('mcp.enabled', false) === true,
		port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT
	};
}

/** @param {{ regenerate?: boolean }} [opts] */
async function getToken(opts = {}) {
	if (!extensionContext) throw new Error('DRIP MCP is not initialized.');
	let token = opts.regenerate ? '' : await extensionContext.secrets.get(TOKEN_SECRET_KEY);
	if (!token) {
		token = crypto.randomBytes(24).toString('base64url');
		await extensionContext.secrets.store(TOKEN_SECRET_KEY, token);
	}
	return token;
}

/** @param {number} port */
function serverUrl(port) {
	return `http://127.0.0.1:${port}/mcp`;
}

/**
 * Standard remote-server entry (url + headers), accepted by most MCP clients.
 * @param {number} port
 * @param {string} token
 */
function httpClientConfig(port, token) {
	return { mcpServers: { [SERVER_NAME]: { url: serverUrl(port), headers: { Authorization: `Bearer ${token}` } } } };
}

/**
 * For clients that can only launch a command: `mcp-remote` bridges stdio ↔ DRIP's HTTP endpoint.
 * The header value goes through env because Windows mangles spaces inside args.
 * @param {number} port
 * @param {string} token
 */
function stdioClientConfig(port, token) {
	return {
		mcpServers: {
			[SERVER_NAME]: {
				command: 'npx',
				args: ['-y', 'mcp-remote', serverUrl(port), '--header', 'Authorization:${DRIP_AUTH}'],
				env: { DRIP_AUTH: `Bearer ${token}` }
			}
		}
	};
}

/** @param {string} token */
function maskToken(token) {
	return token ? `${token.slice(0, 4)}…${token.slice(-4)}` : '';
}

/** Snapshot for the settings panel (config snippets carry the full token so they can be pasted as-is). */
async function getMcpStatus() {
	const { enabled, port } = readMcpSettings();
	const token = extensionContext ? (await extensionContext.secrets.get(TOKEN_SECRET_KEY)) || '' : '';
	const masked = token ? maskToken(token) : '<token>';
	const full = token || '<token>';
	return {
		enabled,
		running: !!running,
		port,
		url: serverUrl(port),
		healthUrl: `http://127.0.0.1:${port}/health`,
		transport: 'Streamable HTTP (JSON-RPC 2.0)',
		serverName: SERVER_NAME,
		error: lastError,
		hasToken: !!token,
		tokenPreview: masked,
		authHeader: `Authorization: Bearer ${masked}`,
		toolCount: listToolCards().length,
		httpConfigPreview: JSON.stringify(httpClientConfig(port, full), null, 2),
		stdioConfigPreview: JSON.stringify(stdioClientConfig(port, full), null, 2)
	};
}

/** @param {boolean} enabled */
async function setMcpEnabled(enabled) {
	await vscode.workspace.getConfiguration('drip').update('mcp.enabled', !!enabled, vscode.ConfigurationTarget.Global);
}

/** @param {unknown} value */
async function setMcpPort(value) {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1024 || port > 65535) {
		void vscode.window.showWarningMessage('DRIP MCP port must be a whole number between 1024 and 65535.');
		notifyStatusChange();
		return;
	}
	await vscode.workspace.getConfiguration('drip').update('mcp.port', port, vscode.ConfigurationTarget.Global);
}

/** @param {'url' | 'token' | 'header' | 'httpConfig' | 'stdioConfig'} kind */
async function copyMcpValue(kind) {
	const { port } = readMcpSettings();
	const needsToken = kind !== 'url';
	const token = needsToken ? await getToken() : '';
	const values = {
		url: () => serverUrl(port),
		token: () => token,
		header: () => `Authorization: Bearer ${token}`,
		httpConfig: () => JSON.stringify(httpClientConfig(port, token), null, 2),
		stdioConfig: () => JSON.stringify(stdioClientConfig(port, token), null, 2)
	};
	const make = values[kind];
	if (!make) return;
	await vscode.env.clipboard.writeText(make());
	void vscode.window.showInformationMessage(
		needsToken ? 'Copied (contains your DRIP MCP token — keep it private).' : 'Copied DRIP MCP server URL.'
	);
	notifyStatusChange();
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {{ getKnowledgeBaseRoot: () => import('vscode').Uri | undefined }} state
 * @param {{ refreshUi?: () => void }} [hooks]
 */
function registerDripMcp(context, state, hooks = {}) {
	extensionContext = context;
	initToolEmbeddings(context);
	const version = String((context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || '0.0.0');

	/** @type {import('./tools/toolShared').ToolContext} */
	const toolContext = {
		extensionContext: context,
		getKbRoot: () => (state.getKnowledgeBaseRoot ? state.getKnowledgeBaseRoot() : undefined),
		refreshUi: () => {
			try {
				require('../../views/lhs/projects/panel').refreshProjectViewIfShown();
			} catch (err) {
				console.error('[DRIP MCP] refresh Project View', err);
			}
			if (hooks.refreshUi) hooks.refreshUi();
		}
	};

	async function stop() {
		if (running) await running.stop();
		running = null;
	}

	/** Serialized so a settings change and a command never start two servers at once. */
	let applyChain = Promise.resolve();
	function applySettings() {
		applyChain = applyChain.then(applySettingsNow, applySettingsNow).finally(notifyStatusChange);
		return applyChain;
	}

	async function applySettingsNow() {
		await stop();
		const { enabled, port } = readMcpSettings();
		lastError = null;
		if (!enabled) return;
		const server = new DripMcpServer({ port, token: await getToken(), version, toolContext });
		try {
			await server.start();
			running = server;
			console.log(`[DRIP MCP] listening on ${server.url}`);
			void warmToolEmbeddings(toolContext.getKbRoot());
		} catch (err) {
			const code = err && /** @type {any} */ (err).code;
			lastError =
				code === 'EADDRINUSE'
					? `Port ${port} is already in use (another DRIP window may be serving MCP). Pick another port.`
					: String(err && err.message ? err.message : err);
			void vscode.window.showWarningMessage(`DRIP MCP did not start: ${lastError}`);
		}
	}

	async function regenerateToken() {
		const pick = await vscode.window.showWarningMessage(
			'Regenerate the DRIP MCP token? Every connected app will need the new token.',
			{ modal: true },
			'Regenerate'
		);
		if (pick !== 'Regenerate') return;
		await getToken({ regenerate: true });
		await applySettings();
		void vscode.window.showInformationMessage('DRIP MCP token regenerated. Update the token in your connected apps.');
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('drip.mcp.openSettings', () =>
			vscode.commands.executeCommand('drip.openDripSettingsView', { panel: 'mcp' })
		),
		vscode.commands.registerCommand('drip.mcp.restart', applySettings),
		vscode.commands.registerCommand('drip.mcp.regenerateToken', regenerateToken),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('drip.mcp')) void applySettings();
			if (e.affectsConfiguration('drip.metadataTypes') || e.affectsConfiguration('drip.metadataTemplatesEnabled')) {
				if (running && typeof running.notifyToolsChanged === 'function') {
					running.notifyToolsChanged();
				}
			}
		}),
		{ dispose: () => void stop() }
	);

	void applySettings();
}

module.exports = {
	registerDripMcp,
	getMcpStatus,
	onMcpStatusChange,
	setMcpEnabled,
	setMcpPort,
	copyMcpValue
};
