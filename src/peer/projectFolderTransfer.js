'use strict';

/**
 * Copy a whole project folder (notes + .drip sidecar) in or out of `.drip.project`.
 */

const fs = require('fs/promises');
const path = require('path');
const vscode = require('vscode');
const { isDripProjectFolderName, PROJECT_FOLDER_EXT } = require('../document/model/dripNoteProjectFolder.js');
const { ensureProjectsHome, projectPrefixUnderHome } = require('../startup/projectsDrip');
const { resolveCopiedProject, memberOf } = require('./projectSharing');
const { readProjectRecord } = require('./projectSidecar');
const { ensurePeerIdentity } = require('./peerIdentity');

/**
 * @param {import('vscode').Uri} src
 * @param {import('vscode').Uri} dest
 */
async function copyFolderRecursive(src, dest) {
	await vscode.workspace.fs.createDirectory(dest);
	const entries = await vscode.workspace.fs.readDirectory(src);
	for (const [name, type] of entries) {
		const from = vscode.Uri.joinPath(src, name);
		const to = vscode.Uri.joinPath(dest, name);
		if (type === vscode.FileType.Directory) {
			await copyFolderRecursive(from, to);
		} else if (type === vscode.FileType.File) {
			await vscode.workspace.fs.writeFile(to, await vscode.workspace.fs.readFile(from));
		}
	}
}

/**
 * Empty `_concepts` / `_decisions` / `_archive` must exist after a copy or join.
 * Snapshot lists files only, so those folders can be missing until we recreate them.
 * @param {import('vscode').Uri} destUri
 */
async function ensureCopiedProjectFolders(destUri) {
	if (!destUri) return;
	try {
		await require('../startup/dripProjectFolder').ensureProjectSpecialFolders(destUri);
	} catch {
		/* folder may not be a .p yet */
	}
}

/**
 * @param {import('vscode').Uri} folderUri
 * @returns {Promise<{ path: string, data: string }[]>}
 */
async function collectFolderFiles(folderUri, prefix) {
	const rel = String(prefix || '');
	const out = [];
	const dirPath = folderUri && folderUri.fsPath;
	if (!dirPath) return out;
	let names;
	try {
		names = await fs.readdir(dirPath, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const ent of names) {
		const childRel = rel ? `${rel}/${ent.name}` : ent.name;
		const childPath = path.join(dirPath, ent.name);
		if (ent.isDirectory()) {
			const kids = await collectFolderFiles(vscode.Uri.file(childPath), childRel);
			if (kids.length) out.push(...kids);
			else out.push({ path: `${childRel.replace(/\\/g, '/')}/`, data: '', dir: true });
		} else if (ent.isFile()) {
			const buf = await fs.readFile(childPath);
			out.push({ path: childRel, data: Buffer.from(buf).toString('base64') });
		}
	}
	return out;
}

/**
 * @param {import('vscode').Uri} destUri
 * @param {{ path: string, data: string }[]} files
 */
/**
 * Update an existing shared folder without deleting it. Open notes are replaced
 * in the editor so the host does not ask to overwrite a newer file on disk.
 * @param {import('vscode').Uri} destUri
 * @param {{ path: string, data: string }[]} files
 */
async function writeFolderFilesInPlace(destUri, files) {
	const { replaceOpenNoteOrWriteDisk, findOpenTextDocument } = require('../state/documentFileOps');
	await vscode.workspace.fs.createDirectory(destUri);
	for (const f of files || []) {
		const parts = String(f.path || '')
			.replace(/\\/g, '/')
			.split('/')
			.filter(Boolean);
		if (!parts.length || parts.some(p => p === '..')) continue;
		const fileUri = vscode.Uri.joinPath(destUri, ...parts);
		if (f.dir || String(f.path || '').endsWith('/')) {
			await vscode.workspace.fs.createDirectory(fileUri);
			continue;
		}
		if (parts.length > 1) {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(destUri, ...parts.slice(0, -1)));
		}
		const raw = Buffer.from(String(f.data || ''), 'base64');
		const name = String(parts[parts.length - 1] || '').toLowerCase();
		if (name.endsWith('.d.txt') || name.endsWith('.d.md')) {
			const open = findOpenTextDocument(fileUri);
			if (open && open.isDirty) continue;
			await replaceOpenNoteOrWriteDisk(fileUri, raw.toString('utf8'));
		} else {
			await vscode.workspace.fs.writeFile(fileUri, raw);
		}
	}
}

async function writeFolderFiles(destUri, files) {
	await vscode.workspace.fs.createDirectory(destUri);
	for (const f of files || []) {
		const parts = String(f.path || '')
			.replace(/\\/g, '/')
			.split('/')
			.filter(Boolean);
		if (!parts.length) continue;
		const fileUri = vscode.Uri.joinPath(destUri, ...parts);
		if (f.dir || String(f.path || '').endsWith('/')) {
			await vscode.workspace.fs.createDirectory(fileUri);
			continue;
		}
		const parent = vscode.Uri.joinPath(destUri, ...parts.slice(0, -1));
		if (parts.length > 1) await vscode.workspace.fs.createDirectory(parent);
		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(String(f.data || ''), 'base64'));
	}
}

/**
 * Write the snapshot into place only after it is complete, replacing a leftover empty stub.
 * @param {import('vscode').Uri} destUri
 * @param {{ path: string, data: string }[]} files
 */
