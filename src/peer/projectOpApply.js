'use strict';

/**
 * Apply a signed operation to project files, then the caller reindexes.
 * Idempotent: same op id or same uid create is a no-op.
 */

const vscode = require('vscode');
const { OP_TYPES, isKnownOpType, verifyOperation } = require('./projectOp');
const { appendOperation, pushNotice } = require('./projectOpLog');
const {
	readProjectRecord,
	writeProjectRecord,
	writeTagsFile,
	readTagsFile,
	writeMetadataFile,
	projectFolderUriFromPrefix
} = require('./projectSidecar');
const { memberOf } = require('./projectSharing');
const { findIssueInProject, listIssueKeysInProject } = require('./projectIssueLookup');
const { nextFreeNumber } = require('./projectRemint');
const { updateIssueBlockText, appendIssueNoteText, replaceIssueBodyText } = require('../document/project/issueBlockEdit');
const {
	PROJECT_ISSUES_FILE_NAME,
	FEATURE_INBOX_FILE_NAME
} = require('../document/project/projectStructureRules');
const { isDripFeatureFolderName } = require('../document/model/dripNoteFeature.js');
const { markExpectedDiskWrite } = require('../shared/documentEditGuard');
const { reprintProjectIssueFileAtPath } = require('../document/project/projectIssuesReprint');

async function writeReprintedIssueFile(uri, text) {
	const next = reprintProjectIssueFileAtPath(text, uri.fsPath, { allocateHeadingIds: false });
	await require('../state/documentFileOps').replaceOpenNoteOrWriteDisk(uri, next);
	try {
		require('./projectHandEdit').rememberHandEditBaseline(uri, next);
	} catch {
		/* baseline keeps the next save from re-sending this apply */
	}
}

async function readNoteText(uri) {
	return require('../state/documentFileOps').readNoteTextPreferEditor(uri);
}

/**
 * While the user is still typing in this note, do not replace a heading/issue
 * body with an older, shorter copy of the same text (or with an empty body).
 */
function keepDirtyLocalBody(uri, localBody, incomingBody) {
	const doc = require('../state/documentFileOps').findOpenTextDocument(uri);
	if (!doc || !doc.isDirty) return false;
	const local = String(localBody || '');
	const incoming = String(incomingBody || '');
	if (!local) return false;
	if (!incoming) return true;
	return local === incoming || local.startsWith(incoming);
}

/** @type {Map<string, Promise<unknown>>} */
const fileLocks = new Map();

function withFileLock(fsPath, fn) {
	const key = String(fsPath || '');
	const prev = fileLocks.get(key) || Promise.resolve();
	const next = prev.then(fn, fn);
	fileLocks.set(key, next.catch(() => {}));
	return next;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {object} op
 * @param {{ alreadyApplied?: boolean }} [opts]
 */
async function applyOperation(kbRootUri, folderPrefix, op, opts) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await readProjectRecord(folderUri);
	if (!rec || !rec.shared) return { ok: false, reason: 'not-shared' };
	try {
		if (!require('./projectLanSync').isSharingActive(rec.projectId)) {
			return { ok: false, reason: 'sharing-stopped' };
		}
	} catch {
		return { ok: false, reason: 'sharing-stopped' };
	}
	if (!op || !op.opId) return { ok: false, reason: 'bad-op' };

	const authorMember = memberOf(rec, op.author);
	if (!authorMember && op.type !== OP_TYPES.MEMBER_ACCEPT && op.type !== OP_TYPES.PROJECT_SHARE) {
		return { ok: false, reason: 'not-a-member' };
	}
	if (authorMember && authorMember.publicKey && op.signature) {
		if (!verifyOperation(op, authorMember.publicKey)) {
			return { ok: false, reason: 'bad-signature' };
		}
	}
	try {
		const { canApplyOp } = require('./projectRoles');
		if (!canApplyOp(rec, op)) return { ok: false, reason: 'forbidden' };
	} catch {
		return { ok: false, reason: 'forbidden' };
	}

	if (!isKnownOpType(op.type)) {
		await appendOperation(folderUri, op);
		await pushNotice(folderUri, 'Update DRIP to see a change from another member.');
		return { ok: true, skipped: 'unknown-type' };
	}

	if (opts && opts.alreadyApplied) {
		await appendOperation(folderUri, op);
		return { ok: true, skipped: 'already-applied' };
	}

	const { appended } = await appendOperation(folderUri, op);
	if (!appended) return { ok: true, skipped: 'duplicate' };

	try {
		const result = await applyPayload(kbRootUri, folderPrefix, folderUri, rec, op);
		return { ok: true, ...result };
	} catch (err) {
		const msg = err && err.message ? err.message : String(err);
		await pushNotice(folderUri, `Could not apply a change: ${msg}`);
		return { ok: false, reason: 'apply-failed', error: msg };
	}
}

