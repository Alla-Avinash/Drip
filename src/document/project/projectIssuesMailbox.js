'use strict';

/**
 * Project `_issues.d.txt` inbox + feature `_inbox` mailbox.
 * Assign = move issue heading block while preserving `i-N` name and `parent: i-N`.
 */

const path = require('path');
const vscode = require('vscode');
const {
	buildNewNoteFile,
	writeTextFile: writeTextFileRaw,
	readTextFile,
	splitFileHeaderAndBody
} = require('../dripNoteKbOps.js');
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
const { allocateNextEntityNumber, indexNewNoteImmediately } = require('../../indexing/dripTxt/dripTxtIndex.js');
const { isHeadingIdentityLine } = require('../../indexing/dripTxt/dripTxtHeadingIdentity.js');
const {
	PROJECT_ISSUES_FILE_NAME,
	FEATURE_INBOX_FILE_NAME,
	FEATURE_INBOX_HEADING_TITLE,
	PROJECT_ISSUES_INBOX_HEADING_TITLE,
	ISSUE_PARENT_META_KEY,
	parseIssueTitleEntityId,
	normalizeIssueEntityId
} = require('./projectStructureRules');
const { allocateNextIssueEntityId } = require('./projectEntityIds');
const {
	findNearestOutlineAncestorIssueId,
	setIssueParentLineInLines
} = require('./issueParentLink');
const { isDripFeatureFolderName } = require('../model/dripNoteFeature.js');
const {
	isMarkdownFormat,
	formatFromPath,
	findIssueHeadingBlock,
	dedentToRoot,
	appendIssueToInbox,
	appendSubIssueUnderParent,
	insertSiblingBeforeIssue,
	insertSiblingAfterIssue,
	appendBlockUnderHeading,
	insertSiblingBeforeHeading,
	insertSiblingAfterHeading
} = require('./issueInboxLayout');
const { convertIssueBlockLines } = require('./issueBlockFormat');
const {
	isHeadingComment,
	parseHeadingComment,
	formatHeadingComment
} = require('../model/dripMd/dripMdNoteComment.js');

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
		const fmt = formatFromPath(uri.fsPath);
		const fmtBlock = convertIssueBlockLines(block, 'drip-txt', fmt);
		const next = appendSubIssueUnderParent(text, parentId, fmtBlock, fmt);
		if (next == null) continue;
		await writeTextFile(uri, next);
		return uri;
	}
	return null;
}

/**
 * Create an issue from Project View.
 * - Root issue → last child of `# _inbox` in `_issues.d.txt`.
 * - Sub-issue → indented under its parent heading (wherever it lives in the project).
 *   Falls back to `# _inbox` + `parent: i-N` only if the parent heading can't be found.
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
		await writeTextFile(issuesUri, appendIssueToInbox(text, block));
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
			mailboxUri: vscode.Uri.joinPath(folderUri, FEATURE_INBOX_FILE_NAME),
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
	const dedentedLines = dedentToRoot(blockLines, found.indent, 'drip-txt');

	const before = found.lines.slice(0, blockStart);
	const after = found.lines.slice(found.end);
	while (before.length && !String(before[before.length - 1]).trim() && after.length && !String(after[0]).trim()) {
		after.shift();
	}
	const remaining = before.concat(after).join('\n');
	await writeTextFile(issuesUri, remaining.endsWith('\n') ? remaining : remaining + '\n');

	const target = await resolveFeatureMailboxTarget(featureUri);
	if (target.kind === 'folder') {
		let mailboxText = '';
		try {
			mailboxText = await readTextFile(target.mailboxUri);
		} catch {
			const n = kbRootUri ? await allocateNextEntityNumber(kbRootUri).catch(() => 0) : 0;
			mailboxText = buildNewNoteFile(
				{ title: 'inbox', content: '', metadataFilename: 'inbox' },
				{ fileEntityNumber: n }
			);
		}
		if (!mailboxText.endsWith('\n')) mailboxText += '\n';
		await writeTextFile(target.mailboxUri, `${mailboxText}${dedentedLines.join('\n')}\n`);
	} else {
		const fileText = await readTextFile(target.mailboxUri);
		const fmt = formatFromPath(target.mailboxUri.fsPath);
		const fmtLines = convertIssueBlockLines(dedentedLines, 'drip-txt', fmt);
		await writeTextFile(
			target.mailboxUri,
			appendIssueToInbox(fileText, fmtLines, FEATURE_INBOX_HEADING_TITLE, fmt)
		);
	}

	try {
		await indexNewNoteImmediately(kbRootUri, issuesUri, options.context);
		await indexNewNoteImmediately(kbRootUri, target.mailboxUri, options.context);
	} catch (err) {
		console.error('[DRIP] reindex after issue move', err);
	}

	return { issueId: id, mailboxUri: target.mailboxUri };
}

/**
 * Remove any `parent: i-N` metadata from a dedented issue block. Used when the block is
 * re-parented under a new issue by nesting — nesting becomes the source of truth. In `.d.md`
 * the parent lives inside the hidden comment.
 * @param {string[]} lines
 * @param {string} [format]
 * @returns {string[]}
 */
