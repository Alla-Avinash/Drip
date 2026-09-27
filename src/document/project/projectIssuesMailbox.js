'use strict';

/**
 * Project `_issues.d.txt` inbox + feature `_recent` mailbox.
 * Assign = move issue heading block while preserving `i-N` name and `parent: i-N`.
 */

const path = require('path');
const vscode = require('vscode');
const { buildNewNoteFile, writeTextFile: writeTextFileRaw, readTextFile } = require('../kbNoteOps');
const { markExpectedDiskWrite } = require('../../shared/documentEditGuard');

/**
 * Disk write that open editors reload silently (no soft-lock "paste/bulk" prompt).
 * @param {import('vscode').Uri} uri
 * @param {string} content
 */
async function writeTextFile(uri, content) {
	markExpectedDiskWrite(uri);
	await writeTextFileRaw(uri, content);
}
const { allocateNextEntityNumber, indexNewNoteImmediately } = require('../../indexing/dripnoteIndex');
const { normalizeNoteIdentityFile } = require('../../indexing/dripnoteFileIdentity');
const { isHeadingIdentityLine } = require('../../indexing/dripnoteHeadingIdentity');
const {
	PROJECT_ISSUES_FILE_NAME,
	FEATURE_RECENT_FILE_NAME,
	FEATURE_RECENT_HEADING_TITLE,
	ISSUE_PARENT_META_KEY,
	parseIssueTitleEntityId,
	normalizeIssueEntityId
} = require('./projectStructureRules');
const { allocateNextIssueEntityId } = require('./projectEntityIds');
const {
	findNearestOutlineAncestorIssueId,
	setIssueParentLineInLines
} = require('./issueParentLink');
const { isDripFeatureFolderName } = require('../model/dripFeature');
const {
	findIssueHeadingBlock,
	appendIssueToRecents,
	appendSubIssueUnderParent
} = require('./issueInboxLayout');

/**
 * @param {import('vscode').Uri} projectFolderUri
 * @returns {import('vscode').Uri}
 */
function projectIssuesUri(projectFolderUri) {
	return vscode.Uri.joinPath(projectFolderUri, PROJECT_ISSUES_FILE_NAME);
}

/**
 * Create empty `_issues.d.txt` in a project folder if missing.
 * @param {import('vscode').Uri} projectFolderUri
 * @param {{ context?: import('vscode').ExtensionContext, kbRoot?: import('vscode').Uri }} [options]
 * @returns {Promise<import('vscode').Uri | undefined>}
 */
async function ensureProjectIssuesFile(projectFolderUri, options = {}) {
	if (!projectFolderUri) return undefined;
	const noteUri = projectIssuesUri(projectFolderUri);
	try {
		await vscode.workspace.fs.stat(noteUri);
		return noteUri;
	} catch {
		/* create */
	}

	const kbRoot = options.kbRoot;
	let n = 0;
	if (kbRoot) {
		try {
			n = await allocateNextEntityNumber(kbRoot);
		} catch (err) {
			console.error('[DRIP] allocate file id for _issues', err);
		}
	}

	const text = buildNewNoteFile(
		{
			title: 'issues',
			content: '',
			metadataFilename: 'issues'
		},
		{ fileEntityNumber: n }
	);
	await writeTextFile(noteUri, text);

	if (kbRoot) {
		try {
			await normalizeNoteIdentityFile(noteUri, { context: options.context, kbRoot });
		} catch (err) {
			console.error('[DRIP] normalize _issues identity', err);
		}
		try {
			await indexNewNoteImmediately(kbRoot, noteUri, options.context);
		} catch (err) {
			console.error('[DRIP] index _issues', err);
		}
	}
	return noteUri;
}

/**
 * New issue block as lines at indent 0 (no trailing blank).
 * @param {{ issueId: string, title?: string, parentIssueId?: string | null }} opts
 * @returns {string[]}
 */
function newIssueBlockLines(opts) {
	return formatNewIssueBlock({ ...opts, indentTabs: 0 })
		.split('\n')
		.filter((l, i, all) => i < all.length - 1 || l.trim());
}

/**
 * Build a new issue heading block (root or nested).
 * @param {{ issueId: string, title?: string, parentIssueId?: string | null, indentTabs?: number }} opts
 * @returns {string}
 */
function formatNewIssueBlock(opts) {
	const issueId = normalizeIssueEntityId(opts.issueId);
	if (!issueId) throw new Error('formatNewIssueBlock: invalid issue id');
	const rest = String(opts.title || '').trim();
	const tabs = Math.max(0, Math.floor(Number(opts.indentTabs) || 0));
	const ind = '\t'.repeat(tabs);
	const parentId = opts.parentIssueId ? normalizeIssueEntityId(opts.parentIssueId) : null;
	// Durable id lives in the type prefix: `# .i-12 Fix login`
	// Type marker one tab under the heading; attributes one tab under the marker.
	const lines = [
		`${ind}# .${issueId}${rest ? ` ${rest}` : ' '}`,
		`${ind}\t.issue`,
		`${ind}\t\tstatus: to-do`,
		`${ind}\t\tpriority: medium`
	];
	if (parentId) {
		lines.push(`${ind}\t\t${ISSUE_PARENT_META_KEY}: ${parentId}`);
	}
	lines.push('');
	return lines.join('\n');
}

