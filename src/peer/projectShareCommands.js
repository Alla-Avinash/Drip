'use strict';

/**
 * Commands and dialogs for identity, share / leave, invites, and change bundles.
 */

const vscode = require('vscode');
const {
	ensurePeerIdentity,
	setPeerDisplayName,
	exportPeerIdentity,
	importPeerIdentity
} = require('./peerIdentity');
const { linkGithubToPeer, signOutGithubFromPeer } = require('./peerGithub');
const {
	shareProject,
	leaveProject,
	rotateInvite,
	rotateAccess,
	redeemAccessCode,
	accessCodeFromRecord,
	removeMember,
	removeGuestMembers,
	admitJoiner,
	declineJoiner,
	setAllowGuests,
	removeNonAdminMembers,
	setSharingActive,
	reconnectNow,
	passAdmin,
	unshareProject,
	getShareSummary
} = require('./projectSharing');
const { canToggleSharing } = require('./projectRoles');
const { stampProjectHiddenIds } = require('./projectHiddenIds');
const { recordLocalOperation, OP_TYPES } = require('./projectRecord');
const { exportChangeBundle, importChangeBundle } = require('./projectBundle');
const { startLanListener, syncWithLanPeer, lanPortFor, onlineCountFor, isPeerOnline } = require('./projectLanSync');
const { readSyncState, projectFolderUriFromPrefix } = require('./projectSidecar');

/** @type {{ context?: import('vscode').ExtensionContext, state?: { getKnowledgeBaseRoot?: Function } }} */
let joinUi = {};

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {{ getKnowledgeBaseRoot?: Function, getVerifiedKnowledgeBaseRoot?: Function }} state
 * @param {{ refreshProjectView?: Function }} [_callbacks]
 */
function registerProjectShareCommands(context, state, _callbacks) {
	joinUi = { context, state };
	const kb = () =>
		(state.getVerifiedKnowledgeBaseRoot && state.getVerifiedKnowledgeBaseRoot()) ||
		(state.getKnowledgeBaseRoot && state.getKnowledgeBaseRoot());

	context.subscriptions.push(
		vscode.commands.registerCommand('drip.peer.setDisplayName', async () => {
			const me = await ensurePeerIdentity();
			const name = await vscode.window.showInputBox({
				prompt: 'PC name on this machine (the guest name other people see)',
				value: me.displayName,
				ignoreFocusOut: true
			});
			if (name == null) return;
			const updated = await setPeerDisplayName(name);
			void vscode.window.showInformationMessage(`DRIP will show you as ${updated.displayName}.`);
		}),
		vscode.commands.registerCommand('drip.projectShare.manage', async opts => {
			await vscode.commands.executeCommand('drip.openDripSettingsView', {
				panel: 'project-sharing',
				projectKey: String((opts && opts.folderPrefix) || ''),
				projectTitle: String((opts && opts.title) || '')
			});
		}),
		vscode.commands.registerCommand('drip.joinProject', async () => {
			const kbRoot = kb();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a knowledge base first.');
				return;
			}
			await runJoinProject(kbRoot);
		}),
		vscode.commands.registerCommand('drip.importProject', async () => {
			const kbRoot = kb();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a knowledge base first.');
				return;
			}
			const { importProjectFolder } = require('./projectFolderTransfer');
			await importProjectFolder(kbRoot);
		}),
		vscode.commands.registerCommand('drip.exportProject', async item => {
			const uri = item && item.uri ? item.uri : item;
			if (!uri) {
				void vscode.window.showWarningMessage('Select a project folder first.');
				return;
			}
			const { exportProjectFolder } = require('./projectFolderTransfer');
			await exportProjectFolder(uri);
		}),
		vscode.commands.registerCommand('drip.peer.exportIdentity', () => exportIdentityFile()),
		vscode.commands.registerCommand('drip.peer.importIdentity', () => importIdentityFile())
	);
}

/**
 * Write this machine's full identity (unique id, signing key, and encryption
 * key) to a user-chosen file, so the same person can be restored on another PC.
 * The file is the person — it must be kept private.
 */
async function exportIdentityFile() {
	const identity = await exportPeerIdentity();
	const picked = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.file('drip-identity.json'),
		saveLabel: 'Export DRIP identity',
		filters: { 'DRIP identity': ['json'] }
	});
	if (!picked) return;
	await vscode.workspace.fs.writeFile(picked, Buffer.from(JSON.stringify(identity, null, 2), 'utf8'));
	void vscode.window.showInformationMessage(
		'Identity exported. Keep this file private — it is your identity. On your other PC, open DRIP Settings → Account → Import identity file to become the same person.'
	);
}

/**
 * Replace this machine's identity with one from an exported identity file, so a
 * second PC can act as the same person (same unique id, signing key, and chat
 * keys). Confirms first because it overwrites the current local identity.
 */
async function importIdentityFile() {
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		openLabel: 'Import DRIP identity',
		filters: { 'DRIP identity': ['json'] }
	});
	if (!picked || !picked.length) return;
	let raw;
	try {
		raw = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8'));
	} catch {
		void vscode.window.showErrorMessage('That file is not a valid DRIP identity.');
		return;
	}
	const confirm = await vscode.window.showWarningMessage(
		'Import this identity? It replaces this PC\'s current identity (unique id, signing key, and chat keys). Use it only to move your existing identity onto a new computer.',
		{ modal: true },
		'Import'
	);
	if (confirm !== 'Import') return;
	try {
		const rec = await importPeerIdentity(raw);
		// Drop any GitHub sign-in from the previous identity so it cannot linger
		// and be mistaken for a link on the newly imported person.
		await require('./peerGithub').clearGithubToken();
		void vscode.window.showInformationMessage(`Identity imported — this PC is now ${rec.displayName}.`);
	} catch (err) {
		void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
	}
}