async function applyPayload(kbRootUri, folderPrefix, folderUri, rec, op) {
	switch (op.type) {
		case OP_TYPES.ISSUE_CREATE:
			return applyIssueCreate(kbRootUri, folderPrefix, folderUri, op);
		case OP_TYPES.ISSUE_UPDATE:
			return applyIssueUpdate(kbRootUri, folderPrefix, op);
		case OP_TYPES.ISSUE_FIELD_SET:
			return applyIssueFieldSet(kbRootUri, folderPrefix, op);
		case OP_TYPES.ISSUE_TITLE_SET:
			return applyIssueTitleSet(kbRootUri, folderPrefix, op);
		case OP_TYPES.ISSUE_BODY_APPEND:
			return applyIssueBodyAppend(kbRootUri, folderPrefix, op);
		case OP_TYPES.ISSUE_BODY_SET:
			return applyIssueBodySet(kbRootUri, folderPrefix, op);
		case OP_TYPES.ISSUE_DELETE:
			return applyIssueDelete(kbRootUri, folderPrefix, op);
		case OP_TYPES.ISSUE_MOVE:
			return applyIssueMove(kbRootUri, folderPrefix, folderUri, op);
		case OP_TYPES.ISSUE_PARENT_SET:
			return applyIssueFieldSet(kbRootUri, folderPrefix, {
				...op,
				payload: { uid: op.payload.uid, field: 'parent', value: op.payload.parent || op.payload.value || '' }
			});
		case OP_TYPES.MEMBER_REMOVE: {
			const removed = (rec.members || []).find(m => m && m.peerId === op.payload.peerId);
			require('./projectSharing').dropPersonFromProject(rec, op.payload.peerId);
			await writeProjectRecord(folderUri, rec);
			if (removed) {
				try {
					require('./projectLanSync').dropPeerOnline(rec.projectId, removed.peerId);
					require('./projectShareNotify').announceMemberRemoved(folderPrefix, removed);
				} catch {
					/* UI refresh is optional */
				}
				await detachIfSelfRemoved(kbRootUri, folderPrefix, folderUri, rec, removed.peerId);
			}
			return { kind: 'member' };
		}
		case OP_TYPES.PROJECT_LEAVE: {
			const leaving = (rec.members || []).find(m => m && m.peerId === op.author) ||
				require('./projectSharing').pendingOf(rec, op.author);
			require('./projectSharing').dropPersonFromProject(rec, op.author);
			await writeProjectRecord(folderUri, rec);
			if (leaving) {
				try {
					require('./projectLanSync').dropPeerOnline(rec.projectId, op.author);
					const me = await require('./peerIdentity').ensurePeerIdentity();
					if (me.peerId !== op.author) {
						require('./projectShareNotify').announceMemberLeft(folderPrefix, leaving);
					} else {
						require('./projectShareNotify').refreshShareSurfaces(folderPrefix);
					}
				} catch {
					/* UI refresh is optional */
				}
			}
			return { kind: 'member' };
		}
		case OP_TYPES.PROJECT_UNSHARE: {
			// Admin closed the project: this machine becomes a solo copy too.
			await require('./projectSharing').detachLocalCopy(folderUri, rec);
			await require('./projectSharing').cleanupSharingMarkersOnDetach(kbRootUri, folderPrefix);
			await require('./projectOpLog').resetProjectLog(folderUri);
			try {
				require('./projectShareNotify').refreshShareSurfaces(folderPrefix);
				const me = await require('./peerIdentity').ensurePeerIdentity();
				void vscode.window.showInformationMessage(
					op.author === me.peerId
						? 'Project is solo again.'
						: 'The admin closed this project. This copy is now solo.'
				);
			} catch {
				/* UI refresh is optional */
			}
			return { kind: 'unshare' };
		}
		case OP_TYPES.JOIN_POLICY_SET: {
			const author = memberOf(rec, op.author);
			if (!author || author.role !== 'admin') return { kind: 'member', skipped: 'not-admin' };
			rec.allowGuests = !!(op.payload && op.payload.allowGuests);
			await writeProjectRecord(folderUri, rec);
			return { kind: 'member' };
		}
		case OP_TYPES.TEAM_UPSERT:
		case OP_TYPES.TEAM_DELETE:
		case OP_TYPES.TEAM_MEMBERS_SET:
		case OP_TYPES.TEAM_DEFAULT_SET:
		case OP_TYPES.MEMBER_ROLE_SET: {
			require('./projectTeams').applyTeamPayload(rec, op);
			await writeProjectRecord(folderUri, rec);
			return { kind: 'team' };
		}
		case OP_TYPES.ACCESS_CAPS_SET: {
			const role = String((op.payload && op.payload.role) || '').trim().toLowerCase();
			const cap = String((op.payload && op.payload.capability) || '');
			if (role && cap && ['member', 'updater', 'admin'].includes(role)) {
				if (!rec.accessCapabilities || typeof rec.accessCapabilities !== 'object') {
					rec.accessCapabilities = { member: '', updater: '', admin: '' };
				}
				rec.accessCapabilities[role] = cap;
				await writeProjectRecord(folderUri, rec);
			}
			return { kind: 'member' };
		}
		case OP_TYPES.MEMBER_ACCESS_REDEEM: {
			const role = require('./projectRoles').normalizeRole(op.payload && op.payload.role);
			const cap = String((op.payload && op.payload.capability) || '');
			const want = rec.accessCapabilities && rec.accessCapabilities[role];
			if (!want || String(want) !== cap) return { kind: 'member', skipped: 'bad-access' };
			const mine = memberOf(rec, op.author);
			if (mine) mine.role = role;
			await writeProjectRecord(folderUri, rec);
			return { kind: 'member' };
		}
		case OP_TYPES.CHAT_APPEND:
		case OP_TYPES.CHAT_CLEAR:
		case OP_TYPES.CHAT_READ: {
			await require('./projectChat').applyChatOp(folderUri, op, rec);
			try {
				require('../views/lhs/projects/panel').refreshProjectChatIfShown(folderPrefix);
			} catch {
				/* Project View may be closed */
			}
			return { kind: 'chat' };
		}
		case OP_TYPES.MEMBER_ACCEPT: {
			const incoming = op.payload && (op.payload.member || op.payload.pending);
			if (incoming && incoming.peerId && !memberOf(rec, incoming.peerId)) {
				const reason = require('./projectSharing').joinBlockReason(rec, incoming);
				if (reason) return { kind: 'member', skipped: 'blocked' };
				const fresh = require('./projectSharing').upsertPendingJoiner(rec, incoming);
				await writeProjectRecord(folderUri, rec);
				if (fresh) {
					try {
						require('./projectShareNotify').announceJoinRequested(folderPrefix, rec, incoming);
					} catch {
						/* UI refresh is optional */
					}
				}
			}
			return { kind: 'member' };
		}
		case OP_TYPES.MEMBER_ADMIT: {
			const incoming = op.payload && op.payload.member;
			if (incoming && incoming.peerId && !memberOf(rec, incoming.peerId)) {
				rec.members.push(incoming);
				require('./projectSharing').removePendingJoiner(rec, incoming.peerId);
				await writeProjectRecord(folderUri, rec);
				try {
					require('./projectShareNotify').announceMemberJoined(
						kbRootUri,
						folderPrefix,
						rec,
						incoming
					);
				} catch {
					/* UI refresh is optional */
				}
			}
			return { kind: 'member' };
		}
		case OP_TYPES.MEMBER_JOIN_DECLINE: {
			const peerId = String((op.payload && op.payload.peerId) || '');
			if (peerId) {
				require('./projectSharing').removePendingJoiner(rec, peerId);
				await writeProjectRecord(folderUri, rec);
			}
			return { kind: 'member' };
		}
		case OP_TYPES.TAG_CREATE:
		case OP_TYPES.TAG_RENAME:
		case OP_TYPES.TAG_DELETE:
			return applyTagOp(folderUri, op);
		case OP_TYPES.METADATA_SET:
			await writeMetadataFile(folderUri, op.payload && op.payload.overrides ? op.payload.overrides : {});
			return { kind: 'metadata' };
		case OP_TYPES.FEATURE_CREATE:
		case OP_TYPES.NOTE_CREATE:
		case OP_TYPES.NOTE_UPDATE:
		case OP_TYPES.CONCEPT_CREATE:
		case OP_TYPES.CONCEPT_UPDATE:
		case OP_TYPES.DECISION_CREATE:
		case OP_TYPES.DECISION_UPDATE:
			return applyFileWrite(kbRootUri, folderPrefix, folderUri, op);
		case OP_TYPES.CONCEPT_DELETE:
		case OP_TYPES.DECISION_DELETE:
			return applyFileDelete(folderUri, op);
		case OP_TYPES.NOTE_HEADING_BODY_SET:
			return applyHeadingBodySet(kbRootUri, folderUri, op);
		case OP_TYPES.HEADING_DELETE:
			return applyHeadingDelete(folderUri, op);
		case OP_TYPES.PROJECT_COMPACT:
			return applyProjectCompact(folderUri, op);
		case OP_TYPES.MAILBOX_REPO_SET: {
			const repo = require('./projectMailbox').parseMailboxRepo(op.payload && op.payload.repo);
			rec.mailboxRepo = repo;
			await writeProjectRecord(folderUri, rec);
			return { kind: 'mailbox' };
		}
		default:
			return { kind: 'stored' };
	}
}

