'use strict';

const path = require('path');
const vscode = require('vscode');
const { getNonce } = require('../../../shared/utils');
const { getMetadataSettings } = require('../../../document/model/dripnoteMetadataTemplates');
const {
	parseNoteForCanvas,
	inferMarkerFromMeta,
	extractSubtreeAtLine,
	findFlatIndexByLine,
	parseHeadingLine
} = require('../../../document/parse/dripnoteCanvasParse');
const { buildNodeGraphForCanvas } = require('../../../document/graph/dripnoteNodeGraphParse');
const { buildWorkflowGraphForCanvas } = require('../../../document/workflow/dripnoteWorkflowParse');

const DRIP_CANVAS_PANEL_ID = 'drip.canvas';

/**
 * Session strings may be plain fs paths or full URIs (e.g. vscode-remote) from the webview.
 * @param {string} s
 * @returns {import('vscode').Uri}
 */
function uriFromCanvasStoredPath(s) {
	const t = String(s || '').trim();
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
		return vscode.Uri.parse(t);
	}
	return vscode.Uri.file(t);
}

/**
 * @param {string[]} arr
 * @param {string} candidate
 */
function canvasSessionHasPath(arr, candidate) {
	try {
		const u = uriFromCanvasStoredPath(candidate);
		const key = u.toString();
		for (const x of arr) {
			try {
				if (uriFromCanvasStoredPath(x).toString() === key) return true;
			} catch (_) {
				/* continue */
			}
		}
	} catch (_) {
		/* ignore */
	}
	return false;
}

function getCanvasVisibleTypeIds() {
	const c = vscode.workspace.getConfiguration('drip');
	const raw = c.get('canvasVisibleTypeIds', []);
	return Array.isArray(raw) ? raw.map(x => String(x || '').trim().toLowerCase()).filter(Boolean) : [];
}

/**
 * @param {import('vscode').WorkspaceConfiguration} c
 * @param {string[]} ids
 */
function setCanvasVisibleTypeIds(c, ids) {
	return c.update('canvasVisibleTypeIds', ids, vscode.ConfigurationTarget.Global);
}

function getCanvasShowHeadingsWithoutType() {
	const c = vscode.workspace.getConfiguration('drip');
	return c.get('canvasShowHeadingsWithoutType', true) !== false;
}

/**
 * @param {import('vscode').WorkspaceConfiguration} c
 * @param {boolean} v
 */
function setCanvasShowHeadingsWithoutType(c, v) {
	return c.update('canvasShowHeadingsWithoutType', !!v, vscode.ConfigurationTarget.Global);
}

/**
 * @param {string} s
 */
function canvasPathKey(s) {
	try {
		return uriFromCanvasStoredPath(String(s || '').trim()).toString();
	} catch (_) {
		return String(s || '')
			.trim()
			.toLowerCase();
	}
}

function markerToTypeIdMap() {
	const s = getMetadataSettings();
	/** @type {Map<string, string>} */
	const m = new Map();
	for (const t of s.types || []) {
		const id = String(t.id || '').trim().toLowerCase();
		const marker = String(t.marker || '').trim().toLowerCase();
		if (marker) m.set(marker, id);
	}
	return m;
}

/**
 * True if the heading section contains a `.type` metadata line (dot-keyword).
 * @param {string[]} metaLines
 */
function headingHasDotTypeLine(metaLines) {
	for (const line of metaLines || []) {
		if (/^\s*\.type\b/i.test(String(line || ''))) {
			return true;
		}
	}
	return false;
}

/**
 * Webview only paints titles/levels; drop `metaLines` to avoid huge postMessage / OOM.
 * @param {any[]} nodes
 * @returns {any[]}
 */
function slimHeadingRootsForWebview(nodes) {
	if (!nodes || !nodes.length) return [];
	return nodes.map(n => {
		const children = slimHeadingRootsForWebview(n.children || []);
		return {
			tabDepth: n.tabDepth,
			level: n.level,
			title: n.title,
			lineIndex: n.lineIndex,
			metaLines: [],
			children,
			hasChildHeadings: children.length > 0
		};
	});
}

