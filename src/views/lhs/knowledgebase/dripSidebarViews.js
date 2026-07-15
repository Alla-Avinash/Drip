'use strict';

const vscode = require('vscode');
const { DRIP_COMPONENTS_VIEW_ID } = require('../../../shared/constants');

const DRIP_VIEW_CONTAINER_ID = 'workbench.view.extension.drip';

/**
 * Keep Components visible: if the user hides it (Views menu, etc.), show it again.
 * Extension-only; works on stock VS Code without core patches.
 *
 * @param {import('vscode').TreeView} componentsTreeView
 * @param {import('vscode').ExtensionContext} context
 */
function registerComponentsViewPin(componentsTreeView, context) {
	let restoring = false;

	const ensureVisible = async () => {
		if (restoring || componentsTreeView.visible) {
			return;
		}
		restoring = true;
		try {
			await vscode.commands.executeCommand(`${DRIP_COMPONENTS_VIEW_ID}.toggleVisibility`);
		} catch {
			// toggleVisibility exists once the DRIP sidebar has been opened at least once
		} finally {
			restoring = false;
		}
	};

	context.subscriptions.push(
		componentsTreeView.onDidChangeVisibility(e => {
			if (!e.visible) {
				void ensureVisible();
			}
		})
	);

	if (!componentsTreeView.visible) {
		void ensureVisible();
	}
}

/**
 * Sidebar context keys and KB selection sync. Does not force DRIP views visible
 * (that stole focus from Explorer and other activity bar containers).
 *
 * @param {import('vscode').TreeView} kbTreeView
 * @param {import('vscode').TreeView} componentsTreeView
 * @param {import('vscode').ExtensionContext} context
 */
function registerDripSidebarViewBehavior(kbTreeView, componentsTreeView, context) {
	registerComponentsViewPin(componentsTreeView, context);
	function setKbEmptySelection(empty) {
		void vscode.commands.executeCommand('setContext', 'drip.kbEmptySelection', !!empty);
	}

	function syncKbEmptySelection() {
		setKbEmptySelection(!kbTreeView.selection || kbTreeView.selection.length === 0);
	}

	function setDripSidebarActive(active) {
		void vscode.commands.executeCommand('setContext', 'drip.sidebarActive', !!active);
	}

	setKbEmptySelection(true);
	setDripSidebarActive(false);
	syncKbEmptySelection();

	context.subscriptions.push(
		kbTreeView.onDidChangeSelection(() => syncKbEmptySelection()),
		kbTreeView.onDidChangeVisibility(e => {
			setDripSidebarActive(!!e.visible);
			if (e.visible) {
				syncKbEmptySelection();
			}
		}),
		vscode.window.onDidChangeActiveColorTheme(() => syncKbEmptySelection())
	);
}

module.exports = {
	registerDripSidebarViewBehavior,
	DRIP_VIEW_CONTAINER_ID
};