/**
 * Settings (and the old command) call this for one share action.
 * @param {import('vscode').Uri | undefined} kbRoot
 * @param {string} prefix
 * @param {string} action
 * @param {{ title?: string, peerId?: string, inviteCode?: string, mailboxRepo?: string, teamName?: string, teamId?: string, memberRole?: string, leadPeerId?: string, guestName?: string, chatText?: string, chatRoom?: string, chatId?: string, accessCode?: string, accessRole?: string, teamIds?: string[] }} [extra]
 */
async function runProjectShareAction(kbRoot, prefix, action, extra) {
	extra = extra || {};
	const title = String(extra.title || '');
	const peerId = String(extra.peerId || '');

	if (action === 'joinProject') {
		if (!kbRoot) {
			void vscode.window.showWarningMessage('Select a knowledge base first.');
			return;
		}
		return runJoinProject(kbRoot, extra.inviteCode);
	}
	if (action === 'changeName') {
		await vscode.commands.executeCommand('drip.peer.setDisplayName');
		return;
	}
	if (action === 'exportIdentity') {
		await exportIdentityFile();
		return;
	}
	if (action === 'importIdentity') {
		await importIdentityFile();
		return;
	}
	if (action === 'linkGithub') {
		try {
			const linked = await linkGithubToPeer();
			if (linked) {
				void vscode.window.showInformationMessage(`Signed in as ${linked.githubLogin || linked.displayName}.`);
			}
		} catch (err) {
			void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
		}
		return;
	}
	if (action === 'signOutGithub') {
		try {
			await signOutGithubFromPeer();
			void vscode.window.showInformationMessage('Signed out of GitHub. This PC still has its guest name and unique id.');
		} catch (err) {
			void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
		}
		return;
	}
	if (action === 'switchGithub') {
		try {
			const linked = await linkGithubToPeer({ replace: true });
			if (linked) {
				void vscode.window.showInformationMessage(`Signed in as ${linked.githubLogin || linked.displayName}.`);
			}
		} catch (err) {
			void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
		}
		return;
	}

	if (!kbRoot || !prefix) {
		void vscode.window.showWarningMessage('Select a project first.');
		return;
	}

	const summary = await getShareSummary(kbRoot, prefix);

	if (action === 'share') {
		await doShare(kbRoot, prefix, title);
		return;
	}
	if (action === 'copyInvite') {
		if (summary.role !== 'admin') {
			void vscode.window.showWarningMessage('Only an admin can copy the project invite.');
			return;
		}
		if (!summary.shared) {
			void vscode.window.showWarningMessage('This project is not shared yet.');
			return;
		}
		try {
			await startLanListener(kbRoot, prefix);
		} catch (err) {
			console.error('[DRIP] start listener for invite', err);
		}
		const live = await getShareSummary(kbRoot, prefix);
		if (!live.invite) {
			void vscode.window.showWarningMessage('This project is not shared yet.');
			return;
		}
		await vscode.env.clipboard.writeText(live.invite);
		void vscode.window.showInformationMessage('Invite copied. Anyone with it can ask to join. You admit them and pick their role.');
		return;
	}
	if (action === 'rotateInvite') {
		if (summary.role !== 'admin') {
			void vscode.window.showWarningMessage('Only an admin can make a new invite.');
			return;
		}
		const next = await rotateInvite(kbRoot, prefix);
		await vscode.env.clipboard.writeText(next.invite);
		void vscode.window.showInformationMessage('Old invite stopped working. The new one is on the clipboard.');
		return;
	}
	if (action === 'copyAccess') {
		if (summary.role !== 'admin') {
			void vscode.window.showWarningMessage('Only an admin can copy an access control code.');
			return;
		}
		const folderUri = projectFolderUriFromPrefix(kbRoot, prefix);
		const rec = await require('./projectSidecar').readProjectRecord(folderUri);
		const role = String((extra && extra.accessRole) || 'member');
		try {
			const code = accessCodeFromRecord(rec, role);
			await vscode.env.clipboard.writeText(code);
			void vscode.window.showInformationMessage(
				`Access control code for ${role} is on the clipboard. They enter it after they join.`
			);
		} catch (err) {
			void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
		}
		return;
	}
	if (action === 'rotateAccess') {
		if (summary.role !== 'admin') {
			void vscode.window.showWarningMessage('Only an admin can make a new access control code.');
			return;
		}
		try {
			const next = await rotateAccess(kbRoot, prefix, String((extra && extra.accessRole) || 'member'));
			await recordLocalOperation(kbRoot, prefix, OP_TYPES.ACCESS_CAPS_SET, {
				role: next.role,
				capability: next.record.accessCapabilities[next.role]
			});
			await vscode.env.clipboard.writeText(next.accessCode);
			void vscode.window.showInformationMessage(
				`Old ${next.role} access code stopped working. The new one is on the clipboard.`
			);
		} catch (err) {
			void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
		}
		return;
	}
	if (action === 'redeemAccess') {
		const code = String((extra && extra.accessCode) || '').trim();
		if (!code) {
			void vscode.window.showWarningMessage('Paste an access control code first.');
			return;
		}
		try {
			const next = await redeemAccessCode(kbRoot, prefix, code);
			await recordLocalOperation(kbRoot, prefix, OP_TYPES.MEMBER_ACCESS_REDEEM, {
				role: next.role,
				capability: next.capability
			});
			void vscode.window.showInformationMessage(`Your role on this project is now ${next.role}.`);
		} catch (err) {
			void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
		}
		return;
	}
	if (action === 'exportBundle') {
		try {
			await require('./projectRecord').flushPendingIssueUpdates(prefix);
			await require('./projectRecord').flushPendingHeadingUpdates(prefix);
		} catch {
			/* export still uses whatever is already in the log */
		}
		const uri = await vscode.window.showSaveDialog({
			saveLabel: 'Export change file',
			filters: { 'DRIP bundle': ['json'] },
			defaultUri: vscode.Uri.file(`${(summary.name || 'project').replace(/\s+/g, '-')}-changes.json`)
		});
		if (!uri) return;
		const bundle = await exportChangeBundle(kbRoot, prefix);
		await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(bundle, null, 2), 'utf8'));
		void vscode.window.showInformationMessage('Change file saved. Send that file to the other person.');
		return;
	}
	if (action === 'importBundle') {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			filters: { 'DRIP bundle': ['json'] }
		});
		if (!picked || !picked[0]) return;
		const raw = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8'));
		const result = await importChangeBundle(kbRoot, prefix, raw);
		void vscode.window.showInformationMessage(
			`Applied ${result.applied} change${result.applied === 1 ? '' : 's'} from the file.`
		);
		return;
	}
	if (action === 'lanSync') {
		const lan = await startLanListener(kbRoot, prefix);
		const port = lan && lan.port;
		const host = await vscode.window.showInputBox({
			prompt: port
				? `You are listening on port ${port}. Enter the other person’s host:port`
				: 'Enter the other person’s host:port',
			placeHolder: '192.168.1.10:41234',
			ignoreFocusOut: true
		});
		if (!host) {
			if (port) {
				void vscode.window.showInformationMessage(`Waiting for a peer on this network (port ${port}).`);
			}
			return;
		}
		const m = String(host).trim().match(/^([^:]+):(\d+)$/);
		if (!m) {
			void vscode.window.showWarningMessage('Use host:port, for example 192.168.1.10:41234');
			return;
		}
		const result = await syncWithLanPeer(kbRoot, prefix, m[1], Number(m[2]));
		void vscode.window.showInformationMessage(`Synced ${result.applied} change${result.applied === 1 ? '' : 's'}.`);
		return;
	}
	if (action === 'leave') {
		const ok = await vscode.window.showWarningMessage(
			'Leave this shared project? You keep a local solo copy. You will not get updates. You can ask to join again later with a project invite.',
			{ modal: true },
			'Leave'
		);
		if (ok !== 'Leave') return;
		try {
			await require('./projectRecord').flushPendingIssueUpdates(prefix);
			await require('./projectRecord').flushPendingHeadingUpdates(prefix);
		} catch {
			/* leave still proceeds */
		}
		await recordLocalOperation(kbRoot, prefix, OP_TYPES.PROJECT_LEAVE, {});
		await leaveProject(kbRoot, prefix);
		void vscode.window.showInformationMessage(
			'You left this project. This copy is solo. You can ask to join again later with a project invite.'
		);
		return;
	}
	if (action === 'createTeam') {
		const name = String((extra && extra.teamName) || '').trim();
		const { createTeam } = require('./projectTeams');
		const result = await createTeam(kbRoot, prefix, name);
		await recordLocalOperation(kbRoot, prefix, OP_TYPES.TEAM_UPSERT, { team: result.team });
		void vscode.window.showInformationMessage(`Team “${result.team.name}” is ready.`);
		return;
	}
	if (action === 'deleteTeam') {
		const teamId = String((extra && extra.teamId) || '');
		if (!teamId) return;
		const { deleteTeam } = require('./projectTeams');
		const result = await deleteTeam(kbRoot, prefix, teamId);
		await recordLocalOperation(kbRoot, prefix, OP_TYPES.TEAM_DELETE, { teamId });
		const removed = Array.isArray(result.removed) ? result.removed : [];
		for (const m of removed) {
			await recordLocalOperation(kbRoot, prefix, OP_TYPES.MEMBER_REMOVE, { peerId: m.peerId });
		}
		if (removed.length) {
			void vscode.window.showInformationMessage(
				`Team deleted. ${removed.length} member${removed.length === 1 ? '' : 's'} with no other team ${removed.length === 1 ? 'was' : 'were'} removed.`
			);
		}
		return;
	}
	if (action === 'setTeamLead') {
		const teamId = String((extra && extra.teamId) || '');
		const leadPeerId = String((extra && extra.leadPeerId) || peerId || '');
		if (!teamId) return;
		const { setTeamLead, teamById } = require('./projectTeams');
		const folderUri = projectFolderUriFromPrefix(kbRoot, prefix);
		const rec = await require('./projectSidecar').readProjectRecord(folderUri);
		await setTeamLead(kbRoot, prefix, teamId, leadPeerId);
		const team = teamById(rec, teamId);
		if (team) {
			team.leadPeerId = leadPeerId;
			await recordLocalOperation(kbRoot, prefix, OP_TYPES.TEAM_UPSERT, { team });
		}
		return;
	}
	if (action === 'toggleMemberTeam') {
		const teamId = String((extra && extra.teamId) || '');
		if (!peerId || !teamId) return;
		const { setMemberTeams, memberTeamIds } = require('./projectTeams');
		const folderUri = projectFolderUriFromPrefix(kbRoot, prefix);
		const rec = await require('./projectSidecar').readProjectRecord(folderUri);
		const cur = memberTeamIds(rec, peerId);
		const next = cur.includes(teamId) ? cur.filter(id => id !== teamId) : cur.concat([teamId]);
		try {
			await setMemberTeams(kbRoot, prefix, peerId, next);
		} catch (err) {
			void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
			return;
		}
		await recordLocalOperation(kbRoot, prefix, OP_TYPES.TEAM_MEMBERS_SET, { peerId, teamIds: next });
		return;
	}
	if (action === 'setMemberRole') {
		if (!peerId) return;
		const role = String((extra && extra.memberRole) || 'member');
		const { setMemberRole } = require('./projectTeams');
		await setMemberRole(kbRoot, prefix, peerId, role);
		await recordLocalOperation(kbRoot, prefix, OP_TYPES.MEMBER_ROLE_SET, { peerId, role });
		return;
	}
	if (action === 'passAdmin') {
		if (!peerId) return;
		await passAdmin(kbRoot, prefix, peerId);
		return;
	}
	if (action === 'removeMember') {
		if (!peerId) return;
		const target = (summary.members || []).find(m => m && m.peerId === peerId);
		const who = require('./projectShareNotify').memberPublicName(target || { peerId });
		const ok = await vscode.window.showWarningMessage(
			`Remove ${who} from this project? They will no longer sync. They can ask to join again with a project invite, and you decide whether to admit them.`,
			{ modal: true },
			'Remove'
		);
		if (ok !== 'Remove') return;
		await recordLocalOperation(kbRoot, prefix, OP_TYPES.MEMBER_REMOVE, { peerId });
		await removeMember(kbRoot, prefix, peerId);
		require('./projectShareNotify').announceMemberRemoved(prefix, target || { peerId });
		return;
	}
	if (action === 'admitJoiner') {
		if (summary.role !== 'admin') {
			void vscode.window.showWarningMessage('Only an admin can admit someone.');
			return;
		}
		if (!peerId) return;
		const role = String((extra && extra.memberRole) || 'member');
		const teamIds = Array.isArray(extra.teamIds)
			? extra.teamIds.map(String)
			: String((extra && extra.teamIds) || '')
					.split(',')
					.map(s => s.trim())
					.filter(Boolean);
		try {
			const result = await admitJoiner(kbRoot, prefix, peerId, role, teamIds);
			await recordLocalOperation(kbRoot, prefix, OP_TYPES.MEMBER_ADMIT, { member: result.member });
			const who = require('./projectShareNotify').memberPublicName(result.member);
			void vscode.window.showInformationMessage(`${who} is on the project as ${result.member.role}.`);
		} catch (err) {
			void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
		}
		return;
	}
	if (action === 'declineJoiner') {
		if (summary.role !== 'admin') {
			void vscode.window.showWarningMessage('Only an admin can decline a join request.');
			return;
		}
		if (!peerId) return;
		try {
			await declineJoiner(kbRoot, prefix, peerId);
			await recordLocalOperation(kbRoot, prefix, OP_TYPES.MEMBER_JOIN_DECLINE, { peerId });
			void vscode.window.showInformationMessage('That join request was declined. They can ask again with a new invite.');
		} catch (err) {
			void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
		}
		return;
	}
	if (action === 'stopSharing') {
		if (!canToggleSharing(summary.role)) {
			void vscode.window.showWarningMessage('Only an admin, member, or updater can stop sharing this project.');
			return;
		}
		try {
			require('./projectRecord').dropPendingProjectEdits(prefix);
		} catch {
			/* half-typed headings stay local */
		}
		const mailbox = require('./projectMailbox');
		const folderUri = projectFolderUriFromPrefix(kbRoot, prefix);
		const rec = await require('./projectSidecar').readProjectRecord(folderUri);
		if (mailbox.parseMailboxRepo(rec && rec.mailboxRepo)) {
			try {
				const r = await mailbox.pushProjectMailbox(kbRoot, prefix, { interactive: true });
				if (r.pushed) await mailbox.notifyMailboxUpdated(kbRoot, prefix, r.repo);
				await setSharingActive(kbRoot, prefix, false);
				void vscode.window.showInformationMessage(
					'Sharing is stopped. Your changes were saved to this project’s GitHub mailbox. People still online were asked to pull.'
				);
			} catch (err) {
				await setSharingActive(kbRoot, prefix, false);
				const send = await vscode.window.showWarningMessage(
					`Sharing is stopped. Could not update the GitHub mailbox: ${err && err.message ? err.message : err}`,
					'Save change file'
				);
				if (send === 'Save change file') {
					await runProjectShareAction(kbRoot, prefix, 'exportBundle', extra);
				}
			}
			return;
		}
		await setSharingActive(kbRoot, prefix, false);
		const send = await vscode.window.showInformationMessage(
			'Sharing is stopped. This PC is disconnected. If the other person is in another timezone, save a change file and send it to them.',
			'Save change file'
		);
		if (send === 'Save change file') {
			await runProjectShareAction(kbRoot, prefix, 'exportBundle', extra);
		}
		return;
	}
	if (action === 'setMailboxRepo') {
		if (summary.role !== 'admin') {
			void vscode.window.showWarningMessage('Only an admin can set the GitHub mailbox for this project.');
			return;
		}
		const mailbox = require('./projectMailbox');
		const repo = mailbox.parseMailboxRepo((extra && extra.mailboxRepo) || '');
		if (!repo) {
			void vscode.window.showWarningMessage('Use owner/repo, for example my-team/shop-drip.');
			return;
		}
		await mailbox.setProjectMailboxRepo(kbRoot, prefix, repo);
		await recordLocalOperation(kbRoot, prefix, OP_TYPES.MAILBOX_REPO_SET, { repo });
		try {
			await mailbox.pullProjectMailbox(kbRoot, prefix, { interactive: true });
			const r = await mailbox.pushProjectMailbox(kbRoot, prefix, { interactive: true, force: true });
			if (r.pushed) await mailbox.notifyMailboxUpdated(kbRoot, prefix, repo);
			void vscode.window.showInformationMessage(
				`This project will use GitHub ${repo} as the recommended mailbox. DRIP pulls it when you open, and pushes when you leave if you changed something.`
			);
		} catch (err) {
			void vscode.window.showWarningMessage(
				`Mailbox saved, but GitHub did not accept a write yet: ${err && err.message ? err.message : err}`
			);
		}
		return;
	}
	if (action === 'clearMailboxRepo') {
		if (summary.role !== 'admin') {
			void vscode.window.showWarningMessage('Only an admin can remove the GitHub mailbox.');
			return;
		}
		await require('./projectMailbox').setProjectMailboxRepo(kbRoot, prefix, '');
		await recordLocalOperation(kbRoot, prefix, OP_TYPES.MAILBOX_REPO_SET, { repo: '' });
		void vscode.window.showInformationMessage('This project no longer uses a GitHub mailbox. Live sync and change files still work.');
		return;
	}
	if (action === 'pullMailbox') {
		if (summary.role !== 'admin') {
			void vscode.window.showWarningMessage('Only an admin can pull the GitHub mailbox.');
			return;
		}
		try {
			const r = await require('./projectMailbox').pullProjectMailbox(kbRoot, prefix, { interactive: true });
			void vscode.window.showInformationMessage(
				r.applied
					? `Pulled ${r.applied} change${r.applied === 1 ? '' : 's'} from the GitHub mailbox.`
					: 'GitHub mailbox is already up to date on this PC.'
			);
		} catch (err) {
			void vscode.window.showWarningMessage(err && err.message ? err.message : String(err));
		}
		return;
	}
	if (action === 'pushMailbox') {
		if (summary.role !== 'admin') {
			void vscode.window.showWarningMessage('Only an admin can save the GitHub mailbox.');
			return;
		}
		try {
			const mailbox = require('./projectMailbox');
			const r = await mailbox.pushProjectMailbox(kbRoot, prefix, { interactive: true, force: true });
			if (r.pushed) await mailbox.notifyMailboxUpdated(kbRoot, prefix, r.repo);
			void vscode.window.showInformationMessage(
				r.pushed
					? 'Saved this project’s log to the GitHub mailbox. People still online were asked to pull.'
					: 'Nothing new to push.'
			);
		} catch (err) {
			void vscode.window.showWarningMessage(err && err.message ? err.message : String(err));
		}
		return;
	}
	if (action === 'startSharing') {
		if (!canToggleSharing(summary.role)) {
			void vscode.window.showWarningMessage('Only an admin, member, or updater can start sharing this project.');
			return;
		}
		await setSharingActive(kbRoot, prefix, true);
		require('./projectShareNotify').announceStartSharing(prefix, summary.projectId);
		return;
	}
	if (action === 'reconnect') {
		if (!canToggleSharing(summary.role)) {
			void vscode.window.showWarningMessage('Your role on this project does not allow reconnecting sharing.');
			return;
		}
		try {
			await reconnectNow(kbRoot, prefix);
			void vscode.window.showInformationMessage('Reconnected. Checking for changes from other people now.');
		} catch (err) {
			void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
		}
		return;
	}
	if (action === 'unshareProject') {
		if (summary.role !== 'admin') {
			void vscode.window.showWarningMessage('Only an admin can convert this project back to solo.');
			return;
		}
		const ok = await vscode.window.showWarningMessage(
			'Convert this shared project back to a solo project? Everyone keeps their own copy and stops syncing. Members who are online now will be told immediately. Members who are offline will be told when they next reconnect, or the next time they pull the GitHub mailbox if one is set.',
			{ modal: true },
			'Convert to solo'
		);
		if (ok !== 'Convert to solo') return;
		try {
			require('./projectRecord').dropPendingProjectEdits(prefix);
		} catch {
			/* half-typed edits stay local */
		}
		try {
			const result = await unshareProject(kbRoot, prefix);
			require('./projectShareNotify').refreshShareSurfaces(prefix);
			if (result.mailboxPushed) {
				void vscode.window.showInformationMessage(
					'Project is solo again. The closing notice was saved to the GitHub mailbox, so members who were offline will also stop sharing when they next pull.'
				);
			} else if (result.mailboxWarn === 'no-token') {
				void vscode.window.showInformationMessage(
					'Project is solo again. The closing notice was not saved to the GitHub mailbox because you are not signed in to GitHub; offline members will see the project as unreachable and can leave it themselves.'
				);
			} else if (result.mailboxWarn) {
				void vscode.window.showInformationMessage(
					`Project is solo again. The closing notice could not reach the GitHub mailbox (${result.mailboxWarn}); offline members will see the project as unreachable and can leave it themselves.`
				);
			} else {
				void vscode.window.showInformationMessage(
					'Project is solo again. Offline members with no mailbox will see the project as unreachable and can leave it themselves.'
				);
			}
		} catch (err) {
			void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
		}
		return;
	}
	if (action === 'removeOtherUsers') {
		const ok = await vscode.window.showWarningMessage(
			'Remove every member who is not an admin? They will no longer sync. Admins stay until you remove them one by one.',
			{ modal: true },
			'Remove other users'
		);
		if (ok !== 'Remove other users') return;
		const result = await removeNonAdminMembers(kbRoot, prefix);
		for (const m of result.removed || []) {
			await recordLocalOperation(kbRoot, prefix, OP_TYPES.MEMBER_REMOVE, { peerId: m.peerId });
		}
		const n = (result.removed || []).length;
		void vscode.window.showInformationMessage(
			n ? `Removed ${n} user${n === 1 ? '' : 's'}. Admins are still on the project.` : 'No other users to remove.'
		);
		return;
	}
	if (action === 'removeGuests') {
		const ok = await vscode.window.showWarningMessage(
			'Remove every guest (no GitHub) from this project? GitHub members stay. Those guests can ask to join again with an invite.',
			{ modal: true },
			'Remove guests'
		);
		if (ok !== 'Remove guests') return;
		const result = await removeGuestMembers(kbRoot, prefix);
		for (const m of result.removed || []) {
			await recordLocalOperation(kbRoot, prefix, OP_TYPES.MEMBER_REMOVE, { peerId: m.peerId });
		}
		const n = (result.removed || []).length;
		require('./projectShareNotify').refreshShareSurfaces(prefix);
		void vscode.window.showInformationMessage(
			n ? `Removed ${n} guest${n === 1 ? '' : 's'}. GitHub members are still on the project.` : 'No guests to remove.'
		);
		return;
	}
	if (action === 'allowGuestsOn' || action === 'allowGuestsOff') {
		if (summary.role !== 'admin') {
			void vscode.window.showWarningMessage('Only an admin can change who may join.');
			return;
		}
		const allow = action === 'allowGuestsOn';
		await setAllowGuests(kbRoot, prefix, allow);
		await recordLocalOperation(kbRoot, prefix, OP_TYPES.JOIN_POLICY_SET, { allowGuests: allow });
		require('./projectShareNotify').refreshShareSurfaces(prefix);
		void vscode.window.showInformationMessage(
			allow
				? 'Guests can join this project with a PC name. GitHub users can still join.'
				: 'Only people signed in with GitHub can join this project. Existing guests stay until you remove them.'
		);
		return;
	}
}

