'use strict';

const { getNonce } = require('../../../shared/utils');

/**
 * DRIP Chat webview view (RHS secondary sidebar).
 * Transcript is display-only and lives in the provider for this session.
 * Memory panel edits long-term (persistent) and short-term (session) memory.
 *
 * @param {import('vscode').Webview} webview
 */
function getDripChatHtml(webview) {
	const nonce = getNonce();
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>DRIP Chat</title>
	<style>
		html, body { height: 100%; }
		body { font-family: var(--vscode-font-family); margin: 0; padding: 0; color: var(--vscode-foreground); font-size: 13px; display: flex; flex-direction: column; }
		#messages { flex: 1 1 auto; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
		.msg { max-width: 92%; padding: 8px 10px; border-radius: 8px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
		.msg.user { align-self: flex-end; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		.msg.bot { align-self: flex-start; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); }
		.msg.bot.err { border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
		.msg.bot.ok { border-color: var(--vscode-testing-iconPassed, #3fb950); }
		.empty { color: var(--vscode-descriptionForeground); font-size: 12px; text-align: center; margin-top: 24px; padding: 0 12px; line-height: 1.5; }
		#warn { display: none; margin: 8px 12px 0; padding: 8px 10px; border-radius: 6px; background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); color: var(--vscode-inputValidation-warningForeground); font-size: 12px; }
		#warn a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
		#memoryPanel { display: none; flex: 0 0 auto; border-top: 1px solid var(--vscode-panel-border); padding: 8px 10px; max-height: 55%; overflow-y: auto; }
		#memoryPanel.open { display: block; }
		#memoryPanel label { display: block; font-weight: 600; margin: 6px 0 2px; }
		#memoryPanel .hint { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 0 0 4px; }
		#memoryPanel a { color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px; }
		#composer { flex: 0 0 auto; border-top: 1px solid var(--vscode-panel-border); padding: 8px 10px; }
		textarea { width: 100%; box-sizing: border-box; min-height: 56px; max-height: 160px; resize: vertical; padding: 8px; border-radius: 6px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-family: var(--vscode-editor-font-family); font-size: 13px; }
		#memoryPanel textarea { min-height: 48px; font-size: 12px; }
		.row { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
		button { border: none; border-radius: 6px; padding: 5px 10px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		button:disabled { opacity: 0.5; cursor: default; }
		button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	</style>
</head>
<body>
	<div id="messages">
		<div class="empty" id="empty">Write a note without a heading. DRIP finds the closest headings and files it for you.<br><br>Say "remember …" to keep a lasting instruction (e.g. "remember: Rust notes go under Rust Basics").</div>
	</div>
	<div id="warn"></div>
	<div id="memoryPanel">
		<label for="ltInput">Long-term memory</label>
		<p class="hint">Kept across sessions and reloads. One item per line. <a id="openLtFile">Open file</a></p>
		<textarea id="ltInput" placeholder="(empty)"></textarea>
		<div class="row"><button id="saveLt">Save long-term</button></div>
		<label for="stInput">Short-term memory</label>
		<p class="hint">This session only — cleared on reload or New chat.</p>
		<textarea id="stInput" placeholder="(empty)"></textarea>
		<div class="row"><button id="saveSt">Save short-term</button></div>
	</div>
	<div id="composer">
		<textarea id="input" placeholder="Type a note… (Enter to send, Shift+Enter for a new line)"></textarea>
		<div class="row">
			<button id="send">Send</button>
			<button id="memory" class="secondary">Memory</button>
			<button id="clear" class="secondary" title="Clear this session's chat and short-term memory (long-term memory is kept)">New chat</button>
			<button id="settings" class="secondary">LLM Settings</button>
		</div>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const messagesEl = document.getElementById('messages');
		const emptyEl = document.getElementById('empty');
		const warnEl = document.getElementById('warn');
		const inputEl = document.getElementById('input');
		const sendBtn = document.getElementById('send');
		const memoryPanel = document.getElementById('memoryPanel');
		const ltInput = document.getElementById('ltInput');
		const stInput = document.getElementById('stInput');
		let pendingEl = null;
		let busy = false;
		let configOk = false;

		function addMessage(text, cls) {
			if (emptyEl.parentNode) emptyEl.remove();
			const el = document.createElement('div');
			el.className = 'msg ' + (cls || 'bot');
			el.textContent = text;
			messagesEl.appendChild(el);
			messagesEl.scrollTop = messagesEl.scrollHeight;
			return el;
		}

		function refreshSend() {
			sendBtn.disabled = busy || !configOk;
		}

		function applyConfig(cfg) {
			let warn = '';
			if (!cfg.enabled) warn = 'LLM is off. <a data-open-settings>Open LLM Settings</a> to turn it on and set your API key.';
			else if (!cfg.hasKey) warn = 'No API key set. <a data-open-settings>Open LLM Settings</a> to add your key.';
			configOk = !warn;
			refreshSend();
			if (warn) {
				warnEl.innerHTML = warn;
				warnEl.style.display = 'block';
				const a = warnEl.querySelector('a[data-open-settings]');
				if (a) a.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
			} else {
				warnEl.style.display = 'none';
			}
		}

		function send() {
			const text = inputEl.value.trim();
			if (!text || sendBtn.disabled) return;
			addMessage(text, 'user');
			inputEl.value = '';
			busy = true;
			refreshSend();
			pendingEl = addMessage('Working…', 'bot');
			vscode.postMessage({ type: 'capture', text });
		}

		sendBtn.addEventListener('click', send);
		inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				send();
			}
		});
		document.getElementById('settings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
		document.getElementById('memory').addEventListener('click', () => {
			memoryPanel.classList.toggle('open');
			if (memoryPanel.classList.contains('open')) vscode.postMessage({ type: 'requestMemory' });
		});
		document.getElementById('openLtFile').addEventListener('click', () => vscode.postMessage({ type: 'openMemoryFile' }));
		document.getElementById('saveLt').addEventListener('click', () => vscode.postMessage({ type: 'saveLongTerm', text: ltInput.value }));
		document.getElementById('saveSt').addEventListener('click', () => vscode.postMessage({ type: 'saveShortTerm', text: stInput.value }));
		document.getElementById('clear').addEventListener('click', () => {
			vscode.postMessage({ type: 'clearSession' });
			messagesEl.innerHTML = '';
			messagesEl.appendChild(emptyEl);
		});

		window.addEventListener('message', (event) => {
			const msg = event.data;
			if (msg.type === 'restore') {
				messagesEl.innerHTML = '';
				const list = Array.isArray(msg.messages) ? msg.messages : [];
				if (!list.length) messagesEl.appendChild(emptyEl);
				for (const m of list) {
					addMessage(m.text, m.role === 'user' ? 'user' : (m.ok === false ? 'bot err' : 'bot ok'));
				}
			} else if (msg.type === 'config') {
				applyConfig(msg);
			} else if (msg.type === 'memory') {
				if (document.activeElement !== ltInput) ltInput.value = msg.longTerm || '';
				if (document.activeElement !== stInput) stInput.value = msg.shortTerm || '';
			} else if (msg.type === 'appendInput') {
				const add = String(msg.text || '');
				inputEl.value = inputEl.value.trim() ? inputEl.value.replace(/\\s+$/, '') + '\\n' + add : add;
				inputEl.focus();
				inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
				inputEl.scrollTop = inputEl.scrollHeight;
			} else if (msg.type === 'status') {
				if (pendingEl) pendingEl.textContent = msg.message;
			} else if (msg.type === 'result') {
				if (pendingEl) pendingEl.remove();
				pendingEl = null;
				busy = false;
				refreshSend();
				addMessage(msg.message, msg.ok ? 'bot ok' : 'bot err');
			}
		});

		vscode.postMessage({ type: 'requestConfig' });
	</script>
</body>
</html>`;
}

module.exports = { getDripChatHtml };
