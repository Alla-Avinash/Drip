'use strict';

// Entry point for the DRIP extension.
//
// The real entry (`src/extension/extension.js`) pulls in `better-sqlite3` at
// module-load time via its require chain. If that require throws, VS Code would
// otherwise surface a cryptic "There is no data provider registered" message.
//
// Instead we catch the load failure here and activate a "degraded" mode that
// registers empty views and shows the underlying error.

let realExtension = null;
let loadError = null;

try {
	realExtension = require('./src/extension/extension');
} catch (err) {
	loadError = err;
	console.error('[DRIP] failed to load extension entry point:', err);
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

	console.error('[DRIP] activation failed. Original error:', loadError);
	void vscode.window.showErrorMessage('DRIP failed to start.', { detail }, 'Show Logs').then(choice => {
		if (choice === 'Show Logs') {
			void vscode.commands.executeCommand('workbench.action.openLogsFolder');
		}
	});
}

module.exports = {
	activate: realExtension ? realExtension.activate : degradedActivate,
	deactivate: realExtension && realExtension.deactivate ? realExtension.deactivate : undefined
};
