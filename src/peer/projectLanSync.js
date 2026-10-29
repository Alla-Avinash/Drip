'use strict';

/**
 * Optional same-network gap exchange. The durable log is the queue;
 * reconnect just diffs version vectors again.
 */

const net = require('net');
const { readVersionVector, opsMissingFrom, cannotFillGap, opsForHello } = require('./projectOpLog');
const { applyOperation } = require('./projectOpApply');
const { projectFolderUriFromPrefix, readProjectRecord, writeProjectRecord, readSyncState, writeSyncState } = require('./projectSidecar');
const { ensurePeerIdentity } = require('./peerIdentity');

/** @type {Map<string, net.Server>} projectId → server */
const servers = new Map();
/** @type {Map<string, number>} projectId → port */
const ports = new Map();
/** @type {Map<string, Map<string, number>>} projectId → peerId → lastSeen ms */
const onlinePeers = new Map();
/** @type {Map<string, Map<string, { host: string, port: number }>>} projectId → host:port → endpoint */
const knownPeers = new Map();
/** @type {Map<string, ReturnType<typeof setInterval>>} */
const lanHelloTimers = new Map();
const ONLINE_MS = 45000;
const LAN_HELLO_MS = 4000;
const PRESENCE_UI_MS = 30000;
const SHARING_ACTIVE_KEY = 'drip.projectSharing.active';
/** @type {(() => void) | null} */
let presenceChangeListener = null;
/** @type {ReturnType<typeof setInterval> | null} */
let presenceUiTimer = null;

function readSharingActiveMap() {
	try {
		const raw = require('./peerIdentity').getPeerExtensionContext().globalState.get(SHARING_ACTIVE_KEY);
		return raw && typeof raw === 'object' ? raw : {};
	} catch {
		return {};
	}
}

function isSharingActive(projectId) {
	const id = String(projectId || '');
	if (!id) return false;
	return readSharingActiveMap()[id] !== false;
}

async function writeSharingActive(projectId, active) {
	const id = String(projectId || '');
	if (!id) return;
	const { getPeerExtensionContext } = require('./peerIdentity');
	const map = { ...readSharingActiveMap(), [id]: active !== false };
	await getPeerExtensionContext().globalState.update(SHARING_ACTIVE_KEY, map);
}

