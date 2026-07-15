'use strict';

const path = require('path');
const vscode = require('vscode');

/** Markdown image: ![alt](dest) — link range is dest only. */
const MD_IMAGE = /!\[[^\]]*\]\(([^)]+)\)/g;

/**
 Pull URL/path from markdown ( … ) payload: strip optional title, angle brackets, quotes.
 @param {string} raw
 @returns {string}
 */
function imageDestFromParenContent(raw) {
	let href = raw.trim();
	if (href.startsWith('<') && href.endsWith('>')) {
		href = href.slice(1, -1).trim();
	}
	const titleSplit = href.match(/^([^\s]+)(\s+["'][^"']*["'])?$/);
	if (titleSplit) {
		href = titleSplit[1];
	} else {
		const q = href.search(/\s+["']/);
		if (q > 0) {
			href = href.slice(0, q).trim();
		}
	}
	if ((href.startsWith('"') && href.endsWith('"')) || (href.startsWith("'") && href.endsWith("'"))) {
		href = href.slice(1, -1);
	}
	return href.trim();
}

/**
 @param {import('vscode').TextDocument} document
 @param {import('vscode').CancellationToken} token
 @returns {import('vscode').DocumentLink[]}
 */
function provideDocumentLinks(document, token) {
	if (document.uri.scheme !== 'file' || token.isCancellationRequested) {
		return [];
	}

	const text = document.getText();
	/** @type {import('vscode').DocumentLink[]} */
	const links = [];
	const baseDir = path.dirname(document.uri.fsPath);

	let m;
	MD_IMAGE.lastIndex = 0;
	while ((m = MD_IMAGE.exec(text)) !== null) {
		if (token.isCancellationRequested) {
			break;
		}
		const parenContent = m[1];
		const href = imageDestFromParenContent(parenContent);
		if (!href || href.startsWith('#')) {
			continue;
		}

		const full = m[0];
		const innerStart = m.index + full.lastIndexOf('](') + 2;
		const innerEnd = m.index + full.length - 1;
		const inner = text.slice(innerStart, innerEnd);

		let spanStart = 0;
		let spanLen = href.length;
		const pos = inner.indexOf(href);
		if (pos >= 0) {
			spanStart = pos;
			spanLen = href.length;
		} else {
			const w = `<${href}>`;
			const pw = inner.indexOf(w);
			if (pw >= 0) {
				spanStart = pw + 1;
				spanLen = href.length;
			} else {
				const dq = `"${href}"`;
				const pd = inner.indexOf(dq);
				if (pd >= 0) {
					spanStart = pd + 1;
					spanLen = href.length;
				} else {
					const sq = `'${href}'`;
					const ps = inner.indexOf(sq);
					if (ps >= 0) {
						spanStart = ps + 1;
						spanLen = href.length;
					} else {
						spanStart = 0;
						spanLen = inner.length;
					}
				}
			}
		}

		const absStart = innerStart + spanStart;
		const absEnd = absStart + spanLen;
		const range = new vscode.Range(document.positionAt(absStart), document.positionAt(absEnd));

		/** @type {import('vscode').Uri | undefined} */
		let target;
		try {
			if (/^https?:\/\//i.test(href)) {
				target = vscode.Uri.parse(href);
			} else {
				const noHash = href.split('#')[0];
				const fsPath = path.isAbsolute(noHash) ? noHash : path.resolve(baseDir, noHash);
				target = vscode.Uri.file(fsPath);
			}
		} catch {
			continue;
		}

		links.push(new vscode.DocumentLink(range, target));
	}

	return links;
}

function registerNoteDocumentLinks(context) {
	const provider = {
		provideDocumentLinks(document, token) {
			return provideDocumentLinks(document, token);
		}
	};

	context.subscriptions.push(
		vscode.languages.registerDocumentLinkProvider({ language: 'dripnote', scheme: 'file' }, provider)
	);
}

module.exports = {
	registerNoteDocumentLinks,
	provideDocumentLinks
};
