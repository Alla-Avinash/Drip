'use strict';

const { getNonce } = require('../shared/utils');

function getSidebarHtml(webview) {
	const nonce = getNonce();

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>DRIP</title>
	<style>
		body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
		.card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px; background: var(--vscode-sideBar-background); margin-bottom: 12px; }
		h2, h3, p { margin: 0 0 10px; }
		button { width: 100%; border: none; border-radius: 6px; padding: 8px 10px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); margin-top: 8px; }
		button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		.draft-item { border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; margin-top: 8px; }
		.meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
	</style>
</head>
<body>
	<div class="card">
		<h2>DRIP</h2>
		<p id="kb-root" class="meta">Knowledge base: not selected</p>
		<button id="open-composer">Open Composer</button>
		<button id="select-kb" class="secondary">Select Knowledge Base Folder</button>
	</div>
	<div class="card">
		<h3>Drafts</h3>
		<div id="drafts"></div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const draftsEl = document.getElementById('drafts');
		const kbRootEl = document.getElementById('kb-root');

		document.getElementById('open-composer').addEventListener('click', () => {
			vscode.postMessage({ type: 'openComposer' });
		});

		document.getElementById('select-kb').addEventListener('click', () => {
			vscode.postMessage({ type: 'selectKnowledgeBase' });
		});

		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type !== 'sidebarState') {
				return;
			}

			const state = message.state;
			kbRootEl.textContent = state.kbRootPath
				? 'Knowledge base: ' + state.kbRootPath
				: 'Knowledge base: not selected';

			if (!state.drafts.length) {
				draftsEl.innerHTML = '<p class="meta">No drafts saved yet.</p>';
				return;
			}

			draftsEl.innerHTML = state.drafts.map(draft => \`
				<div class="draft-item">
					<strong>\${escapeHtml(draft.title || 'Untitled Draft')}</strong>
					<div class="meta">\${escapeHtml(draft.priority)} | \${escapeHtml(draft.status)} | \${escapeHtml(draft.updatedAt || '')}</div>
					<button data-draft-id="\${draft.id}" class="secondary">Open Draft</button>
				</div>
			\`).join('');

			for (const button of draftsEl.querySelectorAll('[data-draft-id]')) {
				button.addEventListener('click', () => {
					vscode.postMessage({ type: 'openComposer', draftId: button.getAttribute('data-draft-id') });
				});
			}
		});

		function escapeHtml(value) {
			return String(value)
				.replaceAll('&', '&amp;')
				.replaceAll('<', '&lt;')
				.replaceAll('>', '&gt;')
				.replaceAll('"', '&quot;')
				.replaceAll("'", '&#39;');
		}
	</script>
</body>
</html>`;
}

/** @deprecated Prefer `./composer/composerHtml` — kept for any leftover require. */
function getComposerHtml(webview, extensionUri) {
	return require('./composer/composerHtml').getComposerHtml(webview, extensionUri);
}

module.exports = {
	getComposerHtml,
	getSidebarHtml
};
