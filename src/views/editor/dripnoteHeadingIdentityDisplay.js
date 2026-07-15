'use strict';

const vscode = require('vscode');

function registerDripnoteHeadingIdentityDisplay(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand('drip.copyHeadingIdentity', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== 'dripnote') return;
			const lineNo = editor.selection.active.line;
			const lines = editor.document.getText().split(/\r?\n/);
			let identity = '';
			if (/^\s*#{1,6}\s+/.test(String(lines[lineNo] || ''))) {
				for (let j = lineNo - 1; j >= Math.max(0, lineNo - 6); j--) {
					const m = String(lines[j] || '').match(/@+\s*f(\d+)\s*:\s*h(\d+)\b/i);
					if (m) {
						identity = `@f${m[1]}:h${m[2]}`;
						break;
					}
					if (String(lines[j] || '').trim()) break;
				}
				if (!identity) {
					for (let j = lineNo + 1; j < Math.min(lines.length, lineNo + 6); j++) {
						const m = String(lines[j] || '').match(/@+\s*f(\d+)\s*:\s*h(\d+)\b/i);
						if (m) {
							identity = `@f${m[1]}:h${m[2]}`;
							break;
						}
						if (String(lines[j] || '').trim()) break;
					}
				}
			}
			if (!identity) {
				for (let i = lineNo; i >= Math.max(0, lineNo - 12); i--) {
					if (!/^\s*#{1,6}\s+/.test(String(lines[i] || ''))) continue;
					for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
						const m = String(lines[j] || '').match(/@+\s*f(\d+)\s*:\s*h(\d+)\b/i);
						if (m) {
							identity = `@f${m[1]}:h${m[2]}`;
							break;
						}
						if (String(lines[j] || '').trim()) break;
					}
					if (!identity) {
						for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
							const m = String(lines[j] || '').match(/@+\s*f(\d+)\s*:\s*h(\d+)\b/i);
							if (m) {
								identity = `@f${m[1]}:h${m[2]}`;
								break;
							}
							if (String(lines[j] || '').trim()) break;
						}
					}
					break;
				}
			}
			if (!identity) {
				void vscode.window.showWarningMessage('No heading identity found for this heading.');
				return;
			}
			await vscode.env.clipboard.writeText(identity);
			void vscode.window.setStatusBarMessage(`Copied ${identity}`, 3000);
		})
	);
}

module.exports = { registerDripnoteHeadingIdentityDisplay };
