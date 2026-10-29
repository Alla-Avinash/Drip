'use strict';

/**
 * One signed, atomic project operation.
 */

const { newPrefixedId } = require('./peerIds');
const { ensurePeerIdentity, signPayload, verifyPayload } = require('./peerIdentity');

const OP_TYPES = Object.freeze({
	ISSUE_CREATE: 'issue.create',
	ISSUE_UPDATE: 'issue.update',
	ISSUE_FIELD_SET: 'issue.field.set',
	ISSUE_TITLE_SET: 'issue.title.set',
	ISSUE_BODY_APPEND: 'issue.body.append',
	ISSUE_BODY_SET: 'issue.body.set',
	ISSUE_MOVE: 'issue.move',
	ISSUE_DELETE: 'issue.delete',
	ISSUE_PARENT_SET: 'issue.parent.set',
	FEATURE_CREATE: 'feature.create',
	FEATURE_FIELD_SET: 'feature.field.set',
	NOTE_CREATE: 'note.create',
	NOTE_UPDATE: 'note.update',
	NOTE_HEADING_BODY_SET: 'note.heading.body.set',
	HEADING_DELETE: 'heading.delete',
	CONCEPT_CREATE: 'concept.create',
	CONCEPT_UPDATE: 'concept.update',
	CONCEPT_DELETE: 'concept.delete',
	DECISION_CREATE: 'decision.create',
	DECISION_UPDATE: 'decision.update',
	DECISION_DELETE: 'decision.delete',
	TAG_CREATE: 'tag.create',
	TAG_RENAME: 'tag.rename',
	TAG_DELETE: 'tag.delete',
	METADATA_SET: 'metadata.override.set',
	MEMBER_INVITE: 'member.invite',
	MEMBER_ACCEPT: 'member.accept',
	MEMBER_ADMIT: 'member.admit',
	MEMBER_JOIN_DECLINE: 'member.join.decline',
	MEMBER_REMOVE: 'member.remove',
	JOIN_POLICY_SET: 'join.policy.set',
	PROJECT_SHARE: 'project.share',
	PROJECT_LEAVE: 'project.leave',
	PROJECT_UNSHARE: 'project.unshare',
	PROJECT_COMPACT: 'project.compact',
	MAILBOX_REPO_SET: 'mailbox.repo.set',
	TEAM_UPSERT: 'team.upsert',
	TEAM_DELETE: 'team.delete',
	TEAM_MEMBERS_SET: 'team.members.set',
	TEAM_DEFAULT_SET: 'team.default.set',
	MEMBER_ROLE_SET: 'member.role.set',
	MEMBER_ACCESS_REDEEM: 'member.access.redeem',
	ACCESS_CAPS_SET: 'access.caps.set',
	CHAT_APPEND: 'chat.append',
	CHAT_CLEAR: 'chat.clear',
	CHAT_READ: 'chat.read'
});

/**
 * @param {{
 *   projectId: string,
 *   type: string,
 *   payload: object,
 *   seq: number,
 *   parents?: string[]
 * }} opts
 */
async function createOperation(opts) {
	const me = await ensurePeerIdentity();
	const unsigned = {
		opId: newPrefixedId('op'),
		type: String(opts.type || ''),
		projectId: String(opts.projectId || ''),
		author: me.peerId,
		seq: Math.max(1, Math.floor(Number(opts.seq) || 1)),
		createdAt: new Date().toISOString(),
		parents: Array.isArray(opts.parents) ? opts.parents.map(String) : [],
		payload: opts.payload && typeof opts.payload === 'object' ? opts.payload : {}
	};
	const signed = await signPayload(unsigned);
	return { ...unsigned, signature: signed.signature };
}

/**
 * @param {object} op
 * @param {string} publicKey
 */
function verifyOperation(op, publicKey) {
	if (!op || !op.opId || !op.signature || !op.author) return false;
	const { signature, ...rest } = op;
	return verifyPayload(rest, signature, publicKey);
}

/**
 * Sort for remint / last-write-wins: time, then peer id, then op id.
 * @param {object} a
 * @param {object} b
 */
function compareOps(a, b) {
	const ta = Date.parse(String((a && a.createdAt) || '')) || 0;
	const tb = Date.parse(String((b && b.createdAt) || '')) || 0;
	if (ta !== tb) return ta - tb;
	const pa = String((a && a.author) || '');
	const pb = String((b && b.author) || '');
	if (pa !== pb) return pa < pb ? -1 : 1;
	const ia = String((a && a.opId) || '');
	const ib = String((b && b.opId) || '');
	if (ia === ib) return 0;
	return ia < ib ? -1 : 1;
}

function isKnownOpType(type) {
	return Object.values(OP_TYPES).includes(String(type || ''));
}

module.exports = {
	OP_TYPES,
	createOperation,
	verifyOperation,
	compareOps,
	isKnownOpType
};
