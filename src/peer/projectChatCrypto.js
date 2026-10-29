'use strict';

/**
 * Chat-room encryption.
 *
 * Each DM room and each team room owns a random AES-256-GCM room key. The room
 * key is handed to a member sealed to that member's X25519 public key
 * (ephemeral ECDH -> shared secret -> AES-GCM), and each message is sealed with
 * the room key. So the ciphertext still travels to every member (the peer
 * network broadcasts everything), but only key-holders can open it.
 *
 * The keychain lives in Secret Storage (the OS-encrypted, login-protected store
 * that also holds the private identity keys), never in the synced `.drip/`
 * sidecar, so a folder snapshot can never leak a plaintext key to someone
 * outside the room. Only keys this peer can decrypt are ever stored here.
 */

const crypto = require('crypto');
const { getEncryptionPrivateKey, getPeerExtensionContext } = require('./peerIdentity');

const KEYCHAIN_STATE_KEY = 'drip.projectChat.roomKeys';

function dh(privB64, pubB64) {
	const priv = crypto.createPrivateKey({ key: Buffer.from(privB64, 'base64'), type: 'pkcs8', format: 'der' });
	const pub = crypto.createPublicKey({ key: Buffer.from(pubB64, 'base64'), type: 'spki', format: 'der' });
	return crypto.diffieHellman({ privateKey: priv, publicKey: pub });
}

function deriveAesKey(shared) {
	return crypto.createSecretKey(crypto.createHash('sha256').update(shared).digest());
}

/** A fresh random 256-bit room key, base64. */
function newRoomKey() {
	return crypto.randomBytes(32).toString('base64');
}

/** Seal a room key to one recipient's X25519 public key (ephemeral ECDH + AES-GCM). */
function sealRoomKeyTo(recipientEncPubB64, roomKeyB64) {
	const ephemeral = crypto.generateKeyPairSync('x25519');
	const epub = ephemeral.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
	const epriv = ephemeral.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
	const key = deriveAesKey(dh(epriv, recipientEncPubB64));
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	const enc = Buffer.concat([cipher.update(Buffer.from(roomKeyB64, 'base64')), cipher.final()]);
	return {
		epub,
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		cipher: enc.toString('base64')
	};
}

/** Open a room key sealed to this peer. Throws if the box is not ours or tampered. */
async function openRoomKeyFrom(sealed) {
	const myPriv = await getEncryptionPrivateKey();
	const key = deriveAesKey(dh(myPriv, String((sealed && sealed.epub) || '')));
	const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String((sealed && sealed.iv) || ''), 'base64'));
	d.setAuthTag(Buffer.from(String((sealed && sealed.tag) || ''), 'base64'));
	const roomKey = Buffer.concat([
		d.update(Buffer.from(String((sealed && sealed.cipher) || ''), 'base64')),
		d.final()
	]);
	return roomKey.toString('base64');
}

/** Seal a message object with the room key. */
function sealMessage(roomKeyB64, value) {
	const key = crypto.createSecretKey(Buffer.from(roomKeyB64, 'base64'));
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
	return {
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		cipher: enc.toString('base64')
	};
}

/** Open a message sealed with the room key. Throws if tampered or wrong key. */
function openMessage(roomKeyB64, sealed) {
	const key = crypto.createSecretKey(Buffer.from(roomKeyB64, 'base64'));
	const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String((sealed && sealed.iv) || ''), 'base64'));
	d.setAuthTag(Buffer.from(String((sealed && sealed.tag) || ''), 'base64'));
	const plain = Buffer.concat([
		d.update(Buffer.from(String((sealed && sealed.cipher) || ''), 'base64')),
		d.final()
	]);
	return JSON.parse(plain.toString('utf8'));
}

// --- machine-local keychain (OS-encrypted Secret Storage, never synced) ---

/**
 * Read the whole room-key map from Secret Storage as one JSON blob. The map is
 * a plain object keyed by project/room/id, each value a generations list.
 */
