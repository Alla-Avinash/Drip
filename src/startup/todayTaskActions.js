'use strict';

/**
 * Create / complete / reopen personal `.task` headings inside Today day notes.
 */

const vscode = require('vscode');
const {
	COMPLETED_FIELD,
	completedStampNow,
	isCompletedStatus
} = require('../document/project/issueCompletedStamp');
const { formatDateTimeToMinute } = require('../document/parse/dripTxt/dripTxtDatetime.js');
const { updateNoteInDripIndex } = require('../indexing/sync/dripTxt/dripTxtIndexUpdate.js');
const { ensureTodayDailyNote, dailyNoteRelPath } = require('./dailyNotesDrip');
const { DAILY_NOTES_DIR } = require('../shared/constants');

/**
 * @param {string} text
 * @param {number} headingId
 * @param {'completed' | 'to-do'} nextStatus
 * @returns {{ text: string, changed: boolean }}
 */
function patchTaskStatusInText(text, headingId, nextStatus) {
	const lines = String(text || '')
		.replace(/\r\n/g, '\n')
		.split('\n');
	const id = Math.floor(Number(headingId));
	const marker = `@h${id}`;
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (String(lines[i] || '').trim() === marker) {
			start = i;
			break;
		}
	}
	if (start < 0) return { text: String(text || ''), changed: false };

	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const t = String(lines[i] || '').trim();
		if (/^@h\d+\s*$/i.test(t)) {
			end = i;
			break;
		}
		if (/^#\d*\s+/.test(t) && i > start + 1) {
			// Next heading without @h (rare) — stop before it
			const prev = String(lines[i - 1] || '').trim();
			if (!/^@h\d+\s*$/i.test(prev)) {
				end = i;
				break;
			}
		}
	}

	const block = lines.slice(start, end);
	let typeLine = -1;
	for (let i = 0; i < block.length; i++) {
		if (/^\t*\.task\b/i.test(String(block[i] || '').trim()) || /^\.task\b/i.test(String(block[i] || '').trim())) {
			typeLine = i;
			break;
		}
	}
	if (typeLine < 0) return { text: String(text || ''), changed: false };

	const indentMatch = String(block[typeLine] || '').match(/^(\t*)/);
	const baseIndent = indentMatch ? indentMatch[1] : '\t';
	const fieldIndent = `${baseIndent}\t`;

	/** @type {Record<string, string>} */
	const fields = {};
	/** @type {number[]} */
	const fieldLineIdx = [];
	for (let i = typeLine + 1; i < block.length; i++) {
		const raw = String(block[i] || '');
		const trimmed = raw.trim();
		if (!trimmed) continue;
		if (/^\.\w+/.test(trimmed) || /^#\d*\s+/.test(trimmed) || /^@h\d+/i.test(trimmed)) break;
		const kv = trimmed.match(/^([\w-]+)\s*:\s*(.*)$/);
		if (!kv) continue;
		fields[String(kv[1] || '').toLowerCase()] = String(kv[2] || '').trim();
		fieldLineIdx.push(i);
	}

	const status = String(nextStatus || '').toLowerCase() === 'completed' ? 'completed' : 'to-do';
	fields.status = status;
	if (isCompletedStatus(status)) {
		if (!fields[COMPLETED_FIELD]) fields[COMPLETED_FIELD] = completedStampNow();
	} else {
		delete fields[COMPLETED_FIELD];
	}

	// Drop old field lines (from bottom) then insert fresh ones after type line
	for (let i = fieldLineIdx.length - 1; i >= 0; i--) {
		block.splice(fieldLineIdx[i], 1);
	}
	const preferred = ['status', 'priority', 'deadline', COMPLETED_FIELD, 'category'];
	const keys = [
		...preferred.filter(k => fields[k] != null && String(fields[k]).trim() !== ''),
		...Object.keys(fields).filter(k => !preferred.includes(k))
	];
	const insertAt = typeLine + 1;
	const newFieldLines = keys.map(k => `${fieldIndent}${k}: ${fields[k]}`);
	block.splice(insertAt, 0, ...newFieldLines);

	const next = [...lines.slice(0, start), ...block, ...lines.slice(end)];
	let out = next.join('\n');
	if (!out.endsWith('\n')) out += '\n';
	return { text: out, changed: true };
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} relPath
 * @param {number} headingId
 * @param {'completed' | 'to-do'} nextStatus
 * @param {import('vscode').ExtensionContext | null | undefined} context
 */
async function setTodayTaskStatus(kbRootUri, relPath, headingId, nextStatus, context) {
	const rel = String(relPath || '').replace(/\\/g, '/');
	if (!rel) throw new Error('Missing task path');
	const uri = vscode.Uri.joinPath(kbRootUri, ...rel.split('/'));
	const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
	const { text, changed } = patchTaskStatusInText(raw, headingId, nextStatus);
	if (!changed) throw new Error('Could not find that task in the day note');
	// Prefer open-buffer write + expected-disk mark so soft-lock does not ask about bulk edits.
	const { replaceOpenNoteOrWriteDisk } = require('../state/documentFileOps');
	await replaceOpenNoteOrWriteDisk(uri, text);
	await updateNoteInDripIndex(kbRootUri, uri, context, { force: true, text });
	return { uri, rel };
}

