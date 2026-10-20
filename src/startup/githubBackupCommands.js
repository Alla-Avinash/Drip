'use strict';

/**
 * Registers the `drip.github.*` backup commands. Kept out of the entry file so `activate`
 * stays a thin wiring layer.
 */

const vscode = require('vscode');

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {import('../state/state').DripState} state
 * @param {{ refreshUi: () => void, refreshProjectView: () => void }} callbacks
 */
function registerGithubBackupCommands(context, state, { refreshUi, refreshProjectView }) {
	context.subscriptions.push(
		vscode.commands.registerCommand('drip.github.configureRemote', async opts => {
			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a DRIP knowledge base first.');
				return;
			}
			const { saveRemoteConfig } = require('./githubBackup');
			const o = opts && typeof opts === 'object' ? opts : {};
			let remoteUrl = String(o.remoteUrl || '').trim();
			let branch = String(o.branch || '').trim();
			if (!remoteUrl) {
				remoteUrl =
					(await vscode.window.showInputBox({
						prompt: 'GitHub remote URL (HTTPS or SSH)',
						placeHolder: 'https://github.com/you/my-kb.git',
						ignoreFocusOut: true
					})) || '';
			}
			if (!remoteUrl.trim()) return;
			if (!branch) {
				branch =
					(await vscode.window.showInputBox({
						prompt: 'Branch name',
						value: 'main',
						ignoreFocusOut: true
					})) || 'main';
			}
			await saveRemoteConfig(kbRoot, { remoteUrl: remoteUrl.trim(), branch: branch.trim() || 'main' });
			void vscode.window.showInformationMessage('DRIP GitHub remote saved.');
		}),
		vscode.commands.registerCommand('drip.github.initRepo', async () => {
			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a DRIP knowledge base first.');
				return;
			}
			try {
				const { initBackupRepo, isGitAvailable } = require('./githubBackup');
				if (!(await isGitAvailable())) {
					const open = 'Open Git downloads';
					const pick = await vscode.window.showErrorMessage(
						'Git is not installed or not on PATH.',
						open
					);
					if (pick === open) {
						await vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com/downloads'));
					}
					return;
				}
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'DRIP: initializing GitHub backup…'
					},
					async () => initBackupRepo(context, kbRoot)
				);
				void vscode.window.showInformationMessage('DRIP GitHub backup initialized.');
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				void vscode.window.showErrorMessage(`DRIP GitHub init failed: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('drip.github.pushBackup', async () => {
			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a DRIP knowledge base first.');
				return;
			}
			try {
				const { pushBackup } = require('./githubBackup');
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'DRIP: pushing KB backup…'
					},
					async () => pushBackup(context, kbRoot)
				);
				void vscode.window.showInformationMessage('DRIP knowledge base backup pushed.');
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				void vscode.window.showErrorMessage(`DRIP GitHub push failed: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('drip.github.pullBackup', async () => {
			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a DRIP knowledge base first.');
				return;
			}
			try {
				const { pullBackup } = require('./githubBackup');
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'DRIP: pulling KB backup…'
					},
					async () =>
						pullBackup(context, kbRoot, {
							reindex: async () => {
								await vscode.commands.executeCommand('drip.reindexCurrentKbWorkspace');
							}
						})
				);
				void vscode.window.showInformationMessage('DRIP knowledge base backup pulled.');
				refreshUi();
				refreshProjectView();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				void vscode.window.showErrorMessage(`DRIP GitHub pull failed: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('drip.github.openRemote', async () => {
			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a DRIP knowledge base first.');
				return;
			}
			const { getGithubBackupSettings, githubWebUrl } = require('./githubBackup');
			const cfg = await getGithubBackupSettings(kbRoot);
			const web = githubWebUrl(cfg.remoteUrl);
			if (!web) {
				void vscode.window.showWarningMessage(
					'Set a github.com remote URL first (HTTPS or git@github.com:…).'
				);
				return;
			}
			await vscode.env.openExternal(vscode.Uri.parse(web));
		}),
		vscode.commands.registerCommand('drip.github.setPat', async () => {
			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a DRIP knowledge base first.');
				return;
			}
			const { setStoredPat } = require('./githubBackup');
			const pat = await vscode.window.showInputBox({
				prompt: 'GitHub personal access token (stored in VS Code Secret Storage for this KB)',
				password: true,
				ignoreFocusOut: true,
				placeHolder: 'ghp_… or github_pat_…'
			});
			if (pat == null) return;
			if (!String(pat).trim()) {
				void vscode.window.showWarningMessage('Token was empty — nothing saved.');
				return;
			}
			await setStoredPat(context, kbRoot, pat);
			void vscode.window.showInformationMessage('DRIP GitHub token saved in Secret Storage.');
		}),
		vscode.commands.registerCommand('drip.github.clearPat', async () => {
			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a DRIP knowledge base first.');
				return;
			}
			const { clearStoredPat } = require('./githubBackup');
			await clearStoredPat(context, kbRoot);
			void vscode.window.showInformationMessage('DRIP GitHub token cleared.');
		})
	);
}

module.exports = { registerGithubBackupCommands };
