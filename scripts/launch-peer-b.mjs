// Starts a second VS Code (Code.exe) that is a different DRIP person.
// Never uses Cursor, never uses the `code` PATH shim (Cursor often steals that name).
// The child env is stripped of the debug bootloader so a new window can actually open.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(root, '.drip-test');
const userDataDir = path.join(testRoot, 'peer-b-vscode-user-data');
const extensionsDir = path.join(testRoot, 'peer-b-vscode-extensions');
const windowDir = path.join(testRoot, 'peer-b-window');
const kbBDir = path.join(testRoot, 'kb-peer-b.driplock');
const kbADir = path.join(testRoot, 'kb-peer-a.driplock');

for (const dir of [userDataDir, extensionsDir, windowDir, kbBDir, kbADir]) {
	fs.mkdirSync(dir, { recursive: true });
}

const editor = resolveCodeExe();
const args = [
	windowDir,
	'--new-window',
	`--user-data-dir=${userDataDir}`,
	`--extensions-dir=${extensionsDir}`,
	`--extensionDevelopmentPath=${root}`,
	'--disable-workspace-trust',
	'--skip-welcome',
	'--skip-release-notes'
];

const childEnv = { ...process.env };
delete childEnv.NODE_OPTIONS;
delete childEnv.VSCODE_INSPECTOR_OPTIONS;
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.ELECTRON_NO_ASAR;
delete childEnv.VSCODE_DEV;
delete childEnv.VSCODE_CWD;

console.log(`Peer B editor: ${editor}`);
console.log(`Peer B profile: ${userDataDir}`);
console.log(`Peer B knowledge base (pick this in DRIP): ${kbBDir}`);
console.log(`Peer A knowledge base (pick this in the F5 window): ${kbADir}`);
console.log('Peer B must stay a guest — do not sign in with the same GitHub as Peer A.');

const child = spawn(editor, args, {
	detached: true,
	stdio: 'ignore',
	shell: false,
	windowsHide: false,
	env: childEnv
});

child.on('error', (err) => {
	console.error(`Failed to start VS Code: ${err.message}`);
	process.exitCode = 1;
});

if (child.pid) {
	console.log(`Started Peer B (pid ${child.pid}). A new VS Code window titled Extension Development Host should appear.`);
	child.unref();
} else {
	console.error('VS Code did not start. Set VSCODE_EXE to your Code.exe path and try again.');
	process.exitCode = 1;
}

function resolveCodeExe() {
	const fromEnv = process.env.VSCODE_EXE && fs.existsSync(process.env.VSCODE_EXE) ? process.env.VSCODE_EXE : '';
	if (fromEnv) {
		if (/cursor/i.test(fromEnv)) {
			throw new Error('VSCODE_EXE points at Cursor. Set it to Code.exe instead.');
		}
		return fromEnv;
	}

	const home = os.homedir();
	const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
	const guessed = [
		path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
		path.join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
		'C:\\Program Files\\Microsoft VS Code\\Code.exe',
		'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe',
		'/usr/share/code/code',
		'/usr/bin/code',
		'/Applications/Visual Studio Code.app/Contents/MacOS/Electron'
	].find((c) => c && fs.existsSync(c) && !/cursor/i.test(c));

	if (guessed) return guessed;

	throw new Error(
		'Could not find Code.exe. Install VS Code, or set VSCODE_EXE to the Code.exe path (not Cursor).'
	);
}
