'use strict';

const vscode = require('vscode');

/** @type {import('vscode').Uri | undefined} */
let lightUri;
/** @type {import('vscode').Uri | undefined} */
let darkUri;

/**
 * Note icon for KB `.d.txt` rows: same glyph as codicon `note`, with left inset in the SVG canvas.
 * @param {import('vscode').Uri} extensionUri
 * @returns {{ light: import('vscode').Uri; dark: import('vscode').Uri }}
 */
function getKbNoteTreeIcon(extensionUri) {
	if (!lightUri) {
		const base = vscode.Uri.joinPath(extensionUri, 'src', 'views', 'lhs', 'knowledgebase', 'icons');
		lightUri = vscode.Uri.joinPath(base, 'kb-note-light.svg');
		darkUri = vscode.Uri.joinPath(base, 'kb-note-dark.svg');
	}
	return { light: lightUri, dark: darkUri };
}

module.exports = { getKbNoteTreeIcon };
