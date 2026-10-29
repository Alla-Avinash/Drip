'use strict';

/**
 * After 3 days completed, move an issue into the project's `_archive` folder.
 * Archive notes are flat, keep parent, and write a feature field so the old
 * location is still known.
 */

const path = require('path');
const vscode = require('vscode');
const {
	ARCHIVE_SUBFOLDER_NAME,
	isDripProjectFolderName
} = require('../model/dripNoteProjectFolder.js');
const { getDefaultNewNoteExtension, noteFormatForPath } = require('../model/dripNoteFileTypes.js');
const { isDripFeatureFolderName, isDripFeatureFileName } = require('../model/dripNoteFeature.js');
const { buildNewNoteFile, readTextFile } = require('../dripNoteKbOps.js');
const { allocateNextEntityNumber, indexNewNoteImmediately } = require('../../indexing/dripTxt/dripTxtIndex.js');
const { ensureProjectsHome } = require('../../startup/projectsDrip');
const { collectIssueIds } = require('../../peer/projectHiddenIds');
const { readIssueBlock, updateIssueBlockText } = require('./issueBlockEdit');
const { isCompletedStatus, isReadyToArchive, COMPLETED_FIELD } = require('./issueCompletedStamp');
const { formatFromPath } = require('./issueInboxLayout');

const ARCHIVE_BATCH = 100;
const LAST_SWEEP_STATE_KEY = 'drip.issueArchive.lastSweepAt';

/** Most recent Sunday 00:00 local (today if today is Sunday). */
function lastSundayStart(now) {
	const d = new Date(now || Date.now());
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() - d.getDay());
	return d;
}

function nextSundayStart(now) {
	const next = lastSundayStart(now);
	next.setDate(next.getDate() + 7);
	return next;
}

function lastSweepStateKey(kbRootUri) {
	const root = kbRootUri && kbRootUri.fsPath ? kbRootUri.fsPath.replace(/\\/g, '/').toLowerCase() : '';
	return root ? `${LAST_SWEEP_STATE_KEY}:${root}` : LAST_SWEEP_STATE_KEY;
}

function isWeeklySweepDue(lastSweepAt, now) {
	if (!lastSweepAt) return true;
	const last = new Date(lastSweepAt);
	if (Number.isNaN(last.getTime())) return true;
	return last.getTime() < lastSundayStart(now).getTime();
}

function isArchiveNotePath(projectFolderUri, noteUri) {
	const rel = path.relative(projectFolderUri.fsPath, noteUri.fsPath).replace(/\\/g, '/');
	return /(^|\/)_archive(\/|$)/i.test(rel);
}

function featureLabelFromPath(projectFolderUri, noteUri) {
	const rel = path.relative(projectFolderUri.fsPath, noteUri.fsPath).replace(/\\/g, '/');
	for (const part of rel.split('/').filter(Boolean)) {
		if (isDripFeatureFolderName(part)) {
			return String(part).replace(/\.f$/i, '');
		}
		if (isDripFeatureFileName(part)) {
			return String(part).replace(/\.f\.d\.(txt|md)$/i, '');
		}
	}
	return '';
}

async function ensureArchiveFolder(projectFolderUri) {
	const dir = vscode.Uri.joinPath(projectFolderUri, ARCHIVE_SUBFOLDER_NAME);
	await vscode.workspace.fs.createDirectory(dir);
	return dir;
}

async function countIssuesInNote(uri) {
	try {
		const text = await readTextFile(uri);
		const fmt = noteFormatForPath(uri.fsPath) === '.d.md' ? 'drip-md' : 'drip-txt';
		return collectIssueIds(text, fmt).length;
	} catch {
		return 0;
	}
}

/**
 * Next archive note with room, or a new one. `preferRel` keeps peers on the same file.
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} projectFolderUri
 * @param {string} [preferRel]
 */
