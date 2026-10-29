'use strict';

/**
 * Headless proof that one issue create travels from folder A to folder B.
 * No editor, no MQTT — localhost LAN only.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DRIP_SKIP_INTERNET_SYNC = '1';

const Module = require('module');
const mock = require('./mockVscode');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return mock;
	return originalLoad.call(this, request, parent, isMain);
};

const { bindPeerIdentityContext, ensurePeerIdentity } = require('../peerIdentity');
const { writeProjectRecord, emptyProjectRecord } = require('../projectSidecar');
const { applyOperation } = require('../projectOpApply');
const { createOperation, OP_TYPES } = require('../projectOp');
const { recordLocalOperation } = require('../projectRecord');
const {
	startLanListener,
	rememberLanPeer,
	publishLanOps,
	stopAllLanListeners,
	lanPortFor
} = require('../projectLanSync');

const ISSUES = `@f0
# issues

# _inbox
`;

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function makeMember(me) {
	return {
		peerId: me.peerId,
		displayName: me.displayName,
		publicKey: me.publicKey,
		role: 'admin',
		joinedAt: new Date().toString()
	};
}

async function writeSharedProject(folderUri, rec) {
	await mock.workspace.fs.createDirectory(folderUri);
	await writeProjectRecord(folderUri, rec);
	await mock.workspace.fs.writeFile(
		mock.Uri.joinPath(folderUri, '_issues.d.txt'),
		Buffer.from(ISSUES, 'utf8')
	);
}

describe('peer sync — create issue A → B', () => {
	/** @type {string} */
	let tmp;
	/** @type {import('vscode').Uri} */
	let kbA;
	/** @type {import('vscode').Uri} */
	let kbB;
	/** @type {string} */
	let projectId;
	const prefixA = 'Demo.p/';
	const prefixB = 'Demo.p/';

	before(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drip-peer-sync-'));
		kbA = mock.Uri.file(path.join(tmp, 'kb-a'));
		kbB = mock.Uri.file(path.join(tmp, 'kb-b'));
		bindPeerIdentityContext(mock.makeContext());
		const me = await ensurePeerIdentity();
		projectId = 'proj_selftest_1';
		const rec = {
			...emptyProjectRecord(),
			projectId,
			shared: true,
			name: 'Demo',
			createdAt: new Date().toISOString(),
			inviteCapability: 'cap_selftest_1',
			members: [makeMember(me)]
		};
		await writeSharedProject(mock.Uri.joinPath(kbA, 'Demo.p'), rec);
		await writeSharedProject(mock.Uri.joinPath(kbB, 'Demo.p'), rec);
	});

	after(() => {
		stopAllLanListeners();
		try {
			fs.rmSync(tmp, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it('applies a create operation onto the other folder', async () => {
		const op = await createOperation({
			projectId,
			type: OP_TYPES.ISSUE_CREATE,
			payload: { uid: 'uid_apply_1', issueKey: 'i-1', title: 'From apply test' },
			seq: 1
		});
		const result = await applyOperation(kbB, prefixB, op);
		assert.equal(
			result.ok,
			true,
			`apply failed: ${result.reason || ''} ${result.error || JSON.stringify(result)}`
		);
		const text = Buffer.from(
			await mock.workspace.fs.readFile(mock.Uri.joinPath(kbB, 'Demo.p', '_issues.d.txt'))
		).toString('utf8');
		assert.match(text, /From apply test/);
		assert.match(text, /i-1/i);
	});

	it('pushes a create over localhost LAN to the other listener', async () => {
		// One process = one listener map per project id. B listens; A only pushes.
		const lanB = await startLanListener(kbB, prefixB);
		assert.ok(lanB && lanB.port, 'peer B must listen');
		rememberLanPeer(projectId, '127.0.0.1', lanB.port);

		const op = await createOperation({
			projectId,
			type: OP_TYPES.ISSUE_CREATE,
			payload: { uid: 'uid_lan_2', issueKey: 'i-2', title: 'From LAN test' },
			seq: 2
		});
		const onA = await applyOperation(kbA, prefixA, op);
		assert.equal(onA.ok, true, `A apply failed: ${onA.reason || onA.error || ''}`);

		await publishLanOps(kbA, prefixA, [op]);
		await sleep(400);

		const textB = Buffer.from(
			await mock.workspace.fs.readFile(mock.Uri.joinPath(kbB, 'Demo.p', '_issues.d.txt'))
		).toString('utf8');
		assert.match(textB, /From LAN test/);
		assert.ok(lanPortFor(projectId) > 0);
	});

	it('records a local create and the other folder receives it', async () => {
		const op = await recordLocalOperation(kbA, prefixA, OP_TYPES.ISSUE_CREATE, {
			uid: 'uid_record_3',
			issueKey: 'i-3',
			title: 'From record test'
		});
		assert.ok(op && op.opId, 'recordLocalOperation must return an op');
		await sleep(400);
		const textB = Buffer.from(
			await mock.workspace.fs.readFile(mock.Uri.joinPath(kbB, 'Demo.p', '_issues.d.txt'))
		).toString('utf8');
		assert.match(textB, /From record test/);
	});

	it('assigns an issue to a feature on the other folder', async () => {
		const featureInbox = `@f1
# inbox

# _inbox
`;
		for (const kb of [kbA, kbB]) {
			const featureUri = mock.Uri.joinPath(kb, 'Demo.p', 'Login.f');
			await mock.workspace.fs.createDirectory(featureUri);
			await mock.workspace.fs.writeFile(
				mock.Uri.joinPath(featureUri, '_inbox.d.txt'),
				Buffer.from(featureInbox, 'utf8')
			);
		}
		const create = await createOperation({
			projectId,
			type: OP_TYPES.ISSUE_CREATE,
			payload: { uid: 'uid_move_9', issueKey: 'i-9', title: 'Assign me' },
			seq: 9
		});
		assert.equal((await applyOperation(kbA, prefixA, create)).ok, true);
		await publishLanOps(kbA, prefixA, [create]);
		await sleep(400);

		const move = await createOperation({
			projectId,
			type: OP_TYPES.ISSUE_MOVE,
			payload: {
				uid: 'uid_move_9',
				issueKey: 'i-9',
				target: { kind: 'feature', rel: 'Login.f' }
			},
			seq: 10
		});
		const movedA = await applyOperation(kbA, prefixA, move);
		assert.equal(movedA.ok, true, `A move failed: ${movedA.reason || movedA.error || ''}`);
		await publishLanOps(kbA, prefixA, [move]);
		await sleep(500);

		const inboxB = Buffer.from(
			await mock.workspace.fs.readFile(mock.Uri.joinPath(kbB, 'Demo.p', 'Login.f', '_inbox.d.txt'))
		).toString('utf8');
		assert.match(inboxB, /Assign me/);
	});

	it('creates an issue in the same feature file on the other folder', async () => {
		const featNote = `@f2
# feat-3

# _inbox
`;
		for (const kb of [kbA, kbB]) {
			await mock.workspace.fs.writeFile(
				mock.Uri.joinPath(kb, 'Demo.p', 'feat-3.f.d.txt'),
				Buffer.from(featNote, 'utf8')
			);
		}
		const create = await createOperation({
			projectId,
			type: OP_TYPES.ISSUE_CREATE,
			payload: {
				uid: 'uid_feat_11',
				issueKey: 'i-11',
				title: 'Lives in feat-3',
				rel: 'feat-3.f.d.txt'
			},
			seq: 11
		});
		assert.equal((await applyOperation(kbA, prefixA, create)).ok, true);
		await publishLanOps(kbA, prefixA, [create]);
		await sleep(400);

		const featB = Buffer.from(
			await mock.workspace.fs.readFile(mock.Uri.joinPath(kbB, 'Demo.p', 'feat-3.f.d.txt'))
		).toString('utf8');
		const inboxB = Buffer.from(
			await mock.workspace.fs.readFile(mock.Uri.joinPath(kbB, 'Demo.p', '_issues.d.txt'))
		).toString('utf8');
		assert.match(featB, /Lives in feat-3/);
		assert.doesNotMatch(inboxB, /Lives in feat-3/);
	});
});
