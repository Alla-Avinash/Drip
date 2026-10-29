'use strict';

/**
 * One local peer identity per person (user-level, not per knowledge base).
 * Public fields live in globalState; the private key lives in Secret Storage.
 */

const crypto = require('crypto');
const os = require('os');
const vscode = require('vscode');
const { newPrefixedId } = require('./peerIds');

const PUBLIC_STATE_KEY = 'drip.peerIdentity.public';
const PRIVATE_SECRET_KEY = 'drip.peerIdentity.privateKey';
const ENC_PRIVATE_SECRET_KEY = 'drip.peerIdentity.encPrivateKey';

/** @type {import('vscode').ExtensionContext | null} */
let _context = null;

/**
 * @param {import('vscode').ExtensionContext} context
 */
function bindPeerIdentityContext(context) {
	_context = context || null;
}

function requireContext() {
	if (!_context) throw new Error('Peer identity is not ready yet.');
	return _context;
}

function getPeerExtensionContext() {
	return requireContext();
}

/**
 * @returns {{ privateKey: string, publicKey: string }}
 */
function generateKeypair() {
	const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
	return {
		privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
		publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
	};
}

/**
 * Separate X25519 keypair used to seal chat room keys to a specific peer.
 * The Ed25519 key above only signs; it cannot encrypt.
 * @returns {{ privateKey: string, publicKey: string }}
 */
function generateEncryptionKeypair() {
	const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
	return {
		privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
		publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
	};
}

/**
 * @param {string} privateKeyB64
 * @param {string} text
 * @returns {string}
 */
function signText(privateKeyB64, text) {
	const key = crypto.createPrivateKey({
		key: Buffer.from(privateKeyB64, 'base64'),
		type: 'pkcs8',
		format: 'der'
	});
	return crypto.sign(null, Buffer.from(String(text || ''), 'utf8'), key).toString('base64');
}

/**
 * @param {string} publicKeyB64
 * @param {string} text
 * @param {string} signatureB64
 * @returns {boolean}
 */
function verifyText(publicKeyB64, text, signatureB64) {
	try {
		const key = crypto.createPublicKey({
			key: Buffer.from(publicKeyB64, 'base64'),
			type: 'spki',
			format: 'der'
		});
		return crypto.verify(
			null,
			Buffer.from(String(text || ''), 'utf8'),
			key,
			Buffer.from(String(signatureB64 || ''), 'base64')
		);
	} catch {
		return false;
	}
}

function defaultDisplayName() {
	try {
		const host = os.hostname();
		if (host && String(host).trim()) return String(host).trim().replace(/\s+/g, '-');
	} catch {
		/* ignore */
	}
	try {
		const n = os.userInfo().username;
		if (n && String(n).trim()) return String(n).trim().replace(/\s+/g, '-');
	} catch {
		/* ignore */
	}
	return 'This PC';
}

/**
 * @returns {Promise<{ peerId: string, displayName: string, publicKey: string }>}
 */
async function readPublicRecord() {
	const ctx = requireContext();
	const rec = ctx.globalState.get(PUBLIC_STATE_KEY);
	if (rec && typeof rec === 'object' && rec.peerId && rec.publicKey && rec.encKey) {
		return {
			peerId: String(rec.peerId),
			displayName: String(rec.displayName || defaultDisplayName()),
			publicKey: String(rec.publicKey),
			encKey: String(rec.encKey),
			githubId: rec.githubId ? String(rec.githubId) : '',
			githubLogin: rec.githubLogin ? String(rec.githubLogin) : ''
		};
	}
	return ensurePeerIdentity();
}

/**
 * Create the local identity once. Later calls return the same person.
 * The signing key (Ed25519) and the encryption key (X25519) are separate:
 * signing proves authorship, encryption seals chat room keys to a peer.
 * @returns {Promise<{ peerId: string, displayName: string, publicKey: string, encKey: string }>}
 */
async function ensurePeerIdentity() {
	const ctx = requireContext();
	let existing = ctx.globalState.get(PUBLIC_STATE_KEY);
	let priv = await ctx.secrets.get(PRIVATE_SECRET_KEY);
	if (!(existing && existing.peerId && existing.publicKey) || !priv) {
		const keys = generateKeypair();
		existing = {
			peerId: newPrefixedId('peer'),
			displayName: defaultDisplayName(),
			publicKey: keys.publicKey
		};
		await ctx.globalState.update(PUBLIC_STATE_KEY, existing);
		await ctx.secrets.store(PRIVATE_SECRET_KEY, keys.privateKey);
	}
	const displayName = String(existing.displayName || '').trim() || defaultDisplayName();

	// Encryption keypair. Older identities lack it, so mint one once and patch.
	let encKey = existing.encKey ? String(existing.encKey) : '';
	let encPriv = await ctx.secrets.get(ENC_PRIVATE_SECRET_KEY);
	if (!encKey || !encPriv) {
		const encKeys = generateEncryptionKeypair();
		encKey = encKeys.publicKey;
		encPriv = encKeys.privateKey;
		await ctx.globalState.update(PUBLIC_STATE_KEY, { ...existing, encKey });
		await ctx.secrets.store(ENC_PRIVATE_SECRET_KEY, encPriv);
	}

	if (!String(existing.displayName || '').trim()) {
		await ctx.globalState.update(PUBLIC_STATE_KEY, { ...existing, encKey, displayName });
	}
	return {
		peerId: String(existing.peerId),
		displayName,
		publicKey: String(existing.publicKey),
		encKey,
		githubId: existing.githubId ? String(existing.githubId) : '',
		githubLogin: existing.githubLogin ? String(existing.githubLogin) : ''
	};
}