function encodeMessage(obj) {
	return Buffer.from(JSON.stringify(obj) + '\n', 'utf8');
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
function setPresenceChangeListener(fn) {
	presenceChangeListener = typeof fn === 'function' ? fn : null;
}

function startPresenceUiLoop() {
	if (presenceUiTimer) return;
	presenceUiTimer = setInterval(() => {
		notifyPresenceChange(false);
	}, PRESENCE_UI_MS);
}

function stopPresenceUiLoopIfIdle() {
	if (servers.size) return;
	if (presenceUiTimer) {
		clearInterval(presenceUiTimer);
		presenceUiTimer = null;
	}
}

/**
 * Presence badge only. Pass true to paint now (join / stop / start).
 * Ordinary hellos do not call this — the one-minute loop does.
 * @param {boolean} [immediate]
 */
function notifyPresenceChange(immediate) {
	if (!presenceChangeListener) return;
	if (immediate === false) {
		for (const projectId of onlinePeers.keys()) pruneOnline(projectId);
	}
	try {
		presenceChangeListener();
	} catch {
		/* ignore */
	}
}

/**
 * @param {string} projectId
 * @param {string} peerId
 */
function markPeerOnline(projectId, peerId) {
	const id = String(projectId || '');
	const peer = String(peerId || '');
	if (!id || !peer) return;
	let map = onlinePeers.get(id);
	if (!map) {
		map = new Map();
		onlinePeers.set(id, map);
	}
	const firstSeen = !map.has(peer);
	map.set(peer, Date.now());
	if (firstSeen) notifyPresenceChange(true);
}

function dropPeerOnline(projectId, peerId) {
	const id = String(projectId || '');
	const peer = String(peerId || '');
	const map = onlinePeers.get(id);
	if (!map || !peer || !map.has(peer)) return;
	map.delete(peer);
	notifyPresenceChange(true);
}

function keepOnlineMembers(projectId, memberIds) {
	const id = String(projectId || '');
	const map = onlinePeers.get(id);
	if (!map) return;
	const allow = new Set((memberIds || []).map(x => String(x || '')).filter(Boolean));
	let dropped = false;
	for (const peer of [...map.keys()]) {
		if (allow.has(peer)) continue;
		map.delete(peer);
		dropped = true;
	}
	if (dropped) notifyPresenceChange(true);
}

function isPeerOnline(projectId, peerId) {
	const id = String(projectId || '');
	const peer = String(peerId || '');
	if (!id || !peer) return false;
	pruneOnline(id);
	const map = onlinePeers.get(id);
	return !!(map && map.has(peer));
}

function pruneOnline(projectId) {
	const map = onlinePeers.get(String(projectId || ''));
	if (!map) return;
	const cutoff = Date.now() - ONLINE_MS;
	for (const [peer, at] of map) {
		if (at < cutoff) map.delete(peer);
	}
}

function onlineCountFor(projectId) {
	const id = String(projectId || '');
	pruneOnline(id);
	const map = onlinePeers.get(id);
	return map ? map.size : 0;
}

/**
 * Remember a reachable LAN address so later changes can be pushed there.
 * @param {string} projectId
 * @param {string} host
 * @param {number} port
 */
function rememberLanPeer(projectId, host, port) {
	const id = String(projectId || '');
	const h = String(host || '').trim();
	const p = Number(port) || 0;
	if (!id || !h || !p) return;
	let map = knownPeers.get(id);
	if (!map) {
		map = new Map();
		knownPeers.set(id, map);
	}
	map.set(`${h}:${p}`, { host: h, port: p });
}

function knownLanPeers(projectId) {
	const map = knownPeers.get(String(projectId || ''));
	return map ? [...map.values()] : [];
}

function rememberLanPeerFromMessage(projectId, msg, remoteAddress) {
	const advertised = Number(msg && msg.port) || 0;
	if (!advertised) return;
	const raw = String((msg && msg.host) || remoteAddress || '')
		.trim()
		.replace(/^::ffff:/, '');
	const host =
		!raw || raw === '::1' || raw === 'localhost' || raw === '127.0.0.1' ? '127.0.0.1' : raw;
	rememberLanPeer(projectId, host, advertised);
}

async function persistKnownLanPeers(folderUri, projectId) {
	try {
		const sync = await readSyncState(folderUri);
		sync.lanPeers = knownLanPeers(projectId);
		const mine = lanPortFor(projectId);
		if (mine) sync.lanPort = mine;
		await writeSyncState(folderUri, sync);
	} catch {
		/* sidecar write is best-effort */
	}
}

async function persistLanListenPort(folderUri, port) {
	const n = Number(port) || 0;
	if (!n) return;
	try {
		const sync = await readSyncState(folderUri);
		if (Number(sync.lanPort) === n) return;
		sync.lanPort = n;
		await writeSyncState(folderUri, sync);
	} catch {
		/* sidecar write is best-effort */
	}
}

function isLoopbackHost(host) {
	const h = String(host || '')
		.trim()
		.replace(/^::ffff:/, '')
		.toLowerCase();
	return !h || h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

/**
 * Remember this member's listen port (LAN hello or internet hello) so a restart
 * can find them again without a new invite.
 */
function rememberAdvertisedListenPort(projectId, msg) {
	const port = Number(msg && msg.port) || 0;
	if (!port) return;
	if (!isLoopbackHost(msg && msg.host)) {
		rememberLanPeer(projectId, String(msg.host).trim(), port);
	}
	rememberLanPeer(projectId, '127.0.0.1', port);
}

async function loadRememberedLanPeers(folderUri, projectId) {
	try {
		const sync = await readSyncState(folderUri);
		for (const peer of sync.lanPeers || []) {
			if (peer && peer.host && peer.port) rememberLanPeer(projectId, peer.host, peer.port);
		}
	} catch {
		/* missing sidecar is fine */
	}
}

function startLanHelloLoop(kbRootUri, folderPrefix, projectId) {
	const id = String(projectId || '');
	if (!id || lanHelloTimers.has(id)) return;
	const tick = () => {
		void helloKnownLanPeers(kbRootUri, folderPrefix);
	};
	lanHelloTimers.set(id, setInterval(tick, LAN_HELLO_MS));
	tick();
}

async function helloKnownLanPeers(kbRootUri, folderPrefix) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await readProjectRecord(folderUri);
	if (!rec || !rec.shared || !isSharingActive(rec.projectId)) return;
	const mine = lanPortFor(rec.projectId);
	for (const peer of knownLanPeers(rec.projectId)) {
		if (mine && isLoopbackHost(peer.host) && Number(peer.port) === mine) continue;
		try {
			await syncWithLanPeer(kbRootUri, folderPrefix, peer.host, peer.port);
		} catch {
			/* peer may be down */
		}
	}
}

async function startLanListener(kbRootUri, folderPrefix) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await readProjectRecord(folderUri);
	if (!rec || !rec.shared || !isSharingActive(rec.projectId)) return null;
	const me = await ensurePeerIdentity();
	markPeerOnline(rec.projectId, me.peerId);
	keepOnlineMembers(rec.projectId, (rec.members || []).map(m => m && m.peerId).concat([me.peerId]));
	await loadRememberedLanPeers(folderUri, rec.projectId);
	if (servers.has(rec.projectId)) {
		startLanHelloLoop(kbRootUri, folderPrefix, rec.projectId);
		startPresenceUiLoop();
		notifyPresenceChange(true);
		return { projectId: rec.projectId, port: ports.get(rec.projectId) };
	}
	let preferred = 0;
	try {
		preferred = Number((await readSyncState(folderUri)).lanPort) || 0;
	} catch {
		preferred = 0;
	}
	const server = net.createServer(socket => {
		void handleSocket(kbRootUri, folderPrefix, socket);
	});
	await listenLan(server, preferred);
	const addr = server.address();
	const port = addr && typeof addr === 'object' ? addr.port : 0;
	servers.set(rec.projectId, server);
	ports.set(rec.projectId, port);
	await persistLanListenPort(folderUri, port);
	startLanHelloLoop(kbRootUri, folderPrefix, rec.projectId);
	startPresenceUiLoop();
	notifyPresenceChange(true);
	if (!process.env.DRIP_SKIP_INTERNET_SYNC) {
		void require('./projectInternetSync')
			.startInternetListener(kbRootUri, folderPrefix)
			.catch(err => {
				console.error('[DRIP] internet listener', err);
			});
	}
	return { projectId: rec.projectId, port };
}

