'use strict';

/**
 * Soft-lock for persistent headings when Settings → Editor = RHS mode.
 *
 * Rules (only these):
 * 1. Plain `# Heading` (non-persistent) — never soft-lock, never open RHS.
 * 2. Typing space that completes `# .c ` / `# . ` / etc. — allow, open RHS.
 * 3. Edit inside a ready persistent title/meta line — undo, keep caret, open RHS.
 * 4. Bulk paste adding persistent headings — confirm Keep/Undo.
 * 5. Bulk delete of 2+ persistent headings — confirm Delete/Undo.
 */

const vscode = require('vscode');
const { getHeadingEditModes } = require('../../document/model/headingEditModes');
const {
	findPersistentZoneAtLine,
	findPersistentHeadingZones,
	countPersistentHeadings,
	isPersistentHeadingReadyForRhs
} = require('../../document/model/persistentHeadingZones');
const { classifyPersistentHeadingTitle } = require('../../document/model/dripnotePersistentHeading');
const { getMetadataSettings, getMetadataSettingsForNotePath } = require('../../document/model/dripnoteMetadataTemplates');
const {
	revealDripHeadingFormView,
	syncHeadingFormFromEditor,
	isHeadingFormApplyActive
} = require('../rhs/headingForm/panel');
const {
	runGuardedDocumentEdit,
	isGuardedDocumentEditActive,
	isExpectedDiskWrite
} = require('../../shared/documentEditGuard');
const { parseHeadingForValidation } = require('../../document/parse/dripnoteCanvasParse');

/** @type {Map<string, string>} */
const lastTextByUri = new Map();

function isDripnoteDoc(doc) {
	if (!doc || doc.uri.scheme === 'untitled') return false;
	if (doc.languageId === 'dripnote') return true;
	const p = String(doc.uri.fsPath || doc.uri.path || '').toLowerCase();
	return p.endsWith('.d.txt');
}

function restoreCursor(editor, pos) {
	const doc = editor.document;
	const line = Math.min(Math.max(0, pos.line), Math.max(0, doc.lineCount - 1));
	const col = Math.min(Math.max(0, pos.character), doc.lineAt(line).text.length);
	const p = new vscode.Position(line, col);
	editor.selection = new vscode.Selection(p, p);
}

function changeTouchesZone(zone, ch) {
	return zone.lockStart <= ch.range.end.line && ch.range.start.line < zone.lockEndExclusive;
}

/**
 * Allow Enter at the very end of the last soft-locked line (heading or last meta line)
 * so the user can start a blank body line without editing metadata.
 * Prefer keeping editor auto-indent; if the insert is a bare newline, copy the previous line's indent.
 * @param {{ lockStart: number, lockEndExclusive: number }} zone
 * @param {{ range: import('vscode').Range, text: string, rangeLength?: number }} ch
 * @param {string} beforeText
 */
function isEnterAtEndOfLock(zone, ch, beforeText) {
	const text = String(ch.text || '');
	// Pure newline, or newline + leading indent only (editor.autoIndent — keep it).
	if (!/^(\r\n|\n)[\t ]*$/.test(text)) return false;
	const rangeLen = typeof ch.rangeLength === 'number' ? ch.rangeLength : 0;
	if (rangeLen > 0) return false;
	const lastLine = zone.lockEndExclusive - 1;
	if (lastLine < zone.lockStart) return false;
	if (ch.range.start.line !== lastLine || ch.range.end.line !== lastLine) return false;
	const lines = String(beforeText || '').replace(/\r\n/g, '\n').split('\n');
	const lineText = lines[lastLine] || '';
	return ch.range.start.character >= lineText.length;
}

/**
 * Leading tabs/spaces on a line.
 * @param {string} lineText
 */
function leadingIndentOf(lineText) {
	return (/^[\t ]*/.exec(String(lineText || '')) || [''])[0];
}

/**
 * After a bare Enter at end-of-lock, ensure the new line matches the previous line's indent.
 * @param {import('vscode').TextEditor} editor
 * @param {number} prevLineIndex line that was at the end of the lock (before Enter)
 */
async function ensureNewLineMatchesPrevIndent(editor, prevLineIndex) {
	if (!editor || prevLineIndex < 0) return;
	const doc = editor.document;
	const blankLineIndex = prevLineIndex + 1;
	if (blankLineIndex >= doc.lineCount) return;
	const prevIndent = leadingIndentOf(doc.lineAt(prevLineIndex).text);
	const blankLine = doc.lineAt(blankLineIndex);
	if (blankLine.text === prevIndent) {
		const end = new vscode.Position(blankLineIndex, prevIndent.length);
		editor.selection = new vscode.Selection(end, end);
		return;
	}
	// Only adjust empty / whitespace-only new lines (don't touch real body text).
	if (blankLine.text.length && !/^[\t ]+$/.test(blankLine.text)) return;
	await editor.edit(eb => {
		eb.replace(blankLine.range, prevIndent);
	});
	const end = new vscode.Position(blankLineIndex, prevIndent.length);
	editor.selection = new vscode.Selection(end, end);
}

