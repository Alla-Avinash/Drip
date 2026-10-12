'use strict';

const vscode = require('vscode');
const { tokenizeDripnote } = require('./dripnoteColoringTokens');

// Theme-palette base coloring. Each role maps (in package.json `semanticTokenScopes`) to a
// textmate scope, so colors follow the active light/dark theme — no hardcoded hex. The
// `declaration` modifier marks headings/markers bold. Doc Coloring custom colors (if any)
// are layered on top by the decoration pass in dripnoteCustomDecorations.js.
const tokenTypes = ['metatype', 'heading', 'metakey', 'relationkey', 'metavalue', 'fileidentity', 'identityvalue', 'typedvalue', 'relationvalue'];
const tokenModifiers = ['declaration'];
const legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

const ROLE_TO_TYPE = {
	type: 'metatype',
	heading: 'heading',
	metakey: 'metakey',
	relationkey: 'relationkey',
	metavalue: 'metavalue',
	fileidentity: 'fileidentity',
	identityvalue: 'identityvalue',
	typedvalue: 'typedvalue',
	relationvalue: 'relationvalue'
};

function typeIndex(name) {
	return tokenTypes.indexOf(name);
}

function declarationBitmask() {
	return 1 << tokenModifiers.indexOf('declaration');
}

function registerDripnoteSemanticTokens(context) {
	const emitter = new vscode.EventEmitter();
	const provider = {
		onDidChangeSemanticTokens: emitter.event,
		/**
		 * @param {import('vscode').TextDocument} document
		 * @returns {import('vscode').SemanticTokens}
		 */
		provideDocumentSemanticTokens(document) {
			if (document.languageId !== 'dripnote') {
				return new vscode.SemanticTokensBuilder(legend).build();
			}
			const builder = new vscode.SemanticTokensBuilder(legend);
			const tokens = tokenizeDripnote(document.getText().split(/\r?\n/));
			for (const t of tokens) {
				const typeName = ROLE_TO_TYPE[t.role];
				if (!typeName) continue;
				builder.push(
					t.line,
					t.start,
					t.length,
					typeIndex(typeName),
					t.bold ? declarationBitmask() : 0
				);
			}
			return builder.build();
		}
	};

	context.subscriptions.push(
		vscode.languages.registerDocumentSemanticTokensProvider({ language: 'dripnote' }, provider, legend)
	);
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('drip')) emitter.fire();
		})
	);
	context.subscriptions.push(emitter);
}

module.exports = {
	registerDripnoteSemanticTokens
};
