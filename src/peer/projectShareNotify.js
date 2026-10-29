'use strict';

/**
 * Immediate share/membership UI updates (join, remove, start/stop).
 * Presence count is separate and slower.
 */

const vscode = require('vscode');

const PENDING_REMOVALS_KEY = 'drip.projectSharing.pendingRemovalNotices';
/** @type {Map<string, number>} */
const lastRemovedSeenAt = new Map();
const REMOVED_SEEN_WAIT_MS = 10 * 60 * 1000;

function memberPublicName(member) {
	const login = String((member && member.githubLogin) || '')
		.trim()
		.replace(/^@/, '');
	if (login) return `@${login}`;
	// Guests are shown with a leading `#` so they read differently from GitHub users.
	return `#${String((member && (member.displayName || member.peerId)) || 'someone')}`;
}

function refreshShareSurfaces(folderPrefix) {
	try {
		require('../views/lhs/projects/panel').refreshProjectViewIfShown();
	} catch {
		/* Project View may be closed */
	}
	try {
		require('../views/settings/settingsPanel').refreshOpenProjectShare(folderPrefix);
	} catch {
		/* Settings may be closed */
	}
	try {
		require('./projectLanSync').notifyPresenceChange(true);
	} catch {
		/* presence is optional */
	}
}

/**
 * @param {import('vscode').Uri} [_kbRootUri]
 * @param {string} folderPrefix
 * @param {{ name?: string }} rec
 * @param {object} member
 */
function announceJoinRequested(folderPrefix, rec, person) {
	const who = memberPublicName(person);
	const kind = String((person && person.githubLogin) || '').trim()
		? 'GitHub'
		: 'guest';
	const project = String((rec && rec.name) || 'the project');
	void vscode.window.showInformationMessage(`${who} (${kind}) asked to join ${project}. Admit them in Share settings.`);
	refreshShareSurfaces(folderPrefix);
}

function announceMemberJoined(_kbRootUri, folderPrefix, rec, member) {
	const who = memberPublicName(member);
	const project = String((rec && rec.name) || 'the project');
	void vscode.window.showInformationMessage(`${who} joined ${project}.`);
	refreshShareSurfaces(folderPrefix);
}

/**
 * @param {string} folderPrefix
 */
function announceMemberRemoved(folderPrefix, member) {
	const who = memberPublicName(member);
	void vscode.window.showInformationMessage(`${who} was removed from the project.`);
	refreshShareSurfaces(folderPrefix);
}

function announceMemberLeft(folderPrefix, member) {
	const who = memberPublicName(member);
	void vscode.window.showInformationMessage(`${who} left the project.`);
	refreshShareSurfaces(folderPrefix);
}

/**
 * @param {string} folderPrefix
 */
function announceShareStateChanged(folderPrefix) {
	refreshShareSurfaces(folderPrefix);
}

function readPendingMap() {
	try {
		const raw = require('./peerIdentity').getPeerExtensionContext().globalState.get(PENDING_REMOVALS_KEY);
		return raw && typeof raw === 'object' ? raw : {};
	} catch {
		return {};
	}
}

function rememberRemovalWhileOffline(projectId, member) {
	const id = String(projectId || '');
	if (!id) return;
	try {
		if (require('./projectLanSync').isSharingActive(id)) return;
	} catch {
		return;
	}
	const who = memberPublicName(member);
	if (!who) return;
	try {
		const ctx = require('./peerIdentity').getPeerExtensionContext();
		const map = { ...readPendingMap() };
		const names = Array.isArray(map[id]) ? map[id].slice() : [];
		if (!names.includes(who)) names.push(who);
		map[id] = names;
		void ctx.globalState.update(PENDING_REMOVALS_KEY, map);
	} catch {
		/* notice is optional */
	}
}

function takePendingRemovalNames(projectId) {
	const id = String(projectId || '');
	if (!id) return [];
	try {
		const ctx = require('./peerIdentity').getPeerExtensionContext();
		const map = { ...readPendingMap() };
		const names = Array.isArray(map[id]) ? map[id].slice() : [];
		if (names.length) {
			delete map[id];
			void ctx.globalState.update(PENDING_REMOVALS_KEY, map);
		}
		return names;
	} catch {
		return [];
	}
}

function announceStartSharing(folderPrefix, projectId) {
	const names = takePendingRemovalNames(projectId);
	if (names.length) {
		const who = names.join(', ');
		void vscode.window.showInformationMessage(
			`Sharing is on. ${who} ${names.length === 1 ? 'was' : 'were'} removed and will not show as online.`
		);
	} else {
		void vscode.window.showInformationMessage('Sharing is on. Other people can receive your changes again.');
	}
	refreshShareSurfaces(folderPrefix);
}

function announceRemovedPeerSeen(rec, person) {
	const id = String((rec && rec.projectId) || '');
	const peer = String((person && person.peerId) || '');
	if (!id || !peer) return;
	const key = `${id}\0${peer}`;
	const now = Date.now();
	const prev = lastRemovedSeenAt.get(key) || 0;
	if (now - prev < REMOVED_SEEN_WAIT_MS) return;
	lastRemovedSeenAt.set(key, now);
	const who = memberPublicName(person);
	void vscode.window.showInformationMessage(`${who} is no longer on this project and will not show as online.`);
}

module.exports = {
	memberPublicName,
	refreshShareSurfaces,
	announceJoinRequested,
	announceMemberJoined,
	announceMemberRemoved,
	announceMemberLeft,
	announceShareStateChanged,
	rememberRemovalWhileOffline,
	takePendingRemovalNames,
	announceStartSharing,
	announceRemovedPeerSeen
};
