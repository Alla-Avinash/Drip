'use strict';

const path = require('path');
const crypto = require('crypto');
const vscode = require('vscode');

const MIME_EXT = {
	'image/png': '.png',
	'image/jpeg': '.jpg',
	'image/jpg': '.jpg',
	'image/gif': '.gif',
	'image/webp': '.webp',
	'image/svg+xml': '.svg',
	'image/bmp': '.bmp',
	'image/avif': '.avif',
	'image/tiff': '.tiff',
	'image/x-icon': '.ico'
};

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif', '.tiff', '.tif', '.ico']);

function extFromMime(mime) {
	const m = String(mime || '')
		.toLowerCase()
		.split(';')[0]
		.trim();
	return MIME_EXT[m] || '.png';
}

function extFromFilename(name) {
	const n = String(name || '');
	const i = n.lastIndexOf('.');
	if (i < 0) {
		return '';
	}
	const ext = n.slice(i).toLowerCase();
	return IMAGE_EXT.has(ext) ? ext : '';
}

function makeImageFileName(ext) {
	const e = ext && ext.startsWith('.') ? ext : `.${ext || 'png'}`;
	return `pasted-image-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${e}`;
}

function relativePathFromNoteToDest(noteUri, destUri) {
	const from = path.dirname(noteUri.fsPath);
	return path.relative(from, destUri.fsPath).replace(/\\/g, '/');
}

async function ensureDirectory(dirUri) {
	try {
		await vscode.workspace.fs.stat(dirUri);
	} catch {
		await vscode.workspace.fs.createDirectory(dirUri);
	}
}

/**
 * @param {import('vscode').DataTransfer} dataTransfer
 * @param {import('vscode').CancellationToken} token
 */
async function extractFirstImageBytes(dataTransfer, token) {
	for (const [mimeType, item] of dataTransfer) {
		if (token.isCancellationRequested) {
			return null;
		}
		if (!item || !mimeType) {
			continue;
		}
		const m = String(mimeType)
			.toLowerCase()
			.split(';')[0]
			.trim();
		if (!m.startsWith('image/')) {
			continue;
		}
		const file = item.asFile();
		if (!file) {
			continue;
		}
		const data = await file.data();
		if (!data || !data.byteLength) {
			continue;
		}
		const ext = extFromFilename(file.name) || extFromMime(m);
		return { bytes: data, ext };
	}

	const filesItem = dataTransfer.get('files');
	if (filesItem && !token.isCancellationRequested) {
		const file = filesItem.asFile();
		if (file) {
			const ext = extFromFilename(file.name);
			if (ext) {
				const data = await file.data();
				if (data && data.byteLength) {
					return { bytes: data, ext };
				}
			}
		}
	}

	const uriListData = dataTransfer.get('text/uri-list');
	if (uriListData && !token.isCancellationRequested) {
		const raw = await uriListData.asString();
		if (raw) {
			for (const line of raw.split(/\r?\n/g)) {
				const s = line.trim();
				if (!s || s.startsWith('#')) {
					continue;
				}
				try {
					const uri = vscode.Uri.parse(s);
					if (uri.scheme !== 'file') {
						continue;
					}
					const ext = extFromFilename(uri.fsPath);
					if (!ext) {
						continue;
					}
					const data = await vscode.workspace.fs.readFile(uri);
					if (data.length) {
						return { bytes: data, ext };
					}
				} catch {
					// next line
				}
			}
		}
	}

	return null;
}

/**
 * @param {import('vscode').TextDocument} document
 * @param {import('vscode').DataTransfer} dataTransfer
 * @param {import('vscode').CancellationToken} token
 */
async function prepareDotImgInsert(document, dataTransfer, token) {
	if (document.languageId !== 'dripnote' || document.uri.scheme !== 'file') {
		return null;
	}

	const img = await extractFirstImageBytes(dataTransfer, token);
	if (!img || token.isCancellationRequested) {
		return null;
	}

	const noteDir = vscode.Uri.joinPath(document.uri, '..');
	const imgDir = vscode.Uri.joinPath(noteDir, '.img');
	await ensureDirectory(imgDir);

	const fileName = makeImageFileName(img.ext);
	const destUri = vscode.Uri.joinPath(imgDir, fileName);
	const rel = relativePathFromNoteToDest(document.uri, destUri);

	const insertText = `![](${rel})`;
	const additionalEdit = new vscode.WorkspaceEdit();
	additionalEdit.createFile(destUri, { contents: img.bytes, overwrite: false });

	return { insertText, additionalEdit };
}

const DROP_PASTE_MIME_TYPES = ['image/*', 'files', 'text/uri-list'];

function registerNoteImagePasteAndDrop(context) {
	if (typeof vscode.languages.registerDocumentPasteEditProvider !== 'function') {
		return;
	}
	if (!vscode.DocumentDropOrPasteEditKind || !vscode.DocumentDropOrPasteEditKind.Text) {
		return;
	}

	const dripNoteImageKind = vscode.DocumentDropOrPasteEditKind.Text.append('markdown', 'image', 'drip-note');
	const selector = { language: 'dripnote', scheme: 'file' };

	const provider = {
		async provideDocumentPasteEdits(document, _ranges, dataTransfer, _ctx, token) {
			const insert = await prepareDotImgInsert(document, dataTransfer, token);
			if (!insert) {
				return undefined;
			}
			const edit = new vscode.DocumentPasteEdit(insert.insertText, 'Insert image into .img (DRIP)', dripNoteImageKind);
			edit.additionalEdit = insert.additionalEdit;
			return [edit];
		},

		async provideDocumentDropEdits(document, _position, dataTransfer, token) {
			const insert = await prepareDotImgInsert(document, dataTransfer, token);
			if (!insert) {
				return undefined;
			}
			const drop = new vscode.DocumentDropEdit(insert.insertText);
			drop.title = 'Insert image into .img (DRIP)';
			drop.kind = dripNoteImageKind;
			drop.additionalEdit = insert.additionalEdit;
			return drop;
		}
	};

	const meta = {
		providedPasteEditKinds: [dripNoteImageKind],
		pasteMimeTypes: DROP_PASTE_MIME_TYPES
	};

	const dropMeta =
		typeof vscode.languages.registerDocumentDropEditProvider === 'function'
			? {
					providedDropEditKinds: [dripNoteImageKind],
					dropMimeTypes: DROP_PASTE_MIME_TYPES
				}
			: null;

	context.subscriptions.push(vscode.languages.registerDocumentPasteEditProvider(selector, provider, meta));

	if (dropMeta) {
		context.subscriptions.push(vscode.languages.registerDocumentDropEditProvider(selector, provider, dropMeta));
	}
}

module.exports = {
	registerNoteImagePasteAndDrop
};
