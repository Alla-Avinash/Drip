'use strict';

const vscode = require('vscode');

/**
 * Explorer-style "New…" menu (folder / project / feature / .d.md / .d.txt note).
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
				label: 'New Project',
				description: 'Create a project folder (.p) with index note',
				command: 'drip.createProjectFolder',
				iconPath: new vscode.ThemeIcon('folder-library')
			},
			{
				label: 'New Feature Folder',
				description: 'Create a feature folder (.f) inside a project',
				command: 'drip.createFeatureFolder',
				iconPath: new vscode.ThemeIcon('folder')
			},
			{
				label: 'New Feature File',
				description: 'Create a feature note (Name.f.d.txt) inside a project',
				command: 'drip.createFeatureFile',
				iconPath: new vscode.ThemeIcon('file')
			},
			{
				label: 'New File',
				description: 'Create a new .d.md file',
				command: 'drip.createMarkdownFile',
				iconPath: new vscode.ThemeIcon('file-add')
			},
			{
				label: 'New Note',
				description: 'Create a new note (default format)',
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