function stripIssueParentLine(lines, format) {
	if (isMarkdownFormat(format)) {
		return (lines || []).map(l => {
			if (!isHeadingComment(l)) return l;
			const c = parseHeadingComment(l);
			if (!c) return l;
			return formatHeadingComment(c.headingNum, c.typeId, c.fields.filter(f => f.key !== ISSUE_PARENT_META_KEY));
		});
	}
	return (lines || []).filter(function (l) {
		return !/^\s*parent\s*:/i.test(String(l));
	});
}

/**
 * @param {string[]} lines
 * @param {string} [format]
 * @returns {boolean}
 */
function hasIssueParentLine(lines, format) {
	if (isMarkdownFormat(format)) {
		return (lines || []).some(l => {
			if (!isHeadingComment(l)) return false;
			const c = parseHeadingComment(l);
			return !!c && c.fields.some(f => f.key === ISSUE_PARENT_META_KEY);
		});
	}
	return (lines || []).some(function (l) {
		return /^\s*parent\s*:/i.test(String(l));
	});
}

/**
 * Append a dedented issue block to a destination target. The block is converted into the
 * destination file's format first (`sourceFormat` describes the block's current syntax).
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} projectFolderUri
 * @param {{ kind: 'feature', featureUri: import('vscode').Uri } | { kind: 'inbox' } | { kind: 'issue', issueId: string, position?: 'before' | 'after' | 'under', fileUri: import('vscode').Uri } | { kind: 'heading', headingPath: string, position?: 'before' | 'after' | 'under', fileUri: import('vscode').Uri } | { kind: 'file', position?: 'top' | 'bottom', fileUri: import('vscode').Uri }} target
 * @param {string[]} blockLines dedented block lines (root level, in `sourceFormat`)
 * @param {{ context?: import('vscode').ExtensionContext, removeParent?: boolean }} options
 * @param {string} [sourceFormat]
 * @returns {Promise<import('vscode').Uri>} the file written
 */
