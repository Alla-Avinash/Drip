'use strict';

/**
 * Host-side controller for the DRIP Settings webview panel: builds the HTML, wires the
 * message handler (settings, LLM profiles, GitHub backup, MCP, project metadata, shortcuts),
 * and keeps the doc-color swatches in sync with theme/config changes.
 */

const vscode = require('vscode');
const { getSettingsWebviewHtml } = require('../settingsWebview');
const {
	saveSettingsToDripIndex,
	importSettingsToKnowledgeBase,
	exportSettingsFromKnowledgeBase
} = require('../../startup/settingsDrip');
const { getSettingsDripFileUri } = require('../../startup/initializeDripIndex');
const { getDefaultKnowledgeBaseSettingsObject } = require('../../startup/defaultKnowledgeBaseSettings');
const { invalidateKbNoteExtensionsCache } = require('../../document/model/dripNoteFileTypes.js');

/** @type {import('vscode').WebviewPanel | null} */
let settingsPanel = null;
/** @type {{ state?: object, context?: import('vscode').ExtensionContext, projectKey?: string }} */
let settingsHost = {};

function getOpenSettingsPanel() {
	return settingsPanel;
}

/**
 * @param {import('vscode').Webview} webview
 * @param {import('../../state/state').DripState} dripState
 * @param {import('vscode').ExtensionContext} [extensionContext]
 */
async function postDripSettingsValuesToWebview(webview, dripState, extensionContext) {
	const c = vscode.workspace.getConfiguration('drip');
	const nt = require('../../document/model/dripNoteFileTypes.js');
	const {
		migrateFileLevelMetadataTypesIfNeeded,
		getMetadataSettings,
		getFileLevelMetadataSettings
	} = require('../../document/model/dripNoteMetadataTemplates.js');
	try {
		await migrateFileLevelMetadataTypesIfNeeded();
	} catch {
		/* ignore migration errors */
	}
	const kbRoot = dripState.getKnowledgeBaseRoot();
	const defs = getDefaultKnowledgeBaseSettingsObject();
	const docTypes = getMetadataSettings().types;
	const fileTypes = getFileLevelMetadataSettings().types;
	/** @type {{ folderPrefix: string, title: string }[]} */
	let projects = [];
	/** @type {Record<string, any>} */
	let projectMetadataOverrides = {};
	if (kbRoot) {
		try {
			const { listProjectsFromIndex } = require('../../indexing/projectViewQuery');
			projects = (await listProjectsFromIndex(kbRoot)).projects.map(p => ({
				folderPrefix: String(p.folderPrefix || ''),
				title: String(p.title || '')
			}));
		} catch (err) {
			console.error('[DRIP] list projects for settings failed', err);
		}
		projectMetadataOverrides = await require('../../document/model/dripTxt/dripTxtProjectMetadata.js').loadProjectMetadataSettings(kbRoot);
	}
	/** @type {unknown} */
	let githubBackupStatus = null;
	if (kbRoot && extensionContext) {
		try {
			const { getBackupStatus } = require('../../startup/githubBackup');
			githubBackupStatus = await getBackupStatus(extensionContext, kbRoot);
		} catch (err) {
			console.error('[DRIP] github backup status failed', err);
		}
	}
	/** @type {unknown} */
	let llmStatus = null;
	if (extensionContext) {
		try {
			llmStatus = await require('../../llm/llmSettings').getLlmStatus(extensionContext);
		} catch (err) {
			console.error('[DRIP] llm status failed', err);
		}
	}
	await webview.postMessage({
		type: 'settingsValues',
		autoOpenComposerOnSidebarReveal: c.get('autoOpenComposerOnSidebarReveal', defs.autoOpenComposerOnSidebarReveal),
		knowledgeBaseFileExtensions: nt.getKbNoteExtensions(),
		defaultNewNoteExtension: nt.getDefaultNewNoteExtension(),
		customTypeMarkers: c.get('dripnoteCustomTypeMarkers', defs.dripnoteCustomTypeMarkers),
		customColors: c.get('dripnoteCustomColors', defs.dripnoteCustomColors),
		metadataTemplatesEnabled: c.get('metadataTemplatesEnabled', defs.metadataTemplatesEnabled),
		metadataStrictValidation: c.get('metadataStrictValidation', defs.metadataStrictValidation),
		metadataIgnoreErrors: c.get('metadataIgnoreErrors', defs.metadataIgnoreErrors),
		metadataAutoInsertTemplate: c.get('metadataAutoInsertTemplate', defs.metadataAutoInsertTemplate),
		metadataShowIndentErrors: c.get('metadataShowIndentErrors', defs.metadataShowIndentErrors),
		showHeadingHierarchyIndentErrors: c.get('showHeadingHierarchyIndentErrors', defs.showHeadingHierarchyIndentErrors),
		metadataUseCustomColors: c.get('metadataUseCustomColors', defs.metadataUseCustomColors),
		metadataTypes: docTypes,
		fileLevelMetadataTypes: fileTypes,
		metadataTypeColors: c.get('metadataTypeColors', defs.metadataTypeColors),
		metadataKeyColor: c.get('metadataKeyColor', defs.metadataKeyColor),
		metadataValueColor: c.get('metadataValueColor', defs.metadataValueColor),
		dripnoteDocColors: c.get('dripnoteDocColors', defs.dripnoteDocColors),
		dripnoteDocThemeColors: require('../editor/themeTokenColors').getDocRoleThemeColors(),
		tagsRelationsConfig: c.get('tagsRelationsConfig', defs.tagsRelationsConfig),
		dripMetadataMarks: c.get('dripMetadataMarks', defs.dripMetadataMarks),
		editHeadingsInFile: c.get('editHeadingsInFile', defs.editHeadingsInFile === true),
		editHeadingsViaRhs: c.get('editHeadingsViaRhs', defs.editHeadingsViaRhs !== false),
		kbSettingsFilePath: kbRoot ? getSettingsDripFileUri(kbRoot).fsPath : '',
		projects,
		projectMetadataOverrides,
		githubBackupStatus,
		llmStatus,
		mcpStatus: await require('../../integrations/mcp/mcpBridge').getMcpStatus(),
		peerIdentity: await readPeerIdentityForSettings()
	});
}

