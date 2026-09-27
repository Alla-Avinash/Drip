'use strict';

/**
 * Stamp durable issue id into the heading type prefix as `.i-N` (never renumber).
 * Heading shape: `# .i-12 Fix login` → typePrefix `.i-12`, titleDisplay `Fix login`.
 * Legacy `# .i i-12 Fix` is migrated once to `.i-12`.
 */

const path = require('path');
const {
	parseIssueTitleEntityId,
	parseIssueTypePrefix,
	formatIssueTypePrefix,
	normalizeIssueEntityId,
	formatIssueEntityId
} = require('./projectStructureRules');
const { allocateNextIssueEntityId } = require('./projectEntityIds');
const { isDripProjectFolderName } = require('../model/dripProjectFolder');

/**
 * Project folder prefix for a note under the KB, e.g. `App.p/`.
 * @param {string} kbRootFs
 * @param {string} noteFsPath
 * @returns {string}
 */
function projectFolderPrefixForNote(kbRootFs, noteFsPath) {
	const root = path.normalize(String(kbRootFs || ''));
	const note = path.normalize(String(noteFsPath || ''));
	if (!root || !note) return '';
	const rel = path.relative(root, note).replace(/\\/g, '/');
	if (!rel || rel.startsWith('..')) return '';
	const parts = rel.split('/').filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		if (isDripProjectFolderName(parts[i])) {
			return parts.slice(0, i + 1).join('/') + '/';
		}
	}
	return '';
}

/**
 * Resolve existing issue id from typePrefix and/or legacy titleDisplay.
 * @param {string} typePrefix
 * @param {string} titleDisplay
 * @returns {{ issueId: string, typePrefix: string, titleDisplay: string } | null}
 */
function resolveExistingIssueStamp(typePrefix, titleDisplay) {
	const fromPrefix = parseIssueTypePrefix(typePrefix);
	let rest = String(titleDisplay || '').trim();
	if (fromPrefix) {
		const legacyInTitle = parseIssueTitleEntityId(rest);
		if (legacyInTitle && legacyInTitle.id === fromPrefix) {
			rest = legacyInTitle.rest;
		}
		return {
			issueId: fromPrefix,
			typePrefix: formatIssueTypePrefix(fromPrefix),
			titleDisplay: rest
		};
	}
	const legacy = parseIssueTitleEntityId(rest);
	if (legacy) {
		return {
			issueId: legacy.id,
			typePrefix: formatIssueTypePrefix(legacy.id),
			titleDisplay: legacy.rest
		};
	}
	return null;
}

/**
 * Ensure typePrefix is `.i-N` (allocate once only when bare `.i` / missing).
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} noteFsPath
 * @param {string} typePrefix
 * @param {string} titleDisplay
 * @returns {Promise<{ typePrefix: string, titleDisplay: string, issueId: string, allocated: boolean } | null>}
 */
async function ensureIssueTypePrefixHasEntityId(kbRootUri, noteFsPath, typePrefix, titleDisplay) {
	const existing = resolveExistingIssueStamp(typePrefix, titleDisplay);
	if (existing) {
		return {
			typePrefix: existing.typePrefix,
			titleDisplay: existing.titleDisplay,
			issueId: existing.issueId,
			allocated: false
		};
	}
	const prefix = projectFolderPrefixForNote(kbRootUri.fsPath, noteFsPath);
	if (!prefix) return null;
	const issueId = await allocateNextIssueEntityId(kbRootUri, prefix);
	const tp = formatIssueTypePrefix(issueId);
	if (!tp) return null;
	return {
		typePrefix: tp,
		titleDisplay: String(titleDisplay || '').trim(),
		issueId,
		allocated: true
	};
}

/**
 * @param {string} typePrefix
 * @param {string} [titleDisplay]
 * @returns {string} e.g. i-12 or ''
 */
function peekIssueEntityId(typePrefix, titleDisplay) {
	const existing = resolveExistingIssueStamp(typePrefix, titleDisplay || '');
	return existing ? existing.issueId : '';
}

/** @deprecated Prefer ensureIssueTypePrefixHasEntityId */
async function ensureIssueTitleHasEntityId(kbRootUri, noteFsPath, titleDisplay) {
	return ensureIssueTypePrefixHasEntityId(kbRootUri, noteFsPath, '', titleDisplay);
}

module.exports = {
	projectFolderPrefixForNote,
	resolveExistingIssueStamp,
	ensureIssueTypePrefixHasEntityId,
	ensureIssueTitleHasEntityId,
	peekIssueEntityId,
	normalizeIssueEntityId,
	formatIssueEntityId,
	parseIssueTypePrefix,
	formatIssueTypePrefix
};