async function resolveArchiveDest(kbRootUri, projectFolderUri, preferRel) {
	const dir = await ensureArchiveFolder(projectFolderUri);
	const prefer = String(preferRel || '').replace(/\\/g, '/');
	if (prefer && !prefer.includes('..')) {
		const dest = vscode.Uri.joinPath(projectFolderUri, ...prefer.split('/').filter(Boolean));
		const parent = vscode.Uri.joinPath(projectFolderUri, ...prefer.split('/').filter(Boolean).slice(0, -1));
		if (parent.fsPath) await vscode.workspace.fs.createDirectory(parent);
		try {
			await vscode.workspace.fs.stat(dest);
			return dest;
		} catch {
			await createArchiveNote(kbRootUri, dest);
			return dest;
		}
	}
	let names = [];
	try {
		names = (await vscode.workspace.fs.readDirectory(dir))
			.filter(([, t]) => t === vscode.FileType.File)
			.map(([n]) => n)
			.filter(n => /^done-\d+\.d\.(txt|md)$/i.test(n))
			.sort((a, b) => {
				const na = parseInt(String(a).replace(/\D/g, ''), 10) || 0;
				const nb = parseInt(String(b).replace(/\D/g, ''), 10) || 0;
				return na - nb;
			});
	} catch {
		names = [];
	}
	for (let i = names.length - 1; i >= 0; i--) {
		const uri = vscode.Uri.joinPath(dir, names[i]);
		if ((await countIssuesInNote(uri)) < ARCHIVE_BATCH) return uri;
	}
	const nextN = names.reduce((max, n) => {
		const v = parseInt(String(n).replace(/\D/g, ''), 10) || 0;
		return v > max ? v : max;
	}, 0) + 1;
	const ext = getDefaultNewNoteExtension() === '.d.md' ? '.d.md' : '.d.txt';
	const dest = vscode.Uri.joinPath(dir, `done-${nextN}${ext}`);
	await createArchiveNote(kbRootUri, dest);
	return dest;
}

async function createArchiveNote(kbRootUri, destUri) {
	let n = 0;
	try {
		n = await allocateNextEntityNumber(kbRootUri, destUri);
	} catch {
		n = 0;
	}
	const stem = path.basename(destUri.fsPath).replace(/\.d\.(txt|md)$/i, '');
	const text = buildNewNoteFile(
		{ title: stem, content: '', metadataFilename: stem },
		{
			fileEntityNumber: n,
			format: /\.md$/i.test(destUri.fsPath) ? 'drip-md' : undefined
		}
	);
	const { markExpectedDiskWrite } = require('../../shared/documentEditGuard');
	markExpectedDiskWrite(destUri);
	await vscode.workspace.fs.writeFile(destUri, Buffer.from(text, 'utf8'));
	try {
		await indexNewNoteImmediately(kbRootUri, destUri);
	} catch {
		/* index is best-effort */
	}
}

/**
 * Move one completed issue into `_archive`.
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} projectFolderUri
 * @param {import('vscode').Uri} sourceUri
 * @param {string} issueId
 * @param {{ context?: import('vscode').ExtensionContext, skipOpRecord?: boolean, archiveRel?: string }} [options]
 */
async function archiveIssue(kbRootUri, projectFolderUri, sourceUri, issueId, options = {}) {
	if (isArchiveNotePath(projectFolderUri, sourceUri)) return null;
	const fmt = formatFromPath(sourceUri.fsPath);
	const text = await readTextFile(sourceUri);
	const block = readIssueBlock(text, issueId, fmt);
	if (!block) return null;
	if (!isCompletedStatus(block.attributes && block.attributes.status)) return null;
	const feature = String((block.attributes && block.attributes.feature) || '').trim()
		|| featureLabelFromPath(projectFolderUri, sourceUri);
	if (feature && String((block.attributes && block.attributes.feature) || '').trim() !== feature) {
		const stamped = updateIssueBlockText(text, issueId, { attributes: { feature } }, fmt);
		if (stamped.ok) {
			const { markExpectedDiskWrite } = require('../../shared/documentEditGuard');
			markExpectedDiskWrite(sourceUri);
			await vscode.workspace.fs.writeFile(sourceUri, Buffer.from(stamped.text, 'utf8'));
		}
	}
	const dest = await resolveArchiveDest(kbRootUri, projectFolderUri, options.archiveRel);
	const { moveIssueBlock } = require('./projectIssuesMailbox');
	return moveIssueBlock(kbRootUri, sourceUri, projectFolderUri, { kind: 'archive', fileUri: dest }, issueId, {
		context: options.context,
		skipOpRecord: options.skipOpRecord,
		removeParent: false
	});
}

