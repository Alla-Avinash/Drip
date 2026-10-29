'use strict';

/**
 * Teams live on the project sidecar (not as folders). An issue's `team` field
 * is only a label; this list is who exists and who belongs where.
 *
 * There is no forced "Everyone" team. Every member belongs to at least one real
 * team (assigned when they are admitted), and an issue may carry an empty team
 * (unassigned). Deleting a team removes members left with no other team.
 */

const { newPrefixedId } = require('./peerIds');
const { ensurePeerIdentity } = require('./peerIdentity');
const {
	readProjectRecord,
	writeProjectRecord,
	projectFolderUriFromPrefix
} = require('./projectSidecar');
const { memberOf, isAdmin, adminCount } = require('./projectSharing');
const { normalizeRole, hasCap, CAPS } = require('./projectRoles');

const RESERVED_TEAM_NAME = 'everyone';

function normalizeTeam(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const id = String(raw.id || '').trim();
	const name = String(raw.name || '').trim();
	if (!id || !name) return null;
	return {
		id,
		name,
		leadPeerId: String(raw.leadPeerId || '').trim()
	};
}

function normalizeTeamsOnRecord(rec) {
	if (!rec) return rec;
	rec.teams = Array.isArray(rec.teams) ? rec.teams.map(normalizeTeam).filter(Boolean) : [];
	rec.defaultTeamId = '';
	for (const m of rec.members || []) {
		if (!m) continue;
		m.role = normalizeRole(m.role);
		m.teamIds = Array.isArray(m.teamIds)
			? m.teamIds.map(id => String(id || '').trim()).filter(id => rec.teams.some(t => t.id === id))
			: [];
	}
	return rec;
}

function teamById(rec, teamId) {
	const id = String(teamId || '').trim();
	return ((rec && rec.teams) || []).find(t => t && t.id === id) || null;
}

function memberTeamIds(rec, peerId) {
	const m = memberOf(rec, peerId);
	return m && Array.isArray(m.teamIds) ? m.teamIds.slice() : [];
}

function canSeeTeam(rec, peerId, teamId) {
	if (!rec || !((rec.teams || []).length)) return true;
	if (hasCap(rec, peerId, CAPS.VIEW_ALL_TEAMS)) return true;
	return memberTeamIds(rec, peerId).includes(String(teamId || '').trim());
}

function canSeeIssueTeamName(rec, peerId, teamName) {
	if (!rec || !((rec.teams || []).length)) return true;
	if (hasCap(rec, peerId, CAPS.VIEW_ALL_TEAMS)) return true;
	const want = String(teamName || '').trim().toLowerCase();
	if (!want) return false;
	const ids = memberTeamIds(rec, peerId);
	return (rec.teams || []).some(t => ids.includes(t.id) && String(t.name || '').trim().toLowerCase() === want);
}

async function requireAdmin(folderUri) {
	const rec = await readProjectRecord(folderUri);
	if (!rec || !rec.shared) throw new Error('This project is not shared.');
	normalizeTeamsOnRecord(rec);
	const me = await ensurePeerIdentity();
	if (!isAdmin(rec, me.peerId)) throw new Error('Only an admin can change teams and roles.');
	return { rec, me };
}

async function createTeam(kbRootUri, folderPrefix, name) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const { rec } = await requireAdmin(folderUri);
	const trimmed = String(name || '').trim();
	if (!trimmed) throw new Error('Enter a team name.');
	if (trimmed.toLowerCase() === RESERVED_TEAM_NAME) {
		throw new Error('That name is reserved.');
	}
	if (rec.teams.some(t => String(t.name).toLowerCase() === trimmed.toLowerCase())) {
		throw new Error('A team with that name already exists.');
	}
	const team = { id: newPrefixedId('team'), name: trimmed, leadPeerId: '' };
	rec.teams.push(team);
	await writeProjectRecord(folderUri, rec);
	return { record: rec, team };
}

async function renameTeam(kbRootUri, folderPrefix, teamId, name) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const { rec } = await requireAdmin(folderUri);
	const team = teamById(rec, teamId);
	if (!team) throw new Error('That team was not found.');
	const trimmed = String(name || '').trim();
	if (!trimmed) throw new Error('Enter a team name.');
	if (trimmed.toLowerCase() === RESERVED_TEAM_NAME) throw new Error('That name is reserved.');
	if (rec.teams.some(t => t.id !== team.id && String(t.name).toLowerCase() === trimmed.toLowerCase())) {
		throw new Error('A team with that name already exists.');
	}
	team.name = trimmed;
	await writeProjectRecord(folderUri, rec);
	return { record: rec, team };
}

async function setTeamLead(kbRootUri, folderPrefix, teamId, leadPeerId) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const { rec } = await requireAdmin(folderUri);
	const team = teamById(rec, teamId);
	if (!team) throw new Error('That team was not found.');
	const lead = String(leadPeerId || '').trim();
	if (lead && !memberOf(rec, lead)) throw new Error('That person is not on the project.');
	team.leadPeerId = lead;
	await writeProjectRecord(folderUri, rec);
	return { record: rec, team };
}

