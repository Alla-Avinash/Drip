'use strict';

/**
 * Unified note lifecycle — the single entry point for both note formats.
 *
 * `.d.txt` and `.d.md` notes now share one lifecycle *driver*: format detection and the
 * open / save / close / delete wiring both start from here. The format-specific reconcile
 * algorithms live in their own modules and are dispatched by format, because the two
 * formats genuinely differ on disk (`.d.txt` uses `@hN` identity lines and a
 * `filename:`/`fileid:`/`headings:` header; `.d.md` uses hidden `<!-- drip … -->`
 * comments).
 *
 * Both drivers already follow the same buffer-first rule, which this module documents as
 * the one shared contract: reconcile edits are applied through the editor buffer (or folded
 * into the save via `onWillSaveTextDocument.waitUntil`), never a blind disk write while a
 * tab is open; a straight disk write happens only on close, when the tab is gone.
 */

const { noteFormatForPath } = require('../../../document/model/dripNoteFileTypes.js');
const { registerDripnoteIndexSync } = require('../../dripTxt/dripTxtIndexSync.js');
const { registerDripMdNoteIndexSync } = require('../dripMd/dripMdNoteSync.js');

/**
 * Coarse note kind for a path, used to dispatch lifecycle work to the right format.
 * @param {string} fsPath
 * @returns {'drip-txt' | 'drip-md' | 'other'}
 */
function noteKindForPath(fsPath) {
	const format = noteFormatForPath(fsPath);
	if (format === 'drip-md') return 'drip-md';
	if (format === 'drip-txt') return 'drip-txt';
	return 'other';
}

/**
 * Wire both note formats' lifecycle drivers in one call. This is the single registration
 * the extension host runs — everything about keeping a note reconciled and indexed, for
 * either format, lives behind this one entry point.
 *
 * @param {import('vscode').ExtensionContext} context
 * @param {{ getKnowledgeBaseRoot: () => import('vscode').Uri | undefined, getVerifiedKnowledgeBaseRoot: () => import('vscode').Uri | undefined }} state
 */
function registerNoteLifecycle(context, state) {
	registerDripnoteIndexSync(context, state);
	registerDripMdNoteIndexSync(context, state);
}

module.exports = {
	noteKindForPath,
	registerNoteLifecycle
};
