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
				label: 'New Note',
				description: 'Create a new note (.d.md or .d.txt)',
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

/**
 * New menu for the Projects sidebar (`.drip.project`).
 * @param {import('vscode').Uri | undefined} targetUri
 */
async function showProjectsNewMenu(targetUri) {
	const pick = await vscode.window.showQuickPick(
		[
			{
				label: 'New Project',
				description: 'Create a project folder (.p) with index note',
				command: 'drip.createProjectFolder',
				iconPath: new vscode.ThemeIcon('folder-library')
			},
			{
				label: 'Join project',
				description: 'Paste an invite and add the project here',
				command: 'drip.joinProject',
				iconPath: new vscode.ThemeIcon('link')
			},
			{
				label: 'Import project',
				description: 'Copy a project folder into this knowledge base',
				command: 'drip.importProject',
				iconPath: new vscode.ThemeIcon('cloud-download')
			},
			{
				label: 'New Feature Folder',
				description: 'Create a feature folder (.f) inside a project',
				command: 'drip.createFeatureFolder',
				iconPath: new vscode.ThemeIcon('folder')
			},
			{
				label: 'New Feature File',
				description: 'Create a feature note inside a project',
				command: 'drip.createFeatureFile',
				iconPath: new vscode.ThemeIcon('file')
			},
			{
				label: 'New Note',
				description: 'Create a new note inside a project',
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
	showKbNewMenu,
	showProjectsNewMenu
};
