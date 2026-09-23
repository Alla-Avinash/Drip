'use strict';

/**
 * RHS mutual exclusivity for Heading vs Storage.
 *
 * Capture / ingest → Storage only (Heading hidden).
 * Heading soft-lock / edit → Heading only (Storage hidden).
 * Never hide both while the aux bar is open (empty container).
 */

const vscode = require('vscode');
const { DRIP_STORAGE_VIEW_ID } = require('../../shared/constants');

const CTX_HIDE_HEADING = 'drip.rhsHideHeading';
const CTX_HIDE_STORAGE = 'drip.rhsHideStorage';

/**
 * @param {boolean} hideHeading
 * @param {boolean} hideStorage
 */
async function setRhsViewVisibility(hideHeading, hideStorage) {
	await vscode.commands.executeCommand('setContext', CTX_HIDE_HEADING, !!hideHeading);
	await vscode.commands.executeCommand('setContext', CTX_HIDE_STORAGE, !!hideStorage);
}

async function initRhsStorageContexts() {
	await setRhsViewVisibility(false, false);
}

/**
 * Open DRIP secondary sidebar with Storage only (Heading hidden).
 */
async function revealStorageOnly() {
	await setRhsViewVisibility(true, false);
	try {
		await vscode.commands.executeCommand('workbench.view.extension.drip-storage-panel');
	} catch {
		/* ignore */
	}
	try {
		await vscode.commands.executeCommand(`${DRIP_STORAGE_VIEW_ID}.focus`);
	} catch {
		try {
			await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
		} catch {
			/* ignore */
		}
	}
}

/**
 * Prepare for Heading edit: show Heading, hide Storage.
 * Does not open the bar by itself — caller focuses Heading.
 */
async function prepareHeadingOnly() {
	await setRhsViewVisibility(false, true);
}

/**
 * Reset both views to contributed (for teardown / init).
 */
async function resetRhsViewVisibility() {
	await setRhsViewVisibility(false, false);
}

module.exports = {
	CTX_HIDE_HEADING,
	CTX_HIDE_STORAGE,
	initRhsStorageContexts,
	setRhsViewVisibility,
	revealStorageOnly,
	prepareHeadingOnly,
	resetRhsViewVisibility
};
