'use strict';

const path = require('path');
const vscode = require('vscode');
const { INDEX_FILE, getDripIndexRootUri } = require('../startup/initializeDripIndex');
const {
	SCHEMA_VERSION,
	TYPED_METADATA_TABLES,
	REMAINING_METADATA_TABLE,
	ensureDripIndexSchema
} = require('./dbSchema/dripIndexSchema');
const { openDripSqlite } = require('./db/dripSqlite');
const {
	deleteFileEmbeddings,
	deleteHeadingEmbedding,
	clearAllHeadingEmbeddings
} = require('./embeddings/headingEmbeddingStore');
const {
	planHeadingEmbeddingRewrite,
	collectAllHeadingEmbeddingTargets
} = require('./embeddings/headingEmbeddingSync');
const { forEachKnowledgeBaseNote } = require('../document/kbNoteOps');
const { parseNoteForIndex, splitHeaderAndBody, parseFileIdFromHeader } = require('./dripIndexParse');
const { formatFileEntityId } = require('./dripnoteEntityIds');
const { findDirtyHeadingIdsByHash } = require('./sync/dripnoteDocumentWatch');
const { normalizeMetadataTypeForIndex } = require('./parse/dripIndexMetadataType');
const tagGraphStore = require('../graph/tagGraphStore');

/** Serialize file-id allocation per KB so concurrent creates cannot both read the same counter. */
/** @type {Map<string, Promise<unknown>>} */
const fileIdAllocationLocks = new Map();

/**
 * @template T
 * @param {import('vscode').Uri} kbRootUri
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withFileIdAllocationLock(kbRootUri, fn) {
	const key = String(kbRootUri && kbRootUri.fsPath ? kbRootUri.fsPath : '');
	const prev = fileIdAllocationLocks.get(key) || Promise.resolve();
	const run = prev.catch(() => undefined).then(fn);
	fileIdAllocationLocks.set(
		key,
		run.then(
			() => undefined,
			() => undefined
		)
	);
	return run;
}

/**
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 */
function ensureSchema(db) {
	ensureDripIndexSchema(db);
}

/**
 * Remove all heading-scoped rows for a file (typed metadata + tags + refs).
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {number} fileId
 */
function deleteFileHeadingScopedRows(db, fileId) {
	deleteFileEmbeddings(db, fileId);
	db.run('DELETE FROM searchtags WHERE file_id = ?', [fileId]);
	db.run('DELETE FROM relations WHERE from_file_id = ?', [fileId]);
	// Keep references from other files to this file during a reindex/update.
	db.run('DELETE FROM heading_references WHERE source_file_id = ?', [fileId]);
	for (const table of TYPED_METADATA_TABLES) {
		db.run(`DELETE FROM ${table} WHERE file_id = ?`, [fileId]);
	}
	db.run(`DELETE FROM ${REMAINING_METADATA_TABLE} WHERE file_id = ?`, [fileId]);
	db.run('DELETE FROM headings WHERE file_id = ?', [fileId]);
}

/**
 * Remove one heading's scoped rows (incremental update).
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {number} fileId
 * @param {number} headingId
 * @param {{ keepEmbedding?: boolean }} [options] — when true, leave sqlite-vec row (title/tags unchanged)
 */
function deleteHeadingScopedRows(db, fileId, headingId, options) {
	if (!(options && options.keepEmbedding)) {
		deleteHeadingEmbedding(db, fileId, headingId);
	}
	db.run('DELETE FROM searchtags WHERE file_id = ? AND heading_id = ?', [fileId, headingId]);
	db.run('DELETE FROM relations WHERE from_file_id = ? AND from_heading_id = ?', [
		fileId,
		headingId
	]);
	db.run(
		'DELETE FROM heading_references WHERE source_file_id = ? AND source_heading_id = ?',
		[fileId, headingId]
	);
	for (const table of TYPED_METADATA_TABLES) {
		db.run(`DELETE FROM ${table} WHERE file_id = ? AND heading_id = ?`, [fileId, headingId]);
	}
	db.run(`DELETE FROM ${REMAINING_METADATA_TABLE} WHERE file_id = ? AND heading_id = ?`, [
		fileId,
		headingId
	]);
	db.run('DELETE FROM headings WHERE file_id = ? AND heading_id = ?', [fileId, headingId]);
}

/**
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {string} sql
 * @param {unknown[]} params
 * @returns {unknown[] | undefined}
 */
