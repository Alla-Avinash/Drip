'use strict';

/**
 * Project-local `.drip/` sidecar — membership, tags, metadata, op log, checkpoints.
 * This folder travels with the project. It is not part of the knowledge-base index.
 */

const vscode = require('vscode');
const path = require('path');
const { isDripProjectFolderName } = require('../document/model/dripNoteProjectFolder.js');

const SIDECAR_DIR = '.drip';
const PROJECT_FILE = 'project.json';
const TAGS_FILE = 'tags.json';
const METADATA_FILE = 'metadata.json';
const OPS_FILE = 'ops.jsonl';
const SYNC_FILE = 'sync.json';

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @returns {import('vscode').Uri}
 */
function projectFolderUriFromPrefix(kbRootUri, folderPrefix) {
	const parts = String(folderPrefix || '')
		.replace(/\\/g, '/')
		.replace(/\/+$/, '')
		.split('/')
		.filter(Boolean);
	return parts.length ? vscode.Uri.joinPath(kbRootUri, ...parts) : kbRootUri;
}

/**
 * @param {string} kbRootFs
 * @param {string} fsPath
 * @returns {string} e.g. `App.p/`
 */
function projectFolderPrefixForPath(kbRootFs, fsPath) {
	const root = path.normalize(String(kbRootFs || ''));
	const file = path.normalize(String(fsPath || ''));
	if (!root || !file) return '';
	const rel = path.relative(root, file).replace(/\\/g, '/');
	if (!rel || rel.startsWith('..')) return '';
	const parts = rel.split('/').filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		if (isDripProjectFolderName(parts[i])) {
			return parts.slice(0, i + 1).join('/') + '/';
		}
	}
	return '';
}

/**
 * @param {import('vscode').Uri} projectFolderUri
 * @returns {import('vscode').Uri}
 */
function sidecarDirUri(projectFolderUri) {
	return vscode.Uri.joinPath(projectFolderUri, SIDECAR_DIR);
}

function sidecarFileUri(projectFolderUri, name) {
	return vscode.Uri.joinPath(sidecarDirUri(projectFolderUri), name);
}

async function ensureSidecarDir(projectFolderUri) {
	await vscode.workspace.fs.createDirectory(sidecarDirUri(projectFolderUri));
}

async function readJsonFile(uri, fallback) {
	try {
		const buf = await vscode.workspace.fs.readFile(uri);
		const parsed = JSON.parse(Buffer.from(buf).toString('utf8'));
		return parsed && typeof parsed === 'object' ? parsed : fallback;
	} catch {
		return fallback;
	}
}

async function writeJsonFile(uri, value) {
	await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
}

function emptyProjectRecord() {
	return {
		format: 'drip-project',
		version: 1,
		projectId: '',
		shared: false,
		name: '',
		createdAt: '',
		inviteCapability: '',
		accessCapabilities: { member: '', updater: '', admin: '' },
		ownerGithubId: '',
		ownerGithubLogin: '',
		members: [],
		pendingJoiners: [],
		highWater: { issue: 0, feature: 0, concept: 0, decision: 0, file: -1 },
		mailboxRepo: '',
		allowGuests: true,
		blocked: { githubIds: [], guestNames: [] },
		teams: [],
		defaultTeamId: ''
	};
}

/**
 * @param {import('vscode').Uri} projectFolderUri
 */
async function readProjectRecord(projectFolderUri) {
	const raw = await readJsonFile(sidecarFileUri(projectFolderUri, PROJECT_FILE), null);
	if (!raw || raw.format !== 'drip-project') return null;
	const base = emptyProjectRecord();
	const next = {
		...base,
		...raw,
		members: Array.isArray(raw.members) ? raw.members : [],
		pendingJoiners: Array.isArray(raw.pendingJoiners) ? raw.pendingJoiners : [],
		highWater: { ...base.highWater, ...(raw.highWater || {}) },
		allowGuests: raw.allowGuests !== false,
		blocked: {
			githubIds: Array.isArray(raw.blocked && raw.blocked.githubIds) ? raw.blocked.githubIds.map(String) : [],
			guestNames: Array.isArray(raw.blocked && raw.blocked.guestNames)
				? raw.blocked.guestNames.map(s => String(s || '').trim().toLowerCase()).filter(Boolean)
				: []
		},
		teams: Array.isArray(raw.teams) ? raw.teams : [],
		defaultTeamId: String(raw.defaultTeamId || ''),
		accessCapabilities: {
			member: String((raw.accessCapabilities && raw.accessCapabilities.member) || ''),
			updater: String((raw.accessCapabilities && raw.accessCapabilities.updater) || ''),
			admin: String((raw.accessCapabilities && raw.accessCapabilities.admin) || '')
		}
	};
	try {
		require('./projectTeams').normalizeTeamsOnRecord(next);
	} catch {
		/* teams helper is optional on first load */
	}
	return next;
}

/**
 * @param {import('vscode').Uri} projectFolderUri
 * @param {ReturnType<typeof emptyProjectRecord>} record
 */