async function readPeerIdentityForSettings() {
	try {
		const me = await require('../../peer/peerIdentity').ensurePeerIdentity();
		return {
			displayName: me.displayName || '',
			peerId: me.peerId || '',
			githubLogin: me.githubLogin || '',
			githubId: me.githubId || ''
		};
	} catch {
		return { displayName: '', peerId: '' };
	}
}

async function postProjectShareToWebview(webview, state, projectKey) {
	settingsHost.state = state;
	settingsHost.projectKey = String(projectKey || '');
	const kbRoot =
		(state.getVerifiedKnowledgeBaseRoot && state.getVerifiedKnowledgeBaseRoot()) ||
		state.getKnowledgeBaseRoot();
	const prefix = String(projectKey || '');
	if (!kbRoot || !prefix) {
		await webview.postMessage({ type: 'projectShareState', projectKey: prefix, shareState: null });
		return;
	}
	const { shareStateForWebview } = require('../../peer/projectShareCommands');
	const shareState = await shareStateForWebview(kbRoot, prefix);
	await webview.postMessage({ type: 'projectShareState', projectKey: prefix, shareState });
}

/**
 * Refresh the open Share settings page after a join, remove, or start/stop.
 * @param {string} [folderPrefix]
 */
function refreshOpenProjectShare(folderPrefix) {
	if (!settingsPanel) return;
	const key = String(folderPrefix || settingsHost.projectKey || '');
	if (!key || !settingsHost.state) return;
	void postProjectShareToWebview(settingsPanel.webview, settingsHost.state, key);
}

/**
 * @param {import('vscode').Webview} webview
 * @param {string} [error]
 */
async function postDripShortcutsToWebview(webview, context, error) {
	try {
		const data = await require('../../startup/dripKeybindings').getDripShortcuts(context);
		await webview.postMessage({ type: 'shortcutsData', ...data, error: error || '' });
	} catch (err) {
		await webview.postMessage({
			type: 'shortcutsData',
			rows: [],
			error: error || (err instanceof Error ? err.message : String(err))
		});
	}
}

