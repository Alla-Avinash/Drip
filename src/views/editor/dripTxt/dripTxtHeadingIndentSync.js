'use strict';

/**
 * Keep `.d.txt` heading markers in sync with their leading-tab indent on Tab / Shift+Tab.
 *
 * The marker number mirrors the leading-tab count (`#` = root, `\t#1` = level 1, `\t\t#2` = 2),
 * so indenting/outdenting a line (or a whole selection) must also move the marker: Tab on `#1`
 * makes `#2`, Shift+Tab on `#1` makes `#`. Bare `# ` headings are left to the shorthand handler,
 * which already upgrades them from their indent when typed.
 */

const vscode = require('vscode');
const {
	runGuardedDocumentEdit,
	isGuardedDocumentEditActive,
	isExpectedDiskWrite
} = require('../../../shared/documentEditGuard');

/** Numbered heading only: leading tabs, `#`, then digits, then whitespace. */
const NUMBERED_HEADING_RE = /^(\t*)#(\d+)\s+/;

function isDripnoteDoc(doc) {
	if (!doc || doc.uri.scheme === 'untitled') return false;
	if (doc.languageId === 'dripnote') return true;
	const p = String(doc.uri.fsPath || doc.uri.path || '').toLowerCase();
	return p.endsWith('.d.txt');
}

function registerDripnoteHeadingIndentSync(context) {
	/** @type {Map<string, string>} */
	const lastTextByUri = new Map();

	function remember(doc) {
		if (isDripnoteDoc(doc)) lastTextByUri.set(doc.uri.toString(), doc.getText());
	}

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(remember),
		vscode.workspace.onDidCloseTextDocument(doc => lastTextByUri.delete(doc.uri.toString()))
	);
	for (const doc of vscode.workspace.textDocuments) remember(doc);

	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(async ev => {
			const doc = ev.document;
			if (!isDripnoteDoc(doc)) return;
			if (isGuardedDocumentEditActive() || isExpectedDiskWrite(doc.uri)) {
				remember(doc);
				return;
			}

			const key = doc.uri.toString();
			const before = lastTextByUri.has(key) ? lastTextByUri.get(key) : doc.getText();
			const after = doc.getText();
			lastTextByUri.set(key, after);

			const editor = vscode.window.visibleTextEditors.find(
				ed => ed.document.uri.toString() === key
			);
			if (!editor) return;

			const beforeLines = String(before).replace(/\r\n/g, '\n').split('\n');
			const afterLines = after.replace(/\r\n/g, '\n').split('\n');

			/** @type {{ range: import('vscode').Range, text: string }[]} */
			const edits = [];
			const seen = new Set();
			for (const ch of ev.contentChanges || []) {
				for (let line = ch.range.start.line; line <= ch.range.end.line; line++) {
					if (seen.has(line)) continue;
					seen.add(line);
					const b = String(beforeLines[line] || '');
					const a = String(afterLines[line] || '');
					// React only when the line changed and only its leading tabs differ —
					// that is an indent/outdent, not a title or body edit.
					if (b.replace(/^\t*/, '') !== a.replace(/^\t*/, '')) continue;
					const m = NUMBERED_HEADING_RE.exec(a);
					if (!m) continue;
					const tabs = m[1].length;
					const want = tabs === 0 ? '#' : `#${tabs}`;
					const cur = `#${m[2]}`;
					if (want === cur) continue;
					const start = m[1].length;
					edits.push({
						range: new vscode.Range(line, start, line, start + cur.length),
						text: want
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

module.exports = { registerDripnoteHeadingIndentSync };
