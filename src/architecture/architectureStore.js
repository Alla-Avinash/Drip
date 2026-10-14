'use strict';

/**
 * Project Architecture data layer.
 *
 * Each project keeps its own architecture model inside `<project>/_architecture/`:
 *   - `architecture.drip` — SQLite (entities + relationships + layout positions)
 *   - `components/*.d.md` and `implementations/*.d.md` — human-readable descriptions
 *
 * Features are not authored here: they are the project's real `.f` features, mirrored
 * into the entity table as read-only nodes so the graph can group components under them.
 */

const vscode = require('vscode');
const path = require('path');
const { openDripSqlite } = require('../indexing/db/dripSqlite');
const { ensureArchitectureSchema } = require('./architectureSchema');
const { formatFileHeaderComment, reconcileMdNoteFileHeader } = require('../document/model/dripMdNoteFileHeader');

const ARCHITECTURE_FOLDER = '_architecture';
const ARCHITECTURE_DB_FILE = 'architecture.drip';

/** Which subfolder a given entity type's `.d.md` description lives in. */
const TYPE_FILE_DIR = {
	component: 'components',
	subcomponent: 'components',
	implementation: 'implementations'
};

/** Id prefix per entity type. */
const TYPE_ID_PREFIX = {
	feature: 'feat',
	component: 'comp',
	subcomponent: 'sub',
	implementation: 'impl'
};

/**
 * @param {string} raw
 * @returns {string}
 */
function slugFor(raw) {
	return (
		String(raw || '')
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'untitled'
	);
}

/**
 * @param {string} type
 * @returns {string}
 */