async function handleSocket(kbRootUri, folderPrefix, socket) {
	let buf = '';
	let handled = false;
	socket.setEncoding('utf8');
	const processLine = () => {
		if (handled) return;
		const nl = buf.indexOf('\n');
		if (nl < 0) return;
		const line = buf.slice(0, nl).trim();
		if (!line) {
			buf = buf.slice(nl + 1);
			return;
		}
		handled = true;
		void (async () => {
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
			const recNow = await readProjectRecord(folderUri);
			if (!recNow || !recNow.shared || !isSharingActive(recNow.projectId)) {
				socket.write(encodeMessage({ type: 'error', message: 'Sharing is stopped on that machine.' }));
				socket.end();
				return;
			}
			const fromPerson = require('./projectSharing').personFromWire(msg);
			if (fromPerson.peerId && msg.type !== 'snapshot-hello') {
				const refuseNow = require('./projectSharing').refuseJoinReason(recNow, fromPerson);
				if (refuseNow) {
					dropPeerOnline(recNow.projectId, fromPerson.peerId);
					try {
						require('./projectShareNotify').announceRemovedPeerSeen(recNow, fromPerson);
					} catch {
						/* notice is optional */
					}
					socket.write(encodeMessage({ type: 'error', message: refuseNow }));
					socket.end();
					return;
				}
				if (require('./projectSharing').memberOf(recNow, fromPerson.peerId)) {
					markPeerOnline(recNow.projectId, fromPerson.peerId);
				}
			}
			rememberLanPeerFromMessage(recNow.projectId, msg, socket.remoteAddress);
			if (msg.port) void persistKnownLanPeers(folderUri, recNow.projectId);
			if (msg.type === 'snapshot-hello') {
				const rec = recNow;
				if (!rec || !rec.shared || rec.inviteCapability !== String(msg.capability || '')) {
					socket.write(encodeMessage({ type: 'error', message: 'That invite is no longer valid.' }));
					socket.end();
					return;
				}
				if (rec.projectId !== String(msg.projectId || '')) {
					socket.write(encodeMessage({ type: 'error', message: 'That invite is for a different project.' }));
					socket.end();
					return;
				}
				const asker = require('./projectSharing').personFromWire(msg);
				const refuse = require('./projectSharing').refuseJoinReason(rec, asker, { inviteOk: true });
				if (refuse) {
					socket.write(encodeMessage({ type: 'error', message: refuse }));
					socket.end();
					return;
				}
				try {
					await require('./projectSharing').rememberJoinRequest(folderUri, asker, folderPrefix);
				} catch (err) {
					socket.write(encodeMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
					socket.end();
					return;
				}
				const { collectFolderFiles } = require('./projectFolderTransfer');
				const files = await collectFolderFiles(folderUri);
				socket.write(
					encodeMessage({
						type: 'snapshot',
						name: rec.name,
						projectId: rec.projectId,
						files
					})
				);
				socket.end();
				return;
			}
			if (msg.type === 'hello') {
				const helloPerson = require('./projectSharing').personFromWire(msg);
				const refuse = require('./projectSharing').refuseJoinReason(recNow, helloPerson);
				if (refuse) {
					socket.write(encodeMessage({ type: 'error', message: refuse }));
					socket.end();
					return;
				}
				// Keep each member's signing/encryption keys fresh from their hello,
				// so a later chat message can grant them the room key.
				if (require('./projectSharing').refreshMemberFromPerson(recNow, helloPerson)) {
					await writeProjectRecord(folderUri, recNow);
				}
				if (Array.isArray(msg.ops)) {
					for (const op of msg.ops) {
						const r = await applyOperation(kbRootUri, folderPrefix, op);
						if (r && r.ok && !r.skipped) {
							/* applied their offline work before we decide snapshot vs gap */
						}
					}
				}
				const me = await ensurePeerIdentity();
				markPeerOnline(recNow.projectId, me.peerId);
				if (await cannotFillGap(folderUri, msg.vector || {})) {
					const { collectFolderFiles } = require('./projectFolderTransfer');
					const files = await collectFolderFiles(folderUri);
					socket.write(
						encodeMessage({
							type: 'snapshot',
							from: me.peerId,
							name: recNow.name,
							projectId: recNow.projectId,
							vector: await readVersionVector(folderUri),
							files
						})
					);
				} else {
					const missing = await opsMissingFrom(folderUri, msg.vector || {});
					socket.write(
						encodeMessage({
							type: 'ops',
							from: me.peerId,
							port: lanPortFor(recNow.projectId),
							vector: await readVersionVector(folderUri),
							ops: missing
						})
					);
				}
			}
			if (msg.type === 'mailbox-updated') {
				void require('./projectMailbox').handleMailboxUpdatedSignal(kbRootUri, folderPrefix, msg);
				socket.end();
				return;
			} else if (msg.type === 'file-get' && msg.rel) {
				const rel = String(msg.rel || '')
					.replace(/\\/g, '/')
					.replace(/^\/+|\/+$/g, '');
				const parts = rel.split('/').filter(Boolean);
				if (!parts.length || parts.some(p => p === '..')) {
					socket.write(encodeMessage({ type: 'file-missing', rel }));
					socket.end();
					return;
				}
				try {
					const fileUri = require('vscode').Uri.joinPath(folderUri, ...parts);
					const data = Buffer.from(await require('vscode').workspace.fs.readFile(fileUri)).toString('utf8');
					socket.write(encodeMessage({ type: 'file', rel, data }));
				} catch {
					socket.write(encodeMessage({ type: 'file-missing', rel }));
				}
				socket.end();
				return;
			} else if (msg.type === 'ops' && Array.isArray(msg.ops)) {
				let applied = 0;
				for (const op of msg.ops) {
					const r = await applyOperation(kbRootUri, folderPrefix, op);
					if (r && r.ok && !r.skipped) applied += 1;
				}
				if (applied) {
					try {
						await require('./projectInternetSync').notifySharedProjectChanged(kbRootUri, folderPrefix);
					} catch {
						/* Project View may be closed */
					}
					try {
						const { compactOpLogIfNeeded } = require('./projectOpLog');
						const compactOp = await compactOpLogIfNeeded(kbRootUri, folderPrefix);
						if (compactOp) await publishLanOps(kbRootUri, folderPrefix, [compactOp]);
					} catch {
						/* compact is optional */
					}
				}
			}
			socket.end();
		})();
	};
	socket.on('data', chunk => {
		buf += chunk;
		processLine();
	});
	socket.on('end', () => {
		processLine();
	});
}

/**
 * Connect to another member’s LAN listener and exchange missing operations.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} host
 * @param {number} port
 */
async function syncWithLanPeer(kbRootUri, folderPrefix, host, port) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const me = await ensurePeerIdentity();
	const rec = await readProjectRecord(folderUri);
	if (!rec || !rec.shared) throw new Error('This project is not shared.');
	if (!isSharingActive(rec.projectId)) throw new Error('Sharing is stopped on this machine.');
	markPeerOnline(rec.projectId, me.peerId);
	const vector = await readVersionVector(folderUri);
	const helloOps = await opsForHello(folderUri);
	return new Promise((resolve, reject) => {
		rememberLanPeer(rec.projectId, host, port);
		const socket = net.connect({ host: String(host), port: Number(port) }, () => {
			socket.write(
				encodeMessage({
					type: 'hello',
					from: me.peerId,
					githubId: me.githubId || '',
					githubLogin: me.githubLogin || '',
					displayName: me.displayName || '',
					publicKey: me.publicKey || '',
					encKey: me.encKey || '',
					projectId: rec.projectId,
					vector,
					ops: helloOps,
					port: lanPortFor(rec.projectId),
					host: '127.0.0.1'
				})
			);
		});
		let buf = '';
		socket.setEncoding('utf8');
		socket.on('data', chunk => {
			buf += chunk;
		});
		socket.on('end', () => {
			void (async () => {
				try {
					const line = buf.split('\n').find(l => l.trim());
					const msg = line ? JSON.parse(line) : null;
					let applied = 0;
					if (msg && msg.type === 'snapshot' && Array.isArray(msg.files)) {
						const { applyIncomingSnapshot } = require('./projectFolderTransfer');
						await applyIncomingSnapshot(kbRootUri, folderPrefix, msg.files);
						applied = 1;
					} else if (msg && msg.type === 'ops' && Array.isArray(msg.ops)) {
						for (const op of msg.ops) {
							const r = await applyOperation(kbRootUri, folderPrefix, op);
							if (r && r.ok && !r.skipped) applied += 1;
						}
					}
					if (applied) {
						try {
							await require('./projectInternetSync').notifySharedProjectChanged(kbRootUri, folderPrefix);
						} catch {
							/* Project View may be closed */
						}
					}
					resolve({ applied });
				} catch (err) {
					reject(err);
				}
			})();
		});
		socket.on('error', reject);
	});
}

