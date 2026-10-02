'use strict';

/**
 * Shared helpers for MCP tool handlers: KB access, name resolution, safe note writes.
 */

const path = require('path');
const vscode = require('vscode');
const { readTextFile, writeTextFile } = require('../../../document/kbNoteOps');
const { runGuardedDocumentEdit, markExpectedDiskWrite } = require('../../../shared/documentEditGuard');
const { normalizeIssueEntityId } = require('../../../document/project/projectStructureRules');
const {
	listProjectsFromIndex,
	listProjectChildrenFromIndex
} = require('../../../indexing/projectViewQuery');

/** Error whose message is safe and useful to show the calling LLM. */
class ToolError extends Error {}

/**
 * @typedef {{
 *   extensionContext: import('vscode').ExtensionContext,
 *   getKbRoot: () => import('vscode').Uri | undefined,
 *   refreshUi: () => void
 * }} ToolContext
 */

/**
 * @param {ToolContext} ctx
 * @returns {import('vscode').Uri}
 */
function requireKbRoot(ctx) {
	const kb = ctx.getKbRoot();
	if (!kb) throw new ToolError('No knowledge base is open in DRIP. Select one in the DRIP sidebar first.');
	return kb;
}

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {string} relPath KB-relative, `/`-separated
 */
function uriFromRel(kbRoot, relPath) {
	return vscode.Uri.joinPath(kbRoot, ...String(relPath || '').split('/').filter(Boolean));
}

/**
 * Project by folder (`Shop.p`, `Shop.p/`), folder name without `.p`, or title.
 * Omitted → the only project, if there is exactly one.
 * @param {import('vscode').Uri} kbRoot
 * @param {string | undefined} name
 */
async function resolveProject(kbRoot, name) {
	const { projects } = await listProjectsFromIndex(kbRoot);
	if (!projects.length) throw new ToolError('This knowledge base has no projects (Name.p folders).');
	const want = String(name || '').trim().toLowerCase().replace(/\/+$/, '');
	if (!want) {
		if (projects.length === 1) return projects[0];
		throw new ToolError(
			`Specify "project". Available: ${projects.map(p => p.folderPrefix.replace(/\/+$/, '')).join(', ')}`
		);
	}
	const hits = projects.filter(p => {
		const folder = p.folderPrefix.replace(/\/+$/, '').toLowerCase();
		const base = path.posix.basename(folder);
		return (
			folder === want ||
			base === want ||
			base.replace(/\.p$/, '') === want.replace(/\.p$/, '') ||
			String(p.title || '').toLowerCase() === want
		);
	});
	if (!hits.length) {
		throw new ToolError(
			`Unknown project "${name}". Available: ${projects.map(p => p.folderPrefix.replace(/\/+$/, '')).join(', ')}`
		);
	}
	if (hits.length > 1) {
		throw new ToolError(
			`"${name}" is ambiguous (${hits.length} projects match). Pick the exact folder: ${hits.map(p => p.folderPrefix.replace(/\/+$/, '')).join(', ')}`
		);
	}
	return hits[0];
}

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {{ folderPrefix: string }} project
 */
async function loadProjectChildren(kbRoot, project) {
	return listProjectChildrenFromIndex(kbRoot, project.folderPrefix);
}

/**
 * Feature by `f-N`, title, folder/file name, or path.
 * @param {{ title: string, path: string, folderPrefix: string | null }[]} features
 * @param {string} name
 */
