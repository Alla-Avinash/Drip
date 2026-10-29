'use strict';

/**
 * Optional GitHub mailbox for one shared project: a private repo holds the
 * signed operations log (not the project files). Pull when DRIP opens, push
 * when this machine leaves if this person changed something. Live peers get
 * a short “pull the mailbox” signal — not every edit.
 */

const crypto = require('crypto');
const vscode = require('vscode');
const { exportChangeBundle, importChangeBundle } = require('./projectBundle');
const {
	readProjectRecord,
	writeProjectRecord,
	readSyncState,
	writeSyncState,
	projectFolderUriFromPrefix
} = require('./projectSidecar');
const { readVersionVector: readVector } = require('./projectOpLog');

const MAILBOX_FILE = 'drip-mailbox.json';
const MAILBOX_TOKEN_KEY = 'drip.mailbox.githubToken';
const MAILBOX_FORMAT = 'drip-project-mailbox';

/** @type {Set<string>} */
const rememberedKbRoots = new Set();

function rememberKbRoot(kbRootUri) {
	if (kbRootUri && kbRootUri.fsPath) rememberedKbRoots.add(kbRootUri.fsPath);
}

function parseMailboxRepo(raw) {
	const s = String(raw || '').trim();
	if (!s) return '';
	const url = s.match(/github\.com[:/]+([^/]+)\/([^/#?\s]+)/i);
	const pair = url || s.match(/^([^/\s]+)\/([^/\s]+)$/);
	if (!pair) return '';
	const owner = String(pair[1] || '').trim();
	const name = String(pair[2] || '')
		.trim()
		.replace(/\.git$/i, '');
	if (!owner || !name) return '';
	return `${owner}/${name}`;
}

function keyFromCapability(capability) {
	return crypto.createHash('sha256').update(String(capability || ''), 'utf8').digest();
}

function encryptBox(capability, value) {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', keyFromCapability(capability), iv);
	const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decryptBox(capability, box) {
	const buf = Buffer.from(String(box || ''), 'base64');
	if (buf.length < 29) throw new Error('Bad mailbox file.');
	const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromCapability(capability), buf.subarray(0, 12));
	decipher.setAuthTag(buf.subarray(12, 28));
	const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
	return JSON.parse(plain.toString('utf8'));
}

function vectorKey(vector) {
	const v = vector && typeof vector === 'object' ? vector : {};
	return JSON.stringify(
		Object.keys(v)
			.sort()
			.reduce((acc, k) => {
				acc[k] = v[k];
				return acc;
			}, {})
	);
}

async function githubRequest(token, method, url, body) {
	const res = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'DRIP',
			'X-GitHub-Api-Version': '2022-11-28',
			...(body ? { 'Content-Type': 'application/json' } : {})
		},
		body: body ? JSON.stringify(body) : undefined
	});
	if (res.status === 404) return null;
	if (res.status === 401 || res.status === 403) {
		throw new Error('GitHub did not allow access to that repo. Sign in with repo access, or use a token that can write this private repo.');
	}
	if (!res.ok) {
		const text = await res.text();
		throw new Error(text || `GitHub ${res.status}`);
	}
	if (res.status === 204) return {};
	return res.json();
}

async function mailboxGithubToken(interactive) {
	try {
		const session = await vscode.authentication.getSession('github', ['repo'], {
			silent: interactive !== true,
			createIfNone: interactive === true
		});
		if (session && session.accessToken) return session.accessToken;
	} catch {
		/* VS Code GitHub session is optional */
	}
	try {
		const stored = await require('./peerIdentity').getPeerExtensionContext().secrets.get(MAILBOX_TOKEN_KEY);
		if (stored) return stored;
	} catch {
		/* ignore */
	}
	if (interactive !== true) return '';
	const pat = await vscode.window.showInputBox({
		prompt: 'GitHub token that can read and write this private repo (contents). Stored only on this PC.',
		password: true,
		ignoreFocusOut: true
	});
	if (!pat) return '';
	await require('./peerIdentity').getPeerExtensionContext().secrets.store(MAILBOX_TOKEN_KEY, pat);
	return pat;
}

