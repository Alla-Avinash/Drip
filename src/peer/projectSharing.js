'use strict';

/**
 * Solo ↔ shared project membership. No network — Share writes the sidecar and an invite.
 */

const path = require('path');
const vscode = require('vscode');
const { newPrefixedId } = require('./peerIds');
const { ensurePeerIdentity } = require('./peerIdentity');
const {
	emptyProjectRecord,
	readProjectRecord,
	writeProjectRecord,
	isProjectShared,
	projectFolderUriFromPrefix,
	readTagsFile,
	writeTagsFile,
	readMetadataFile,
	writeMetadataFile
} = require('./projectSidecar');

/**
 * @param {string} raw
 * @returns {string}
 */
function encodeInvite(rawObj) {
	return Buffer.from(JSON.stringify(rawObj), 'utf8').toString('base64url');
}

/**
 * @param {string} code
 * @returns {{ v: number, projectId: string, capability: string, name: string }}
 */
function parseInviteCode(code) {
	const trimmed = String(code || '').trim();
	if (!trimmed) throw new Error('Invite is empty.');
	let parsed;
	try {
		parsed = JSON.parse(Buffer.from(trimmed, 'base64url').toString('utf8'));
	} catch {
		throw new Error('That invite is not valid.');
	}
	if (parsed && parsed.kind === 'access') {
		throw new Error('That is an access control code. Join with the project invite first, then enter this code on the project.');
	}
	if (!parsed || !parsed.projectId || !parsed.capability) {
		throw new Error('That invite is missing the project or the secret.');
	}
	const hosts = [];
	const addHost = h => {
		const s = String(h || '').trim();
		if (s && !hosts.includes(s)) hosts.push(s);
	};
	addHost(parsed.host);
	if (Array.isArray(parsed.hosts)) parsed.hosts.forEach(addHost);
	return {
		v: Number(parsed.v) || 1,
		projectId: String(parsed.projectId),
		capability: String(parsed.capability),
		name: String(parsed.name || 'project'),
		host: hosts[0] || '',
		hosts,
		port: parsed.port ? Number(parsed.port) : 0
	};
}

/**
 * @param {ReturnType<typeof emptyProjectRecord>} rec
 * @returns {string}
 */
const ACCESS_ROLES = Object.freeze(['member', 'updater', 'admin']);

function emptyAccessCapabilities() {
	return { member: '', updater: '', admin: '' };
}

function normalizeAccessCapabilities(rec) {
	if (!rec) return rec;
	const cur = rec.accessCapabilities && typeof rec.accessCapabilities === 'object' ? rec.accessCapabilities : {};
	rec.accessCapabilities = {
		member: String(cur.member || ''),
		updater: String(cur.updater || ''),
		admin: String(cur.admin || '')
	};
	return rec;
}

function ensureAccessCapabilities(rec) {
	normalizeAccessCapabilities(rec);
	for (const role of ACCESS_ROLES) {
		if (!rec.accessCapabilities[role]) rec.accessCapabilities[role] = newPrefixedId('acap');
	}
	return rec;
}

function parseAccessCode(code) {
	const trimmed = String(code || '').trim();
	if (!trimmed) throw new Error('Access control code is empty.');
	let parsed;
	try {
		parsed = JSON.parse(Buffer.from(trimmed, 'base64url').toString('utf8'));
	} catch {
		throw new Error('That access control code is not valid.');
	}
	if (!parsed || parsed.kind !== 'access' || !parsed.projectId || !parsed.capability || !parsed.role) {
		throw new Error('That is not an access control code. Use a project invite to join, then enter an access code to change your role.');
	}
	const role = String(parsed.role).trim().toLowerCase();
	if (!ACCESS_ROLES.includes(role)) {
		throw new Error('That access control code is not valid.');
	}
	return {
		v: Number(parsed.v) || 1,
		kind: 'access',
		projectId: String(parsed.projectId),
		role,
		capability: String(parsed.capability)
	};
}

function accessCodeFromRecord(rec, role) {
	const r = String(role || '').trim().toLowerCase();
	if (!ACCESS_ROLES.includes(r)) throw new Error('Pick member, updater, or admin.');
	ensureAccessCapabilities(rec);
	return encodeInvite({
		v: 1,
		kind: 'access',
		projectId: rec.projectId,
		role: r,
		capability: rec.accessCapabilities[r]
	});
}

