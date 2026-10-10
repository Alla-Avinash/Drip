'use strict';

const { getNonce } = require('../shared/utils');
const getTagsGraphEmbedRuntime = require('./tagsGraphEmbedRuntime');
const { getTagsGraphSubOnlyRuntime } = require('./tagsGraphSubOnlyEmbed');

/**
 * Full-page tag graph for a WebviewPanel in the editor area (not the Storage sidebar).
 */
function getTagsWebviewHtml(webview) {
	const nonce = getNonce();
	const tagsGraphEmbedScript = getTagsGraphEmbedRuntime();

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>DRIP Tags</title>
	<style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 0; padding: 10px; height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; min-height: 0; }
		.tags-editor-root { flex: 1; min-height: 0; display: flex; flex-direction: column; }
		.tags-layout { flex: 1; min-height: 0; display: flex; }
		.tags-col { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
		#tags-main-panel .tags-intro { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 0 0 8px 0; line-height: 1.4; }
		.tags-embed-inner { display: flex; flex: 1; min-height: 280px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; }
		.stag-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
		.stag-toolbar { flex-shrink: 0; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
		.stag-toolbar button { padding: 5px 10px; font-size: 11px; border: none; border-radius: 4px; cursor: pointer;
			background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		.stag-toolbar button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		.tags-selection .stag-graph-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
		.tags-selection label.stag-graph-label { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 0; }
		.tags-selection .stag-toolbar-select { padding: 4px 8px; font-size: 12px; border-radius: 4px; cursor: pointer;
			border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground);
			min-width: 160px; max-width: 280px; }
		.stag-toolbar .hint { font-size: 10px; color: var(--vscode-descriptionForeground); flex: 1; min-width: 120px; line-height: 1.35; }
		.tags-selection .stag-graph-actions { display: inline-flex; gap: 6px; }
		.tags-selection .stag-graph-name { width: 180px; padding: 4px 8px; font-size: 12px; border-radius: 4px;
			border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
		.tags-selection .is-hidden { display: none !important; }
		.stag-canvas-wrap { flex: 1; min-height: 200px; position: relative; cursor: grab; }
		.stag-canvas-wrap.stag-panning { cursor: grabbing; }
		.stag-canvas-wrap.stag-drag-node { cursor: move; }
		#stag-graph { display: block; width: 100%; height: 100%; }
		.stag-hover-label {
			position: absolute; z-index: 20; pointer-events: none; margin: 0; padding: 0; box-sizing: border-box;
			transform: translateX(-50%); max-width: min(560px, calc(100% - 24px)); text-align: center; line-height: 1.25;
			word-wrap: break-word; overflow-wrap: anywhere; font-family: var(--vscode-font-family);
			color: var(--vscode-editor-foreground); background: transparent; border: none; border-radius: 0; box-shadow: none;
		}
		.stag-hover-label[hidden] { display: none !important; }
		.stag-ctx-menu {
			position: absolute; z-index: 50; min-width: 148px; padding: 4px 0; margin: 0;
			background: var(--vscode-menu-background); color: var(--vscode-menu-foreground);
			border: 1px solid var(--vscode-menu-border); border-radius: 4px;
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
		}
		.stag-ctx-menu[hidden] { display: none !important; }
		.stag-ctx-menu button {
			display: block; width: 100%; margin: 0; padding: 6px 14px; border: none; border-radius: 0;
			font-size: 13px; text-align: left; cursor: pointer;
			background: transparent; color: var(--vscode-menu-foreground);
		}
		.stag-ctx-menu button:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
		.stag-ctx-menu button.stag-ctx-danger:hover { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); }
		.stag-subtag-flyout {
			position: absolute; z-index: 55; width: min(320px, calc(100% - 16px)); max-height: min(340px, calc(100% - 16px));
			display: flex; flex-direction: column; min-height: 0; box-sizing: border-box;
			background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-focusBorder); border-radius: 8px;
			box-shadow: 0 6px 24px rgba(0,0,0,.4); overflow: hidden;
		}
		.stag-subtag-flyout[hidden] { display: none !important; }
		.stag-subtag-flyout-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 8px;
			border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; background: var(--vscode-editorWidget-background); }
		.stag-subtag-flyout-head span { font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.stag-subtag-flyout-head button { padding: 2px 8px; font-size: 11px; border: none; border-radius: 4px; cursor: pointer;
			background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		.stag-subtag-mini-hint { margin: 0; padding: 4px 8px; font-size: 9px; line-height: 1.35; color: var(--vscode-descriptionForeground);
			border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
		.stag-subgraph-wrap { flex: 1; min-height: 160px; position: relative; cursor: grab; background: var(--vscode-editor-background); }
		.stag-subgraph-wrap.stag-panning { cursor: grabbing; }
		.stag-subgraph-wrap.stag-drag-node { cursor: move; }
		#stag-subgraph { display: block; width: 100%; height: 100%; }
		.stag-subtag-footer { flex-shrink: 0; border-top: 1px solid var(--vscode-panel-border); padding: 6px 8px; }
		.stag-subtag-footer .lbl { font-size: 10px; }
		.stag-subtag-footer .inp { font-size: 11px; padding: 4px 6px; }
		.stag-sidebar { width: 240px; flex-shrink: 0; border-left: 1px solid var(--vscode-panel-border); padding: 10px; overflow: auto;
			display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
		.stag-sidebar h3 { margin: 0 0 4px 0; font-size: 12px; font-weight: 600; }
		.stag-sidebar .lbl { font-size: 11px; color: var(--vscode-descriptionForeground); display: block; margin-bottom: 3px; }
		.stag-sidebar .inp, .stag-sidebar .sel { width: 100%; padding: 5px 7px; font-size: 11px; border-radius: 4px;
			border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
		.stag-sidebar .settings-wrap[hidden] { display: none !important; }
		.stag-sidebar .settings-wrap { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; }
		.stag-sidebar .settings-title { margin: 0 0 6px 0; font-size: 11px; font-weight: 600; }
		.stag-sidebar .chk { display: flex; align-items: center; gap: 6px; font-size: 11px; }
		.stag-legend { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
		.stag-legend-item { display: flex; align-items: center; gap: 6px; font-size: 11px; }
		.stag-legend-swatch { width: 10px; height: 10px; border-radius: 999px; border: 1px solid rgba(0,0,0,0.35); display: inline-block; }
		.stag-sidebar input[type="range"] {
			width: 100%;
			padding: 0;
			margin: 0;
			height: 18px;
			box-sizing: border-box;
		}
		.stag-sidebar input[type="range"]::-webkit-slider-runnable-track { margin: 0; }
		.stag-sidebar input[type="range"]::-moz-range-track { margin: 0; }
		.stag-range-label { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
		.stag-range-value { font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); min-width: 44px; text-align: right; }
		.stag-row2 { display: flex; gap: 6px; align-items: center; }
		.stag-row2 .inp { flex: 1; }
		.stag-icon-btn { width: 28px; min-width: 28px; padding: 4px 0; text-align: center; font-size: 12px; }
		.stag-btn-active { outline: 1px solid var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset; }
		.stag-delete-panel { display: flex; flex-direction: column; gap: 6px; padding: 0; }
		.stag-delete-panel.is-active { border: 1px solid var(--vscode-focusBorder); border-radius: 6px; padding: 6px; box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset; }
		.stag-delete-tools { display: flex; flex-direction: column; gap: 6px; }
		.stag-delete-tools[hidden] { display: none !important; }
		.stag-delete-title { margin: 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
		.stag-delete-actions { display: flex; align-items: center; gap: 6px; }
		.stag-combine-panel { flex-basis: 100%; display: flex; flex-direction: column; gap: 6px; padding-top: 6px; min-width: 280px; }
		.stag-combine-panel[hidden] { display: none !important; }
		.stag-combine-list { display: flex; flex-direction: column; gap: 4px; max-height: 140px; overflow: auto; }
		.stag-combine-row { display: flex; align-items: center; gap: 6px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 4px; background: var(--vscode-editor-background); }
		.stag-combine-row.dragging { opacity: 0.65; }
		.stag-combine-grip { cursor: grab; user-select: none; color: var(--vscode-descriptionForeground); }
		.stag-combine-actions { display: flex; align-items: center; gap: 6px; }
		.stag-selection-note { margin: 6px 0 0 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
		.stag-status-note { margin: 4px 0 0 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
		.error { margin-top: 8px; color: var(--vscode-errorForeground); }
		.meta { color: var(--vscode-descriptionForeground); }
		#tags-main-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
		.tags-header { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 2px 0 12px 0; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
		.tags-title { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.2; }
		.tags-mode-switch { display: flex; gap: 16px; align-items: center; margin: 0; padding: 0; }
		.tags-mode-switch label { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--vscode-descriptionForeground); cursor: pointer; }
		.tags-mode-switch input { margin: 0; }
		.tags-selection { flex-shrink: 0; margin-bottom: 12px; padding: 8px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
		.tags-selection button { padding: 5px 10px; font-size: 12px; border: none; border-radius: 4px; cursor: pointer;
			background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		.tags-selection button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		.projects-tags-top { display: inline-flex; align-items: center; gap: 8px; }
		.projects-tags-top[hidden] { display: none !important; }
		.projects-tags-top label { font-size: 12px; color: var(--vscode-descriptionForeground); }
		.projects-tags-top select { padding: 4px 8px; font-size: 12px; border-radius: 4px; cursor: pointer; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); min-width: 180px; }
	</style>
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
	<script nonce="${nonce}">
${tagsGraphEmbedScript}
	</script>
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
 */
function getSubGraphPanelHtml(webview) {
	const nonce = getNonce();
	const subOnlyScript = getTagsGraphSubOnlyRuntime();

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>DRIP Sub-tags</title>
	<style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 0; padding: 8px; height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; min-height: 0; }
		#drip-subgraph-panel-root { display: none; }
		.drip-subgraph-panel-layout { flex: 1; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; }
		.stag-toolbar { flex-shrink: 0; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
		.stag-toolbar button { padding: 5px 10px; font-size: 11px; border: none; border-radius: 4px; cursor: pointer;
			background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		.stag-toolbar button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		.stag-toolbar .hint { font-size: 10px; color: var(--vscode-descriptionForeground); flex: 1; min-width: 120px; line-height: 1.35; }
		.stag-subgraph-panel-hint { margin: 0; padding: 6px 10px; font-size: 10px; line-height: 1.4; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
		.stag-subgraph-wrap { flex: 1; min-height: 200px; position: relative; cursor: grab; background: var(--vscode-editor-background); }
		.stag-subgraph-wrap.stag-panning { cursor: grabbing; }
		.stag-subgraph-wrap.stag-drag-node { cursor: move; }
		#stag-subgraph { display: block; width: 100%; height: 100%; }
		.stag-ctx-menu {
			position: absolute; z-index: 50; min-width: 148px; padding: 4px 0; margin: 0;
			background: var(--vscode-menu-background); color: var(--vscode-menu-foreground);
			border: 1px solid var(--vscode-menu-border); border-radius: 4px;
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
		}
		.stag-ctx-menu[hidden] { display: none !important; }
		.stag-ctx-menu button {
			display: block; width: 100%; margin: 0; padding: 6px 14px; border: none; border-radius: 0;
			font-size: 13px; text-align: left; cursor: pointer;
			background: transparent; color: var(--vscode-menu-foreground);
		}
		.stag-ctx-menu button:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
		.stag-ctx-menu button.stag-ctx-danger:hover { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); }
		.stag-subtag-footer { flex-shrink: 0; border-top: 1px solid var(--vscode-panel-border); padding: 8px 10px; }
		.stag-subtag-footer .lbl { font-size: 11px; color: var(--vscode-descriptionForeground); display: block; margin-bottom: 3px; }
		.stag-subtag-footer .inp { width: 100%; padding: 5px 7px; font-size: 11px; border-radius: 4px; box-sizing: border-box;
			border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
		.stag-row2 { display: flex; gap: 6px; align-items: center; }
		.stag-row2 .inp { flex: 1; }
		.error { margin: 8px 10px 0; color: var(--vscode-errorForeground); }
	</style>
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
	<script nonce="${nonce}">
${subOnlyScript}
	</script>
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