function stopLanListener(projectId) {
	const id = String(projectId || '');
	const server = servers.get(id);
	if (server) {
		try {
			server.close();
		} catch {
			/* ignore */
		}
	}
	servers.delete(id);
	ports.delete(id);
	onlinePeers.delete(id);
	knownPeers.delete(id);
	const helloTimer = lanHelloTimers.get(id);
	if (helloTimer) clearInterval(helloTimer);
	lanHelloTimers.delete(id);
	try {
		require('./projectInternetSync').stopInternetListener(id);
	} catch {
		/* ignore */
	}
	notifyPresenceChange(true);
	stopPresenceUiLoopIfIdle();
}

/**
 * Owner or member pressed Stop sharing: close every live path for this project.
 * Remembered addresses stay on disk so Start sharing can find people again.
 */
function disconnectAllPeers(projectId) {
	stopLanListener(projectId);
}

function stopAllLanListeners() {
	for (const server of servers.values()) {
		try {
			server.close();
		} catch {
			/* ignore */
		}
	}
	servers.clear();
	ports.clear();
	onlinePeers.clear();
	knownPeers.clear();
	for (const helloTimer of lanHelloTimers.values()) clearInterval(helloTimer);
	lanHelloTimers.clear();
	try {
		require('./projectInternetSync').stopAllInternetListeners();
	} catch {
		/* ignore */
	}
	notifyPresenceChange(true);
	stopPresenceUiLoopIfIdle();
}

