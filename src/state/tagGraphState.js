'use strict';

// Tag-graph state, mixed into DripState.prototype. Owns the standalone tag graph
// (load/save/checkpoint), undo/redo history, and graph mutation routing.

const vscode = require('vscode');

const tagGraphStateMixin = {
	/** Standalone tag graph (not linked to note files yet). */
	getTagGraph() {
		const { loadTagGraph } = require('../graph/tagGraphStore');
		return loadTagGraph(this.context);
	},

	async saveTagGraph(graph) {
		const { saveTagGraph, normalizeGraph } = require('../graph/tagGraphStore');
		await saveTagGraph(this.context, normalizeGraph(graph));
	},

	syncTagGraphCheckpointFromStorage() {
		const tagGraphStore = require('../graph/tagGraphStore');
		const g = tagGraphStore.normalizeGraph(tagGraphStore.loadTagGraph(this.context));
		this._tagGraphCheckpoint = JSON.parse(JSON.stringify(g));
	},

	isTagGraphDirtyVsCheckpoint() {
		if (!this._tagGraphCheckpoint) {
			return false;
		}
		const tagGraphStore = require('../graph/tagGraphStore');
		const cur = tagGraphStore.normalizeGraph(tagGraphStore.loadTagGraph(this.context));
		return JSON.stringify(cur) !== JSON.stringify(this._tagGraphCheckpoint);
	},

	commitTagGraphCheckpoint() {
		this.syncTagGraphCheckpointFromStorage();
	},

	async revertTagGraphToCheckpoint() {
		if (!this._tagGraphCheckpoint) {
			return;
		}
		await this.saveTagGraph(this._tagGraphCheckpoint);
	},

	/**
	 * When switching graphs: if the slot changed since last checkpoint, ask what to do.
	 * @returns {Promise<'ok'|'cancel'>}
	 */
	async promptTagGraphSwitchOrCancel() {
		if (!this.isTagGraphDirtyVsCheckpoint()) {
			return 'ok';
		}
		const pick = await vscode.window.showWarningMessage(
			'This tags graph has changes since you last opened it (or last confirmed this slot). Save these edits to this slot and continue, discard them and restore the previous version, or cancel?',
			{ modal: true },
			'Save and continue',
			'Discard without saving',
			'Cancel'
		);
		if (pick === 'Cancel' || pick === undefined) {
			return 'cancel';
		}
		if (pick === 'Discard without saving') {
			await this.revertTagGraphToCheckpoint();
			return 'ok';
		}
		this.commitTagGraphCheckpoint();
		return 'ok';
	},

	clearTagGraphHistory() {
		this._tagGraphUndo.length = 0;
		this._tagGraphRedo.length = 0;
	},

	_clearTagGraphRedo() {
		this._tagGraphRedo.length = 0;
	},

	_pushTagGraphUndoSnapshot(graph) {
		// Graph is plain data; JSON clone is fine here.
		const snap = JSON.parse(JSON.stringify(graph));
		this._tagGraphUndo.push(snap);
		if (this._tagGraphUndo.length > this._tagGraphHistoryMax) {
			this._tagGraphUndo.splice(0, this._tagGraphUndo.length - this._tagGraphHistoryMax);
		}
	},

	_pushTagGraphRedoSnapshot(graph) {
		const snap = JSON.parse(JSON.stringify(graph));
		this._tagGraphRedo.push(snap);
		if (this._tagGraphRedo.length > this._tagGraphHistoryMax) {
			this._tagGraphRedo.splice(0, this._tagGraphRedo.length - this._tagGraphHistoryMax);
		}
	},

	async undoTagGraph() {
		if (!this._tagGraphUndo.length) {
			return this.getTagGraph();
		}
		const tagGraphStore = require('../graph/tagGraphStore');
		const current = tagGraphStore.normalizeGraph(tagGraphStore.loadTagGraph(this.context));
		const prev = this._tagGraphUndo.pop();
		this._pushTagGraphRedoSnapshot(current);
		await tagGraphStore.saveTagGraph(this.context, tagGraphStore.normalizeGraph(prev));
		return tagGraphStore.normalizeGraph(prev);
	},

	async redoTagGraph() {
		if (!this._tagGraphRedo.length) {
			return this.getTagGraph();
		}
		const tagGraphStore = require('../graph/tagGraphStore');
		const current = tagGraphStore.normalizeGraph(tagGraphStore.loadTagGraph(this.context));
		const next = this._tagGraphRedo.pop();
		this._pushTagGraphUndoSnapshot(current);
		await tagGraphStore.saveTagGraph(this.context, tagGraphStore.normalizeGraph(next));
		return tagGraphStore.normalizeGraph(next);
	},

	/**
	 * @param {(g: ReturnType<typeof import('../graph/tagGraphStore').loadTagGraph>) => void} mutator
	 * @param {{ recordHistory?: boolean }} [opts]
	 */
	async mutateTagGraph(mutator, opts) {
		const tagGraphStore = require('../graph/tagGraphStore');
		const recordHistory = opts && typeof opts.recordHistory === 'boolean' ? opts.recordHistory : true;
		const g = tagGraphStore.loadTagGraph(this.context);
		if (recordHistory) {
			this._pushTagGraphUndoSnapshot(tagGraphStore.normalizeGraph(g));
			this._clearTagGraphRedo();
		}
		mutator(g);
		await tagGraphStore.saveTagGraph(this.context, tagGraphStore.normalizeGraph(g));
		return tagGraphStore.normalizeGraph(g);
	},

};

module.exports = { tagGraphStateMixin };
