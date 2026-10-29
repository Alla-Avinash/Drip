'use strict';

/**
 * Short scratch talk for a shared project. Rooms are per hidden uid, per team,
 * per direct-message pair, or the whole project. Chat is capped and clear drops
 * a room. Unread state and a mentions scan live here too.
 */

const vscode = require('vscode');
const { newPrefixedId } = require('./peerIds');
const { ensurePeerIdentity, signPayload, verifyPayload } = require('./peerIdentity');
const { sidecarDirUri, readProjectRecord } = require('./projectSidecar');
const { memberPublicName } = require('./projectSharing');
const {
	newRoomKey,
	sealRoomKeyTo,
	openRoomKeyFrom,
	sealMessage,
	openMessage,
	roomKeyState,
	storeRoomKeyGeneration,
	pruneRoomKeys
} = require('./projectChatCrypto');

const CHAT_MAX = 100;
// Mentions are `@githubLogin` or `#guestname`.
const MENTION_RE = /[@#]([a-z0-9][a-z0-9._-]{0,40})/gi;
// Key in reads.json holding the newest-mention timestamp this person has seen.
const MENTION_READS_KEY = '__mentions__';
// Short-lived cache of issue uid -> i-N key maps (per project folder).
const uidToKeyCache = new Map();

function chatDirUri(projectFolderUri) {
	return vscode.Uri.joinPath(sidecarDirUri(projectFolderUri), 'chat');
}

function chatFileUri(projectFolderUri, room, id) {
	const kind = String(room || '');
	if (kind === 'issue') {
		const uid = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
		if (!uid) throw new Error('Issue talk needs a hidden id.');
		return vscode.Uri.joinPath(chatDirUri(projectFolderUri), 'issues', `${uid}.json`);
	}
	if (kind === 'team') {
		const teamId = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
		if (!teamId) throw new Error('Team talk needs a team.');
		return vscode.Uri.joinPath(chatDirUri(projectFolderUri), 'teams', `${teamId}.json`);
	}
	if (kind === 'dm') {
		const dmId = String(id || '').replace(/[^a-zA-Z0-9:_-]/g, '');
		if (!dmId) throw new Error('Direct message needs a peer.');
		return vscode.Uri.joinPath(chatDirUri(projectFolderUri), 'dm', `${dmId}.json`);
	}
	return vscode.Uri.joinPath(chatDirUri(projectFolderUri), 'project.json');
}

/** Stable, order-independent id for a two-person room. */
function dmRoomId(peerA, peerB) {
	return [String(peerA || ''), String(peerB || '')].sort().join(':');
}

/** Stable key for the unread map. */
function roomKey(room, id) {
	const kind = String(room || 'project');
	if (kind === 'project') return 'project';
	return `${kind}:${String(id || '')}`;
}

function readsFileUri(projectFolderUri) {
	return vscode.Uri.joinPath(chatDirUri(projectFolderUri), 'reads.json');
}

/** Read receipts from other peers, used for blue ticks: `{ [roomKey]: { [peerId]: msgId } }`. */
function readReceiptsFileUri(projectFolderUri) {
	return vscode.Uri.joinPath(chatDirUri(projectFolderUri), 'readReceipts.json');
}

async function readReadReceipts(projectFolderUri) {
	try {
		const buf = await vscode.workspace.fs.readFile(readReceiptsFileUri(projectFolderUri));
		const parsed = JSON.parse(Buffer.from(buf).toString('utf8'));
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

async function writeReadReceipts(projectFolderUri, receipts) {
	await vscode.workspace.fs.createDirectory(chatDirUri(projectFolderUri));
	await vscode.workspace.fs.writeFile(
		readReceiptsFileUri(projectFolderUri),
		Buffer.from(JSON.stringify(receipts, null, 2), 'utf8')
	);
}

async function readChatFile(uri) {
	try {
		const buf = await vscode.workspace.fs.readFile(uri);
		const parsed = JSON.parse(Buffer.from(buf).toString('utf8'));
		const messages = Array.isArray(parsed && parsed.messages) ? parsed.messages : [];
		return { version: 1, messages };
	} catch {
		return { version: 1, messages: [] };
	}
}

async function writeChatFile(uri, data) {
	const parent = vscode.Uri.joinPath(uri, '..');
	await vscode.workspace.fs.createDirectory(parent);
	const messages = (data.messages || []).slice(-CHAT_MAX);
	await vscode.workspace.fs.writeFile(
		uri,
		Buffer.from(JSON.stringify({ version: 1, messages }, null, 2), 'utf8')
	);
	return { version: 1, messages };
}

async function readReads(projectFolderUri) {
	try {
		const buf = await vscode.workspace.fs.readFile(readsFileUri(projectFolderUri));
		const parsed = JSON.parse(Buffer.from(buf).toString('utf8'));
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

async function writeReads(projectFolderUri, reads) {
	await vscode.workspace.fs.createDirectory(chatDirUri(projectFolderUri));
	await vscode.workspace.fs.writeFile(
		readsFileUri(projectFolderUri),
		Buffer.from(JSON.stringify(reads, null, 2), 'utf8')
	);
}

function mentionsIn(text) {
	const out = [];
	const s = String(text || '');
	let m;
	const re = new RegExp(MENTION_RE.source, 'gi');
	while ((m = re.exec(s))) {
		const prefix = m[0][0];
		const name = String(m[1] || '').toLowerCase();
		const token = prefix + name;
		if (name && !out.includes(token)) out.push(token);
	}
	return out;
}

/** The `@team-name` mention token for a team (spaces and other symbols become dashes). */
function teamMentionToken(team) {
	const name = String((team && team.name) || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9_-]/g, '');
	return name ? `@${name}` : '';
}

/** Find the team a mention token refers to (case-insensitive, dash-normalized). */
function matchTeamMention(token, teams) {
	const want = String(token || '').toLowerCase().replace(/^@/, '');
	if (!want) return null;
	return (teams || []).find(t => {
		const tName = String(t && t.name || '')
			.trim()
			.toLowerCase()
			.replace(/\s+/g, '-')
			.replace(/[^a-z0-9_-]/g, '');
		return tName === want && tName !== '';
	}) || null;
}

/** Teams mentioned in a message, by the `@team-name` tokens present in the text. */
function teamMentionsIn(text, teams) {
	const out = [];
	if (!(teams || []).length) return out;
	for (const token of mentionsIn(text)) {
		const t = matchTeamMention(token, teams);
		if (t && !out.some(x => x.id === t.id)) out.push(t);
	}
	return out;
}

/** The mention tokens (lowercased) that identify this person. */
function mentionTokensFor(person) {
	const tokens = [];
	const login = String((person && person.githubLogin) || '').trim().replace(/^@/, '').toLowerCase();
	if (login) tokens.push(`@${login}`);
	const name = String((person && person.displayName) || '').trim().toLowerCase();
	if (name) tokens.push(`#${name}`);
	return tokens;
}

/**
 * Sorted peer ids for a room: the two DMs, or a team's members (plus me).
 * @param {object} rec
 * @param {string} room
 * @param {string} id
 * @param {string} mePeerId
 */
function participantsForRoom(rec, room, id, mePeerId) {
	const ids = [];
	const me = String(mePeerId || '');
	if (me && !ids.includes(me)) ids.push(me);
	if (room === 'dm') {
		for (const p of String(id || '').split(':')) {
			if (p && !ids.includes(p)) ids.push(p);
		}
	} else if (room === 'team') {
		const teamId = String(id || '');
		for (const m of (rec && rec.members) || []) {
			if (m && m.peerId && Array.isArray(m.teamIds) && m.teamIds.includes(teamId)) {
				if (!ids.includes(m.peerId)) ids.push(m.peerId);
			}
		}
	}
	return ids.sort();
}

function participantsChanged(prev, next) {
	if (!Array.isArray(prev) || prev.length !== (next || []).length) return true;
	const a = [...prev].sort();
	const b = [...next].sort();
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
	return false;
}

/** Room key sealed to every participant other than me, keyed by their peer id. */
function grantsForRoom(rec, roomKeyB64, participants, mePeerId) {
	const grants = {};
	const me = String(mePeerId || '');
	const members = (rec && rec.members) || [];
	for (const pid of participants) {
		if (pid === me) continue;
		const m = members.find(x => x && x.peerId === pid);
		if (m && m.encKey) grants[pid] = sealRoomKeyTo(m.encKey, roomKeyB64);
	}
	return grants;
}

/** Decrypt the sealed content of dm/team messages so callers see plain text. */
async function plainMessages(projectId, room, id, messages) {
	if (room !== 'dm' && room !== 'team') return messages;
	const state = await roomKeyState(String(projectId || ''), room, String(id || ''));
	if (!state.generations.length) return messages;
	// Each message records which generation sealed it; open it with that key.
	const keyByGen = new Map(state.generations.map(g => [g.gen, g.key]));
	return (messages || []).map(m => {
		if (m && m.seal && !m.text) {
			const key = keyByGen.get(messageGen(m));
			if (!key) return m;
			try {
				const p = openMessage(key, m.seal);
				return { ...m, text: String(p.text || ''), mentions: Array.isArray(p.mentions) ? p.mentions : [] };
			} catch {
				return m;
			}
		}
		return m;
	});
}

/** Generation number a sealed message claims, or null if none/not sealed. */
function messageGen(m) {
	if (!m || !m.seal) return null;
	const gen = Math.floor(Number(m.gen));
	return Number.isFinite(gen) && gen >= 1 ? gen : null;
}

/** Set of generations still referenced by a room's stored messages. */
function referencedGens(messages) {
	const set = new Set();
	for (const m of messages || []) {
		const g = messageGen(m);
		if (g) set.add(g);
	}
	return set;
}

/** Drop messages whose per-message signature is missing or doesn't match the author. */
function verifySignedMessages(rec, messages) {
	const members = (rec && rec.members) || [];
	const pubByPeer = new Map();
	for (const m of members) {
		if (m && m.peerId && m.publicKey) pubByPeer.set(String(m.peerId), String(m.publicKey));
	}
	return (messages || []).filter(m => {
		if (!m) return false;
		if (!m.sig) return false;
		const pub = pubByPeer.get(String(m.author || ''));
		if (!pub) return false;
		const { sig, ...rest } = m;
		return verifyPayload(rest, sig, pub);
	});
}

/**
 * For each of my messages, list the other members whose read cursor is at or
 * past it, so the UI can show a blue tick. Any non-me reader counts.
 */
async function attachReadState(projectFolderUri, rec, room, id, messages, mePeerId) {
	const me = String(mePeerId || '');
	const msgs = messages || [];
	const receipts = await readReadReceipts(projectFolderUri);
	const cursors = receipts[roomKey(room, id)] || {};
	const idxOf = new Map();
	for (let i = 0; i < msgs.length; i++) {
		if (msgs[i] && msgs[i].id) idxOf.set(msgs[i].id, i);
	}
	const cursorIdx = {};
	for (const [pid, mid] of Object.entries(cursors)) {
		if (pid === me) continue;
		if (mid && idxOf.has(mid)) cursorIdx[pid] = idxOf.get(mid);
	}
	return msgs.map(m => {
		if (!m || m.author !== me) return m;
		const myIdx = idxOf.has(m.id) ? idxOf.get(m.id) : -1;
		const readBy = Object.keys(cursorIdx).filter(pid => cursorIdx[pid] >= myIdx);
		return readBy.length ? { ...m, readBy } : m;
	});
}

async function readRoom(projectFolderUri, room, id, rec, mePeerId) {
	if (!rec || typeof rec !== 'object') {
		try {
			rec = await readProjectRecord(projectFolderUri);
		} catch {
			rec = null;
		}
	}
	const data = await readChatFile(chatFileUri(projectFolderUri, room, id));
	if (rec) {
		// Verify the stored (sealed/plain) form first, before decrypting adds
		// text fields the signature never covered.
		data.messages = verifySignedMessages(rec, data.messages);
	}
	if (rec && rec.projectId) {
		data.messages = await plainMessages(rec.projectId, room, id, data.messages);
	}
	if (rec && mePeerId) {
		data.messages = await attachReadState(projectFolderUri, rec, room, id, data.messages, mePeerId);
	}
	return data;
}

/**
 * Append a message. DM and team rooms seal the text+mentions with a room key
 * (rotated lazily when the participant set changed) and return the sealed
 * message plus the key grants to hand other participants. Project and issue
 * rooms stay plain.
 * @returns {Promise<{ data: {version:number,messages:object[]}, message: object, grants: object, participants: string[] }>}
 */
async function appendMessage(projectFolderUri, rec, room, id, text, author, extra) {
	const body = String(text || '').trim();
	if (!body) throw new Error('Type a message first.');
	const me = author || (await ensurePeerIdentity());
	const uri = chatFileUri(projectFolderUri, room, id);
	const data = await readChatFile(uri);
	const base = {
		id: newPrefixedId('msg'),
		author: me.peerId,
		name: memberPublicName(me),
		createdAt: new Date().toISOString(),
		...(extra && typeof extra === 'object' ? extra : {})
	};
	let message;
	let grants = {};
	let participants = [];
	if (room === 'dm' || room === 'team') {
		const projectId = String((rec && rec.projectId) || '');
		participants = participantsForRoom(rec, room, id, me.peerId);
		const state = await roomKeyState(projectId, room, id);
		const latest = state.generations[state.generations.length - 1];
		let gen;
		let key;
		if (!latest || participantsChanged(latest.participants, participants)) {
			// Mint a new generation when members changed (or there is none yet),
			// leaving the older generations in place so history stays readable.
			key = newRoomKey();
			gen = state.nextGen;
			await storeRoomKeyGeneration(projectId, room, id, gen, key, participants);
		} else {
			key = latest.key;
			gen = latest.gen;
		}
		message = { ...base, gen, seal: sealMessage(key, { text: body, mentions: mentionsIn(body) }) };
		grants = grantsForRoom(rec, key, participants, me.peerId);
	} else {
		message = { ...base, text: body, mentions: mentionsIn(body) };
	}
	// Sign the message itself so any peer can tell a line was not forged or
	// rewritten, even after the op log that carried it has been folded away.
	message.sig = (await signPayload(message)).signature;
	data.messages.push(message);
	const written = await writeChatFile(uri, data);
	// Sweep generations no message references, so rotations don't hoard keys.
	if (room === 'dm' || room === 'team') {
		await pruneRoomKeys(String((rec && rec.projectId) || ''), room, id, referencedGens(written.messages));
	}
	return { data: { version: 1, messages: written.messages }, message, grants, participants };
}

/**
 * Append to an issue's chat and, for any `@team-name` mention, copy a pointer
 * message into that team's talk room so team members see it there and can click
 * through to the issue. Returns the issue room plus the list of team fan-outs.
 */
async function appendIssueMessage(projectFolderUri, rec, uid, text, author, issueKey) {
	const me = author || (await ensurePeerIdentity());
	const teams = (rec && rec.teams) || [];
	const issueRes = await appendMessage(projectFolderUri, rec, 'issue', uid, text, me, {
		issueUid: uid,
		issueKey: String(issueKey || '')
	});
	const fanout = [];
	for (const t of teamMentionsIn(text, teams)) {
		const tm = await appendMessage(projectFolderUri, rec, 'team', t.id, text, me, {
			refIssueUid: uid,
			refIssueKey: String(issueKey || ''),
			refTeamName: String(t.name || '')
		});
		if (tm.message) {
			fanout.push({ teamId: t.id, teamName: t.name, message: tm.message, grants: tm.grants, participants: tm.participants });
		}
	}
	return { issueData: issueRes.data, issueMessage: issueRes.message, fanout };
}

async function clearRoom(projectFolderUri, room, id) {
	const uri = chatFileUri(projectFolderUri, room, id);
	const data = await writeChatFile(uri, { version: 1, messages: [] });
	// Drop the read cursor too, so a later message in this room isn't measured
	// against a message that was deleted by the clear.
	try {
		const reads = await readReads(projectFolderUri);
		const key = roomKey(room, id);
		if (reads[key] !== undefined) {
			delete reads[key];
			await writeReads(projectFolderUri, reads);
		}
	} catch {
		/* cursor cleanup is best-effort */
	}
	// A cleared room has no messages, so every key generation is now dead.
	// Remove them all rather than hoarding padlocks for a room that's empty.
	if (room === 'dm' || room === 'team') {
		try {
			const rec = await readProjectRecord(projectFolderUri);
			await pruneRoomKeys(String((rec && rec.projectId) || ''), room, id, []);
		} catch {
			/* key sweep is best-effort */
		}
	}
	return data;
}

async function applyChatOp(projectFolderUri, op, rec) {
	const p = op.payload || {};
	const room = String(p.room || 'issue');
	const id = String(p.id || '');
	if (op.type === 'chat.read') return applyChatRead(projectFolderUri, op);
	if (op.type === 'chat.clear') return clearRoom(projectFolderUri, room, id);
	if (p.message && (p.message.text || p.message.seal)) {
		const projectId = String((rec && rec.projectId) || '');
		// Pick up the room key granted to me before storing the sealed message,
		// filed under the generation that message claims.
		await applyRoomKeyGrants(projectId, room, id, p.message.gen, p.grants, p.participants);
		const uri = chatFileUri(projectFolderUri, room, id);
		const data = await readChatFile(uri);
		if (!data.messages.some(m => m && m.id === p.message.id)) {
			data.messages.push(p.message);
		}
		const written = await writeChatFile(uri, data);
		// Sweep generations no stored message references, as on the sending side.
		await pruneRoomKeys(projectId, room, id, referencedGens(written.messages));
		return written;
	}
	return readRoom(projectFolderUri, room, id, rec);
}

/** Record that a peer read up to a message id in a room (advance their cursor). */
async function applyChatRead(projectFolderUri, op) {
	const p = op.payload || {};
	const room = String(p.room || '');
	const id = String(p.id || '');
	const upTo = String(p.upTo || '');
	if (!room || !upTo) return { kind: 'chat-read' };
	const author = String(op.author || '');
	const key = roomKey(room, id);
	// Cursors only move forward, so keep the receipt whose message sits further
	// along the room's ordered list (guards against out-of-order network arrival).
	const data = await readChatFile(chatFileUri(projectFolderUri, room, id));
	const msgs = data.messages || [];
	const idxOf = mid => {
		for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].id === mid) return i;
		return -1;
	};
	const receipts = await readReadReceipts(projectFolderUri);
	const map = receipts[key] || (receipts[key] = {});
	const cur = map[author];
	if (!cur || idxOf(upTo) > idxOf(cur)) map[author] = upTo;
	await writeReadReceipts(projectFolderUri, receipts);
	return { kind: 'chat-read' };
}

/** Open any room-key grant addressed to me and keep it under the right generation. */
async function applyRoomKeyGrants(projectId, room, id, gen, grants, participants) {
	if (!grants || typeof grants !== 'object') return;
	const me = await ensurePeerIdentity();
	const box = grants[me.peerId];
	if (!box) return;
	try {
		const key = await openRoomKeyFrom(box);
		await storeRoomKeyGeneration(projectId, room, id, gen, key, Array.isArray(participants) ? participants : []);
	} catch {
		/* not ours, or tampered — ignore */
	}
}

/** Messages by other people after the last-seen id. */
function unreadCount(messages, mePeerId, lastSeenId) {
	let lastIdx = -1;
	if (lastSeenId) {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i] && messages[i].id === lastSeenId) {
				lastIdx = i;
				break;
			}
		}
	}
	let count = 0;
	for (let i = lastIdx + 1; i < messages.length; i++) {
		const m = messages[i];
		if (m && m.author !== mePeerId) count++;
	}
	return count;
}

