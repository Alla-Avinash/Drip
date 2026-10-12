'use strict';

const vscode = require('vscode');
const { escapeHtml, getNonce } = require('../../../shared/utils');

/**
 * Content-Security-Policy for the markdown editor webview.
 * @param {import('vscode').Webview} webview
 * @param {string} nonce
 */
function buildCsp(webview, nonce) {
	return [
		`default-src 'none'`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}' ${webview.cspSource}`,
		// Allow remote/local images so markdown `![]()` and HTML `<img>` render.
		`img-src ${webview.cspSource} https: http: data: blob:`
	].join('; ');
}

/**
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} extensionUri
 * @param {string} fileName
 */
function distUri(webview, extensionUri, fileName) {
	return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', fileName));
}

/**
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} extensionUri
 * @param {import('vscode').Uri} documentUri
 * @param {string} [initialText] document text to seed the editor with on first paint
 * @param {object} [initialSchema] serialized metadata schema (types + allowed relations)
 */
function getDripMdEditorHtml(webview, extensionUri, documentUri, initialText, initialSchema) {
	const nonce = getNonce();
	const cssUri = distUri(webview, extensionUri, 'dripMdEditor.css');
	const runtimeUri = distUri(webview, extensionUri, 'dripMdEditorRuntime.js');
	const fileName = documentUri ? escapeHtml(documentUri.fsPath.split(/[\\/]/).pop() || 'Note') : 'Note';
	// Embed the initial document text as JSON so the editor renders immediately,
	// without waiting on a postMessage round-trip. escapeHtml keeps `</div>` and
	// other markup from breaking out of the hidden element.
	const initialJson = escapeHtml(JSON.stringify(String(initialText || '')));
	const schemaJson = escapeHtml(JSON.stringify(initialSchema || { types: [], allowedRelations: [] }));

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${buildCsp(webview, nonce)}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${fileName}</title>
	<link rel="stylesheet" href="${cssUri}">
</head>
<body>
	<div id="drip-md-editor-initial" hidden>${initialJson}</div>
	<div id="drip-md-editor-schema" hidden>${schemaJson}</div>
	<div id="drip-md-editor-root"></div>
	<script nonce="${nonce}">
		// Registered before the runtime bundle loads, so any failure — even a crash at
		// the very top of the bundled CodeMirror code — is shown instead of a silent blank page.
		(function () {
			function showError(msg) {
				var el = document.getElementById('drip-md-editor-root');
				if (el) {
					// Include the stack so a crash is diagnosable instead of an opaque message.
					el.textContent = 'DRIP editor failed to load: ' + msg;
				}
			}
			window.addEventListener('error', function (e) {
				var err = e.error;
				var stack = err && err.stack ? '\n\n' + err.stack : '';
				console.error('[DRIP] editor error', err || e.message);
				showError((e.message || (err && err.message) || 'unknown error') + stack);
			});
			window.addEventListener('unhandledrejection', function (e) {
				var r = e.reason;
				showError(r && r.message ? r.message : String(r));
			});
			// Catch the runtime bundle failing to load (404 / CSP), which fires on the
			// script element in the capture phase rather than on window.
			document.addEventListener('error', function (e) {
				var t = e.target;
				if (t && t.tagName === 'SCRIPT') {
					showError('script failed to load: ' + (t.src || 'unknown'));
				}
			}, true);
		})();
	</script>
	<script nonce="${nonce}" src="${runtimeUri}"></script>
</body>
</html>`;
}

module.exports = { getDripMdEditorHtml };
