'use strict';

/**
 * Monthly Today cleanup:
 * - Delete completed `.task` blocks in `.drip.dailynotes` older than 30 days
 * - Delete day files that are effectively empty (whitespace / shell only)
 * KB and project notes are never touched.
 */

const path = require('path');
const vscode = require('vscode');
const {
	getDailyNotesRootUri,
	isDailyNoteUri,
	DAILY_NOTES_DIR
} = require('./dailyNotesDrip');
const { isCompletedStatus, COMPLETED_FIELD } = require('../document/project/issueCompletedStamp');
const { parseFlexibleDateTime } = require('../document/parse/dripTxt/dripTxtDatetime.js');
const { removeFileFromDripIndex } = require('../indexing/dripIndexDb');
const { updateNoteInDripIndex } = require('../indexing/sync/dripTxt/dripTxtIndexUpdate.js');

const RETAIN_COMPLETED_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_SWEEP_STATE_KEY = 'drip.todayCleanup.lastSweepAt';

/**
 * @param {Date} [now]
 */
function currentMonthKey(now) {
	const d = now || new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Due when we have never swept, or last sweep was in a previous calendar month.
 * @param {string | undefined} lastSweepAt
 * @param {Date} [now]
 */
function isMonthlySweepDue(lastSweepAt, now) {
	if (!lastSweepAt) return true;
	const last = new Date(lastSweepAt);
	if (Number.isNaN(last.getTime())) return true;
	return currentMonthKey(last) !== currentMonthKey(now || new Date());
}

function lastSweepStateKey(kbRootUri) {
	const root = kbRootUri && kbRootUri.fsPath ? kbRootUri.fsPath.replace(/\\/g, '/').toLowerCase() : '';
	return root ? `${LAST_SWEEP_STATE_KEY}:${root}` : LAST_SWEEP_STATE_KEY;
}

/**
 * True when the note body has no user content beyond the file shell (header + h0).
 * Whitespace-only and metadata + date h0 alone count as empty.
 * @param {string} text
 */
function isTodayNoteEffectivelyEmpty(text) {
	const lines = String(text || '')
		.replace(/\r\n/g, '\n')
		.split('\n');
	let i = 0;
	while (i < lines.length && !/^\s*---\s*$/.test(lines[i])) i++;
	if (i < lines.length) i++;
	while (i < lines.length) {
		const raw = lines[i];
		const t = String(raw || '').trim();
		if (!t) {
			i++;
			continue;
		}
		if (/^@h\d+\s*$/i.test(t)) {
			i++;
			continue;
		}
		if (/^#+\d*\s+\./.test(t) || /^#\s+\./.test(t)) {
			i++;
			continue;
		}
		return false;
	}
	return true;
}

/**
 * Delete a Today day note immediately when it is only the shell (metadata + h0 / whitespace).
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @returns {Promise<boolean>} true when the file was deleted
 */
async function deleteTodayNoteIfEmpty(kbRootUri, noteUri) {
	if (!kbRootUri || !noteUri || !isDailyNoteUri(kbRootUri, noteUri)) return false;
	let text = '';
	try {
		text = Buffer.from(await vscode.workspace.fs.readFile(noteUri)).toString('utf8');
	} catch {
		return false;
	}
	if (!isTodayNoteEffectivelyEmpty(text)) return false;
	const rel = path.relative(kbRootUri.fsPath, noteUri.fsPath).replace(/\\/g, '/');
	try {
		await removeFileFromDripIndex(kbRootUri, rel);
	} catch {
		/* best-effort */
	}
	try {
		await vscode.workspace.fs.delete(noteUri, { useTrash: false });
		return true;
	} catch (err) {
		console.error('[DRIP] delete empty Today note failed', rel, err);
		return false;
	}
}

/**
 * @param {string} line
 * @returns {{ level: number, title: string } | null}
 */
function parseHeadingLine(line) {
	// `.d.txt` markers: `# Title`, `#1 Title`, `# . Title`
	const m2 = String(line || '').match(/^(#\d*)\s+(.*)$/);
	if (!m2) return null;
	const marker = m2[1];
	const lvl = marker === '#' ? 0 : parseInt(marker.slice(1), 10) || 0;
	return { level: lvl, title: String(m2[2] || '').trim() };
}

/**
 * Split a `.d.txt` note into heading blocks (line ranges). Includes pre-first-heading preamble.
 * @param {string} text
 * @returns {{ start: number, end: number, level: number, lines: string[] }[]}
 */
function splitTxtHeadingBlocks(text) {
	const lines = String(text || '')
		.replace(/\r\n/g, '\n')
		.split('\n');
	/** @type {{ start: number, end: number, level: number, lines: string[] }[]} */
	const blocks = [];
	/** @type {number[]} */
	const headingIdx = [];
	for (let i = 0; i < lines.length; i++) {
		if (parseHeadingLine(lines[i])) headingIdx.push(i);
	}
	if (!headingIdx.length) {
		return [{ start: 0, end: lines.length, level: -1, lines }];
	}
	if (headingIdx[0] > 0) {
		blocks.push({
			start: 0,
			end: headingIdx[0],
			level: -1,
			lines: lines.slice(0, headingIdx[0])
		});
	}
	for (let h = 0; h < headingIdx.length; h++) {
		const start = headingIdx[h];
		const parsed = parseHeadingLine(lines[start]);
		const level = parsed ? parsed.level : 0;
		let end = lines.length;
		for (let n = h + 1; n < headingIdx.length; n++) {
			const next = parseHeadingLine(lines[headingIdx[n]]);
			if (next && next.level <= level) {
				end = headingIdx[n];
				if (end > 0 && /^@h\d+\s*$/i.test(String(lines[end - 1] || '').trim())) {
					end -= 1;
				}
				break;
			}
		}
		// Include leading @hN identity line if present
		let blockStart = start;
		if (blockStart > 0 && /^@h\d+\s*$/i.test(String(lines[blockStart - 1] || '').trim())) {
			blockStart -= 1;
		}
		blocks.push({
			start: blockStart,
			end,
			level,
			lines: lines.slice(blockStart, end)
		});
	}
	return blocks;
}

/**
 * Read type + key/values from a heading block's indented metadata.
 * @param {string[]} blockLines
 */
function readBlockTaskMeta(blockLines) {
	/** @type {Record<string, string>} */
	const attrs = {};
	let typeId = '';
	let pastHeading = false;
	for (const line of blockLines) {
		const t = String(line || '');
		if (!pastHeading) {
			if (parseHeadingLine(t) || /^@h\d+\s*$/i.test(t.trim())) {
				if (parseHeadingLine(t)) pastHeading = true;
				continue;
			}
		}
		const trimmed = t.trim();
		if (/^\.\w+/.test(trimmed)) {
			typeId = trimmed.replace(/^\./, '').split(/\s+/)[0].toLowerCase();
			continue;
		}
		const kv = trimmed.match(/^([\w-]+)\s*:\s*(.*)$/);
		if (kv) {
			attrs[String(kv[1] || '').toLowerCase()] = String(kv[2] || '').trim();
		}
	}
	return { typeId, attrs };
}

/**
 * @param {string} text
 * @param {Date} [now]
 * @param {Date | null} [noteDay]
 * @returns {{ text: string, removed: number }}
 */
function removeOldCompletedTasksFromText(text, now, noteDay) {
	const when = now || new Date();
	const blocks = splitTxtHeadingBlocks(text);
	/** @type {string[]} */
	const kept = [];
	let removed = 0;
	for (const block of blocks) {
		if (block.level < 0) {
			kept.push(...block.lines);
			continue;
		}
		const { typeId, attrs } = readBlockTaskMeta(block.lines);
		if (typeId !== 'task' || !isCompletedStatus(attrs.status)) {
			kept.push(...block.lines);
			continue;
		}
		const stampRaw = attrs[COMPLETED_FIELD] || attrs.completed || '';
		let completedAt = parseFlexibleDateTime(String(stampRaw || '').trim(), when);
		if (!completedAt && noteDay) completedAt = noteDay;
		if (!completedAt || Number.isNaN(completedAt.getTime())) {
			kept.push(...block.lines);
			continue;
		}
		if (when.getTime() - completedAt.getTime() < RETAIN_COMPLETED_MS) {
			kept.push(...block.lines);
			continue;
		}
		removed += 1;
	}
	let out = kept.join('\n');
	if (!out.endsWith('\n')) out += '\n';
	return { text: out, removed };
}

/**
 * Parse MM-DD-YYYY from a daily note filename stem.
 * @param {string} fileName
 * @returns {Date | null}
 */
function dateFromDailyNoteFileName(fileName) {
	const stem = String(fileName || '').replace(/\.d\.txt$/i, '');
	const m = stem.match(/^(\d{2})-(\d{2})-(\d{4})$/);
	if (!m) return null;
	const month = parseInt(m[1], 10) - 1;
	const day = parseInt(m[2], 10);
	const year = parseInt(m[3], 10);
	const d = new Date(year, month, day);
	return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {import('vscode').Uri} dir
 * @returns {AsyncGenerator<import('vscode').Uri>}
 */
async function* walkDailyNoteFiles(dir) {
	let entries = [];
	try {
		entries = await vscode.workspace.fs.readDirectory(dir);
	} catch {
		return;
	}
	for (const [name, kind] of entries) {
		const child = vscode.Uri.joinPath(dir, name);
		if (kind === vscode.FileType.Directory) {
			yield* walkDailyNoteFiles(child);
		} else if (kind === vscode.FileType.File && name.toLowerCase().endsWith('.d.txt')) {
			yield child;
		}
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').ExtensionContext} context
 * @param {{ force?: boolean, now?: Date }} [options]
 */
async function runTodayCleanupIfDue(kbRootUri, context, options = {}) {
	if (!kbRootUri) return { ran: false, reason: 'no-kb' };
	const now = options.now || new Date();
	const key = lastSweepStateKey(kbRootUri);
	const last = context.workspaceState.get(key);
	if (!options.force && !isMonthlySweepDue(typeof last === 'string' ? last : undefined, now)) {
		return { ran: false, reason: 'not-due' };
	}
	const result = await runTodayCleanup(kbRootUri, context, { now });
	await context.workspaceState.update(key, now.toISOString());
	return { ran: true, ...result };
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').ExtensionContext | null | undefined} context
 * @param {{ now?: Date }} [options]
 */
async function runTodayCleanup(kbRootUri, context, options = {}) {
	const now = options.now || new Date();
	const root = getDailyNotesRootUri(kbRootUri);
	let tasksRemoved = 0;
	let filesDeleted = 0;
	let filesUpdated = 0;

	for await (const uri of walkDailyNoteFiles(root)) {
		if (!isDailyNoteUri(kbRootUri, uri)) continue;
		let text = '';
		try {
			text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		} catch {
			continue;
		}
		const noteDay = dateFromDailyNoteFileName(path.basename(uri.fsPath));
		const { text: next, removed } = removeOldCompletedTasksFromText(text, now, noteDay);
		tasksRemoved += removed;
		let finalText = removed ? next : text;

		if (isTodayNoteEffectivelyEmpty(finalText)) {
			const rel = path.relative(kbRootUri.fsPath, uri.fsPath).replace(/\\/g, '/');
			try {
				await removeFileFromDripIndex(kbRootUri, rel);
			} catch {
				/* best-effort */
			}
			try {
				await vscode.workspace.fs.delete(uri, { useTrash: false });
				filesDeleted += 1;
			} catch (err) {
				console.error('[DRIP] Today cleanup delete empty file failed', rel, err);
			}
			continue;
		}

		if (removed) {
			try {
				await vscode.workspace.fs.writeFile(uri, Buffer.from(finalText, 'utf8'));
				filesUpdated += 1;
				try {
					await updateNoteInDripIndex(kbRootUri, uri, context, { force: true, text: finalText });
				} catch (err) {
					console.error('[DRIP] Today cleanup reindex failed', uri.fsPath, err);
				}
			} catch (err) {
				console.error('[DRIP] Today cleanup write failed', uri.fsPath, err);
			}
		}
	}

	return { tasksRemoved, filesDeleted, filesUpdated };
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {{ getVerifiedKnowledgeBaseRoot?: () => import('vscode').Uri | undefined, getKnowledgeBaseRoot?: () => import('vscode').Uri | undefined }} state
 */
function registerTodayCleanupSweep(context, state) {
	const run = () => {
		const kb =
			(state.getVerifiedKnowledgeBaseRoot && state.getVerifiedKnowledgeBaseRoot()) ||
			(state.getKnowledgeBaseRoot && state.getKnowledgeBaseRoot());
		if (!kb) return;
		void runTodayCleanupIfDue(kb, context).then(result => {
			if (result && result.ran) {
				console.log(
					`[DRIP] Today cleanup: removed ${result.tasksRemoved} task(s), deleted ${result.filesDeleted} empty file(s), updated ${result.filesUpdated}`
				);
			}
		}).catch(err => console.error('[DRIP] Today cleanup failed', err));
	};
	return run;
}

module.exports = {
	RETAIN_COMPLETED_MS,
	isMonthlySweepDue,
	isTodayNoteEffectivelyEmpty,
	deleteTodayNoteIfEmpty,
	removeOldCompletedTasksFromText,
	runTodayCleanup,
	runTodayCleanupIfDue,
	registerTodayCleanupSweep,
	DAILY_NOTES_DIR
};
