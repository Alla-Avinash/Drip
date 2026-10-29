'use strict';

/**
 * Public-internet path for a shared project.
 * A public MQTT broker only forwards short-lived encrypted blobs. It never
 * stores issues. LAN is tried first; this runs when two machines cannot open
 * a direct port (home routers, or two windows that cannot see each other's LAN IP).
 */

const crypto = require('crypto');
const mqtt = require('mqtt');
const vscode = require('vscode');
const { newPrefixedId } = require('./peerIds');
const { ensurePeerIdentity } = require('./peerIdentity');
const { projectFolderUriFromPrefix, readProjectRecord, writeProjectRecord } = require('./projectSidecar');
const { applyOperation } = require('./projectOpApply');
const { opsMissingFrom, readVersionVector, cannotFillGap, opsForHello } = require('./projectOpLog');
const { isSharingActive } = require('./projectLanSync');

const DEFAULT_BROKER = 'wss://broker.emqx.io:8084/mqtt';
const CHUNK = 24 * 1024;
const SNAPSHOT_MS = 120000;

/** @type {Map<string, { client: import('mqtt').MqttClient, kbRootUri: import('vscode').Uri, folderPrefix: string, capability: string, peerId: string }>} */
const sessions = new Map();

function brokerUrl() {
	return String(DEFAULT_BROKER);
}

function topicBase(projectId) {
	return `drip/v1/${String(projectId || '')}`;
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
	if (buf.length < 29) throw new Error('Bad packet.');
	const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromCapability(capability), buf.subarray(0, 12));
	decipher.setAuthTag(buf.subarray(12, 28));
	const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
	return JSON.parse(plain.toString('utf8'));
}

function connectBroker() {
	return new Promise((resolve, reject) => {
		const client = mqtt.connect(brokerUrl(), {
			clientId: `drip-${crypto.randomBytes(6).toString('hex')}`,
			clean: true,
			connectTimeout: 20000,
			reconnectPeriod: 5000,
			protocolVersion: 4
		});
		const t = setTimeout(() => {
			try {
				client.end(true);
			} catch {
				/* ignore */
			}
			reject(new Error('Could not reach the internet relay. Check this PC is online.'));
		}, 22000);
		client.once('connect', () => {
			clearTimeout(t);
			resolve(client);
		});
		client.once('error', err => {
			clearTimeout(t);
			reject(err instanceof Error ? err : new Error(String(err)));
		});
	});
}

function publishJson(client, topic, obj) {
	return new Promise((resolve, reject) => {
		client.publish(topic, JSON.stringify(obj), { qos: 1, retain: false }, err => {
			if (err) reject(err);
			else resolve();
		});
	});
}

