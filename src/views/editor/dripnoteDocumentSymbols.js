'use strict';

const vscode = require('vscode');
const { splitFileHeaderAndBody, parseType1HeadingRecords } = require('../../document/kbNoteOps');

/**
 * Registers outline symbols for `#` headings (tabs + `#` nesting). Enables the
 * editor Outline view and Sticky Scroll when using the outline model.
 * @param {import('vscode').ExtensionContext} context
 */
function registerDripnoteDocumentSymbols(context) {
	const provider = {
		/**
		 * @param {import('vscode').TextDocument} document
		 * @param {import('vscode').CancellationToken} _token
		 * @returns {import('vscode').DocumentSymbol[] | undefined}
		 */
		provideDocumentSymbols(document, _token) {
			if (document.languageId !== 'dripnote') {
				return undefined;
			}
			const { body, bodyStartLine } = splitFileHeaderAndBody(document.getText());
			const { headings } = parseType1HeadingRecords(body);
			if (!headings.length) {
				return [];
			}

			/** @type {import('vscode').DocumentSymbol[]} */
			const root = [];
			/** @type {{ symbol: import('vscode').DocumentSymbol; level: number }[]} */
			const stack = [];

			for (const h of headings) {
				const docLine = bodyStartLine + h.line;
				if (docLine < 0 || docLine >= document.lineCount) {
					continue;
				}
				const line = document.lineAt(docLine);
				const sym = new vscode.DocumentSymbol(
					h.title,
					'',
					vscode.SymbolKind.String,
					line.range,
					line.range
				);
				sym.children = [];

				while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
					stack.pop();
				}
				if (stack.length === 0) {
					root.push(sym);
				} else {
					stack[stack.length - 1].symbol.children.push(sym);
				}
				stack.push({ symbol: sym, level: h.level });
			}

			return root;
		}
	};

	context.subscriptions.push(
		vscode.languages.registerDocumentSymbolProvider({ language: 'dripnote' }, provider)
	);
}

module.exports = {
	registerDripnoteDocumentSymbols
};
