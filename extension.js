'use strict';

// Entry point for the DRIP extension.
//
// The real entry (`src/extension/extension.js`) pulls in `better-sqlite3` at
// module-load time via its require chain. If that native module was compiled
// for a different VS Code/Electron ABI (e.g. the user auto-updated VS Code past
// the version this build was published for), that require throws and VS Code
// otherwise surfaces a cryptic "There is no data provider registered" message.
//
// Instead of letting that happen, we catch the load failure here and activate a
// "degraded" mode that registers empty views and shows a clear, actionable error.

let realExtension = null;
let loadError = null;

try {
	realExtension = require('./src/extension/extension');
} catch (err) {
	loadError = err;
	console.error('[DRIP] failed to load extension entry point:', err);
}

/**
 * True when the failure looks like a native-module ABI mismatch (the common case).
 * @param {unknown} err
 * @returns {boolean}
 */
function isNativeModuleError(err) {
	const msg = String((err && err.message) || '');
	return (
		/better-sqlite3/i.test(msg) ||
		/NODE_MODULE_VERSION/i.test(msg) ||
		/compiled against a different/i.test(msg) ||
		/\.node\b/.test(msg) ||
		/DLL initialization/i.test(msg) ||
		/could not be located/i.test(msg) ||
		/not a valid Win32 application/i.test(msg)
	);
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
function registerFallbackViews(context) {
	const vscode = require('vscode');
	const treeIds = [
		'drip.components',
		'drip.knowledgeBase',
		'drip.dailyNotes',
		'drip.drafts',
		'drip.recents'
	];
	const webviewIds = ['drip.storage', 'drip.headingForm', 'drip.chat'];

	const emptyProvider = {
		getChildren: () => [],
		getTreeItem: () => new vscode.TreeItem(''),
		getParent: () => undefined
	};
	for (const id of treeIds) {
		context.subscriptions.push(
			vscode.window.createTreeView(id, { treeDataProvider: emptyProvider })
		);
	}
	for (const id of webviewIds) {
		context.subscriptions.push(
			vscode.window.registerWebviewViewProvider(id, {
				resolveWebviewView(webviewView) {
					webviewView.webview.html = '';
				}
			})
		);
	}
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
function degradedActivate(context) {
	const vscode = require('vscode');
	registerFallbackViews(context);

	const detail =
		loadError && loadError.message ? String(loadError.message) : String(loadError || '');
	const message = isNativeModuleError(loadError)
		? 'DRIP could not load its native database module. Your VS Code version is newer than what this build of DRIP was compiled for — please update the DRIP extension.'
		: 'DRIP failed to start. Check the Extension Host logs for details.';

	console.error('[DRIP] activation failed. Original error:', loadError);
	void vscode.window.showErrorMessage(message, { detail }, 'Show Logs').then(choice => {
		if (choice === 'Show Logs') {
			void vscode.commands.executeCommand('workbench.action.openLogsFolder');
		}
	});
}

module.exports = {
	activate: realExtension ? realExtension.activate : degradedActivate
};
