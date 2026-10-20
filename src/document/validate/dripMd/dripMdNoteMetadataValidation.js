'use strict';

/**
 * One-time metadata validation for `.d.md` notes.
 *
 * The chip UI can only ever write valid enum/datetime/duration values, so invalid
 * values only appear when a note is hand-edited in a plain text editor. This hook
 * sweeps each `.d.md` note once — the first time it is opened in a session
 * (including tabs restored from a previous session) — and drops invalid keys/values
 * straight out of the comment, leaving everything else untouched.
 *
 * It is deliberately separate from the `.d.txt` heading-identity logic and never
 * touches the database.
 */

const vscode = require('vscode');
const { parseMarkdownHeading } = require('../../parse/dripMd/dripMdHeadingParse.js');
const { isHeadingComment, validateHeadingComment } = require('../../model/dripMd/dripMdNoteComment.js');
const { knownTagsLowerForNote } = require('../../../graph/noteTagScope');

/** Any `<!-- drip … -->` comment — heading metadata, the file header, or a stray/legacy one. */
const DRIP_COMMENT_RE = /^<!--\s*drip\b/i;
/** The `<!-- drip-file … -->` file-level identity block (rendered as a banner). */
const FILE_HEADER_COMMENT_RE = /^<!--\s*drip-file\b/i;

/**
 * @param {import('vscode').TextDocument} document
 * @returns {boolean}
 */
function isDripMdNoteDocument(document) {
	if (!document || document.uri.scheme !== 'file') return false;
	return String(document.uri.fsPath || '').toLowerCase().endsWith('.d.md');
}

/** True when a heading line appears anywhere before `idx`. */
function hasHeadingBefore(lines, idx) {
	for (let j = 0; j < idx; j++) {
		if (parseMarkdownHeading(lines[j])) return true;
	}
	return false;
}

/**
 * @param {import('vscode').TextDocument} document
 * @param {import('vscode').ExtensionContext} context
 * @returns {Promise<void>}
 */
async function validateDocumentOnce(document, context) {
	const lines = document.getText().split(/\r?\n/);

	// Tags valid for this note's graph (project graph or all KB graphs) — used to drop
	// stale tags from `tags: [...]` fields below.
	const knownTagsLower = await knownTagsLowerForNote(context, document.uri.fsPath);

	// Pass 1: find orphaned drip comments. A `<!-- drip-file … -->` header is legitimate
	// only when it sits before the first heading (the top of the file); every other drip
	// comment must sit directly under a heading line. Anything else is stray and removed.
	/** @type {number[]} */
	const orphanLines = [];
	for (let i = 0; i < lines.length; i++) {
		const trimmed = String(lines[i] || '').trim();
		if (!DRIP_COMMENT_RE.test(trimmed)) continue;
		if (FILE_HEADER_COMMENT_RE.test(trimmed) && !hasHeadingBefore(lines, i)) continue;
		if (i > 0 && parseMarkdownHeading(lines[i - 1])) continue;
		orphanLines.push(i);
	}
	const orphanSet = new Set(orphanLines);

	// Pass 2: validate each heading comment against its own type (skip orphaned ones —
	// they're removed entirely rather than rewritten).
	/** @type {{ line: number, text: string }[]} */
	const edits = [];
	for (let i = 0; i < lines.length; i++) {
		if (!parseMarkdownHeading(lines[i])) continue;
		// The comment sits immediately below its heading line.
		const commentLine = i + 1;
		if (commentLine >= lines.length) continue;
		if (orphanSet.has(commentLine)) continue;
		if (!isHeadingComment(lines[commentLine])) continue;

		const result = validateHeadingComment(lines[commentLine], knownTagsLower);
		if (result.text == null || !result.changed) continue;
		edits.push({ line: commentLine, text: result.text });
	}

	if (!edits.length && !orphanLines.length) return;

	const edit = new vscode.WorkspaceEdit();
	for (const e of edits) {
		edit.replace(document.uri, document.lineAt(e.line).range, e.text);
	}
	// Delete orphan lines bottom-up so earlier line indices stay valid.
	for (let i = orphanLines.length - 1; i >= 0; i--) {
		edit.delete(document.uri, document.lineAt(orphanLines[i]).rangeIncludingLineBreak);
	}
	await vscode.workspace.applyEdit(edit);
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
function registerDripMdNoteMetadataValidation(context) {
	/** Validated once per session — reopening a note doesn't re-sweep it. */
	const validated = new Set();

	/** @param {import('vscode').TextDocument} document */
	const validateOnce = async document => {
		if (!isDripMdNoteDocument(document)) return;
		const key = document.uri.toString();
		if (validated.has(key)) return;
		validated.add(key);
		try {
			await validateDocumentOnce(document, context);
		} catch (err) {
			console.error('[DRIP] .d.md first-open validation failed', err);
		}
	};

	// Tabs restored from a previous session are already in textDocuments on activate.
	for (const doc of vscode.workspace.textDocuments) {
		void validateOnce(doc);
	}
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(doc => {
			void validateOnce(doc);
		})
	);
}

module.exports = { registerDripMdNoteMetadataValidation };