/**
 * Append a new `.task` heading to the day note for `date` (creates the note if needed).
 * Deadline defaults to 09:00 on that calendar day, or opts.deadline ("2 hrs" / absolute).
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {Date} date
 * @param {string} title
 * @param {import('vscode').ExtensionContext | null | undefined} context
 * @param {{ deadline?: string, hour?: number, minute?: number, priority?: string } | null | undefined} [opts]
 * @returns {Promise<{ uri: import('vscode').Uri, rel: string, headingId: number }>}
 */
async function createTodayTask(kbRootUri, date, title, context, opts) {
	const name = String(title || '').trim();
	if (!name) throw new Error('Task title is required');
	const day = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
	const options = opts && typeof opts === 'object' ? opts : {};

	const { uri } = await ensureTodayDailyNote(kbRootUri, day, { context });
	const rel = dailyNoteRelPath(day);
	let text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

	const { openDripTodayDb } = require('../indexing/dripTodayDb');
	const { allocateHeadingIdForFile } = require('../indexing/dripIndexDb');
	const { headingAllocScopeForNote } = require('../document/project/projectFileIds');

	let fileId = null;
	{
		const handle = openDripTodayDb(kbRootUri);
		try {
			const stmt = handle.db.prepare('SELECT id FROM files WHERE path = ?');
			stmt.bind([rel]);
			if (stmt.step()) {
				const row = stmt.get();
				fileId = Number(row[0]);
			}
			stmt.free();
		} finally {
			handle.close();
		}
	}
	if (fileId == null || !Number.isFinite(fileId)) {
		// Brand-new note may need one index pass before the files row exists.
		await updateNoteInDripIndex(kbRootUri, uri, context, { force: true, text });
		const handle = openDripTodayDb(kbRootUri);
		try {
			const stmt = handle.db.prepare('SELECT id FROM files WHERE path = ?');
			stmt.bind([rel]);
			if (stmt.step()) {
				const row = stmt.get();
				fileId = Number(row[0]);
			}
			stmt.free();
		} finally {
			handle.close();
		}
	}
	if (fileId == null || !Number.isFinite(fileId)) {
		throw new Error('Could not resolve Today note file id');
	}

	const scopeKey = headingAllocScopeForNote(kbRootUri, uri) || DAILY_NOTES_DIR;
	const headingId = await allocateHeadingIdForFile(kbRootUri, fileId, scopeKey);

	const { parseFlexibleDateTime } = require('../document/parse/dripTxt/dripTxtDatetime.js');
	let deadline = null;
	const deadlineRaw = String(options.deadline || '').trim();
	if (deadlineRaw) {
		deadline = parseFlexibleDateTime(deadlineRaw, new Date());
	}
	if (!deadline) {
		let hour = Number(options.hour);
		let minute = Number(options.minute);
		if (!Number.isFinite(hour) || hour < 0 || hour > 23) hour = 9;
		if (!Number.isFinite(minute) || minute < 0 || minute > 59) minute = 0;
		deadline = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);
	}
	const priorityRaw = String(options.priority || '')
		.trim()
		.toLowerCase();
	const priority = priorityRaw === 'high' || priorityRaw === 'low' ? priorityRaw : '';

	// Persistent typed heading: title shortcut + marker at level+1, fields at level+2.
	const { shortcutForTypeId } = require('../capture/noteDraft');
	const shortcut = shortcutForTypeId('task');
	/** @type {string[]} */
	const blockLines = [
		'',
		`@h${headingId}`,
		`# ${shortcut} ${name}`,
		'\t.task',
		'\t\tstatus: to-do',
		`\t\tdeadline: ${formatDateTimeToMinute(deadline)}`
	];
	if (priority) blockLines.push(`\t\tpriority: ${priority}`);
	blockLines.push('');
	const block = blockLines.join('\n');

	let next = String(text || '').replace(/\r\n/g, '\n');
	if (!next.endsWith('\n')) next += '\n';
	next += block.startsWith('\n') ? block.slice(1) : block;
	if (!next.endsWith('\n')) next += '\n';

	// Prefer open-buffer write + expected-disk mark so soft-lock does not ask about bulk edits.
	const { replaceOpenNoteOrWriteDisk } = require('../state/documentFileOps');
	await replaceOpenNoteOrWriteDisk(uri, next);
	await updateNoteInDripIndex(kbRootUri, uri, context, { force: true, text: next });
	return { uri, rel, headingId };
}

module.exports = {
	patchTaskStatusInText,
	setTodayTaskStatus,
	createTodayTask
};