async function markRead(projectFolderUri, room, id) {
	const data = await readRoom(projectFolderUri, room, id);
	const msgs = data.messages || [];
	if (!msgs.length) return { advanced: false, upTo: '' };
	const key = roomKey(room, id);
	const upTo = msgs[msgs.length - 1].id;
	const reads = await readReads(projectFolderUri);
	if (reads[key] === upTo) return { advanced: false, upTo };
	reads[key] = upTo;
	await writeReads(projectFolderUri, reads);
	return { advanced: true, upTo };
}

async function roomSummary(projectFolderUri, room, id, label, mePeerId, reads, peerId, rec) {
	const data = await readRoom(projectFolderUri, room, id, rec);
	const msgs = data.messages || [];
	const last = msgs[msgs.length - 1];
	return {
		key: roomKey(room, id),
		room,
		id,
		peerId: peerId || '',
		label,
		unread: unreadCount(msgs, mePeerId, reads[roomKey(room, id)]),
		lastText: last ? String(last.text || '') : '',
		lastAuthor: last ? String(last.name || last.author || '') : ''
	};
}

/** Every `issues/*.json` uid present in the chat sidecar. */
async function listIssueChatUids(projectFolderUri) {
	try {
		const dir = vscode.Uri.joinPath(chatDirUri(projectFolderUri), 'issues');
		const entries = await vscode.workspace.fs.readDirectory(dir);
		return entries
			.map(([name]) => name)
			.filter(name => String(name).toLowerCase().endsWith('.json'))
			.map(name => String(name).slice(0, -5));
	} catch {
		return [];
	}
}

