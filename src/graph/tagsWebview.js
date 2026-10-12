'use strict';

const vscode = require('vscode');
const { getNonce } = require('../shared/utils');

/**
 * Builds the Content-Security-Policy for the tag graph webviews.
 * - default-src 'none': block everything by default.
 * - style-src: allow the bundled stylesheet (via cspSource) + inline style attributes.
 * - script-src: allow the nonce'd inline bootstrap AND the bundled runtime (via cspSource).
 * @param {import('vscode').Webview} webview
 * @param {string} nonce
 */
function buildCsp(webview, nonce) {
	return [
		`default-src 'none'`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}' ${webview.cspSource}`
	].join('; ');
}

/**
 * Resolve a dist/ build artifact to a webview-safe URI.
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} extensionUri
 * @param {string} fileName
 */
function distUri(webview, extensionUri, fileName) {
	return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', fileName));
}

/**
 * Full-page tag graph for a WebviewPanel in the editor area (not the Storage sidebar).
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} extensionUri
 */
function getTagsWebviewHtml(webview, extensionUri) {
	const nonce = getNonce();
	const styleUri = distUri(webview, extensionUri, 'tagsGraph.css');
	const runtimeUri = distUri(webview, extensionUri, 'tagsGraphRuntime.js');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${buildCsp(webview, nonce)}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>DRIP Tags</title>
	<link rel="stylesheet" href="${styleUri}">
</head>
<body>
	<div class="tags-editor-root">
		<div id="tags-main-panel">
			<header class="tags-header">
				<h1 class="tags-title">Tags Graph</h1>
				<div class="tags-mode-switch" role="radiogroup" aria-label="Tags scope">
					<label><input type="radio" name="tagsMode" value="kb" checked /> Knowledge Base</label>
					<label><input type="radio" name="tagsMode" value="projects" /> Projects</label>
				</div>
			</header>
			<div class="tags-selection">
				<div class="stag-graph-controls">
					<label class="stag-graph-label" for="stag-graph-select">Graph</label>
					<select id="stag-graph-select" class="stag-toolbar-select" aria-label="Stored tags graph"></select>
					<input id="stag-graph-name" class="inp stag-graph-name is-hidden" type="text" placeholder="Graph name" autocomplete="off" />
					<div class="stag-graph-actions">
						<button type="button" id="stag-btn-rename-graph">Rename</button>
						<button type="button" id="stag-btn-delete-graph">Delete</button>
						<button type="button" id="stag-btn-combine-graph" title="Combine graphs">+</button>
					</div>
				</div>
				<div class="projects-tags-top" id="projects-tags-top" hidden>
					<label for="ptp-project-select">Project</label>
					<select id="ptp-project-select"></select>
				</div>
				<button type="button" id="stag-btn-export-graph">Export…</button>
				<button type="button" id="stag-btn-reset-view">Reset view</button>
				<div id="stag-delete-panel" class="stag-delete-panel">
					<button type="button" id="stag-btn-delete-mode">Delete nodes</button>
					<div id="stag-delete-tools" class="stag-delete-tools" hidden>
						<p class="stag-delete-title">Delete nodes</p>
						<label class="chk" id="stag-delete-include-wrap"><input id="stag-opt-delete-include-children" type="checkbox" /> Include children</label>
						<div class="stag-delete-actions">
							<button type="button" id="stag-btn-delete-confirm" disabled>Delete</button>
							<button type="button" id="stag-btn-delete-cancel">Cancel</button>
						</div>
					</div>
				</div>
				<div id="stag-combine-panel" class="stag-combine-panel" hidden>
					<div id="stag-combine-list" class="stag-combine-list"></div>
					<div class="stag-combine-actions">
						<button type="button" id="stag-btn-combine-add">+ Add graph</button>
						<button type="button" id="stag-btn-combine-create">Create combined</button>
						<button type="button" id="stag-btn-combine-cancel">Cancel</button>
					</div>
				</div>
			</div>
			<div class="tags-layout">
				<div class="tags-col">
			<p class="tags-intro"></p>
			<div class="tags-embed-inner">
				<div class="stag-main">
					<div class="stag-canvas-wrap" id="stag-canvas-wrap">
						<canvas id="stag-graph" width="600" height="400" aria-label="Tag graph"></canvas>
						<div id="stag-hover-label" class="stag-hover-label" hidden aria-hidden="true"></div>
						<div id="stag-ctx-menu" class="stag-ctx-menu" hidden role="menu" aria-label="Graph actions"></div>
						<div id="stag-subtag-flyout" class="stag-subtag-flyout" hidden aria-label="Sub-tag graph">
							<div class="stag-subtag-flyout-head">
								<span id="stag-subtag-title">Sub-tags</span>
								<button type="button" id="stag-subtag-close">Close</button>
							</div>
							<p class="stag-subtag-mini-hint">Mini graph: parent tag node (arrow label) + sub-tags. Link any nodes with Shift+double-click. Drag, pan, wheel. Inline rename via right-click. With 6+ sub-tags, double-click opens a separate window instead.</p>
							<div class="stag-subgraph-wrap" id="stag-subgraph-wrap">
								<canvas id="stag-subgraph" width="280" height="180" aria-label="Sub-tag graph"></canvas>
								<div id="stag-sub-ctx-menu" class="stag-ctx-menu" hidden role="menu" aria-label="Sub-graph actions"></div>
							</div>
							<div class="stag-subtag-footer">
								<label class="lbl" for="stag-subtag-new">New sub-tag (placed near center)</label>
								<div class="stag-row2">
									<input class="inp" id="stag-subtag-new" type="text" placeholder="e.g. milestone" autocomplete="off" />
									<button type="button" class="primary" id="stag-subtag-add">Add</button>
								</div>
							</div>
						</div>
					</div>
					<p id="stag-selection-note" class="stag-selection-note" hidden>Node group selection in progress. Click tags to assign. Click empty canvas or press Esc to stop.</p>
					<p id="stag-status-note" class="stag-status-note" hidden></p>
					<p id="stag-err" class="error" role="alert"></p>
				</div>
					</div>
				</div>
				<aside class="stag-sidebar">
					<h3>Tag list</h3>
					<div>
						<label class="lbl" for="stag-new-label">New tag name</label>
						<div class="stag-row2">
							<input class="inp" id="stag-new-label" type="text" placeholder="e.g. backlog" autocomplete="off" />
							<button type="button" class="primary" id="stag-btn-add">Add tag</button>
						</div>
					</div>
					<div>
						<label class="chk"><input id="stag-opt-show-groups" type="checkbox" /> Show Groups legend</label>
						<div id="stag-groups-wrap" class="settings-wrap" hidden>
							<p class="settings-title">Groups</p>
							<label class="lbl" for="stag-group-manage">Group</label>
							<div class="stag-row2" id="stag-group-row">
								<select class="sel" id="stag-group-manage"><option value="">No group</option></select>
								<input class="inp" id="stag-group-editor-name" type="text" placeholder="Group name" autocomplete="off" hidden />
								<input class="inp" id="stag-group-editor-color" type="color" value="#7aa2ff" style="max-width:56px;padding:2px;" hidden />
								<button type="button" class="stag-icon-btn" id="stag-btn-rename-group" title="Rename group" aria-label="Rename group">✎</button>
								<button type="button" class="stag-icon-btn" id="stag-btn-delete-group" title="Delete group" aria-label="Delete group">🗑</button>
								<button type="button" id="stag-btn-group-editor-save" hidden>Save</button>
								<button type="button" id="stag-btn-group-editor-cancel" hidden>Cancel</button>
							</div>
							<div class="stag-row2" style="margin-top:6px;">
								<button type="button" id="stag-btn-select-group-nodes">Select nodes</button>
								<label class="chk" style="margin:0;"><input id="stag-opt-group-include-children" type="checkbox" checked /> Include children</label>
							</div>
							<div id="stag-groups-legend" class="stag-legend"></div>
						</div>
					</div>
					<div>
						<label class="lbl" for="stag-sel-from">Link from</label>
						<select class="sel" id="stag-sel-from"><option value="">\u2014</option></select>
					</div>
					<div>
						<label class="lbl" for="stag-sel-to">Link to</label>
						<select class="sel" id="stag-sel-to"><option value="">\u2014</option></select>
					</div>
					<button type="button" class="primary" id="stag-btn-link" style="width:100%">Create link</button>
					<button type="button" id="stag-btn-toggle-settings" style="width:100%">Graph settings</button>
					<div id="stag-settings-wrap" class="settings-wrap" hidden>
						<p class="settings-title">Forces</p>
						<label class="chk"><input id="stag-opt-rigid" type="checkbox" /> Rigid mode (freeze nodes)</label>
						<label class="lbl stag-range-label" for="stag-opt-force-center">Center force <span id="stag-opt-force-center-val" class="stag-range-value"></span></label>
						<input class="inp" id="stag-opt-force-center" type="range" min="0" max="0.5" step="0.01" value="0.03" />
						<label class="lbl stag-range-label" for="stag-opt-force-repel">Repel force <span id="stag-opt-force-repel-val" class="stag-range-value"></span></label>
						<input class="inp" id="stag-opt-force-repel" type="range" min="0" max="20" step="0.05" value="10" />
						<label class="lbl stag-range-label" for="stag-opt-force-link">Link force <span id="stag-opt-force-link-val" class="stag-range-value"></span></label>
						<input class="inp" id="stag-opt-force-link" type="range" min="0" max="1" step="0.01" value="0.75" />
						<label class="lbl stag-range-label" for="stag-opt-link-distance">Link distance <span id="stag-opt-link-distance-val" class="stag-range-value"></span></label>
						<input class="inp" id="stag-opt-link-distance" type="range" min="15" max="150" step="5" value="80" />
						<p class="settings-title" style="margin-top:10px;">Display</p>
						<label class="chk"><input id="stag-opt-show-orphans" type="checkbox" checked /> Show orphans</label>
						<label class="chk"><input id="stag-opt-show-arrows" type="checkbox" checked /> Show arrows</label>
						<label class="lbl stag-range-label" for="stag-opt-node-size">Node size <span id="stag-opt-node-size-val" class="stag-range-value"></span></label>
						<input class="inp" id="stag-opt-node-size" type="range" min="1" max="20" step="0.1" value="8" />
						<label class="lbl stag-range-label" for="stag-opt-edge-thickness">Edge thickness <span id="stag-opt-edge-thickness-val" class="stag-range-value"></span></label>
						<input class="inp" id="stag-opt-edge-thickness" type="range" min="0.75" max="1.75" step="0.01" value="1.50" />
						<label class="lbl stag-range-label" for="stag-opt-text-fade">Text fade threshold <span id="stag-opt-text-fade-val" class="stag-range-value"></span></label>
						<input class="inp" id="stag-opt-text-fade" type="range" min="-3" max="3" step="0.1" value="-2.5" />
					</div>
					<div>
						<label class="lbl">Selected</label>
						<p class="meta" id="stag-sel-info" style="margin:0;font-size:12px;line-height:1.4;"></p>
					</div>
				</aside>
			</div>
		</div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		window.__dripVscodeApi = vscode;
		vscode.postMessage({ type: 'requestTagGraph' });
	</script>
	<script nonce="${nonce}" src="${runtimeUri}"></script>
	<script nonce="${nonce}">
	(function () {
		var vscode = window.__dripVscodeApi;
		if (!vscode) return;
		var modeInputs = document.querySelectorAll('input[name="tagsMode"]');
		var projectsTop = document.getElementById('projects-tags-top');
		var projectsSelect = document.getElementById('ptp-project-select');

		function setMode(mode) {
			var isProjects = mode === 'projects';
			if (projectsTop) projectsTop.hidden = !isProjects;
			// In Projects mode the graph is one graph per project, so the multi-graph
			// management controls (graph selector, rename/delete/combine, export) don't apply.
			// Reset view + Delete nodes stay so they appear exactly once, in both modes.
			var graphControls = document.querySelector('.stag-graph-controls');
			var exportBtn = document.getElementById('stag-btn-export-graph');
			if (graphControls) graphControls.style.display = isProjects ? 'none' : '';
			if (exportBtn) exportBtn.style.display = isProjects ? 'none' : '';
			vscode.postMessage({ type: 'tagsModeChanged', mode: mode });
		}
		for (var i = 0; i < modeInputs.length; i++) {
			modeInputs[i].addEventListener('change', function () {
				if (this.checked) setMode(this.value);
			});
		}

		if (projectsSelect) {
			projectsSelect.addEventListener('change', function () {
				vscode.postMessage({ type: 'projectTagsSelectProject', folderPrefix: projectsSelect.value });
			});
		}

		window.addEventListener('message', function (e) {
			var msg = e.data || {};
			if (msg.type !== 'projectTagsPanelState') return;
			var projects = msg.projects || [];
			var activePrefix = msg.folderPrefix || '';
			if (projectsSelect) {
				projectsSelect.innerHTML = '';
				projects.forEach(function (p) {
					var opt = document.createElement('option');
					opt.value = String(p.folderPrefix || '');
					opt.textContent = String(p.title || p.folderPrefix || '');
					projectsSelect.appendChild(opt);
				});
				projectsSelect.value = activePrefix || '';
			}
		});
	})();
	</script>
</body>
</html>`;
}

/**
 * Dedicated panel: full-area sub-graph editor (used when a tag has many sub-tags).
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} extensionUri
 */
function getSubGraphPanelHtml(webview, extensionUri) {
	const nonce = getNonce();
	const styleUri = distUri(webview, extensionUri, 'tagsGraphSubOnly.css');
	const runtimeUri = distUri(webview, extensionUri, 'tagsGraphSubOnlyRuntime.js');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${buildCsp(webview, nonce)}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>DRIP Sub-tags</title>
	<link rel="stylesheet" href="${styleUri}">
</head>
<body>
	<div id="drip-subgraph-panel-root"></div>
	<div class="drip-subgraph-panel-layout">
		<div class="stag-toolbar">
			<button type="button" id="stag-btn-refresh-sub">Reload graph</button>
			<span class="hint">Parent node (\u2191) matches the main tag. Shift+double-click: link. Right-click: rename (inline) / delete / links.</span>
		</div>
		<p class="stag-subgraph-panel-hint">This window stays open while you edit the main Tags graph. Changes sync across panels.</p>
		<div class="stag-subgraph-wrap" id="stag-subgraph-wrap">
			<canvas id="stag-subgraph" width="640" height="480" aria-label="Sub-tag graph"></canvas>
			<div id="stag-sub-ctx-menu" class="stag-ctx-menu" hidden role="menu" aria-label="Sub-graph actions"></div>
		</div>
		<div class="stag-subtag-footer">
			<label class="lbl" for="stag-subtag-new">New sub-tag</label>
			<div class="stag-row2">
				<input class="inp" id="stag-subtag-new" type="text" placeholder="e.g. milestone" autocomplete="off" />
				<button type="button" class="primary" id="stag-subtag-add">Add</button>
			</div>
		</div>
		<p id="stag-err" class="error" role="alert"></p>
	</div>
	<script nonce="${nonce}">
		window.__dripVscodeApi = acquireVsCodeApi();
	</script>
	<script nonce="${nonce}" src="${runtimeUri}"></script>
	<script nonce="${nonce}">
		document.getElementById('stag-btn-refresh-sub').addEventListener('click', function () {
			window.__dripVscodeApi.postMessage({ type: 'requestTagGraph' });
		});
	</script>
</body>
</html>`;
}

module.exports = {
	getTagsWebviewHtml,
	getSubGraphPanelHtml
};