function inviteCodeFromRecord(rec) {
	const { lanPortFor } = require('./projectLanSync');
	const port = lanPortFor(rec.projectId);
	let host = '';
	if (port) {
		try {
			const os = require('os');
			const nets = os.networkInterfaces();
			for (const list of Object.values(nets || {})) {
				for (const n of list || []) {
					if (n && (n.family === 'IPv4' || n.family === 4) && !n.internal) {
						host = n.address;
						break;
					}
				}
				if (host) break;
			}
		} catch {
			/* ignore */
		}
	}
	const hosts = [];
	if (host) hosts.push(host);
	if (port) hosts.push('127.0.0.1');
	return encodeInvite({
		v: 1,
		projectId: rec.projectId,
		capability: rec.inviteCapability,
		name: rec.name || 'project',
		host: hosts[0] || '',
		hosts,
		port: port || 0
	});
}

/**
 * @param {ReturnType<typeof emptyProjectRecord>} rec
 * @param {string} peerId
 */
function memberOf(rec, peerId) {
	return (rec.members || []).find(m => m && m.peerId === peerId) || null;
}

function isAdmin(rec, peerId) {
	const m = memberOf(rec, peerId);
	return !!(m && m.role === 'admin');
}

/**
 * Backfill an existing member's identity keys from a peer's wire identity
 * (a hello/join message). Role and teams are untouched; only the fields that
 * identify or encrypt to that peer are refreshed. Returns true if changed.
 * @param {object} rec
 * @param {{ peerId?: string, publicKey?: string, encKey?: string, displayName?: string, githubId?: string, githubLogin?: string }} person
 */
function refreshMemberFromPerson(rec, person) {
	const id = String((person && person.peerId) || '');
	if (!rec || !id) return false;
	const m = memberOf(rec, id);
	if (!m) return false;
	let changed = false;
	if (person.publicKey && m.publicKey !== String(person.publicKey)) {
		m.publicKey = String(person.publicKey);
		changed = true;
	}
	if (person.encKey && m.encKey !== String(person.encKey)) {
		m.encKey = String(person.encKey);
		changed = true;
	}
	if (person.displayName && !m.displayName) {
		m.displayName = String(person.displayName);
		changed = true;
	}
	if (person.githubLogin && !m.githubLogin) {
		m.githubLogin = String(person.githubLogin);
		changed = true;
	}
	if (person.githubId && !m.githubId) {
		m.githubId = String(person.githubId);
		changed = true;
	}
	return changed;
}

function adminCount(rec) {
	return (rec.members || []).filter(m => m && m.role === 'admin').length;
}

/**
 * Name other people see: GitHub login when linked, otherwise the guest PC name.
 * @param {{ githubLogin?: string, displayName?: string, peerId?: string }} person
 */
function memberPublicName(person) {
	return require('./projectShareNotify').memberPublicName(person);
}

function emptyBlocked() {
	return { githubIds: [], guestNames: [] };
}

function normalizeGuestName(name) {
	return String(name || '')
		.trim()
		.toLowerCase();
}

function isGuestMember(member) {
	return !String((member && member.githubId) || '').trim();
}

function ensurePendingJoiners(rec) {
	if (!rec) return [];
	if (!Array.isArray(rec.pendingJoiners)) rec.pendingJoiners = [];
	return rec.pendingJoiners;
}

function pendingOf(rec, peerId) {
	const id = String(peerId || '');
	if (!id) return null;
	return ensurePendingJoiners(rec).find(p => p && p.peerId === id) || null;
}

function pendingEntryFromPerson(person) {
	const githubLogin = String((person && person.githubLogin) || '').trim();
	const githubId = String((person && person.githubId) || '').trim();
	return {
		peerId: String((person && person.peerId) || ''),
		displayName: githubLogin || String((person && person.displayName) || ''),
		publicKey: String((person && person.publicKey) || ''),
		encKey: String((person && person.encKey) || ''),
		githubId,
		githubLogin,
		requestedAt: new Date().toISOString()
	};
}

/**
 * Add or refresh a join request. Returns true when this is a new request.
 * @param {object} rec
 * @param {object} person
 */
function upsertPendingJoiner(rec, person) {
	if (!rec || !person || !person.peerId) return false;
	if (memberOf(rec, person.peerId)) return false;
	const list = ensurePendingJoiners(rec);
	const next = pendingEntryFromPerson(person);
	const i = list.findIndex(p => p && p.peerId === next.peerId);
	if (i >= 0) {
		list[i] = { ...list[i], ...next, requestedAt: list[i].requestedAt || next.requestedAt };
		return false;
	}
	list.push(next);
	return true;
}

function removePendingJoiner(rec, peerId) {
	const id = String(peerId || '');
	rec.pendingJoiners = ensurePendingJoiners(rec).filter(p => p && p.peerId !== id);
	return rec;
}

function dropPersonFromProject(rec, peerId) {
	const id = String(peerId || '');
	if (!rec || !id) return rec;
	rec.members = (rec.members || []).filter(m => m && m.peerId !== id);
	removePendingJoiner(rec, id);
	for (const t of rec.teams || []) {
		if (t && t.leadPeerId === id) t.leadPeerId = '';
	}
	return rec;
}