async function doShare(kbRoot, prefix, title) {
	let result;
	try {
		result = await shareProject(kbRoot, prefix, title);
	} catch (err) {
		void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
		return;
	}
	try {
		await stampProjectHiddenIds(kbRoot, prefix);
	} catch (err) {
		console.error('[DRIP] stamp hidden ids', err);
	}
	await recordLocalOperation(kbRoot, prefix, OP_TYPES.PROJECT_SHARE, { projectId: result.record.projectId });
	await promptForFirstTeam(kbRoot, prefix);
	try {
		await startLanListener(kbRoot, prefix);
	} catch {
		/* LAN is optional */
	}
	const summary = await getShareSummary(kbRoot, prefix);
	await vscode.env.clipboard.writeText(summary.invite || result.invite);
	void vscode.window.showInformationMessage(
		'Project is shared. The invite is on the clipboard. People who use it appear here so you can admit them and pick their role and teams.'
	);
}

/**
 * A shared project must have at least one team, so a fresh share asks the admin
 * to name the first one and puts the owner on it. Skipping the prompt is fine —
 * the admin can create a team later from Share settings before admitting anyone.
 */
async function promptForFirstTeam(kbRoot, prefix) {
	try {
		const folderUri = projectFolderUriFromPrefix(kbRoot, prefix);
		const rec = await require('./projectSidecar').readProjectRecord(folderUri);
		if (!rec || !rec.shared || (rec.teams || []).length) return;
		const name = String(
			(await vscode.window.showInputBox({
				prompt: 'Create your first team. Everyone you add needs a team.',
				placeHolder: 'Team name',
				ignoreFocusOut: true
			})) || ''
		).trim();
		if (!name) return;
		const { createTeam, setMemberTeams } = require('./projectTeams');
		const me = await require('./peerIdentity').ensurePeerIdentity();
		const created = await createTeam(kbRoot, prefix, name);
		await recordLocalOperation(kbRoot, prefix, OP_TYPES.TEAM_UPSERT, { team: created.team });
		await setMemberTeams(kbRoot, prefix, me.peerId, [created.team.id]);
		await recordLocalOperation(kbRoot, prefix, OP_TYPES.TEAM_MEMBERS_SET, { peerId: me.peerId, teamIds: [created.team.id] });
	} catch (err) {
		console.error('[DRIP] first team prompt', err);
	}
}