function queryOne(db, sql, params) {
	const stmt = db.prepare(sql);
	stmt.bind(params);
	let row;
	if (stmt.step()) {
		row = stmt.get();
	}
	stmt.free();
	return row;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {import('vscode').Uri}
 */
function getIndexDbUri(kbRootUri) {
	return vscode.Uri.joinPath(getDripIndexRootUri(kbRootUri), INDEX_FILE);
}

/**
 * @param {string} kbRootFsPath
 * @param {string} noteFsPath
 */
function normalizeRelPath(kbRootFsPath, noteFsPath) {
	return path.relative(kbRootFsPath, noteFsPath).replace(/\\/g, '/');
}

/**
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {number} sourceFileId
 * @param {{ source_heading_id: number, target_file_id: number }[]} references
 */
function insertHeadingReferences(db, sourceFileId, references) {
	for (const ref of references || []) {
		db.run(
			`INSERT OR IGNORE INTO heading_references
			 (source_file_id, source_heading_id, target_file_id)
			 VALUES (?, ?, ?)`,
			[
				sourceFileId,
				ref.source_heading_id,
				ref.target_file_id
			]
		);
	}
}

/**
 * @param {import('vscode').ExtensionContext | null | undefined} context
 * @returns {Set<string>}
 */
function collectKnownTagNamesLower(context) {
	/** @type {Set<string>} */
	const out = new Set();
	if (!context) {
		return out;
	}
	for (const meta of tagGraphStore.listStoredTagGraphs(context)) {
		const graph = tagGraphStore.loadStoredTagGraphById(context, meta.id);
		for (const node of graph.nodes || []) {
			const label = String(node.label || '').trim();
			if (label) {
				out.add(label.toLowerCase());
			}
		}
	}
	return out;
}

/**
 * Sync `tags` table from tag graph node labels. Returns lowercase name → tag_id map.
 *
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {import('vscode').ExtensionContext | null | undefined} context
 * @param {{ replaceAll?: boolean }} [options]
 * @returns {Map<string, number>}
 */
function syncTagsTableFromGraph(db, context, options) {
	if (options && options.replaceAll) {
		db.run('DELETE FROM tags');
	}

	/** @type {Map<string, number>} */
	const tagIdByLower = new Map();
	const existing = db.exec('SELECT tag_id, tag_name FROM tags');
	if (existing.length) {
		for (const row of existing[0].values) {
			tagIdByLower.set(String(row[1] || '').toLowerCase(), Number(row[0]));
		}
	}

	let nextId = 0;
	const maxRow = queryOne(db, 'SELECT COALESCE(MAX(tag_id), -1) FROM tags', []);
	if (maxRow) {
		nextId = Number(maxRow[0]) + 1;
	}

	if (!context) {
		return tagIdByLower;
	}

	for (const meta of tagGraphStore.listStoredTagGraphs(context)) {
		const graph = tagGraphStore.loadStoredTagGraphById(context, meta.id);
		for (const node of graph.nodes || []) {
			const label = String(node.label || '').trim();
			if (!label) {
				continue;
			}
			const lower = label.toLowerCase();
			if (tagIdByLower.has(lower)) {
				continue;
			}
			db.run('INSERT INTO tags (tag_id, tag_name) VALUES (?, ?)', [nextId, label]);
			tagIdByLower.set(lower, nextId);
			nextId += 1;
		}
	}

	return tagIdByLower;
}

/**
 * Load or create a row in a (id, name) lookup table. Names are stored lowercased.
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {'metadata_types' | 'relation_types'} table
 * @param {string} idColumn
 * @param {string} nameColumn
 * @param {string} rawName
 * @param {Map<string, number>} idByLower
 * @returns {number | null}
 */
function ensureLookupTypeId(db, table, idColumn, nameColumn, rawName, idByLower) {
	const name = String(rawName || '').trim().toLowerCase();
	if (!name) {
		return null;
	}
	if (idByLower.has(name)) {
		return /** @type {number} */ (idByLower.get(name));
	}
	const existing = queryOne(
		db,
		`SELECT ${idColumn} FROM ${table} WHERE ${nameColumn} = ?`,
		[name]
	);
	if (existing) {
		const id = Number(existing[0]);
		idByLower.set(name, id);
		return id;
	}
	const maxRow = queryOne(db, `SELECT COALESCE(MAX(${idColumn}), -1) FROM ${table}`, []);
	const nextId = maxRow ? Number(maxRow[0]) + 1 : 0;
	db.run(`INSERT INTO ${table} (${idColumn}, ${nameColumn}) VALUES (?, ?)`, [nextId, name]);
	idByLower.set(name, nextId);
	return nextId;
}

/**
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @returns {{ metadataTypeIdByLower: Map<string, number>, relationTypeIdByLower: Map<string, number> }}
 */
function loadTypeLookupMaps(db) {
	/** @type {Map<string, number>} */
	const metadataTypeIdByLower = new Map();
	const metaRows = db.exec('SELECT metadata_type_id, metadata_type_name FROM metadata_types');
	if (metaRows.length) {
		for (const row of metaRows[0].values) {
			metadataTypeIdByLower.set(String(row[1] || '').toLowerCase(), Number(row[0]));
		}
	}
	/** @type {Map<string, number>} */
	const relationTypeIdByLower = new Map();
	const relRows = db.exec('SELECT relation_type_id, relation_type_name FROM relation_types');
	if (relRows.length) {
		for (const row of relRows[0].values) {
			relationTypeIdByLower.set(String(row[1] || '').toLowerCase(), Number(row[0]));
		}
	}
	return { metadataTypeIdByLower, relationTypeIdByLower };
}

/**
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {number} fileId
 * @param {{ heading_id: number, table: string | null, fields: Record<string, string | number | null>, remaining?: { key: string, value: string | null }[], metadata_type?: string }[]} typedMetadata
 * @param {Map<string, number>} metadataTypeIdByLower
 */
function insertTypedMetadataRows(db, fileId, typedMetadata, metadataTypeIdByLower) {
	const metaMap = metadataTypeIdByLower || new Map();
	for (const entry of typedMetadata || []) {
		const table = String(entry.table || '');
		const fields = entry.fields || {};
		const headingId = entry.heading_id;

		if (table && TYPED_METADATA_TABLES.includes(table) && Object.keys(fields).length) {
			if (table === 'concept_metadata') {
				db.run(`INSERT INTO concept_metadata (file_id, heading_id, status) VALUES (?, ?, ?)`, [
					fileId,
					headingId,
					fields.status != null ? String(fields.status) : null
				]);
			} else if (table === 'project_metadata') {
				db.run(
					`INSERT INTO project_metadata (file_id, heading_id, status, deadline) VALUES (?, ?, ?, ?)`,
					[
						fileId,
						headingId,
						fields.status != null ? String(fields.status) : null,
						fields.deadline != null ? Number(fields.deadline) : null
					]
				);
			} else if (table === 'task_metadata') {
				db.run(
					`INSERT INTO task_metadata (file_id, heading_id, status, category, deadline, priority)
					 VALUES (?, ?, ?, ?, ?, ?)`,
					[
						fileId,
						headingId,
						fields.status != null ? String(fields.status) : null,
						fields.category != null ? String(fields.category) : null,
						fields.deadline != null ? Number(fields.deadline) : null,
						fields.priority != null ? String(fields.priority) : null
					]
				);
			} else if (table === 'issue_metadata') {
				db.run(
					`INSERT INTO issue_metadata (file_id, heading_id, status, category, deadline, priority)
					 VALUES (?, ?, ?, ?, ?, ?)`,
					[
						fileId,
						headingId,
						fields.status != null ? String(fields.status) : null,
						fields.category != null ? String(fields.category) : null,
						fields.deadline != null ? Number(fields.deadline) : null,
						fields.priority != null ? String(fields.priority) : null
					]
				);
			} else if (table === 'decision_metadata') {
				db.run(
					`INSERT INTO decision_metadata (file_id, heading_id, category) VALUES (?, ?, ?)`,
					[fileId, headingId, fields.category != null ? String(fields.category) : null]
				);
			}
		}

		const remaining = entry.remaining || [];
		if (!remaining.length) {
			continue;
		}
		const typeName = String(entry.metadata_type || '').trim().toLowerCase();
		const metadataTypeId = ensureLookupTypeId(
			db,
			'metadata_types',
			'metadata_type_id',
			'metadata_type_name',
			typeName,
			metaMap
		);
		if (metadataTypeId == null) {
			continue;
		}
		for (const pair of remaining) {
			const key = String(pair.key || '').trim().toLowerCase();
			if (!key) continue;
			if (pair.value == null || !String(pair.value).trim()) {
				continue;
			}
			db.run(
				`INSERT OR REPLACE INTO ${REMAINING_METADATA_TABLE}
				 (file_id, heading_id, metadata_type_id, key, value)
				 VALUES (?, ?, ?, ?, ?)`,
				[fileId, headingId, metadataTypeId, key, String(pair.value).trim()]
			);
		}
	}
}

/**
 * @param {object} parsed
 * @param {Set<number>} headingIds
 */
function filterParsedByHeadingIds(parsed, headingIds) {
	if (!headingIds || !headingIds.size) {
		return {
			headings: [],
			references: [],
			searchtags: [],
			relations: [],
			typedMetadata: []
		};
	}
	return {
		headings: (parsed.headings || []).filter(h => headingIds.has(h.heading_id)),
		references: (parsed.references || []).filter(r => headingIds.has(r.source_heading_id)),
		searchtags: (parsed.searchtags || []).filter(t => headingIds.has(t.source_heading_id)),
		relations: (parsed.relations || []).filter(r => headingIds.has(r.source_heading_id)),
		typedMetadata: (parsed.typedMetadata || []).filter(t => headingIds.has(t.heading_id))
	};
}

/**
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {number} sourceFileId
 * @param {{ searchtags?: { source_heading_id: number, tag_name: string }[], relations?: object[] }} parsed
 * @param {Map<string, number>} tagIdByLower
 * @param {Map<string, number>} relationTypeIdByLower
 */
function insertSearchTagsAndRelations(db, sourceFileId, parsed, tagIdByLower, relationTypeIdByLower) {
	for (const row of parsed.searchtags || []) {
		const tagId = tagIdByLower.get(String(row.tag_name || '').toLowerCase());
		if (tagId == null) {
			continue;
		}
		db.run(
			`INSERT OR IGNORE INTO searchtags (file_id, heading_id, tag_id) VALUES (?, ?, ?)`,
			[sourceFileId, row.source_heading_id, tagId]
		);
	}

	for (const rel of parsed.relations || []) {
		const tagId = tagIdByLower.get(String(rel.tag_name || '').toLowerCase());
		if (tagId == null) {
			continue;
		}
		const relationTypeId = ensureLookupTypeId(
			db,
			'relation_types',
			'relation_type_id',
			'relation_type_name',
			rel.relation_type,
			relationTypeIdByLower
		);
		if (relationTypeId == null) {
			continue;
		}
		db.run(
			`INSERT OR IGNORE INTO relations
			 (from_file_id, from_heading_id, relation_type_id, tag_id)
			 VALUES (?, ?, ?, ?)`,
			[sourceFileId, rel.source_heading_id, relationTypeId, tagId]
		);
	}
}

/**
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {number} fileId
 * @param {{ headings: object[], references: object[], searchtags?: object[], relations?: object[] }} parsed
 * @param {Map<string, number>} tagIdByLower
 * @param {Map<string, number>} [metadataTypeIdByLower]
 * @param {Map<string, number>} [relationTypeIdByLower]
 */
function insertParsedHeadingsAndReferences(
	db,
	fileId,
	parsed,
	tagIdByLower,
	metadataTypeIdByLower,
	relationTypeIdByLower
) {
	const metaMap = metadataTypeIdByLower || new Map();
	const relMap = relationTypeIdByLower || new Map();
	const seenHeadingIds = new Set();
	for (const heading of parsed.headings || []) {
		const headingId = heading.heading_id;
		if (seenHeadingIds.has(headingId)) {
			continue;
		}
		seenHeadingIds.add(headingId);
		const typeName = normalizeMetadataTypeForIndex(heading.metadata_type);
		const metadataTypeId =
			typeName == null
				? null
				: ensureLookupTypeId(
						db,
						'metadata_types',
						'metadata_type_id',
						'metadata_type_name',
						typeName,
						metaMap
					);
		db.run(
			`INSERT INTO headings (file_id, heading_id, title, metadata_type_id, hash)
			 VALUES (?, ?, ?, ?, ?)`,
			[fileId, headingId, heading.title, metadataTypeId, heading.hash]
		);
	}
	insertHeadingReferences(db, fileId, parsed.references);
	insertSearchTagsAndRelations(db, fileId, parsed, tagIdByLower, relMap);
	insertTypedMetadataRows(db, fileId, parsed.typedMetadata, metaMap);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 */
async function openDripIndexDb(kbRootUri) {
	const indexUri = getIndexDbUri(kbRootUri);
	const db = openDripSqlite(indexUri.fsPath);
	ensureSchema(db);

	return {
		db,
		indexUri,
		/**
		 * File-backed DB writes immediately; keep save() for call-site compatibility
		 * (callers still close after save).
		 */
		async save() {
			// no-op: better-sqlite3 persists on each write
		},
		close() {
			db.close();
		}
	};
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<string[]>}
 */
async function listIndexedFilePaths(kbRootUri) {
	const handle = await openDripIndexDb(kbRootUri);
	try {
		const result = handle.db.exec('SELECT path FROM files ORDER BY path');
		if (!result.length) {
			return [];
		}
		return result[0].values.map(row => String(row[0] || ''));
	} finally {
		handle.close();
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<string[]>}
 */
async function listDiskNotePaths(kbRootUri) {
	/** @type {string[]} */
	const paths = [];
	await forEachKnowledgeBaseNote(
		kbRootUri,
		async note => {
			if (!note?.uri?.fsPath) {
				return;
			}
			paths.push(normalizeRelPath(kbRootUri.fsPath, note.uri.fsPath));
		},
		{ yieldEvery: 40 }
	);
	paths.sort((a, b) => a.localeCompare(b));
	return paths;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<boolean>}
 */
async function dripIndexNeedsRebuild(kbRootUri) {
	const [indexed, disk] = await Promise.all([
		listIndexedFilePaths(kbRootUri),
		listDiskNotePaths(kbRootUri)
	]);
	return JSON.stringify(indexed) !== JSON.stringify(disk);
}

/**
 * Allocate the next unused sequential file entity id (`@fN` number).
 * Uses max(counter, MAX(files.id)+1), skips ids already in `files`, bumps
 * `index_meta.next_file_id`, and saves `index.drip` immediately.
 *
 * @param {import('vscode').Uri} kbRootUri
 * @returns {Promise<number>}
 */
async function allocateNextFileEntityNumber(kbRootUri) {
	return withFileIdAllocationLock(kbRootUri, async () => {
		const handle = await openDripIndexDb(kbRootUri);
		try {
			const counterRow = queryOne(
				handle.db,
				`SELECT value FROM index_meta WHERE key = 'next_file_id'`,
				[]
			);
			const maxRow = queryOne(handle.db, 'SELECT COALESCE(MAX(id), -1) FROM files', []);
			const maxId = maxRow && Number.isFinite(Number(maxRow[0])) ? Number(maxRow[0]) : -1;
			let counter = counterRow ? parseInt(String(counterRow[0]), 10) : NaN;
			if (!Number.isFinite(counter) || counter < 0) {
				counter = 0;
			}

			let next = Math.max(counter, maxId + 1, 0);
			for (;;) {
				const taken = queryOne(handle.db, 'SELECT 1 FROM files WHERE id = ?', [next]);
				if (!taken) break;
				next += 1;
			}

			handle.db.run(`INSERT OR REPLACE INTO index_meta(key, value) VALUES ('next_file_id', ?)`, [
				String(next + 1)
			]);
			await handle.save();
			return next;
		} finally {
			handle.close();
		}
	});
}

/**
 * Keep `next_file_id` ahead of any id that was just written into `files`.
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {number} usedFileId
 */
function bumpNextFileIdCounter(db, usedFileId) {
	const used = Math.floor(Number(usedFileId));
	if (!Number.isFinite(used) || used < 0) return;
	const need = used + 1;
	const counterRow = queryOne(db, `SELECT value FROM index_meta WHERE key = 'next_file_id'`, []);
	let counter = counterRow ? parseInt(String(counterRow[0]), 10) : NaN;
	if (!Number.isFinite(counter) || counter < need) {
		db.run(`INSERT OR REPLACE INTO index_meta(key, value) VALUES ('next_file_id', ?)`, [
			String(need)
		]);
	}
}

/**
 * Resolve sequential `@fN` file entity from note header or index.drip (allocate when missing).
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @param {string} [text]
 * @returns {Promise<{ fileNum: number, fileEntityId: string } | null>}
 */
async function resolveSequentialFileEntityForKbNote(kbRootUri, noteUri, text) {
	if (!kbRootUri || !noteUri) return null;
	const normalized = String(text || '').replace(/\r\n/g, '\n');
	const { headerLines } = splitHeaderAndBody(normalized);
	const fromHeader = parseFileIdFromHeader(headerLines);
	if (fromHeader != null) {
		return { fileNum: fromHeader, fileEntityId: formatFileEntityId(fromHeader) };
	}

	await initEmptyDripIndexFile(kbRootUri);
	const relPath = normalizeRelPath(kbRootUri.fsPath, noteUri.fsPath);
	const handle = await openDripIndexDb(kbRootUri);
	try {
		const row = queryOne(handle.db, 'SELECT id FROM files WHERE path = ?', [relPath]);
		if (row) {
			const fileNum = Number(row[0]);
			if (Number.isFinite(fileNum)) {
				return { fileNum, fileEntityId: formatFileEntityId(fileNum) };
			}
		}
	} finally {
		handle.close();
	}

	const fileNum = await allocateNextFileEntityNumber(kbRootUri);
	return { fileNum, fileEntityId: formatFileEntityId(fileNum) };
}

/**
 * @param {number} fileId
 * @returns {string}
 */
function headingAllocatorMetaKey(fileId) {
	return `heading_alloc_${Math.max(0, Math.floor(Number(fileId) || 0))}`;
}

/**
 * @param {unknown} raw
 * @returns {{ next: number, free: number[] }}
 */
function parseHeadingAllocatorState(raw) {
	try {
		const parsed = JSON.parse(String(raw || '{}'));
		const next = parseInt(String(parsed && parsed.next), 10);
		const free = Array.isArray(parsed && parsed.free)
			? parsed.free.map(x => parseInt(String(x), 10)).filter(n => Number.isFinite(n) && n > 0)
			: [];
		return {
			next: Number.isFinite(next) && next > 0 ? next : 1,
			free: [...new Set(free)].sort((a, b) => a - b)
		};
	} catch {
		return { next: 1, free: [] };
	}
}

/**
 * @param {{ next: number, free: number[] }} state
 * @returns {string}
 */
function formatHeadingAllocatorState(state) {
	const next = Math.max(1, Math.floor(Number(state && state.next) || 1));
	const free = Array.isArray(state && state.free)
		? [...new Set(state.free.map(n => Math.floor(Number(n) || 0)).filter(n => n > 0))].sort((a, b) => a - b)
		: [];
	return JSON.stringify({ next, free });
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {number} fileId
 * @returns {Promise<{ next: number, free: number[] }>}
 */
async function readFileHeadingAllocator(kbRootUri, fileId) {
	const handle = await openDripIndexDb(kbRootUri);
	try {
		const key = headingAllocatorMetaKey(fileId);
		const row = queryOne(handle.db, `SELECT value FROM index_meta WHERE key = ?`, [key]);
		return parseHeadingAllocatorState(row && row[0]);
	} finally {
		handle.close();
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {number} fileId
 * @param {{ next: number, free: number[] }} state
 */
async function writeFileHeadingAllocator(kbRootUri, fileId, state) {
	const handle = await openDripIndexDb(kbRootUri);
	try {
		const key = headingAllocatorMetaKey(fileId);
		handle.db.run(`INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)`, [
			key,
			formatHeadingAllocatorState(state)
		]);
		await handle.save();
	} finally {
		handle.close();
	}
}

/**
 * Allocate a per-file non-h0 heading id (reuses lowest free id when available).
 * @param {import('vscode').Uri} kbRootUri
 * @param {number} fileId
 * @returns {Promise<number>}
 */
async function allocateHeadingIdForFile(kbRootUri, fileId) {
	const state = await readFileHeadingAllocator(kbRootUri, fileId);
	state.free.sort((a, b) => a - b);
	if (state.free.length) {
		const id = state.free.shift();
		await writeFileHeadingAllocator(kbRootUri, fileId, state);
		return /** @type {number} */ (id);
	}
	const id = state.next;
	state.next = id + 1;
	await writeFileHeadingAllocator(kbRootUri, fileId, state);
	return id;
}

/**
 * Rebuild per-file heading allocator from ids currently used in a note.
 * Fills gaps (e.g. 4–18 when only 1–3 remain) and sets next to max(used)+1.
 * @param {Iterable<number>} usedNonH0Ids
 * @param {{ next?: number, free?: number[] }} [existing]
 * @returns {{ next: number, free: number[] }}
 */
function recomputeHeadingAllocatorState(usedNonH0Ids, existing) {
	/** @type {Set<number>} */
	const used = new Set();
	for (const raw of usedNonH0Ids || []) {
		const n = Math.floor(Number(raw) || 0);
		if (n > 0) used.add(n);
	}
	let max = 0;
	for (const id of used) max = Math.max(max, id);

	const existingNext =
		existing && Number.isFinite(existing.next) && existing.next > 0 ? existing.next : 1;
	const scanMax = Math.max(max, existingNext > 1 ? existingNext - 1 : 0);

	/** @type {Set<number>} */
	const freeSet = new Set();
	for (let i = 1; i <= scanMax; i++) {
		if (!used.has(i)) freeSet.add(i);
	}
	if (existing && Array.isArray(existing.free)) {
		for (const raw of existing.free) {
			const id = Math.floor(Number(raw) || 0);
			if (id > 0 && !used.has(id)) freeSet.add(id);
		}
	}
	const free = [...freeSet].sort((a, b) => a - b);
	const next = Math.max(max + 1, free.length > 0 ? free[free.length - 1] + 1 : max + 1, 1);
	return { next, free };
}

/**
 * Sync allocator free-list from heading ids present in a file after reconcile.
 * @param {import('vscode').Uri} kbRootUri
 * @param {number} fileId
 * @param {Iterable<number>} usedNonH0Ids
 */
async function syncFileHeadingAllocatorFromUsedIds(kbRootUri, fileId, usedNonH0Ids) {
	const existing = await readFileHeadingAllocator(kbRootUri, fileId);
	const state = recomputeHeadingAllocatorState(usedNonH0Ids, existing);
	await writeFileHeadingAllocator(kbRootUri, fileId, state);
}

/**
 * @param {number} fileId
 * @param {number} workflowHeadingId
 * @returns {string}
 */
function workflowTaskAllocatorMetaKey(fileId, workflowHeadingId) {
	const f = Math.max(0, Math.floor(Number(fileId) || 0));
	const h = Math.max(0, Math.floor(Number(workflowHeadingId) || 0));
	return `workflow_alloc_${f}_${h}`;
}

/**
 * @param {string | null | undefined} raw
 * @returns {{ next: number, free: number[], byHeading: Record<string, number> }}
 */
function parseWorkflowTaskAllocatorState(raw) {
	const base = parseHeadingAllocatorState(raw);
	/** @type {Record<string, number>} */
	const byHeading = {};
	try {
		const parsed = JSON.parse(String(raw || '{}'));
		const src = parsed && parsed.byHeading && typeof parsed.byHeading === 'object' ? parsed.byHeading : {};
		for (const [k, v] of Object.entries(src)) {
			const h = Math.floor(Number(k) || 0);
			const tid = Math.floor(Number(v) || 0);
			if (h > 0 && tid > 0) byHeading[String(h)] = tid;
		}
	} catch {
		/* ignore */
	}
	return { next: base.next, free: base.free, byHeading };
}

/**
 * @param {{ next: number, free?: number[], byHeading?: Record<string, number> }} state
 * @returns {string}
 */
function formatWorkflowTaskAllocatorState(state) {
	const next = Math.max(1, Math.floor(Number(state && state.next) || 1));
	/** @type {Record<string, number>} */
	const byHeading = {};
	const src = state && state.byHeading && typeof state.byHeading === 'object' ? state.byHeading : {};
	for (const [k, v] of Object.entries(src)) {
		const h = Math.floor(Number(k) || 0);
		const tid = Math.floor(Number(v) || 0);
		if (h > 0 && tid > 0) byHeading[String(h)] = tid;
	}
	return JSON.stringify({ next, free: [], byHeading });
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {number} fileId
 * @param {number} workflowHeadingId
 * @returns {Promise<{ next: number, free: number[], byHeading: Record<string, number> }>}
 */
async function readWorkflowTaskAllocator(kbRootUri, fileId, workflowHeadingId) {
	const handle = await openDripIndexDb(kbRootUri);
	try {
		const key = workflowTaskAllocatorMetaKey(fileId, workflowHeadingId);
		const row = queryOne(handle.db, `SELECT value FROM index_meta WHERE key = ?`, [key]);
		return parseWorkflowTaskAllocatorState(row && row[0]);
	} finally {
		handle.close();
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {number} fileId
 * @param {number} workflowHeadingId
 * @param {{ next: number, free?: number[], byHeading?: Record<string, number> }} state
 */
async function writeWorkflowTaskAllocator(kbRootUri, fileId, workflowHeadingId, state) {
	const handle = await openDripIndexDb(kbRootUri);
	try {
		const key = workflowTaskAllocatorMetaKey(fileId, workflowHeadingId);
		handle.db.run(`INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)`, [
			key,
			formatWorkflowTaskAllocatorState(state)
		]);
		await handle.save();
	} finally {
		handle.close();
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {number} fileId
 * @param {number} workflowHeadingId
 * @returns {Promise<number>}
 */
async function allocateWorkflowTaskId(kbRootUri, fileId, workflowHeadingId) {
	const state = await readWorkflowTaskAllocator(kbRootUri, fileId, workflowHeadingId);
	state.free.sort((a, b) => a - b);
	if (state.free.length) {
		const id = state.free.shift();
		await writeWorkflowTaskAllocator(kbRootUri, fileId, workflowHeadingId, state);
		return /** @type {number} */ (id);
	}
	const id = state.next;
	state.next = id + 1;
	await writeWorkflowTaskAllocator(kbRootUri, fileId, workflowHeadingId, state);
	return id;
}

/**
 * Dense contiguous sync: used ids are exactly 1..N; stores heading→taskId bindings for remaps.
 * @param {import('vscode').Uri} kbRootUri
 * @param {number} fileId
 * @param {number} workflowHeadingId
 * @param {Iterable<number>} usedTaskIds
 * @param {Record<string, number>} [byHeading]
 */
async function syncWorkflowTaskAllocatorFromUsedIds(kbRootUri, fileId, workflowHeadingId, usedTaskIds, byHeading) {
	/** @type {Set<number>} */
	const used = new Set();
	for (const raw of usedTaskIds || []) {
		const n = Math.floor(Number(raw) || 0);
		if (n > 0) used.add(n);
	}
	let max = 0;
	for (const id of used) max = Math.max(max, id);
	await writeWorkflowTaskAllocator(kbRootUri, fileId, workflowHeadingId, {
		next: max + 1,
		free: [],
		byHeading: byHeading || {}
	});
}

/**
 * Full rebuild of index.drip from KB notes on disk.
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').ExtensionContext | null | undefined} [context]
 */
async function rebuildDripIndex(kbRootUri, context) {
	const handle = await openDripIndexDb(kbRootUri);
	const usedFileIds = new Set();
	let nextFileId = 0;
	const knownTagsLower = collectKnownTagNamesLower(context);

	try {
		handle.db.run('BEGIN');
		clearAllHeadingEmbeddings(handle.db);
		try {
			require('./embeddings/folderEmbeddingStore').clearAllFolderEmbeddings(handle.db);
		} catch (err) {
			console.warn('[DRIP] folder embedding clear on rebuild failed', err && err.message);
		}
		try {
			require('./embeddings/headingEmbeddingFaiss').deleteFaissArtifacts(kbRootUri);
		} catch (err) {
			console.warn('[DRIP] FAISS cleanup on rebuild failed', err && err.message);
		}
		handle.db.run('DELETE FROM searchtags');
		handle.db.run('DELETE FROM relations');
		handle.db.run('DELETE FROM heading_references');
		for (const table of TYPED_METADATA_TABLES) {
			handle.db.run(`DELETE FROM ${table}`);
		}
		handle.db.run(`DELETE FROM ${REMAINING_METADATA_TABLE}`);
		handle.db.run('DELETE FROM headings');
		handle.db.run('DELETE FROM files');
		const tagIdByLower = syncTagsTableFromGraph(handle.db, context, { replaceAll: true });
		const { metadataTypeIdByLower, relationTypeIdByLower } = loadTypeLookupMaps(handle.db);

		await forEachKnowledgeBaseNote(
			kbRootUri,
			async note => {
				if (!note?.uri?.fsPath || !note.text) {
					return;
				}

				const relPath = normalizeRelPath(kbRootUri.fsPath, note.uri.fsPath);
				let stat;
				try {
					stat = await vscode.workspace.fs.stat(note.uri);
				} catch {
					stat = undefined;
				}

				const parsed = parseNoteForIndex(
					note.text,
					relPath,
					path.basename(note.uri.fsPath),
					{
						ctimeMs: stat?.ctime,
						mtimeMs: stat?.mtime
					},
					{ knownTagsLower }
				);

				let fileId = parsed.fileId;
				if (fileId == null || !Number.isFinite(fileId) || fileId < 0 || usedFileIds.has(fileId)) {
					fileId = nextFileId;
					nextFileId += 1;
				} else {
					nextFileId = Math.max(nextFileId, fileId + 1);
				}
				usedFileIds.add(fileId);

				handle.db.run(
					`INSERT INTO files (id, path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
					[
						fileId,
						parsed.file.path,
						parsed.file.name,
						parsed.file.created_at,
						parsed.file.updated_at
					]
				);

				insertParsedHeadingsAndReferences(
					handle.db,
					fileId,
					parsed,
					tagIdByLower,
					metadataTypeIdByLower,
					relationTypeIdByLower
				);
			},
			{ yieldEvery: 20 }
		);

		handle.db.run('COMMIT');
		const maxRow = queryOne(handle.db, 'SELECT COALESCE(MAX(id), -1) FROM files', []);
		const nextFileIdCounter = maxRow ? Number(maxRow[0]) + 1 : 0;
		handle.db.run(`INSERT OR REPLACE INTO index_meta(key, value) VALUES ('next_file_id', ?)`, [
			String(nextFileIdCounter)
		]);
		await handle.save();
	} catch (err) {
		try {
			handle.db.run('ROLLBACK');
		} catch {
			// ignore rollback failure
		}
		throw err;
	} finally {
		handle.close();
	}
}

/**
 * Write parsed note rows into an open transaction (caller owns BEGIN/COMMIT).
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {string} relPath
 * @param {ReturnType<typeof parseNoteForIndex>} parsed
 * @param {import('vscode').ExtensionContext | null | undefined} [context]
 * @param {{ incremental?: boolean, embeddingUpserts?: { fileId: number, headingId: number }[] }} [options]
 * @returns {number} resolved file id
 */
function applyParsedNoteToIndex(db, relPath, parsed, context, options) {
	const normalizedPath = String(relPath || '').replace(/\\/g, '/');
	const incremental = !(options && options.incremental === false);
	const embeddingUpserts =
		options && Array.isArray(options.embeddingUpserts) ? options.embeddingUpserts : null;
	const tagIdByLower = syncTagsTableFromGraph(db, context);
	const { metadataTypeIdByLower, relationTypeIdByLower } = loadTypeLookupMaps(db);

	const existing = queryOne(db, 'SELECT id FROM files WHERE path = ?', [normalizedPath]);
	let fileId = parsed.fileId;
	if (existing) {
		fileId = Number(existing[0]);
		db.run(`UPDATE files SET name = ?, updated_at = ? WHERE id = ?`, [
			parsed.file.name,
			parsed.file.updated_at,
			fileId
		]);

		if (incremental && parsed._parseMode === 'incremental-subtree') {
			const dirtyIds = Array.isArray(parsed._dirtyHeadingIds)
				? [...new Set(parsed._dirtyHeadingIds.map(Number).filter(Number.isFinite))]
				: findDirtyHeadingIdsByHash(db, fileId, parsed.headings || []);
			if (dirtyIds.length) {
				const dirtySet = new Set(dirtyIds);
				/** @type {Set<number>} */
				const upsertSet = new Set();
				for (const headingId of dirtyIds) {
					const stillPresent = (parsed.headings || []).some(
						h => Number(h.heading_id) === Number(headingId)
					);
					if (!stillPresent) {
						deleteHeadingScopedRows(db, fileId, headingId);
						continue;
					}
					const plan = planHeadingEmbeddingRewrite(db, fileId, headingId, parsed);
					if (plan.needUpsert) {
						upsertSet.add(headingId);
					}
					deleteHeadingScopedRows(db, fileId, headingId, {
						keepEmbedding: plan.keepEmbedding
					});
				}
				const slice = filterParsedByHeadingIds(parsed, dirtySet);
				insertParsedHeadingsAndReferences(
					db,
					fileId,
					slice,
					tagIdByLower,
					metadataTypeIdByLower,
					relationTypeIdByLower
				);
				if (embeddingUpserts) {
					for (const headingId of upsertSet) {
						embeddingUpserts.push({ fileId, headingId });
					}
				}
			}
		} else {
			// A full parse (including reconcile-update) replaces this file's derived rows.
			// This guarantees metadata-only changes cannot be hidden by a stale identity hash.
			deleteFileHeadingScopedRows(db, fileId);
			insertParsedHeadingsAndReferences(
				db,
				fileId,
				parsed,
				tagIdByLower,
				metadataTypeIdByLower,
				relationTypeIdByLower
			);
			if (embeddingUpserts) {
				embeddingUpserts.push(...collectAllHeadingEmbeddingTargets(fileId, parsed));
			}
		}
	} else {
		if (fileId == null || !Number.isFinite(fileId) || fileId < 0) {
			const maxRow = queryOne(db, 'SELECT COALESCE(MAX(id), -1) FROM files', []);
			const maxId = maxRow ? Number(maxRow[0]) : -1;
			fileId = Math.max(0, maxId + 1);
		} else {
			const idOwner = queryOne(db, 'SELECT path FROM files WHERE id = ?', [fileId]);
			if (idOwner && String(idOwner[0] || '').replace(/\\/g, '/') !== normalizedPath) {
				const maxRow = queryOne(db, 'SELECT COALESCE(MAX(id), -1) FROM files', []);
				const maxId = maxRow ? Number(maxRow[0]) : -1;
				fileId = Math.max(0, maxId + 1);
			}
		}
		db.run(
			`INSERT INTO files (id, path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
			[
				fileId,
				parsed.file.path,
				parsed.file.name,
				parsed.file.created_at,
				parsed.file.updated_at
			]
		);
		insertParsedHeadingsAndReferences(
			db,
			fileId,
			parsed,
			tagIdByLower,
			metadataTypeIdByLower,
			relationTypeIdByLower
		);
		if (embeddingUpserts) {
			embeddingUpserts.push(...collectAllHeadingEmbeddingTargets(fileId, parsed));
		}
	}

	bumpNextFileIdCounter(db, fileId);
	return fileId;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} relPath
 */
async function removeFileFromDripIndex(kbRootUri, relPath) {
	const normalized = String(relPath || '').replace(/\\/g, '/');
	const handle = await openDripIndexDb(kbRootUri);
	try {
		const row = queryOne(handle.db, 'SELECT id FROM files WHERE path = ?', [normalized]);
		if (!row) {
			return;
		}
		const fileId = Number(row[0]);
		handle.db.run('BEGIN');
		deleteFileHeadingScopedRows(handle.db, fileId);
		handle.db.run('DELETE FROM heading_references WHERE target_file_id = ?', [fileId]);
		handle.db.run('DELETE FROM files WHERE id = ?', [fileId]);
		handle.db.run('COMMIT');
		await handle.save();
	} catch (err) {
		try {
			handle.db.run('ROLLBACK');
		} catch {
			// ignore
		}
		throw err;
	} finally {
		handle.close();
	}
}

/**
 * Look up a `files` row by sequential id.
 * @param {import('vscode').Uri} kbRootUri
 * @param {number} fileId
 * @returns {Promise<{ id: number, path: string, name: string } | null>}
 */
async function lookupFileRowById(kbRootUri, fileId) {
	const id = Math.floor(Number(fileId));
	if (!Number.isFinite(id) || id < 0) {
		return null;
	}
	const handle = await openDripIndexDb(kbRootUri);
	try {
		const row = queryOne(handle.db, 'SELECT id, path, name FROM files WHERE id = ?', [id]);
		if (!row) {
			return null;
		}
		return {
			id: Number(row[0]),
			path: String(row[1] || '').replace(/\\/g, '/'),
			name: String(row[2] || '')
		};
	} finally {
		handle.close();
	}
}

/**
 * Bind `fileId` to this parsed note path and replace all heading-scoped rows.
 * Used by unwired `reconcileUpdate` (reclaim / first insert / new id).
 *
 * @param {import('./db/dripSqlite').DripSqliteDatabase} db
 * @param {number} fileId
 * @param {ReturnType<typeof parseNoteForIndex>} parsed
 * @param {import('vscode').ExtensionContext | null | undefined} [context]
 * @param {{ embeddingUpserts?: { fileId: number, headingId: number }[] }} [options]
 * @returns {number}
 */
function replaceParsedNoteAtFileId(db, fileId, parsed, context, options) {
	const id = Math.floor(Number(fileId));
	const normalizedPath = String((parsed && parsed.file && parsed.file.path) || '').replace(/\\/g, '/');
	const embeddingUpserts =
		options && Array.isArray(options.embeddingUpserts) ? options.embeddingUpserts : null;
	const tagIdByLower = syncTagsTableFromGraph(db, context);
	const { metadataTypeIdByLower, relationTypeIdByLower } = loadTypeLookupMaps(db);

	const pathOwner = queryOne(db, 'SELECT id FROM files WHERE path = ?', [normalizedPath]);
	if (pathOwner) {
		const ownerId = Number(pathOwner[0]);
		if (Number.isFinite(ownerId) && ownerId !== id) {
			deleteFileHeadingScopedRows(db, ownerId);
			db.run('DELETE FROM heading_references WHERE target_file_id = ?', [ownerId]);
			db.run('DELETE FROM files WHERE id = ?', [ownerId]);
		}
	}

	const existing = queryOne(db, 'SELECT id FROM files WHERE id = ?', [id]);
	if (existing) {
		db.run(`UPDATE files SET path = ?, name = ?, updated_at = ? WHERE id = ?`, [
			normalizedPath,
			parsed.file.name,
			parsed.file.updated_at,
			id
		]);
		deleteFileHeadingScopedRows(db, id);
	} else {
		db.run(
			`INSERT INTO files (id, path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
			[
				id,
				normalizedPath,
				parsed.file.name,
				parsed.file.created_at,
				parsed.file.updated_at
			]
		);
	}

	insertParsedHeadingsAndReferences(
		db,
		id,
		parsed,
		tagIdByLower,
		metadataTypeIdByLower,
		relationTypeIdByLower
	);
	if (embeddingUpserts) {
		embeddingUpserts.push(...collectAllHeadingEmbeddingTargets(id, parsed));
	}
	bumpNextFileIdCounter(db, id);
	return id;
}

/**
 * Create an empty index.drip SQLite file with schema when missing.
 * @param {import('vscode').Uri} kbRootUri
 */
async function initEmptyDripIndexFile(kbRootUri) {
	const handle = await openDripIndexDb(kbRootUri);
	try {
		await handle.save();
	} finally {
		handle.close();
	}
}

/**
 * Delete `<kb>/.dripindex/index.drip` and create a fresh empty schema.
 * @param {import('vscode').Uri} kbRootUri
 */
async function resetDripIndexDatabase(kbRootUri) {
	const indexUri = getIndexDbUri(kbRootUri);
	try {
		await vscode.workspace.fs.delete(indexUri, { useTrash: false });
	} catch {
		// missing is fine
	}
	try {
		const { clearHeadingEmbeddingSearchLock } = require('./embeddings/headingEmbeddingSearchMethod');
		clearHeadingEmbeddingSearchLock(kbRootUri);
	} catch {
		/* optional */
	}
	await initEmptyDripIndexFile(kbRootUri);
}

module.exports = {
	SCHEMA_VERSION,
	allocateNextFileEntityNumber,
	allocateHeadingIdForFile,
	applyParsedNoteToIndex,
	collectKnownTagNamesLower,
	dripIndexNeedsRebuild,
	getIndexDbUri,
	initEmptyDripIndexFile,
	listDiskNotePaths,
	listIndexedFilePaths,
	lookupFileRowById,
	openDripIndexDb,
	rebuildDripIndex,
	replaceParsedNoteAtFileId,
	resetDripIndexDatabase,
	recomputeHeadingAllocatorState,
	syncFileHeadingAllocatorFromUsedIds,
	readFileHeadingAllocator,
	writeFileHeadingAllocator,
	allocateWorkflowTaskId,
	syncWorkflowTaskAllocatorFromUsedIds,
	readWorkflowTaskAllocator,
	writeWorkflowTaskAllocator,
	resolveSequentialFileEntityForKbNote,
	removeFileFromDripIndex
};