function blockMemberOnRecord(rec) {
	return rec;
}

async function allowJoinAgain(_kbRootUri, _folderPrefix, _who) {
	return null;
}

/**
 * Why this person cannot even ask to join (guest policy only).
 * Removed people are not blocked — they ask again with an invite.
 * @param {object} rec
 * @param {{ githubId?: string, displayName?: string }} person
 */
function joinBlockReason(rec, person) {
	if (!rec || !person) return '';
	const githubId = String(person.githubId || '').trim();
	if (githubId && rec.ownerGithubId && String(githubId) === String(rec.ownerGithubId)) return '';
	if (!githubId && rec.allowGuests === false) {
		return 'This project only allows people signed in with GitHub.';
	}
	return '';
}

/**
 * Why this person cannot connect right now.
 * Members and people already waiting may connect. A valid invite is enough to ask.
 * @param {object} rec
 * @param {{ peerId?: string, githubId?: string, displayName?: string }} person
 * @param {{ inviteOk?: boolean }} [opts]
 */
function refuseJoinReason(rec, person, opts) {
	if (person && person.peerId && memberOf(rec, person.peerId)) return '';
	const policy = joinBlockReason(rec, person);
	if (policy) return policy;
	if (person && person.peerId && pendingOf(rec, person.peerId)) return '';
	if (opts && opts.inviteOk) return '';
	return 'You are not on this project. Use a project invite to ask the admin.';
}

function personFromWire(msg) {
	return {
		peerId: String((msg && (msg.from || msg.peerId)) || ''),
		githubId: String((msg && msg.githubId) || ''),
		githubLogin: String((msg && msg.githubLogin) || ''),
		displayName: String((msg && msg.displayName) || ''),
		publicKey: String((msg && msg.publicKey) || ''),
		encKey: String((msg && msg.encKey) || '')
	};
}

async function wireIdentityFields() {
	const me = await ensurePeerIdentity();
	return {
		from: me.peerId,
		githubId: me.githubId || '',
		githubLogin: me.githubLogin || '',
		displayName: me.displayName || '',
		publicKey: me.publicKey || '',
		encKey: me.encKey || ''
	};
}

function memberEntryFromPeer(me, role, extra) {
	const githubLogin = String((extra && extra.githubLogin) || me.githubLogin || '').trim();
	const githubId = String((extra && extra.githubId) || me.githubId || '').trim();
	return {
		peerId: me.peerId,
		displayName: githubLogin || me.displayName,
		publicKey: me.publicKey,
		encKey: me.encKey || '',
		role: role || 'viewer',
		githubId,
		githubLogin,
		joinedAt: new Date().toISOString(),
		teamIds: Array.isArray(extra && extra.teamIds) ? extra.teamIds.map(String) : []
	};
}

function joiningMemberEntry(me, rec, extra) {
	return pendingEntryFromPerson({ ...me, ...(extra || {}) });
}

function admittedMemberFromPending(rec, pending, role, teamIds) {
	const { normalizeRole } = require('./projectRoles');
	const member = {
		peerId: pending.peerId,
		displayName: pending.githubLogin || pending.displayName || pending.peerId,
		publicKey: pending.publicKey || '',
		encKey: pending.encKey || '',
		role: normalizeRole(role || 'member'),
		githubId: pending.githubId || '',
		githubLogin: pending.githubLogin || '',
		joinedAt: new Date().toISOString(),
		teamIds: (Array.isArray(teamIds) ? teamIds : String(teamIds || '').split(','))
			.map(String)
			.filter(Boolean)
	};
	if (!member.teamIds.length) throw new Error('Pick at least one team for this person.');
	return member;
}

/**
 * Everyone team + access codes on an already-shared project.
 * @param {import('vscode').Uri} folderUri
 * @param {object} rec
 */
async function persistShareDefaults(folderUri, rec) {
	if (!rec || !rec.shared) return rec;
	const { normalizeTeamsOnRecord } = require('./projectTeams');
	normalizeTeamsOnRecord(rec);
	normalizeAccessCapabilities(rec);
	const missingCaps = ACCESS_ROLES.some(r => !rec.accessCapabilities[r]);
	let dirty = missingCaps;
	if (missingCaps) ensureAccessCapabilities(rec);
	if (
		rec.blocked &&
		((rec.blocked.githubIds && rec.blocked.githubIds.length) ||
			(rec.blocked.guestNames && rec.blocked.guestNames.length))
	) {
		rec.blocked = emptyBlocked();
		dirty = true;
	}
	if (!Array.isArray(rec.pendingJoiners)) {
		rec.pendingJoiners = [];
		dirty = true;
	}
	if (dirty) await writeProjectRecord(folderUri, rec);
	return rec;
}