async function postLlmStatusToWebview(webview, context) {
	try {
		const status = await require('../../llm/llmSettings').getLlmStatus(context);
		await webview.postMessage({ type: 'llmStatus', status });
	} catch (err) {
		console.error('[DRIP] llm status failed', err);
	}
}

function wireSettingsWebviewMessageHandler(webview, state, context) {
	webview.onDidReceiveMessage(async message => {
		try {
			switch (message.type) {
				case 'requestSettings':
					await postDripSettingsValuesToWebview(webview, state, context);
					break;
				case 'updateSetting':
					{
						const kbRoot = state.getKnowledgeBaseRoot();
						const target = kbRoot
							? vscode.ConfigurationTarget.Workspace
							: vscode.ConfigurationTarget.Global;
						await vscode.workspace
							.getConfiguration('drip')
							.update(message.key, message.value, target);
						if (kbRoot) {
							await saveSettingsToDripIndex(kbRoot);
							invalidateKbNoteExtensionsCache();
						}
					}
					break;
				case 'importKbSettings': {
					const kbRoot = state.getKnowledgeBaseRoot();
					if (!kbRoot) {
						void vscode.window.showWarningMessage(
							'Select a DRIP knowledge base folder before importing settings.'
						);
						break;
					}
					const result = await importSettingsToKnowledgeBase(kbRoot);
					if (result.ok) {
						invalidateKbNoteExtensionsCache();
						await postDripSettingsValuesToWebview(webview, state, context);
					}
					break;
				}
				case 'exportKbSettings': {
					const kbRoot = state.getKnowledgeBaseRoot();
					if (!kbRoot) {
						void vscode.window.showWarningMessage(
							'Select a DRIP knowledge base folder before exporting settings.'
						);
						break;
					}
					await exportSettingsFromKnowledgeBase(kbRoot);
					break;
				}
				case 'openKeyboardShortcuts':
					await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings');
					break;
				case 'openKeybindingsFile':
					await require('../../startup/dripKeybindings').openUserKeybindingsFile(context);
					break;
				case 'requestShortcuts':
					await postDripShortcutsToWebview(webview, context);
					break;
				case 'updateShortcut': {
					let error = '';
					try {
						await require('../../startup/dripKeybindings').updateDripShortcut(
							context,
							String(message.command || ''),
							message.mode,
							message.key
						);
					} catch (err) {
						error = err instanceof Error ? err.message : String(err);
					}
					await postDripShortcutsToWebview(webview, context, error);
					break;
				}
				case 'selectKnowledgeBase':
					await vscode.commands.executeCommand('drip.selectKnowledgeBase');
					break;
				case 'reindexCurrentKbWorkspace':
					await vscode.commands.executeCommand('drip.reindexCurrentKbWorkspace');
					break;
				case 'resetReindexEntireKb':
					await vscode.commands.executeCommand('drip.resetReindexEntireKb');
					break;
				case 'openDripUserSettings':
					await vscode.commands.executeCommand('workbench.action.openSettings', 'drip');
					break;
				case 'runEmbeddingBenchmark':
					await vscode.commands.executeCommand('drip.testEmbeddings');
					break;
				case 'githubBackupSaveRemote':
					await vscode.commands.executeCommand('drip.github.configureRemote', {
						remoteUrl: message.remoteUrl,
						branch: message.branch
					});
					await postDripSettingsValuesToWebview(webview, state, context);
					break;
				case 'githubBackupInit':
					await vscode.commands.executeCommand('drip.github.initRepo');
					await postDripSettingsValuesToWebview(webview, state, context);
					break;
				case 'githubBackupPush':
					await vscode.commands.executeCommand('drip.github.pushBackup');
					await postDripSettingsValuesToWebview(webview, state, context);
					break;
				case 'githubBackupPull':
					await vscode.commands.executeCommand('drip.github.pullBackup');
					await postDripSettingsValuesToWebview(webview, state, context);
					break;
				case 'githubBackupOpen':
					await vscode.commands.executeCommand('drip.github.openRemote');
					break;
				case 'githubBackupSetPat':
					await vscode.commands.executeCommand('drip.github.setPat');
					await postDripSettingsValuesToWebview(webview, state, context);
					break;
				case 'githubBackupClearPat':
					await vscode.commands.executeCommand('drip.github.clearPat');
					await postDripSettingsValuesToWebview(webview, state, context);
					break;
				case 'mcpSetEnabled':
					await require('../../integrations/mcp/mcpBridge').setMcpEnabled(message.value === true);
					break;
				case 'mcpSetPort':
					await require('../../integrations/mcp/mcpBridge').setMcpPort(message.value);
					break;
				case 'mcpCopy':
					await require('../../integrations/mcp/mcpBridge').copyMcpValue(message.kind);
					break;
				case 'mcpRestart':
					await vscode.commands.executeCommand('drip.mcp.restart');
					break;
				case 'mcpRegenerateToken':
					await vscode.commands.executeCommand('drip.mcp.regenerateToken');
					break;
				case 'mcpOpenHealth':
					await vscode.env.openExternal(
						vscode.Uri.parse((await require('../../integrations/mcp/mcpBridge').getMcpStatus()).healthUrl)
					);
					break;
			case 'llmAddProfile':
				{
					await require('../../llm/llmSettings').addLlmProfile(context, message.profile);
					await postLlmStatusToWebview(webview, context);
				}
				break;
			case 'llmUpdateProfile':
				{
					await require('../../llm/llmSettings').updateLlmProfile(context, message.profileId, message.patch);
					await postLlmStatusToWebview(webview, context);
				}
				break;
			case 'llmDeleteProfile':
				{
					await require('../../llm/llmSettings').deleteLlmProfile(context, message.profileId);
					await postLlmStatusToWebview(webview, context);
				}
				break;
			case 'llmSetActiveProfile':
				{
					await require('../../llm/llmSettings').setActiveLlmProfile(context, message.profileId);
					await postLlmStatusToWebview(webview, context);
				}
				break;
			case 'llmSetApiKey':
				{
					const key = String(message.value || '').trim();
					if (key) {
						await require('../../llm/llmSettings').setLlmApiKey(context, key, message.profileId);
					}
					await postLlmStatusToWebview(webview, context);
				}
				break;
			case 'llmClearApiKey':
				await require('../../llm/llmSettings').clearLlmApiKey(context, message.profileId);
				await postLlmStatusToWebview(webview, context);
				break;
			case 'llmTestConnection':
				{
					const profileId = String(message.profileId || '');
					const cfg = require('../../llm/llmSettings').getLlmConfigForProfile(context, profileId);
					const apiKey = await require('../../llm/llmSettings').getLlmApiKey(context, profileId);
					let result;
					if (!cfg) {
						result = { ok: false, message: 'Provider not found.' };
					} else if (!apiKey) {
						result = { ok: false, message: 'No API key saved for this provider.' };
					} else {
						try {
							const { chatComplete } = require('../../llm/llmClient');
							await chatComplete({
								baseUrl: cfg.baseUrl,
								model: cfg.model,
								apiKey,
								maxTokens: 8,
								temperature: 0,
								timeoutMs: 20000,
								messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
							});
							result = { ok: true, message: `Connected — ${cfg.model}` };
						} catch (err) {
							result = { ok: false, message: err instanceof Error ? err.message : String(err) };
						}
					}
					await webview.postMessage({ type: 'llmTestResult', profileId, ...result });
				}
				break;
				case 'requestProjectShare':
					await postProjectShareToWebview(webview, state, message.projectKey);
					break;
				case 'projectShareAction': {
					const kbRoot =
						(state.getVerifiedKnowledgeBaseRoot && state.getVerifiedKnowledgeBaseRoot()) ||
						state.getKnowledgeBaseRoot();
					const { runProjectShareAction } = require('../../peer/projectShareCommands');
					const action = String(message.action || '');
					const prefix = String(message.projectKey || '');
					const result = await runProjectShareAction(kbRoot, prefix, action, {
						title: String(message.projectTitle || ''),
						peerId: String(message.peerId || ''),
						inviteCode: String(message.inviteCode || ''),
						mailboxRepo: String(message.mailboxRepo || ''),
						teamName: String(message.teamName || ''),
						teamId: String(message.teamId || ''),
						memberRole: String(message.memberRole || ''),
						leadPeerId: String(message.leadPeerId || ''),
						guestName: String(message.guestName || ''),
						accessCode: String(message.accessCode || ''),
						accessRole: String(message.accessRole || ''),
						teamIds: Array.isArray(message.teamIds) ? message.teamIds.map(String) : []
					});
					await webview.postMessage({
						type: 'peerIdentity',
						peerIdentity: await readPeerIdentityForSettings()
					});
					if (action === 'joinProject') {
						await postDripSettingsValuesToWebview(webview, state, context);
						if (result && result.folderPrefix) {
							await webview.postMessage({
								type: 'showPanel',
								panel: 'project-sharing',
								projectKey: result.folderPrefix,
								projectTitle: result.title || ''
							});
						}
					} else if (prefix && kbRoot) {
						await postProjectShareToWebview(webview, state, prefix);
					}
					try {
						require('../lhs/projects/panel').refreshProjectViewIfShown();
					} catch {
						/* Project View may not be open */
					}
					break;
				}
				case 'saveProjectMetadata': {
					const kbRoot = state.getKnowledgeBaseRoot();
					if (!kbRoot) {
						void vscode.window.showWarningMessage(
							'Select a DRIP knowledge base folder before saving project metadata.'
						);
						break;
					}
					const pm = require('../../document/model/dripTxt/dripTxtProjectMetadata.js');
					await pm.saveProjectMetadataSettings(kbRoot, message.projectKey, message.overrides);
					await postDripSettingsValuesToWebview(webview, state, context);
					break;
				}
			}
		} catch (error) {
			console.error(error);
		}
	});
}