function resolveFeature(features, name) {
	const want = String(name || '').trim().toLowerCase().replace(/\/+$/, '');
	if (!want) throw new ToolError('Specify "feature".');
	const hit = features.find(f => {
		const title = String(f.title || '').toLowerCase();
		const folder = f.folderPrefix ? f.folderPrefix.replace(/\/+$/, '').toLowerCase() : '';
		const folderBase = folder ? path.posix.basename(folder) : '';
		const fileBase = path.posix.basename(String(f.path || '').toLowerCase());
		const bare = s => s.replace(/\.f(\.d\.txt)?$/, '');
		return (
			title === want ||
			title.replace(/^f-\d+\s+/, '') === want ||
			title.startsWith(`${want} `) ||
			(folder && (folder === want || folderBase === want || bare(folderBase) === bare(want))) ||
			fileBase === want ||
			bare(fileBase) === bare(want) ||
			String(f.path || '').toLowerCase() === want
		);
	});
	if (!hit) {
		throw new ToolError(
			`Unknown feature "${name}". Available: ${features.map(f => f.title).join(', ') || '(none)'}`
		);
	}
	return hit;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function requireIssueId(raw) {
	const id = normalizeIssueEntityId(String(raw || '').trim());
	if (!id) throw new ToolError(`"${raw}" is not an issue id. Use i-N (e.g. i-12).`);
	return id;
}

/**
 * @param {any[]} issues
 * @param {string} issueId
 */
function findIssueRow(issues, issueId) {
	const row = issues.find(i => i.issueKey === issueId);
	if (!row) throw new ToolError(`Issue ${issueId} was not found in this project.`);
	return row;
}

/**
 * @param {import('vscode').Uri} uri
 * @returns {import('vscode').TextDocument | undefined}
 */
function openDocumentFor(uri) {
	const key = uri.fsPath.toLowerCase();
	return vscode.workspace.textDocuments.find(d => d.uri.fsPath.toLowerCase() === key);
}

/**
 * Live editor text when the note is open (may be unsaved), else disk.
 * @param {import('vscode').Uri} uri
 */
async function readNoteText(uri) {
	const doc = openDocumentFor(uri);
	return doc ? doc.getText().replace(/\r\n/g, '\n') : readTextFile(uri);
}

/**
 * Write through the open editor (keeps undo, no reload conflict) or to disk.
 * @param {import('vscode').Uri} uri
 * @param {string} text
 */
async function writeNoteText(uri, text) {
	const doc = openDocumentFor(uri);
	markExpectedDiskWrite(uri);
	if (!doc) {
		await writeTextFile(uri, text);
		return;
	}
	await runGuardedDocumentEdit(async () => {
		const edit = new vscode.WorkspaceEdit();
		const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
		edit.replace(doc.uri, full, text);
		await vscode.workspace.applyEdit(edit);
		await doc.save();
	});
}

/**
 * Re-index one note so Project View / queries see the change.
 * @param {ToolContext} ctx
 * @param {import('vscode').Uri} uri
 */
async function reindexNote(ctx, uri) {
	const { indexNewNoteImmediately } = require('../../../indexing/dripnoteIndex');
	try {
		await indexNewNoteImmediately(requireKbRoot(ctx), uri, ctx.extensionContext);
	} catch (err) {
		console.error('[DRIP MCP] reindex', err);
	}
}

/**
 * Compact issue shape returned to the LLM.
 * @param {any} i
 */
function issueSummary(i) {
	const { formatDateTimeToMinute } = require('../../../document/parse/dripnoteDatetime');
	return {
		id: i.issueKey,
		title: String(i.title || '').replace(/^i-\d+\s+/i, ''),
		status: i.status || null,
		priority: i.priority || null,
		category: i.category || null,
		deadline:
			i.deadline != null && Number.isFinite(Number(i.deadline))
				? formatDateTimeToMinute(new Date(Number(i.deadline) * 1000))
				: null,
		parent: i.parentIssueKey || null,
		file: i.path,
		location: i.inProjectInbox ? 'inbox' : i.featurePathPrefix || 'other'
	};
}

module.exports = {
	ToolError,
	requireKbRoot,
	uriFromRel,
	resolveProject,
	loadProjectChildren,
	resolveFeature,
	requireIssueId,
	findIssueRow,
	readNoteText,
	writeNoteText,
	reindexNote,
	issueSummary
};