/**
 * Record a join request on the admin’s sidecar (invite holder is not a member yet).
 * @param {import('vscode').Uri} folderUri
 * @param {object} person
 * @param {string} [folderPrefix]
 */
async function rememberJoinRequest(folderUri, person, folderPrefix) {
	const rec = await readProjectRecord(folderUri);
	if (!rec || !rec.shared) return rec;
	if (memberOf(rec, person && person.peerId)) return rec;
	const policy = joinBlockReason(rec, person);
	if (policy) throw new Error(policy);
	const fresh = upsertPendingJoiner(rec, person);
	await writeProjectRecord(folderUri, rec);
	if (fresh && folderPrefix) {
		try {
			require('./projectShareNotify').announceJoinRequested(folderPrefix, rec, person);
		} catch {
			/* notice is optional */
		}
	}
	return rec;
}

/**
 * Opt a solo project into sharing. You become the first admin.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} [displayName]
 */
async function shareProject(kbRootUri, folderPrefix, displayName) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const existing = await readProjectRecord(folderUri);
	if (existing && existing.shared) {
		return { record: existing, created: false, invite: inviteCodeFromRecord(existing) };
	}
	const { linkGithubToPeer } = require('./peerGithub');
	const linked = await linkGithubToPeer();
	if (!linked || !linked.githubId) {
		throw new Error('Sign in with GitHub to share a project.');
	}
	const githubId = linked.githubId;
	const githubLogin = linked.githubLogin;
	const me = await ensurePeerIdentity();
	const name =
		String(displayName || '').trim() ||
		path.basename(String(folderPrefix || '').replace(/\/+$/, '')).replace(/\.p$/i, '') ||
		'project';
	const rec = {
		...emptyProjectRecord(),
		...(existing || {}),
		projectId: existing && existing.projectId ? existing.projectId : newPrefixedId('proj'),
		shared: true,
		name,
		createdAt: (existing && existing.createdAt) || new Date().toISOString(),
		inviteCapability: newPrefixedId('cap'),
		accessCapabilities: emptyAccessCapabilities(),
		ownerGithubId: githubId,
		ownerGithubLogin: githubLogin,
		members: [memberEntryFromPeer(me, 'admin', { githubId, githubLogin })]
	};
	ensureAccessCapabilities(rec);
	await writeProjectRecord(folderUri, rec);
	await migrateLegacySidecarData(kbRootUri, folderPrefix, folderUri);
	await require('./projectLanSync').writeSharingActive(rec.projectId, true);
	return { record: rec, created: true, invite: inviteCodeFromRecord(rec) };
}

/**
 * Move tags + metadata from the KB-level sidecars into `.drip/` when sharing.
 */
async function migrateLegacySidecarData(kbRootUri, folderPrefix, folderUri) {
	if (!(await readTagsFile(folderUri))) {
		try {
			const { loadProjectGraph } = require('../graph/projectTagStore');
			const graph = await loadProjectGraph(kbRootUri, folderPrefix);
			if (graph && Array.isArray(graph.nodes) && graph.nodes.length) {
				await writeTagsFile(folderUri, graph);
			}
		} catch {
			/* keep going */
		}
	}
	if (!(await readMetadataFile(folderUri))) {
		try {
			const { getProjectMetadataOverrides } = require('../document/model/dripTxt/dripTxtProjectMetadata.js');
			const overrides = getProjectMetadataOverrides(folderPrefix);
			if (overrides && Object.keys(overrides).length) {
				await writeMetadataFile(folderUri, overrides);
			}
		} catch {
			/* keep going */
		}
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function rotateInvite(kbRootUri, folderPrefix) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await requireShared(folderUri);
	const me = await ensurePeerIdentity();
	if (!isAdmin(rec, me.peerId)) throw new Error('Only an admin can rotate the invite.');
	rec.inviteCapability = newPrefixedId('cap');
	await writeProjectRecord(folderUri, rec);
	return { record: rec, invite: inviteCodeFromRecord(rec) };
}

/**
 * Replace one role's access control code. The project invite stays the same.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} role
 */
async function rotateAccess(kbRootUri, folderPrefix, role) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await requireShared(folderUri);
	const me = await ensurePeerIdentity();
	if (!isAdmin(rec, me.peerId)) throw new Error('Only an admin can rotate an access control code.');
	const r = String(role || '').trim().toLowerCase();
	if (!ACCESS_ROLES.includes(r)) throw new Error('Pick member, updater, or admin.');
	ensureAccessCapabilities(rec);
	rec.accessCapabilities[r] = newPrefixedId('acap');
	await writeProjectRecord(folderUri, rec);
	return { record: rec, role: r, accessCode: accessCodeFromRecord(rec, r) };
}