/**
 * Issue chats worth surfacing in the chat sidebar: ones that are unread, carry a
 * team mention, or mention this person. Anything else stays hidden so the list
 * doesn't crowd with every issue that has talk.
 */
async function issueChatSummaries(projectFolderUri, rec, mePeerId, reads, uidToKey) {
	const myTokens = mentionTokensFor(require('./projectSharing').memberOf(rec, mePeerId));
	const teams = (rec && rec.teams) || [];
	const teamTokens = teams.map(teamMentionToken).filter(Boolean);
	const uids = await listIssueChatUids(projectFolderUri);
	const out = [];
	for (const uid of uids) {
		if (!uid) continue;
		const data = await readRoom(projectFolderUri, 'issue', uid, rec);
		const msgs = data.messages || [];
		if (!msgs.length) continue;
		let hasTeamMention = false;
		let hasUserMention = false;
		for (const m of msgs) {
			const ms = Array.isArray(m.mentions) ? m.mentions : [];
			if (ms.some(tok => teamTokens.includes(String(tok).toLowerCase()))) hasTeamMention = true;
			if (myTokens.length && ms.some(tok => myTokens.includes(String(tok).toLowerCase()))) hasUserMention = true;
		}
		const unread = unreadCount(msgs, mePeerId, reads[roomKey('issue', uid)]);
		if (!unread && !hasTeamMention && !hasUserMention) continue;
		const last = msgs[msgs.length - 1];
		out.push({
			key: roomKey('issue', uid),
			room: 'issue',
			id: uid,
			issueKey: String((uidToKey && uidToKey[uid]) || ''),
			unread,
			hasTeamMention,
			hasUserMention,
			lastText: last ? String(last.text || '') : '',
			lastAuthor: last ? String(last.name || last.author || '') : ''
		});
	}
	return out;
}

