'use strict';

/**
 * GitHub backup for a bound KB: init / remote / push / pull via system `git`.
 * Non-secret config lives in `.dripindex/settings.drip.json` → settings.githubBackup.
 * Optional PAT lives in ExtensionContext.secrets (never in settings JSON).
 */

const vscode = require('vscode');
const path = require('path');
const { spawn } = require('child_process');
const { getSettingsDripFileUri } = require('./initializeDripIndex');

const DEFAULT_GITHUB_BACKUP = Object.freeze({
	remoteUrl: '',
	branch: 'main',
	lastPushAt: null,
	lastPullAt: null,
	lastError: null
});

const GITIGNORE_MARK = '# DRIP GitHub backup';
const GITIGNORE_BLOCK = `${GITIGNORE_MARK}
.dripindex/
*.driplock/
.DS_Store
Thumbs.db
`;

/**
 * @param {unknown} raw
 * @returns {{ remoteUrl: string, branch: string, lastPushAt: string|null, lastPullAt: string|null, lastError: string|null }}
 */
function normalizeGithubBackup(raw) {
	const o = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
	return {
		remoteUrl: String(o.remoteUrl || '').trim(),
		branch: String(o.branch || 'main').trim() || 'main',
		lastPushAt: o.lastPushAt != null ? String(o.lastPushAt) : null,
		lastPullAt: o.lastPullAt != null ? String(o.lastPullAt) : null,
		lastError: o.lastError != null ? String(o.lastError) : null
	};
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {string}
 */
function patSecretKey(kbRootUri) {
	const fp = String(kbRootUri.fsPath || '')
		.replace(/\\/g, '/')
		.toLowerCase();
	return `drip.github.pat.${Buffer.from(fp).toString('base64url').slice(0, 48)}`;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 */
async function readSettingsEnvelope(kbRootUri) {
	const uri = getSettingsDripFileUri(kbRootUri);
	try {
		const buf = await vscode.workspace.fs.readFile(uri);
		return JSON.parse(Buffer.from(buf).toString('utf8'));
	} catch {
		return {
			format: 'drip-settings',
			version: 1,
			savedAt: new Date().toISOString(),
			settings: {}
		};
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {Record<string, unknown>} envelope
 */
async function writeSettingsEnvelope(kbRootUri, envelope) {
	const uri = getSettingsDripFileUri(kbRootUri);
	envelope.savedAt = new Date().toISOString();
	await vscode.workspace.fs.writeFile(
		uri,
		Buffer.from(JSON.stringify(envelope, null, 2), 'utf8')
	);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 */
async function getGithubBackupSettings(kbRootUri) {
	const envelope = await readSettingsEnvelope(kbRootUri);
	const settings =
		envelope && envelope.settings && typeof envelope.settings === 'object'
			? /** @type {Record<string, unknown>} */ (envelope.settings)
			: {};
	return normalizeGithubBackup(settings.githubBackup);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {Partial<ReturnType<typeof normalizeGithubBackup>>} patch
 */
async function updateGithubBackupSettings(kbRootUri, patch) {
	const envelope = await readSettingsEnvelope(kbRootUri);
	if (!envelope.settings || typeof envelope.settings !== 'object') {
		envelope.settings = {};
	}
	const settings = /** @type {Record<string, unknown>} */ (envelope.settings);
	const next = normalizeGithubBackup({
		...normalizeGithubBackup(settings.githubBackup),
		...patch
	});
	settings.githubBackup = next;
	await writeSettingsEnvelope(kbRootUri, envelope);
	return next;
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<string>}
 */
async function getStoredPat(context, kbRootUri) {
	try {
		return String((await context.secrets.get(patSecretKey(kbRootUri))) || '').trim();
	} catch {
		return '';
	}
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} pat
 */
async function setStoredPat(context, kbRootUri, pat) {
	const key = patSecretKey(kbRootUri);
	const v = String(pat || '').trim();
	if (!v) {
		await context.secrets.delete(key);
		return;
	}
	await context.secrets.store(key, v);
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').Uri} kbRootUri
 */
async function clearStoredPat(context, kbRootUri) {
	await context.secrets.delete(patSecretKey(kbRootUri));
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, input?: string }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runGit(cwd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn('git', args, {
			cwd,
			env: { ...process.env, ...(opts.env || {}), GIT_TERMINAL_PROMPT: '0' },
			windowsHide: true
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', d => {
			stdout += String(d);
		});
		child.stderr.on('data', d => {
			stderr += String(d);
		});
		child.on('error', err => {
			reject(err);
		});
		if (opts.input != null) {
			child.stdin.write(opts.input);
			child.stdin.end();
		}
		child.on('close', code => {
			resolve({ code: code == null ? 1 : code, stdout, stderr });
		});
	});
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {string} [pat]
 */
async function runGitMaybeAuth(cwd, args, pat) {
	/** @type {NodeJS.ProcessEnv} */
	const env = {};
	if (pat) {
		// Prefer asking via askpass-less URL rewrite for HTTPS remotes when PAT is set.
		env.GIT_ASKPASS = 'echo';
		env.GCM_INTERACTIVE = 'never';
	}
	return runGit(cwd, args, { env });
}

/**
 * Inject PAT into HTTPS remote URL for a single push/pull (not stored in git config).
 * @param {string} remoteUrl
 * @param {string} pat
 */
function remoteUrlWithPat(remoteUrl, pat) {
	const u = String(remoteUrl || '').trim();
	const token = String(pat || '').trim();
	if (!token || !/^https:\/\//i.test(u)) return u;
	try {
		const parsed = new URL(u);
		parsed.username = 'x-access-token';
		parsed.password = token;
		return parsed.toString();
	} catch {
		return u;
	}
}

/**
 * @returns {Promise<boolean>}
 */
async function isGitAvailable() {
	try {
		const r = await runGit(process.cwd(), ['--version']);
		return r.code === 0;
	} catch {
		return false;
	}
}

/**
 * @param {string} cwd
 */
async function isGitRepo(cwd) {
	const r = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
	return r.code === 0 && String(r.stdout).trim() === 'true';
}

/**
 * @param {import('vscode').Uri} kbRootUri
 */
async function ensureBackupGitignore(kbRootUri) {
	const uri = vscode.Uri.joinPath(kbRootUri, '.gitignore');
	let existing = '';
	try {
		existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
	} catch {
		existing = '';
	}
	if (existing.includes(GITIGNORE_MARK) || existing.includes('.dripindex/')) {
		if (!existing.includes(GITIGNORE_MARK) && existing.includes('.dripindex/')) {
			return;
		}
		if (existing.includes(GITIGNORE_MARK)) return;
	}
	const next = existing
		? existing.replace(/\s*$/, '\n\n') + GITIGNORE_BLOCK
		: GITIGNORE_BLOCK;
	await vscode.workspace.fs.writeFile(uri, Buffer.from(next, 'utf8'));
}

/**
 * @param {string} remoteUrl
 * @returns {string}
 */
function githubWebUrl(remoteUrl) {
	const u = String(remoteUrl || '').trim();
	if (!u) return '';
	const ssh = u.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
	if (ssh) return `https://github.com/${ssh[1]}/${ssh[2].replace(/\.git$/i, '')}`;
	const https = u.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
	if (https) return `https://github.com/${https[1]}/${https[2].replace(/\.git$/i, '')}`;
	return '';
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').Uri} kbRootUri
 */
async function getBackupStatus(context, kbRootUri) {
	const cfg = await getGithubBackupSettings(kbRootUri);
	const cwd = kbRootUri.fsPath;
	const gitOk = await isGitAvailable();
	let repo = false;
	let branch = cfg.branch;
	let remoteConfigured = false;
	let dirty = false;
	if (gitOk) {
		repo = await isGitRepo(cwd);
		if (repo) {
			const br = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
			if (br.code === 0 && String(br.stdout).trim()) {
				branch = String(br.stdout).trim();
			}
			const rem = await runGit(cwd, ['remote', 'get-url', 'origin']);
			remoteConfigured = rem.code === 0 && !!String(rem.stdout).trim();
			const st = await runGit(cwd, ['status', '--porcelain']);
			dirty = st.code === 0 && !!String(st.stdout).trim();
		}
	}
	const hasPat = !!(await getStoredPat(context, kbRootUri));
	const connected = !!(cfg.remoteUrl && repo && remoteConfigured);
	return {
		gitAvailable: gitOk,
		isRepo: repo,
		remoteConfigured,
		connected,
		dirty,
		hasPat,
		branch,
		remoteUrl: cfg.remoteUrl,
		webUrl: githubWebUrl(cfg.remoteUrl),
		lastPushAt: cfg.lastPushAt,
		lastPullAt: cfg.lastPullAt,
		lastError: cfg.lastError
	};
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {{ remoteUrl: string, branch?: string }} opts
 */
async function saveRemoteConfig(kbRootUri, opts) {
	const remoteUrl = String(opts.remoteUrl || '').trim();
	const branch = String(opts.branch || 'main').trim() || 'main';
	return updateGithubBackupSettings(kbRootUri, {
		remoteUrl,
		branch,
		lastError: null
	});
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').Uri} kbRootUri
 */
async function initBackupRepo(context, kbRootUri) {
	if (!(await isGitAvailable())) {
		throw new Error('Git is not installed or not on PATH. Install Git, then try again.');
	}
	const cwd = kbRootUri.fsPath;
	const cfg = await getGithubBackupSettings(kbRootUri);
	await ensureBackupGitignore(kbRootUri);

	if (!(await isGitRepo(cwd))) {
		const init = await runGit(cwd, ['init', '-b', cfg.branch || 'main']);
		if (init.code !== 0) {
			// Older git may not support -b
			const init2 = await runGit(cwd, ['init']);
			if (init2.code !== 0) {
				throw new Error(init2.stderr || init.stderr || 'git init failed');
			}
			await runGit(cwd, ['checkout', '-b', cfg.branch || 'main']);
		}
	}

	if (cfg.remoteUrl) {
		const existing = await runGit(cwd, ['remote', 'get-url', 'origin']);
		if (existing.code === 0) {
			await runGit(cwd, ['remote', 'set-url', 'origin', cfg.remoteUrl]);
		} else {
			const add = await runGit(cwd, ['remote', 'add', 'origin', cfg.remoteUrl]);
			if (add.code !== 0) {
				throw new Error(add.stderr || 'Failed to set origin remote');
			}
		}
	}

	await runGit(cwd, ['add', '-A']);
	const status = await runGit(cwd, ['status', '--porcelain']);
	if (String(status.stdout).trim()) {
		const commit = await runGit(cwd, [
			'commit',
			'-m',
			'DRIP: initial knowledge base backup'
		]);
		if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
			// Allow empty identity failure with clearer message
			if (/author|user\.email|user\.name/i.test(commit.stderr)) {
				throw new Error(
					'Git user.name / user.email are not configured. Set them globally, then retry.'
				);
			}
			throw new Error(commit.stderr || 'git commit failed');
		}
	}

	await updateGithubBackupSettings(kbRootUri, { lastError: null });
	return getBackupStatus(context, kbRootUri);
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').Uri} kbRootUri
 * @param {{ message?: string }} [opts]
 */
async function pushBackup(context, kbRootUri, opts = {}) {
	if (!(await isGitAvailable())) {
		throw new Error('Git is not installed or not on PATH.');
	}
	const cwd = kbRootUri.fsPath;
	const cfg = await getGithubBackupSettings(kbRootUri);
	if (!cfg.remoteUrl) {
		throw new Error('Set a GitHub remote URL in Settings → GitHub backup first.');
	}
	if (!(await isGitRepo(cwd))) {
		await initBackupRepo(context, kbRootUri);
	}
	await ensureBackupGitignore(kbRootUri);

	const existing = await runGit(cwd, ['remote', 'get-url', 'origin']);
	if (existing.code !== 0) {
		await runGit(cwd, ['remote', 'add', 'origin', cfg.remoteUrl]);
	} else if (String(existing.stdout).trim() !== cfg.remoteUrl) {
		await runGit(cwd, ['remote', 'set-url', 'origin', cfg.remoteUrl]);
	}

	await runGit(cwd, ['add', '-A']);
	const porcelain = await runGit(cwd, ['status', '--porcelain']);
	if (String(porcelain.stdout).trim()) {
		const msg =
			String(opts.message || '').trim() ||
			`DRIP backup ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
		const commit = await runGit(cwd, ['commit', '-m', msg]);
		if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
			if (/author|user\.email|user\.name/i.test(commit.stderr)) {
				throw new Error(
					'Git user.name / user.email are not configured. Set them globally, then retry.'
				);
			}
			throw new Error(commit.stderr || 'git commit failed');
		}
	}

	const pat = await getStoredPat(context, kbRootUri);
	const pushUrl = remoteUrlWithPat(cfg.remoteUrl, pat);
	const args =
		pushUrl !== cfg.remoteUrl
			? ['push', '-u', pushUrl, `HEAD:${cfg.branch || 'main'}`]
			: ['push', '-u', 'origin', `HEAD:${cfg.branch || 'main'}`];
	const push = await runGitMaybeAuth(cwd, args, pat);
	if (push.code !== 0) {
		const err = (push.stderr || push.stdout || 'git push failed').trim();
		await updateGithubBackupSettings(kbRootUri, { lastError: err.slice(0, 500) });
		throw new Error(err);
	}

	const now = new Date().toISOString();
	await updateGithubBackupSettings(kbRootUri, { lastPushAt: now, lastError: null });
	return getBackupStatus(context, kbRootUri);
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').Uri} kbRootUri
 * @param {{ reindex?: (kbRoot: import('vscode').Uri) => Promise<void> }} [hooks]
 */
async function pullBackup(context, kbRootUri, hooks = {}) {
	if (!(await isGitAvailable())) {
		throw new Error('Git is not installed or not on PATH.');
	}
	const cwd = kbRootUri.fsPath;
	const cfg = await getGithubBackupSettings(kbRootUri);
	if (!cfg.remoteUrl) {
		throw new Error('Set a GitHub remote URL in Settings → GitHub backup first.');
	}
	if (!(await isGitRepo(cwd))) {
		throw new Error('This knowledge base is not a Git repo yet. Run Initialize backup first.');
	}

	const existing = await runGit(cwd, ['remote', 'get-url', 'origin']);
	if (existing.code !== 0) {
		await runGit(cwd, ['remote', 'add', 'origin', cfg.remoteUrl]);
	} else if (String(existing.stdout).trim() !== cfg.remoteUrl) {
		await runGit(cwd, ['remote', 'set-url', 'origin', cfg.remoteUrl]);
	}

	const pat = await getStoredPat(context, kbRootUri);
	const pullUrl = remoteUrlWithPat(cfg.remoteUrl, pat);
	const args =
		pullUrl !== cfg.remoteUrl
			? ['pull', pullUrl, cfg.branch || 'main', '--no-rebase', '--allow-unrelated-histories']
			: ['pull', 'origin', cfg.branch || 'main', '--no-rebase', '--allow-unrelated-histories'];
	const pull = await runGitMaybeAuth(cwd, args, pat);
	if (pull.code !== 0) {
		const err = (pull.stderr || pull.stdout || 'git pull failed').trim();
		await updateGithubBackupSettings(kbRootUri, { lastError: err.slice(0, 500) });
		if (/conflict/i.test(err)) {
			throw new Error(
				'Pull hit merge conflicts. Resolve them in the KB folder, commit, then push.'
			);
		}
		throw new Error(err);
	}

	const now = new Date().toISOString();
	await updateGithubBackupSettings(kbRootUri, { lastPullAt: now, lastError: null });

	if (typeof hooks.reindex === 'function') {
		try {
			await hooks.reindex(kbRootUri);
		} catch (err) {
			console.error('[DRIP] reindex after pull failed', err);
		}
	}

	return getBackupStatus(context, kbRootUri);
}

module.exports = {
	DEFAULT_GITHUB_BACKUP,
	normalizeGithubBackup,
	getGithubBackupSettings,
	updateGithubBackupSettings,
	getStoredPat,
	setStoredPat,
	clearStoredPat,
	getBackupStatus,
	saveRemoteConfig,
	ensureBackupGitignore,
	initBackupRepo,
	pushBackup,
	pullBackup,
	isGitAvailable,
	githubWebUrl
};
