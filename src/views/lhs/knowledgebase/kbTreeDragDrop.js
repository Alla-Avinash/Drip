'use strict';

const path = require('path');
const vscode = require('vscode');

/** Internal payload for Knowledge Base tree drag-and-drop (same view). */
const KB_TREE_DND_MIME = 'application/vnd.code.tree.drip-knowledge-base';

/**
 * @param {*} state DripState
 * @param {() => void} refreshUi
 */
function createKbTreeDragDropController(state, refreshUi) {
	return {
		dropMimeTypes: [KB_TREE_DND_MIME, 'text/uri-list'],
		dragMimeTypes: [KB_TREE_DND_MIME, 'text/uri-list'],

		/**
		 * @param {vscode.TreeItem[]} sources
		 * @param {vscode.DataTransfer} dataTransfer
		 */
		async handleDrag(sources, dataTransfer, _token) {
			const uris = [];
			for (const s of sources) {
				if (!s || !s.uri || s.kind === 'kbRoot') {
					continue;
				}
				if (s.kind === 'folder' || s.kind === 'file' || s.kind === 'image') {
					uris.push(s.uri.toString());
				}
			}
			if (!uris.length) {
				return;
			}
			const unique = [...new Set(uris)];
			dataTransfer.set(KB_TREE_DND_MIME, new vscode.DataTransferItem(JSON.stringify({ uris: unique })));
			dataTransfer.set('text/uri-list', new vscode.DataTransferItem(unique.join('\r\n') + '\r\n'));
		},

		/**
		 * @param {vscode.TreeItem | undefined} target
		 * @param {vscode.DataTransfer} dataTransfer
		 */
		async handleDrop(target, dataTransfer, _token) {
			let sourceUris = collectSourceUrisFromTransfer(dataTransfer);
			if (!sourceUris.length) {
				return;
			}

			const kbRoot = state.getKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a knowledge base folder first.');
				return;
			}

			sourceUris = sourceUris.filter(u => isStrictlyUnderKb(kbRoot, u));
			if (!sourceUris.length) {
				void vscode.window.showWarningMessage('You can only move items that are inside the knowledge base.');
				return;
			}

			sourceUris = filterTopLevelUris(sourceUris);
			const destDir = resolveDropTargetDir(target, kbRoot);
			if (!destDir) {
				return;
			}

			for (const src of sourceUris) {
				let st;
				try {
					st = await vscode.workspace.fs.stat(src);
				} catch {
					continue;
				}
				if (st.type === vscode.FileType.Directory) {
					if (isDescendantOrEqual(src.fsPath, destDir.fsPath)) {
						void vscode.window.showWarningMessage('Cannot move a folder into itself or into one of its children.');
						return;
					}
				}
			}

			for (const src of sourceUris) {
				const name = path.basename(src.fsPath);
				const destUri = vscode.Uri.joinPath(destDir, name);
				if (path.normalize(src.fsPath) === path.normalize(destUri.fsPath)) {
					continue;
				}
				try {
					await vscode.workspace.fs.stat(destUri);
					void vscode.window.showErrorMessage(`"${name}" already exists in the destination.`);
					continue;
				} catch {
					/* destination free */
				}
				try {
					await vscode.workspace.fs.rename(src, destUri, { overwrite: false });
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					void vscode.window.showErrorMessage(`Move failed: ${msg}`);
				}
			}

			refreshUi();
		}
	};
}

/**
 * @param {vscode.DataTransfer} dataTransfer
 * @returns {vscode.Uri[]}
 */
function collectSourceUrisFromTransfer(dataTransfer) {
	const out = [];
	const drip = dataTransfer.get(KB_TREE_DND_MIME);
	if (drip?.value) {
		try {
			const raw = typeof drip.value === 'string' ? JSON.parse(drip.value) : drip.value;
			const arr = raw?.uris;
			if (Array.isArray(arr)) {
				for (const u of arr) {
					if (typeof u === 'string' && u) {
						out.push(vscode.Uri.parse(u));
					}
				}
			}
		} catch {
			/* ignore */
		}
	}
	if (out.length) {
		return dedupeUris(out);
	}

	const uriList = dataTransfer.get('text/uri-list');
	const v = uriList?.value;
	if (typeof v === 'string' && v.trim()) {
		const lines = v.split(/\r?\n/).filter(Boolean);
		for (const line of lines) {
			try {
				const u = vscode.Uri.parse(line.trim());
				if (u.scheme === 'file') {
					out.push(u);
				}
			} catch {
				/* ignore */
			}
		}
	}
	return dedupeUris(out);
}

/** @param {vscode.Uri[]} uris */
function dedupeUris(uris) {
	const seen = new Set();
	const res = [];
	for (const u of uris) {
		const k = u.toString();
		if (!seen.has(k)) {
			seen.add(k);
			res.push(u);
		}
	}
	return res;
}

/** @param {vscode.Uri} kbRoot */
function isStrictlyUnderKb(kbRoot, candidate) {
	const rel = path.relative(kbRoot.fsPath, candidate.fsPath);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Drop target is inside or equal to folder ancestor (invalid). */
function isDescendantOrEqual(ancestorFs, descendantFs) {
	const a = path.normalize(ancestorFs);
	const d = path.normalize(descendantFs);
	return d === a || d.startsWith(a + path.sep);
}

/** Keep only top-most selected nodes (children of a selected folder are redundant). */
function filterTopLevelUris(uris) {
	return uris.filter(u => {
		return !uris.some(other => other !== u && u.fsPath.startsWith(other.fsPath + path.sep));
	});
}

/**
 * @param {vscode.TreeItem | undefined} target
 * @param {vscode.Uri} kbRoot
 */
function resolveDropTargetDir(target, kbRoot) {
	if (!target || target.kind === 'kbRoot' || !target.uri) {
		return kbRoot;
	}
	if (target.kind === 'folder') {
		return target.uri;
	}
	if (target.kind === 'file' || target.kind === 'image') {
		return vscode.Uri.file(path.dirname(target.uri.fsPath));
	}
	return kbRoot;
}

module.exports = {
	createKbTreeDragDropController,
	KB_TREE_DND_MIME
};
