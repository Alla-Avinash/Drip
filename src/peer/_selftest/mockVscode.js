'use strict';

/**
 * Minimal vscode stand-in so peer sync can run in plain Node.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

class Uri {
	constructor(fsPath) {
		this.fsPath = path.resolve(String(fsPath || ''));
		this.scheme = 'file';
		this.path = this.fsPath.replace(/\\/g, '/');
	}

	static file(p) {
		return new Uri(p);
	}

	static joinPath(base, ...parts) {
		return new Uri(path.join(base.fsPath, ...parts));
	}

	toString() {
		return this.fsPath;
	}
}

const FileType = { Unknown: 0, File: 1, Directory: 2 };

const workspace = {
	getConfiguration() {
		return {
			get(_key, fallback) {
				return fallback;
			}
		};
	},
	fs: {
		async readFile(uri) {
			return await fsp.readFile(uri.fsPath);
		},
		async writeFile(uri, buf) {
			await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
			await fsp.writeFile(uri.fsPath, buf);
		},
		async createDirectory(uri) {
			await fsp.mkdir(uri.fsPath, { recursive: true });
		},
		async stat(uri) {
			const st = await fsp.stat(uri.fsPath);
			return {
				type: st.isDirectory() ? FileType.Directory : FileType.File,
				size: st.size,
				mtime: st.mtimeMs
			};
		},
		async readDirectory(uri) {
			const names = await fsp.readdir(uri.fsPath, { withFileTypes: true });
			return names.map(n => [n.name, n.isDirectory() ? FileType.Directory : FileType.File]);
		},
		async delete(uri, opts) {
			await fsp.rm(uri.fsPath, { recursive: !!(opts && opts.recursive), force: true });
		}
	}
};

function makeContext() {
	const store = {};
	const secrets = {};
	return {
		globalState: {
			get(key, fallback) {
				return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : fallback;
			},
			async update(key, value) {
				store[key] = value;
			}
		},
		secrets: {
			async get(key) {
				return secrets[key];
			},
			async store(key, value) {
				secrets[key] = value;
			}
		},
		subscriptions: []
	};
}

module.exports = {
	Uri,
	FileType,
	workspace,
	window: {
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		withProgress: async (_opts, fn) => fn()
	},
	commands: { executeCommand: async () => undefined },
	EventEmitter: class {
		constructor() {
			this.event = () => ({ dispose() {} });
		}
		fire() {}
		dispose() {}
	},
	ThemeIcon: class {
		constructor() {}
	},
	ThemeColor: class {
		constructor() {}
	},
	TreeItem: class {
		constructor(label) {
			this.label = label;
		}
	},
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	FileDecoration: class {
		constructor(badge, tooltip, color) {
			this.badge = badge;
			this.tooltip = tooltip;
			this.color = color;
		}
	},
	ProgressLocation: { Notification: 1 },
	makeContext,
	_exists: fs.existsSync
};