/** @param {string} [panelId] settings nav id to show (e.g. `mcp`) */
function createOrShowSettingsPanel(context, state, panelId, projectKey, projectTitle) {
	const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;
	if (settingsPanel) {
		settingsHost = { state, context, projectKey: String(projectKey || settingsHost.projectKey || '') };
		settingsPanel.reveal(column, false);
		if (panelId) {
			void settingsPanel.webview.postMessage({
				type: 'showPanel',
				panel: panelId,
				projectKey: projectKey || '',
				projectTitle: projectTitle || ''
			});
		}
		return settingsPanel;
	}
	settingsPanel = vscode.window.createWebviewPanel(
		'drip.settings.editor',
		'DRIP Settings',
		column,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [context.extensionUri]
		}
	);
	settingsPanel.webview.html = getSettingsWebviewHtml(settingsPanel.webview, context.extensionUri, {
		initialPanel: panelId,
		initialProject: projectKey,
		initialProjectTitle: projectTitle
	});
	settingsHost = { state, context, projectKey: String(projectKey || '') };
	wireSettingsWebviewMessageHandler(settingsPanel.webview, state, context);
	const mcpBridge = require('../../integrations/mcp/mcpBridge');
	const panelWebview = settingsPanel.webview;
	const mcpStatusSub = mcpBridge.onMcpStatusChange(async () => {
		void panelWebview.postMessage({ type: 'mcpStatus', status: await mcpBridge.getMcpStatus() });
	});
	settingsPanel.onDidDispose(() => {
		mcpStatusSub.dispose();
		settingsPanel = null;
		settingsHost = {};
	});
	return settingsPanel;
}

// Keep the Doc Coloring swatches in sync with the editor when the theme or token
// color customizations change. Send only the resolved theme colors so any unsaved
// edits in the form are left untouched.
function postDocThemeColors() {
	if (!settingsPanel) return;
	void settingsPanel.webview.postMessage({
		type: 'docThemeColors',
		colors: require('../editor/themeTokenColors').getDocRoleThemeColors()
	});
}

function registerSettingsThemeSync(context) {
	context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(postDocThemeColors));
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration('workbench.colorTheme') ||
				e.affectsConfiguration('editor.tokenColorCustomizations') ||
				e.affectsConfiguration('editor.semanticTokenColorCustomizations')
			) {
				postDocThemeColors();
			}
		})
	);
}

module.exports = {
	createOrShowSettingsPanel,
	getOpenSettingsPanel,
	refreshOpenProjectShare,
	postDripSettingsValuesToWebview,
	postDocThemeColors,
	registerSettingsThemeSync
};