/**
 * @param {any[]} nodes
 * @param {string[]} visibleIds
 * @param {Map<string, string>} markerMap
 * @param {boolean} showUntypedWhen typed filters hide sections without matching type id
 */
function filterHeadingTree(nodes, visibleIds, markerMap, showUntypedWhen) {
	if (!visibleIds.length) return nodes;
	const out = [];
	for (const n of nodes) {
		const marker = inferMarkerFromMeta(n.metaLines).toLowerCase();
		const typeId = marker ? markerMap.get(marker) : '';
		let selfOk = !marker || !typeId || visibleIds.includes(typeId);
		if (showUntypedWhen && !headingHasDotTypeLine(n.metaLines)) {
			selfOk = true;
		}
		const children = filterHeadingTree(n.children || [], visibleIds, markerMap, showUntypedWhen);
		if (selfOk || children.length) {
			out.push({
				...n,
				metaLines: selfOk ? n.metaLines : [],
				children
			});
		}
	}
	return out;
}

/**
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} extensionUri
 */
function getCanvasHtml(webview, extensionUri) {
	const nonce = getNonce();
	const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'views', 'lhs', 'canvas', 'webview', 'canvas.css'));
	const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'views', 'lhs', 'canvas', 'webview', 'canvas.js'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}' ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>DRIP Canvas</title>
	<link rel="stylesheet" href="${cssUri}">
