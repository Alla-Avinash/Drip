'use strict';

/**
 * Signed change-bundle fallback: a file you send when a live path cannot be made.
 */

const { listOperations, readVersionVector } = require('./projectOpLog');
const { applyOperation } = require('./projectOpApply');
const { readProjectRecord, projectFolderUriFromPrefix } = require('./projectSidecar');
const { ensurePeerIdentity, signPayload, verifyPayload } = require('./peerIdentity');

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
async function exportChangeBundle(kbRootUri, folderPrefix) {
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await readProjectRecord(folderUri);
	if (!rec || !rec.shared) throw new Error('This project is not shared.');
	const me = await ensurePeerIdentity();
	const body = {
		format: 'drip-project-bundle',
		version: 1,
		projectId: rec.projectId,
		name: rec.name,
		exportedAt: new Date().toISOString(),
		exportedBy: me.peerId,
		vector: await readVersionVector(folderUri),
		members: rec.members,
		ops: await listOperations(folderUri)
	};
	const signed = await signPayload(body);
	return { ...body, signature: signed.signature };
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {object} bundle
 */
async function importChangeBundle(kbRootUri, folderPrefix, bundle) {
	if (!bundle || bundle.format !== 'drip-project-bundle') {
		throw new Error('That file is not a DRIP change bundle.');
	}
	const folderUri = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	const rec = await readProjectRecord(folderUri);
	if (!rec || rec.projectId !== bundle.projectId) {
		throw new Error('That bundle belongs to a different project.');
	}
	const author = (rec.members || []).find(m => m && m.peerId === bundle.exportedBy);
	if (author && author.publicKey) {
		const { signature, ...rest } = bundle;
		if (!verifyPayload(rest, signature, author.publicKey)) {
			throw new Error('That bundle’s signature is not valid.');
		}
	}
	let applied = 0;
	let skipped = 0;
	for (const op of bundle.ops || []) {
		const result = await applyOperation(kbRootUri, folderPrefix, op);
		if (result && result.ok && !result.skipped) applied += 1;
		else skipped += 1;
	}
	return { applied, skipped };
}

/**
 * Snapshot bundle for a new joiner: project record + ops (files are copied separately
 * when the admin sends the folder, or the guest already has a copy).
 */
async function exportSnapshotBundle(kbRootUri, folderPrefix) {
	const bundle = await exportChangeBundle(kbRootUri, folderPrefix);
	bundle.kind = 'snapshot';
	return bundle;
}

module.exports = {
	exportChangeBundle,
	importChangeBundle,
	exportSnapshotBundle
};
