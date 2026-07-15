'use strict';

const vscode = require('vscode');

/**
 * Explorer-style "New…" menu (folder / .md file / .d.txt note).
 * @param {import('vscode').Uri | undefined} targetUri Optional folder from tree selection.
 */
async function showKbNewMenu(targetUri) {
	const pick = await vscode.window.showQuickPick(
		[
			{
				label: 'New Folder',
				description: 'Create a folder in the knowledge base',
				command: 'drip.createFolder',
				iconPath: new vscode.ThemeIcon('new-folder')
			},
			{
				label: 'New File',
				description: 'Create a new .md file',
				command: 'drip.createMarkdownFile',
				iconPath: new vscode.ThemeIcon('file-add')
			},
			{
				label: 'New Note',
				description: 'Create a new .d.txt note',
				command: 'drip.createNoteFile',
				iconPath: new vscode.ThemeIcon('notebook')
			}
		],
		{
			title: 'New',
			placeHolder: 'Choose what to create'
		}
	);
	if (!pick) {
		return;
	}
	const arg = targetUri ? { uri: targetUri.toString() } : undefined;
	await vscode.commands.executeCommand(pick.command, arg);
}

module.exports = {
	showKbNewMenu
};