/**
 * Rooms (project, my teams, DMs, relevant issues) with unread counts, plus
 * mentions for me, people and teams for autocomplete.
 * @param {import('vscode').Uri} projectFolderUri
 * @param {object} rec project record
 * @param {string} mePeerId
 * @param {{ kbRootUri?: import('vscode').Uri, folderPrefix?: string }} [opts]
 */
async function chatOverview(projectFolderUri, rec, mePeerId, opts) {
	const me = require('./projectSharing').memberOf(rec, mePeerId);
	const myTeamIds = me && Array.isArray(me.teamIds) ? me.teamIds : [];
	const isAdminRole = !!(me && me.role === 'admin');
	const teams = (rec && rec.teams) || [];
	const members = (rec && rec.members) || [];
	const reads = await readReads(projectFolderUri);

	// Map issue uid -> visible i-N key so issue chats can show a real title.
	const uidToKey = await issueUidToKeyMap(opts && opts.kbRootUri, opts && opts.folderPrefix);

	const rooms = [];
	rooms.push(await roomSummary(projectFolderUri, 'project', '', 'Project talk', mePeerId, reads, '', rec));

	for (const t of teams) {
		if (!isAdminRole && !myTeamIds.includes(t.id)) continue;
		rooms.push(await roomSummary(projectFolderUri, 'team', t.id, t.name, mePeerId, reads, '', rec));
	}

	// Every team is offerable as a `@team-name` mention in issue chat; a member can
	// call out a team they are not in to draw its attention to an issue.
	const teamSuggestions = teams.map(t => ({
		id: t.id,
		name: t.name,
		token: teamMentionToken(t)
	}));

	const issues = await issueChatSummaries(projectFolderUri, rec, mePeerId, reads, uidToKey);

	// DMs appear only once there is an actual conversation between two people.
	for (const m of members) {
		if (!m || m.peerId === mePeerId) continue;
		const dmId = dmRoomId(mePeerId, m.peerId);
		const dm = await readRoom(projectFolderUri, 'dm', dmId, rec);
		if (!(dm.messages || []).length) continue;
		rooms.push(await roomSummary(projectFolderUri, 'dm', dmId, memberPublicName(m), mePeerId, reads, m.peerId, rec));
	}

	// Everyone else, for the DM search and the @/# mention autocomplete.
	const people = members
		.filter(m => m && m.peerId !== mePeerId)
		.map(m => {
			const githubLogin = String(m.githubLogin || '').trim().replace(/^@/, '');
			const isGuest = !githubLogin;
			return {
				peerId: m.peerId,
				name: memberPublicName(m),
				githubLogin,
				isGuest,
				at: githubLogin ? `@${githubLogin}` : '',
				hash: isGuest ? `#${String(m.displayName || m.peerId || '')}` : '',
				dmId: dmRoomId(mePeerId, m.peerId)
			};
		});

	const mentions = await collectMentions(projectFolderUri, rec, mePeerId, uidToKey);

	const tokens = mentionTokensFor(me);
	return {
		me: {
			peerId: mePeerId,
			name: me ? memberPublicName(me) : '',
			mentionTokens: tokens
		},
		rooms,
		issues,
		teams: teamSuggestions,
		people,
		mentions,
		mentionsReadAt: String(reads[MENTION_READS_KEY] || '')
	};
}