/**
 * A member who already joined as a viewer raises their role with an access code.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} code
 */
async function redeemAccessCode(kbRootUri, folderPrefix, code) {
	const access = parseAccessCode(code);
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await requireShared(folderUri);
	if (rec.projectId !== access.projectId) {
		throw new Error('That access control code is for a different project.');
	}
	normalizeAccessCapabilities(rec);
	if (!rec.accessCapabilities[access.role] || rec.accessCapabilities[access.role] !== access.capability) {
		throw new Error('That access control code is no longer valid. Ask for a new one.');
	}
	const me = await ensurePeerIdentity();
	const mine = memberOf(rec, me.peerId);
	if (!mine) throw new Error('Join this project with an invite first, then enter the access control code.');
	if (mine.role === 'admin' && access.role !== 'admin' && adminCount(rec) <= 1) {
		throw new Error('Pass admin to someone else before you change the last admin.');
	}
	mine.role = access.role;
	await writeProjectRecord(folderUri, rec);
	return { record: rec, role: access.role, capability: access.capability };
}

/**
 * Leave: keep a local copy as a detached solo project with a new project id.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function detachLocalCopy(folderUri, rec) {
	const next = {
		...emptyProjectRecord(),
		projectId: newPrefixedId('proj'),
		shared: false,
		name: rec && rec.name ? rec.name : '',
		createdAt: new Date().toISOString(),
		members: [],
		highWater: (rec && rec.highWater) || { issue: 0, feature: 0, concept: 0, decision: 0, file: -1 }
	};
	await writeProjectRecord(folderUri, next);
	if (rec && rec.projectId) {
		try {
			const lan = require('./projectLanSync');
			await lan.writeSharingActive(rec.projectId, false);
			lan.stopLanListener(rec.projectId);
		} catch {
			/* this copy is already solo */
		}
	}
	return next;
}

/**
 * Admin converts a shared project back to a solo project. A signed "close"
 * operation is recorded and broadcast so every member stops syncing; it is also
 * pushed to the GitHub mailbox (when one is set) so members who are offline now
 * detach the next time they pull. This machine then detaches itself.
 *
 * Offline members without a mailbox cannot be reached (same as any other change):
 * they keep a shared-but-unreachable copy and can leave it themselves.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function unshareProject(kbRootUri, folderPrefix) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await requireShared(folderUri);
	const me = await ensurePeerIdentity();
	if (!isAdmin(rec, me.peerId)) throw new Error('Only an admin can convert this project to solo.');

	// 1. Record the signed close operation (the single source of truth).
	const opLog = require('./projectOpLog');
	const { createOperation, OP_TYPES } = require('./projectOp');
	const op = await createOperation({
		projectId: rec.projectId,
		type: OP_TYPES.PROJECT_UNSHARE,
		payload: { closedBy: me.peerId },
		seq: await opLog.nextSeqFor(folderUri, me.peerId)
	});
	await opLog.appendOperation(folderUri, op);

	// 2. Tell members who are online right now.
	try {
		await require('./projectLanSync').publishLanOps(kbRootUri, folderPrefix, [op]);
	} catch (err) {
		console.error('[DRIP] unshare LAN publish', err);
	}
	try {
		await require('./projectInternetSync').publishInternetOps(rec.projectId, rec.inviteCapability, [op]);
	} catch (err) {
		console.error('[DRIP] unshare internet publish', err);
	}

	// 3. Durable fallback for members who are offline right now.
	let mailboxPushed = false;
	let mailboxWarn = '';
	const mailbox = require('./projectMailbox');
	if (mailbox.parseMailboxRepo(rec.mailboxRepo)) {
		try {
			const r = await mailbox.pushProjectMailbox(kbRootUri, folderPrefix, { interactive: true, force: true });
			mailboxPushed = !!(r && r.pushed);
			if (mailboxPushed) {
				try {
					await mailbox.notifyMailboxUpdated(kbRootUri, folderPrefix, r.repo);
				} catch {
					/* live mailbox signal is optional */
				}
			} else if (r && r.reason) {
				mailboxWarn = String(r.reason);
			}
		} catch (err) {
			mailboxWarn = err && err.message ? err.message : String(err);
		}
	}

	// 4. This machine becomes solo too, then sharing-only markers are cleaned up.
	await detachLocalCopy(folderUri, rec);
	await cleanupSharingMarkersOnDetach(kbRootUri, folderPrefix);

	// 5. Drop the shared history so a later re-share starts clean.
	await opLog.resetProjectLog(folderUri);

	return { record: rec, op, mailboxPushed, mailboxWarn };
}

