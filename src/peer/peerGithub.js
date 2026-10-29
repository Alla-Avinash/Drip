'use strict';

/**
 * DRIP GitHub OAuth app (device login). Profile only — not VS Code's GitHub session.
 * The client id is public; the token lives in Secret Storage.
 */

const vscode = require('vscode');
const { ensurePeerIdentity, patchPeerPublicRecord, getPeerExtensionContext } = require('./peerIdentity');

const DRIP_GITHUB_CLIENT_ID = 'Ov23li7HM1yK4gziwhqZ';
const DRIP_GITHUB_SCOPE = 'read:user';
const TOKEN_SECRET_KEY = 'drip.peerGithub.accessToken';

/**
 * @param {string} path
 * @param {Record<string, string>} body
 */
async function postGithubForm(path, body) {
	const res = await fetch(path, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
			'User-Agent': 'DRIP'
		},
		body: new URLSearchParams(body).toString()
	});
	const json = await res.json();
	if (!res.ok && json && json.error) {
		throw new Error(String(json.error_description || json.error));
	}
	return json;
}

async function fetchGithubUser(token) {
	const res = await fetch('https://api.github.com/user', {
		headers: {
			Authorization: `Bearer ${token}`,
			'User-Agent': 'DRIP',
			Accept: 'application/vnd.github+json'
		}
	});
	if (res.status === 401 || res.status === 403) return null;
	if (!res.ok) {
		throw new Error('GitHub did not return the account. Try signing in again.');
	}
	const user = await res.json();
	const login = String(user.login || '').trim();
	if (!login) return null;
	return {
		id: String(user.id || ''),
		login,
		name: String(user.name || login).trim() || login
	};
}

async function readStoredToken() {
	try {
		return (await getPeerExtensionContext().secrets.get(TOKEN_SECRET_KEY)) || '';
	} catch {
		return '';
	}
}

async function storeToken(token) {
	await getPeerExtensionContext().secrets.store(TOKEN_SECRET_KEY, String(token || ''));
}

async function clearStoredToken() {
	try {
		await getPeerExtensionContext().secrets.delete(TOKEN_SECRET_KEY);
	} catch {
		/* ignore */
	}
}

/**
 * Device login against the DRIP OAuth app. GitHub shows "DRIP" and only profile.
 */
async function signInWithDripGithubApp() {
	const start = await postGithubForm('https://github.com/login/device/code', {
		client_id: DRIP_GITHUB_CLIENT_ID,
		scope: DRIP_GITHUB_SCOPE
	});
	const userCode = String(start.user_code || '');
	const deviceCode = String(start.device_code || '');
	const verifyUrl = String(start.verification_uri || 'https://github.com/login/device');
	if (!userCode || !deviceCode) {
		throw new Error('GitHub did not start the DRIP sign-in.');
	}

	await vscode.env.clipboard.writeText(userCode);
	void vscode.env.openExternal(vscode.Uri.parse(verifyUrl));

	const intervalMs = Math.max(5, Number(start.interval) || 5) * 1000;
	const deadline = Date.now() + Math.max(60, Number(start.expires_in) || 900) * 1000;
	const tokenPromise = pollDripGithubDeviceToken(deviceCode, intervalMs, deadline);

	let choice = 'Open GitHub again';
	while (choice === 'Open GitHub again') {
		choice = await vscode.window.showInformationMessage(
			userCode,
			{
				modal: true,
				detail:
					'Enter this code on the GitHub page that opened. It is also on the clipboard.\n\nGitHub will ask only for your profile (the DRIP app). After you Allow, come back here and click Continue.'
			},
			'Continue',
			'Open GitHub again'
		);
		if (choice === 'Open GitHub again') {
			await vscode.env.clipboard.writeText(userCode);
			void vscode.env.openExternal(vscode.Uri.parse(verifyUrl));
		}
	}

	return tokenPromise;
}

/**
 * @param {string} deviceCode
 * @param {number} intervalMs
 * @param {number} deadline
 */
async function pollDripGithubDeviceToken(deviceCode, intervalMs, deadline) {
	let wait = intervalMs;
	while (Date.now() < deadline) {
		await new Promise(r => setTimeout(r, wait));
		const poll = await postGithubForm('https://github.com/login/oauth/access_token', {
			client_id: DRIP_GITHUB_CLIENT_ID,
			device_code: deviceCode,
			grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
		});
		if (poll.access_token) {
			await storeToken(poll.access_token);
			const user = await fetchGithubUser(poll.access_token);
			if (!user) throw new Error('Signed in, but GitHub did not return the profile.');
			return user;
		}
		if (poll.error === 'authorization_pending') continue;
		if (poll.error === 'slow_down') {
			wait += 5000;
			continue;
		}
		if (poll.error === 'expired_token' || poll.error === 'access_denied') {
			throw new Error(
				poll.error === 'access_denied'
					? 'GitHub sign-in was denied.'
					: 'The GitHub sign-in code expired. Try again.'
			);
		}
		if (poll.error) {
			throw new Error(String(poll.error_description || poll.error));
		}
	}
	throw new Error('GitHub sign-in timed out. Try again.');
}

/**
 * @param {boolean} [createIfNone]
 * @returns {Promise<{ id: string, login: string, name: string } | null>}
 */
async function readGithubAccount(createIfNone) {
	const existing = await readStoredToken();
	if (existing) {
		const user = await fetchGithubUser(existing);
		if (user) return user;
		await clearStoredToken();
	}
	if (createIfNone !== true) return null;
	return signInWithDripGithubApp();
}

/**
 * Sign in with the DRIP GitHub app and store the account on the local peer.
 * Pass replace to drop the current GitHub and start a new device login.
 * The guest PC name stays — GitHub is only the login on top of this machine identity.
 * @param {{ replace?: boolean }} [opts]
 */
async function linkGithubToPeer(opts) {
	const replace = !!(opts && opts.replace);
	if (replace) {
		await clearStoredToken();
		await patchPeerPublicRecord({ githubId: '', githubLogin: '' });
	} else {
		const existing = await readLinkedGithub();
		if (existing) {
			const rec = await patchPeerPublicRecord({
				githubId: existing.id,
				githubLogin: existing.login
			});
			return { ...rec, github: existing };
		}
	}
	const gh = await readGithubAccount(true);
	if (!gh) return null;
	const rec = await patchPeerPublicRecord({
		githubId: gh.id,
		githubLogin: gh.login
	});
	return { ...rec, github: gh };
}

/**
 * Drop the GitHub login. The guest PC name and unique id stay on this machine.
 */
async function signOutGithubFromPeer() {
	await clearStoredToken();
	return patchPeerPublicRecord({ githubId: '', githubLogin: '' });
}

/**
 * GitHub already stored on this machine (no prompt).
 */
async function readLinkedGithub() {
	try {
		const rec = await ensurePeerIdentity();
		if (rec.githubId && rec.githubLogin) {
			return { id: String(rec.githubId), login: String(rec.githubLogin), name: rec.displayName };
		}
	} catch {
		/* ignore */
	}
	try {
		return await readGithubAccount(false);
	} catch {
		return null;
	}
}

module.exports = {
	readGithubAccount,
	linkGithubToPeer,
	readLinkedGithub,
	signOutGithubFromPeer,
	getDripGithubToken: readStoredToken,
	clearGithubToken: clearStoredToken
};