</head>
<body class="canvas-body">
	<header class="canvas-toolbar">
		<div class="canvas-brand">
			<h1 class="canvas-title">Canvas</h1>
			<p class="canvas-subtitle">Interactive heading hierarchy — pan, zoom, drop notes</p>
		</div>
		<div class="canvas-toolbar-actions">
			<button type="button" class="btn-toolbar secondary" id="btn-clear" title="Clear the canvas">Clear</button>
			<button type="button" class="btn-toolbar icon-only" id="btn-settings" title="Which metadata types to show">
				<span class="gear" aria-hidden="true">⚙</span>
			</button>
		</div>
	</header>
	<div class="canvas-shell">
	<div class="canvas-controls-bar">
		<button type="button" class="btn-toolbar secondary" id="btn-add-files" title="Choose .d.txt files from disk">Add files…</button>
		<label class="canvas-view-select" for="sel-canvas-view">
			<span class="canvas-view-select-label">Views</span>
			<select id="sel-canvas-view" class="canvas-view-select-input" title="Canvas layout style">
				<option value="classic">Classic</option>
				<option value="graph">Graph view</option>
				<option value="teardrop">Tear drop</option>
				<option value="nodegraph">Node graph</option>
			</select>
		</label>
		<span class="canvas-hint-keys">From Explorer: hold <strong>Shift</strong> while dragging · OS files: drop anywhere · Pan / wheel on the map</span>
		<button type="button" class="btn-toolbar secondary" id="btn-zoom-reset" title="Reset zoom and pan">Reset view</button>
	</div>
	<div id="canvas-viewport" class="canvas-viewport">
		<div id="node-graph-floats" class="node-graph-floats hidden">
			<aside id="node-graph-heading-filter" class="node-graph-float">
				<button type="button" id="btn-node-heading-filter-toggle" class="node-graph-float-toggle" aria-expanded="true">Headings ▾</button>
				<div id="node-graph-heading-filter-body" class="node-graph-float-body">
					<p class="node-graph-settings-title">Persistence</p>
					<div id="node-graph-heading-persistence"></div>
					<p class="node-graph-settings-title" style="margin-top:10px !important">Types</p>
					<div id="node-graph-heading-types"></div>
				</div>
			</aside>
			<aside id="node-graph-filter" class="node-graph-float">
				<button type="button" id="btn-node-filter-toggle" class="node-graph-float-toggle" aria-expanded="true">Relations ▾</button>
				<div id="node-graph-filter-body" class="node-graph-float-body">
					<p>Show relation edges</p>
					<div id="node-graph-relation-types"></div>
				</div>
			</aside>
			<aside id="node-graph-settings" class="node-graph-float">
				<button type="button" id="btn-node-settings-toggle" class="node-graph-float-toggle" aria-expanded="true">Graph settings ▾</button>
				<div id="node-graph-settings-body" class="node-graph-float-body">
					<p class="node-graph-settings-title">Forces</p>
					<label class="node-graph-chk"><input type="checkbox" id="ng-opt-rigid" /> Rigid mode (freeze nodes)</label>
					<label class="node-graph-range-label" for="ng-opt-force-center">Center force <span id="ng-opt-force-center-val"></span></label>
					<input id="ng-opt-force-center" type="range" min="0" max="0.015" step="0.001" value="0.003" />
					<label class="node-graph-range-label" for="ng-opt-force-repel">Repel force <span id="ng-opt-force-repel-val"></span></label>
					<input id="ng-opt-force-repel" type="range" min="10" max="30" step="0.05" value="25" />
					<label class="node-graph-range-label" for="ng-opt-force-link">Link force <span id="ng-opt-force-link-val"></span></label>
					<input id="ng-opt-force-link" type="range" min="0" max="1" step="0.01" value="0.7" />
					<label class="node-graph-range-label" for="ng-opt-link-distance">Link distance <span id="ng-opt-link-distance-val"></span></label>
					<input id="ng-opt-link-distance" type="range" min="15" max="200" step="5" value="185" />
				</div>
			</aside>
		</div>
		<div id="canvas-empty" class="canvas-empty-overlay">
			<p class="canvas-empty-title">Heading map</p>
			<p class="canvas-empty-text">From the <strong>Explorer</strong>, hold <strong>Shift</strong> and drop <code>.d.txt</code> (otherwise VS Code opens the file). Or use <strong>Add files…</strong> / <code>Open heading in Canvas</code>.</p>
		</div>
		<div id="canvas-world" class="canvas-world">
			<svg id="canvas-edges" class="canvas-edges" aria-hidden="true"></svg>
			<div id="canvas-nodes" class="canvas-nodes"></div>
			<svg id="canvas-tree-edges" class="canvas-tree-edges" aria-hidden="true"></svg>
		</div>
	</div>
	</div>
	<div id="settings-panel" class="settings-overlay hidden" role="dialog">
		<div class="settings-card">
			<div class="settings-head">
				<h2>Visible metadata types</h2>
				<button type="button" class="icon-btn" id="btn-close-settings">✕</button>
			</div>
			<p class="settings-meta">Uncheck to hide sections whose first dot-marker maps to that metadata type. If none checked, all types are shown.</p>
			<div id="type-checkboxes" class="type-checkboxes"></div>
			<label class="canvas-option-row"><input type="checkbox" id="cb-canvas-untyped" />
				<span>Show headings with no <code>.type</code> line when filtering by type</span></label>
			<div class="settings-actions">
				<button type="button" id="btn-save-types">Save</button>
			</div>
		</div>
	</div>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

/** @type {import('vscode').WebviewPanel | undefined} */
let panelRef;

/** @type {{ heading: { uri: import('vscode').Uri; line: number } | null; paths: string[] }} */
let canvasSession = { heading: null, paths: [] };

/** Normalized key — last path added via drop / Open file in Canvas (for webview highlight). */
let canvasDropHighlightKey = '';