async function applyIssueCreate(kbRootUri, folderPrefix, folderUri, op) {
	const uid = String((op.payload && op.payload.uid) || '');
	const requested = String((op.payload && op.payload.issueKey) || '').toLowerCase();
	if (uid) {
		const existing = await findIssueInProject(kbRootUri, folderPrefix, { uid });
		if (existing) return { kind: 'issue', skipped: 'exists' };
	}
	const destUri = await destUriForIssueCreate(folderUri, op.payload);
	let issueKey = requested;
	if (requested) {
		const taken = await findIssueInProject(kbRootUri, folderPrefix, { issueKey: requested });
		if (taken) {
			const sameFile =
				taken.uri &&
				String(taken.uri.fsPath || '').replace(/\\/g, '/').toLowerCase() ===
					String(destUri.fsPath || '').replace(/\\/g, '/').toLowerCase();
			if (sameFile) return { kind: 'issue', skipped: 'exists' };
			if (taken.attributes.uid && taken.attributes.uid !== uid) {
				const keys = await listIssueKeysInProject(kbRootUri, folderPrefix);
				const nums = keys.map(k => parseInt(String(k.issueId).replace(/^i-/i, ''), 10)).filter(n => n > 0);
				const n = nextFreeNumber(nums);
				issueKey = `i-${n}`;
				await pushNotice(
					folderUri,
					`Issue number changed to ${issueKey} — someone else had already used ${requested} offline.`
				);
			}
		}
	}
	await ensureIssueDestFile(kbRootUri, folderUri, destUri, op.payload);
	await withFileLock(destUri.fsPath, async () => {
		let text = await readNoteText(destUri);
		if (!String(text).trim()) {
			text = await stubIssueDestText(kbRootUri, destUri, op.payload);
		}
		const {
			findIssueHeadingBlock,
			formatFromPath
		} = require('../document/project/issueInboxLayout');
		const { collectIssueIds } = require('./projectHiddenIds');
		const { readIssueBlock } = require('../document/project/issueBlockEdit');
		const fmt = formatFromPath(destUri.fsPath);
		if (uid) {
			for (const issueId of collectIssueIds(text, fmt)) {
				const block = readIssueBlock(text, issueId, fmt);
				if (block && String((block.attributes && block.attributes.uid) || '').trim() === uid) {
					return;
				}
			}
		}
		if (requested && findIssueHeadingBlock(text, requested, fmt)) {
			return;
		}
		if (issueKey && findIssueHeadingBlock(text, issueKey, fmt)) {
			return;
		}
		const { formatNewIssueBlock } = require('../document/project/projectIssuesMailbox');
		const { convertIssueBlockLines } = require('../document/project/issueBlockFormat');
		const {
			appendIssueToInbox: append,
			appendIssueAtFileRoot,
			appendSubIssueUnderParent,
			ensureHeadingPath,
			appendBlockUnderHeading,
			isIssueLikeHeadingTitle
		} = require('../document/project/issueInboxLayout');
		const rawBlock = formatNewIssueBlock({
			issueId: issueKey || requested,
			title: (op.payload && op.payload.title) || 'Issue',
			parentIssueId: (op.payload && op.payload.parentIssueId) || null,
			uid,
			headingNum: op.payload && op.payload.headingNum
		})
			.split('\n')
			.filter((l, i, all) => i < all.length - 1 || l.trim());
		const block = convertIssueBlockLines(rawBlock, 'drip-txt', fmt);
		const parentId = String((op.payload && op.payload.parentIssueId) || '').trim();
		const headingPath = String((op.payload && op.payload.headingPath) || '').trim();
		const pathLooksLikeIssue = headingPath
			.split('/')
			.map(s => s.trim())
			.filter(Boolean)
			.every(c => isIssueLikeHeadingTitle(c));
		let next = null;
		if (parentId) {
			next = appendSubIssueUnderParent(text, parentId, block, fmt);
		}
		if (!next && headingPath && !pathLooksLikeIssue) {
			const withPath = ensureHeadingPath(text, headingPath, fmt);
			next = appendBlockUnderHeading(withPath, headingPath, block, fmt);
		}
		if (!next) {
			const base = require('path').basename(destUri.fsPath).toLowerCase();
			const useInbox =
				base === String(FEATURE_INBOX_FILE_NAME).toLowerCase() ||
				base === String(PROJECT_ISSUES_FILE_NAME).toLowerCase();
			next = useInbox ? append(text, block, undefined, fmt) : appendIssueAtFileRoot(text, block, fmt);
		}
		const attrs = op.payload && op.payload.attributes && typeof op.payload.attributes === 'object'
			? op.payload.attributes
			: null;
		if (attrs && Object.keys(attrs).length) {
			const patched = updateIssueBlockText(next, issueKey || requested, { attributes: attrs }, fmt);
			if (patched.ok) next = patched.text;
		}
		const body = op.payload && op.payload.body != null ? String(op.payload.body) : '';
		if (body.trim()) {
			const patched = replaceIssueBodyText(next, issueKey || requested, body, fmt);
			if (patched.ok) next = patched.text;
		}
		await writeReprintedIssueFile(destUri, next);
	});
	try {
		const { indexNewNoteImmediately } = require('../indexing/dripTxt/dripTxtIndex');
		await indexNewNoteImmediately(kbRootUri, destUri);
	} catch {
		/* index catch-up is best-effort */
	}
	return { kind: 'issue', issueKey, dest: destUri.fsPath };
}