async function appendIssueBlockToTarget(kbRootUri, projectFolderUri, target, blockLines, options, sourceFormat) {
	const src = sourceFormat || 'drip-txt';

	if (target.kind === 'inbox') {
		const issuesUri = await ensureProjectIssuesFile(projectFolderUri, {
			kbRoot: kbRootUri,
			context: options.context
		});
		const issuesText = await readTextFile(issuesUri);
		const txtBlock = convertIssueBlockLines(blockLines, src, 'drip-txt');
		await writeTextFile(
			issuesUri,
			appendIssueToInbox(issuesText, txtBlock, PROJECT_ISSUES_INBOX_HEADING_TITLE, 'drip-txt')
		);
		return issuesUri;
	}

	if (target.kind === 'issue') {
		const fmt = formatFromPath(target.fileUri.fsPath);
		const fmtBlock = convertIssueBlockLines(blockLines, src, fmt);
		const pos = target.position === 'before' || target.position === 'after' ? target.position : 'under';
		const refText = await readTextFile(target.fileUri);
		let next = null;
		if (pos === 'under') {
			// A sub-issue can't be nested under another issue — nesting would fight the `parent:`
			// link. Only allow it when the user chose to remove the parent first.
			if (!options.removeParent && hasIssueParentLine(fmtBlock, fmt)) {
				throw new Error('This issue has a parent. Check "Remove parent" to place it under another issue.');
			}
			// Re-parent under an existing issue: nesting carries the link, so drop any parent field.
			next = appendSubIssueUnderParent(refText, target.issueId, stripIssueParentLine(fmtBlock, fmt), fmt);
		} else if (pos === 'before') {
			next = insertSiblingBeforeIssue(refText, target.issueId, fmtBlock, fmt);
		} else {
			next = insertSiblingAfterIssue(refText, target.issueId, fmtBlock, fmt);
		}
		if (next == null) throw new Error(`Issue ${target.issueId} not found in ${target.fileUri.fsPath}`);
		await writeTextFile(target.fileUri, next);
		return target.fileUri;
	}

	if (target.kind === 'heading') {
		// Place relative to a plain (or issue) heading in a file: as its last child (default),
		// or as a sibling directly before/after it. The `parent:` field (if any) is kept so the
		// issue's own hierarchy survives, unless the user chose to remove it.
		const fmt = formatFromPath(target.fileUri.fsPath);
		const fmtBlock = convertIssueBlockLines(blockLines, src, fmt);
		const pos = target.position === 'before' || target.position === 'after' ? target.position : 'under';
		const text = await readTextFile(target.fileUri);
		let next = null;
		if (pos === 'before') {
			next = insertSiblingBeforeHeading(text, target.headingPath, fmtBlock, fmt);
		} else if (pos === 'after') {
			next = insertSiblingAfterHeading(text, target.headingPath, fmtBlock, fmt);
		} else {
			next = appendBlockUnderHeading(text, target.headingPath, fmtBlock, fmt);
		}
		if (next == null) throw new Error(`Heading "${target.headingPath}" not found in ${target.fileUri.fsPath}`);
		await writeTextFile(target.fileUri, next);
		return target.fileUri;
	}

	if (target.kind === 'file') {
		// File-level placement: put the issue at the top of the body (first heading) or at the
		// very bottom of the file, with no heading nesting — so there is no hierarchy problem.
		const fmt = formatFromPath(target.fileUri.fsPath);
		const fmtBlock = convertIssueBlockLines(blockLines, src, fmt);
		const text = await readTextFile(target.fileUri);
		const { bodyStartLine } = splitFileHeaderAndBody(text);
		const lines = text.replace(/\r\n/g, '\n').split('\n');
		if (target.position === 'top') {
			lines.splice(bodyStartLine, 0, '', ...fmtBlock, '');
		} else {
			while (lines.length && !String(lines[lines.length - 1]).trim()) lines.pop();
			lines.push('', ...fmtBlock, '');
		}
		let next = lines.join('\n');
		await writeTextFile(target.fileUri, next.endsWith('\n') ? next : next + '\n');
		return target.fileUri;
	}

	const t = await resolveFeatureMailboxTarget(target.featureUri);
	if (t.kind === 'folder') {
		const txtBlock = convertIssueBlockLines(blockLines, src, 'drip-txt');
		let mailboxText = '';
		try {
			mailboxText = await readTextFile(t.mailboxUri);
		} catch {
			const n = kbRootUri ? await allocateNextEntityNumber(kbRootUri).catch(() => 0) : 0;
			mailboxText = buildNewNoteFile(
				{ title: 'inbox', content: '', metadataFilename: 'inbox' },
				{ fileEntityNumber: n }
			);
		}
		if (!mailboxText.endsWith('\n')) mailboxText += '\n';
		await writeTextFile(t.mailboxUri, `${mailboxText}${txtBlock.join('\n')}\n`);
		return t.mailboxUri;
	}
	const fmt = formatFromPath(t.mailboxUri.fsPath);
	const fmtBlock = convertIssueBlockLines(blockLines, src, fmt);
	const fileText = await readTextFile(t.mailboxUri);
	await writeTextFile(
		t.mailboxUri,
		appendIssueToInbox(fileText, fmtBlock, FEATURE_INBOX_HEADING_TITLE, fmt)
	);
	return t.mailboxUri;
}

