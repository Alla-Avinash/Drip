'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { getNonce } = require('../../../shared/utils');

const STORAGE_BODY_HTML = fs.readFileSync(path.join(__dirname, 'webview', 'storageBody.html'), 'utf8');

/**
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} extensionUri
 */
function getStorageWebviewHtml(webview, extensionUri) {
	const nonce = getNonce();
	const cssUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'src', 'views', 'rhs', 'storage', 'webview', 'storage.css')
	);
	const jsUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'src', 'views', 'rhs', 'storage', 'webview', 'storage.js')
	);

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>DRIP Storage</title>
	<link rel="stylesheet" href="${cssUri}">
</head>
${STORAGE_BODY_HTML}
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

module.exports = {
	getStorageWebviewHtml
};