/**
 * Create lands in the same project-relative file the change names.
 * Only an older change with no file name uses the project inbox.
 * @param {import('vscode').Uri} projectFolderUri
 * @param {{ rel?: string }} [payload]
 */
async function destUriForIssueCreate(projectFolderUri, payload) {
	const rel = String((payload && payload.rel) || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	if (!rel) {
		return vscode.Uri.joinPath(projectFolderUri, PROJECT_ISSUES_FILE_NAME);
	}
	let dest = vscode.Uri.joinPath(projectFolderUri, ...rel.split('/').filter(Boolean));
	try {
		const st = await vscode.workspace.fs.stat(dest);
		if ((st.type & vscode.FileType.Directory) !== 0 || isDripFeatureFolderName(rel.split('/').pop() || '')) {
			return vscode.Uri.joinPath(dest, FEATURE_INBOX_FILE_NAME);
		}
	} catch {
		if (isDripFeatureFolderName(rel.split('/').pop() || '')) {
			return vscode.Uri.joinPath(dest, FEATURE_INBOX_FILE_NAME);
		}
	}
	return dest;
}

/**
 * If the named file is missing, ask a live peer for that one file; otherwise
 * create the folders and a stub note so the issue can still land in the same place.
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} folderUri
 * @param {import('vscode').Uri} destUri
 * @param {{ rel?: string }} [payload]
 */
async function ensureIssueDestFile(kbRootUri, folderUri, destUri, payload) {
	const rel = String((payload && payload.rel) || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	const parentFs = require('path').dirname(destUri.fsPath);
	if (parentFs && parentFs !== destUri.fsPath) {
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(parentFs));
	}
	try {
		const st = await vscode.workspace.fs.stat(destUri);
		if ((st.type & vscode.FileType.File) !== 0) return;
	} catch {
		/* missing — fill from a peer or a stub */
	}
	if (rel) {
		try {
			const fetched = await require('./projectLanSync').requestPeerFile(folderUri, rel);
			if (fetched != null) {
				markExpectedDiskWrite(destUri);
				await vscode.workspace.fs.writeFile(destUri, Buffer.from(fetched, 'utf8'));
				return;
			}
		} catch {
			/* live peer is optional */
		}
	}
	const stub = await stubIssueDestText(kbRootUri, destUri, payload);
	markExpectedDiskWrite(destUri);
	await vscode.workspace.fs.writeFile(destUri, Buffer.from(stub, 'utf8'));
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} destUri
 * @param {{ rel?: string }} [payload]
 */
async function stubIssueDestText(kbRootUri, destUri, payload) {
	const { buildNewNoteFile } = require('../document/dripNoteKbOps');
	const { allocateNextEntityNumber } = require('../indexing/dripTxt/dripTxtIndex');
	const rel = String((payload && payload.rel) || destUri.path || '')
		.replace(/\\/g, '/')
		.split('/')
		.filter(Boolean)
		.pop() || 'note';
	const stem = rel.replace(/\.(d\.)?(txt|md)$/i, '').replace(/\.f$/i, '') || 'note';
	const isFeature = /\.f(\.|$)/i.test(rel) || isDripFeatureFolderName(rel);
	let n = 0;
	try {
		n = await allocateNextEntityNumber(kbRootUri, destUri);
	} catch {
		n = 0;
	}
	return buildNewNoteFile(
		{ title: stem, content: '', metadataFilename: stem },
		{
			fileEntityNumber: n,
			h0TypeMarker: isFeature ? '.f' : '.',
			format: /\.md$/i.test(destUri.fsPath) ? 'drip-md' : undefined
		}
	);
}

async function applyIssueFieldSet(kbRootUri, folderPrefix, op) {
	const found = await findIssueInProject(kbRootUri, folderPrefix, { uid: op.payload.uid });
	if (!found) return { kind: 'issue', skipped: 'missing' };
	const field = String((op.payload && op.payload.field) || '').toLowerCase();
	if (!field) return { kind: 'issue', skipped: 'no-field' };
	await withFileLock(found.uri.fsPath, async () => {
		const text = await readNoteText(found.uri);
		const updated = updateIssueBlockText(
			text,
			found.issueId,
			{ attributes: { [field]: String((op.payload && op.payload.value) || '') } },
			found.format
		);
		if (updated.ok) {
			await writeReprintedIssueFile(found.uri, updated.text);
		}
	});
	return { kind: 'issue' };
}

async function applyIssueUpdate(kbRootUri, folderPrefix, op) {
	const found = await findIssueInProject(kbRootUri, folderPrefix, { uid: op.payload && op.payload.uid });
	if (!found) return { kind: 'issue', skipped: 'missing' };
	const payload = op.payload || {};
	await withFileLock(found.uri.fsPath, async () => {
		let text = await readNoteText(found.uri);
		if (payload.title != null) {
			const patched = updateIssueBlockText(
				text,
				found.issueId,
				{ title: String(payload.title) },
				found.format
			);
			if (patched.ok) text = patched.text;
		}
		if (payload.attributes && typeof payload.attributes === 'object') {
			const patched = updateIssueBlockText(
				text,
				found.issueId,
				{ attributes: payload.attributes },
				found.format
			);
			if (patched.ok) text = patched.text;
		}
		if (Object.prototype.hasOwnProperty.call(payload, 'body')) {
			const incoming = String(payload.body || '');
			const { readIssueBlock } = require('../document/project/issueBlockEdit');
			const local = readIssueBlock(text, found.issueId, found.format);
			if (!keepDirtyLocalBody(found.uri, local && local.body, incoming)) {
				const patched = replaceIssueBodyText(text, found.issueId, incoming, found.format);
				if (patched.ok) text = patched.text;
			}
		}
		await writeReprintedIssueFile(found.uri, text);
	});
	return { kind: 'issue' };
}

async function applyIssueTitleSet(kbRootUri, folderPrefix, op) {
	const found = await findIssueInProject(kbRootUri, folderPrefix, { uid: op.payload.uid });
	if (!found) return { kind: 'issue', skipped: 'missing' };
	await withFileLock(found.uri.fsPath, async () => {
		const text = await readNoteText(found.uri);
		const updated = updateIssueBlockText(
			text,
			found.issueId,
			{ title: String((op.payload && op.payload.title) || found.title) },
			found.format
		);
		if (updated.ok) {
			await writeReprintedIssueFile(found.uri, updated.text);
		}
	});
	return { kind: 'issue' };
}

async function applyIssueBodyAppend(kbRootUri, folderPrefix, op) {
	const found = await findIssueInProject(kbRootUri, folderPrefix, { uid: op.payload.uid });
	if (!found) return { kind: 'issue', skipped: 'missing' };
	await withFileLock(found.uri.fsPath, async () => {
		const text = await readNoteText(found.uri);
		const updated = appendIssueNoteText(
			text,
			found.issueId,
			String((op.payload && op.payload.note) || ''),
			found.format
		);
		if (updated.ok) {
			await writeReprintedIssueFile(found.uri, updated.text);
		}
	});
	return { kind: 'issue' };
}

async function applyIssueBodySet(kbRootUri, folderPrefix, op) {
	const found = await findIssueInProject(kbRootUri, folderPrefix, { uid: op.payload.uid });
	if (!found) return { kind: 'issue', skipped: 'missing' };
	await withFileLock(found.uri.fsPath, async () => {
		const text = await readNoteText(found.uri);
		const incoming = String((op.payload && op.payload.body) || '');
		const { readIssueBlock } = require('../document/project/issueBlockEdit');
		const local = readIssueBlock(text, found.issueId, found.format);
		if (keepDirtyLocalBody(found.uri, local && local.body, incoming)) {
			return;
		}
		const updated = replaceIssueBodyText(text, found.issueId, incoming, found.format);
		if (updated.ok) {
			await writeReprintedIssueFile(found.uri, updated.text);
		}
	});
	return { kind: 'issue' };
}

async function applyHeadingBodySet(kbRootUri, folderUri, op) {
	const payload = op.payload || {};
	const destUri = await destUriForIssueCreate(folderUri, payload);
	await ensureIssueDestFile(kbRootUri, folderUri, destUri, payload);
	const headingPath = String(payload.headingPath || '').trim();
	if (!headingPath) return { kind: 'heading', skipped: 'no-path' };
	await withFileLock(destUri.fsPath, async () => {
		let text = await readNoteText(destUri);
		if (!String(text).trim()) {
			text = await stubIssueDestText(kbRootUri, destUri, payload);
		}
		const {
			formatFromPath,
			ensureHeadingPath,
			replaceHeadingOwnBody,
			readHeadingOwnBody
		} = require('../document/project/issueInboxLayout');
		const fmt = formatFromPath(destUri.fsPath);
		const withPath = ensureHeadingPath(text, headingPath, fmt);
		const incoming = payload.body != null ? String(payload.body) : '';
		const localBody = readHeadingOwnBody(withPath, headingPath, fmt);
		const keepBody =
			keepDirtyLocalBody(destUri, localBody, incoming) ||
			(!incoming.trim() && String(localBody || '').trim());
		const next = keepBody
			? withPath
			: replaceHeadingOwnBody(withPath, headingPath, incoming, fmt);
		await writeReprintedIssueFile(destUri, next || withPath);
	});
	return { kind: 'heading' };
}

async function applyHeadingDelete(folderUri, op) {
	const payload = op.payload || {};
	const destUri = await destUriForIssueCreate(folderUri, payload);
	const headingPath = String(payload.headingPath || '').trim();
	if (!headingPath) return { kind: 'heading', skipped: 'no-path' };
	try {
		await vscode.workspace.fs.stat(destUri);
	} catch {
		return { kind: 'heading', skipped: 'missing-file' };
	}
	await withFileLock(destUri.fsPath, async () => {
		const text = await readNoteText(destUri);
		const { formatFromPath, removeHeadingKeepChildren } = require('../document/project/issueInboxLayout');
		const next = removeHeadingKeepChildren(text, headingPath, formatFromPath(destUri.fsPath));
		if (next != null) await writeReprintedIssueFile(destUri, next);
	});
	return { kind: 'heading' };
}

function detectIncomingFileKind(rel) {
	const n = String(rel || '').replace(/\\/g, '/').toLowerCase();
	if (n.includes('/_concepts/') || n.startsWith('_concepts/')) return 'concept';
	if (n.includes('/_decisions/') || n.startsWith('_decisions/')) return 'decision';
	if (/(^|\/)[^/]+\.f(\/|\.d\.)/.test(n)) return 'feature';
	return 'note';
}

async function applyFileWrite(kbRootUri, folderPrefix, folderUri, op) {
	const payload = op.payload || {};
	const folderRel = String(payload.folderRel || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	if (folderRel) {
		const dir = vscode.Uri.joinPath(folderUri, ...folderRel.split('/').filter(Boolean));
		await vscode.workspace.fs.createDirectory(dir);
	}
	const rel = String(payload.rel || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	if (!rel) return { kind: 'file', skipped: 'no-rel' };
	const dest = vscode.Uri.joinPath(folderUri, ...rel.split('/').filter(Boolean));
	const parentParts = rel.split('/').filter(Boolean).slice(0, -1);
	if (parentParts.length) {
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folderUri, ...parentParts));
	}
	let text = payload.text != null ? String(payload.text) : '';
	const kind = String(payload.kind || detectIncomingFileKind(rel));
	if (kind === 'concept' || kind === 'decision') {
		text = await remintIncomingTypedKeys(
			kbRootUri,
			folderPrefix,
			folderUri,
			dest,
			text,
			kind === 'decision' ? 'd' : 'c'
		);
	}
	await withFileLock(dest.fsPath, async () => {
		await require('../state/documentFileOps').replaceOpenNoteOrWriteDisk(dest, text);
	});
	try {
		require('./projectHandEdit').rememberHandEditBaseline(dest, text);
	} catch {
		/* baseline keeps the next save from re-sending this write */
	}
	try {
		const { indexNewNoteImmediately } = require('../indexing/dripTxt/dripTxtIndex');
		await indexNewNoteImmediately(kbRootUri, dest);
	} catch {
		/* index catch-up is best-effort */
	}
	return { kind: 'file', dest: dest.fsPath };
}

async function applyFileDelete(folderUri, op) {
	const rel = String((op.payload && op.payload.rel) || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	if (!rel) return { kind: 'file', skipped: 'no-rel' };
	const dest = vscode.Uri.joinPath(folderUri, ...rel.split('/').filter(Boolean));
	try {
		await vscode.workspace.fs.delete(dest);
	} catch {
		/* already gone */
	}
	return { kind: 'file' };
}

async function remintIncomingTypedKeys(kbRootUri, folderPrefix, folderUri, destUri, text, letter) {
	const { noteFormatForPath } = require('../document/model/dripNoteFileTypes.js');
	const { collectTypedEntityIds, readTypedEntityUid, renameTypedHeadingKey } = require('./projectHiddenIds');
	const { listTypedKeysInProject } = require('./projectIssueLookup');
	const fmt = noteFormatForPath(destUri.fsPath) === '.d.md' ? 'drip-md' : 'drip-txt';
	const taken = await listTypedKeysInProject(kbRootUri, folderPrefix, letter, destUri);
	const used = taken.map(t => t.num).filter(n => n > 0);
	let next = String(text || '');
	for (const id of collectTypedEntityIds(next, fmt, letter)) {
		const uid = readTypedEntityUid(next, id, fmt);
		const clash = taken.find(t => t.key === id && t.uid && uid && t.uid !== uid);
		if (!clash) {
			const n = parseInt(String(id).replace(new RegExp(`^${letter}-`, 'i'), ''), 10);
			if (n > 0 && !used.includes(n)) used.push(n);
			continue;
		}
		const n = nextFreeNumber(used);
		used.push(n);
		const toKey = `${letter}-${n}`;
		next = renameTypedHeadingKey(next, fmt, id, toKey, letter);
		await pushNotice(
			folderUri,
			`${letter === 'd' ? 'Decision' : 'Concept'} number changed to ${toKey} — someone else had already used ${id} offline.`
		);
	}
	return next;
}

async function applyProjectCompact(folderUri, op) {
	const { readSyncState, writeSyncState } = require('./projectSidecar');
	const { trimOpsCoveredByVector } = require('./projectOpLog');
	const sync = await readSyncState(folderUri);
	sync.compactedVector = (op.payload && op.payload.vector) || {};
	sync.lastCompactAt = op.createdAt || new Date().toISOString();
	await writeSyncState(folderUri, sync);
	await trimOpsCoveredByVector(folderUri, sync.compactedVector, op.opId);
	return { kind: 'compact' };
}

async function applyIssueMove(kbRootUri, folderPrefix, folderUri, op) {
	const found = await findIssueInProject(kbRootUri, folderPrefix, {
		uid: op.payload && op.payload.uid,
		issueKey: op.payload && op.payload.issueKey
	});
	if (!found) return { kind: 'issue', skipped: 'missing' };
	const { moveIssueBlock, deserializeMoveTarget } = require('../document/project/projectIssuesMailbox');
	let target = deserializeMoveTarget(folderUri, (op.payload && op.payload.target) || { kind: 'inbox' });
	if (target.kind === 'issue' && !target.fileUri && target.issueId) {
		const parent = await findIssueInProject(kbRootUri, folderPrefix, { issueKey: target.issueId });
		if (!parent) return { kind: 'issue', skipped: 'missing-target' };
		target = { ...target, fileUri: parent.uri };
	}
	await withFileLock(found.uri.fsPath, async () => {
		await moveIssueBlock(kbRootUri, found.uri, folderUri, target, found.issueId, {
			removeParent: !!(op.payload && op.payload.removeParent),
			skipOpRecord: true
		});
	});
	return { kind: 'issue' };
}

async function applyIssueDelete(kbRootUri, folderPrefix, op) {
	const found = await findIssueInProject(kbRootUri, folderPrefix, { uid: op.payload.uid });
	if (!found) return { kind: 'issue', skipped: 'missing' };
	const { findIssueHeadingBlock } = require('../document/project/issueInboxLayout');
	await withFileLock(found.uri.fsPath, async () => {
		const text = await readNoteText(found.uri);
		const block = findIssueHeadingBlock(text, found.issueId, found.format);
		if (!block) return;
		const lines = block.lines.slice();
		lines.splice(block.start, block.end - block.start);
		await writeReprintedIssueFile(found.uri, lines.join('\n'));
	});
	return { kind: 'issue' };
}

async function applyTagOp(folderUri, op) {
	const graph = (await readTagsFile(folderUri)) || { version: 2, nodes: [], links: [], groups: [] };
	const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
	if (op.type === OP_TYPES.TAG_CREATE && op.payload && op.payload.node) {
		if (!nodes.some(n => n && n.id === op.payload.node.id)) nodes.push(op.payload.node);
	} else if (op.type === OP_TYPES.TAG_RENAME && op.payload && op.payload.id) {
		const n = nodes.find(x => x && x.id === op.payload.id);
		if (n) n.label = String(op.payload.name || n.label);
	} else if (op.type === OP_TYPES.TAG_DELETE && op.payload && op.payload.id) {
		graph.nodes = nodes.filter(n => n && n.id !== op.payload.id);
		graph.links = (graph.links || []).filter(
			l => l && l.source !== op.payload.id && l.target !== op.payload.id
		);
	}
	if (op.type !== OP_TYPES.TAG_DELETE) graph.nodes = nodes;
	await writeTagsFile(folderUri, graph);
	return { kind: 'tag' };
}

async function detachIfSelfRemoved(kbRootUri, folderPrefix, folderUri, rec, removedPeerId) {
	try {
		const me = await require('./peerIdentity').ensurePeerIdentity();
		if (!me || me.peerId !== removedPeerId) return;
		await require('./projectSharing').detachLocalCopy(folderUri, rec);
		await require('./projectSharing').cleanupSharingMarkersOnDetach(kbRootUri, folderPrefix);
		try {
			const vscode = require('vscode');
			void vscode.window.showWarningMessage(
				'You were removed from this project. This copy is now solo. You can ask to join again later with a project invite.'
			);
		} catch {
			/* notice is optional */
		}
	} catch {
		/* still rejected as a member */
	}
}

module.exports = {
	applyOperation,
	withFileLock
};