async function writeProjectRecord(projectFolderUri, record) {
	await ensureSidecarDir(projectFolderUri);
	const next = {
		...emptyProjectRecord(),
		...record,
		format: 'drip-project',
		version: 1,
		savedAt: new Date().toISOString()
	};
	if (next.shared) {
		try {
			require('./projectTeams').normalizeTeamsOnRecord(next);
		} catch {
			/* teams helper is optional on first load */
		}
	}
	await writeJsonFile(sidecarFileUri(projectFolderUri, PROJECT_FILE), next);
	return next;
}

async function isProjectShared(projectFolderUri) {
	const rec = await readProjectRecord(projectFolderUri);
	return !!(rec && rec.shared && rec.projectId);
}

async function readTagsFile(projectFolderUri) {
	return readJsonFile(sidecarFileUri(projectFolderUri, TAGS_FILE), null);
}

async function writeTagsFile(projectFolderUri, graph) {
	await ensureSidecarDir(projectFolderUri);
	await writeJsonFile(sidecarFileUri(projectFolderUri, TAGS_FILE), graph);
}

async function readMetadataFile(projectFolderUri) {
	return readJsonFile(sidecarFileUri(projectFolderUri, METADATA_FILE), null);
}

async function writeMetadataFile(projectFolderUri, overrides) {
	await ensureSidecarDir(projectFolderUri);
	await writeJsonFile(sidecarFileUri(projectFolderUri, METADATA_FILE), {
		format: 'drip-project-metadata',
		version: 1,
		savedAt: new Date().toISOString(),
		overrides: overrides || {}
	});
}

function emptySyncState() {
	return {
		format: 'drip-project-sync',
		version: 1,
		vector: {},
		appliedOpIds: [],
		notices: [],
		lanPeers: [],
		lanPort: 0,
		compactedVector: {},
		lastCompactAt: '',
		lastMailboxPushVector: '',
		lastMailboxPullAt: '',
		lastMailboxPushAt: '',
		mailboxSha: ''
	};
}

async function readSyncState(projectFolderUri) {
	const raw = await readJsonFile(sidecarFileUri(projectFolderUri, SYNC_FILE), null);
	if (!raw) return emptySyncState();
	return {
		...emptySyncState(),
		...raw,
		vector: raw.vector && typeof raw.vector === 'object' ? raw.vector : {},
		appliedOpIds: Array.isArray(raw.appliedOpIds) ? raw.appliedOpIds : [],
		notices: Array.isArray(raw.notices) ? raw.notices : [],
		lanPeers: Array.isArray(raw.lanPeers) ? raw.lanPeers : [],
		lanPort: Number(raw.lanPort) || 0,
		compactedVector: raw.compactedVector && typeof raw.compactedVector === 'object' ? raw.compactedVector : {},
		lastCompactAt: raw.lastCompactAt ? String(raw.lastCompactAt) : ''
	};
}

async function writeSyncState(projectFolderUri, state) {
	await ensureSidecarDir(projectFolderUri);
	await writeJsonFile(sidecarFileUri(projectFolderUri, SYNC_FILE), {
		...emptySyncState(),
		...state,
		format: 'drip-project-sync',
		version: 1,
		savedAt: new Date().toISOString()
	});
}

async function readOpsJsonl(projectFolderUri) {
	try {
		const buf = await vscode.workspace.fs.readFile(sidecarFileUri(projectFolderUri, OPS_FILE));
		const text = Buffer.from(buf).toString('utf8');
		const out = [];
		for (const line of text.split(/\r?\n/)) {
			const t = line.trim();
			if (!t) continue;
			try {
				out.push(JSON.parse(t));
			} catch {
				/* skip a bad line */
			}
		}
		return out;
	} catch {
		return [];
	}
}

async function writeOpsJsonl(projectFolderUri, ops) {
	await ensureSidecarDir(projectFolderUri);
	const uri = sidecarFileUri(projectFolderUri, OPS_FILE);
	const lines = (Array.isArray(ops) ? ops : []).filter(op => op && op.opId).map(op => JSON.stringify(op));
	await vscode.workspace.fs.writeFile(uri, Buffer.from(lines.length ? `${lines.join('\n')}\n` : '', 'utf8'));
}

async function appendOpJsonl(projectFolderUri, op) {
	await ensureSidecarDir(projectFolderUri);
	const uri = sidecarFileUri(projectFolderUri, OPS_FILE);
	let prev = '';
	try {
		prev = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
	} catch {
		prev = '';
	}
	if (prev && !prev.endsWith('\n')) prev += '\n';
	await vscode.workspace.fs.writeFile(uri, Buffer.from(`${prev}${JSON.stringify(op)}\n`, 'utf8'));
}

module.exports = {
	SIDECAR_DIR,
	PROJECT_FILE,
	TAGS_FILE,
	METADATA_FILE,
	OPS_FILE,
	SYNC_FILE,
	projectFolderUriFromPrefix,
	projectFolderPrefixForPath,
	sidecarDirUri,
	sidecarFileUri,
	ensureSidecarDir,
	emptyProjectRecord,
	readProjectRecord,
	writeProjectRecord,
	isProjectShared,
	readTagsFile,
	writeTagsFile,
	readMetadataFile,
	writeMetadataFile,
	emptySyncState,
	readSyncState,
	writeSyncState,
	readOpsJsonl,
	writeOpsJsonl,
	appendOpJsonl
};