async function readKeychainMap() {
	try {
		const raw = await getPeerExtensionContext().secrets.get(KEYCHAIN_STATE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === 'object' ? parsed : {};
		}
	} catch {
		/* keychain read is best-effort */
	}
	return {};
}

async function writeKeychainMap(map) {
	try {
		await getPeerExtensionContext().secrets.store(KEYCHAIN_STATE_KEY, JSON.stringify(map));
	} catch {
		/* keychain persistence is best-effort */
	}
}

function roomStoreKey(projectId, room, id) {
	return `${String(projectId || '')}\0${String(room || '')}\0${String(id || '')}`;
}

/**
 * A room keyed by project/room/id holds a small list of key generations. Each
 * generation is a key plus the participant set it was minted for. Keeping the
 * older generations (instead of overwriting one key) lets a member still read
 * the history after a rotation: an old message carries which generation sealed
 * it, so it is opened with that generation's key.
 */
function normalizeGenerations(v) {
	const list = (v && Array.isArray(v.generations)) ? v.generations : [];
	const out = [];
	for (const g of list) {
		if (!g || !g.key) continue;
		const gen = Math.floor(Number(g.gen));
		if (!Number.isFinite(gen) || gen < 1) continue;
		out.push({
			gen,
			key: String(g.key),
			participants: Array.isArray(g.participants) ? g.participants.map(String) : []
		});
	}
	out.sort((a, b) => a.gen - b.gen);
	return out;
}

/** @returns {Promise<{ generations: Array<{gen:number,key:string,participants:string[]}>, nextGen: number }>} */
async function roomKeyState(projectId, room, id) {
	const map = await readKeychainMap();
	const storeKey = roomStoreKey(projectId, room, id);
	const generations = normalizeGenerations(map[storeKey]);
	const nextGen = generations.length
		? generations.reduce((m, g) => Math.max(m, g.gen), 0) + 1
		: 1;
	return { generations, nextGen };
}

/**
 * Record one key generation for a room (used when the key is minted or a grant
 * arrives). Replaces any generation with the same number.
 */
async function storeRoomKeyGeneration(projectId, room, id, gen, roomKeyB64, participants) {
	const g = Math.floor(Number(gen));
	if (!Number.isFinite(g) || g < 1) return roomKeyB64;
	const map = await readKeychainMap();
	const storeKey = roomStoreKey(projectId, room, id);
	const generations = normalizeGenerations(map[storeKey]);
	const entry = {
		gen: g,
		key: String(roomKeyB64 || ''),
		participants: Array.isArray(participants) ? participants.map(String) : []
	};
	const i = generations.findIndex(x => x.gen === g);
	if (i >= 0) generations[i] = entry;
	else generations.push(entry);
	generations.sort((a, b) => a.gen - b.gen);
	map[storeKey] = { generations };
	await writeKeychainMap(map);
	return roomKeyB64;
}

/**
 * Drop generations that no message in this room references (so a rotation does
 * not hoard padlocks forever). If nothing is left, the whole entry is removed.
 * `keepGens` is a set or array of generation numbers still in use.
 */
async function pruneRoomKeys(projectId, room, id, keepGens) {
	if (room !== 'dm' && room !== 'team') return;
	const keep = new Set();
	for (const n of keepGens || []) {
		const g = Math.floor(Number(n));
		if (Number.isFinite(g) && g >= 1) keep.add(g);
	}
	const map = await readKeychainMap();
	const storeKey = roomStoreKey(projectId, room, id);
	const v = map[storeKey];
	if (!v) return;
	const generations = normalizeGenerations(v).filter(g => keep.has(g.gen));
	if (generations.length) {
		map[storeKey] = { generations };
	} else {
		delete map[storeKey];
	}
	await writeKeychainMap(map);
}

module.exports = {
	newRoomKey,
	sealRoomKeyTo,
	openRoomKeyFrom,
	sealMessage,
	openMessage,
	roomKeyState,
	storeRoomKeyGeneration,
	pruneRoomKeys
};