function newEntityId(type) {
	const prefix = TYPE_ID_PREFIX[type] || 'ent';
	return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Stable id for a real project feature (read-only node).
 * @param {{ folderPrefix?: string | null, path?: string, title?: string }} feature
 * @returns {string}
 */
function featureEntityId(feature) {
	const key = String(feature.folderPrefix || feature.path || feature.title || '').replace(/\\/g, '/');
	return `feat-${slugFor(key)}`;
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @returns {import('vscode').Uri}
 */
function architectureFolderUri(kbRootUri, folderPrefix) {
	const parts = String(folderPrefix || '')
		.replace(/\\/g, '/')
		.replace(/\/+$/, '')
		.split('/')
		.filter(Boolean);
	return vscode.Uri.joinPath(kbRootUri, ...parts, ARCHITECTURE_FOLDER);
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @returns {import('vscode').Uri}
 */
function architectureDbUri(kbRootUri, folderPrefix) {
	return vscode.Uri.joinPath(architectureFolderUri(kbRootUri, folderPrefix), ARCHITECTURE_DB_FILE);
}

/**
 * Open (or create) the project's architecture database, ensuring its schema.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 */
function openArchitectureDb(kbRootUri, folderPrefix) {
	const uri = architectureDbUri(kbRootUri, folderPrefix);
	const db = openDripSqlite(uri.fsPath);
	ensureArchitectureSchema(db);
	return { db, uri };
}

/**
 * A description path (relative to the project folder) that does not collide with an
 * existing file.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} type
 * @param {string} name
 * @returns {Promise<string>}
 */
async function uniqueDescriptionRelPath(kbRootUri, folderPrefix, type, name) {
	const dir = TYPE_FILE_DIR[type] || 'components';
	const base = slugFor(name);
	let rel = `${dir}/${base}.d.md`;
	let i = 2;
	for (;;) {
		const uri = vscode.Uri.joinPath(architectureFolderUri(kbRootUri, folderPrefix), ...rel.split('/'));
		try {
			await vscode.workspace.fs.stat(uri);
		} catch {
			return rel;
		}
		rel = `${dir}/${base}-${i}.d.md`;
		i += 1;
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} rel
 * @returns {import('vscode').Uri}
 */
function descriptionFileUri(kbRootUri, folderPrefix, rel) {
	const parts = String(rel || '')
		.replace(/\\/g, '/')
		.split('/')
		.filter(Boolean);
	return vscode.Uri.joinPath(architectureFolderUri(kbRootUri, folderPrefix), ...parts);
}

/**
 * Write a fresh `.d.md` description file for a new entity.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} type
 * @param {string} name
 * @returns {Promise<string>} description path relative to the project folder
 */
async function writeDescriptionFile(kbRootUri, folderPrefix, type, name) {
	const trimmed = String(name || '').trim() || 'Untitled';
	const rel = await uniqueDescriptionRelPath(kbRootUri, folderPrefix, type, trimmed);
	await writeDescriptionFileTo(kbRootUri, folderPrefix, rel, trimmed);
	return rel;
}

/**
 * Write a minimal `.d.md` description file at a specific (already-allocated) path.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} rel
 * @param {string} name
 */
async function writeDescriptionFileTo(kbRootUri, folderPrefix, rel, name) {
	const trimmed = String(name || '').trim() || 'Untitled';
	const uri = descriptionFileUri(kbRootUri, folderPrefix, rel);
	await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
	const content = `${formatFileHeaderComment({ filename: trimmed, fileid: '', headings: 0 })}\n# ${trimmed}\n\n`;
	await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {object} features from `listProjectChildrenFromIndex`
 * @returns {Promise<{ nodes: object[], links: object[] }>}
 */
async function loadGraph(kbRootUri, folderPrefix, features) {
	const { db } = openArchitectureDb(kbRootUri, folderPrefix);
	try {
		// Mirror the project's real features as read-only nodes (upsert by stable id).
		const upsertFeature = db.native.prepare(
			`INSERT INTO entities (entity_id, entity_type, name, description_file, status)
			 VALUES (?, 'feature', ?, '', 'active')
			 ON CONFLICT(entity_id) DO UPDATE SET name = excluded.name`
		);
		for (const f of features || []) {
			upsertFeature.run(featureEntityId(f), String(f.title || 'Untitled'));
		}

		const nodes = db.native
			.prepare(
				`SELECT entity_id AS id, entity_type AS type, name, parent_id AS parentId,
				        feature_id AS featureId, description_file AS descriptionFile, x, y
				 FROM entities
				 ORDER BY entity_type, LOWER(name)`
			)
			.all();

		// Implementations with at least one saved workflow step count as "already
		// have a workflow" — the UI shows Play/Edit instead of Create for those.
		const wfRows = db.native
			.prepare(`SELECT DISTINCT workflow_id AS id FROM workflow_steps`)
			.all();
		const hasWorkflow = new Set(wfRows.map(r => String(r.id)));
		for (const n of nodes) {
			n.hasWorkflow = n.type === 'implementation' && hasWorkflow.has(String(n.id));
		}

		const links = db.native
			.prepare(`SELECT source_id AS source, relation, target_id AS target FROM relations`)
			.all();
		return { nodes, links };
	} finally {
		db.close();
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {{ type: string, name: string, parentId?: string | null, featureId?: string | null }} opts
 * @returns {Promise<object>} the created node
 */
async function createEntity(kbRootUri, folderPrefix, opts) {
	const type = String(opts.type || 'component');
	const name = String(opts.name || '').trim() || 'Untitled';
	const rel = await writeDescriptionFile(kbRootUri, folderPrefix, type, name);
	const { db } = openArchitectureDb(kbRootUri, folderPrefix);
	try {
		const id = newEntityId(type);
		const parentId = opts.parentId ? String(opts.parentId) : null;
		const featureId = opts.featureId ? String(opts.featureId) : null;
		db.native
			.prepare(
				`INSERT INTO entities (entity_id, entity_type, name, parent_id, feature_id, description_file, status)
				 VALUES (?, ?, ?, ?, ?, ?, 'active')`
			)
			.run(id, type, name, parentId, featureId, rel);
		return { id, type, name, parentId, featureId, descriptionFile: rel, x: null, y: null };
	} finally {
		db.close();
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {{ id: string, name: string }} opts
 */
async function renameEntity(kbRootUri, folderPrefix, opts) {
	const id = String(opts.id || '');
	const name = String(opts.name || '').trim();
	if (!id || !name) return;
	const { db } = openArchitectureDb(kbRootUri, folderPrefix);
	try {
		const row = db.native
			.prepare(`SELECT description_file AS rel FROM entities WHERE entity_id = ?`)
			.get(id);
		db.native.prepare(`UPDATE entities SET name = ? WHERE entity_id = ?`).run(name, id);
		if (row && row.rel) {
			const uri = descriptionFileUri(kbRootUri, folderPrefix, row.rel);
			try {
				const buf = await vscode.workspace.fs.readFile(uri);
				const text = Buffer.from(buf).toString('utf8').replace(/\r\n/g, '\n');
				const { headerLines, bodyStartLineIndex } = reconcileMdNoteFileHeader(text, { fileStem: name });
				const lines = text.split('\n');
				const next = headerLines.concat(lines.slice(bodyStartLineIndex)).join('\n');
				await vscode.workspace.fs.writeFile(uri, Buffer.from(next, 'utf8'));
			} catch {
				/* description file missing — leave it */
			}
		}
	} finally {
		db.close();
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {{ id: string }} opts
 */
async function deleteEntity(kbRootUri, folderPrefix, opts) {
	const id = String(opts.id || '');
	if (!id) return;
	const { db } = openArchitectureDb(kbRootUri, folderPrefix);
	try {
		const all = db.native
			.prepare(`SELECT entity_id AS id, parent_id AS parentId, description_file AS rel FROM entities`)
			.all();
		const childrenOf = new Map();
		for (const r of all) {
			const p = String(r.parentId || '');
			if (!childrenOf.has(p)) childrenOf.set(p, []);
			childrenOf.get(p).push(r);
		}
		const toDelete = new Set();
		(function collect(eid) {
			if (!eid || toDelete.has(eid)) return;
			toDelete.add(eid);
			for (const c of childrenOf.get(eid) || []) collect(c.id);
		})(id);

		const delRel = db.native.prepare(`DELETE FROM relations WHERE source_id = ? OR target_id = ?`);
		const delEnt = db.native.prepare(`DELETE FROM entities WHERE entity_id = ?`);
		for (const eid of toDelete) {
			delRel.run(eid, eid);
			delEnt.run(eid);
		}

		for (const r of all) {
			if (toDelete.has(r.id) && r.rel) {
				const uri = descriptionFileUri(kbRootUri, folderPrefix, r.rel);
				try {
					await vscode.workspace.fs.delete(uri, { useTrash: false });
				} catch {
					/* missing file is fine */
				}
			}
		}
	} finally {
		db.close();
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {{ id: string, x: number, y: number }} opts
 */
async function moveEntity(kbRootUri, folderPrefix, opts) {
	const id = String(opts.id || '');
	if (!id) return;
	const { db } = openArchitectureDb(kbRootUri, folderPrefix);
	try {
		db.native
			.prepare(`UPDATE entities SET x = ?, y = ? WHERE entity_id = ?`)
			.run(Number(opts.x) || 0, Number(opts.y) || 0, id);
	} finally {
		db.close();
	}
}

/**
 * Re-parent a sub-component (or an implementation) under a different component.
 * Sub-components can nest to any depth (multi-level component hierarchy).
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {{ id: string, parentId: string | null }} opts
 */
async function setParent(kbRootUri, folderPrefix, opts) {
	const id = String(opts.id || '');
	const parentId = opts.parentId ? String(opts.parentId) : null;
	if (!id) return;
	const { db } = openArchitectureDb(kbRootUri, folderPrefix);
	try {
		db.native
			.prepare(`UPDATE entities SET parent_id = ? WHERE entity_id = ? AND entity_type IN ('subcomponent', 'implementation')`)
			.run(parentId, id);
	} finally {
		db.close();
	}
}

/**
 * Assign (or detach) an entity to a feature.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {{ id: string, featureId: string | null }} opts
 */
async function setFeature(kbRootUri, folderPrefix, opts) {
	const id = String(opts.id || '');
	const featureId = opts.featureId ? String(opts.featureId) : null;
	if (!id) return;
	const { db } = openArchitectureDb(kbRootUri, folderPrefix);
	try {
		db.native
			.prepare(`UPDATE entities SET feature_id = ? WHERE entity_id = ?`)
			.run(featureId, id);
	} finally {
		db.close();
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {{ from: string, to: string, relation?: string }} opts
 */
async function addLink(kbRootUri, folderPrefix, opts) {
	const from = String(opts.from || '');
	const to = String(opts.to || '');
	const relation = String(opts.relation || 'uses');
	if (!from || !to || from === to) return;
	const { db } = openArchitectureDb(kbRootUri, folderPrefix);
	try {
		db.native
			.prepare(`INSERT OR IGNORE INTO relations (source_id, relation, target_id) VALUES (?, ?, ?)`)
			.run(from, relation, to);
	} finally {
		db.close();
	}
}

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {{ from: string, to: string, relation?: string }} opts
 */
async function removeLink(kbRootUri, folderPrefix, opts) {
	const from = String(opts.from || '');
	const to = String(opts.to || '');
	const relation = String(opts.relation || 'uses');
	if (!from || !to) return;
	const { db } = openArchitectureDb(kbRootUri, folderPrefix);
	try {
		db.native
			.prepare(`DELETE FROM relations WHERE source_id = ? AND relation = ? AND target_id = ?`)
			.run(from, relation, to);
	} finally {
		db.close();
	}
}

module.exports = {
	ARCHITECTURE_FOLDER,
	ARCHITECTURE_DB_FILE,
	architectureFolderUri,
	architectureDbUri,
	descriptionFileUri,
	featureEntityId,
	writeDescriptionFile,
	writeDescriptionFileTo,
	loadGraph,
	createEntity,
	renameEntity,
	deleteEntity,
	moveEntity,
	setParent,
	setFeature,
	addLink,
	removeLink
};