function lanPortFor(projectId) {
	return ports.get(String(projectId || '')) || 0;
}

function listenLan(server, preferred) {
	const want = Number(preferred) || 0;
	const bind = port =>
		new Promise((resolve, reject) => {
			const onErr = err => reject(err);
			server.once('error', onErr);
			server.listen(port, '0.0.0.0', () => {
				server.off('error', onErr);
				resolve();
			});
		});
	if (!want) return bind(0);
	return bind(want).catch(err => {
		if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) return bind(0);
		throw err;
	});
}

/**
 * Ask a listening member for the whole project folder.
 * @param {string} host
 * @param {number} port
 * @param {{ projectId: string, capability: string }} invite
 */
async function requestLanSnapshot(host, port, invite, timeoutMs) {
	const me = await ensurePeerIdentity();
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: String(host), port: Number(port) }, () => {
			socket.write(
				encodeMessage({
					type: 'snapshot-hello',
					projectId: invite.projectId,
					capability: invite.capability,
					from: me.peerId,
					githubId: me.githubId || '',
					githubLogin: me.githubLogin || '',
					displayName: me.displayName || ''
				})
			);
		});
		let buf = '';
		socket.setEncoding('utf8');
		socket.on('data', chunk => {
			buf += chunk;
		});
		socket.on('end', () => {
			try {
				const line = buf.split('\n').find(l => l.trim());
				const msg = line ? JSON.parse(line) : null;
				if (!msg || msg.type === 'error') {
					reject(new Error((msg && msg.message) || 'Could not download the project.'));
					return;
				}
				if (msg.type !== 'snapshot' || !Array.isArray(msg.files)) {
					reject(new Error('That member did not send the project folder.'));
					return;
				}
				resolve(msg);
			} catch (err) {
				reject(err);
			}
		});
		socket.on('error', reject);
		socket.setTimeout(Math.max(3000, Number(timeoutMs) || 8000), () => {
			socket.destroy();
			reject(new Error('Timed out waiting for the project folder.'));
		});
	});
}