function isMembershipRefuseError(err) {
	const m = String((err && err.message) || err || '');
	return /only allows people signed in|invite is no longer valid|different project|not on this project/i.test(m);
}

function friendlyJoinError(err) {
	const m = String((err && err.message) || err || '');
	if (/connack timeout|internet relay/i.test(m)) {
		return 'Could not reach the other person on the internet relay. Make sure they have sharing on and copy a fresh invite.';
	}
	return m;
}

/**
 * Join a shared project from an invite. Uses the Account on this PC:
 * GitHub if signed in, otherwise the guest PC name.
 * @param {import('vscode').Uri} kbRoot
 * @param {string} [inviteCode]
 */
async function runJoinProject(kbRoot, inviteCode) {
	let code = String(inviteCode || '').trim();
	if (!code) {
		code = String(
			(await vscode.window.showInputBox({
				prompt: 'Paste the project invite',
				placeHolder: 'Invite code',
				ignoreFocusOut: true
			})) || ''
		).trim();
	}
	if (!code) return;
	const { parseInviteCode, acceptInviteOnFolder } = require('./projectSharing');
	let invite;
	try {
		invite = parseInviteCode(code);
	} catch (err) {
		void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
		return;
	}

	const { readLinkedGithub } = require('./peerGithub');
	const alreadyGithub = await readLinkedGithub();
	if (alreadyGithub) {
		try {
			const linked = await linkGithubToPeer();
			if (!linked) {
				void vscode.window.showWarningMessage('GitHub sign-in was cancelled.');
				return;
			}
		} catch (err) {
			void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
			return;
		}
	} else {
		await ensurePeerIdentity();
	}

	const { ensureProjectsHome, projectPrefixUnderHome } = require('../startup/projectsDrip');
	const { destUriForJoin, writeFolderFilesAtomic, importProjectFolder } = require('./projectFolderTransfer');
	const { requestLanSnapshotFromInvite } = require('./projectLanSync');
	const { requestInternetSnapshot } = require('./projectInternetSync');
	const home = await ensureProjectsHome(kbRoot);
	const { dest, destName } = await destUriForJoin(home, invite);
	const prefix = projectPrefixUnderHome(destName);
	let landed = false;
	let snapError = '';

	try {
		const snap = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Downloading ${invite.name || 'project'}…`,
				cancellable: false
			},
			async () => {
				try {
					return await requestLanSnapshotFromInvite(invite);
				} catch (lanErr) {
					console.error('[DRIP] join LAN snapshot', lanErr);
					if (isMembershipRefuseError(lanErr)) throw lanErr;
					return requestInternetSnapshot(invite);
				}
			}
		);
		await writeFolderFilesAtomic(dest, snap.files);
		landed = true;
	} catch (err) {
		snapError = friendlyJoinError(err);
		console.error('[DRIP] join snapshot', err);
	}

	if (!landed) {
		if (isMembershipRefuseError({ message: snapError })) {
			void vscode.window.showWarningMessage(
				snapError
			);
			return;
		}
		const go = await vscode.window.showWarningMessage(
			snapError
				? `${snapError} Import a project export to get the full folder.`
				: 'No member is reachable. Import a project export to get the full folder.',
			'Import project folder'
		);
		if (go !== 'Import project folder') return;
		const imported = await importProjectFolder(kbRoot);
		if (!imported) return;
		try {
			await acceptInviteOnFolder(kbRoot, imported.folderPrefix, code);
		} catch (err) {
			void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
			try {
				const { detachLocalCopy, projectFolderUriFromPrefix } = require('./projectSharing');
				const rec = await require('./projectSidecar').readProjectRecord(
					projectFolderUriFromPrefix(kbRoot, imported.folderPrefix)
				);
				if (rec) await detachLocalCopy(projectFolderUriFromPrefix(kbRoot, imported.folderPrefix), rec);
			} catch {
				/* leave the imported files as a solo copy if we can */
			}
		}
		const indexedPrefix = await indexJoinedProject(kbRoot, imported.folderUri, invite.name || '');
		const importedResult = {
			folderPrefix: indexedPrefix || imported.folderPrefix,
			title: invite.name || ''
		};
		try {
			await vscode.commands.executeCommand('drip.refreshTree');
		} catch {
			/* ignore */
		}
		await refreshSettingsAfterJoin(importedResult);
		void vscode.window.showInformationMessage(
			'Project folder is here. The admin still needs to admit you before you are on the project.'
		);
		return importedResult;
	}

	try {
		await acceptInviteOnFolder(kbRoot, prefix, code);
	} catch (err) {
		void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
		try {
			const { detachLocalCopy, projectFolderUriFromPrefix } = require('./projectSharing');
			const rec = await require('./projectSidecar').readProjectRecord(
				projectFolderUriFromPrefix(kbRoot, prefix)
			);
			if (rec) await detachLocalCopy(projectFolderUriFromPrefix(kbRoot, prefix), rec);
		} catch {
			/* refuse still stands */
		}
		return;
	}
	try {
		await startLanListener(kbRoot, prefix);
		const { rememberLanPeer, syncWithLanPeer, persistKnownLanPeers } = require('./projectLanSync');
		if (invite.port) {
			for (const h of [...(invite.hosts || []), invite.host, '127.0.0.1']) {
				rememberLanPeer(invite.projectId, h, invite.port);
			}
			await persistKnownLanPeers(projectFolderUriFromPrefix(kbRoot, prefix), invite.projectId);
			try {
				await syncWithLanPeer(kbRoot, prefix, '127.0.0.1', invite.port);
			} catch {
				/* host on the invite may still work */
				if (invite.host && invite.host !== '127.0.0.1') {
					try {
						await syncWithLanPeer(kbRoot, prefix, invite.host, invite.port);
					} catch {
						/* catch-up is best-effort */
					}
				}
			}
		}
		const me = await ensurePeerIdentity();
		const { joiningMemberEntry } = require('./projectSharing');
		const rec = await require('./projectSidecar').readProjectRecord(
			projectFolderUriFromPrefix(kbRoot, prefix)
		);
		await recordLocalOperation(kbRoot, prefix, OP_TYPES.MEMBER_ACCEPT, {
			member: joiningMemberEntry(me, rec || {})
		});
	} catch (err) {
		void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
	}
	const indexedPrefix = await indexJoinedProject(kbRoot, dest, invite.name || destName);
	const joined = {
		folderPrefix: indexedPrefix || prefix,
		title: invite.name || destName
	};
	try {
		await vscode.commands.executeCommand('drip.refreshTree');
	} catch {
		/* ignore */
	}
	await refreshSettingsAfterJoin(joined);
		void vscode.window.showInformationMessage(
			`Asked to join ${invite.name || destName}. The admin will admit you and pick your role.`
		);
	return joined;
}

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {import('vscode').Uri} folderUri
 * @param {string} title
 */
async function indexJoinedProject(kbRoot, folderUri, title) {
	try {
		const { ensureJoinedProjectInIndex } = require('../indexing/projectIndex');
		return await ensureJoinedProjectInIndex(kbRoot, folderUri, title);
	} catch (err) {
		console.error('[DRIP] index joined project', err);
		return '';
	}
}

/**
 * Reload the Settings project dropdown and select the project we just joined.
 * @param {{ folderPrefix?: string, title?: string } | undefined} result
 */
async function refreshSettingsAfterJoin(result) {
	if (!result || !joinUi.state) return;
	try {
		const { getOpenSettingsPanel, postDripSettingsValuesToWebview } = require('../views/settings/settingsPanel');
		const panel = getOpenSettingsPanel();
		if (!panel) return;
		await postDripSettingsValuesToWebview(panel.webview, joinUi.state, joinUi.context);
		if (result.folderPrefix) {
			await panel.webview.postMessage({
				type: 'showPanel',
				panel: 'project-sharing',
				projectKey: result.folderPrefix,
				projectTitle: result.title || ''
			});
		}
	} catch (err) {
		console.error('[DRIP] refresh settings after join', err);
	}
}

/**
 * Payload the Project View header uses for members + status.
 * @param {import('vscode').Uri} kbRoot
 * @param {string} folderPrefix
 */
async function shareStateForWebview(kbRoot, folderPrefix) {
	const summary = await getShareSummary(kbRoot, folderPrefix);
	let notices = [];
	let status = summary.shared ? 'waiting for a peer' : 'solo';
	if (summary.shared && summary.sharingActive !== false) {
		const folderUri = projectFolderUriFromPrefix(kbRoot, folderPrefix);
		const sync = await readSyncState(folderUri);
		notices = (sync.notices || []).slice(-5);
		const port = lanPortFor(summary.projectId);
		status = port ? `listening on ${port}` : 'waiting for a peer';
		try {
			await startLanListener(kbRoot, folderPrefix);
			const p = lanPortFor(summary.projectId);
			if (p) status = `listening on ${p}`;
		} catch {
			/* ignore */
		}
	} else if (summary.shared) {
		status = 'sharing stopped';
	}
	const { memberPublicName } = require('./projectShareNotify');
	const folderUri = projectFolderUriFromPrefix(kbRoot, folderPrefix);
	const rec = await require('./projectSidecar').readProjectRecord(folderUri);
	const me = await require('./peerIdentity').ensurePeerIdentity();
	const teamsState = rec
		? require('./projectTeams').teamsForWebview(rec, me.peerId)
		: { teams: [], defaultTeamId: '', myTeamIds: [], canViewAll: false, caps: {} };
	const myTeamIds = new Set(teamsState.myTeamIds || []);
	const viewAll = !!teamsState.canViewAll || summary.role === 'admin';
	const members = (summary.members || [])
		.filter(m => {
			if (!m) return false;
			if (viewAll) return true;
			const ids = Array.isArray(m.teamIds) ? m.teamIds : [];
			return ids.some(id => myTeamIds.has(id));
		})
		.map(m => ({
			peerId: m.peerId,
			displayName: memberPublicName(m),
			githubLogin: m.githubLogin || '',
			isGuest: !String(m.githubId || '').trim(),
			role: m.role,
			teamIds: Array.isArray(m.teamIds) ? m.teamIds : [],
			online: !!(summary.sharingActive && isPeerOnline(summary.projectId, m.peerId))
		}));
	const pendingJoiners =
		summary.role === 'admin'
			? (summary.pendingJoiners || []).map(p => ({
					peerId: p.peerId,
					displayName: memberPublicName(p),
					githubLogin: p.githubLogin || '',
					isGuest: !String(p.githubId || '').trim()
				}))
			: [];
	return {
		shared: summary.shared,
		sharingActive: summary.shared && summary.sharingActive !== false,
		onlineCount: summary.shared && summary.sharingActive !== false ? onlineCountFor(summary.projectId) : 0,
		status,
		ownerGithubLogin: summary.ownerGithubLogin || '',
		members,
		pendingJoiners,
		waitingAdmit: !!summary.waitingAdmit,
		role: summary.role,
		canToggleSharing: canToggleSharing(summary.role),
		notices,
		mailboxRepo: summary.role === 'admin' ? summary.mailboxRepo || '' : '',
		allowGuests: summary.allowGuests !== false,
		teams: teamsState.teams,
		defaultTeamId: teamsState.defaultTeamId,
		myTeamIds: teamsState.myTeamIds,
		canViewAllTeams: teamsState.canViewAll,
		caps: teamsState.caps || {}
	};
}

/**
 * Start LAN + internet listeners for every shared project that still has sharing on.
 * Call after the knowledge base is verified so two windows do not sit idle
 * until someone opens Share settings.
 * @param {import('vscode').Uri} kbRoot
 */
async function resumeSharedProjectListeners(kbRoot) {
	if (!kbRoot) return;
	try {
		require('./projectMailbox').rememberKbRoot(kbRoot);
	} catch {
		/* mailbox is optional */
	}
	const { ensureProjectsHome } = require('../startup/projectsDrip');
	const { isDripProjectFolderName } = require('../document/model/dripNoteProjectFolder.js');
	const { readProjectRecord, projectFolderPrefixForPath } = require('./projectSidecar');
	const { startLanListener, isSharingActive } = require('./projectLanSync');
	const home = await ensureProjectsHome(kbRoot);
	let entries = [];
	try {
		entries = await vscode.workspace.fs.readDirectory(home);
	} catch {
		return;
	}
	for (const [name, type] of entries) {
		if (type !== vscode.FileType.Directory || !isDripProjectFolderName(name)) continue;
		const folderUri = vscode.Uri.joinPath(home, name);
		let rec;
		try {
			rec = await readProjectRecord(folderUri);
		} catch {
			continue;
		}
		if (!rec || !rec.shared || !rec.projectId || !isSharingActive(rec.projectId)) continue;
		const prefix = projectFolderPrefixForPath(kbRoot.fsPath, folderUri.fsPath);
		if (!prefix) continue;
		try {
			await startLanListener(kbRoot, prefix);
		} catch (err) {
			console.error('[DRIP] resume share listener', err);
		}
	}
	try {
		await require('./projectMailbox').pullAllProjectMailboxes(kbRoot);
	} catch (err) {
		console.error('[DRIP] mailbox pull on open', err);
	}
}

module.exports = {
	registerProjectShareCommands,
	runProjectShareAction,
	runJoinProject,
	shareStateForWebview,
	resumeSharedProjectListeners
};
