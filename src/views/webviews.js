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

function getComposerHtml(webview) {
	const nonce = getNonce();

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>DRIP Composer</title>
	<style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 0; padding: 20px; }
		.layout { display: grid; grid-template-columns: 1.35fr 1fr; gap: 16px; }
		.panel { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 16px; background: var(--vscode-editorWidget-background); }
		h1, h2, h3, p { margin-top: 0; }
		label { display: block; font-size: 12px; margin-bottom: 6px; color: var(--vscode-descriptionForeground); }
		input, textarea, select { width: 100%; box-sizing: border-box; border: 1px solid var(--vscode-input-border); border-radius: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: 10px 12px; }
		textarea { min-height: 120px; resize: vertical; font-family: var(--vscode-editor-font-family, var(--vscode-font-family)); }
		.grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
		.row { margin-top: 12px; }
		.meta { color: var(--vscode-descriptionForeground); }
		.button-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
		button { border: none; border-radius: 6px; padding: 10px 12px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		.target-item { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; margin-top: 10px; }
		.selected-card { border: 2px solid var(--vscode-focusBorder); background: var(--vscode-editorWidget-background); }
		.selectable { cursor: pointer; }
		.selectable:hover { background: var(--vscode-editorWidget-background); }
		.status { margin-top: 12px; color: var(--vscode-textLink-foreground); }
		.error { margin-top: 12px; color: var(--vscode-errorForeground); }
		textarea { min-height: 120px; resize: vertical; font-family: var(--vscode-editor-font-family, var(--vscode-font-family)); }
		.composer-tabs { display: flex; gap: 6px; margin: 12px 0; flex-wrap: wrap; }
		.composer-tabs button.tab { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		.composer-tabs button.tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		.tab-panel[hidden] { display: none !important; }
		.subh { font-size: 12px; margin: 10px 0 6px; color: var(--vscode-descriptionForeground); font-weight: 600; }
		.storage-flow { margin-top: 8px; }
		.storage-path-bar { font-size: 12px; margin-bottom: 10px; padding: 8px 10px; border-radius: 8px; background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border); line-height: 1.5; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 0; }
		.storage-path-bar .path-root { font-weight: 600; color: var(--vscode-foreground); }
		.storage-path-bar .path-sep { margin: 0 8px; color: var(--vscode-descriptionForeground); user-select: none; }
		.storage-path-bar .path-seg { color: var(--vscode-foreground); }
		.storage-path-bar .path-seg.clickable { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
		.storage-path-bar .path-seg.clickable:hover { color: var(--vscode-textLink-activeForeground); }
		.storage-path-bar .path-muted { color: var(--vscode-descriptionForeground); font-style: italic; }
		.sf-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
		.sf-row:first-of-type { margin-top: 0; }
		.sf-row .sf-score { font-size: 11px; color: var(--vscode-descriptionForeground); min-width: 2.75em; flex-shrink: 0; font-variant-numeric: tabular-nums; }
		.sf-row .sf-name { flex: 1; min-width: 0; font-weight: 600; }
		.sf-row.selectable { cursor: default; }
		.sf-hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 4px 0 8px; }
		.heading-tree { font-size: 12px; max-height: 220px; overflow: auto; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; }
		.heading-tree ul { list-style: none; margin: 0; padding-left: 14px; }
		.heading-tree > ul { padding-left: 0; }
		.heading-tree li { margin: 2px 0; cursor: pointer; padding: 2px 4px; border-radius: 4px; }
		.heading-tree li:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-textLink-foreground); }
		.heading-tree li.ht-selected { background: var(--vscode-list-inactiveSelectionBackground); font-weight: 600; }
		.picker-panel { margin-top: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px; background: var(--vscode-sideBar-background); }
		.picker-breadcrumb { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; word-break: break-all; }
		.picker-filter { margin-bottom: 8px; width: 100%; box-sizing: border-box; }
		.picker-list { max-height: 180px; overflow: auto; font-size: 12px; }
		.picker-item { padding: 6px 8px; cursor: pointer; border-radius: 4px; display: flex; align-items: center; gap: 6px; }
		.picker-item:hover { background: var(--vscode-list-hoverBackground); }
		.picker-item .sym { opacity: 0.8; font-size: 11px; }
		.picker-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
		.picker-actions button { padding: 4px 10px; font-size: 11px; }
		.kb-row { display: flex; align-items: center; gap: 10px; margin: 0 0 12px 0; flex-wrap: nowrap; }
		.kb-row .kb-path { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.4; word-break: break-word; }
		button#select-kb { padding: 3px 10px; font-size: 11px; border-radius: 4px; flex-shrink: 0; white-space: nowrap; align-self: center; }
		@media (max-width: 900px) { .layout, .grid { grid-template-columns: 1fr; } }
	</style>