/**
 * Try to write a sub-issue as the last indented child of its parent heading
 * (parent's own file first, via the index; then `_issues.d.txt`). No `parent:` line — the
 * indentation carries the link.
 *
 * @returns {Promise<import('vscode').Uri | null>} file written, or null when the parent heading was not found
 */
async function writeSubIssueUnderParent(kbRootUri, projectFolderUri, prefix, parentId, block) {
	/** @type {import('vscode').Uri[]} */
	const candidates = [];
	try {
		const { listProjectIssuesForParentPicker } = require('../../indexing/projectViewQuery');
		const rows = await listProjectIssuesForParentPicker(kbRootUri, prefix);
		const row = rows.find(r => r.issueKey === parentId);
		if (row && row.path) {
			candidates.push(vscode.Uri.joinPath(kbRootUri, ...String(row.path).split('/').filter(Boolean)));
		}
	} catch (err) {
		console.error('[DRIP] locate parent issue file', err);
	}
	const inbox = projectIssuesUri(projectFolderUri);
	if (!candidates.some(u => u.fsPath === inbox.fsPath)) candidates.push(inbox);

	for (const uri of candidates) {
		let text;
		try {
			text = await readTextFile(uri);
		} catch {
			continue;
		}
		const next = appendSubIssueUnderParent(text, parentId, block);
		if (next == null) continue;
		await writeTextFile(uri, next);
		return uri;
	}
	return null;
}

/**
 * Create an issue from Project View.
 * - Root issue → last child of `# recents` in `_issues.d.txt`.
 * - Sub-issue → indented under its parent heading (wherever it lives in the project).
 *   Falls back to `# recents` + `parent: i-N` only if the parent heading can't be found.
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} projectFolderUri
 * @param {{ title?: string, parentIssueId?: string | null, context?: import('vscode').ExtensionContext }} opts
 * @returns {Promise<{ issueId: string, uri: import('vscode').Uri }>}
 */
async function createIssueInProjectInbox(kbRootUri, projectFolderUri, opts = {}) {
	const rel = path.relative(kbRootUri.fsPath, projectFolderUri.fsPath).replace(/\\/g, '/');
	const prefix = rel.endsWith('/') ? rel : `${rel}/`;
	const issueId = await allocateNextIssueEntityId(kbRootUri, prefix);
	const parentId = normalizeIssueEntityId(opts.parentIssueId || '') || null;

	/** @type {import('vscode').Uri | null} */
	let writtenUri = null;
	if (parentId) {
		writtenUri = await writeSubIssueUnderParent(
			kbRootUri,
			projectFolderUri,
			prefix,
			parentId,
			newIssueBlockLines({ issueId, title: opts.title })
		);
	}
	if (!writtenUri) {
		const issuesUri = await ensureProjectIssuesFile(projectFolderUri, {
			kbRoot: kbRootUri,
			context: opts.context
		});
		if (!issuesUri) throw new Error('Could not create _issues.d.txt');
		const text = await readTextFile(issuesUri);
		const block = newIssueBlockLines({ issueId, title: opts.title, parentIssueId: parentId });
		await writeTextFile(issuesUri, appendIssueToRecents(text, block));
		writtenUri = issuesUri;
	}
	try {
		await indexNewNoteImmediately(kbRootUri, writtenUri, opts.context);
	} catch (err) {
		console.error('[DRIP] reindex after issue create', err);
	}
	return { issueId, uri: writtenUri };
}

/**
 * Ensure `# _recent` section exists after `---` (+ 2 blank lines) in a feature file note.
 * @param {string} text
 * @returns {string}
 */
function ensureRecentHeadingInFeatureFile(text) {
	const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	if (/(^|\n)#\s+_recent\b/i.test(normalized)) {
		return normalized.endsWith('\n') ? normalized : normalized + '\n';
	}
	const sep = normalized.indexOf('\n---\n');
	if (sep < 0) {
		return normalized.replace(/\s*$/, '') + `\n\n\n# ${FEATURE_RECENT_HEADING_TITLE}\n`;
	}
	const before = normalized.slice(0, sep + '\n---\n'.length);
	const after = normalized.slice(sep + '\n---\n'.length);
	return before + `\n\n# ${FEATURE_RECENT_HEADING_TITLE}\n` + after.replace(/^\n*/, '');
}