async function deleteTeam(kbRootUri, folderPrefix, teamId) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const { rec } = await requireAdmin(folderUri);
	const id = String(teamId || '').trim();
	if (!teamById(rec, id)) throw new Error('That team was not found.');
	// Refuse to strand every admin, which would orphan the project.
	const adminsStranded = (rec.members || []).filter(
		m => m && m.role === 'admin' && Array.isArray(m.teamIds) && m.teamIds.length === 1 && m.teamIds[0] === id
	);
	if (adminsStranded.length && adminsStranded.length >= adminCount(rec)) {
		throw new Error('That team holds the only admin. Move them to another team first.');
	}
	rec.teams = rec.teams.filter(t => t.id !== id);
	const removed = [];
	const kept = [];
	for (const m of rec.members || []) {
		if (!m) continue;
		m.teamIds = (m.teamIds || []).filter(x => x !== id);
		if (m.teamIds.length) kept.push(m);
		else removed.push(m);
	}
	rec.members = kept;
	await writeProjectRecord(folderUri, rec);
	return { record: rec, removed };
}

async function setMemberTeams(kbRootUri, folderPrefix, peerId, teamIds) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const { rec } = await requireAdmin(folderUri);
	const m = memberOf(rec, peerId);
	if (!m) throw new Error('That person is not on the project.');
	const allow = new Set((rec.teams || []).map(t => t.id));
	const next = (Array.isArray(teamIds) ? teamIds : []).map(String).filter(id => allow.has(id));
	if (!next.length) throw new Error('A member needs at least one team. Remove them instead.');
	m.teamIds = next;
	await writeProjectRecord(folderUri, rec);
	return { record: rec };
}

async function setMemberRole(kbRootUri, folderPrefix, peerId, role) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const { rec, me } = await requireAdmin(folderUri);
	const m = memberOf(rec, peerId);
	if (!m) throw new Error('That person is not on the project.');
	const next = normalizeRole(role);
	if (m.role === 'admin' && next !== 'admin' && adminCount(rec) <= 1) {
		throw new Error('Pass admin to someone else before you change the last admin.');
	}
	if (m.peerId === me.peerId && next !== 'admin' && adminCount(rec) <= 1) {
		throw new Error('Pass admin to someone else before you change your own role.');
	}
	m.role = next;
	await writeProjectRecord(folderUri, rec);
	return { record: rec };
}

function applyTeamPayload(rec, op) {
	normalizeTeamsOnRecord(rec);
	const { OP_TYPES } = require('./projectOp');
	const p = op.payload || {};
	if (op.type === OP_TYPES.TEAM_UPSERT && p.team) {
		const team = normalizeTeam(p.team);
		if (!team) return rec;
		const i = rec.teams.findIndex(t => t.id === team.id);
		if (i >= 0) rec.teams[i] = team;
		else rec.teams.push(team);
	} else if (op.type === OP_TYPES.TEAM_DELETE && p.teamId) {
		const id = String(p.teamId);
		rec.teams = rec.teams.filter(t => t.id !== id);
		for (const m of rec.members || []) {
			m.teamIds = (m.teamIds || []).filter(x => x !== id);
		}
	} else if (op.type === OP_TYPES.TEAM_MEMBERS_SET && p.peerId) {
		const m = memberOf(rec, p.peerId);
		if (m) {
			const allow = new Set(rec.teams.map(t => t.id));
			m.teamIds = (Array.isArray(p.teamIds) ? p.teamIds : []).map(String).filter(id => allow.has(id));
		}
	} else if (op.type === OP_TYPES.TEAM_DEFAULT_SET) {
		rec.defaultTeamId = '';
	} else if (op.type === OP_TYPES.MEMBER_ROLE_SET && p.peerId) {
		const m = memberOf(rec, p.peerId);
		if (m) m.role = normalizeRole(p.role);
	}
	return rec;
}

function teamsForWebview(rec, peerId) {
	normalizeTeamsOnRecord(rec);
	const mine = memberTeamIds(rec, peerId);
	const viewAll = hasCap(rec, peerId, CAPS.VIEW_ALL_TEAMS);
	return {
		// Everyone can browse every team's issues, so the dropdown lists all teams.
		teams: (rec.teams || []).map(t => ({
			id: t.id,
			name: t.name,
			leadPeerId: t.leadPeerId || '',
			mine: mine.includes(t.id)
		})),
		defaultTeamId: rec.defaultTeamId || '',
		myTeamIds: mine,
		canViewAll: viewAll,
		caps: memberCapsSafe(rec, peerId)
	};
}

function memberCapsSafe(rec, peerId) {
	try {
		const { memberCaps } = require('./projectRoles');
		return memberCaps(rec, peerId);
	} catch {
		return {};
	}
}

module.exports = {
	normalizeTeamsOnRecord,
	teamById,
	memberTeamIds,
	canSeeTeam,
	canSeeIssueTeamName,
	createTeam,
	renameTeam,
	setTeamLead,
	deleteTeam,
	setMemberTeams,
	setMemberRole,
	applyTeamPayload,
	teamsForWebview
};