/**
 * Remove everything a solo project must not carry: sharing-only markers in the
 * note files (uid / team / fileuid) and the project's issue→team index rows.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function cleanupSharingMarkersOnDetach(kbRootUri, folderPrefix) {
	try {
		await require('./projectHiddenIds').stripProjectHiddenIds(kbRootUri, folderPrefix);
	} catch (err) {
		console.error('[DRIP] strip hidden ids on detach', err);
	}
	try {
		await require('../indexing/projectIndex').clearProjectIssueTeams(kbRootUri, folderPrefix);
	} catch (err) {
		console.error('[DRIP] clear issue teams on detach', err);
	}
}

async function leaveProject(kbRootUri, folderPrefix) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await requireShared(folderUri);
	const me = await ensurePeerIdentity();
	if (!memberOf(rec, me.peerId) && !pendingOf(rec, me.peerId)) {
		throw new Error('You are not on this project.');
	}
	if (isAdmin(rec, me.peerId) && adminCount(rec) <= 1 && rec.members.length > 1) {
		throw new Error('Pass admin to someone else before you leave.');
	}
	const next = await detachLocalCopy(folderUri, rec);
	await cleanupSharingMarkersOnDetach(kbRootUri, folderPrefix);
	return next;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} peerId
 */
async function removeMember(kbRootUri, folderPrefix, peerId) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await requireShared(folderUri);
	const me = await ensurePeerIdentity();
	if (!isAdmin(rec, me.peerId)) throw new Error('Only an admin can remove a member.');
	const target = String(peerId || '');
	if (target === me.peerId && adminCount(rec) <= 1) {
		throw new Error('Pass admin to someone else before you remove yourself.');
	}
	const gone = (rec.members || []).find(m => m && m.peerId === target);
	dropPersonFromProject(rec, target);
	await writeProjectRecord(folderUri, rec);
	try {
		const lan = require('./projectLanSync');
		lan.dropPeerOnline(rec.projectId, target);
		if (!lan.isSharingActive(rec.projectId) && gone) {
			require('./projectShareNotify').rememberRemovalWhileOffline(rec.projectId, gone);
		}
	} catch {
		/* presence is optional */
	}
	return rec;
}

/**
 * Remove every guest (no GitHub). GitHub members stay.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function removeGuestMembers(kbRootUri, folderPrefix) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await requireShared(folderUri);
	const me = await ensurePeerIdentity();
	if (!isAdmin(rec, me.peerId)) throw new Error('Only an admin can remove guests.');
	const removed = (rec.members || []).filter(m => m && isGuestMember(m) && m.peerId !== me.peerId);
	const gone = new Set(removed.map(m => m.peerId));
	rec.members = (rec.members || []).filter(m => m && !gone.has(m.peerId));
	await writeProjectRecord(folderUri, rec);
	try {
		const lan = require('./projectLanSync');
		for (const m of removed) {
			lan.dropPeerOnline(rec.projectId, m.peerId);
			if (!lan.isSharingActive(rec.projectId)) {
				require('./projectShareNotify').rememberRemovalWhileOffline(rec.projectId, m);
			}
		}
	} catch {
		/* presence is optional */
	}
	return { record: rec, removed };
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {boolean} allowGuests
 */
async function setAllowGuests(kbRootUri, folderPrefix, allowGuests) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await requireShared(folderUri);
	const me = await ensurePeerIdentity();
	if (!isAdmin(rec, me.peerId)) throw new Error('Only an admin can change who may join.');
	rec.allowGuests = allowGuests !== false;
	await writeProjectRecord(folderUri, rec);
	return rec;
}

/**
 * Admin disconnect: drop every non-admin. Other admins stay until removed one by one.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function removeNonAdminMembers(kbRootUri, folderPrefix) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await requireShared(folderUri);
	const me = await ensurePeerIdentity();
	if (!isAdmin(rec, me.peerId)) throw new Error('Only an admin can remove members.');
	const removed = (rec.members || []).filter(m => m && m.role !== 'admin');
	if (!removed.length) return { record: rec, removed: [] };
	rec.members = (rec.members || []).filter(m => m && m.role === 'admin');
	await writeProjectRecord(folderUri, rec);
	return { record: rec, removed };
}

/**
 * Promote a member to admin so the last admin can leave.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} peerId
 */
async function passAdmin(kbRootUri, folderPrefix, peerId) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await requireShared(folderUri);
	const me = await ensurePeerIdentity();
	if (!isAdmin(rec, me.peerId)) throw new Error('Only an admin can pass admin.');
	const m = memberOf(rec, peerId);
	if (!m) throw new Error('That person is not a member.');
	m.role = 'admin';
	await writeProjectRecord(folderUri, rec);
	return rec;
}

