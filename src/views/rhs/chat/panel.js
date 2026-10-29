'use strict';

const vscode = require('vscode');
const { getDripChatHtml } = require('./chatHtml');
const { runQuickCapture } = require('../../../capture/captureEngine');
const { getLlmConfig, getLlmApiKey, onLlmSettingsChanged } = require('../../../llm/llmSettings');
const { openChatMemoryFile, readChatMemoryItems, saveChatMemoryText } = require('../../../llm/chatMemory');
const { DRIP_CHAT_VIEW_ID } = require('../../../shared/constants');

/** Session transcript cap (display only — never sent to the LLM). */
const SESSION_MAX_MESSAGES = 100;

/**
 * DRIP Chat — RHS secondary-sidebar webview view.
 * Plain-text capture inbox: notes without a heading go through the LLM (merge / append / new).
 *
 * What the LLM sees per message (kept small on purpose):
 *   long-term memory (`src/llm/chatMemory.js`, persists) + short-term memory (this session)
 *   + only the previous exchange + top matching headings + the message.
 * The transcript below is for display; it is cleared on reload or "New chat".
 */
class DripChatWebviewProvider {
	/**
	 * @param {import('vscode').ExtensionContext} context
	 * @param {import('../../../state/state').DripState} state
	 */
	constructor(context, state) {
		this.context = context;
		this.state = state;
		/** @type {import('vscode').WebviewView | undefined} */
		this.view = undefined;
		/** @type {Array<{ role: 'user'|'assistant', text: string, ok?: boolean }>} */
		this.session = [];
		/** Short-term memory for this session (LLM- or user-edited). */
		this.shortTerm = '';
		/** @type {{ user: string, assistant: string } | null} */
		this.lastExchange = null;
		/** Text waiting to be appended to the input once the view is ready. */
		this.pendingInsert = '';
		/** Re-read LLM config whenever profiles/enabled/key change so the view never keeps a stale "off" state. */
		this._llmSettingsListener = onLlmSettingsChanged(() => this.refreshConfig());
	}

	/**
	 * Re-post the current LLM config to the view if it is alive. Fires on LLM
	 * settings changes and when the view becomes visible again.
	 */
	refreshConfig() {
		if (!this.view) return;
		void this.postConfig(this.view.webview);
	}

	/** Clean up the settings listener when the provider is disposed. */
	dispose() {
		this._llmSettingsListener.dispose();
	}

	/** Reveal the chat view in the RHS (used by the focus command / keybinding). */
	reveal() {
		if (this.view) {
			this.view.show(true);
			return;
		}
		void vscode.commands.executeCommand(`${DRIP_CHAT_VIEW_ID}.focus`);
	}

	/**
	 * Append text to the chat input box (not sent) and reveal the chat.
	 * @param {string} text
	 */
	appendToInput(text) {
		const t = String(text || '');
		if (!t.trim()) return;
		if (this.view) {
			void this.view.webview.postMessage({ type: 'appendInput', text: t });
		} else {
			this.pendingInsert = this.pendingInsert ? `${this.pendingInsert}\n${t}` : t;
		}
		this.reveal();
	}

	/**
	 * @param {import('vscode').WebviewView} webviewView
	 */
	resolveWebviewView(webviewView) {
		this.view = webviewView;
		const w = webviewView.webview;
		w.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
		w.html = getDripChatHtml(w);
		webviewView.onDidDispose(() => {
			if (this.view === webviewView) this.view = undefined;
		});
		// Re-check config when the view is shown again (the webview is retained,
		// so its script does not reload and re-request config on its own).
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) this.refreshConfig();
		});
		w.onDidReceiveMessage(message => {
			void this.onMessage(w, message);
		});
	}

	/**
	 * @param {import('vscode').Webview} w
	 */
	async postConfig(w) {
		const cfg = getLlmConfig(this.context);
		const hasKey = !!(await getLlmApiKey(this.context));
		await w.postMessage({
			type: 'config',
			enabled: cfg.enabled,
			hasKey
		});
	}

	/**
	 * @param {import('vscode').Webview} w
	 */
	async postMemory(w) {
		const kbRoot = this.state.getKnowledgeBaseRoot && this.state.getKnowledgeBaseRoot();
		const items = kbRoot ? await readChatMemoryItems(kbRoot) : [];
		await w.postMessage({
			type: 'memory',
			longTerm: items.join('\n'),
			shortTerm: this.shortTerm,
			hasKb: !!kbRoot
		});
	}

	/**
	 * @param {'user'|'assistant'} role
	 * @param {string} text
	 * @param {boolean} [ok]
	 */
	pushSession(role, text, ok) {
		this.session.push({ role, text, ok });
		if (this.session.length > SESSION_MAX_MESSAGES) this.session.splice(0, this.session.length - SESSION_MAX_MESSAGES);
	}

	/**
	 * @param {import('vscode').Webview} w
	 * @param {unknown} message
	 */
	async onMessage(w, message) {
		const kbRoot = this.state.getKnowledgeBaseRoot && this.state.getKnowledgeBaseRoot();
		try {
			switch (message.type) {
				case 'requestConfig':
					await this.postConfig(w);
					await w.postMessage({ type: 'restore', messages: this.session });
					await this.postMemory(w);
					if (this.pendingInsert) {
						await w.postMessage({ type: 'appendInput', text: this.pendingInsert });
						this.pendingInsert = '';
					}
					break;
				case 'capture': {
					const text = String(message.text || '');
					if (!kbRoot) {
						await w.postMessage({ type: 'result', ok: false, message: 'Select a DRIP knowledge base first.' });
						return;
					}
					this.pushSession('user', text);
					let result;
					try {
						result = await runQuickCapture({
							kbRoot,
							noteText: text,
							context: this.context,
							shortTerm: this.shortTerm,
							lastExchange: this.lastExchange,
							onStatus: m => void w.postMessage({ type: 'status', message: m })
						});
					} catch (err) {
						result = { ok: false, message: err instanceof Error ? err.message : String(err) };
					}
					if (typeof result.shortTerm === 'string') this.shortTerm = result.shortTerm;
					this.lastExchange = { user: text, assistant: result.message };
					this.pushSession('assistant', result.message, result.ok);
					await w.postMessage({ type: 'result', ok: result.ok, message: result.message });
					await this.postMemory(w);
					break;
				}
				case 'clearSession':
					this.session = [];
					this.shortTerm = '';
					this.lastExchange = null;
					await this.postMemory(w);
					break;
				case 'saveShortTerm':
					this.shortTerm = String(message.text || '').trim();
					await this.postMemory(w);
					break;
				case 'saveLongTerm':
					if (!kbRoot) {
						void vscode.window.showWarningMessage('Select a DRIP knowledge base first.');
						return;
					}
					await saveChatMemoryText(kbRoot, String(message.text || ''));
					await this.postMemory(w);
					break;
				case 'requestMemory':
					await this.postMemory(w);
					break;
				case 'openMemoryFile':
					if (!kbRoot) {
						void vscode.window.showWarningMessage('Select a DRIP knowledge base first.');
						return;
					}
					await openChatMemoryFile(kbRoot);
					break;
				case 'openSettings':
					await vscode.commands.executeCommand('drip.openDripSettingsView', { panel: 'llm' });
					break;
				default:
					break;
			}
		} catch (err) {
			await w.postMessage({
				type: 'result',
				ok: false,
				message: err instanceof Error ? err.message : String(err)
			});
		}
	}
}

module.exports = { DripChatWebviewProvider };