/**
 * Tab / Shift+Tab (or equivalent) that only adds/removes leading whitespace —
 * hierarchy edits must not be soft-locked.
 * @param {readonly { range: import('vscode').Range, text: string }[]} changes
 * @param {string} beforeText
 */
function isIndentOrOutdentOnlyChange(changes, beforeText) {
	if (!changes.length) return false;
	const lines = String(beforeText || '').replace(/\r\n/g, '\n').split('\n');
	for (const ch of changes) {
		const startLine = ch.range.start.line;
		const endLine = ch.range.end.line;
		const inserted = String(ch.text || '');

		// Common case: one change per line at the start of leading whitespace.
		if (startLine === endLine) {
			const lineText = lines[startLine] || '';
			const start = ch.range.start.character;
			const end = ch.range.end.character;
			const deleted = lineText.slice(start, end);
			const leadingWsLen = leadingIndentOf(lineText).length;

			// Indent: insert only whitespace into the leading-indent region (usually at col 0).
			if (/^[\t ]+$/.test(inserted) && start <= leadingWsLen && /^[\t ]*$/.test(deleted)) {
				continue;
			}
			// Outdent: delete only leading whitespace.
			if (
				inserted === '' &&
				start < leadingWsLen &&
				end <= leadingWsLen &&
				/^[\t ]+$/.test(deleted)
			) {
				continue;
			}
			// Whole-line rewrite that only changes leading whitespace.
			if (start === 0 && end === lineText.length) {
				const oldCore = lineText.replace(/^[\t ]*/, '');
				const newCore = inserted.replace(/^[\t ]*/, '');
				if (oldCore === newCore && oldCore.length > 0) {
					continue;
				}
				if (oldCore === newCore && oldCore.length === 0 && /^[\t ]*$/.test(inserted)) {
					continue;
				}
			}
			return false;
		}

		// Multi-line replace: each corresponding line may only differ by leading whitespace.
		const beforeSlice = lines.slice(startLine, endLine + 1);
		// If the change doesn't start at col 0 / end at EOL, it's not a pure indent op.
		const lastLine = lines[endLine] || '';
		if (ch.range.start.character !== 0) return false;
		if (ch.range.end.character !== lastLine.length) return false;
		const afterSlice = inserted.replace(/\r\n/g, '\n').split('\n');
		if (afterSlice.length !== beforeSlice.length) return false;
		for (let i = 0; i < beforeSlice.length; i++) {
			const oldCore = String(beforeSlice[i] || '').replace(/^[\t ]*/, '');
			const newCore = String(afterSlice[i] || '').replace(/^[\t ]*/, '');
			if (oldCore !== newCore) return false;
		}
	}
	return true;
}

