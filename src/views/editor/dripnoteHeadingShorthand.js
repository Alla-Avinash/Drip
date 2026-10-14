'use strict';

/**
 * `# ` heading shorthand for `.d.txt` notes.
 *
 * Typing a bare `#` followed by a space at the start of a line auto-upgrades the marker to
 * the numbered `#N` form from the leading tab indent: `# ` = root, `\t# ` = `#1`,
 * `\t\t# ` = `#2`, and so on. Lines with any non-whitespace before the `#` are left alone,
 * and `.d.md`/markdown notes are never touched (they use `#`/`##` instead).
 */

const vscode = require('vscode');
const {
	runGuardedDocumentEdit,
	isGuardedDocumentEditActive,
	isExpectedDiskWrite
} = require('../../shared/documentEditGuard');

/** Leading whitespace, a bare `#`, then a space/tab and the rest. `#1`, `##`, `#foo` don't match. */
const BARE_HASH_HEADING_RE = /^([\t ]*)#([ \t])([\s\S]*)$/;

function isDripnoteDoc(doc) {
	if (!doc || doc.uri.scheme === 'untitled') return false;
	if (doc.languageId === 'dripnote') return true;
	const p = String(doc.uri.fsPath || doc.uri.path || '').toLowerCase();
	return p.endsWith('.d.txt');
}

/** Heading level = number of leading tabs (one tab per level, matching the `#N` marker). */
function levelForIndent(indent) {
	return (String(indent || '').match(/\t/g) || []).length;
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
function registerDripnoteHeadingShorthand(context) {
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(async ev => {
			const doc = ev.document;
			if (!isDripnoteDoc(doc)) return;
			if (isGuardedDocumentEditActive() || isExpectedDiskWrite(doc.uri)) return;

			const editor = vscode.window.visibleTextEditors.find(
				ed => ed.document.uri.toString() === doc.uri.toString()
			);
			if (!editor) return;

			/** @type {{ range: import('vscode').Range, text: string }[]} */
			const edits = [];
			const seenLines = new Set();
			for (const ch of ev.contentChanges || []) {
				for (let line = ch.range.start.line; line <= ch.range.end.line; line++) {
					if (seenLines.has(line)) continue;
					seenLines.add(line);
					const text = doc.lineAt(line).text;
					const m = BARE_HASH_HEADING_RE.exec(text);
					if (!m) continue;
					const level = levelForIndent(m[1]);
					if (level === 0) continue;
					const hashCol = m[1].length;
					edits.push({
						range: new vscode.Range(line, hashCol, line, hashCol + 1),
						text: `#${level}`
					});
				}
			}
			if (!edits.length) return;

			await runGuardedDocumentEdit(async () => {
				await editor.edit(eb => {
					for (const e of edits) eb.replace(e.range, e.text);
				});
			});
		})
	);
}

module.exports = { registerDripnoteHeadingShorthand };