/**
 * Try every address on the invite, then this machine, until one sends the folder.
 * @param {{ projectId: string, capability: string, host?: string, hosts?: string[], port?: number }} invite
 */
async function requestLanSnapshotFromInvite(invite) {
	const port = Number(invite && invite.port) || 0;
	if (!port) {
		throw new Error(
			'That invite has no live connection. The other person must have sharing on, then copy a new invite.'
		);
	}
	const hosts = [];
	const add = h => {
		const s = String(h || '').trim();
		if (s && !hosts.includes(s)) hosts.push(s);
	};
	add(invite.host);
	if (Array.isArray(invite.hosts)) invite.hosts.forEach(add);
	add('127.0.0.1');
	add('localhost');
	let lastErr;
	for (const host of hosts) {
		try {
			const snap = await requestLanSnapshot(host, port, invite, 6000);
			if (!snap || !Array.isArray(snap.files) || !snap.files.length) {
				throw new Error('That member sent an empty project folder.');
			}
			const hasRecord = snap.files.some(f => /(^|\/)\.drip\/project\.json$/i.test(String((f && f.path) || '')));
			if (!hasRecord) {
				throw new Error('That member did not send the project sidecar. Ask them to share again.');
			}
			return snap;
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr || new Error('Could not download the project.');
}

/**
 * Push operations to every remembered LAN peer (localhost or last invite).
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {object[]} ops
 */
async function publishLanOps(kbRootUri, folderPrefix, ops) {
	if (!Array.isArray(ops) || !ops.length) return;
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await readProjectRecord(folderUri);
	if (!rec || !rec.shared || !isSharingActive(rec.projectId)) return;
	const me = await ensurePeerIdentity();
	for (const peer of knownLanPeers(rec.projectId)) {
		try {
			await pushOpsToLanPeer(peer.host, peer.port, me.peerId, ops);
		} catch (err) {
			console.error('[DRIP] lan op push', err && err.message ? err.message : err);
		}
	}
}

/**
 * Ask a remembered LAN peer for one project file. Returns the text, or null.
 * @param {import('vscode').Uri} folderUri
 * @param {string} rel
 */
async function requestPeerFile(folderUri, rel) {
	const rec = await readProjectRecord(folderUri);
	if (!rec || !rec.shared || !isSharingActive(rec.projectId)) return null;
	const path = String(rel || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	if (!path) return null;
	const me = await ensurePeerIdentity();
	for (const peer of knownLanPeers(rec.projectId)) {
		try {
			const data = await requestFileFromLanPeer(peer.host, peer.port, me.peerId, path);
			if (data != null) return data;
		} catch {
			/* try the next remembered address */
		}
	}
	return null;
}

function requestFileFromLanPeer(host, port, from, rel) {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: String(host), port: Number(port) }, () => {
			socket.write(encodeMessage({ type: 'file-get', from, rel }));
		});
		let buf = '';
		const done = (err, data) => {
			try {
				socket.destroy();
			} catch {
				/* ignore */
			}
			if (err) reject(err);
			else resolve(data);
		};
		socket.setEncoding('utf8');
		socket.setTimeout(4000, () => done(new Error('LAN peer timed out.')));
		socket.on('data', chunk => {
			buf += chunk;
			const nl = buf.indexOf('\n');
			if (nl < 0) return;
			let msg;
			try {
				msg = JSON.parse(buf.slice(0, nl).trim());
			} catch {
				done(new Error('bad file reply'));
				return;
			}
			if (msg && msg.type === 'file' && msg.data != null) done(null, String(msg.data));
			else done(null, null);
		});
		socket.on('error', err => done(err));
		socket.on('end', () => {
			if (!buf) done(null, null);
		});
	});
}

function pushOpsToLanPeer(host, port, from, ops) {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: String(host), port: Number(port) }, () => {
			socket.write(encodeMessage({ type: 'ops', from, ops }));
		});
		const done = err => {
			try {
				socket.destroy();
			} catch {
				/* ignore */
			}
			if (err) reject(err);
			else resolve();
		};
		socket.setTimeout(4000, () => done(new Error('LAN peer timed out.')));
		socket.on('error', err => done(err));
		socket.on('end', () => done());
		socket.on('close', () => done());
	});
}

module.exports = {
	startLanListener,
	syncWithLanPeer,
	helloKnownLanPeers,
	requestLanSnapshot,
	requestLanSnapshotFromInvite,
	stopLanListener,
	disconnectAllPeers,
	stopAllLanListeners,
	lanPortFor,
	markPeerOnline,
	dropPeerOnline,
	keepOnlineMembers,
	isPeerOnline,
	onlineCountFor,
	notifyPresenceChange,
	isSharingActive,
	writeSharingActive,
	setPresenceChangeListener,
	rememberLanPeer,
	rememberAdvertisedListenPort,
	knownLanPeers,
	publishLanOps,
	requestPeerFile,
	persistKnownLanPeers,
	loadRememberedLanPeers
};