function isBulkLikeChange(changes) {
	if (changes.length > 1) return true;
	const ch = changes[0];
	if (!ch) return false;
	const t = String(ch.text || '');
	if (t.length > 80) return true;
	if (/#\s*\./.test(t) && t.includes('\n')) return true;
	// Multi-line delete / replace (empty or short replacement over a span).
	if (ch.range.end.line > ch.range.start.line) return true;
	const rangeLen = typeof ch.rangeLength === 'number' ? ch.rangeLength : 0;
	if (rangeLen > 80) return true;
	return false;
}

function titleAtLine(text, line) {
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	const ph = parseHeadingForValidation(lines[line] || '');
	return ph ? ph.title : '';
}

/**
 * @param {string} title
 */
function isPersistentTitle(title) {
	return classifyPersistentHeadingTitle(title, getMetadataSettings()).persistent;
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
function registerPersistentHeadingSoftLock(context) {
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(doc => {
			if (isDripnoteDoc(doc)) lastTextByUri.set(doc.uri.toString(), doc.getText());
		}),
		vscode.workspace.onDidCloseTextDocument(doc => {
			lastTextByUri.delete(doc.uri.toString());
		}),
		vscode.window.onDidChangeActiveTextEditor(ed => {
			if (ed && isDripnoteDoc(ed.document)) {
				lastTextByUri.set(ed.document.uri.toString(), ed.document.getText());
			}
		})
	);

	for (const doc of vscode.workspace.textDocuments) {
		if (isDripnoteDoc(doc)) lastTextByUri.set(doc.uri.toString(), doc.getText());
	}

	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(async ev => {
			const doc = ev.document;
			if (!isDripnoteDoc(doc)) return;
			const key = doc.uri.toString();
			const after = doc.getText();
			const before = lastTextByUri.has(key) ? lastTextByUri.get(key) : after;
			const changes = ev.contentChanges || [];

			if (isGuardedDocumentEditActive() || isHeadingFormApplyActive() || isExpectedDiskWrite(doc.uri)) {
				lastTextByUri.set(key, after);
				return;
			}

			const modes = getHeadingEditModes();
			if (!modes.showRhsForm) {
				lastTextByUri.set(key, after);
				return;
			}

			const editor = vscode.window.visibleTextEditors.find(ed => ed.document.uri.toString() === key);
			const caret = editor ? editor.selection.active : null;
			const noteSettings = getMetadataSettingsForNotePath(doc.uri.fsPath);

			const beforeCount = countPersistentHeadings(before || '', noteSettings);
			const afterCount = countPersistentHeadings(after, noteSettings);
			const added = afterCount - beforeCount;
			const removed = beforeCount - afterCount;

			// Bulk delete of 2+ persistent headings
			if (changes.length && removed >= 2 && isBulkLikeChange(changes)) {
				const pick = await vscode.window.showWarningMessage(
					`DRIP: ${removed} persistent heading(s) were deleted (bulk). Confirm delete?`,
					{ modal: true },
					'Delete',
					'Undo'
				);
				if (pick !== 'Delete') {
					await runGuardedDocumentEdit(async () => {
						await vscode.commands.executeCommand('undo');
					});
					lastTextByUri.set(key, doc.getText());
					return;
				}
				lastTextByUri.set(key, after);
				return;
			}

			// Bulk paste of persistent headings
			if (changes.length && added > 0 && isBulkLikeChange(changes)) {
				const pick = await vscode.window.showWarningMessage(
					`DRIP: ${added} new persistent heading(s) were added (paste/bulk). Keep them?`,
					{ modal: true },
					'Keep',
					'Undo'
				);
				if (pick !== 'Keep') {
					await runGuardedDocumentEdit(async () => {
						await vscode.commands.executeCommand('undo');
					});
					lastTextByUri.set(key, doc.getText());
					return;
				}
				lastTextByUri.set(key, after);
				if (editor) {
					const z = findPersistentZoneAtLine(after, editor.selection.active.line, noteSettings);
					if (z && z.persistent && z.readyForRhs) {
						await syncHeadingFormFromEditor(editor, z.headingLine, { reveal: true });
					}
				}
				return;
			}

			// Complete persistent prefix with a space → open RHS (never for plain headings).
			if (changes.length === 1) {
				const ch = changes[0];
				if (String(ch.text || '') === ' ' || /\s$/.test(String(ch.text || ''))) {
					const line = ch.range.start.line;
					const linesAfter = after.replace(/\r\n/g, '\n').split('\n');
					const linesBefore = String(before || '')
						.replace(/\r\n/g, '\n')
						.split('\n');
					const lineAfter = linesAfter[line] || '';
					const lineBefore = linesBefore[line] || '';
					const titleAfter = titleAtLine(after, line);
					if (
						isPersistentTitle(titleAfter) &&
						isPersistentHeadingReadyForRhs(lineAfter) &&
						!isPersistentHeadingReadyForRhs(lineBefore)
					) {
						lastTextByUri.set(key, after);
						if (editor) {
							if (caret) restoreCursor(editor, caret);
							await syncHeadingFormFromEditor(editor, line, { reveal: true });
						} else {
							await revealDripHeadingFormView();
						}
						return;
					}
				}
			}

			// Soft-lock ready persistent zones only
			if (modes.softLockPersistent && changes.length) {
				const zonesBefore = findPersistentHeadingZones(before || '', noteSettings).filter(
					z => z.persistent && z.readyForRhs
				);
				let hit = null;
				for (const ch of changes) {
					for (const z of zonesBefore) {
						if (changeTouchesZone(z, ch)) {
							// Only if the change is on heading / identity / structured meta — not blanks.
							const zHit = findPersistentZoneAtLine(before || '', ch.range.start.line, noteSettings);
							if (zHit && zHit.headingLine === z.headingLine) {
								hit = z;
								break;
							}
						}
					}
					if (hit) break;
					const zNow = findPersistentZoneAtLine(after, ch.range.start.line, noteSettings);
					if (zNow && zNow.persistent && zNow.readyForRhs) {
						hit = zNow;
						break;
					}
				}
				if (hit) {
					const ch0 = changes[0];
					const zoneForEnter =
						zonesBefore.find(z => z.headingLine === hit.headingLine) || hit;
					if (isIndentOrOutdentOnlyChange(changes, before || '')) {
						lastTextByUri.set(key, after);
						return;
					}
					if (
						changes.length === 1 &&
						ch0 &&
						isEnterAtEndOfLock(zoneForEnter, ch0, before || '')
					) {
						if (editor) {
							await runGuardedDocumentEdit(async () => {
								await ensureNewLineMatchesPrevIndent(
									editor,
									zoneForEnter.lockEndExclusive - 1
								);
							});
						}
						lastTextByUri.set(key, doc.getText());
						return;
					}
					const restorePos = caret || (changes[0] && changes[0].range.start);
					await runGuardedDocumentEdit(async () => {
						await vscode.commands.executeCommand('undo');
					});
					lastTextByUri.set(key, doc.getText());
					if (editor) {
						if (restorePos) restoreCursor(editor, restorePos);
						await syncHeadingFormFromEditor(editor, hit.headingLine, { reveal: true });
					} else {
						await revealDripHeadingFormView();
					}
					return;
				}
			}

			lastTextByUri.set(key, after);
		})
	);
}

module.exports = {
	registerPersistentHeadingSoftLock
};