</head>
<body>
	<div class="layout">
		<section class="panel">
			<h1>DRIP Composer</h1>
			<div class="kb-row">
				<p id="kb-root" class="meta kb-path">Knowledge base: not selected</p>
				<button type="button" id="select-kb" class="secondary">Select Knowledge Base Folder</button>
			</div>
			<div class="composer-tabs">
				<button type="button" class="tab active" id="tab-btn-compose">Compose</button>
				<button type="button" class="tab" id="tab-btn-metadata">Metadata</button>
			</div>
			<div id="panel-compose" class="tab-panel">
				<div class="grid">
					<div>
						<label for="title">Note title</label>
						<input id="title" />
					</div>
				</div>
				<div class="row">
					<label for="content">Draft note content</label>
					<textarea id="content"></textarea>
				</div>
			</div>
			<div id="panel-metadata" class="tab-panel" hidden>
				<p class="meta">File header for new or updated knowledge base notes (typically <code>.d.txt</code>; <code>.md</code> when enabled in settings — see <code>filename:</code> / <code>created:</code> in prototypes). Headings in the file use <code>#</code> and tabs for nested sections.</p>
				<div class="grid">
					<div>
						<label for="meta-filename">filename: (display label)</label>
						<input id="meta-filename" placeholder="Defaults to note title when empty" />
					</div>
				</div>
				<p id="meta-created-hint" class="meta" style="margin-top:10px;">created: is set automatically when you ingest or create a note file.</p>
			</div>
			<div class="button-row">
				<button id="save-draft">Save Draft</button>
				<button id="new-note" class="secondary">New Note</button>
				<button id="ingest-note">Ingest Note</button>
			</div>
			<div id="status" class="status"></div>
			<div id="error" class="error"></div>
		</section>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		let currentDraftId = '';
		let noteDebounce = null;

		const titleEl = document.getElementById('title');
		const contentEl = document.getElementById('content');
		const statusEl = document.getElementById('status');
		const errorEl = document.getElementById('error');
		const selectKbBtn = document.getElementById('select-kb');
		const newNoteBtn = document.getElementById('new-note');
		const kbRootEl = document.getElementById('kb-root');
		const metaFilenameEl = document.getElementById('meta-filename');
		const tabBtnCompose = document.getElementById('tab-btn-compose');
		const tabBtnMetadata = document.getElementById('tab-btn-metadata');
		const panelCompose = document.getElementById('panel-compose');
		const panelMetadata = document.getElementById('panel-metadata');

		function notePayload() {
			return {
				id: currentDraftId,
				title: titleEl.value,
				headings: '',
				content: contentEl.value,
				metadataFilename: metaFilenameEl.value
			};
		}

		function pushNoteSnapshot() {
			clearTimeout(noteDebounce);
			noteDebounce = setTimeout(function () {
				vscode.postMessage({ type: 'noteSnapshot', note: notePayload() });
			}, 300);
		}

		function setComposerTab(which) {
			const meta = which === 'metadata';
			tabBtnCompose.classList.toggle('active', !meta);
			tabBtnMetadata.classList.toggle('active', meta);
			panelCompose.hidden = meta;
			panelMetadata.hidden = !meta;
		}
		tabBtnCompose.addEventListener('click', () => setComposerTab('compose'));
		tabBtnMetadata.addEventListener('click', () => setComposerTab('metadata'));

		titleEl.addEventListener('input', pushNoteSnapshot);
		contentEl.addEventListener('input', pushNoteSnapshot);
		metaFilenameEl.addEventListener('input', pushNoteSnapshot);

		document.getElementById('save-draft').addEventListener('click', () => {
			statusEl.textContent = '';
			errorEl.textContent = '';
			vscode.postMessage({ type: 'saveDraft', note: notePayload() });
		});

		newNoteBtn.addEventListener('click', () => {
			currentDraftId = '';
			titleEl.value = '';
			contentEl.value = '';
			metaFilenameEl.value = '';
			setComposerTab('compose');
			statusEl.textContent = '';
			errorEl.textContent = '';
			vscode.postMessage({ type: 'composerNewNote' });
		});

		document.getElementById('ingest-note').addEventListener('click', () => {
			statusEl.textContent = '';
			errorEl.textContent = '';
			vscode.postMessage({ type: 'ingestNote', note: notePayload() });
		});

		document.getElementById('select-kb').addEventListener('click', () => {
			statusEl.textContent = '';
			errorEl.textContent = '';
			vscode.postMessage({ type: 'selectKnowledgeBase', noteId: currentDraftId });
		});

		window.addEventListener('message', event => {
			const message = event.data;

			if (message.type === 'composerState') {
				const state = message.state;
				currentDraftId = state.draft.id || '';
				titleEl.value = state.draft.title || '';
				contentEl.value = state.draft.content || '';
				metaFilenameEl.value = state.draft.metadataFilename || '';
				kbRootEl.textContent = state.kbRootPath
					? 'Knowledge base: ' + state.kbRootPath
					: 'Knowledge base: not selected';
				selectKbBtn.textContent = state.kbRootPath ? 'Change Knowledge Base' : 'Select Knowledge Base Folder';
				statusEl.textContent = state.statusMessage || '';
				errorEl.textContent = '';
				pushNoteSnapshot();
			}

			if (message.type === 'capturedSelection') {
				titleEl.value = message.title || '';
				contentEl.value = message.content || '';
				metaFilenameEl.value = '';
				setComposerTab('compose');
				errorEl.textContent = '';
				statusEl.textContent = 'Selection captured.';
				pushNoteSnapshot();
			}

			if (message.type === 'operationError') {
				errorEl.textContent = message.message || 'Unknown error';
			}
		});

		vscode.postMessage({ type: 'requestState' });
	</script>

</body>
</html>`;
}

module.exports = {
	getComposerHtml,
	getSidebarHtml
};
