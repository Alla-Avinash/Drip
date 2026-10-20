'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { getNonce } = require('../shared/utils');
const { DEFAULT_METADATA_TYPES, DEFAULT_FILE_LEVEL_METADATA_TYPES } = require('../document/model/dripNoteMetadataTemplates.js');

const SETTINGS_BODY_HTML = fs.readFileSync(path.join(__dirname, 'settings', 'webview', 'settingsBody.html'), 'utf8');

/**
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} extensionUri
 * @param {{ initialPanel?: string, initialProject?: string, initialProjectTitle?: string }} [opts]
 */
function getSettingsWebviewHtml(webview, extensionUri, opts = {}) {
	const nonce = getNonce();
	const initialPanelJson = JSON.stringify(/^[a-z-]+$/.test(String(opts.initialPanel || '')) ? opts.initialPanel : 'kb');
	const initialProjectJson = JSON.stringify(String(opts.initialProject || ''));
	const initialProjectTitleJson = JSON.stringify(String(opts.initialProjectTitle || ''));
	const defaultTypesJson = JSON.stringify(DEFAULT_METADATA_TYPES).replace(/</g, '\\u003c');
	const defaultFileTypesJson = JSON.stringify(DEFAULT_FILE_LEVEL_METADATA_TYPES).replace(/</g, '\\u003c');

	const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'settings.css'));
	const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'settings.js'));

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>DRIP Settings</title>
	<link rel="stylesheet" href="${cssUri}">
</head>
${SETTINGS_BODY_HTML}
	<script nonce="${nonce}">
		window.__dripSettingsInit = {
			initialPanel: ${initialPanelJson},
			initialProject: ${initialProjectJson},
			initialProjectTitle: ${initialProjectTitleJson},
			defaultMetadataTypes: ${defaultTypesJson},
			defaultFileLevelMetadataTypes: ${defaultFileTypesJson}
		};
	</script>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

module.exports = {
	getSettingsWebviewHtml
};