async function sweepOneProject(kbRootUri, projectFolderUri, context) {
	const { forEachKnowledgeBaseNotePath } = require('../../indexing/kbFilesystem');
	const { projectFolderPrefixForPath } = require('../../peer/projectSidecar');
	const prefix = projectFolderPrefixForPath(kbRootUri.fsPath, projectFolderUri.fsPath);
	if (!prefix) return 0;
	let moved = 0;
	await forEachKnowledgeBaseNotePath(kbRootUri, async note => {
		const rel = String(note.relativePath || '').replace(/\\/g, '/');
		if (!rel.startsWith(prefix + '/') && rel !== prefix) return;
		if (isArchiveNotePath(projectFolderUri, note.uri)) return;
		let text;
		try {
			text = Buffer.from(await vscode.workspace.fs.readFile(note.uri)).toString('utf8');
		} catch {
			return;
		}
		const fmt = noteFormatForPath(note.uri.fsPath) === '.d.md' ? 'drip-md' : 'drip-txt';
		for (const issueId of collectIssueIds(text, fmt)) {
			const block = readIssueBlock(text, issueId, fmt);
			if (!block || !isCompletedStatus(block.attributes && block.attributes.status)) continue;
			const stamp = block.attributes && block.attributes[COMPLETED_FIELD];
			if (!String(stamp || '').trim()) {
				const patched = updateIssueBlockText(
					text,
					issueId,
					{ attributes: { status: 'completed' } },
					fmt
				);
				if (patched.ok) {
					const { markExpectedDiskWrite } = require('../../shared/documentEditGuard');
					markExpectedDiskWrite(note.uri);
					await vscode.workspace.fs.writeFile(note.uri, Buffer.from(patched.text, 'utf8'));
					text = patched.text;
				}
				continue;
			}
			if (!isReadyToArchive(stamp)) continue;
			try {
				const result = await archiveIssue(kbRootUri, projectFolderUri, note.uri, issueId, { context });
				if (result) moved += 1;
				text = Buffer.from(await vscode.workspace.fs.readFile(note.uri)).toString('utf8');
			} catch (err) {
				console.error('[DRIP] archive issue', issueId, err);
			}
		}
	});
	return moved;
}

/**
 * Walk every project folder and archive completed issues that are old enough.
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').ExtensionContext} [context]
 */
async function sweepProjectIssueArchives(kbRootUri, context) {
	if (!kbRootUri) return 0;
	const home = await ensureProjectsHome(kbRootUri);
	let names = [];
	try {
		names = await vscode.workspace.fs.readDirectory(home);
	} catch {
		return 0;
	}
	let total = 0;
	for (const [name, type] of names) {
		if (type !== vscode.FileType.Directory || !isDripProjectFolderName(name)) continue;
		const folderUri = vscode.Uri.joinPath(home, name);
		try {
			total += await sweepOneProject(kbRootUri, folderUri, context);
		} catch (err) {
			console.error('[DRIP] archive sweep', name, err);
		}
	}
	return total;
}

/**
 * Run the archive job at most once a week, on Sunday.
 * If DRIP was closed that Sunday, the next time it is open (and the KB is ready)
 * does that week's job. Nothing runs while the app is closed.
 */
function registerIssueArchiveSweep(context, state) {
	let timer = null;
	const clearTimer = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};

	const kbRoot = () =>
		(state.getVerifiedKnowledgeBaseRoot && state.getVerifiedKnowledgeBaseRoot()) ||
		(state.getKnowledgeBaseRoot && state.getKnowledgeBaseRoot());

	const scheduleNextSunday = () => {
		clearTimer();
		const delay = Math.max(1000, nextSundayStart(new Date()).getTime() - Date.now());
		timer = setTimeout(() => runIfDue(), delay);
	};

	const runIfDue = () => {
		const kb = kbRoot();
		if (!kb) {
			scheduleNextSunday();
			return;
		}
		const key = lastSweepStateKey(kb);
		if (!isWeeklySweepDue(context.globalState.get(key), new Date())) {
			scheduleNextSunday();
			return;
		}
		sweepProjectIssueArchives(kb, context)
			.then(() => context.globalState.update(key, new Date().toISOString()))
			.catch(err => console.error('[DRIP] archive sweep', err))
			.finally(scheduleNextSunday);
	};

	context.subscriptions.push({ dispose: clearTimer });
	return runIfDue;
}

module.exports = {
	ARCHIVE_BATCH,
	isArchiveNotePath,
	featureLabelFromPath,
	ensureArchiveFolder,
	resolveArchiveDest,
	archiveIssue,
	sweepProjectIssueArchives,
	registerIssueArchiveSweep
};