/**
 * @param {string} name
 */
async function setPeerDisplayName(name) {
	const rec = await ensurePeerIdentity();
	// No spaces: a name with spaces would break `@`/`#` mention matching, so collapse
	// whitespace into a dash (e.g. "John Doe" -> "John-Doe").
	const cleaned = String(name || '').trim().replace(/\s+/g, '-');
	const next = { ...rec, displayName: cleaned || rec.displayName };
	await requireContext().globalState.update(PUBLIC_STATE_KEY, next);
	return next;
}

/**
 * Persist extra public fields (GitHub id/login) on the local peer.
 * @param {Record<string, string>} patch
 */
async function patchPeerPublicRecord(patch) {
	const rec = await ensurePeerIdentity();
	const next = { ...rec, ...(patch || {}) };
	await requireContext().globalState.update(PUBLIC_STATE_KEY, next);
	return next;
}

/**
 * @returns {Promise<string>}
 */
async function getPrivateKey() {
	const ctx = requireContext();
	await ensurePeerIdentity();
	const priv = await ctx.secrets.get(PRIVATE_SECRET_KEY);
	if (!priv) throw new Error('Peer private key is missing. Import your identity file.');
	return priv;
}

/**
 * @returns {Promise<string>}
 */
async function getEncryptionPrivateKey() {
	const ctx = requireContext();
	await ensurePeerIdentity();
	const priv = await ctx.secrets.get(ENC_PRIVATE_SECRET_KEY);
	if (!priv) throw new Error('Peer encryption private key is missing. Import your identity file.');
	return priv;
}

/**
 * @param {object} payload
 * @returns {Promise<{ payload: object, signature: string, author: string }>}
 */
async function signPayload(payload) {
	const rec = await ensurePeerIdentity();
	const body = canonicalJson(payload);
	const signature = signText(await getPrivateKey(), body);
	return { payload, signature, author: rec.peerId };
}

/**
 * @param {object} payload
 * @param {string} signature
 * @param {string} publicKey
 * @returns {boolean}
 */
function verifyPayload(payload, signature, publicKey) {
	return verifyText(publicKey, canonicalJson(payload), signature);
}

function canonicalJson(value) {
	return JSON.stringify(value);
}

/**
 * Export the full identity (including the private key) as a portable file payload.
 * Keep this file private — it is the person.
 */
async function exportPeerIdentity() {
	const rec = await ensurePeerIdentity();
	return {
		format: 'drip-peer-identity',
		version: 2,
		peerId: rec.peerId,
		displayName: rec.displayName,
		publicKey: rec.publicKey,
		encKey: rec.encKey,
		privateKey: await getPrivateKey(),
		encPrivateKey: await getEncryptionPrivateKey()
	};
}

/**
 * Replace this machine's identity with an exported one (second computer).
 * @param {object} raw
 */
async function importPeerIdentity(raw) {
	if (
		!raw ||
		raw.format !== 'drip-peer-identity' ||
		!raw.peerId ||
		!raw.publicKey ||
		!raw.privateKey ||
		!raw.encKey ||
		!raw.encPrivateKey
	) {
		throw new Error('That file is not a valid DRIP identity.');
	}
	const rec = {
		peerId: String(raw.peerId),
		displayName: String(raw.displayName || defaultDisplayName()),
		publicKey: String(raw.publicKey),
		encKey: String(raw.encKey)
	};
	const ctx = requireContext();
	await ctx.globalState.update(PUBLIC_STATE_KEY, rec);
	await ctx.secrets.store(PRIVATE_SECRET_KEY, String(raw.privateKey));
	await ctx.secrets.store(ENC_PRIVATE_SECRET_KEY, String(raw.encPrivateKey));
	return rec;
}

module.exports = {
	bindPeerIdentityContext,
	getPeerExtensionContext,
	ensurePeerIdentity,
	readPublicRecord,
	setPeerDisplayName,
	patchPeerPublicRecord,
	getPrivateKey,
	getEncryptionPrivateKey,
	signPayload,
	verifyPayload,
	signText,
	verifyText,
	exportPeerIdentity,
	importPeerIdentity
};