class DripCanvasPanel {
	/**
	 * @param {import('vscode').Uri} extensionUri
	 * @param {{ uri: import('vscode').Uri, line: number } | null} heading
	 * @param {{ mergePaths?: boolean }} [options]
	 */
	static createOrShow(extensionUri, heading, options) {
		const opts = options || {};
		const mergePaths = !!opts.mergePaths;
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		if (panelRef) {
			panelRef.reveal(column);
			if (heading) {
				canvasSession.heading = heading;
				canvasSession.paths = [];
				canvasDropHighlightKey = '';
			}
			void DripCanvasPanel.refreshPanel(panelRef);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			DRIP_CANVAS_PANEL_ID,
			'DRIP Canvas',
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extensionUri]
			}
		);

		panel.webview.html = getCanvasHtml(panel.webview, extensionUri);
		panelRef = panel;

		panel.onDidDispose(() => {
			panelRef = undefined;
		});

		panel.webview.onDidReceiveMessage(async message => {
			try {
				if (message.type === 'clearSession' && panelRef) {
					canvasSession = { heading: null, paths: [] };
					canvasDropHighlightKey = '';
					await DripCanvasPanel.refreshPanel(panelRef);
					return;
				}
				if (message.type === 'saveCanvasSettings' && panelRef) {
					const c = vscode.workspace.getConfiguration('drip');
					if (Array.isArray(message.visibleTypeIds)) {
						await setCanvasVisibleTypeIds(c, message.visibleTypeIds);
					}
					if (typeof message.showUntyped === 'boolean') {
						await setCanvasShowHeadingsWithoutType(c, message.showUntyped);
					}
					await DripCanvasPanel.refreshPanel(panelRef);
					return;
				}
				if (message.type === 'setVisibleTypeIds' && Array.isArray(message.ids)) {
					const conf = vscode.workspace.getConfiguration('drip');
					await setCanvasVisibleTypeIds(conf, message.ids);
					if (panelRef) await DripCanvasPanel.refreshPanel(panelRef);
				}
				if (message.type === 'pickFiles' && panelRef) {
					const uris = await vscode.window.showOpenDialog({
						canSelectMany: true,
						filters: { 'DRIP notes': ['d.txt'] },
						openLabel: 'Add to canvas'
					});
					if (uris && uris.length) {
						for (const u of uris) {
							const fsPath = u.fsPath;
							if (fsPath && !canvasSessionHasPath(canvasSession.paths, fsPath)) {
								canvasSession.paths.push(fsPath);
							}
						}
						await DripCanvasPanel.refreshPanel(panelRef);
					}
				}
				if (message.type === 'loadPaths' && Array.isArray(message.paths) && panelRef) {
					let lastAdded = '';
					for (const p of message.paths) {
						const clean = String(p || '').trim();
						if (!clean || !clean.toLowerCase().endsWith('.d.txt')) continue;
						if (!canvasSessionHasPath(canvasSession.paths, clean)) {
							canvasSession.paths.push(clean);
							lastAdded = clean;
						}
					}
					if (lastAdded) {
						canvasDropHighlightKey = canvasPathKey(lastAdded);
					}
					await DripCanvasPanel.refreshPanel(panelRef);
				}
			} catch (e) {
				void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
			}
		});

		canvasSession.heading = heading;
		if (!mergePaths) {
			canvasSession.paths = [];
		}
		if (heading) {
			canvasDropHighlightKey = '';
		}
		void DripCanvasPanel.refreshPanel(panel);
	}

	/**
	 * Rebuild canvas from canvasSession (heading block + dropped paths).
	 * @param {import('vscode').WebviewPanel} panel
	 */
	static async refreshPanel(panel) {
		const visibleIds = getCanvasVisibleTypeIds();
		const showUntypedWhen = getCanvasShowHeadingsWithoutType();
		const types = (getMetadataSettings().types || []).map(t => ({
			id: String(t.id || '').trim().toLowerCase(),
			marker: String(t.marker || '').trim(),
			shortcut: String(t.shortcut || '').replace(/\./g, '').trim(),
			label: String(t.id || '')
		}));
		const markerMap = markerToTypeIdMap();
		/** @type {object[]} */
		const docs = [];

		const heading = canvasSession.heading;
		if (heading && heading.uri) {
			try {
				const buf = await vscode.workspace.fs.readFile(heading.uri);
				const text = Buffer.from(buf).toString('utf8');
				const parsed = parseNoteForCanvas(text);
				const idx = findFlatIndexByLine(parsed.flat, heading.line);
				const fn = idx >= 0 ? parsed.flat[idx] : null;
				if (idx < 0) {
					void vscode.window.showWarningMessage(
						'Could not find a heading on that line — the line should start with # (after any tabs).'
					);
				} else if (!fn || fn.valid === false) {
					void vscode.window.showWarningMessage(
						'That heading is excluded from the hierarchy (invalid tab indent). Fix the red diagnostics in the editor, then try again.'
					);
				} else {
					const subtree = extractSubtreeAtLine(parsed.headingRoots, parsed.flat, heading.line);
					const filtered = subtree
						? filterHeadingTree(subtree, visibleIds, markerMap, showUntypedWhen)
						: [];
					const workflowGraph = buildWorkflowGraphForCanvas(filtered, 0);
					docs.push({
						id: path.basename(heading.uri.fsPath),
						fileLabel: heading.uri.fsPath + ' (from heading)',
						headingRoots: slimHeadingRootsForWebview(filtered),
						workflowGraph,
						nodeGraph: buildNodeGraphForCanvas(subtree || [], 0),
						focusLine: heading.line
					});
				}
			} catch (e) {
				docs.push({
					id: 'error',
					fileLabel: String(heading.uri.fsPath),
					headingRoots: [],
					error: e instanceof Error ? e.message : String(e)
				});
			}
		}

		for (const clean of canvasSession.paths) {
			if (!clean.toLowerCase().endsWith('.d.txt')) continue;
			try {
				const uri = uriFromCanvasStoredPath(clean);
				const buf = await vscode.workspace.fs.readFile(uri);
				const text = Buffer.from(buf).toString('utf8');
				const parsed = parseNoteForCanvas(text);
				const filtered = filterHeadingTree(
					parsed.headingRoots,
					visibleIds,
					markerMap,
					showUntypedWhen
				);
				docs.push({
					id: path.basename(clean),
					fileLabel: clean,
					headingRoots: slimHeadingRootsForWebview(filtered),
					workflowGraph: buildWorkflowGraphForCanvas(filtered, docs.length),
					nodeGraph: buildNodeGraphForCanvas(parsed.headingRoots, docs.length)
				});
			} catch (e) {
				docs.push({
					id: path.basename(clean),
					fileLabel: clean,
					headingRoots: [],
					error: e instanceof Error ? e.message : String(e)
				});
			}
		}

		let mode = 'empty';
		if (canvasSession.heading) mode = 'heading';
		else if (canvasSession.paths.length) mode = 'files';

		panel.webview.postMessage({
			type: 'canvasState',
			types,
			visibleTypeIds: visibleIds,
			canvasShowUntyped: showUntypedWhen,
			docs,
			highlightPath: canvasDropHighlightKey,
			mode
		});
	}
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
function registerDripCanvasPanel(context) {
	const extensionUri = context.extensionUri;
	context.subscriptions.push(
		vscode.commands.registerCommand('drip.openCanvasView', () => {
			DripCanvasPanel.createOrShow(extensionUri, null);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('drip.openHeadingInCanvas', () => {
			const ed = vscode.window.activeTextEditor;
			if (!ed || ed.document.languageId !== 'dripnote') {
				void vscode.window.showWarningMessage('Open a .d.txt (dripnote) file first.');
				return;
			}
			const line = ed.selection.active.line;
			const text = ed.document.lineAt(line).text;
			if (!parseHeadingLine(text)) {
				void vscode.window.showWarningMessage('Place the cursor on a heading line (starts with #).');
				return;
			}
			DripCanvasPanel.createOrShow(extensionUri, {
				uri: ed.document.uri,
				line
			});
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('drip.openFileInCanvas', () => {
			const ed = vscode.window.activeTextEditor;
			if (!ed || ed.document.languageId !== 'dripnote') {
				void vscode.window.showWarningMessage('Open a .d.txt (dripnote) file first.');
				return;
			}
			const fsPath = ed.document.uri.fsPath;
			if (!fsPath || !fsPath.toLowerCase().endsWith('.d.txt')) {
				return;
			}
			canvasSession.heading = null;
			if (!canvasSessionHasPath(canvasSession.paths, fsPath)) {
				canvasSession.paths.push(fsPath);
			}
			canvasDropHighlightKey = canvasPathKey(fsPath);
			DripCanvasPanel.createOrShow(extensionUri, null, { mergePaths: true });
		})
	);
}

module.exports = {
	DRIP_CANVAS_PANEL_ID,
	DripCanvasPanel,
	registerDripCanvasPanel
};
