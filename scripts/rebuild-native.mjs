/**
 * Rebuild better-sqlite3 against VS Code's Electron ABI for local development.
 *
 * The Electron version is resolved in order:
 *   1. CLI arg             → node scripts/rebuild-native.mjs 43.7.7
 *   2. ELECTRON_VERSION    env var
 *   3. `.electron-version` file at the repo root (single source of truth)
 *
 * This mirrors the publish workflow, so `.electron-version` is the one place
 * to change the target Electron for both local and CI builds.
 */

import { execSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function resolveVersion() {
	if (process.argv[2]) return String(process.argv[2]).trim();
	if (process.env.ELECTRON_VERSION) return String(process.env.ELECTRON_VERSION).trim();
	const file = join(root, '.electron-version');
	if (existsSync(file)) return readFileSync(file, 'utf8').trim();
	throw new Error(
		'No Electron version found — pass it as an arg, set ELECTRON_VERSION, or create .electron-version.'
	);
}

const version = resolveVersion();
console.log(`[rebuild-native] Rebuilding better-sqlite3 for Electron ${version}…`);
execSync(`npx @electron/rebuild -v ${version} -w better-sqlite3`, {
	stdio: 'inherit',
	cwd: root
});

// Remove stale Node-ABI prebuilds so the freshly rebuilt Electron binary is used.
const prebuilds = join(root, 'node_modules', 'better-sqlite3', 'prebuilds');
if (existsSync(prebuilds)) {
	rmSync(prebuilds, { recursive: true, force: true });
	console.log('[rebuild-native] Removed stale prebuilds (Node ABI).');
}
console.log('[rebuild-native] Done. Reload the VS Code window to pick up the new binary.');
