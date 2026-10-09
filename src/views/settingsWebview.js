'use strict';

const { getNonce } = require('../shared/utils');
const { DEFAULT_METADATA_TYPES, DEFAULT_FILE_LEVEL_METADATA_TYPES } = require('../document/model/dripnoteMetadataTemplates');

/**
 * @param {import('vscode').Webview} webview
 * @param {{ initialPanel?: string }} [opts]
 */
function getSettingsWebviewHtml(webview, opts = {}) {
	const nonce = getNonce();
	const initialPanelJson = JSON.stringify(/^[a-z-]+$/.test(String(opts.initialPanel || '')) ? opts.initialPanel : 'kb');
	const defaultTypesJson = JSON.stringify(DEFAULT_METADATA_TYPES).replace(/</g, '\\u003c');
	const defaultFileTypesJson = JSON.stringify(DEFAULT_FILE_LEVEL_METADATA_TYPES).replace(/</g, '\\u003c');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>DRIP Settings</title>
	<style>
		body { font-family: var(--vscode-font-family); margin: 0; color: var(--vscode-foreground); font-size: 13px; }
		h2 { font-size: 1.1em; margin: 0 0 10px; }
		h3 { font-size: 1em; margin: 0 0 8px; font-weight: 600; color: var(--vscode-foreground); }
		p { margin: 0 0 10px; line-height: 1.45; }
		.meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
		label.row { display: flex; align-items: flex-start; gap: 8px; margin: 10px 0; cursor: pointer; line-height: 1.45; }
		label.row input { margin-top: 2px; flex-shrink: 0; }
		table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 8px 0; }
		th, td { border: 1px solid var(--vscode-panel-border); padding: 6px 8px; text-align: left; vertical-align: top; }
		th { background: var(--vscode-editorWidget-background); }
		code { font-family: var(--vscode-editor-font-family); font-size: 11px; }
		button { border: 1px solid transparent; border-radius: 6px; padding: 8px 12px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); margin-top: 10px; font-family: inherit; }
		button:hover { background: var(--vscode-button-hoverBackground); }
		button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-color: var(--vscode-panel-border); }
		button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		textarea { width: 100%; min-height: 82px; padding: 6px; border-radius: 6px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-family: var(--vscode-editor-font-family); font-size: 12px; }
		input[type="text"], select { width: 100%; box-sizing: border-box; padding: 6px; border-radius: 6px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-family: var(--vscode-editor-font-family); font-size: 12px; }
		.app { display: grid; grid-template-columns: 250px 1fr; height: 100vh; overflow: hidden; }
		.sidebar { border-right: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); padding: 14px 10px; overflow-y: auto; display: flex; flex-direction: column; }
		.brand { margin: 0 8px 14px; }
		.brand h2 { font-size: 1.9em; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
		.navBtn { width: 100%; text-align: left; margin: 4px 0; padding: 8px 10px; border-radius: 6px; background: transparent; color: var(--vscode-foreground); }
		.navBtn:hover { background: var(--vscode-list-hoverBackground); }
		.navBtn.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
		.main { padding: 16px 18px 32px; overflow-y: auto; height: 100vh; box-sizing: border-box; }
		.panel { display: none; max-width: 900px; }
		.panel.active { display: block; }
		.card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 14px; margin: 12px 0 16px; background: var(--vscode-editorWidget-background); }
		.actions { display: flex; gap: 8px; margin-top: 8px; }
		.actions button { width: auto; }
		.typeList { display: flex; flex-direction: column; gap: 10px; }
		.typeDetails { border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: var(--vscode-editorWidget-background); }
		.typeSummary { cursor: pointer; padding: 8px 10px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; list-style: none; }
		.typeSummary::-webkit-details-marker { display: none; }
		.typeBody { padding: 10px; border-top: 1px solid var(--vscode-panel-border); }
		.typeGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
		.attrTable { width: 100%; border-collapse: collapse; margin-top: 8px; }
		.attrTable th, .attrTable td { border: 1px solid var(--vscode-panel-border); padding: 6px; vertical-align: middle; }
		.iconBtn { width: 28px; height: 28px; min-width: 28px; padding: 0; border-radius: 6px; margin-top: 0; font-size: 16px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--vscode-panel-border); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		.iconBtn:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.iconBtn.deleteIcon { color: var(--vscode-errorForeground); }
		.inlineActions { display: flex; gap: 8px; align-items: center; }
		.summaryRight { display: inline-flex; align-items: center; gap: 8px; }
		.chev { font-size: 14px; opacity: 0.85; }
		.typeDetails[open] .chev { transform: rotate(180deg); }
		.deleteIcon { color: var(--vscode-errorForeground); }
		.optionSelect { min-width: 150px; }
		.colorRow { display: grid; grid-template-columns: 1fr 44px; gap: 6px; align-items: center; }
		.colorPatch { width: 42px; height: 30px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 0; background: transparent; margin: 0; cursor: pointer; }
		.docColoringSample { font-family: var(--vscode-editor-font-family); font-size: 13px; line-height: 1.6; white-space: pre; overflow-x: auto; padding: 4px 0; }
		.docColoringSample .bold { font-weight: 600; }
		.docColorRow { display: grid; grid-template-columns: 1fr 44px; gap: 6px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border); }
		.docColorRow:last-child { border-bottom: none; }
		.docColorRow .lbl { display: flex; flex-direction: column; gap: 2px; }
		.docColorRow .lbl .t { font-weight: 600; }
		.docColorRow .lbl .d { color: var(--vscode-descriptionForeground); font-size: 11px; }
		.docColorRow .swatch { width: 34px; height: 28px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 0; margin: 0; cursor: pointer; background: transparent; }
		.saved-settings-path-line { margin: 8px 0 12px; word-break: break-all; }
		.saved-settings-path-line code { display: block; padding: 8px 10px; border-radius: 6px; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); font-size: 12px; }
		.mcp-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; background: var(--vscode-descriptionForeground); vertical-align: middle; }
		.mcp-dot.on { background: var(--vscode-testing-iconPassed, #3fb950); }
		.mcp-dot.err { background: var(--vscode-errorForeground); }
		.mcp-kv { display: grid; grid-template-columns: 130px 1fr auto; gap: 6px 10px; align-items: center; margin-top: 6px; }
		.mcp-kv code { word-break: break-all; }
		.mcp-kv button { margin-top: 0; padding: 4px 10px; }
		pre.mcp-snippet { margin: 6px 0 0; padding: 8px 10px; border-radius: 6px; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); font-family: var(--vscode-editor-font-family); font-size: 11px; white-space: pre; overflow-x: auto; }
		.mcp-port-row { display: flex; gap: 8px; align-items: center; }
		.mcp-port-row input { max-width: 8em; }
		.mcp-port-row button { margin-top: 0; }
		.shortcut-table td { vertical-align: middle; }
		.shortcut-table button { margin-top: 0; padding: 4px 10px; }
		.shortcut-table .sc-actions { display: flex; gap: 6px; white-space: nowrap; }
		.shortcut-table input.sc-record { cursor: pointer; }
		.shortcut-table input.sc-record:focus { outline: 1px solid var(--vscode-focusBorder); }
		kbd { font-family: var(--vscode-editor-font-family); font-size: 11px; padding: 1px 5px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-textCodeBlock-background); margin-right: 4px; }
		.sc-conflict { color: var(--vscode-editorWarning-foreground); font-size: 11px; margin-top: 3px; }
	</style>
