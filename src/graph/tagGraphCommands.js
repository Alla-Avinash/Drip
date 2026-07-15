'use strict';

const vscode = require('vscode');
const tagGraphStore = require('./tagGraphStore');

/** @param {string} name */
function sanitizeFileName(name) {
	const s = String(name || 'tag-graph')
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 120);
	return s || 'tag-graph';
}

async function writeUtf8(uri, text) {
	await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
}

/**
 * @param {import('../src/state/state').DripState} state
 * @returns {Promise<boolean>} false if the user cancelled the save dialog
 */
async function exportActiveTagGraphToFile(state) {
	const graph = state.getTagGraph();
	const meta = tagGraphStore.getActiveStoredTagGraphMeta(state.context);
	const suggest = `${sanitizeFileName(meta.name)}.json`;
	/** @type {vscode.Uri | undefined} */
	let defaultUri;
	if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]) {
		defaultUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, suggest);
	}
	const picked = await vscode.window.showSaveDialog({
		defaultUri,
		filters: { JSON: ['json'] },
		saveLabel: 'Export'
	});
	if (!picked) {
		return false;
	}
	const envelope = {
		dripTagGraphExport: true,
		exportFormat: 1,
		name: meta.name,
		graphId: meta.id,
		exportedAt: new Date().toISOString(),
		graph
	};
	const json = JSON.stringify(envelope, null, 2);
	await writeUtf8(picked, json);
	void vscode.window.showInformationMessage(`Exported tags graph "${meta.name}"`);
	return true;
}

/**
 * @param {import('../src/state/state').DripState} state
 * @param {() => Promise<void>} pushTagGraphUi
 */
async function runTagGraphNew(state, pushTagGraphUi) {
	if ((await state.promptTagGraphSwitchOrCancel()) === 'cancel') {
		return;
	}
	const name = await vscode.window.showInputBox({
		prompt: 'Name for the new tags graph',
		value: 'Untitled graph'
	});
	if (name === undefined) {
		return;
	}
	await tagGraphStore.createStoredTagGraph(state.context, name);
	await pushTagGraphUi();
	void vscode.window.showInformationMessage(`New tags graph: ${String(name).trim() || 'Untitled graph'}`);
}

/**
 * @param {import('../src/state/state').DripState} state
 * @param {() => Promise<void>} pushTagGraphUi
 */
async function runTagGraphImport(state, pushTagGraphUi) {
	if ((await state.promptTagGraphSwitchOrCancel()) === 'cancel') {
		return;
	}
	const files = await vscode.window.showOpenDialog({
		canSelectMany: false,
		filters: { JSON: ['json'] },
		openLabel: 'Import tags graph'
	});
	if (!files || !files.length) {
		return;
	}
	let text;
	try {
		const buf = await vscode.workspace.fs.readFile(files[0]);
		text = Buffer.from(buf).toString('utf8');
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		void vscode.window.showErrorMessage(`Could not read file: ${msg}`);
		return;
	}
	let norm;
	try {
		norm = tagGraphStore.parseImportedTagGraphJson(text);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		void vscode.window.showErrorMessage(`Invalid tags graph file: ${msg}`);
		return;
	}
	const mode = await vscode.window.showQuickPick(
		[
			{ label: 'New stored graph', description: 'Add a graph slot and switch to it', mode: 'new' },
			{ label: 'Replace active graph', description: 'Overwrite the current graph slot', mode: 'replace' }
		],
		{ placeHolder: 'How should this file be imported?' }
	);
	if (!mode) {
		return;
	}
	if (mode.mode === 'new') {
		const slotName = await vscode.window.showInputBox({
			prompt: 'Name for the imported tags graph',
			value: 'Imported graph'
		});
		if (slotName === undefined) {
			return;
		}
		await tagGraphStore.importStoredTagGraphAsNew(state.context, slotName, norm);
	} else {
		await tagGraphStore.replaceActiveStoredTagGraphData(state.context, norm);
	}
	await pushTagGraphUi();
	void vscode.window.showInformationMessage('Tags graph import complete.');
}

module.exports = {
	exportActiveTagGraphToFile,
	runTagGraphNew,
	runTagGraphImport
};
