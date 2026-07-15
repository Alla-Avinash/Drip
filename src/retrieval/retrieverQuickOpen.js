'use strict';

const vscode = require('vscode');
const { buildRetrieverIndex, sortRetrieverRows } = require('./dripnoteRetrieverQuery');
const { openRetrieverHeading } = require('../views/lhs/retriever/panel');

const QUICK_PICK_CAP = 12_000;

/**
 * @param {{
 *   getKnowledgeBaseRoot?: () => import('vscode').Uri | undefined
 * }} state
 */
async function runRetrieverHeadingQuickOpen(state) {
	const rk =
		typeof state.getRetrieverKnowledgeBaseRoot === 'function'
			? state.getRetrieverKnowledgeBaseRoot()
			: { uri: state.getKnowledgeBaseRoot?.(), usedWorkspaceFallback: false };
	const kb = rk.uri;
	if (!kb) {
		void vscode.window.showWarningMessage(
			'Open a folder workspace or set a Knowledge Base folder (DRIP sidebar).'
		);
		return;
	}

	/** @type {Awaited<ReturnType<typeof buildRetrieverIndex>> | undefined} */
	let idx;
	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'DRIP: Scanning headings…',
				cancellable: false
			},
			async () => {
				idx = await buildRetrieverIndex(kb, { usedWorkspaceFallback: rk.usedWorkspaceFallback });
			}
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		void vscode.window.showErrorMessage(`Could not index headings: ${msg}`);
		return;
	}

	if (!idx || idx.kbMissing) {
		void vscode.window.showWarningMessage('Knowledge base is not available.');
		return;
	}
	const rows = idx.rows || [];
	if (!rows.length) {
		void vscode.window.showInformationMessage('No headings found in the knowledge base.');
		return;
	}

	const sorted = sortRetrieverRows(rows, { sortBy: 'recent', groupBy: 'none' });
	const capped = sorted.length > QUICK_PICK_CAP ? sorted.slice(0, QUICK_PICK_CAP) : sorted;

	/** @type {(vscode.QuickPickItem & { _row?: (typeof rows)[0] })[]} */
	const items = capped.map(r => {
		const bc = (r.breadcrumbs || []).slice(0, -1);
		return {
			label: r.title,
			description: `${r.relPath}:${r.line}`,
			detail: bc.length ? bc.join(' › ') : undefined,
			_row: r
		};
	});

	const hint =
		sorted.length > QUICK_PICK_CAP
			? `Showing ${QUICK_PICK_CAP} most recently modified headings (of ${sorted.length}). `
			: '';

	const qp = vscode.window.createQuickPick();
	qp.placeholder = `${hint}Enter to open file — toolbar: show in Retriever`;
	qp.matchOnDescription = true;
	qp.matchOnDetail = true;
	qp.items = items;
	qp.buttons = [
		{
			iconPath: new vscode.ThemeIcon('search'),
			tooltip: 'Show active heading in DRIP Retriever (filter by title)'
		}
	];

	let lastActive =
		/** @type {(typeof items)[number] | undefined} */ (items.length ? items[0] : undefined);
	qp.onDidChangeActive(act => {
		if (act.length) {
			lastActive = /** @type {(typeof items)[number]} */ (act[0]);
		}
	});

	qp.onDidTriggerButton(async () => {
		const pick = qp.selectedItems[0] || lastActive;
		const row = pick && pick._row;
		if (!row) {
			void vscode.window.showInformationMessage('Pick a heading first (use arrow keys).');
			return;
		}
		qp.hide();
		await vscode.commands.executeCommand('drip.openRetriever', { applyQuery: row.title });
	});

	qp.onDidAccept(async () => {
		const pick = qp.selectedItems[0];
		qp.hide();
		if (pick && pick._row) {
			await openRetrieverHeading(pick._row.uri, pick._row.line);
		}
	});

	qp.show();

	await new Promise(resolve => {
		qp.onDidHide(() => resolve());
	});
}

module.exports = {
	runRetrieverHeadingQuickOpen
};