/**
 * A copied shared folder: keep the same project id (rejoin) or mint a solo copy.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {'rejoin' | 'solo-copy'} mode
 */
async function resolveCopiedProject(kbRootUri, folderPrefix, mode) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await readProjectRecord(folderUri);
	if (!rec) throw new Error('This folder is not a shared project.');
	const me = await ensurePeerIdentity();
	if (mode === 'solo-copy') {
		const next = {
			...emptyProjectRecord(),
			projectId: newPrefixedId('proj'),
			shared: false,
			name: rec.name,
			createdAt: new Date().toISOString(),
			members: [],
			highWater: rec.highWater
		};
		await writeProjectRecord(folderUri, next);
		return next;
	}
	if (!memberOf(rec, me.peerId)) {
		const blocked = joinBlockReason(rec, me);
		if (blocked) throw new Error(blocked);
		upsertPendingJoiner(rec, me);
		await writeProjectRecord(folderUri, rec);
	}
	return rec;
}

/**
 * Accept an invite against a folder that already has the matching project id
 * (used when a snapshot bundle created the folder, or the folder was copied).
 */
async function acceptInviteOnFolder(kbRootUri, folderPrefix, inviteCode) {
	const invite = parseInviteCode(inviteCode);
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await requireShared(folderUri);
	if (rec.projectId !== invite.projectId) {
		throw new Error('That invite is for a different project.');
	}
	if (rec.inviteCapability !== invite.capability) {
		throw new Error('That invite is no longer valid. Ask for a new one.');
	}
	const me = await ensurePeerIdentity();
	const blocked = joinBlockReason(rec, me);
	if (blocked) throw new Error(blocked);
	if (!memberOf(rec, me.peerId)) {
		upsertPendingJoiner(rec, me);
		await writeProjectRecord(folderUri, rec);
	}
	await require('./projectLanSync').writeSharingActive(rec.projectId, true);
	return rec;
}

/**
 * Admin admits a waiting person and picks their role and teams.
 * Everyone is always included.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} peerId
 * @param {string} [role]
 * @param {string[]} [teamIds]
 */
async function admitJoiner(kbRootUri, folderPrefix, peerId, role, teamIds) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await requireShared(folderUri);
	const me = await ensurePeerIdentity();
	if (!isAdmin(rec, me.peerId)) throw new Error('Only an admin can admit someone.');
	const pending = pendingOf(rec, peerId);
	if (!pending) throw new Error('That person is not waiting to join.');
	const member = admittedMemberFromPending(rec, pending, role, teamIds);
	rec.members.push(member);
	removePendingJoiner(rec, peerId);
	await writeProjectRecord(folderUri, rec);
	return { record: rec, member };
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} peerId
 */
async function declineJoiner(kbRootUri, folderPrefix, peerId) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await requireShared(folderUri);
	const me = await ensurePeerIdentity();
	if (!isAdmin(rec, me.peerId)) throw new Error('Only an admin can decline a join request.');
	const pending = pendingOf(rec, peerId);
	if (!pending) return rec;
	removePendingJoiner(rec, peerId);
	await writeProjectRecord(folderUri, rec);
	return { record: rec, pending };
}

/**
 * Same GitHub owner on a new machine: keep admin, accept the new local key.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function recoverOwnerIfGithubMatches(kbRootUri, folderPrefix) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await readProjectRecord(folderUri);
	if (!rec || !rec.shared || !rec.ownerGithubId) return rec;
	const me = await ensurePeerIdentity();
	if (!me.githubId || String(me.githubId) !== String(rec.ownerGithubId)) return rec;
	const owner = (rec.members || []).find(m => m && String(m.githubId) === String(rec.ownerGithubId));
	if (!owner) {
		rec.members.push(
			memberEntryFromPeer(me, 'admin', {
				githubId: me.githubId,
				githubLogin: me.githubLogin || rec.ownerGithubLogin
			})
		);
		await writeProjectRecord(folderUri, rec);
		return rec;
	}
	if (owner.peerId === me.peerId && owner.publicKey === me.publicKey) return rec;
	owner.peerId = me.peerId;
	owner.publicKey = me.publicKey;
	owner.encKey = me.encKey || owner.encKey || '';
	owner.displayName = me.displayName;
	owner.role = 'admin';
	owner.githubLogin = me.githubLogin || owner.githubLogin;
	await writeProjectRecord(folderUri, rec);
	return rec;
}

async function requireShared(projectFolderUri) {
	const rec = await readProjectRecord(projectFolderUri);
	if (!rec || !rec.shared) throw new Error('This project is not shared.');
	return rec;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function getShareSummary(kbRootUri, folderPrefix) {
	await recoverOwnerIfGithubMatches(kbRootUri, folderPrefix);
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await readProjectRecord(folderUri);
	const me = await ensurePeerIdentity();
	if (!rec || !rec.shared) {
		return {
			shared: false,
			sharingActive: false,
			projectId: rec && rec.projectId ? rec.projectId : '',
			name: rec && rec.name ? rec.name : '',
			members: [],
			role: '',
			invite: '',
			status: 'solo'
		};
	}
	await persistShareDefaults(folderUri, rec);
	const mine = memberOf(rec, me.peerId);
	const waiting = pendingOf(rec, me.peerId);
	const lan = require('./projectLanSync');
	const sharingActive = lan.isSharingActive(rec.projectId);
	return {
		shared: true,
		sharingActive,
		projectId: rec.projectId,
		name: rec.name,
		ownerGithubLogin: rec.ownerGithubLogin || '',
		members: rec.members || [],
		pendingJoiners: rec.pendingJoiners || [],
		role: mine ? mine.role : '',
		waitingAdmit: !mine && !!waiting,
		invite: inviteCodeFromRecord(rec),
		status: mine ? 'member' : waiting ? 'waiting' : 'copied',
		mailboxRepo: rec.mailboxRepo || '',
		allowGuests: rec.allowGuests !== false
	};
}

/**
 * Pause or resume live sharing on this machine. The project stays shared; members stay.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {boolean} active
 */