function contentsUrl(repo) {
	const [owner, name] = String(repo).split('/');
	return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${MAILBOX_FILE}`;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} repo
 */
async function setProjectMailboxRepo(kbRootUri, folderPrefix, repo) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await readProjectRecord(folderUri);
	if (!rec || !rec.shared) throw new Error('Share this project first.');
	rec.mailboxRepo = parseMailboxRepo(repo);
	await writeProjectRecord(folderUri, rec);
	return rec.mailboxRepo;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function pullProjectMailbox(kbRootUri, folderPrefix, opts) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await readProjectRecord(folderUri);
	const repo = parseMailboxRepo((opts && opts.repo) || (rec && rec.mailboxRepo));
	if (!rec || !rec.shared || !repo) return { pulled: false, applied: 0 };
	if (rec.mailboxRepo !== repo) {
		rec.mailboxRepo = repo;
		await writeProjectRecord(folderUri, rec);
	}
	const token = await mailboxGithubToken(opts && opts.interactive);
	if (!token) return { pulled: false, applied: 0, reason: 'no-token' };
	const file = await githubRequest(token, 'GET', contentsUrl(repo));
	if (!file || !file.content) return { pulled: true, applied: 0 };
	const raw = Buffer.from(String(file.content).replace(/\n/g, ''), 'base64').toString('utf8');
	const envelope = JSON.parse(raw);
	if (!envelope || envelope.format !== MAILBOX_FORMAT || envelope.projectId !== rec.projectId) {
		throw new Error('That GitHub file is not the mailbox for this project.');
	}
	const bundle = envelope.box
		? decryptBox(rec.inviteCapability, envelope.box)
		: envelope.bundle;
	const result = await importChangeBundle(kbRootUri, folderPrefix, bundle);
	const sync = await readSyncState(folderUri);
	sync.mailboxSha = String(file.sha || '');
	sync.lastMailboxPullAt = new Date().toISOString();
	await writeSyncState(folderUri, sync);
	if (result.applied) {
		try {
			await require('./projectInternetSync').notifySharedProjectChanged(kbRootUri, folderPrefix);
		} catch {
			/* Project View may be closed */
		}
	}
	return { pulled: true, applied: result.applied || 0, repo };
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function pushProjectMailbox(kbRootUri, folderPrefix, opts) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await readProjectRecord(folderUri);
	const repo = parseMailboxRepo(rec && rec.mailboxRepo);
	if (!rec || !rec.shared || !repo) return { pushed: false };
	const vector = await readVector(folderUri);
	const sync = await readSyncState(folderUri);
	if (!(opts && opts.force) && vectorKey(vector) === String(sync.lastMailboxPushVector || '')) {
		return { pushed: false, reason: 'no-local-changes' };
	}
	const token = await mailboxGithubToken(opts && opts.interactive);
	if (!token) return { pushed: false, reason: 'no-token' };
	await pullProjectMailbox(kbRootUri, folderPrefix, { repo, interactive: false });
	const bundle = await exportChangeBundle(kbRootUri, folderPrefix);
	const envelope = {
		format: MAILBOX_FORMAT,
		version: 1,
		projectId: rec.projectId,
		name: rec.name,
		repo,
		updatedAt: new Date().toISOString(),
		box: encryptBox(rec.inviteCapability, bundle)
	};
	const latest = await githubRequest(token, 'GET', contentsUrl(repo));
	const put = await githubRequest(token, 'PUT', contentsUrl(repo), {
		message: `DRIP mailbox: ${rec.name || rec.projectId}`,
		content: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64'),
		sha: latest && latest.sha ? String(latest.sha) : undefined
	});
	const next = await readSyncState(folderUri);
	next.lastMailboxPushVector = vectorKey(await readVector(folderUri));
	next.mailboxSha = put && put.content && put.content.sha ? String(put.content.sha) : next.mailboxSha;
	next.lastMailboxPushAt = new Date().toISOString();
	await writeSyncState(folderUri, next);
	return { pushed: true, repo };
}

async function notifyMailboxUpdated(kbRootUri, folderPrefix, repo) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await readProjectRecord(folderUri);
	if (!rec || !rec.shared) return;
	const msg = { type: 'mailbox-updated', projectId: rec.projectId, repo: parseMailboxRepo(repo || rec.mailboxRepo) };
	try {
		const me = await require('./peerIdentity').ensurePeerIdentity();
		const { knownLanPeers, lanPortFor } = require('./projectLanSync');
		for (const peer of knownLanPeers(rec.projectId)) {
			await pushLanMailboxNotice(peer.host, peer.port, me.peerId, msg);
		}
		void lanPortFor;
	} catch {
		/* LAN notice is optional */
	}
	try {
		await require('./projectInternetSync').publishMailboxNotice(rec.projectId, rec.inviteCapability, msg);
	} catch {
		/* internet notice is optional */
	}
}

function pushLanMailboxNotice(host, port, from, msg) {
	const net = require('net');
	return new Promise(resolve => {
		const socket = net.connect({ host: String(host), port: Number(port) }, () => {
			socket.write(Buffer.from(`${JSON.stringify({ ...msg, from })}\n`, 'utf8'));
		});
		const done = () => {
			try {
				socket.destroy();
			} catch {
				/* ignore */
			}
			resolve();
		};
		socket.setTimeout(3000, done);
		socket.on('error', done);
		socket.on('close', done);
	});
}

/**
 * @param {import('vscode').Uri} kbRootUri
 */
async function pullAllProjectMailboxes(kbRootUri) {
	rememberKbRoot(kbRootUri);
	const projects = await listSharedMailboxProjects(kbRootUri);
	let applied = 0;
	for (const p of projects) {
		try {
			const r = await pullProjectMailbox(kbRootUri, p.prefix);
			applied += r.applied || 0;
		} catch (err) {
			console.error('[DRIP] mailbox pull', err);
		}
	}
	return { applied };
}

/**
 * Push every mailbox that this machine changed, then tell online members to pull.
 */
async function pushAllProjectMailboxesOnExit() {
	const roots = [...rememberedKbRoots];
	for (const fsPath of roots) {
		const kbRoot = vscode.Uri.file(fsPath);
		let projects = [];
		try {
			projects = await listSharedMailboxProjects(kbRoot);
		} catch {
			continue;
		}
		for (const p of projects) {
			try {
				const r = await pushProjectMailbox(kbRoot, p.prefix);
				if (r.pushed) await notifyMailboxUpdated(kbRoot, p.prefix, r.repo);
			} catch (err) {
				console.error('[DRIP] mailbox push', err);
			}
		}
	}
}

async function listSharedMailboxProjects(kbRootUri) {
	const { ensureProjectsHome } = require('../startup/projectsDrip');
	const { isDripProjectFolderName } = require('../document/model/dripNoteProjectFolder.js');
	const { projectFolderPrefixForPath } = require('./projectSidecar');
	const home = await ensureProjectsHome(kbRootUri);
	let entries = [];
	try {
		entries = await vscode.workspace.fs.readDirectory(home);
	} catch {
		return [];
	}
	const out = [];
	for (const [name, type] of entries) {
		if (type !== vscode.FileType.Directory || !isDripProjectFolderName(name)) continue;
		const folderUri = vscode.Uri.joinPath(home, name);
		const rec = await readProjectRecord(folderUri);
		if (!rec || !rec.shared || !parseMailboxRepo(rec.mailboxRepo)) continue;
		const prefix = projectFolderPrefixForPath(kbRootUri.fsPath, folderUri.fsPath);
		if (prefix) out.push({ prefix, repo: parseMailboxRepo(rec.mailboxRepo), projectId: rec.projectId });
	}
	return out;
}

async function handleMailboxUpdatedSignal(kbRootUri, folderPrefix, msg) {
	const repo = parseMailboxRepo(msg && msg.repo);
	try {
		await pullProjectMailbox(kbRootUri, folderPrefix, { repo });
	} catch (err) {
		console.error('[DRIP] mailbox signal pull', err);
	}
}

module.exports = {
	parseMailboxRepo,
	setProjectMailboxRepo,
	pullProjectMailbox,
	pushProjectMailbox,
	notifyMailboxUpdated,
	pullAllProjectMailboxes,
	pushAllProjectMailboxesOnExit,
	handleMailboxUpdatedSignal,
	rememberKbRoot,
	MAILBOX_FILE
};