async function publishChunks(client, topic, capability, payload) {
	const raw = encryptBox(capability, payload);
	const n = Math.max(1, Math.ceil(raw.length / CHUNK));
	const id = newPrefixedId('snap');
	for (let i = 0; i < n; i += 1) {
		await publishJson(client, topic, {
			type: 'chunk',
			id,
			i,
			n,
			part: raw.slice(i * CHUNK, (i + 1) * CHUNK)
		});
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function startInternetListener(kbRootUri, folderPrefix) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await readProjectRecord(folderUri);
	if (!rec || !rec.shared || !rec.projectId || !isSharingActive(rec.projectId)) return null;
	if (sessions.has(rec.projectId)) return { projectId: rec.projectId };
	const me = await ensurePeerIdentity();
	const client = await connectBroker();
	const session = {
		client,
		kbRootUri,
		folderPrefix,
		capability: rec.inviteCapability,
		peerId: me.peerId,
		projectId: rec.projectId,
		helloTimer: null,
		chunks: new Map()
	};
	sessions.set(rec.projectId, session);
	const base = topicBase(rec.projectId);
	await new Promise((resolve, reject) => {
		client.subscribe([`${base}/to-host`, `${base}/ops`, `${base}/sync`, `${base}/to/${me.peerId}`], { qos: 1 }, err => {
			if (err) reject(err);
			else resolve();
		});
	});
	client.on('message', (topic, buf) => {
		void onSessionMessage(rec.projectId, topic, buf);
	});
	client.on('close', () => {
		const cur = sessions.get(rec.projectId);
		if (cur && cur.client === client) {
			if (cur.helloTimer) clearInterval(cur.helloTimer);
			sessions.delete(rec.projectId);
			if (!cur.stopped && isSharingActive(rec.projectId)) {
				setTimeout(() => {
					startInternetListener(kbRootUri, folderPrefix).catch(() => {});
				}, 2000);
			}
		}
	});
	try {
		require('./projectLanSync').markPeerOnline(rec.projectId, me.peerId);
	} catch {
		/* presence is optional */
	}
	void publishHello(rec.projectId);
	session.helloTimer = setInterval(() => {
		void publishHello(rec.projectId);
	}, 8000);
	return { projectId: rec.projectId };
}

async function onSessionMessage(projectId, topic, buf) {
	const session = sessions.get(String(projectId || ''));
	if (!session) return;
	const rec = await readProjectRecord(projectFolderUriFromPrefix(session.kbRootUri, session.folderPrefix));
	if (!rec || !rec.shared || !isSharingActive(rec.projectId)) return;
	let outer;
	try {
		outer = JSON.parse(Buffer.from(buf).toString('utf8'));
	} catch {
		return;
	}
	const base = topicBase(projectId);
	if (topic === `${base}/ops` || topic === `${base}/to/${session.peerId}` || topic === `${base}/sync`) {
		let msg;
		if (outer && outer.type === 'chunk') {
			msg = takeSessionChunk(session, rec.inviteCapability, outer);
			if (!msg) return;
		} else {
			try {
				msg = decryptBox(rec.inviteCapability, outer.box);
			} catch {
				return;
			}
		}
		if (!msg) return;
		if (msg.type === 'mailbox-updated') {
			void require('./projectMailbox').handleMailboxUpdatedSignal(
				session.kbRootUri,
				session.folderPrefix,
				msg
			);
			return;
		}
		if (msg.type === 'snapshot' && Array.isArray(msg.files)) {
			try {
				const { applyIncomingSnapshot } = require('./projectFolderTransfer');
				await applyIncomingSnapshot(session.kbRootUri, session.folderPrefix, msg.files);
			} catch (err) {
				console.error('[DRIP] internet snapshot catch-up', err);
			}
			return;
		}
		if (msg.type === 'hello' && msg.from && msg.from !== session.peerId) {
			const fromPerson = require('./projectSharing').personFromWire(msg);
			const refuse = require('./projectSharing').refuseJoinReason(rec, fromPerson);
			if (refuse) {
				try {
					require('./projectLanSync').dropPeerOnline(projectId, msg.from);
					require('./projectShareNotify').announceRemovedPeerSeen(rec, fromPerson);
				} catch {
					/* notice is optional */
				}
				await publishJson(session.client, `${base}/to/${msg.from}`, { type: 'error', message: refuse });
				return;
			}
			if (require('./projectSharing').refreshMemberFromPerson(rec, fromPerson)) {
				await writeProjectRecord(projectFolderUriFromPrefix(session.kbRootUri, session.folderPrefix), rec);
			}
			try {
				const lan = require('./projectLanSync');
				if (require('./projectSharing').memberOf(rec, msg.from)) {
					lan.markPeerOnline(projectId, msg.from);
				}
				lan.rememberAdvertisedListenPort(projectId, msg);
				void lan.persistKnownLanPeers(
					projectFolderUriFromPrefix(session.kbRootUri, session.folderPrefix),
					projectId
				);
			} catch {
				/* presence is optional */
			}
			if (Array.isArray(msg.ops)) await applyIncomingOps(session, msg.ops);
			const folderUri = projectFolderUriFromPrefix(session.kbRootUri, session.folderPrefix);
			if (await cannotFillGap(folderUri, msg.vector || {})) {
				const { collectFolderFiles } = require('./projectFolderTransfer');
				const files = await collectFolderFiles(folderUri);
				await publishChunks(session.client, `${base}/to/${msg.from}`, rec.inviteCapability, {
					type: 'snapshot',
					from: session.peerId,
					name: rec.name,
					projectId: rec.projectId,
					files
				});
				return;
			}
			const missing = await opsMissingFrom(folderUri, msg.vector || {});
			if (!missing.length) return;
			await publishJson(session.client, `${base}/to/${msg.from}`, {
				v: 1,
				box: encryptBox(rec.inviteCapability, { type: 'ops', from: session.peerId, ops: missing })
			});
			return;
		}
		if (msg.from && msg.from !== session.peerId) {
			try {
				if (require('./projectSharing').memberOf(rec, msg.from)) {
					require('./projectLanSync').markPeerOnline(projectId, msg.from);
				} else {
					require('./projectLanSync').dropPeerOnline(projectId, msg.from);
				}
			} catch {
				/* presence is optional */
			}
		}
		if (!Array.isArray(msg.ops)) return;
		await applyIncomingOps(session, msg.ops);
		return;
	}
	if (topic !== `${base}/to-host`) return;
	let msg;
	try {
		msg = decryptBox(rec.inviteCapability, outer.box);
	} catch {
		return;
	}
	if (!msg || !msg.from) return;
	const replyTo = `${base}/to/${msg.from}`;
	if (msg.type === 'snapshot-hello') {
		if (rec.projectId !== String(msg.projectId || '')) {
			await publishJson(session.client, replyTo, { type: 'error', message: 'That invite is for a different project.' });
			return;
		}
		const asker = require('./projectSharing').personFromWire(msg);
		const refuse = require('./projectSharing').refuseJoinReason(rec, asker, { inviteOk: true });
		if (refuse) {
			await publishJson(session.client, replyTo, { type: 'error', message: refuse });
			return;
		}
		try {
			await require('./projectSharing').rememberJoinRequest(
				projectFolderUriFromPrefix(session.kbRootUri, session.folderPrefix),
				asker,
				session.folderPrefix
			);
		} catch (err) {
			await publishJson(session.client, replyTo, {
				type: 'error',
				message: err instanceof Error ? err.message : String(err)
			});
			return;
		}
		const { collectFolderFiles } = require('./projectFolderTransfer');
		const files = await collectFolderFiles(projectFolderUriFromPrefix(session.kbRootUri, session.folderPrefix));
		await publishChunks(session.client, replyTo, rec.inviteCapability, {
			type: 'snapshot',
			name: rec.name,
			projectId: rec.projectId,
			files
		});
		return;
	}
	if (msg.type === 'hello') {
		const helloPerson = require('./projectSharing').personFromWire(msg);
		const refuse = require('./projectSharing').refuseJoinReason(rec, helloPerson);
		if (refuse) {
			await publishJson(session.client, replyTo, { type: 'error', message: refuse });
			return;
		}
		if (require('./projectSharing').refreshMemberFromPerson(rec, helloPerson)) {
			await writeProjectRecord(projectFolderUriFromPrefix(session.kbRootUri, session.folderPrefix), rec);
		}
		if (Array.isArray(msg.ops)) await applyIncomingOps(session, msg.ops);
		const folderUri = projectFolderUriFromPrefix(session.kbRootUri, session.folderPrefix);
		if (await cannotFillGap(folderUri, msg.vector || {})) {
			const { collectFolderFiles } = require('./projectFolderTransfer');
			const files = await collectFolderFiles(folderUri);
			await publishChunks(session.client, replyTo, rec.inviteCapability, {
				type: 'snapshot',
				from: session.peerId,
				name: rec.name,
				projectId: rec.projectId,
				files
			});
			return;
		}
		const missing = await opsMissingFrom(folderUri, msg.vector || {});
		await publishChunks(session.client, replyTo, rec.inviteCapability, {
			type: 'ops',
			from: session.peerId,
			vector: await readVersionVector(folderUri),
			ops: missing
		});
	}
}

function takeSessionChunk(session, capability, outer) {
	const id = String((outer && outer.id) || '');
	if (!id || !session.chunks) return null;
	let rec = session.chunks.get(id);
	if (!rec) {
		rec = { expected: Number(outer.n) || 0, parts: new Map() };
		session.chunks.set(id, rec);
	}
	rec.parts.set(Number(outer.i), String(outer.part || ''));
	if (!rec.expected || rec.parts.size < rec.expected) return null;
	const raw = Array.from({ length: rec.expected }, (_, i) => rec.parts.get(i) || '').join('');
	session.chunks.delete(id);
	try {
		return decryptBox(capability, raw);
	} catch {
		return null;
	}
}

/**
 * Guest: download the whole project folder over the internet.
 * @param {{ projectId: string, capability: string }} invite
 */
async function requestInternetSnapshot(invite) {
	const projectId = String((invite && invite.projectId) || '');
	const capability = String((invite && invite.capability) || '');
	if (!projectId || !capability) throw new Error('That invite is missing the project or the secret.');
	const me = await ensurePeerIdentity();
	const client = await connectBroker();
	const base = topicBase(projectId);
	const myTopic = `${base}/to/${me.peerId}`;
	const chunks = new Map();
	let expected = 0;
	let chunkId = '';
	return new Promise((resolve, reject) => {
		const finish = (err, value) => {
			clearTimeout(timer);
			try {
				client.end(true);
			} catch {
				/* ignore */
			}
			if (err) reject(err);
			else resolve(value);
		};
		const timer = setTimeout(() => {
			finish(new Error('Timed out waiting for the project over the internet. The other person must have sharing on.'));
		}, SNAPSHOT_MS);
		client.on('message', (topic, buf) => {
			if (topic !== myTopic) return;
			let msg;
			try {
				msg = JSON.parse(Buffer.from(buf).toString('utf8'));
			} catch {
				return;
			}
			if (msg && msg.type === 'error') {
				finish(new Error(msg.message || 'The other person refused the download.'));
				return;
			}
			if (!msg || msg.type !== 'chunk') return;
			if (!chunkId) {
				chunkId = String(msg.id || '');
				expected = Number(msg.n) || 0;
			}
			if (String(msg.id || '') !== chunkId) return;
			chunks.set(Number(msg.i), String(msg.part || ''));
			if (!expected || chunks.size < expected) return;
			const raw = Array.from({ length: expected }, (_, i) => chunks.get(i) || '').join('');
			try {
				const payload = decryptBox(capability, raw);
				if (!payload || payload.type !== 'snapshot' || !Array.isArray(payload.files) || !payload.files.length) {
					throw new Error('empty');
				}
				const hasRecord = payload.files.some(f => /(^|\/)\.drip\/project\.json$/i.test(String((f && f.path) || '')));
				if (!hasRecord) throw new Error('no sidecar');
				finish(null, payload);
			} catch {
				finish(new Error('The internet copy of the project was incomplete. Try joining again.'));
			}
		});
		client.subscribe(myTopic, { qos: 1 }, err => {
			if (err) {
				finish(err);
				return;
			}
			const box = encryptBox(capability, {
				type: 'snapshot-hello',
				from: me.peerId,
				githubId: me.githubId || '',
				githubLogin: me.githubLogin || '',
				displayName: me.displayName || '',
				projectId
			});
			client.publish(`${base}/to-host`, JSON.stringify({ v: 1, box }), { qos: 1 }, pubErr => {
				if (pubErr) finish(pubErr);
			});
		});
	});
}

/**
 * Push local operations to other members over the internet.
 * @param {string} projectId
 * @param {string} capability
 * @param {object[]} ops
 */
async function publishInternetOps(projectId, capability, ops) {
	const session = sessions.get(String(projectId || ''));
	if (!session || !session.client || !Array.isArray(ops) || !ops.length) return;
	const box = encryptBox(capability, { type: 'ops', from: session.peerId, ops });
	await publishJson(session.client, `${topicBase(projectId)}/ops`, { v: 1, box });
}

async function publishMailboxNotice(projectId, capability, msg) {
	const session = sessions.get(String(projectId || ''));
	if (!session || !session.client || !msg) return;
	const box = encryptBox(capability, { ...msg, from: session.peerId });
	await publishJson(session.client, `${topicBase(projectId)}/sync`, { v: 1, box });
}

async function applyIncomingOps(session, ops) {
	let applied = 0;
	for (const op of ops || []) {
		if (!op || op.author === session.peerId) continue;
		const r = await applyOperation(session.kbRootUri, session.folderPrefix, op);
		if (r && r.ok && !r.skipped) applied += 1;
	}
	if (applied) await notifySharedProjectChanged(session.kbRootUri, session.folderPrefix);
	try {
		const { compactOpLogIfNeeded } = require('./projectOpLog');
		const compactOp = await compactOpLogIfNeeded(session.kbRootUri, session.folderPrefix);
		if (compactOp) await publishInternetOps(session.projectId, session.capability, [compactOp]);
	} catch {
		/* compact is optional */
	}
}

async function publishHello(projectId) {
	const session = sessions.get(String(projectId || ''));
	if (!session || !session.client) return;
	const folderUri = projectFolderUriFromPrefix(session.kbRootUri, session.folderPrefix);
	const rec = await readProjectRecord(folderUri);
	if (!rec || !rec.inviteCapability) return;
	const vector = await readVersionVector(folderUri);
	const ops = await opsForHello(folderUri);
	const ident = await require('./projectSharing').wireIdentityFields();
	await publishJson(session.client, `${topicBase(projectId)}/sync`, {
		v: 1,
		box: encryptBox(rec.inviteCapability, {
			type: 'hello',
			...ident,
			vector,
			ops,
			port: require('./projectLanSync').lanPortFor(projectId) || 0,
			host: '127.0.0.1'
		})
	});
}

async function notifySharedProjectChanged(kbRootUri, folderPrefix) {
	try {
		const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
		const issuesUri = vscode.Uri.joinPath(folderUri, '_issues.d.txt');
		const { indexNewNoteImmediately } = require('../indexing/dripTxt/dripTxtIndex');
		await indexNewNoteImmediately(kbRootUri, issuesUri);
	} catch {
		/* index catch-up is best-effort */
	}
	try {
		require('../views/lhs/projects/panel').refreshProjectViewIfShown();
	} catch {
		/* Project View may be closed */
	}
}

function stopInternetListener(projectId) {
	const session = sessions.get(String(projectId || ''));
	if (!session) return;
	session.stopped = true;
	sessions.delete(String(projectId || ''));
	if (session.helloTimer) clearInterval(session.helloTimer);
	try {
		session.client.end(true);
	} catch {
		/* ignore */
	}
}

function stopAllInternetListeners() {
	for (const id of [...sessions.keys()]) stopInternetListener(id);
}

function isInternetListening(projectId) {
	return sessions.has(String(projectId || ''));
}

module.exports = {
	startInternetListener,
	stopInternetListener,
	stopAllInternetListeners,
	requestInternetSnapshot,
	publishInternetOps,
	isInternetListening,
	notifySharedProjectChanged,
	publishMailboxNotice,
	brokerUrl
};