async function setSharingActive(kbRootUri, folderPrefix, active) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await requireShared(folderUri);
	const me = await ensurePeerIdentity();
	const lan = require('./projectLanSync');
	await lan.writeSharingActive(rec.projectId, active !== false);
	if (active !== false) {
		await lan.startLanListener(kbRootUri, folderPrefix);
		try {
			await require('./projectInternetSync').startInternetListener(kbRootUri, folderPrefix);
		} catch (err) {
			console.error('[DRIP] internet listener', err);
		}
		lan.markPeerOnline(rec.projectId, me.peerId);
		lan.keepOnlineMembers(
			rec.projectId,
			(rec.members || []).map(m => m && m.peerId).concat([me.peerId])
		);
	} else {
		lan.disconnectAllPeers(rec.projectId);
	}
	try {
		require('./projectShareNotify').announceShareStateChanged(folderPrefix);
	} catch {
		/* UI refresh is optional */
	}
	return rec;
}

/**
 * Force an immediate reconnect while sharing stays on: re-open the LAN listener,
 * say hello to every remembered peer right now, and re-open the internet relay.
 * Used by the manual "Reconnect now" button so a peer that fell out of sync can
 * catch up without toggling sharing off and on.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function reconnectNow(kbRootUri, folderPrefix) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await requireShared(folderUri);
	const me = await ensurePeerIdentity();
	const lan = require('./projectLanSync');
	await lan.startLanListener(kbRootUri, folderPrefix);
	try {
		await require('./projectInternetSync').startInternetListener(kbRootUri, folderPrefix);
	} catch (err) {
		console.error('[DRIP] internet listener on reconnect', err);
	}
	lan.markPeerOnline(rec.projectId, me.peerId);
	await lan.helloKnownLanPeers(kbRootUri, folderPrefix);
	require('./projectShareNotify').announceShareStateChanged(folderPrefix);
	return rec;
}

function isSharingActive(projectId) {
	return require('./projectLanSync').isSharingActive(projectId);
}

module.exports = {
	ACCESS_ROLES,
	parseInviteCode,
	parseAccessCode,
	inviteCodeFromRecord,
	accessCodeFromRecord,
	ensureAccessCapabilities,
	memberOf,
	isAdmin,
	shareProject,
	rotateInvite,
	rotateAccess,
	redeemAccessCode,
	joiningMemberEntry,
	pendingOf,
	pendingEntryFromPerson,
	upsertPendingJoiner,
	removePendingJoiner,
	rememberJoinRequest,
	admitJoiner,
	declineJoiner,
	dropPersonFromProject,
	leaveProject,
	detachLocalCopy,
	unshareProject,
	cleanupSharingMarkersOnDetach,
	removeMember,
	removeGuestMembers,
	setAllowGuests,
	isGuestMember,
	joinBlockReason,
	refuseJoinReason,
	personFromWire,
	wireIdentityFields,
	refreshMemberFromPerson,
	blockMemberOnRecord,
	allowJoinAgain,
	memberPublicName,
	memberEntryFromPeer,
	removeNonAdminMembers,
	passAdmin,
	resolveCopiedProject,
	acceptInviteOnFolder,
	recoverOwnerIfGithubMatches,
	getShareSummary,
	setSharingActive,
	reconnectNow,
	isSharingActive,
	isProjectShared,
	projectFolderUriFromPrefix
};
