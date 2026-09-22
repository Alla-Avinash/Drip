'use strict';

/**
 * File-backed SQLite for `<kb>/.dripindex/index.drip` via better-sqlite3.
 *
 * Exposes a thin sql.js-compatible surface (`run` / `exec` / `prepare`+`bind`+`step`+`get`+`free`)
 * so existing index callers and schema migrations keep working while we leave WASM sql.js.
 *
 * Native handle: `db.native` (better-sqlite3 Database) for future sqlite-vec loads.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * @param {import('better-sqlite3').Database} native
 * @param {unknown[]} rows — objects from .all()
 * @returns {{ columns: string[], values: unknown[][] }[]}
 */
function toSqlJsExecResult(nativeStmt, rows) {
	const columns = nativeStmt.columns().map(c => c.name);
	if (!rows.length) {
		return [{ columns, values: [] }];
	}
	return [
		{
			columns,
			values: rows.map(row => columns.map(name => row[name]))
		}
	];
}

/**
 * sql.js-like prepared statement over better-sqlite3.
 */
class DripSqliteStatement {
	/**
	 * @param {import('better-sqlite3').Statement} stmt
	 */
	constructor(stmt) {
		this._stmt = stmt;
		/** @type {unknown[]} */
		this._params = [];
		/** @type {Record<string, unknown>[]} */
		this._rows = [];
		/** @type {number} */
		this._index = 0;
		/** @type {Record<string, unknown> | null} */
		this._current = null;
		/** @type {boolean} */
		this._started = false;
	}

	/**
	 * @param {unknown[]} [params]
	 * @returns {boolean}
	 */
	bind(params) {
		this._params = Array.isArray(params) ? params : [];
		this._rows = [];
		this._index = 0;
		this._current = null;
		this._started = false;
		return true;
	}

	/**
	 * @returns {boolean}
	 */
	step() {
		if (!this._stmt) {
			return false;
		}
		if (!this._started) {
			this._started = true;
			if (this._stmt.reader) {
				// Load all rows up front — avoids leaving an open iterator (busy connection).
				this._rows = this._stmt.all(...this._params);
				this._index = 0;
			} else {
				this._stmt.run(...this._params);
				return false;
			}
		}
		if (this._index >= this._rows.length) {
			this._current = null;
			return false;
		}
		this._current = this._rows[this._index++];
		return true;
	}

	/**
	 * Positional values (sql.js `Statement#get` shape).
	 * @returns {unknown[]}
	 */
	get() {
		if (!this._current || !this._stmt) {
			return [];
		}
		return this._stmt.columns().map(c => this._current[c.name]);
	}

	free() {
		this._rows = [];
		this._index = 0;
		this._current = null;
		this._stmt = null;
		this._params = [];
		this._started = false;
	}
}

/**
 * sql.js-like Database over a file-backed better-sqlite3 connection.
 */
class DripSqliteDatabase {
	/**
	 * @param {import('better-sqlite3').Database} native
	 * @param {string} fsPath
	 */
	constructor(native, fsPath) {
		/** @type {import('better-sqlite3').Database} */
		this.native = native;
		/** @type {string} */
		this.fsPath = fsPath;
	}

	/**
	 * @param {string} sql
	 * @param {unknown[]} [params]
	 */
	run(sql, params) {
		const p = Array.isArray(params) ? params : [];
		if (p.length === 0) {
			// BEGIN/COMMIT/ROLLBACK and parameterless DDL/DML
			this.native.exec(sql);
			return;
		}
		this.native.prepare(sql).run(...p);
	}

	/**
	 * sql.js `Database#exec`: returns `[{ columns, values }]` for row-returning SQL;
	 * runs multi-statement DDL via native exec and returns `[]`.
	 * @param {string} sql
	 * @returns {{ columns: string[], values: unknown[][] }[]}
	 */
	exec(sql) {
		const text = String(sql || '').trim();
		if (!text) {
			return [];
		}
		try {
			const stmt = this.native.prepare(text);
			if (stmt.reader) {
				const rows = stmt.all();
				return toSqlJsExecResult(stmt, rows);
			}
			stmt.run();
			return [];
		} catch (err) {
			const msg = err && err.message ? String(err.message) : '';
			// better-sqlite3 rejects multi-statement prepare — fall back to exec (DDL batches).
			if (/one statement|multiple statements|This statement does not return data/i.test(msg) || /prepare/i.test(msg)) {
				this.native.exec(text);
				return [];
			}
			// Some environments throw differently for multi-statement; try exec once.
			try {
				this.native.exec(text);
				return [];
			} catch {
				throw err;
			}
		}
	}

	/**
	 * @param {string} sql
	 * @returns {DripSqliteStatement}
	 */
	prepare(sql) {
		return new DripSqliteStatement(this.native.prepare(sql));
	}

	/**
	 * No-op for file-backed DB (writes are immediate). Kept for call-site compatibility.
	 * @returns {Uint8Array}
	 */
	export() {
		return new Uint8Array(0);
	}

	close() {
		if (this.native) {
			try {
				this.native.close();
			} catch {
				// already closed
			}
			this.native = null;
		}
	}
}

/**
 * Open (or create) `index.drip` at an absolute filesystem path.
 * @param {string} fsPath
 * @returns {DripSqliteDatabase}
 */
function openDripSqlite(fsPath) {
	const resolved = path.resolve(String(fsPath || ''));
	if (!resolved) {
		throw new Error('openDripSqlite: missing path');
	}
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	const native = new Database(resolved);
	native.pragma('foreign_keys = ON');
	loadSqliteVecExtension(native);
	return new DripSqliteDatabase(native, resolved);
}

/**
 * Load sqlite-vec (`vec0`) into this connection. Required before creating/querying vector tables.
 * @param {import('better-sqlite3').Database} native
 */
function loadSqliteVecExtension(native) {
	const { getLoadablePath } = require('sqlite-vec');
	native.loadExtension(getLoadablePath());
}

module.exports = {
	openDripSqlite,
	loadSqliteVecExtension,
	DripSqliteDatabase,
	DripSqliteStatement
};
