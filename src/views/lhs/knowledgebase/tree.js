'use strict';

const vscode = require('vscode');
const {
	loadDailyNotesTree,
	loadDailyMonthNodes,
	loadDailyNoteNodes
} = require('../../../startup/dailyNotesDrip');

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
	{ id: 'projectView', label: 'Project View', command: 'drip.openProjectView', icon: 'folder-library' },
	{ id: 'settings', label: 'DRIP Settings', command: 'drip.openDripSettingsView', icon: 'gear' }
];

class DripTreeDataProvider {
	/**
	 * @param {*} state
	 * @param {'components' | 'knowledge' | 'projects' | 'drafts' | 'recents' | 'dailyNotes'} mode
	 */
	constructor(state, mode) {
		this.state = state;
		this.mode = mode;
		this.onDidChangeTreeDataEmitter = new vscode.EventEmitter();
		this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
		/** @type {import('vscode').TreeItem[]} */
		this._lastProjectItems = [];
		this.presenceDecorations = new SharedProjectPresenceDecorationProvider();
	}

	refresh() {
		this.onDidChangeTreeDataEmitter.fire(undefined);
	}

	/**
	 * Online count uses a file decoration (badge), never a tree reload.
	 * Reloading this tree is what draws the loading bar under Projects.
	 */
	refreshPresence() {
		if (this.mode !== 'projects') return;
		void this.presenceDecorations.updateFromProjectItems(this._lastProjectItems);
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

			if (this.mode === 'recents') {
				if (!element) {
					return this.getRecentItems();
				}
				return [];
			}

			if (this.mode === 'dailyNotes') {
				return this.getDailyNotesChildren(element);
			}

			if (this.mode === 'projects') {
				return this.getProjectsChildren(element);
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

	async getProjectsChildren(element) {
		const kbRoot = this.state.getVerifiedKnowledgeBaseRoot();
		if (!kbRoot) {
			const item = new vscode.TreeItem('Select a Knowledge Base first', vscode.TreeItemCollapsibleState.None);
			item.contextValue = 'dripProjectsEmpty';
			return [item];
		}
		const { ensureProjectsHome } = require('../../../startup/projectsDrip');
		const home = await ensureProjectsHome(kbRoot);
		if (!element) {
			const kids = await this.state.getKnowledgeBaseTreeChildren(home);
			if (!kids.length) {
				this._lastProjectItems = [];
				const empty = new vscode.TreeItem('No projects yet', vscode.TreeItemCollapsibleState.None);
				empty.description = 'Use + to create or join a project';
				empty.iconPath = new vscode.ThemeIcon('folder-library');
				empty.contextValue = 'dripProjectsEmpty';
				return [empty];
			}
			this._lastProjectItems = kids;
			void this.presenceDecorations.updateFromProjectItems(kids);
			return kids;
		}
		if (element.kind === 'folder') {
			return this.state.getKnowledgeBaseTreeChildren(element.uri);
		}
		return [];
	}

	async getKnowledgeRootChildren() {
		// Only render the KB after the saved folder has been verified as a `.driplock` KB by
		// the startup check. Until then we show a neutral placeholder, so we never list folders
		// from an unverified (or stale) path.
		const kbRoot = this.state.getVerifiedKnowledgeBaseRoot();
		if (kbRoot) {
			return this.state.getKnowledgeBaseTreeChildren(kbRoot);
		}

		// A path is saved but verification hasn't finished yet — brief "verifying" state.
		// Once the check settles (success OR failure) this branch is never hit again.
		if (!this.state.getVerificationSettled() && this.state.getKnowledgeBaseRoot()) {
			const verifying = new vscode.TreeItem(
				'Verifying knowledge base…',
				vscode.TreeItemCollapsibleState.None
			);
			verifying.kind = 'kbRoot';
			verifying.contextValue = 'dripKbRoot';
			verifying.iconPath = new vscode.ThemeIcon('sync~spin');
			return [verifying];
		}

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
			const snippet = String(draft.metadata || draft.content || '')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, 48);
			item.description = snippet || draft.status || 'draft';
			item.tooltip = [draft.title || 'Untitled Draft', snippet].filter(Boolean).join('\n');
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

	getRecentItems() {
		const recents =
			typeof this.state.getRecentFiles === 'function' ? this.state.getRecentFiles() : [];
		if (!recents.length) {
			const emptyItem = new vscode.TreeItem(
				'No recent files yet',
				vscode.TreeItemCollapsibleState.None
			);
			emptyItem.description = 'Open or save a .d.txt note';
			emptyItem.contextValue = 'dripRecentEmpty';
			return [emptyItem];
		}

		return recents.map(entry => {
			const item = new vscode.TreeItem(entry.label, vscode.TreeItemCollapsibleState.None);
			item.kind = 'recent';
			item.tooltip = entry.uri;
			item.iconPath = new vscode.ThemeIcon('file');
			item.command = {
				command: 'drip.openRecentFile',
				title: 'Open Recent File',
				arguments: [entry.uri]
			};
			item.contextValue = 'dripRecent';
			return item;
		});
	}

	async getDailyNotesChildren(element) {
		const kbRoot = this.state.getVerifiedKnowledgeBaseRoot();
		if (!kbRoot) {
			const item = new vscode.TreeItem('Select a Knowledge Base first', vscode.TreeItemCollapsibleState.None);
			item.contextValue = 'dripDailyEmpty';
			return [item];
		}

		if (!element) {
			const years = await loadDailyNotesTree(kbRoot);
			if (!years.length) {
				const item = new vscode.TreeItem('No daily notes yet', vscode.TreeItemCollapsibleState.None);
				item.description = 'Use + to create today\'s note';
				item.iconPath = new vscode.ThemeIcon('calendar');
				item.contextValue = 'dripDailyEmpty';
				return [item];
			}
			return years.map(node => {
				const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
				item.kind = 'dailyYear';
				item.uri = node.uri;
				item.iconPath = new vscode.ThemeIcon('folder');
				item.contextValue = 'dripDailyYear';
				return item;
			});
		}

		if (element.kind === 'dailyYear') {
			const months = await loadDailyMonthNodes(element.uri);
			return months.map(node => {
				const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
				item.kind = 'dailyMonth';
				item.uri = node.uri;
				item.iconPath = new vscode.ThemeIcon('folder');
				item.contextValue = 'dripDailyMonth';
				return item;
			});
		}

		if (element.kind === 'dailyMonth') {
			const notes = await loadDailyNoteNodes(element.uri);
			return notes.map(node => {
				const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
				item.kind = 'dailyNote';
				item.uri = node.uri;
				item.resourceUri = node.uri;
				item.iconPath = new vscode.ThemeIcon('file-text');
				item.command = {
					command: 'vscode.open',
					title: 'Open Daily Note',
					arguments: [node.uri]
				};
				item.contextValue = 'dripDailyNote';
				return item;
			});
		}

		return [];
	}
}

/**
 * Green online count on a shared project folder. File decorations do not
 * reload the tree, so they never show the Projects loading bar.
 */
class SharedProjectPresenceDecorationProvider {
	constructor() {
		this._emitter = new vscode.EventEmitter();
		this.onDidChangeFileDecorations = this._emitter.event;
		/** @type {Map<string, number>} */
		this._countByFsPath = new Map();
	}

	/**
	 * @param {import('vscode').Uri} uri
	 */
	provideFileDecoration(uri) {
		if (!uri) return undefined;
		const n = this._countByFsPath.get(uri.fsPath);
		if (!n) return undefined;
		const badge = n > 99 ? '99' : String(n);
		return new vscode.FileDecoration(
			badge,
			n === 1 ? '1 online' : `${n} online`,
			new vscode.ThemeColor('charts.green')
		);
	}

	/**
	 * @param {{ uri?: import('vscode').Uri, contextValue?: string }[]} items
	 */
	async updateFromProjectItems(items) {
		const { readProjectRecord } = require('../../../peer/projectSidecar');
		const { onlineCountFor, isSharingActive } = require('../../../peer/projectLanSync');
		const next = new Map();
		for (const item of items || []) {
			if (!item || item.contextValue !== 'dripProjectFolder' || !item.uri) continue;
			try {
				const rec = await readProjectRecord(item.uri);
				if (!rec || !rec.shared || !rec.projectId || !isSharingActive(rec.projectId)) continue;
				next.set(item.uri.fsPath, Math.max(1, onlineCountFor(rec.projectId)));
			} catch {
				/* sidecar may be missing */
			}
		}
		this._countByFsPath = next;
		this._emitter.fire(undefined);
	}
}

module.exports = {
	DripTreeDataProvider
};
