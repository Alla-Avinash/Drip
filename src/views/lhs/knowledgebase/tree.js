'use strict';

const vscode = require('vscode');

const COMPONENT_ENTRIES = [
	{
		id: 'chooseKb',
		label: 'Choose KB folder',
		command: 'drip.selectKnowledgeBase',
		icon: 'folder-opened'
	},
	{ id: 'composer', label: 'DRIP Composer', command: 'drip.openComposer', icon: 'edit' },
	{ id: 'editor', label: 'Editor', command: 'drip.openKbEditor', icon: 'notebook' },
	{ id: 'retriever', label: 'Retriever', command: 'drip.openRetriever', icon: 'search' },
	{ id: 'tagsGraph', label: 'Tags Graph', command: 'drip.openTagsPanel', icon: 'graph' },
	{ id: 'canvas', label: 'Canvas', command: 'drip.openCanvasView', icon: 'layout' },
	{ id: 'settings', label: 'DRIP Settings', command: 'drip.openDripSettingsView', icon: 'gear' }
];

class DripTreeDataProvider {
	/**
	 * @param {*} state
	 * @param {'components' | 'knowledge' | 'drafts'} mode
	 */
	constructor(state, mode) {
		this.state = state;
		this.mode = mode;
		this.onDidChangeTreeDataEmitter = new vscode.EventEmitter();
		this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
	}

	refresh() {
		this.onDidChangeTreeDataEmitter.fire(undefined);
	}

	async getChildren(element) {
		try {
			if (this.mode === 'components') {
				if (!element) {
					return this.getComponentItems();
				}
				return [];
			}

			if (this.mode === 'drafts') {
				if (!element) {
					return this.getDraftItems();
				}
				return [];
			}

			if (!element) {
				return await this.getKnowledgeRootChildren();
			}

			if (element.kind === 'folder') {
				return this.state.getKnowledgeBaseTreeChildren(element.uri);
			}

			return [];
		} catch {
			return [];
		}
	}

	getTreeItem(element) {
		return element;
	}

	getComponentItems() {
		return COMPONENT_ENTRIES.map(entry => {
			const item = new vscode.TreeItem(entry.label, vscode.TreeItemCollapsibleState.None);
			item.kind = 'component';
			item.componentId = entry.id;
			item.contextValue = 'dripComponent';
			item.iconPath = new vscode.ThemeIcon(entry.icon);
			item.command = {
				command: entry.command,
				title: entry.label
			};
			return item;
		});
	}

	async getKnowledgeRootChildren() {
		let kbRoot = this.state.getKnowledgeBaseRoot();
		if (
			!kbRoot &&
			typeof this.state.getRetrieverKnowledgeBaseRoot === 'function'
		) {
			const rk = this.state.getRetrieverKnowledgeBaseRoot();
			if (rk && rk.uri) {
				kbRoot = rk.uri;
			}
		}
		if (!kbRoot) {
			const kbItem = new vscode.TreeItem(
				'Select Knowledge Base Folder',
				vscode.TreeItemCollapsibleState.None
			);
			kbItem.kind = 'kbRoot';
			kbItem.contextValue = 'dripKbRoot';
			kbItem.description = 'Or open a folder workspace';
			kbItem.command = {
				command: 'drip.selectKnowledgeBase',
				title: 'Select Knowledge Base Folder'
			};
			kbItem.iconPath = new vscode.ThemeIcon('folder');
			return [kbItem];
		}

		return this.state.getKnowledgeBaseTreeChildren(kbRoot);
	}

	getDraftItems() {
		const drafts = this.state.getDrafts();
		if (!drafts.length) {
			const emptyItem = new vscode.TreeItem('No drafts saved yet', vscode.TreeItemCollapsibleState.None);
			emptyItem.description = 'Use the composer to create one';
			emptyItem.contextValue = 'dripDraftEmpty';
			return [emptyItem];
		}

		return drafts.map(draft => {
			const item = new vscode.TreeItem(draft.title || 'Untitled Draft', vscode.TreeItemCollapsibleState.None);
			item.kind = 'draft';
			item.draftId = draft.id;
			item.description = `${draft.priority} | ${draft.status}`;
			item.iconPath = new vscode.ThemeIcon('note');
			item.command = {
				command: 'drip.openComposer',
				title: 'Open Draft',
				arguments: [draft.id]
			};
			item.contextValue = 'dripDraft';
			return item;
		});
	}
}

module.exports = {
	DripTreeDataProvider
};