/**
 * Move an issue block from any source file (project inbox, feature mailbox, feature note)
 * to a feature mailbox, the project inbox, under a plain heading, or under another issue as a
 * sub-issue. Preserves `parent: i-N` by converting any outline ancestor before the block leaves
 * its file, unless `options.removeParent` is set (the user chose to detach the hierarchy).
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} sourceUri file the issue currently lives in
 * @param {import('vscode').Uri} projectFolderUri
 * @param {{ kind: 'feature', featureUri: import('vscode').Uri } | { kind: 'inbox' } | { kind: 'issue', issueId: string, position?: 'before' | 'after' | 'under', fileUri: import('vscode').Uri } | { kind: 'heading', headingPath: string, position?: 'before' | 'after' | 'under', fileUri: import('vscode').Uri } | { kind: 'file', position?: 'top' | 'bottom', fileUri: import('vscode').Uri }} target
 * @param {string} issueId e.g. i-3
 * @param {{ context?: import('vscode').ExtensionContext, removeParent?: boolean }} options
 */
async function moveIssueBlock(kbRootUri, sourceUri, projectFolderUri, target, issueId, options = {}) {
	const id = normalizeIssueEntityId(issueId);
	if (!id) throw new Error('Invalid issue id');
	const removeParent = options.removeParent === true;
	const sourceFormat = formatFromPath(sourceUri.fsPath);

	let text = await readTextFile(sourceUri);
	let found = findIssueHeadingBlock(text, id, sourceFormat);
	if (!found) throw new Error(`Issue ${id} not found in ${sourceUri.fsPath}`);

	// Nesting-carried parent is lost on move; record it as `parent: i-N` first — unless the
	// user is detaching the hierarchy, in which case we leave it out entirely.
	const outlineParent = findNearestOutlineAncestorIssueId(found.lines.join('\n'), found.start, sourceFormat);
	if (outlineParent && !removeParent) {
		text = setIssueParentLineInLines(found.lines, found.start, outlineParent, sourceFormat).join('\n');
		found = findIssueHeadingBlock(text, id, sourceFormat);
		if (!found) throw new Error(`Issue ${id} not found in ${sourceUri.fsPath}`);
	}

	// Take the heading's own identity line with the block (as a manual cut/paste would).
	const blockStart =
		found.start > 0 && isHeadingIdentityLine(found.lines[found.start - 1])
			? found.start - 1
			: found.start;
	const blockLines = found.lines.slice(blockStart, found.end);
	const dedentedLines = dedentToRoot(blockLines, found.indent, sourceFormat);
	// Detach: drop the `parent:` field so the issue can sit under any heading/issue.
	const finalLines = removeParent ? stripIssueParentLine(dedentedLines, sourceFormat) : dedentedLines;

	const before = found.lines.slice(0, blockStart);
	const after = found.lines.slice(found.end);
	while (before.length && !String(before[before.length - 1]).trim() && after.length && !String(after[0]).trim()) {
		after.shift();
	}
	const remaining = before.concat(after).join('\n');

	// Append to the destination FIRST: if it throws (e.g. "has a parent" guard, or the target
	// heading/issue isn't found), the issue is never removed from its source file.
	const targetUri = await appendIssueBlockToTarget(kbRootUri, projectFolderUri, target, finalLines, options, sourceFormat);

	// Destination write succeeded — now remove the issue from its source file.
	await writeTextFile(sourceUri, remaining.endsWith('\n') ? remaining : remaining + '\n');

	try {
		await indexNewNoteImmediately(kbRootUri, sourceUri, options.context);
		await indexNewNoteImmediately(kbRootUri, targetUri, options.context);
	} catch (err) {
		console.error('[DRIP] reindex after issue move', err);
	}

	return { issueId: id, mailboxUri: targetUri };
}

module.exports = {
	projectIssuesUri,
	ensureProjectIssuesFile,
	formatNewIssueBlock,
	createIssueInProjectInbox,
	findIssueHeadingBlock,
	resolveFeatureMailboxTarget,
	moveIssueToFeatureMailbox,
	moveIssueBlock,
	parseIssueTitleEntityId
};