/**
 * Build a `{ [uid]: issueKey }` map by scanning the project notes once. Cached
 * per (kbRoot, prefix) so repeated overview refreshes stay cheap.
 */
async function issueUidToKeyMap(kbRootUri, folderPrefix) {
	const cacheKey = `${String((kbRootUri && kbRootUri.fsPath) || '')}::${String(folderPrefix || '')}`;
	const cached = uidToKeyCache.get(cacheKey);
	if (cached && Date.now() - cached.at < 15000) return cached.map;
	const map = {};
	try {
		const { listIssueKeysInProject } = require('./projectIssueLookup');
		const keys = await listIssueKeysInProject(kbRootUri, folderPrefix);
		for (const k of keys) {
			if (k && k.uid && k.issueId) map[k.uid] = k.issueId;
		}
	} catch {
		/* lookup is best-effort */
	}
	uidToKeyCache.set(cacheKey, { map, at: Date.now() });
	return map;
}

async function collectMentions(projectFolderUri, rec, mePeerId, uidToKey) {
	const me = require('./projectSharing').memberOf(rec, mePeerId);
	const tokens = mentionTokensFor(me);
	if (!tokens.length) return [];
	const myTeamIds = me && Array.isArray(me.teamIds) ? me.teamIds : [];
	const isAdminRole = !!(me && me.role === 'admin');
	const teams = (rec && rec.teams) || [];
	const members = (rec && rec.members) || [];

	const roomsToScan = [{ room: 'project', id: '', label: 'Project talk' }];
	for (const t of teams) {
		if (!isAdminRole && !myTeamIds.includes(t.id)) continue;
		roomsToScan.push({ room: 'team', id: t.id, label: t.name });
	}
	for (const m of members) {
		if (m.peerId === mePeerId) continue;
		roomsToScan.push({ room: 'dm', id: dmRoomId(mePeerId, m.peerId), label: memberPublicName(m) });
	}

	// Issue chats: any that mention this person also surface here.
	const issueUids = await listIssueChatUids(projectFolderUri);
	for (const uid of issueUids) {
		if (!uid) continue;
		const key = (uidToKey && uidToKey[uid]) || '';
		roomsToScan.push({ room: 'issue', id: uid, label: key ? `#${key}` : 'Issue', issueUid: uid, issueKey: key });
	}

	const out = [];
	for (const r of roomsToScan) {
		const data = await readRoom(projectFolderUri, r.room, r.id, rec);
		for (const m of data.messages || []) {
			const ms = Array.isArray(m.mentions) ? m.mentions : [];
			if (ms.some(tok => tokens.includes(String(tok).toLowerCase()))) {
				out.push({
					id: m.id || '',
					roomLabel: r.label,
					room: r.room,
					issueUid: r.issueUid || '',
					issueKey: r.issueKey || '',
					name: m.name || m.author || '',
					text: m.text || '',
					createdAt: m.createdAt || ''
				});
			}
		}
	}
	return out;
}

/** Mark every current mention as read (advance the seen cursor to the newest). */
async function markMentionsRead(projectFolderUri, rec, mePeerId) {
	const mentions = await collectMentions(projectFolderUri, rec, mePeerId);
	let max = '';
	for (const m of mentions) {
		const ts = String(m.createdAt || '');
		if (ts > max) max = ts;
	}
	if (!max) return;
	const reads = await readReads(projectFolderUri);
	const prev = String(reads[MENTION_READS_KEY] || '');
	if (max > prev) {
		reads[MENTION_READS_KEY] = max;
		await writeReads(projectFolderUri, reads);
	}
}

module.exports = {
	CHAT_MAX,
	chatFileUri,
	dmRoomId,
	roomKey,
	readRoom,
	plainMessages,
	appendMessage,
	appendIssueMessage,
	clearRoom,
	applyChatOp,
	mentionsIn,
	teamMentionToken,
	mentionTokensFor,
	markRead,
	markMentionsRead,
	chatOverview
};
