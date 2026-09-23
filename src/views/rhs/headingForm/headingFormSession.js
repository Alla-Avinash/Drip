'use strict';

/**
 * RHS Heading form session: which note/heading is bound, open/close auxiliary bar.
 * Soft-lock and Apply call into this — keep UI chrome here, not in edit logic.
 */

const vscode = require('vscode');
const { DRIP_HEADING_FORM_VIEW_ID } = require('../../../shared/constants');

/** @type {import('vscode').WebviewView | undefined} */
let view;
/** @type {import('vscode').Webview | undefined} */
let webview;
/** @type {{ uri: string, headingLine: number, identityText: string } | null} */
let bound = null;
/** @type {object | null} message queued until the webview resolves */
let pendingMessage = null;
/** Suppress selection-close right after open/apply. */
let suppressCloseUntil = 0;

function getWebview() {
	return webview;
}

function getBound() {
	return bound;
}

function setBound(next) {
	bound = next;
}

function attachView(webviewView) {
	view = webviewView;
	webview = webviewView.webview;
	webviewView.onDidDispose(() => {
		if (view === webviewView) {
			view = undefined;
			webview = undefined;
			bound = null;
			pendingMessage = null;
		}
	});
}

/**
 * Re-send any queued load after the webview script boots (`headingFormReady`).
 */
function flushPendingMessage() {
	if (!webview || !pendingMessage) return;
	const msg = pendingMessage;
	pendingMessage = null;
	void webview.postMessage(msg);
}

/**
 * Wait until resolveWebviewView has attached (first open of auxiliary bar).
 * @param {number} [ms]
 * @returns {Promise<boolean>}
 */
async function waitForWebview(ms = 2000) {
	if (webview) return true;
	const deadline = Date.now() + Math.max(0, Number(ms) || 0);
	while (!webview && Date.now() < deadline) {
		await new Promise(r => setTimeout(r, 40));
	}
	return !!webview;
}

function markOpened() {
	suppressCloseUntil = Date.now() + 2000;
}

function shouldSuppressClose() {
	return Date.now() < suppressCloseUntil;
}

/**
 * Show secondary sidebar with Heading view.
 * Prefer preserveFocus so the editor caret stays put; restore editor after focus fallback.
 */
async function openHeadingSidebar() {
	markOpened();
	const editor = vscode.window.activeTextEditor;
	const caret = editor ? editor.selection.active : null;
	try {
		const { prepareHeadingOnly } = require('../revealStorageOnly');
		await prepareHeadingOnly();
	} catch {
		/* ignore */
	}
	try {
		await vscode.commands.executeCommand('workbench.view.extension.drip-storage-panel');
	} catch {
		/* ignore */
	}
	try {
		if (view && typeof view.show === 'function') {
			view.show(true);
		} else {
			// First open: view not resolved yet — this may steal focus briefly.
			await vscode.commands.executeCommand(`${DRIP_HEADING_FORM_VIEW_ID}.focus`);
		}
	} catch {
		try {
			await vscode.commands.executeCommand(`${DRIP_HEADING_FORM_VIEW_ID}.focus`);
		} catch {
			/* ignore */
		}
	}
	await waitForWebview(1500);
	// Put caret back in the note so soft-lock / typing feel stable.
	if (editor && caret) {
		try {
			await vscode.window.showTextDocument(editor.document, {
				viewColumn: editor.viewColumn,
				preserveFocus: false,
				selection: new vscode.Selection(caret, caret)
			});
		} catch {
			/* ignore */
		}
	}
	markOpened();
}

async function closeHeadingSidebar() {
	bound = null;
	if (webview) {
		try {
			await webview.postMessage({ type: 'headingFormClear' });
		} catch {
			/* ignore */
		}
	}
	try {
		const { resetRhsViewVisibility } = require('../revealStorageOnly');
		await resetRhsViewVisibility();
	} catch {
		/* ignore */
	}
	try {
		await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
	} catch {
		/* ignore */
	}
}

async function postToForm(message) {
	// Always keep the latest load/clear as pending so a late `headingFormReady` can replay it.
	if (
		message &&
		(message.type === 'headingFormLoad' || message.type === 'headingFormClear')
	) {
		pendingMessage = message;
	}
	if (!webview) return;
	await webview.postMessage(message);
}

function isViewVisible() {
	return !!(view && view.visible !== false);
}

module.exports = {
	attachView,
	getWebview,
	getBound,
	setBound,
	markOpened,
	shouldSuppressClose,
	openHeadingSidebar,
	closeHeadingSidebar,
	postToForm,
	waitForWebview,
	flushPendingMessage,
	isViewVisible
};