</head>
<body>
	<div class="app">
		<aside class="sidebar">
			<div class="brand">
				<h2>DRIP Settings</h2>
			</div>
			<nav id="nav-group">
				<button class="navBtn active" data-panel="kb">Knowledge Base</button>
				<button class="navBtn" data-panel="editor">Editor</button>
				<button class="navBtn" data-panel="update">Update</button>
				<button class="navBtn" data-panel="types">Metadata Types</button>
				<button class="navBtn" data-panel="relations">Tags & Relations</button>
				<button class="navBtn" data-panel="metadata">Markdown</button>
				<button class="navBtn" data-panel="doccoloring">Doc Coloring</button>
				<button class="navBtn" data-panel="embedding">Embedding model</button>
				<button class="navBtn" data-panel="llm">Lightweight LLM</button>
				<button class="navBtn" data-panel="github-backup">GitHub backup</button>
				<button class="navBtn" data-panel="mcp">MCP connection</button>
				<button class="navBtn" data-panel="saved-settings">Saved Settings</button>
				<button class="navBtn" data-panel="shortcuts">Keyboard Shortcuts</button>
			</nav>
		</aside>
		<main class="main">
			<section id="panel-kb" class="panel active">
				<h3>Knowledge Base</h3>
				<div class="card">
					<label class="row">
						<input type="checkbox" id="opt-auto-open">
						<span>Open the Note Composer the first time the Knowledge Base sidebar becomes visible in this window.</span>
					</label>
					<p class="meta">Capture selection (Ctrl+Shift+U / Cmd+Shift+U) copies the full selection into the draft note body.</p>
					<div class="actions">
						<button id="btn-select-kb">Change Knowledge Base Folder</button>
					</div>
				</div>
				<div class="card">
					<p class="meta">Choose which extensions appear in KB tree/scans.</p>
					<label class="row">
						<input type="checkbox" id="kb-ext-dtxt">
						<span><code>.d.txt</code> — DRIP note files</span>
					</label>
					<label class="row">
						<input type="checkbox" id="kb-ext-md">
						<span><code>.md</code> — Markdown (e.g. README.md)</span>
					</label>
					<label class="row" style="align-items:center;">
						<span style="min-width:9em;">New note uses</span>
						<select id="kb-default-ext" style="flex:1; max-width:12em; padding:4px 6px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px;"></select>
					</label>
					<div class="actions">
						<button id="btn-user-settings" class="secondary">Open User Settings (DRIP)</button>
					</div>
				</div>
			</section>

			<section id="panel-editor" class="panel">
				<h3>Editor</h3>
				<p class="meta">Choose <strong>one</strong> way to edit persistent headings (<code># .…</code>, <code># .c</code>, <code># .c#</code>, <code># .t1</code>, etc.). Plain headings without a leading <code>.</code> always edit in the file.</p>
				<div class="card">
					<label class="row">
						<input type="radio" name="edit-headings-mode" id="opt-edit-headings-rhs" value="rhs" checked>
						<span>Edit via RHS sidebar <strong>(recommended)</strong> — opens after you type a space after <code>.</code> / type shortcut; soft-locks title &amp; metadata in the file</span>
					</label>
					<label class="row">
						<input type="radio" name="edit-headings-mode" id="opt-edit-headings-file" value="file">
						<span>Edit directly in the <code>.d.txt</code> file</span>
					</label>
					<p class="meta">RHS mode: form fields come from the metadata type template (attributes, tags, relations). Changes save when focus returns to the editor or you switch tabs.</p>
				</div>
			</section>

			<section id="panel-update" class="panel">
				<h3>Update</h3>
				<p class="meta">Fix file ids, heading ids, and <code>index.drip</code> when the SQLite index and notes disagree. Both actions rewrite <code>.d.txt</code> identity lines when needed.</p>
				<div class="card">
					<h3>Update/reindex the current KB working space</h3>
					<p class="meta">Keeps the existing <code>index.drip</code>. Runs reconcile-update on notes currently in the working KB (honors <code>.dripignore</code>). Colliding <code>@fN</code> values that already belong to another existing file get a new id.</p>
					<div class="actions">
						<button id="btn-reindex-workspace">Update/reindex the current KB working space</button>
					</div>
				</div>
				<div class="card">
					<h3>Reset/reindex the entire KB driplock folder</h3>
					<p class="meta">Deletes <code>index.drip</code>, creates a fresh database, then reconcile-updates every note in the driplock folder (including ignored paths, except <code>.dripindex</code>). File ids that collide while rebuilding are assigned from scratch.</p>
					<div class="actions">
						<button id="btn-reset-reindex-entire" class="secondary">Reset/reindex the entire KB driplock folder</button>
					</div>
				</div>
			</section>

			<section id="panel-types" class="panel">
				<h3>Metadata Types</h3>
				<div class="card">
					<label class="row"><input type="checkbox" id="opt-template-enabled"><span>Enable metadata templates</span></label>
					<label class="row"><input type="checkbox" id="opt-template-auto"><span>Auto insert template keys when type marker is added in valid metadata zone</span></label>
					<label class="row"><input type="checkbox" id="opt-template-strict"><span>Strict validation (show errors + quick fixes)</span></label>
					<label class="row"><input type="checkbox" id="opt-template-ignore"><span>Ignore metadata template errors</span></label>
					<label class="row"><input type="checkbox" id="opt-template-indent-errors"><span>Show indent errors in heading metadata blocks</span></label>
					<label class="row"><input type="checkbox" id="opt-heading-hierarchy-indent"><span>Show heading hierarchy indent errors (body line vs next heading tabs)</span></label>
				</div>
				<div class="card">
					<h3>Projects</h3>
					<p class="meta">Project (<code>.p</code>), feature (<code>.f</code>), and issue (<code>.issue</code> / <code>i</code>) types. Shortcuts are fixed. Issues are headings inside project folders; their metadata (status, priority, deadline, category, parent <code>i-N</code>) feeds Project View.</p>
					<div id="file-level-types-list" class="typeList"></div>
					<div class="actions">
						<button id="btn-save-file-types">Save Project Types</button>
						<button id="btn-reset-file-types" class="secondary">Revert Project Types</button>
					</div>
				</div>
				<div class="card">
					<h3>Document KB types</h3>
					<p class="meta">Heading metadata types for the note zone (marker, shortcut, attributes). Defaults include <code>.concept</code> and <code>.task</code>.</p>
					<div id="metadata-types-list" class="typeList"></div>
					<div class="actions">
						<button id="btn-add-type" class="iconBtn" title="Add Metadata Type">+</button>
						<button id="btn-save-types">Save Document Types</button>
						<button id="btn-reset-types" class="secondary">Revert Document Types</button>
					</div>
				</div>
				<div class="actions">
					<button id="btn-save-metadata-panel">Save Metadata Types Settings</button>
				</div>
			</section>

			<section id="panel-relations" class="panel">
				<h3>Tags & Relations</h3>
				<div class="card">
					<p class="meta">Manage relation rows (default locked: tags) and descriptions.</p>
					<div id="relations-list" class="typeList"></div>
					<div class="actions">
						<button id="btn-add-relation" class="iconBtn" title="Add Relation">+</button>
						<button id="btn-save-relations">Save Tags & Relations</button>
					</div>
				</div>
			</section>

			<section id="panel-metadata" class="panel">
				<h3>Markdown</h3>
				<div class="card">
					<p class="meta">Manage markdown marks (defaults: L, Q, R). A mark is written in the document as <code>Mark: text</code> — for example <code>Q: why does this work?</code>. Names are case-sensitive — Impl, impl, and IMPL are distinct. L is locked and includes a link format example. Leave a color empty to use the normal text color.</p>
					<div id="metadata-marks-list" class="typeList"></div>
					<div class="actions">
						<button id="btn-add-metadata-mark" class="iconBtn" title="Add Metadata Mark">+</button>
						<button id="btn-save-metadata-marks">Save Metadata Marks</button>
					</div>
				</div>
			</section>

			<section id="panel-doccoloring" class="panel">
				<h3>Doc Coloring</h3>
				<p class="meta">The six document colors follow your theme by default. Set a color here to override that specific one in <code>.d.txt</code> notes; leave it empty to keep the theme color.</p>
				<div class="card">
					<div id="doc-coloring-sample" class="docColoringSample"></div>
				</div>
				<div class="card">
					<div id="doc-coloring-rows" class="typeList"></div>
					<div class="actions">
						<button id="btn-save-doc-colors">Save Doc Colors</button>
						<button id="btn-revert-doc-colors" class="secondary">Revert to Theme Defaults</button>
					</div>
				</div>
			</section>

			<section id="panel-embedding" class="panel">
				<h3>Embeddings</h3>
				<div class="card">
					<p class="meta">DRIP always uses sentence embeddings (Transformers.js + ONNX in the extension host) to rank Storage targets — top folder suggestions, next folder/file picks inside a folder, and AI deep-match across the KB.</p>
					<p class="meta">DRIP uses the <code>Xenova/all-MiniLM-L6-v2</code> sentence-transformer model. The first use downloads the model weights (~90MB) into the DRIP extension folder (<code>.cache/transformers</code>) — not your home folder's Hugging Face cache — so uninstalling the DRIP extension removes the model files cleanly.</p>
					<div class="actions">
						<button id="btn-embedding-benchmark" class="secondary" type="button">Run embedding benchmark</button>
					</div>
				</div>
			</section>

			<section id="panel-llm" class="panel">
				<h3>Lightweight LLM</h3>
				<p class="meta">DRIP runs its own small LLM (separate from VS Code Copilot) to decide where a Quick Capture note belongs: merge into the best matching heading, append as a new section, or start a new heading. Only the note plus a short snippet of the top matching headings is sent, keeping tokens low. The API key lives in VS Code Secret Storage — never in settings.</p>
				<div class="card">
					<label class="row">
						<input type="checkbox" id="llm-enabled">
						<span>Enable the lightweight LLM for Quick Capture</span>
					</label>
					<label class="row" style="display:block;margin-top:10px;">
						<span>Base URL (OpenAI-compatible)</span>
						<input type="text" id="llm-base-url" placeholder="https://api.openai.com/v1" autocomplete="off" spellcheck="false" />
					</label>
					<label class="row" style="display:block;margin-top:10px;">
						<span>Model</span>
						<input type="text" id="llm-model" placeholder="gpt-4o-mini" autocomplete="off" spellcheck="false" style="max-width:18em;" />
					</label>
					<div class="actions">
						<button id="btn-llm-save" type="button">Save</button>
					</div>
					<p class="meta" style="margin-top:8px;">Works with any OpenAI-compatible endpoint (OpenAI, Groq, Ollama, LM Studio, …). Examples: <code>https://api.openai.com/v1</code>, <code>https://api.groq.com/openai/v1</code>, <code>http://localhost:11434/v1</code>.</p>
				</div>
				<div class="card">
					<h3 style="margin-top:0;">API key</h3>
					<p class="meta">Entered below, then stored only in VS Code Secret Storage — never in settings and never shown again. Characters stay masked.</p>
					<p id="llm-key-status" class="meta">API key: not set</p>
					<label class="row" style="display:block;margin-top:8px;">
						<span>API key</span>
						<input type="password" id="llm-api-key" placeholder="sk-…" autocomplete="off" spellcheck="false" />
					</label>
					<div class="actions">
						<button id="btn-llm-set-key" type="button">Save API key</button>
						<button id="btn-llm-clear-key" class="secondary" type="button">Clear API key</button>
					</div>
				</div>
			</section>

			<section id="panel-github-backup" class="panel">
				<h3>GitHub backup</h3>
				<p class="meta">Back up this knowledge base’s notes to a GitHub remote. The regenerable <code>.dripindex/</code> folder is ignored. Never store a GitHub password here — use HTTPS + Git Credential Manager / <code>gh auth</code>, SSH keys, or an optional PAT (Secret Storage).</p>
				<div class="card">
					<h3 style="margin-top:0;">Status</h3>
					<p id="gh-status-line" class="meta">Select a knowledge base to configure backup.</p>
					<p id="gh-status-detail" class="meta"></p>
					<p id="gh-status-error" style="color:var(--vscode-errorForeground);"></p>
				</div>
				<div class="card">
					<h3 style="margin-top:0;">Repository</h3>
					<label class="row" style="display:block;">
						<span>Remote URL (HTTPS or SSH)</span>
						<input type="text" id="gh-remote-url" placeholder="https://github.com/you/my-kb.git" autocomplete="off" spellcheck="false" />
					</label>
					<label class="row" style="display:block;margin-top:10px;">
						<span>Branch</span>
						<input type="text" id="gh-branch" placeholder="main" autocomplete="off" spellcheck="false" style="max-width:12em;" />
					</label>
					<div class="actions">
						<button id="btn-gh-save-remote" type="button">Save remote</button>
						<button id="btn-gh-open" class="secondary" type="button">Open on GitHub</button>
					</div>
				</div>
				<div class="card">
					<h3 style="margin-top:0;">Actions</h3>
					<div class="actions">
						<button id="btn-gh-init" type="button">Initialize backup</button>
						<button id="btn-gh-push" type="button">Push backup</button>
						<button id="btn-gh-pull" type="button">Pull / restore</button>
					</div>
					<p class="meta" style="margin-top:10px;">Initialize creates a Git repo in the KB folder, seeds <code>.gitignore</code>, and sets <code>origin</code>. Push commits note changes and uploads. Pull downloads then reindexes.</p>
				</div>
				<div class="card">
					<h3 style="margin-top:0;">Optional token (HTTPS)</h3>
					<p class="meta">Only if Git Credential Manager / <code>gh</code> is not available. Stored in VS Code Secret Storage for this KB — not in <code>settings.drip.json</code>.</p>
					<p id="gh-pat-status" class="meta">Token: not set</p>
					<div class="actions">
						<button id="btn-gh-set-pat" type="button">Set token…</button>
						<button id="btn-gh-clear-pat" class="secondary" type="button">Clear token</button>
					</div>
				</div>
			</section>

			<section id="panel-mcp" class="panel">
				<h3>MCP connection</h3>
				<p class="meta">Let AI apps (Cursor, Claude, VS Code Copilot, Windsurf, …) read and manage your DRIP projects and issues. DRIP runs one local MCP server; every MCP-capable app connects to the same address with the same token — no per-app integration. The server only listens on this computer (<code>127.0.0.1</code>) and DRIP must stay open while an app uses it.</p>
				<div class="card">
					<h3 style="margin-top:0;">Server</h3>
					<label class="row">
						<input type="checkbox" id="mcp-enabled">
						<span>Turn on the DRIP MCP server</span>
					</label>
					<p class="meta"><span id="mcp-dot" class="mcp-dot"></span><span id="mcp-status-line">Off</span></p>
					<p id="mcp-error" style="color:var(--vscode-errorForeground);"></p>
					<div class="mcp-port-row">
						<span>Port</span>
						<input type="text" id="mcp-port" inputmode="numeric" autocomplete="off" spellcheck="false" />
						<button id="btn-mcp-save-port" class="secondary" type="button">Save port</button>
						<button id="btn-mcp-restart" class="secondary" type="button">Restart server</button>
					</div>
					<p class="meta" style="margin-top:8px;">Change the port only if another program already uses it. Only one DRIP window can run the server on a port.</p>
				</div>
				<div class="card">
					<h3 style="margin-top:0;">Connection details</h3>
					<p class="meta">Everything an MCP app asks for. The token is shortened in this list; Copy and the config snippets below use the full token — keep them private.</p>
					<div class="mcp-kv">
						<span>Server name</span><code id="mcp-name">drip</code><span></span>
						<span>Server URL</span><code id="mcp-url"></code><button class="secondary" type="button" data-mcp-copy="url">Copy</button>
						<span>Transport</span><code id="mcp-transport"></code><span></span>
						<span>Auth header</span><code id="mcp-header"></code><button class="secondary" type="button" data-mcp-copy="header">Copy</button>
						<span>Token</span><code id="mcp-token"></code><button class="secondary" type="button" data-mcp-copy="token">Copy</button>
						<span>Tools</span><code id="mcp-tools"></code><span></span>
					</div>
					<div class="actions">
						<button id="btn-mcp-regenerate" class="secondary" type="button">Regenerate token…</button>
						<button id="btn-mcp-health" class="secondary" type="button">Test in browser</button>
					</div>
					<p class="meta" style="margin-top:8px;">The token is kept in VS Code Secret Storage (never in <code>settings.drip.json</code>). Regenerating it disconnects every app until you paste the new token.</p>
				</div>
				<div class="card">
					<h3 style="margin-top:0;">Option A — apps that accept a server URL (most apps)</h3>
					<p class="meta">Cursor, Claude Code, VS Code Copilot, Windsurf, Cline, Continue… Paste into the app’s MCP config file or “Add MCP server” form.</p>
					<pre class="mcp-snippet" id="mcp-http-config"></pre>
					<div class="actions"><button type="button" data-mcp-copy="httpConfig">Copy config</button></div>
					<p class="meta" style="margin-top:8px;">A few apps use slightly different key names (VS Code: <code>"servers"</code> + <code>"type": "http"</code>; Windsurf: <code>"serverUrl"</code>). The URL and <code>Authorization</code> header are always the same.</p>
				</div>
				<div class="card">
					<h3 style="margin-top:0;">Option B — apps that can only start a command</h3>
					<p class="meta">E.g. Claude Desktop. Uses the small <code>mcp-remote</code> bridge (needs Node.js; downloaded automatically by <code>npx</code>).</p>
					<pre class="mcp-snippet" id="mcp-stdio-config"></pre>
					<div class="actions"><button type="button" data-mcp-copy="stdioConfig">Copy config</button></div>
				</div>
				<div class="card">
					<h3 style="margin-top:0;">How an app uses DRIP</h3>
					<p class="meta">Apps see two tools: <code>search_tools</code> (describe what you want, get the matching DRIP tools and their exact inputs) and <code>call_tool</code> (run one). This keeps prompts small while the AI can still reach every DRIP tool. A knowledge base must be open in DRIP.</p>
				</div>
			</section>

			<section id="panel-saved-settings" class="panel">
				<h3>Saved Settings</h3>
				<div class="card">
					<p>DRIP settings for the active knowledge base are stored in:</p>
					<p class="saved-settings-path-line"><code id="saved-settings-path">(no knowledge base selected)</code></p>
					<p class="meta">When you change settings while a KB is bound, they are saved to that file. Switching KB loads that KB's settings (or defaults if the file is missing).</p>
					<div class="actions">
						<button id="btn-import-settings" type="button">Import settings from file…</button>
						<button id="btn-export-settings" class="secondary" type="button">Export settings to file…</button>
					</div>
				</div>
			</section>

			<section id="panel-shortcuts" class="panel">
				<h3>Keyboard Shortcuts</h3>
				<div class="card">
					<p class="meta">Click a shortcut box, press the key combination you want, then Save. Changes are written to your VS Code <code>keybindings.json</code> and apply immediately. Reset brings back the DRIP default; Remove leaves the command without a shortcut.</p>
					<table class="shortcut-table">
						<thead><tr><th>Command</th><th>Current</th><th>New shortcut</th><th></th></tr></thead>
						<tbody id="shortcut-rows"><tr><td colspan="4" class="meta">Loading…</td></tr></tbody>
					</table>
					<p id="shortcut-error" style="color:var(--vscode-errorForeground);"></p>
					<p class="meta">Shortcuts already used by built-in VS Code commands are not detected here — if a new shortcut does nothing, pick another combination.</p>
					<div class="actions">
						<button id="btn-keys" class="secondary">Open VS Code Keyboard Shortcuts</button>
						<button id="btn-keys-file" class="secondary">Open keybindings.json</button>
					</div>
				</div>
			</section>
		</main>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const navButtons = Array.prototype.slice.call(document.querySelectorAll('.navBtn'));
		const panels = {
			kb: document.getElementById('panel-kb'),
			editor: document.getElementById('panel-editor'),
			update: document.getElementById('panel-update'),
			types: document.getElementById('panel-types'),
			relations: document.getElementById('panel-relations'),
			metadata: document.getElementById('panel-metadata'),
			doccoloring: document.getElementById('panel-doccoloring'),
			embedding: document.getElementById('panel-embedding'),
			llm: document.getElementById('panel-llm'),
			'github-backup': document.getElementById('panel-github-backup'),
			mcp: document.getElementById('panel-mcp'),
			'saved-settings': document.getElementById('panel-saved-settings'),
			shortcuts: document.getElementById('panel-shortcuts')
		};
		const optEditHeadingsRhs = document.getElementById('opt-edit-headings-rhs');
		const optEditHeadingsFile = document.getElementById('opt-edit-headings-file');
		const llmEnabledEl = document.getElementById('llm-enabled');
		const llmBaseUrlEl = document.getElementById('llm-base-url');
		const llmModelEl = document.getElementById('llm-model');
		const autoOpenEl = document.getElementById('opt-auto-open');
		const kbExtDtxt = document.getElementById('kb-ext-dtxt');
		const kbExtMd = document.getElementById('kb-ext-md');
		const kbDefaultExt = document.getElementById('kb-default-ext');
		const metadataTypesListEl = document.getElementById('metadata-types-list');
		const fileLevelTypesListEl = document.getElementById('file-level-types-list');
		const optTemplateEnabled = document.getElementById('opt-template-enabled');
		const optTemplateAuto = document.getElementById('opt-template-auto');
		const optTemplateStrict = document.getElementById('opt-template-strict');
		const optTemplateIgnore = document.getElementById('opt-template-ignore');
		const optTemplateIndentErrors = document.getElementById('opt-template-indent-errors');
		const optHeadingHierarchyIndent = document.getElementById('opt-heading-hierarchy-indent');
		const relationsListEl = document.getElementById('relations-list');
		const metadataMarksListEl = document.getElementById('metadata-marks-list');
		const docColoringSampleEl = document.getElementById('doc-coloring-sample');
		const docColoringRowsEl = document.getElementById('doc-coloring-rows');
		const savedSettingsPathEl = document.getElementById('saved-settings-path');
		const defaultMetadataTypes = ${defaultTypesJson};
		const defaultFileLevelMetadataTypes = ${defaultFileTypesJson};
		/** Extensions set only via settings JSON; preserved when toggling .d.txt / .md here. */
		var preservedOtherExts = [];
		var metadataTypesState = [];
		var fileLevelTypesState = [];
		var relationsState = [];
		var metadataMarksState = [];
		var docColorsState = { color1: '', color2: '', color3: '', color4: '', color5: '', color6: '' };
		// Resolved from the active theme in the extension host (theme tokenColors + token/semantic customizations).
		var docThemeColors = null;

		function showPanel(id) {
			for (var key in panels) {
				if (!Object.prototype.hasOwnProperty.call(panels, key)) continue;
				panels[key].classList.toggle('active', key === id);
			}
			for (var i = 0; i < navButtons.length; i++) {
				var b = navButtons[i];
				b.classList.toggle('active', b.getAttribute('data-panel') === id);
			}
		}

		function escapeHtml(value) {
			return String(value || '')
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#39;');
		}

		function normalizeHexColor(v) {
			var s = String(v || '').trim();
			return /^#([0-9a-f]{6})$/i.test(s) ? s.toLowerCase() : '';
		}
		function syncColorPickerFromText(textEl, pickerEl) {
			if (!textEl || !pickerEl) return;
			pickerEl.value = normalizeHexColor(textEl.value) || '#808080';
		}
		function syncColorTextFromPicker(textEl, pickerEl) {
			if (!textEl || !pickerEl) return;
			textEl.value = normalizeHexColor(pickerEl.value) || '';
		}

		function cloneJson(v) {
			try { return JSON.parse(JSON.stringify(v)); } catch { return []; }
		}

		function normalizeAttributeKind(kind) {
			var k = String(kind || 'enum').trim().toLowerCase();
			if (k === 'free' || k === 'range') return 'enum';
			if (k === 'enum' || k === 'datetime' || k === 'duration') return k;
			if (k === 'parent' || k === 'issue_parent') return 'issue_parent';
			return 'enum';
		}

		// Fixed kind for the issue parent key — a special link, not an enum/datetime/duration.
		var SPECIAL_PARENT_KIND = 'issue_parent';

		var FIXED_DURATION_UNITS_LABEL = 'minute, hour, day, week, month, year';
		var FIXED_DATETIME_FORMAT_LABEL = 'datetime (YYYY-MM-DD HH:mm)';

		function normalizeAttributes(rawAttrs) {
			var attrs = [];
			if (Array.isArray(rawAttrs)) {
				for (var i = 0; i < rawAttrs.length; i++) {
					var a = rawAttrs[i] || {};
					var kind = normalizeAttributeKind(a.kind || a.type);
					attrs.push({
						key: String(a.key || '').trim(),
						kind: kind,
						values: kind === 'enum' && Array.isArray(a.values)
							? a.values.map(function (x) { return String(x || '').trim(); }).filter(Boolean)
							: [],
						default: String(a.default != null ? a.default : '').trim(),
						required: !!a.required
					});
				}
				return attrs;
			}
			var src = rawAttrs && typeof rawAttrs === 'object' ? rawAttrs : {};
			var keys = Object.keys(src);
			for (var j = 0; j < keys.length; j++) {
				var key = String(keys[j] || '').trim();
				if (!key) continue;
				var r = src[key] || {};
				var kindObj = normalizeAttributeKind(r.kind);
				attrs.push({
					key: key,
					kind: kindObj,
					values: kindObj === 'enum' && Array.isArray(r.values)
						? r.values.map(function (x) { return String(x || '').trim(); }).filter(Boolean)
						: [],
					default: String(r.default != null ? r.default : '').trim(),
					required: !!r.required
				});
			}
			return attrs;
		}

		function normalizeTypesFromSettings(rawTypes) {
			var arr = Array.isArray(rawTypes) && rawTypes.length ? rawTypes : cloneJson(defaultMetadataTypes);
			var out = [];
			for (var i = 0; i < arr.length; i++) {
				var t = arr[i] || {};
				var id = String(t.id || '').trim().toLowerCase();
				var markerRaw = String(t.marker || (id ? ('.' + id) : '')).trim();
				var marker = markerRaw ? (markerRaw.startsWith('.') ? markerRaw : '.' + markerRaw) : '';
				var shortcut = String(t.shortcut != null ? t.shortcut : '').trim();
				out.push({
					id: id,
					marker: marker,
					shortcut: shortcut,
					displayTemplate: t.displayTemplate !== false,
					attributes: (function () {
						var attrs = normalizeAttributes(t.attributes);
						for (var ai = 0; ai < attrs.length; ai++) {
							sanitizeEnumDefault(attrs[ai]);
						}
						return attrs;
					})()
				});
			}
			return out;
		}
		function normalizeAttrByKind(attr) {
			if (!attr) return;
			attr.kind = normalizeAttributeKind(attr.kind);
			if (attr.kind === 'datetime') {
				attr.values = [];
			} else if (attr.kind === 'duration') {
				attr.values = [];
			} else if (attr.kind !== 'enum') {
				attr.values = [];
			}
			if (attr.kind !== 'enum') {
				attr.default = '';
			} else {
				sanitizeEnumDefault(attr);
			}
		}

		function sanitizeEnumDefault(attr) {
			if (!attr || normalizeAttributeKind(attr.kind) !== 'enum') return;
			var def = String(attr.default || '').trim();
			if (!def) {
				attr.default = '';
				return;
			}
			var vals = (Array.isArray(attr.values) ? attr.values : []).map(function (x) {
				return String(x || '').trim().toLowerCase();
			});
			if (vals.indexOf(def.toLowerCase()) < 0) {
				attr.default = '';
			}
		}

		function renderAttrValuesCell(a) {
			var kind = normalizeAttributeKind(a.kind);
			if (kind === 'datetime') {
				return '<input type="text" data-role="attr-values" disabled value="' + escapeHtml(FIXED_DATETIME_FORMAT_LABEL) + '" title="Fixed datetime format in DRIP">';
			}
			if (kind === 'duration') {
				return '<input type="text" data-role="attr-values" disabled value="' + escapeHtml(FIXED_DURATION_UNITS_LABEL) + '" title="Fixed duration units in DRIP">';
			}
			if (kind === SPECIAL_PARENT_KIND) {
				return '<input type="text" data-role="attr-values" disabled value="parent issue (i-N)" title="Fixed special key">';
			}
			return '<input type="text" data-role="attr-values" value="' + escapeHtml((a.values || []).join(', ')) + '" placeholder="comma values (enum)">';
		}

		function renderAttrKindCell(a, builtIn) {
			var kind = normalizeAttributeKind(a.kind);
			var disabled = builtIn ? ' disabled' : '';
			if (kind === SPECIAL_PARENT_KIND) {
				return '<select data-role="attr-kind" disabled title="Fixed special key"><option value="issue_parent" selected>parent</option></select>';
			}
			return '<select data-role="attr-kind"' + disabled + '>' +
				'<option value="enum"' + (kind === 'enum' ? ' selected' : '') + '>enum</option>' +
				'<option value="datetime"' + (kind === 'datetime' ? ' selected' : '') + '>datetime</option>' +
				'<option value="duration"' + (kind === 'duration' ? ' selected' : '') + '>duration</option>' +
			'</select>';
		}

		var LOCKED_METADATA_TYPE_IDS = { concept: true, task: true, issue: true };
		var LOCKED_FILE_LEVEL_TYPE_IDS = { project: true, feature: true };

		// Built-in template keys per type: fixed by the product, editable but never deletable.
		var BUILTIN_ATTRIBUTE_KEYS = {
			concept: ['domain', 'status'],
			task: ['status', 'priority', 'deadline', 'category'],
			issue: ['status', 'priority', 'deadline', 'category', 'parent'],
			project: ['status', 'priority', 'deadline'],
			feature: ['category']
		};

		function isBuiltInAttributeKey(typeId, key) {
			var list = BUILTIN_ATTRIBUTE_KEYS[String(typeId || '').trim().toLowerCase()];
			return !!list && list.indexOf(String(key || '').trim().toLowerCase()) >= 0;
		}

		function isLockedMetadataType(t) {
			var id = String((t && t.id) || '').trim().toLowerCase();
			return !!LOCKED_METADATA_TYPE_IDS[id];
		}

		function isLockedFileLevelType(t) {
			var id = String((t && t.id) || '').trim().toLowerCase();
			return !!LOCKED_FILE_LEVEL_TYPE_IDS[id];
		}

		function findDocumentTypeIndex(id) {
			var want = String(id || '').trim().toLowerCase();
			for (var i = 0; i < metadataTypesState.length; i++) {
				if (String((metadataTypesState[i] || {}).id || '').trim().toLowerCase() === want) return i;
			}
			return -1;
		}

		function resetIssueType() {
			var def = null;
			for (var i = 0; i < defaultMetadataTypes.length; i++) {
				if (String((defaultMetadataTypes[i] || {}).id || '').toLowerCase() === 'issue') {
					def = defaultMetadataTypes[i];
					break;
				}
			}
			if (!def) return;
			var idx = findDocumentTypeIndex('issue');
			var normalized = normalizeTypesFromSettings([def]);
			if (normalized.length) {
				if (idx >= 0) metadataTypesState[idx] = normalized[0];
				else metadataTypesState.push(normalized[0]);
			}
		}

		function addNewType() {
			metadataTypesState.push({
				id: 'new-type',
				marker: '.new-type',
				shortcut: '',
				displayTemplate: true,
				attributes: []
			});
			renderMetadataTypes();
		}

		function renderMetadataTypes() {
			var html = '';
			for (var i = 0; i < metadataTypesState.length; i++) {
				var t = metadataTypesState[i] || {};
				// Issue is shown in the Projects card, not the document list.
				if (String(t.id || '').trim().toLowerCase() === 'issue') continue;
				var attrs = Array.isArray(t.attributes) ? t.attributes : [];
				var rows = '';
				for (var j = 0; j < attrs.length; j++) {
					var a = attrs[j] || {};
					var builtIn = isBuiltInAttributeKey(t.id, a.key);
					rows += '<tr data-type-index="' + i + '" data-attr-index="' + j + '">' +
						'<td><input type="text" data-role="attr-key" value="' + escapeHtml(a.key) + '" placeholder="key"' + (builtIn ? ' disabled' : '') + '></td>' +
						'<td>' + renderAttrKindCell(a, builtIn) + '</td>' +
						'<td>' + renderAttrValuesCell(a) + '</td>' +
						'<td><label class="row" style="margin:0;"><input type="checkbox" data-role="attr-required"' + (a.required ? ' checked' : '') + '><span>required</span></label></td>' +
						'<td>' + (builtIn ? '<span class="meta">built-in</span>' : '<button class="iconBtn deleteIcon" data-role="remove-attr" title="Delete Attribute">🗑</button>') + '</td>' +
					'</tr>';
				}
				var locked = isLockedMetadataType(t);
				var deleteTypeBtn = locked
					? ''
					: '<button class="iconBtn deleteIcon" data-role="remove-type" title="Delete Metadata Type">🗑</button>';
				html +=
					'<details class="typeDetails" data-type-index="' + i + '" open>' +
						'<summary class="typeSummary">' +
							'<span>' + escapeHtml(t.marker || '.type') + ' (' + escapeHtml(t.id || 'type') + ')</span>' +
							'<span class="summaryRight">' + deleteTypeBtn + '<span class="chev">⌃</span></span>' +
						'</summary>' +
						'<div class="typeBody" data-type-index="' + i + '">' +
							'<div class="typeGrid">' +
								'<label class="row" style="display:block;margin:0;"><span>Type Id</span><input type="text" data-role="type-id" value="' + escapeHtml(t.id) + '"></label>' +
								'<label class="row" style="display:block;margin:0;"><span>Marker (must start with .)</span><input type="text" data-role="type-marker" value="' + escapeHtml(t.marker) + '"></label>' +
								'<label class="row" style="display:block;margin:0;"><span>Heading shortcut</span><input type="text" data-role="type-shortcut" value="' + escapeHtml(t.shortcut) + '" placeholder="t"></label>' +
								'<label class="row" style="display:block;margin:0;"><input type="checkbox" data-role="type-display-template"' + (t.displayTemplate !== false ? ' checked' : '') + '><span>Display template for this type</span></label>' +
							'</div>' +
							'<table class="attrTable">' +
								'<thead><tr><th>Key</th><th>Kind</th><th>Values</th><th>Required</th><th>Action</th></tr></thead>' +
								'<tbody>' + rows + '</tbody>' +
							'</table>' +
							'<div class="inlineActions">' +
								'<button class="iconBtn" data-role="add-attr" title="Add Attribute">+</button>' +
							'</div>' +
						'</div>' +
					'</details>';
			}
			metadataTypesListEl.innerHTML = html;
		}

		function renderFileLevelTypes() {
			var html = '';
			for (var i = 0; i < fileLevelTypesState.length; i++) {
				var t = fileLevelTypesState[i] || {};
				var typeId = String(t.id || '').trim().toLowerCase();
				var attrs = Array.isArray(t.attributes) ? t.attributes : [];
				var rows = '';
				for (var j = 0; j < attrs.length; j++) {
					var a = attrs[j] || {};
					var builtIn = isBuiltInAttributeKey(typeId, a.key);
					rows += '<tr data-type-index="' + i + '" data-attr-index="' + j + '">' +
						'<td><input type="text" data-role="attr-key" value="' + escapeHtml(a.key) + '" placeholder="key"' + (builtIn ? ' disabled' : '') + '></td>' +
						'<td>' + renderAttrKindCell(a, builtIn) + '</td>' +
						'<td>' + renderAttrValuesCell(a) + '</td>' +
						'<td><label class="row" style="margin:0;"><input type="checkbox" data-role="attr-required"' + (a.required ? ' checked' : '') + '><span>required</span></label></td>' +
						'<td>' + (builtIn ? '<span class="meta">built-in</span>' : '<button class="iconBtn deleteIcon" data-role="remove-attr" title="Delete Attribute">🗑</button>') + '</td>' +
					'</tr>';
				}
				var shortcutLabel = typeId === 'project' ? '.p' : typeId === 'feature' ? '.f' : '';
				html +=
					'<details class="typeDetails" data-type-index="' + i + '" open>' +
						'<summary class="typeSummary">' +
							'<span>' + escapeHtml(t.id || 'type') + ' (special)</span>' +
							'<span class="summaryRight"><span class="chev">⌃</span></span>' +
						'</summary>' +
						'<div class="typeBody" data-type-index="' + i + '">' +
							'<div class="typeGrid">' +
								'<label class="row" style="display:block;margin:0;"><span>Type Id</span><input type="text" data-role="type-id" value="' + escapeHtml(t.id) + '" disabled></label>' +
								'<label class="row" style="display:block;margin:0;"><span>Shortcut</span><input type="text" value="' + escapeHtml(shortcutLabel) + '" disabled></label>' +
							'</div>' +
							'<table class="attrTable">' +
								'<thead><tr><th>Key</th><th>Kind</th><th>Values</th><th>Required</th><th>Action</th></tr></thead>' +
								'<tbody>' + rows + '</tbody>' +
							'</table>' +
							'<div class="inlineActions">' +
								'<button class="iconBtn" data-role="add-attr" title="Add Attribute">+</button>' +
							'</div>' +
						'</div>' +
					'</details>';
			}

			// Issue is a document/heading type (stored in metadataTypes) but belongs to
			// Projects, so it is rendered here. Mark the block so edits route back to
			// metadataTypesState instead of fileLevelTypesState.
			var issueIndex = findDocumentTypeIndex('issue');
			if (issueIndex >= 0) {
				var it = metadataTypesState[issueIndex] || {};
				var iAttrs = Array.isArray(it.attributes) ? it.attributes : [];
				var iRows = '';
				for (var j = 0; j < iAttrs.length; j++) {
					var ia = iAttrs[j] || {};
					var builtIn = isBuiltInAttributeKey('issue', ia.key);
					iRows += '<tr data-attr-index="' + j + '">' +
						'<td><input type="text" data-role="attr-key" value="' + escapeHtml(ia.key) + '" placeholder="key"' + (builtIn ? ' disabled' : '') + '></td>' +
						'<td>' + renderAttrKindCell(ia, builtIn) + '</td>' +
						'<td>' + renderAttrValuesCell(ia) + '</td>' +
						'<td><label class="row" style="margin:0;"><input type="checkbox" data-role="attr-required"' + (ia.required ? ' checked' : '') + '><span>required</span></label></td>' +
						'<td>' + (builtIn ? '<span class="meta">built-in</span>' : '<button class="iconBtn deleteIcon" data-role="remove-attr" title="Delete Attribute">🗑</button>') + '</td>' +
					'</tr>';
				}
				html +=
					'<details class="typeDetails" data-type-index="' + issueIndex + '" data-source="document" open>' +
						'<summary class="typeSummary">' +
							'<span>' + escapeHtml(it.marker || '.issue') + ' (issue)</span>' +
							'<span class="summaryRight"><span class="chev">⌃</span></span>' +
						'</summary>' +
						'<div class="typeBody" data-type-index="' + issueIndex + '" data-source="document">' +
							'<div class="typeGrid">' +
								'<label class="row" style="display:block;margin:0;"><span>Type Id</span><input type="text" data-role="type-id" value="issue" disabled></label>' +
								'<label class="row" style="display:block;margin:0;"><span>Shortcut</span><input type="text" value="i" disabled></label>' +
							'</div>' +
							'<table class="attrTable">' +
								'<thead><tr><th>Key</th><th>Kind</th><th>Values</th><th>Required</th><th>Action</th></tr></thead>' +
								'<tbody>' + iRows + '</tbody>' +
							'</table>' +
							'<div class="inlineActions">' +
								'<button class="iconBtn" data-role="add-attr" title="Add Attribute">+</button>' +
							'</div>' +
						'</div>' +
					'</details>';
			}

			fileLevelTypesListEl.innerHTML = html;
		}

		function collectFileLevelTypesForSave() {
			var out = [];
			for (var i = 0; i < fileLevelTypesState.length; i++) {
				var t = fileLevelTypesState[i] || {};
				var id = String(t.id || '').trim().toLowerCase();
				if (!id || !LOCKED_FILE_LEVEL_TYPE_IDS[id]) continue;
				var marker = '.' + id;
				var attrsObj = {};
				var attrs = Array.isArray(t.attributes) ? t.attributes : [];
				for (var j = 0; j < attrs.length; j++) {
					var a = attrs[j] || {};
					var k = String(a.key || '').trim().toLowerCase();
					if (!k) continue;
					var kind = normalizeAttributeKind(a.kind);
					var values = kind === 'enum' && Array.isArray(a.values)
						? a.values.map(function (x) { return String(x || '').trim().toLowerCase(); }).filter(Boolean)
						: [];
					var entry = {
						kind: kind,
						default: kind === 'enum' ? String(a.default != null ? a.default : '').trim() : '',
						required: !!a.required
					};
					if (kind === 'enum') entry.values = values;
					attrsObj[k] = entry;
				}
				out.push({
					id: id,
					marker: marker,
					shortcut: id === 'project' ? 'p' : id === 'feature' ? 'f' : '',
					displayTemplate: true,
					attributes: attrsObj
				});
			}
			return out.length ? out : cloneJson(defaultFileLevelMetadataTypes);
		}

		function renderRelations() {
			var html = '';
			for (var i = 0; i < relationsState.length; i++) {
				var r = relationsState[i] || {};
				var locked = !!r.locked || String(r.name || '').toLowerCase() === 'tags';
				html += '<div class="typeDetails"><div class="typeBody" data-rel-index="' + i + '">' +
					'<div class="typeGrid">' +
						'<label class="row" style="display:block;margin:0;"><span>Relation Name</span><input type="text" data-role="rel-name" value="' + escapeHtml(r.name || '') + '"' + (locked ? ' disabled' : '') + '></label>' +
						'<label class="row" style="display:block;margin:0;"><span>Description</span><input type="text" data-role="rel-desc" value="' + escapeHtml(r.description || '') + '"></label>' +
					'</div>' +
					'<div class="inlineActions">' + (locked ? '<span class="meta">Locked default relation</span>' : '<button class="iconBtn secondary deleteIcon" data-role="remove-rel" title="Delete Relation">🗑</button>') + '</div>' +
				'</div></div>';
			}
			relationsListEl.innerHTML = html;
		}

		function renderMetadataMarks() {
			var html = '';
			for (var i = 0; i < metadataMarksState.length; i++) {
				var m = metadataMarksState[i] || {};
				var locked = !!m.locked || String(m.name || '') === 'L';
				html += '<div class="typeDetails"><div class="typeBody" data-mark-index="' + i + '">' +
					'<div class="typeGrid">' +
						'<label class="row" style="display:block;margin:0;"><span>Mark</span><input type="text" data-role="mark-name" value="' + escapeHtml(m.name || '') + '"' + (locked ? ' disabled' : '') + '></label>' +
						'<label class="row" style="display:block;margin:0;"><span>Description</span><input type="text" data-role="mark-desc" value="' + escapeHtml(m.description || '') + '"' + (locked ? ' disabled' : '') + '></label>' +
						'<label class="row" style="display:block;margin:0;"><span>Mark letter color</span><div class="colorRow"><input type="text" data-role="mark-color" value="' + escapeHtml(m.markColor || m.color || '') + '" placeholder="no color (plain text)"><input type="color" class="colorPatch" data-role="mark-color-picker" value="' + escapeHtml(/^#([0-9a-f]{6})$/i.test(String(m.markColor || m.color || '')) ? String(m.markColor || m.color || '') : '#808080') + '"></div></label>' +
						'<label class="row" style="display:block;margin:0;"><span>Text color</span><div class="colorRow"><input type="text" data-role="mark-text-color" value="' + escapeHtml(m.textColor || '') + '" placeholder="no color (plain text)"><input type="color" class="colorPatch" data-role="mark-text-color-picker" value="' + escapeHtml(/^#([0-9a-f]{6})$/i.test(String(m.textColor || '')) ? String(m.textColor || '') : '#808080') + '"></div></label>' +
					'</div>' +
					'<div class="inlineActions">' + (locked ? '<span class="meta">Locked default mark</span>' : '<button class="iconBtn secondary deleteIcon" data-role="remove-mark" title="Delete Mark">🗑</button>') + '</div>' +
				'</div></div>';
			}
			metadataMarksListEl.innerHTML = html;
		}

		var DOC_COLOR_SLOTS = [
			{ key: 'color1', title: 'Color 1 — Metadata type / shortcut', desc: 'e.g. .concept, .c, c', proxies: ['--vscode-debugTokenExpression-type'], fallback: '#4ec9b0' },
			{ key: 'color2', title: 'Color 2 — Heading line (bold)', desc: 'the whole heading, e.g. # .c My title', proxies: ['--vscode-debugTokenExpression-boolean'], fallback: '#569cd6' },
			{ key: 'color3', title: 'Color 3 — Metadata keys', desc: 'e.g. status, deadline, parent', proxies: ['--vscode-debugTokenExpression-name'], fallback: '#c586c0' },
			{ key: 'color4', title: 'Color 4 — Tag / relation keys', desc: 'e.g. tags, pre-req', proxies: ['--vscode-debugTokenExpression-boolean'], fallback: '#569cd6' },
			{ key: 'color5', title: 'Color 5 — Values & separators', desc: 'metadata values, tag items, fileid value, ---', proxies: ['--vscode-debugTokenExpression-string'], fallback: '#ce9178' },
			{ key: 'color6', title: 'Color 6 — File identity keys', desc: 'filename, fileid, headings', proxies: ['--vscode-symbolIcon-fieldForeground', '--vscode-debugTokenExpression-boolean'], fallback: '#4fc1ff' }
		];

		function normalizeDocColors(raw) {
			var out = { color1: '', color2: '', color3: '', color4: '', color5: '', color6: '' };
			raw = raw || {};
			for (var i = 1; i <= 6; i++) {
				var key = 'color' + i;
				var v = String(raw[key] || '').trim();
				out[key] = /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : '';
			}
			return out;
		}

		function docColorCss(key) {
			return docColorHex(key);
		}

		function docSpan(color, bold, text) {
			return '<span class="' + (bold ? 'bold' : '') + '" style="color:' + color + '">' + escapeHtml(text) + '</span>';
		}

		function cssColorToHex(colorStr) {
			var m = String(colorStr || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
			if (!m) return '';
			var r = parseInt(m[1], 10);
			var g = parseInt(m[2], 10);
			var b = parseInt(m[3], 10);
			var a = m[4] != null ? parseFloat(m[4]) : 1;
			if (a < 1) {
				r = Math.round(r * a + 255 * (1 - a));
				g = Math.round(g * a + 255 * (1 - a));
				b = Math.round(b * a + 255 * (1 - a));
			}
			function hx(n) { var h = n.toString(16); return h.length === 1 ? '0' + h : h; }
			return '#' + hx(r) + hx(g) + hx(b);
		}

		function readThemeVar(name) {
			var v = getComputedStyle(document.documentElement).getPropertyValue(name);
			return (v && String(v).trim()) ? String(v).trim() : '';
		}

		function themeVarToHex(name) {
			var raw = readThemeVar(name);
			if (!raw) return '';
			return normalizeHexColor(raw) || cssColorToHex(raw);
		}

		function docColorHex(key) {
			var val = String(docColorsState[key] || '').trim();
			if (/^#[0-9a-f]{6}$/i.test(val)) return val;
			// Prefer the real color the editor shows (resolved in the extension host).
			if (docThemeColors && /^#[0-9a-f]{6}$/i.test(String(docThemeColors[key] || ''))) {
				return String(docThemeColors[key]).toLowerCase();
			}
			for (var i = 0; i < DOC_COLOR_SLOTS.length; i++) {
				var slot = DOC_COLOR_SLOTS[i];
				if (slot.key !== key) continue;
				for (var p = 0; p < slot.proxies.length; p++) {
					var hex = themeVarToHex(slot.proxies[p]);
					if (hex) return hex;
				}
				return slot.fallback;
			}
			return '#808080';
		}

		function renderDocColoringRows() {
			var rowsHtml = '';
			for (var i = 0; i < DOC_COLOR_SLOTS.length; i++) {
				var slot = DOC_COLOR_SLOTS[i];
				var pickerVal = docColorHex(slot.key);
				rowsHtml += '<div class="docColorRow" data-slot="' + slot.key + '">' +
					'<div class="lbl"><span class="t">' + escapeHtml(slot.title) + '</span><span class="d">' + escapeHtml(slot.desc) + '</span></div>' +
					'<input type="color" class="swatch" data-role="doc-color-picker" value="' + escapeHtml(pickerVal) + '">' +
					'</div>';
			}
			docColoringRowsEl.innerHTML = rowsHtml;
		}

		function renderDocColoringSample() {
			var c = {};
			for (var k = 1; k <= 6; k++) c['color' + k] = docColorCss('color' + k);
			var plain = 'var(--vscode-foreground)';
			var s = '';
			s += docSpan(c.color6, false, 'filename') + docSpan(plain, false, ': ') + docSpan(c.color5, false, 'my-note') + '\\n';
			s += docSpan(c.color6, false, 'fileid') + docSpan(plain, false, ': ') + docSpan(c.color5, false, '@abc123def4') + '\\n';
			s += docSpan(c.color6, false, 'headings') + docSpan(plain, false, ': ') + docSpan(c.color5, false, '3') + '\\n';
			s += docSpan(c.color5, false, '---') + '\\n';
			s += docSpan(c.color2, true, '# ') + docSpan(c.color1, true, '.c') + docSpan(c.color2, true, ' My Concept') + '\\n';
			s += docSpan(c.color3, false, 'status') + docSpan(plain, false, ': ') + docSpan(c.color5, false, 'active') + '\\n';
			s += docSpan(c.color3, false, 'deadline') + docSpan(plain, false, ': ') + docSpan(c.color5, false, '2026-12-31') + '\\n';
			s += docSpan(c.color4, false, 'tags') + docSpan(plain, false, ': ') + docSpan(c.color5, false, '[drip, notes]') + '\\n';
			s += docSpan(c.color4, false, 'pre-req') + docSpan(plain, false, ': ') + docSpan(c.color5, false, '[setup]') + '\\n';
			docColoringSampleEl.innerHTML = s;
		}

		function renderDocColoring() {
			renderDocColoringRows();
			renderDocColoringSample();
		}

		function collectTypesForSave() {
			var out = [];
			for (var i = 0; i < metadataTypesState.length; i++) {
				var t = metadataTypesState[i] || {};
				var id = String(t.id || '').trim().toLowerCase();
				var marker = String(t.marker || '').trim().toLowerCase();
				if (marker && !marker.startsWith('.')) marker = '.' + marker;
				if (!id || !marker) continue;
				var attrsObj = {};
				var attrs = Array.isArray(t.attributes) ? t.attributes : [];
				for (var j = 0; j < attrs.length; j++) {
					var a = attrs[j] || {};
					var k = String(a.key || '').trim().toLowerCase();
					if (!k) continue;
					var kind = normalizeAttributeKind(a.kind);
					var values = kind === 'enum' && Array.isArray(a.values)
						? a.values.map(function (x) { return String(x || '').trim().toLowerCase(); }).filter(Boolean)
						: [];
					var entry = {
						kind: kind,
						default: kind === 'enum' ? String(a.default != null ? a.default : '').trim() : '',
						required: !!a.required
					};
					if (kind === 'enum') entry.values = values;
					attrsObj[k] = entry;
				}
				out.push({
					id: id,
					marker: marker,
					shortcut: String(t.shortcut != null ? t.shortcut : '').trim(),
					displayTemplate: t.displayTemplate !== false,
					attributes: attrsObj
				});
			}
			return out;
		}

		for (var iNav = 0; iNav < navButtons.length; iNav++) {
			(function (btn) {
				btn.addEventListener('click', function () {
					var panelId = btn.getAttribute('data-panel');
					showPanel(panelId);
					if (panelId === 'saved-settings') {
						vscode.postMessage({ type: 'requestSettings' });
					}
					if (panelId === 'shortcuts') {
						vscode.postMessage({ type: 'requestShortcuts' });
					}
				});
			})(navButtons[iNav]);
		}

		function lowerList(arr) {
			return (arr || []).map(function (x) { return String(x).trim().toLowerCase(); });
		}

		function normalizeExtEntry(s) {
			var t = String(s || '').trim().toLowerCase();
			return t.indexOf('.') === 0 ? t : (t ? '.' + t : '');
		}

		function mergeKbExtensionsList() {
			var seen = {};
			var out = [];
			function add(x) {
				var n = normalizeExtEntry(x);
				if (n && !seen[n]) {
					seen[n] = true;
					out.push(n);
				}
			}
			for (var i = 0; i < preservedOtherExts.length; i++) {
				add(preservedOtherExts[i]);
			}
			if (kbExtDtxt.checked) add('.d.txt');
			if (kbExtMd.checked) add('.md');
			if (!out.length) add('.d.txt');
			return out;
		}

		function rebuildDefaultSelect(exts, selected) {
			kbDefaultExt.innerHTML = '';
			var list = exts && exts.length ? exts : ['.d.txt', '.md'];
			for (var i = 0; i < list.length; i++) {
				var opt = document.createElement('option');
				opt.value = list[i];
				opt.textContent = list[i];
				kbDefaultExt.appendChild(opt);
			}
			var want = String(selected || list[0] || '.d.txt').toLowerCase();
			var found = null;
			for (var j = 0; j < list.length; j++) {
				if (String(list[j]).toLowerCase() === want) {
					found = list[j];
					break;
				}
			}
			kbDefaultExt.value = found || list[0];
		}

		function pushKbExtensionSettings() {
			var exts = mergeKbExtensionsList();
			vscode.postMessage({ type: 'updateSetting', key: 'knowledgeBaseFileExtensions', value: exts });
			rebuildDefaultSelect(exts, kbDefaultExt.value);
			var cur = String(kbDefaultExt.value).toLowerCase();
			var ok = false;
			for (var i = 0; i < exts.length; i++) {
				if (String(exts[i]).toLowerCase() === cur) {
					ok = true;
					break;
				}
			}
			if (!ok) {
				kbDefaultExt.value = exts[0];
			}
			vscode.postMessage({ type: 'updateSetting', key: 'defaultNewNoteExtension', value: kbDefaultExt.value });
		}

		window.addEventListener('message', function (event) {
			var message = event.data;
			if (message.type !== 'settingsValues') return;
			autoOpenEl.checked = !!message.autoOpenComposerOnSidebarReveal;
			var raw = message.knowledgeBaseFileExtensions || [];
			var low = lowerList(raw);
			preservedOtherExts = raw.filter(function (e) {
				var l = String(e).trim().toLowerCase();
				return l !== '.d.txt' && l !== '.md';
			});
			kbExtDtxt.checked = low.indexOf('.d.txt') >= 0;
			kbExtMd.checked = low.indexOf('.md') >= 0;
			if (!kbExtDtxt.checked && !kbExtMd.checked && preservedOtherExts.length === 0) {
				kbExtDtxt.checked = true;
			}
			rebuildDefaultSelect(mergeKbExtensionsList(), message.defaultNewNoteExtension || '.d.txt');
			optTemplateEnabled.checked = !!message.metadataTemplatesEnabled;
			optTemplateAuto.checked = !!message.metadataAutoInsertTemplate;
			optTemplateStrict.checked = !!message.metadataStrictValidation;
			optTemplateIgnore.checked = !!message.metadataIgnoreErrors;
			optTemplateIndentErrors.checked = !!message.metadataShowIndentErrors;
			optHeadingHierarchyIndent.checked = !!message.showHeadingHierarchyIndentErrors;
			metadataTypesState = normalizeTypesFromSettings(message.metadataTypes);
			renderMetadataTypes();
			fileLevelTypesState = normalizeTypesFromSettings(
				message.fileLevelMetadataTypes && message.fileLevelMetadataTypes.length
					? message.fileLevelMetadataTypes
					: defaultFileLevelMetadataTypes
			);
			renderFileLevelTypes();
			var tr = message.tagsRelationsConfig || {};
			relationsState = Array.isArray(tr.relations) && tr.relations.length ? tr.relations : [
				{ name: 'tags', description: 'Special default relation for tags.', locked: true },
				{ name: 'pre-req', description: 'Prerequisite relation.', locked: false }
			];
			if (!relationsState.some(function (x) { return String((x && x.name) || '').toLowerCase() === 'tags'; })) {
				relationsState.unshift({ name: 'tags', description: 'Special default relation for tags.', locked: true });
			}
			metadataMarksState = (message.dripMetadataMarks && Array.isArray(message.dripMetadataMarks.marks) && message.dripMetadataMarks.marks.length)
				? message.dripMetadataMarks.marks
				: [
					{ name: 'L', description: 'Link marker. Example: L: ![file-name - @fileid](rel/path/to/file)', markColor: '', textColor: '', locked: true },
					{ name: 'Q', description: 'Question marker.', markColor: '', textColor: '', locked: false },
					{ name: 'R', description: 'Reference marker.', markColor: '', textColor: '', locked: false }
				];
			renderRelations();
			renderMetadataMarks();
			docColorsState = normalizeDocColors(message.dripnoteDocColors);
			docThemeColors = message.dripnoteDocThemeColors || null;
			renderDocColoring();
			if (optEditHeadingsRhs) optEditHeadingsRhs.checked = message.editHeadingsViaRhs !== false;
			if (optEditHeadingsFile) optEditHeadingsFile.checked = !!message.editHeadingsInFile && message.editHeadingsViaRhs === false;
			if (savedSettingsPathEl) {
				var p = String(message.kbSettingsFilePath || '').trim();
				savedSettingsPathEl.textContent = p || '(no knowledge base selected — bind a .driplock folder first)';
			}
			applyGithubBackupStatus(message.githubBackupStatus || null);
			applyMcpStatus(message.mcpStatus || null);
			applyLlmStatus(message.llmStatus || null);
		});

		window.addEventListener('message', function (event) {
			var message = event.data;
			if (message.type === 'githubBackupStatus') {
				applyGithubBackupStatus(message.status || null);
			} else if (message.type === 'mcpStatus') {
				applyMcpStatus(message.status || null);
			} else if (message.type === 'showPanel' && panels[message.panel]) {
				showPanel(message.panel);
			} else if (message.type === 'docThemeColors') {
				docThemeColors = message.colors || null;
				renderDocColoring();
			}
		});

		function setText(id, value) {
			var el = document.getElementById(id);
			if (el) el.textContent = value == null ? '' : String(value);
		}

		function applyMcpStatus(st) {
			if (!st) return;
			var enabledEl = document.getElementById('mcp-enabled');
			var portEl = document.getElementById('mcp-port');
			var dot = document.getElementById('mcp-dot');
			if (enabledEl) enabledEl.checked = !!st.enabled;
			if (portEl && document.activeElement !== portEl) portEl.value = String(st.port || '');
			var line = !st.enabled
				? 'Off — turn it on to let AI apps connect.'
				: st.running
					? 'Running at ' + st.url
					: 'Turned on, but not running.';
			setText('mcp-status-line', line);
			setText('mcp-error', st.enabled && st.error ? st.error : '');
			if (dot) {
				dot.classList.toggle('on', !!(st.enabled && st.running));
				dot.classList.toggle('err', !!(st.enabled && !st.running));
			}
			setText('mcp-name', st.serverName);
			setText('mcp-url', st.url);
			setText('mcp-transport', st.transport);
			setText('mcp-header', st.authHeader);
			setText('mcp-token', st.hasToken ? st.tokenPreview : 'created when the server first starts');
			setText('mcp-tools', 'search_tools + call_tool (' + st.toolCount + ' DRIP tools behind them)');
			setText('mcp-http-config', st.httpConfigPreview);
			setText('mcp-stdio-config', st.stdioConfigPreview);
		}

		function applyLlmStatus(st) {
			if (!st) return;
			if (llmEnabledEl) llmEnabledEl.checked = !!st.enabled;
			if (llmBaseUrlEl && document.activeElement !== llmBaseUrlEl) llmBaseUrlEl.value = String(st.baseUrl || '');
			if (llmModelEl && document.activeElement !== llmModelEl) llmModelEl.value = String(st.model || '');
			setText('llm-key-status', st.hasKey ? 'API key: saved (Secret Storage)' : 'API key: not set');
		}

		function fmtTime(iso) {
			if (!iso) return 'never';
			try {
				return new Date(iso).toLocaleString();
			} catch (e) {
				return String(iso);
			}
		}

		function applyGithubBackupStatus(st) {
			var statusLine = document.getElementById('gh-status-line');
			var statusDetail = document.getElementById('gh-status-detail');
			var statusError = document.getElementById('gh-status-error');
			var remoteEl = document.getElementById('gh-remote-url');
			var branchEl = document.getElementById('gh-branch');
			var patStatus = document.getElementById('gh-pat-status');
			if (!statusLine) return;
			if (!st) {
				statusLine.textContent = 'Select a knowledge base to configure backup.';
				if (statusDetail) statusDetail.textContent = '';
				if (statusError) statusError.textContent = '';
				if (patStatus) patStatus.textContent = 'Token: not set';
				return;
			}
			if (!st.gitAvailable) {
				statusLine.textContent = 'Git not found on PATH — install Git, then reload.';
			} else if (st.connected) {
				statusLine.textContent = 'Connected — ready to push / pull.';
			} else if (st.isRepo && st.remoteUrl) {
				statusLine.textContent = 'Repo ready — save remote and Initialize if origin is missing.';
			} else if (st.remoteUrl) {
				statusLine.textContent = 'Remote saved — run Initialize backup.';
			} else {
				statusLine.textContent = 'Not connected — enter a remote URL.';
			}
			var bits = [];
			if (st.branch) bits.push('branch: ' + st.branch);
			bits.push('last push: ' + fmtTime(st.lastPushAt));
			bits.push('last pull: ' + fmtTime(st.lastPullAt));
			if (st.dirty) bits.push('uncommitted changes');
			if (statusDetail) statusDetail.textContent = bits.join(' · ');
			if (statusError) statusError.textContent = st.lastError ? String(st.lastError) : '';
			if (remoteEl && document.activeElement !== remoteEl) {
				remoteEl.value = String(st.remoteUrl || '');
			}
			if (branchEl && document.activeElement !== branchEl) {
				branchEl.value = String(st.branch || 'main');
			}
			if (patStatus) {
				patStatus.textContent = st.hasPat ? 'Token: saved (Secret Storage)' : 'Token: not set';
			}
		}

		vscode.postMessage({ type: 'requestSettings' });

		autoOpenEl.addEventListener('change', function () {
			vscode.postMessage({ type: 'updateSetting', key: 'autoOpenComposerOnSidebarReveal', value: autoOpenEl.checked });
		});
		kbExtDtxt.addEventListener('change', function () {
			if (!kbExtDtxt.checked && !kbExtMd.checked) kbExtMd.checked = true;
			pushKbExtensionSettings();
		});
		kbExtMd.addEventListener('change', function () {
			if (!kbExtDtxt.checked && !kbExtMd.checked) kbExtDtxt.checked = true;
			pushKbExtensionSettings();
		});
		kbDefaultExt.addEventListener('change', function () {
			vscode.postMessage({ type: 'updateSetting', key: 'defaultNewNoteExtension', value: kbDefaultExt.value });
		});
		function postBool(el, key) { vscode.postMessage({ type: 'updateSetting', key: key, value: !!el.checked }); }
		optTemplateEnabled.addEventListener('change', function(){ postBool(optTemplateEnabled, 'metadataTemplatesEnabled'); });
		optTemplateAuto.addEventListener('change', function(){ postBool(optTemplateAuto, 'metadataAutoInsertTemplate'); });
		optTemplateStrict.addEventListener('change', function(){ postBool(optTemplateStrict, 'metadataStrictValidation'); });
		optTemplateIgnore.addEventListener('change', function(){ postBool(optTemplateIgnore, 'metadataIgnoreErrors'); });
		optTemplateIndentErrors.addEventListener('change', function(){ postBool(optTemplateIndentErrors, 'metadataShowIndentErrors'); });
		optHeadingHierarchyIndent.addEventListener('change', function(){ postBool(optHeadingHierarchyIndent, 'showHeadingHierarchyIndentErrors'); });
		function parseJsonArea(el, fallback) {
			try { return JSON.parse(String(el.value || '')); } catch { return fallback; }
		}
		document.getElementById('btn-add-type').addEventListener('click', function () {
			addNewType();
		});
		metadataTypesListEl.addEventListener('input', function (ev) {
			var target = ev.target;
			if (!target) return;
			var body = target.closest('[data-type-index]');
			if (!body) return;
			var typeIndex = Number(body.getAttribute('data-type-index'));
			if (!Number.isFinite(typeIndex) || !metadataTypesState[typeIndex]) return;
			var role = target.getAttribute('data-role');
			var typeRef = metadataTypesState[typeIndex];
			if (role === 'type-id') typeRef.id = String(target.value || '').trim().toLowerCase();
			if (role === 'type-marker') {
				var markerVal = String(target.value || '').trim().toLowerCase();
				typeRef.marker = markerVal ? (markerVal.startsWith('.') ? markerVal : '.' + markerVal) : '';
				target.value = typeRef.marker;
			}
			if (role === 'type-shortcut') {
				typeRef.shortcut = String(target.value != null ? target.value : '').trim();
				return;
			}
			if (role === 'type-display-template') typeRef.displayTemplate = !!target.checked;
			var row = target.closest('tr[data-attr-index]');
			if (row) {
				var attrIndex = Number(row.getAttribute('data-attr-index'));
				if (Number.isFinite(attrIndex) && typeRef.attributes && typeRef.attributes[attrIndex]) {
					var attr = typeRef.attributes[attrIndex];
					if (role === 'attr-key') attr.key = String(target.value || '').trim().toLowerCase();
					if (role === 'attr-kind') {
						attr.kind = normalizeAttributeKind(target.value);
						normalizeAttrByKind(attr);
						renderMetadataTypes();
						return;
					}
					if (role === 'attr-values') {
						if (normalizeAttributeKind(attr.kind) !== 'enum') return;
						attr.values = String(target.value || '')
							.split(',')
							.map(function (x) { return String(x || '').trim(); })
							.filter(Boolean);
						return;
					}
					if (role === 'attr-required') attr.required = !!target.checked;
				}
			}
		});
		metadataTypesListEl.addEventListener('change', function (ev) {
			var target = ev.target;
			if (!target) return;
			var role = target.getAttribute('data-role');
			if (role !== 'attr-values') return;
			var row = target.closest('tr[data-attr-index]');
			if (!row) return;
			var scope = target.closest('[data-type-index]');
			if (!scope) return;
			var typeIndex = Number(scope.getAttribute('data-type-index'));
			var attrIndex = Number(row.getAttribute('data-attr-index'));
			if (!Number.isFinite(typeIndex) || !Number.isFinite(attrIndex)) return;
			var typeRef = metadataTypesState[typeIndex];
			if (!typeRef || !typeRef.attributes || !typeRef.attributes[attrIndex]) return;
			var attr = typeRef.attributes[attrIndex];
			if (normalizeAttributeKind(attr.kind) !== 'enum') return;
			attr.values = String(target.value || '')
				.split(',')
				.map(function (x) { return String(x || '').trim(); })
				.filter(Boolean);
			sanitizeEnumDefault(attr);
			renderMetadataTypes();
		});
		metadataTypesListEl.addEventListener('click', function (ev) {
			var target = ev.target;
			if (!target) return;
			var role = target.getAttribute('data-role');
			if (!role) return;
			var scope = target.closest('[data-type-index]');
			if (!scope) return;
			var typeIndex = Number(scope.getAttribute('data-type-index'));
			if (!Number.isFinite(typeIndex) || !metadataTypesState[typeIndex]) return;
			if (role === 'remove-type') {
				if (isLockedMetadataType(metadataTypesState[typeIndex])) return;
				ev.preventDefault();
				ev.stopPropagation();
				metadataTypesState.splice(typeIndex, 1);
				renderMetadataTypes();
				return;
			}
			if (role === 'add-attr') {
				ev.preventDefault();
				ev.stopPropagation();
				if (!Array.isArray(metadataTypesState[typeIndex].attributes)) metadataTypesState[typeIndex].attributes = [];
				metadataTypesState[typeIndex].attributes.push({ key: '', kind: 'enum', values: [], default: '', required: false });
				renderMetadataTypes();
				return;
			}
			if (role === 'remove-attr') {
				ev.preventDefault();
				ev.stopPropagation();
				var row = target.closest('tr[data-attr-index]');
				if (!row) return;
				var attrIndex = Number(row.getAttribute('data-attr-index'));
				if (!Number.isFinite(attrIndex)) return;
				var attrKey = metadataTypesState[typeIndex].attributes[attrIndex] && metadataTypesState[typeIndex].attributes[attrIndex].key;
				if (isBuiltInAttributeKey(metadataTypesState[typeIndex].id, attrKey)) return;
				metadataTypesState[typeIndex].attributes.splice(attrIndex, 1);
				renderMetadataTypes();
			}
		});
		fileLevelTypesListEl.addEventListener('input', function (ev) {
			var target = ev.target;
			if (!target) return;
			var body = target.closest('[data-type-index]');
			if (!body) return;
			var typeIndex = Number(body.getAttribute('data-type-index'));
			var stateArr = body.getAttribute('data-source') === 'document' ? metadataTypesState : fileLevelTypesState;
			if (!Number.isFinite(typeIndex) || !stateArr[typeIndex]) return;
			var role = target.getAttribute('data-role');
			var typeRef = stateArr[typeIndex];
			var row = target.closest('tr[data-attr-index]');
			if (row) {
				var attrIndex = Number(row.getAttribute('data-attr-index'));
				if (Number.isFinite(attrIndex) && typeRef.attributes && typeRef.attributes[attrIndex]) {
					var attr = typeRef.attributes[attrIndex];
					if (role === 'attr-key') attr.key = String(target.value || '').trim().toLowerCase();
					if (role === 'attr-kind') {
						attr.kind = normalizeAttributeKind(target.value);
						normalizeAttrByKind(attr);
						renderFileLevelTypes();
						return;
					}
					if (role === 'attr-values') {
						if (normalizeAttributeKind(attr.kind) !== 'enum') return;
						attr.values = String(target.value || '')
							.split(',')
							.map(function (x) { return String(x || '').trim(); })
							.filter(Boolean);
						return;
					}
					if (role === 'attr-required') attr.required = !!target.checked;
				}
			}
		});
		fileLevelTypesListEl.addEventListener('click', function (ev) {
			var target = ev.target;
			if (!target) return;
			var role = target.getAttribute('data-role');
			if (!role) return;
			var scope = target.closest('[data-type-index]');
			if (!scope) return;
			var typeIndex = Number(scope.getAttribute('data-type-index'));
			var stateArr = scope.getAttribute('data-source') === 'document' ? metadataTypesState : fileLevelTypesState;
			if (!Number.isFinite(typeIndex) || !stateArr[typeIndex]) return;
			if (role === 'add-attr') {
				ev.preventDefault();
				ev.stopPropagation();
				if (!Array.isArray(stateArr[typeIndex].attributes)) stateArr[typeIndex].attributes = [];
				stateArr[typeIndex].attributes.push({ key: '', kind: 'enum', values: [], default: '', required: false });
				renderFileLevelTypes();
				return;
			}
			if (role === 'remove-attr') {
				ev.preventDefault();
				ev.stopPropagation();
				var row = target.closest('tr[data-attr-index]');
				if (!row) return;
				var attrIndex = Number(row.getAttribute('data-attr-index'));
				if (!Number.isFinite(attrIndex)) return;
				var attrKey = stateArr[typeIndex].attributes[attrIndex] && stateArr[typeIndex].attributes[attrIndex].key;
				if (isBuiltInAttributeKey(stateArr[typeIndex].id, attrKey)) return;
				stateArr[typeIndex].attributes.splice(attrIndex, 1);
				renderFileLevelTypes();
			}
		});
		document.getElementById('btn-save-types').addEventListener('click', function () {
			var types = collectTypesForSave();
			vscode.postMessage({ type: 'updateSetting', key: 'metadataTypes', value: types.length ? types : defaultMetadataTypes });
		});
		document.getElementById('btn-reset-types').addEventListener('click', function () {
			metadataTypesState = normalizeTypesFromSettings(defaultMetadataTypes);
			renderMetadataTypes();
			renderFileLevelTypes();
			vscode.postMessage({ type: 'updateSetting', key: 'metadataTypes', value: defaultMetadataTypes });
		});
		document.getElementById('btn-save-file-types').addEventListener('click', function () {
			// The Projects card edits issue too, and issue lives in metadataTypes — save both.
			var types = collectTypesForSave();
			vscode.postMessage({
				type: 'updateSetting',
				key: 'fileLevelMetadataTypes',
				value: collectFileLevelTypesForSave()
			});
			vscode.postMessage({ type: 'updateSetting', key: 'metadataTypes', value: types.length ? types : defaultMetadataTypes });
		});
		document.getElementById('btn-reset-file-types').addEventListener('click', function () {
			fileLevelTypesState = normalizeTypesFromSettings(defaultFileLevelMetadataTypes);
			resetIssueType();
			renderFileLevelTypes();
			vscode.postMessage({
				type: 'updateSetting',
				key: 'fileLevelMetadataTypes',
				value: defaultFileLevelMetadataTypes
			});
			var types = collectTypesForSave();
			vscode.postMessage({ type: 'updateSetting', key: 'metadataTypes', value: types.length ? types : defaultMetadataTypes });
		});
		document.getElementById('btn-save-metadata-panel').addEventListener('click', function () {
			postBool(optTemplateEnabled, 'metadataTemplatesEnabled');
			postBool(optTemplateAuto, 'metadataAutoInsertTemplate');
			postBool(optTemplateStrict, 'metadataStrictValidation');
			postBool(optTemplateIgnore, 'metadataIgnoreErrors');
			postBool(optTemplateIndentErrors, 'metadataShowIndentErrors');
			postBool(optHeadingHierarchyIndent, 'showHeadingHierarchyIndentErrors');
			var types = collectTypesForSave();
			vscode.postMessage({ type: 'updateSetting', key: 'metadataTypes', value: types.length ? types : defaultMetadataTypes });
			vscode.postMessage({
				type: 'updateSetting',
				key: 'fileLevelMetadataTypes',
				value: collectFileLevelTypesForSave()
			});
		});
		document.getElementById('btn-add-relation').addEventListener('click', function () {
			relationsState.push({ name: 'new-relation', description: '', locked: false });
			renderRelations();
		});
		relationsListEl.addEventListener('input', function (ev) {
			var target = ev.target;
			if (!target) return;
			var body = target.closest('[data-rel-index]');
			if (!body) return;
			var idx = Number(body.getAttribute('data-rel-index'));
			if (!Number.isFinite(idx) || !relationsState[idx]) return;
			var role = target.getAttribute('data-role');
			if (role === 'rel-name') relationsState[idx].name = String(target.value || '').trim();
			if (role === 'rel-desc') relationsState[idx].description = String(target.value || '');
		});
		relationsListEl.addEventListener('click', function (ev) {
			var target = ev.target;
			if (!target || target.getAttribute('data-role') !== 'remove-rel') return;
			ev.preventDefault();
			var body = target.closest('[data-rel-index]');
			if (!body) return;
			var idx = Number(body.getAttribute('data-rel-index'));
			if (!Number.isFinite(idx) || !relationsState[idx]) return;
			if (String(relationsState[idx].name || '').toLowerCase() === 'tags' || relationsState[idx].locked) return;
			relationsState.splice(idx, 1);
			renderRelations();
		});
		document.getElementById('btn-save-relations').addEventListener('click', function () {
			var rows = relationsState
				.map(function (r) {
					return {
						name: String((r && r.name) || '').trim(),
						description: String((r && r.description) || ''),
						locked: !!(r && r.locked) || String((r && r.name) || '').toLowerCase() === 'tags'
					};
				})
				.filter(function (r) { return !!r.name; });
			if (!rows.some(function (x) { return String(x.name || '').toLowerCase() === 'tags'; })) {
				rows.unshift({ name: 'tags', description: 'Special default relation for tags.', locked: true });
			}
			var allowed = rows.map(function (x) { return String(x.name || '').toLowerCase(); }).filter(Boolean);
			vscode.postMessage({
				type: 'updateSetting',
				key: 'tagsRelationsConfig',
				value: {
					relations: rows,
					allowed: allowed
				}
			});
		});
		document.getElementById('btn-add-metadata-mark').addEventListener('click', function () {
			metadataMarksState.push({ name: 'X', description: '', color: '', locked: false });
			renderMetadataMarks();
		});
		metadataMarksListEl.addEventListener('input', function (ev) {
			var target = ev.target;
			if (!target) return;
			var body = target.closest('[data-mark-index]');
			if (!body) return;
			var idx = Number(body.getAttribute('data-mark-index'));
			if (!Number.isFinite(idx) || !metadataMarksState[idx]) return;
			var role = target.getAttribute('data-role');
			if (role === 'mark-name') metadataMarksState[idx].name = String(target.value || '').trim();
			if (role === 'mark-desc') metadataMarksState[idx].description = String(target.value || '');
			if (role === 'mark-color') {
				metadataMarksState[idx].markColor = String(target.value || '').trim();
				var markPicker = body.querySelector('input[data-role="mark-color-picker"]');
				syncColorPickerFromText(target, markPicker);
			}
			if (role === 'mark-text-color') {
				metadataMarksState[idx].textColor = String(target.value || '').trim();
				var textPicker = body.querySelector('input[data-role="mark-text-color-picker"]');
				syncColorPickerFromText(target, textPicker);
			}
			if (role === 'mark-color-picker') {
				metadataMarksState[idx].markColor = String(target.value || '').trim().toLowerCase();
				var markText = body.querySelector('input[data-role="mark-color"]');
				if (markText) markText.value = metadataMarksState[idx].markColor;
			}
			if (role === 'mark-text-color-picker') {
				metadataMarksState[idx].textColor = String(target.value || '').trim().toLowerCase();
				var textColorText = body.querySelector('input[data-role="mark-text-color"]');
				if (textColorText) textColorText.value = metadataMarksState[idx].textColor;
			}
		});
		metadataMarksListEl.addEventListener('click', function (ev) {
			var target = ev.target;
			if (!target) return;
			var role = target.getAttribute('data-role');
			if (!role) return;
			if (role !== 'remove-mark') return;
			ev.preventDefault();
			var body = target.closest('[data-mark-index]');
			if (!body) return;
			var idx = Number(body.getAttribute('data-mark-index'));
			if (!Number.isFinite(idx) || !metadataMarksState[idx]) return;
			if (String(metadataMarksState[idx].name || '') === 'L' || metadataMarksState[idx].locked) return;
			metadataMarksState.splice(idx, 1);
			renderMetadataMarks();
		});
		document.getElementById('btn-save-metadata-marks').addEventListener('click', function () {
			var marks = metadataMarksState
				.map(function (m) {
					return {
						name: String((m && m.name) || '').trim(),
						description: String((m && m.description) || ''),
						markColor: String((m && (m.markColor || m.color)) || '').trim(),
						textColor: String((m && m.textColor) || '').trim(),
						locked: !!(m && m.locked) || String((m && m.name) || '') === 'L'
					};
				})
				.filter(function (m) { return !!m.name; });
			if (!marks.some(function (m) { return m.name === 'L'; })) {
				marks.unshift({ name: 'L', description: 'Link marker. Example: L: ![file-name - @fileid](rel/path/to/file)', markColor: '', textColor: '', locked: true });
			}
			vscode.postMessage({ type: 'updateSetting', key: 'dripMetadataMarks', value: { marks: marks } });
		});
		docColoringRowsEl.addEventListener('input', function (ev) {
			var target = ev.target;
			if (!target || target.getAttribute('data-role') !== 'doc-color-picker') return;
			var row = target.closest('[data-slot]');
			if (!row) return;
			var slot = row.getAttribute('data-slot');
			if (!slot || !(slot in docColorsState)) return;
			docColorsState[slot] = String(target.value || '').trim().toLowerCase();
			renderDocColoringSample();
		});
		document.getElementById('btn-save-doc-colors').addEventListener('click', function () {
			vscode.postMessage({ type: 'updateSetting', key: 'dripnoteDocColors', value: docColorsState });
		});
		document.getElementById('btn-revert-doc-colors').addEventListener('click', function () {
			docColorsState = { color1: '', color2: '', color3: '', color4: '', color5: '', color6: '' };
			renderDocColoring();
			vscode.postMessage({ type: 'updateSetting', key: 'dripnoteDocColors', value: docColorsState });
		});
		document.getElementById('btn-keys').addEventListener('click', function () {
			vscode.postMessage({ type: 'openKeyboardShortcuts' });
		});
		document.getElementById('btn-keys-file').addEventListener('click', function () {
			vscode.postMessage({ type: 'openKeybindingsFile' });
		});

		var shortcutRowsEl = document.getElementById('shortcut-rows');
		var IS_MAC = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
		var CODE_TO_KEY = {
			Space: 'space', Enter: 'enter', Tab: 'tab', Backspace: 'backspace', Delete: 'delete', Insert: 'insert',
			Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
			ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
			Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\\\',
			Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '\`'
		};
		function keyFromEvent(e) {
			var code = e.code || '';
			var base = '';
			if (/^Key[A-Z]$/.test(code)) base = code.slice(3).toLowerCase();
			else if (/^Digit[0-9]$/.test(code)) base = code.slice(5);
			else if (/^Numpad[0-9]$/.test(code)) base = 'numpad' + code.slice(6);
			else if (/^F([1-9]|1[0-9])$/.test(code)) base = code.toLowerCase();
			else if (CODE_TO_KEY[code]) base = CODE_TO_KEY[code];
			if (!base) return '';
			var parts = [];
			if (e.ctrlKey) parts.push('ctrl');
			if (e.shiftKey) parts.push('shift');
			if (e.altKey) parts.push('alt');
			if (e.metaKey) parts.push(IS_MAC ? 'cmd' : 'win');
			parts.push(base);
			return parts.join('+');
		}
		function prettyKey(k) {
			return String(k || '').split(' ').map(function (chord) {
				return chord.split('+').map(function (p) {
					return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
				}).join('+');
			}).join(' ');
		}
		function renderShortcuts(data) {
			var rows = (data && data.rows) || [];
			setText('shortcut-error', data && data.error ? data.error : '');
			if (!rows.length) {
				shortcutRowsEl.innerHTML = '<tr><td colspan="4" class="meta">No DRIP commands found.</td></tr>';
				return;
			}
			var html = '';
			for (var i = 0; i < rows.length; i++) {
				var r = rows[i];
				var current = r.keys.length
					? r.keys.map(function (k) { return '<kbd>' + escapeHtml(prettyKey(k)) + '</kbd>'; }).join('')
					: '<span class="meta">(none)</span>';
				var def = r.defaultKey ? 'Default: ' + prettyKey(r.defaultKey) : 'No default';
				var conflict = r.conflicts && r.conflicts.length
					? '<div class="sc-conflict">Also bound: ' + escapeHtml(r.conflicts.map(prettyKey).join(', ')) + '</div>'
					: '';
				html += '<tr data-command="' + escapeHtml(r.id) + '">' +
					'<td>' + escapeHtml(r.title) + '<div class="meta"><code>' + escapeHtml(r.id) + '</code></div></td>' +
					'<td>' + current + conflict + '</td>' +
					'<td><input type="text" class="sc-record" readonly placeholder="Click, then press keys" title="' + escapeHtml(def) + '"></td>' +
					'<td><div class="sc-actions">' +
						'<button type="button" data-sc="set">Save</button>' +
						'<button type="button" class="secondary" data-sc="reset"' + (r.customized ? '' : ' disabled') + ' title="' + escapeHtml(def) + '">Reset</button>' +
						'<button type="button" class="secondary" data-sc="remove"' + (r.keys.length ? '' : ' disabled') + '>Remove</button>' +
					'</div></td>' +
				'</tr>';
			}
			shortcutRowsEl.innerHTML = html;
		}
		shortcutRowsEl.addEventListener('keydown', function (e) {
			var input = e.target;
			if (!input || !input.classList || !input.classList.contains('sc-record')) return;
			// Keep the keystroke inside this box so VS Code does not also run the shortcut.
			e.preventDefault();
			e.stopPropagation();
			if (e.key === 'Escape') {
				input.value = '';
				input.blur();
				return;
			}
			if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && input.value) {
				input.value = '';
				return;
			}
			var k = keyFromEvent(e);
			if (!k) return;
			input.dataset.key = k;
			input.value = prettyKey(k);
		});
		shortcutRowsEl.addEventListener('click', function (e) {
			var btn = e.target && e.target.closest ? e.target.closest('button[data-sc]') : null;
			if (!btn) return;
			var row = btn.closest('tr[data-command]');
			if (!row) return;
			var mode = btn.getAttribute('data-sc');
			var input = row.querySelector('input.sc-record');
			var key = input && input.value ? String(input.dataset.key || '') : '';
			if (mode === 'set' && !key) {
				setText('shortcut-error', 'Click the "New shortcut" box and press a key combination first.');
				if (input) input.focus();
				return;
			}
			setText('shortcut-error', '');
			vscode.postMessage({ type: 'updateShortcut', command: row.getAttribute('data-command'), mode: mode, key: key });
		});
		window.addEventListener('message', function (event) {
			if (event.data && event.data.type === 'shortcutsData') renderShortcuts(event.data);
		});
		vscode.postMessage({ type: 'requestShortcuts' });
		document.getElementById('btn-select-kb').addEventListener('click', function () {
			vscode.postMessage({ type: 'selectKnowledgeBase' });
		});
		document.getElementById('btn-reindex-workspace').addEventListener('click', function () {
			vscode.postMessage({ type: 'reindexCurrentKbWorkspace' });
		});
		document.getElementById('btn-reset-reindex-entire').addEventListener('click', function () {
			vscode.postMessage({ type: 'resetReindexEntireKb' });
		});
		document.getElementById('btn-user-settings').addEventListener('click', function () {
			vscode.postMessage({ type: 'openDripUserSettings' });
		});
		function pushHeadingEditMode(mode) {
			var viaRhs = mode === 'rhs';
			vscode.postMessage({ type: 'updateSetting', key: 'editHeadingsViaRhs', value: viaRhs });
			vscode.postMessage({ type: 'updateSetting', key: 'editHeadingsInFile', value: !viaRhs });
		}
		if (optEditHeadingsRhs) {
			optEditHeadingsRhs.addEventListener('change', function () {
				if (optEditHeadingsRhs.checked) pushHeadingEditMode('rhs');
			});
		}
		if (optEditHeadingsFile) {
			optEditHeadingsFile.addEventListener('change', function () {
				if (optEditHeadingsFile.checked) pushHeadingEditMode('file');
			});
		}
		document.getElementById('btn-embedding-benchmark').addEventListener('click', function () {
			vscode.postMessage({ type: 'runEmbeddingBenchmark' });
		});
		document.getElementById('btn-import-settings').addEventListener('click', function () {
			vscode.postMessage({ type: 'importKbSettings' });
		});
		document.getElementById('btn-export-settings').addEventListener('click', function () {
			vscode.postMessage({ type: 'exportKbSettings' });
		});
		var btnGhSave = document.getElementById('btn-gh-save-remote');
		if (btnGhSave) {
			btnGhSave.addEventListener('click', function () {
				vscode.postMessage({
					type: 'githubBackupSaveRemote',
					remoteUrl: String((document.getElementById('gh-remote-url') || {}).value || '').trim(),
					branch: String((document.getElementById('gh-branch') || {}).value || 'main').trim() || 'main'
				});
			});
		}
		var btnGhOpen = document.getElementById('btn-gh-open');
		if (btnGhOpen) {
			btnGhOpen.addEventListener('click', function () {
				vscode.postMessage({ type: 'githubBackupOpen' });
			});
		}
		var btnGhInit = document.getElementById('btn-gh-init');
		if (btnGhInit) {
			btnGhInit.addEventListener('click', function () {
				vscode.postMessage({ type: 'githubBackupInit' });
			});
		}
		var btnGhPush = document.getElementById('btn-gh-push');
		if (btnGhPush) {
			btnGhPush.addEventListener('click', function () {
				vscode.postMessage({ type: 'githubBackupPush' });
			});
		}
		var btnGhPull = document.getElementById('btn-gh-pull');
		if (btnGhPull) {
			btnGhPull.addEventListener('click', function () {
				vscode.postMessage({ type: 'githubBackupPull' });
			});
		}
		var btnGhSetPat = document.getElementById('btn-gh-set-pat');
		if (btnGhSetPat) {
			btnGhSetPat.addEventListener('click', function () {
				vscode.postMessage({ type: 'githubBackupSetPat' });
			});
		}
		var btnGhClearPat = document.getElementById('btn-gh-clear-pat');
		if (btnGhClearPat) {
			btnGhClearPat.addEventListener('click', function () {
				vscode.postMessage({ type: 'githubBackupClearPat' });
			});
		}
		var mcpEnabledEl = document.getElementById('mcp-enabled');
		if (mcpEnabledEl) {
			mcpEnabledEl.addEventListener('change', function () {
				vscode.postMessage({ type: 'mcpSetEnabled', value: !!mcpEnabledEl.checked });
			});
		}
		var btnMcpSavePort = document.getElementById('btn-mcp-save-port');
		if (btnMcpSavePort) {
			btnMcpSavePort.addEventListener('click', function () {
				var portEl = document.getElementById('mcp-port');
				vscode.postMessage({ type: 'mcpSetPort', value: Number(String((portEl && portEl.value) || '').trim()) });
			});
		}
		var btnMcpRestart = document.getElementById('btn-mcp-restart');
		if (btnMcpRestart) {
			btnMcpRestart.addEventListener('click', function () {
				vscode.postMessage({ type: 'mcpRestart' });
			});
		}
		var btnMcpRegenerate = document.getElementById('btn-mcp-regenerate');
		if (btnMcpRegenerate) {
			btnMcpRegenerate.addEventListener('click', function () {
				vscode.postMessage({ type: 'mcpRegenerateToken' });
			});
		}
		var btnMcpHealth = document.getElementById('btn-mcp-health');
		if (btnMcpHealth) {
			btnMcpHealth.addEventListener('click', function () {
				vscode.postMessage({ type: 'mcpOpenHealth' });
			});
		}
		Array.prototype.forEach.call(document.querySelectorAll('[data-mcp-copy]'), function (btn) {
			btn.addEventListener('click', function () {
				vscode.postMessage({ type: 'mcpCopy', kind: btn.getAttribute('data-mcp-copy') });
			});
		});
		var btnLlmSave = document.getElementById('btn-llm-save');
		if (btnLlmSave) {
			btnLlmSave.addEventListener('click', function () {
				vscode.postMessage({ type: 'updateSetting', key: 'llm.enabled', value: !!llmEnabledEl.checked });
				vscode.postMessage({ type: 'updateSetting', key: 'llm.baseUrl', value: String((llmBaseUrlEl && llmBaseUrlEl.value) || '').trim() });
				vscode.postMessage({ type: 'updateSetting', key: 'llm.model', value: String((llmModelEl && llmModelEl.value) || '').trim() });
			});
		}
		var btnLlmSetKey = document.getElementById('btn-llm-set-key');
		if (btnLlmSetKey) {
			btnLlmSetKey.addEventListener('click', function () {
				var keyEl = document.getElementById('llm-api-key');
				var key = keyEl ? String(keyEl.value || '').trim() : '';
				if (!key) return;
				vscode.postMessage({ type: 'llmSetApiKey', value: key });
				if (keyEl) keyEl.value = '';
			});
		}
		var btnLlmClearKey = document.getElementById('btn-llm-clear-key');
		if (btnLlmClearKey) {
			btnLlmClearKey.addEventListener('click', function () {
				vscode.postMessage({ type: 'llmClearApiKey' });
				var keyEl = document.getElementById('llm-api-key');
				if (keyEl) keyEl.value = '';
			});
		}
		showPanel(${initialPanelJson});
	</script>
</body>
</html>`;
}

module.exports = {
	getSettingsWebviewHtml
};