/**
 * Resolve mailbox target for a feature path (folder `.f` or file `*.f.d.txt`).
 * @param {import('vscode').Uri} featureUri folder or feature note
 * @returns {Promise<{ kind: 'file'|'folder', mailboxUri: import('vscode').Uri, isFolderIndex?: boolean }>}
 */
async function resolveFeatureMailboxTarget(featureUri) {
	const base = path.basename(featureUri.fsPath);
	let st;
	try {
		st = await vscode.workspace.fs.stat(featureUri);
	} catch {
		throw new Error('Feature path not found');
	}
	const isDir = (st.type & vscode.FileType.Directory) !== 0;
	if (isDir || isDripFeatureFolderName(base)) {
		const folderUri = isDir ? featureUri : vscode.Uri.file(path.dirname(featureUri.fsPath));
		return {
			kind: 'folder',
			mailboxUri: vscode.Uri.joinPath(folderUri, FEATURE_RECENT_FILE_NAME),
			isFolderIndex: true
		};
	}
	return { kind: 'file', mailboxUri: featureUri, isFolderIndex: false };
}

/**
 * Move an issue block from `_issues.d.txt` into the feature mailbox. Preserves parent: i-N.
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} projectFolderUri
 * @param {import('vscode').Uri} featureUri
 * @param {string} issueId e.g. i-3
 * @param {{ context?: import('vscode').ExtensionContext }} [options]
 */
async function moveIssueToFeatureMailbox(kbRootUri, projectFolderUri, featureUri, issueId, options = {}) {
	const id = normalizeIssueEntityId(issueId);
	if (!id) throw new Error('Invalid issue id');

	const issuesUri = projectIssuesUri(projectFolderUri);
	let issuesText = await readTextFile(issuesUri);
	let found = findIssueHeadingBlock(issuesText, id);
	if (!found) throw new Error(`Issue ${id} not found in _issues.d.txt`);

	// Outline parent is lost once the block leaves this file; keep it as `parent: i-N`.
	const outlineParent = findNearestOutlineAncestorIssueId(found.lines.join('\n'), found.start);
	if (outlineParent) {
		issuesText = setIssueParentLineInLines(found.lines, found.start, outlineParent).join('\n');
		found = findIssueHeadingBlock(issuesText, id);
		if (!found) throw new Error(`Issue ${id} not found in _issues.d.txt`);
	}

	// Take the heading's own identity line with the block (as a manual cut/paste would).
	const blockStart =
		found.start > 0 && isHeadingIdentityLine(found.lines[found.start - 1])
			? found.start - 1
			: found.start;
	const blockLines = found.lines.slice(blockStart, found.end);
	const startIndentMatch = found.lines[found.start].match(/^(\t*)/);
	const tabStrip = startIndentMatch ? startIndentMatch[1].length : 0;
	const dedented =
		blockLines
			.map(ln => {
				if (!tabStrip) return ln;
				let out = ln;
				for (let t = 0; t < tabStrip; t++) {
					if (out.startsWith('\t')) out = out.slice(1);
					else break;
				}
				return out;
			})
			.join('\n') + '\n';

	const remaining = found.lines.slice(0, blockStart).concat(found.lines.slice(found.end)).join('\n');
	await writeTextFile(issuesUri, remaining.endsWith('\n') ? remaining : remaining + '\n');

	const target = await resolveFeatureMailboxTarget(featureUri);
	if (target.kind === 'folder') {
		let mailboxText = '';
		try {
			mailboxText = await readTextFile(target.mailboxUri);
		} catch {
			const n = kbRootUri ? await allocateNextEntityNumber(kbRootUri).catch(() => 0) : 0;
			mailboxText = buildNewNoteFile(
				{ title: 'recent', content: '', metadataFilename: 'recent' },
				{ fileEntityNumber: n }
			);
		}
		if (!mailboxText.endsWith('\n')) mailboxText += '\n';
		await writeTextFile(target.mailboxUri, mailboxText + dedented);
	} else {
		let fileText = await readTextFile(target.mailboxUri);
		fileText = ensureRecentHeadingInFeatureFile(fileText);
		if (!fileText.endsWith('\n')) fileText += '\n';
		await writeTextFile(target.mailboxUri, fileText + dedented);
	}

	try {
		await indexNewNoteImmediately(kbRootUri, issuesUri, options.context);
		await indexNewNoteImmediately(kbRootUri, target.mailboxUri, options.context);
	} catch (err) {
		console.error('[DRIP] reindex after issue move', err);
	}

	return { issueId: id, mailboxUri: target.mailboxUri };
}

module.exports = {
	projectIssuesUri,
	ensureProjectIssuesFile,
	formatNewIssueBlock,
	createIssueInProjectInbox,
	findIssueHeadingBlock,
	ensureRecentHeadingInFeatureFile,
	resolveFeatureMailboxTarget,
	moveIssueToFeatureMailbox,
	parseIssueTitleEntityId
};
