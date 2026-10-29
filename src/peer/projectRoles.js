'use strict';

/**
 * Project roles for a shared folder. The files on disk are still a full copy —
 * roles only gate the product UI and which signed operations others accept.
 */

const { memberOf } = require('./projectSharing');

const ROLES = Object.freeze(['admin', 'member', 'updater', 'viewer']);

const CAPS = Object.freeze({
	SHARE_MANAGE: 'shareManage',
	ISSUE_CREATE: 'issueCreate',
	ISSUE_EDIT: 'issueEdit',
	ISSUE_STATUS: 'issueStatus',
	ISSUE_MOVE: 'issueMove',
	ISSUE_DELETE: 'issueDelete',
	CHAT_WRITE: 'chatWrite',
	VIEW_ALL_TEAMS: 'viewAllTeams'
});

function normalizeRole(role) {
	const r = String(role || '').trim().toLowerCase();
	if (r === 'admin') return 'admin';
	if (r === 'updater') return 'updater';
	if (r === 'viewer') return 'viewer';
	return 'member';
}

function capabilitiesForRole(role) {
	const r = normalizeRole(role);
	if (r === 'admin') {
		return {
			shareManage: true,
			issueCreate: true,
			issueEdit: true,
			issueStatus: true,
			issueMove: true,
			issueDelete: true,
			chatWrite: true,
			viewAllTeams: true
		};
	}
	if (r === 'member') {
		return {
			shareManage: false,
			issueCreate: true,
			issueEdit: true,
			issueStatus: true,
			issueMove: true,
			issueDelete: true,
			chatWrite: true,
			viewAllTeams: false
		};
	}
	if (r === 'updater') {
		return {
			shareManage: false,
			issueCreate: false,
			issueEdit: false,
			issueStatus: true,
			issueMove: false,
			issueDelete: false,
			chatWrite: true,
			viewAllTeams: false
		};
	}
	return {
		shareManage: false,
		issueCreate: false,
		issueEdit: false,
		issueStatus: false,
		issueMove: false,
		issueDelete: false,
		chatWrite: false,
		viewAllTeams: false
	};
}

/**
 * Whether this role may pause or resume live sharing on this machine.
 * Admin, member, and updater can stop/start their own connection. A viewer has
 * no sharing controls — they only receive changes.
 * @param {string} role
 */
function canToggleSharing(role) {
	const r = normalizeRole(role);
	return r === 'admin' || r === 'member' || r === 'updater';
}

function memberCaps(rec, peerId) {
	const m = memberOf(rec, peerId);
	if (!m) return capabilitiesForRole('viewer');
	return capabilitiesForRole(m.role);
}

function hasCap(rec, peerId, cap) {
	return !!memberCaps(rec, peerId)[cap];
}

/**
 * Whether this signed operation is allowed for its author on this project.
 * Join / first share stay open so a new member can land.
 * @param {object} rec
 * @param {object} op
 */
function canApplyOp(rec, op) {
	if (!op || !op.type) return false;
	const { OP_TYPES } = require('./projectOp');
	if (
		op.type === OP_TYPES.MEMBER_ACCEPT ||
		op.type === OP_TYPES.PROJECT_SHARE ||
		op.type === OP_TYPES.PROJECT_LEAVE
	) {
		return true;
	}
	const m = memberOf(rec, op.author);
	if (!m) return false;
	const caps = capabilitiesForRole(m.role);
	switch (op.type) {
		case OP_TYPES.ISSUE_CREATE:
		case OP_TYPES.FEATURE_CREATE:
		case OP_TYPES.NOTE_CREATE:
		case OP_TYPES.CONCEPT_CREATE:
		case OP_TYPES.DECISION_CREATE:
			return caps.issueCreate;
		case OP_TYPES.ISSUE_UPDATE: {
			const payload = op.payload || {};
			const attrs = payload.attributes && typeof payload.attributes === 'object' ? payload.attributes : {};
			const keys = Object.keys(attrs);
			const noText = payload.title == null && payload.body == null;
			const onlyStatus =
				noText && keys.length > 0 && keys.every(k => k === 'status' || k === 'completed');
			if (onlyStatus) return caps.issueStatus;
			return caps.issueEdit;
		}
		case OP_TYPES.ISSUE_FIELD_SET: {
			const field = String((op.payload && op.payload.field) || '').toLowerCase();
			if (field === 'status' || field === 'deadline' || field === 'completed') {
				return caps.issueStatus || caps.issueEdit;
			}
			return caps.issueEdit;
		}
		case OP_TYPES.ISSUE_TITLE_SET:
		case OP_TYPES.ISSUE_BODY_APPEND:
		case OP_TYPES.ISSUE_BODY_SET:
		case OP_TYPES.ISSUE_PARENT_SET:
		case OP_TYPES.NOTE_HEADING_BODY_SET:
		case OP_TYPES.CONCEPT_UPDATE:
		case OP_TYPES.DECISION_UPDATE:
			return caps.issueEdit;
		case OP_TYPES.ISSUE_MOVE:
			return caps.issueMove;
		case OP_TYPES.ISSUE_DELETE:
		case OP_TYPES.HEADING_DELETE:
		case OP_TYPES.CONCEPT_DELETE:
		case OP_TYPES.DECISION_DELETE:
			return caps.issueDelete;
		case OP_TYPES.CHAT_APPEND:
		case OP_TYPES.CHAT_CLEAR:
		case OP_TYPES.CHAT_READ:
			return caps.chatWrite;
		case OP_TYPES.TEAM_UPSERT:
		case OP_TYPES.TEAM_DELETE:
		case OP_TYPES.TEAM_MEMBERS_SET:
		case OP_TYPES.TEAM_DEFAULT_SET:
		case OP_TYPES.MEMBER_ROLE_SET:
		case OP_TYPES.MEMBER_REMOVE:
		case OP_TYPES.MEMBER_INVITE:
		case OP_TYPES.JOIN_POLICY_SET:
		case OP_TYPES.MAILBOX_REPO_SET:
		case OP_TYPES.PROJECT_COMPACT:
		case OP_TYPES.ACCESS_CAPS_SET:
		case OP_TYPES.MEMBER_ADMIT:
		case OP_TYPES.MEMBER_JOIN_DECLINE:
		case OP_TYPES.PROJECT_UNSHARE:
			return caps.shareManage;
		case OP_TYPES.MEMBER_ACCESS_REDEEM: {
			const role = normalizeRole(op.payload && op.payload.role);
			const cap = String((op.payload && op.payload.capability) || '');
			const want =
				rec.accessCapabilities && role && rec.accessCapabilities[role]
					? String(rec.accessCapabilities[role])
					: '';
			return !!(want && cap && want === cap && role !== 'viewer');
		}
		case OP_TYPES.PROJECT_LEAVE:
			return true;
		default:
			return caps.issueEdit || caps.shareManage;
	}
}

module.exports = {
	ROLES,
	CAPS,
	normalizeRole,
	capabilitiesForRole,
	canToggleSharing,
	memberCaps,
	hasCap,
	canApplyOp
};