async function writeFolderFilesAtomic(destUri, files) {
	const destPath = destUri.fsPath;
	const tmpPath = `${String(destPath || '').replace(/[\\/]+$/, '')}.__drip_incoming`;
	const tmpUri = vscode.Uri.file(tmpPath);
	try {
		await fs.rm(tmpPath, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	const { pauseProjectFolderEnsure, resumeProjectFolderEnsure } = require('../startup/dripProjectFolder');
	pauseProjectFolderEnsure();
	try {
		await writeFolderFiles(tmpUri, files);
		await fs.access(path.join(tmpPath, '.drip', 'project.json'));
		try {
			await fs.rm(destPath, { recursive: true, force: true });
		} catch {
			/* first join */
		}
		await fs.rename(tmpPath, destPath);
		await ensureCopiedProjectFolders(destUri);
	} finally {
		try {
			await fs.rm(tmpPath, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		resumeProjectFolderEnsure();
	}
}

/**
 * Reuse the invite's folder name so a leftover empty stub is replaced, not kept beside the real copy.
 * @param {import('vscode').Uri} home
 * @param {{ projectId?: string, name?: string }} invite
 */
async function destUriForJoin(home, invite) {
	const destName = isDripProjectFolderName(invite.name || 'project')
		? String(invite.name)
		: `${invite.name || 'project'}${PROJECT_FOLDER_EXT}`;
	const dest = vscode.Uri.joinPath(home, destName);
	try {
		const rec = await readProjectRecord(dest);
		if (rec && rec.projectId && rec.projectId !== String(invite.projectId || '')) {
			const entries = await vscode.workspace.fs.readDirectory(home);
			const taken = new Set(entries.map(([n]) => String(n).toLowerCase()));
			const other = uniqueProjectFolderName(destName, taken);
			return { dest: vscode.Uri.joinPath(home, other), destName: other };
		}
	} catch {
		/* no sidecar — overwrite the stub */
	}
	return { dest, destName };
}

function uniqueProjectFolderName(baseName, taken) {
	let name = isDripProjectFolderName(baseName) ? baseName : `${baseName}${PROJECT_FOLDER_EXT}`;
	if (!taken.has(name.toLowerCase())) return name;
	const stem = name.replace(/\.p$/i, '') || 'project';
	let n = 2;
	while (taken.has(`${stem}-${n}.p`.toLowerCase())) n += 1;
	return `${stem}-${n}.p`;
}

/**
 * Export the whole `.p` folder to a parent folder the user picks.
 * @param {import('vscode').Uri} projectFolderUri
 */
async function exportProjectFolder(projectFolderUri) {
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: 'Export project here'
	});
	if (!picked || !picked[0]) return undefined;
	const folderName = path.basename(projectFolderUri.fsPath);
	const dest = vscode.Uri.joinPath(picked[0], folderName);
	try {
		await vscode.workspace.fs.stat(dest);
		void vscode.window.showWarningMessage(`A folder named ${folderName} already exists there.`);
		return undefined;
	} catch {
		/* free */
	}
	await copyFolderRecursive(projectFolderUri, dest);
	await ensureCopiedProjectFolders(dest);
	void vscode.window.showInformationMessage(`Project exported to ${dest.fsPath}.`);
	return dest;
}

/**
 * Import a `.p` folder (or any folder that looks like one) into `.drip.project`.
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} [sourceUri]
 */
async function importProjectFolder(kbRootUri, sourceUri) {
	let src = sourceUri;
	if (!src) {
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Import this project folder'
		});
		if (!picked || !picked[0]) return undefined;
		src = picked[0];
	}
	const home = await ensureProjectsHome(kbRootUri);
	const entries = await vscode.workspace.fs.readDirectory(home);
	const taken = new Set(entries.map(([n]) => String(n).toLowerCase()));
	const destName = uniqueProjectFolderName(path.basename(src.fsPath), taken);
	const dest = vscode.Uri.joinPath(home, destName);
	await copyFolderRecursive(src, dest);
	await ensureCopiedProjectFolders(dest);
	const prefix = projectPrefixUnderHome(destName);
	try {
		const rec = await readProjectRecord(dest);
		if (rec && rec.shared) {
			const me = await ensurePeerIdentity();
			await resolveCopiedProject(kbRootUri, prefix, memberOf(rec, me.peerId) ? 'rejoin' : 'solo-copy');
		}
	} catch {
		/* solo folder without sidecar is fine */
	}
	void vscode.window.showInformationMessage(`Project imported as ${destName}.`);
	return { folderUri: dest, folderPrefix: prefix };
}

/**
 * Catch-up: replace this machine's project folder with the other person's current files.
 * Used when old changelog lines were folded away.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {{ path: string, data: string }[]} files
 */
async function applyIncomingSnapshot(kbRootUri, folderPrefix, files) {
	if (!kbRootUri || !folderPrefix || !Array.isArray(files) || !files.length) return;
	const { projectFolderUriFromPrefix } = require('./projectSidecar');
	const dest = projectFolderUriFromPrefix(kbRootUri, folderPrefix);
	await writeFolderFilesInPlace(dest, files);
	await ensureCopiedProjectFolders(dest);
	try {
		const { ensureJoinedProjectInIndex } = require('../indexing/projectIndex');
		await ensureJoinedProjectInIndex(kbRootUri, dest, '');
	} catch {
		/* index catch-up is best-effort */
	}
	try {
		await require('./projectInternetSync').notifySharedProjectChanged(kbRootUri, folderPrefix);
	} catch {
		/* Project View may be closed */
	}
}

module.exports = {
	copyFolderRecursive,
	collectFolderFiles,
	writeFolderFiles,
	exportProjectFolder,
	importProjectFolder,
	uniqueProjectFolderName,
	writeFolderFilesAtomic,
	destUriForJoin,
	applyIncomingSnapshot
};
