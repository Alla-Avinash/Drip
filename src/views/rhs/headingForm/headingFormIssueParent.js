'use strict';

/**
 * RHS "Parent issue" field: allowed choices + apply-time validation.
 * Rules live in `src/document/project/issueParentLink.js`.
 */

const path = require('path');
const { getHeadingFormKbRoot } = require('./headingFormKb');
const { getMetadataSettingsForNotePath } = require('../../../document/model/dripNoteMetadataTemplates.js');
const { findPersistentHeadingZones } = require('../../../document/model/dripTxt/dripTxtPersistentHeadingZones.js');
const {
	issueIdFromHeadingTitle,
	findNearestOutlineAncestorIssueId,
	collectSelfAndDescendants,
	validateIssueParentChoice
} = require('../../../document/project/issueParentLink');
const {
	normalizeIssueEntityId,
	parseIssueTitleEntityId,
	parseIssueTypePrefix
} = require('../../../document/project/projectStructureRules');

/**
 * @param {string} key
 * @returns {number}
 */
function issueNumber(key) {
	const m = String(key || '').match(/^i-(\d+)$/i);
	return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * @param {import('vscode').TextDocument} doc
 * @param {number} headingLine
 * @param {string | null} selfKey
 * @returns {Promise<{
 *   locked: boolean,
 *   lockedParent: string | null,
 *   currentParent: string,
 *   options: { key: string, title: string, where: string }[],
 *   projectIssues: { issueKey: string, title: string, path: string, parentIssueKey: string | null }[]
 * }>}
 */
async function loadIssueParentContext(doc, headingLine, selfKey) {
	const text = doc.getText();
	const self = normalizeIssueEntityId(selfKey || '');
	const lockedParent = findNearestOutlineAncestorIssueId(text, headingLine);
	const kbRoot = getHeadingFormKbRoot();
	const relPath = kbRoot
		? path.relative(kbRoot.fsPath, doc.uri.fsPath).replace(/\\/g, '/')
		: '';
	let prefix = '';
	if (kbRoot) {
		const { projectFolderPrefixForNote } = require('../../../document/project/issueEntityIdStamp');
		prefix = projectFolderPrefixForNote(kbRoot.fsPath, doc.uri.fsPath);
	}

	// Current file from the live buffer (may be unsaved); other files from the index.
	/** @type {{ issueKey: string, title: string, path: string, parentIssueKey: string | null }[]} */
	const bufferIssues = [];
	let currentParent = '';
	const settings = getMetadataSettingsForNotePath(doc.uri.fsPath);
	for (const z of findPersistentHeadingZones(text, settings)) {
		if (z.typeId !== 'issue') continue;
		const key = issueIdFromHeadingTitle(z.titleRaw);
		if (!key) continue;
		const lock = findNearestOutlineAncestorIssueId(text, z.headingLine);
		const declared = normalizeIssueEntityId(String((z.attributes && z.attributes.parent) || ''));
		const parentIssueKey = lock || declared || null;
		if (key === self) currentParent = parentIssueKey || '';
		bufferIssues.push({ issueKey: key, title: z.titleDisplay || '', path: relPath, parentIssueKey });
	}

	/** @type {{ issueKey: string, title: string, path: string, parentIssueKey: string | null }[]} */
	let indexIssues = [];
	if (kbRoot && prefix) {
		try {
			const { listProjectIssuesForParentPicker } = require('../../../indexing/projectViewQuery');
			indexIssues = await listProjectIssuesForParentPicker(kbRoot, prefix);
		} catch (err) {
			console.error('[DRIP] load project issues for parent picker', err);
		}
	}

	/** @type {Map<string, { issueKey: string, title: string, path: string, parentIssueKey: string | null }>} */
	const byKey = new Map();
	for (const iss of indexIssues) {
		if (iss.path === relPath) continue;
		byKey.set(iss.issueKey, iss);
	}
	for (const iss of bufferIssues) byKey.set(iss.issueKey, iss);
	const projectIssues = [...byKey.values()];

	const blocked = collectSelfAndDescendants(self || '', projectIssues);
	const options = projectIssues
		.filter(i => !blocked.has(i.issueKey))
		.sort((a, b) => issueNumber(a.issueKey) - issueNumber(b.issueKey))
		.map(i => {
			const legacy = parseIssueTitleEntityId(String(i.title || '').replace(/^\./, ''));
			const title = legacy && legacy.id === i.issueKey ? legacy.rest : String(i.title || '');
			const where = prefix && i.path.startsWith(prefix) ? i.path.slice(prefix.length) : i.path;
			return { key: i.issueKey, title, where };
		});

	return {
		locked: !!lockedParent,
		lockedParent: lockedParent || null,
		currentParent,
		options,
		projectIssues
	};
}

/**
 * @param {{ issueEntityId?: string, typePrefix?: string }} model
 * @returns {string | null}
 */
function selfIssueKeyFromModel(model) {
	return (
		normalizeIssueEntityId(String((model && model.issueEntityId) || '')) ||
		parseIssueTypePrefix(String((model && model.typePrefix) || '')) ||
		null
	);
}

/**
 * Validate the RHS parent value before writing. On rejection, `value` is what should stay
 * in the file (the locked parent, or the current valid parent).
 *
 * @param {import('vscode').TextDocument} doc
 * @param {any} model
 * @returns {Promise<{ ok: boolean, value: string, error?: string }>}
 */
async function validateIssueParentForApply(doc, model) {
	const selfKey = selfIssueKeyFromModel(model);
	const ctx = await loadIssueParentContext(doc, Number(model.headingLine), selfKey);
	const candidate = String((model.attributes && model.attributes.parent) || '').trim();
	const res = validateIssueParentChoice({
		selfKey,
		candidate,
		lockedParent: ctx.lockedParent,
		projectIssues: ctx.projectIssues
	});
	if (res.ok) return res;
	return { ok: false, value: ctx.locked ? '' : ctx.currentParent || '', error: res.error };
}

module.exports = {
	loadIssueParentContext,
	selfIssueKeyFromModel,
	validateIssueParentForApply
};
