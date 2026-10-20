'use strict';

const vscode = require('vscode');
const { getDefaultKnowledgeBaseSettingsObject } = require('../../../startup/defaultKnowledgeBaseSettings');

/**
 * Persistent-heading edit mode — mutually exclusive (Settings → Editor radios).
 *
 * @returns {{
 *   editInFile: boolean,
 *   editViaRhs: boolean,
 *   softLockPersistent: boolean,
 *   showRhsForm: boolean
 * }}
 */
function getHeadingEditModes() {
	const defs = getDefaultKnowledgeBaseSettingsObject();
	const c = vscode.workspace.getConfiguration('drip');
	const viaRhsDefault = defs.editHeadingsViaRhs !== false;
	let editViaRhs = !!c.get('editHeadingsViaRhs', viaRhsDefault);
	let editInFile = !!c.get('editHeadingsInFile', defs.editHeadingsInFile === true);
	// Radios: exactly one mode. Prefer RHS if both/neither somehow set.
	if (editViaRhs === editInFile) {
		editViaRhs = viaRhsDefault;
		editInFile = !editViaRhs;
	}
	return {
		editInFile,
		editViaRhs,
		softLockPersistent: editViaRhs,
		showRhsForm: editViaRhs
	};
}

module.exports = {
	getHeadingEditModes
};
