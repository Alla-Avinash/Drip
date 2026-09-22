'use strict';

/**
 * Persisted FAISS HNSW acceleration index for heading embeddings.
 *
 * SQLite (`heading_embedding_vectors`) remains authoritative.
 * FAISS is rebuildable sidecar under `.dripindex/`:
 *   heading-embeddings.faiss
 *   heading-embeddings.faiss.json
 *
 * FAISS row labels are 0..n-1; sidecar `embeddingIds[label]` maps to SQLite embedding_id.
 * `faiss-node` is required lazily so KBs locked to `exact` never pay the ~50MB native cost.
 */

const fs = require('fs');
const path = require('path');
const {
	getEmbeddingMeta,
	countHeadingEmbeddings,
	listAllHeadingEmbeddings,
	getHeadingEmbeddingVector,
	getEmbeddingId
} = require('./headingEmbeddingStore');

const FAISS_INDEX_BASENAME = 'heading-embeddings.faiss';
const FAISS_MANIFEST_BASENAME = 'heading-embeddings.faiss.json';
const HNSW_FACTORY = 'HNSW32,Flat';
const SAVE_DEBOUNCE_MS = 2000;
const MANIFEST_VERSION = 1;

/**
 * @typedef {{
 *   version: number,
 *   model: string,
 *   dimensions: number,
 *   generation: string,
 *   formatVersion: string,
 *   vectorCount: number,
 *   factory: string,
 *   metric: string,
 *   embeddingIds: number[],
 *   updatedAt: number
 * }} HeadingFaissManifest
 *
 * @typedef {{
 *   index: import('faiss-node').Index,
 *   embeddingIds: number[],
 *   manifest: HeadingFaissManifest,
 *   dirty: boolean,
 *   saveTimer: NodeJS.Timeout | null
 * }} HeadingFaissSession
 */

/** @type {Map<string, HeadingFaissSession>} */
const sessionsByKb = new Map();

/** @type {typeof import('faiss-node') | null | undefined} */
let faissModuleCache;

/**
 * @param {import('vscode').Uri | string | null | undefined} kbRootUri
 */
function kbFsPath(kbRootUri) {
	if (!kbRootUri) return '';
	if (typeof kbRootUri === 'string') return kbRootUri;
	return String(kbRootUri.fsPath || '');
}

/**
 * @param {string} kbRoot
 */
function dripIndexDir(kbRoot) {
	return path.join(kbRoot, '.dripindex');
}

/**
 * @param {string} kbRoot
 */
function faissIndexPath(kbRoot) {
	return path.join(dripIndexDir(kbRoot), FAISS_INDEX_BASENAME);
}

/**
 * @param {string} kbRoot
 */
function faissManifestPath(kbRoot) {
	return path.join(dripIndexDir(kbRoot), FAISS_MANIFEST_BASENAME);
}

/**
 * Lazy-load faiss-node. Returns null if unavailable.
 * @returns {typeof import('faiss-node') | null}
 */
function loadFaissModule() {
	if (faissModuleCache !== undefined) {
		return faissModuleCache;
	}
	try {
		faissModuleCache = require('faiss-node');
		return faissModuleCache;
	} catch (err) {
		console.warn('[DRIP] faiss-node unavailable; FAISS path disabled', err && err.message);
		faissModuleCache = null;
		return null;
	}
}

/**
 * @param {string} kbRoot
 * @returns {HeadingFaissManifest | null}
 */
function readManifest(kbRoot) {
	const p = faissManifestPath(kbRoot);
	if (!fs.existsSync(p)) {
		return null;
	}
	try {
		const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
		if (!raw || typeof raw !== 'object') {
			return null;
		}
		const embeddingIds = Array.isArray(raw.embeddingIds)
			? raw.embeddingIds.map(Number).filter(n => Number.isFinite(n))
			: [];
		return {
			version: Number(raw.version) || 0,
			model: String(raw.model || ''),
			dimensions: Number(raw.dimensions) || 0,
			generation: String(raw.generation || ''),
			formatVersion: String(raw.formatVersion || ''),
			vectorCount: Number(raw.vectorCount) || embeddingIds.length,
			factory: String(raw.factory || HNSW_FACTORY),
			metric: String(raw.metric || 'L2'),
			embeddingIds,
			updatedAt: Number(raw.updatedAt) || 0
		};
	} catch (err) {
		console.warn('[DRIP] FAISS manifest unreadable', err && err.message);
		return null;
	}
}

/**
 * @param {string} kbRoot
 * @param {HeadingFaissManifest} manifest
 */
function writeManifestAtomic(kbRoot, manifest) {
	const dir = dripIndexDir(kbRoot);
	fs.mkdirSync(dir, { recursive: true });
	const target = faissManifestPath(kbRoot);
	const tmp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(manifest, null, '\t'), 'utf8');
	fs.renameSync(tmp, target);
}

/**
 * @param {string} kbRoot
 * @param {import('faiss-node').Index} index
 */
function writeIndexAtomic(kbRoot, index) {
	const dir = dripIndexDir(kbRoot);
	fs.mkdirSync(dir, { recursive: true });
	const target = faissIndexPath(kbRoot);
	const tmp = `${target}.${process.pid}.tmp`;
	index.write(tmp);
	fs.renameSync(tmp, target);
}

/**
 * @param {HeadingFaissManifest | null} manifest
 * @param {{ model: string, dimensions: number, generation: string, formatVersion: string }} meta
 * @param {number} vectorCount
 */
function isManifestInSync(manifest, meta, vectorCount) {
	if (!manifest) {
		return false;
	}
	return (
		manifest.version === MANIFEST_VERSION &&
		manifest.model === meta.model &&
		manifest.dimensions === meta.dimensions &&
		manifest.generation === meta.generation &&
		manifest.formatVersion === meta.formatVersion &&
		manifest.factory === HNSW_FACTORY &&
		manifest.vectorCount === vectorCount &&
		manifest.embeddingIds.length === vectorCount
	);
}

/**
 * @param {string} kbRoot
 * @param {HeadingFaissSession} session
 */
function scheduleSave(kbRoot, session) {
	session.dirty = true;
	if (session.saveTimer) {
		clearTimeout(session.saveTimer);
	}
	session.saveTimer = setTimeout(() => {
		session.saveTimer = null;
		try {
			persistSession(kbRoot, session);
		} catch (err) {
			console.error('[DRIP] FAISS save failed', err);
		}
	}, SAVE_DEBOUNCE_MS);
	if (typeof session.saveTimer.unref === 'function') {
		session.saveTimer.unref();
	}
}

/**
 * @param {string} kbRoot
 * @param {HeadingFaissSession} session
 */
function persistSession(kbRoot, session) {
	const meta = session.manifest;
	/** @type {HeadingFaissManifest} */
	const next = {
		version: MANIFEST_VERSION,
		model: meta.model,
		dimensions: meta.dimensions,
		generation: meta.generation,
		formatVersion: meta.formatVersion,
		vectorCount: session.embeddingIds.length,
		factory: HNSW_FACTORY,
		metric: 'L2',
		embeddingIds: session.embeddingIds.slice(),
		updatedAt: Date.now()
	};
	writeIndexAtomic(kbRoot, session.index);
	writeManifestAtomic(kbRoot, next);
	session.manifest = next;
	session.dirty = false;
	console.log(`[DRIP] FAISS index saved: vectors=${next.vectorCount}`);
}

/**
 * Build HNSW from all sqlite-vec rows and replace session + disk files.
 * @param {import('vscode').Uri | string} kbRootUri
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @returns {HeadingFaissSession | null}
 */
function rebuildFaissFromDb(kbRootUri, db) {
	const kbRoot = kbFsPath(kbRootUri);
	if (!kbRoot) {
		return null;
	}
	const faiss = loadFaissModule();
	if (!faiss) {
		return null;
	}

	const meta = getEmbeddingMeta(db);
	const rows = listAllHeadingEmbeddings(db);
	const { Index, MetricType } = faiss;
	const index = Index.fromFactory(meta.dimensions, HNSW_FACTORY, MetricType.METRIC_L2);

	/** @type {number[]} */
	const embeddingIds = [];
	if (rows.length) {
		const flat = [];
		for (const row of rows) {
			for (const v of row.embedding) {
				flat.push(v);
			}
			embeddingIds.push(row.embedding_id);
		}
		if (!index.isTrained()) {
			index.train(flat);
		}
		index.add(flat);
	}

	/** @type {HeadingFaissManifest} */
	const manifest = {
		version: MANIFEST_VERSION,
		model: meta.model,
		dimensions: meta.dimensions,
		generation: meta.generation,
		formatVersion: meta.formatVersion,
		vectorCount: embeddingIds.length,
		factory: HNSW_FACTORY,
		metric: 'L2',
		embeddingIds: embeddingIds.slice(),
		updatedAt: Date.now()
	};

	const prev = sessionsByKb.get(kbRoot);
	if (prev && prev.saveTimer) {
		clearTimeout(prev.saveTimer);
	}

	/** @type {HeadingFaissSession} */
	const session = {
		index,
		embeddingIds,
		manifest,
		dirty: false,
		saveTimer: null
	};
	sessionsByKb.set(kbRoot, session);
	persistSession(kbRoot, session);
	console.log(`[DRIP] FAISS rebuilt from sqlite-vec: vectors=${embeddingIds.length}`);
	return session;
}

/**
 * Load disk FAISS if in sync with DB; otherwise rebuild.
 * @param {import('vscode').Uri | string} kbRootUri
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @returns {HeadingFaissSession | null}
 */
function ensureFaissSession(kbRootUri, db) {
	const kbRoot = kbFsPath(kbRootUri);
	if (!kbRoot) {
		return null;
	}

	const existing = sessionsByKb.get(kbRoot);
	if (existing && !existing.dirty) {
		const meta = getEmbeddingMeta(db);
		const vectorCount = countHeadingEmbeddings(db);
		if (
			isManifestInSync(existing.manifest, meta, vectorCount) &&
			existing.embeddingIds.length === vectorCount &&
			existing.index.ntotal() === vectorCount
		) {
			return existing;
		}
	}

	const faiss = loadFaissModule();
	if (!faiss) {
		return null;
	}

	const meta = getEmbeddingMeta(db);
	const vectorCount = countHeadingEmbeddings(db);
	const manifest = readManifest(kbRoot);
	const indexFile = faissIndexPath(kbRoot);

	if (isManifestInSync(manifest, meta, vectorCount) && fs.existsSync(indexFile)) {
		try {
			const index = faiss.Index.read(indexFile);
			if (index.ntotal() === vectorCount && manifest) {
				const prev = sessionsByKb.get(kbRoot);
				if (prev && prev.saveTimer) {
					clearTimeout(prev.saveTimer);
				}
				/** @type {HeadingFaissSession} */
				const session = {
					index,
					embeddingIds: manifest.embeddingIds.slice(),
					manifest,
					dirty: false,
					saveTimer: null
				};
				sessionsByKb.set(kbRoot, session);
				console.log(`[DRIP] FAISS loaded from disk: vectors=${vectorCount}`);
				return session;
			}
		} catch (err) {
			console.warn('[DRIP] FAISS load failed; will rebuild', err && err.message);
		}
	}

	return rebuildFaissFromDb(kbRootUri, db);
}

/**
 * ANN search. Returns embedding_id + L2 distance (FAISS METRIC_L2).
 * @param {import('vscode').Uri | string} kbRootUri
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number[] | Float32Array} query
 * @param {number} k
 * @returns {{ embedding_id: number, distance: number }[]}
 */
function searchFaiss(kbRootUri, db, query, k) {
	const session = ensureFaissSession(kbRootUri, db);
	if (!session || session.index.ntotal() === 0) {
		return [];
	}
	const { dimensions } = getEmbeddingMeta(db);
	const values = Array.from(query);
	if (values.length !== dimensions) {
		throw new Error(`searchFaiss: expected ${dimensions} dims, got ${values.length}`);
	}
	const limit = Math.max(1, Math.min(Number(k) || 1, session.embeddingIds.length || 1));
	const result = session.index.search(values, limit);
	/** @type {{ embedding_id: number, distance: number }[]} */
	const hits = [];
	for (let i = 0; i < result.labels.length; i++) {
		const label = Number(result.labels[i]);
		if (!Number.isFinite(label) || label < 0) {
			continue;
		}
		const embeddingId = session.embeddingIds[label];
		if (embeddingId == null) {
			continue;
		}
		hits.push({
			embedding_id: Number(embeddingId),
			distance: Number(result.distances[i])
		});
	}
	return hits;
}

/**
 * After SQLite upsert: sync FAISS session (remove old label if any, add vector).
 * No-op if no session and method not using FAISS yet (rebuild happens on ensure).
 * @param {import('vscode').Uri | string} kbRootUri
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number} embeddingId
 */
function syncFaissAfterUpsert(kbRootUri, db, embeddingId) {
	const kbRoot = kbFsPath(kbRootUri);
	const session = sessionsByKb.get(kbRoot);
	if (!session) {
		return;
	}
	const vector = getHeadingEmbeddingVector(db, embeddingId);
	if (!vector) {
		return;
	}

	const existingLabel = session.embeddingIds.indexOf(Number(embeddingId));
	if (existingLabel >= 0) {
		try {
			session.index.removeIds([existingLabel]);
		} catch (err) {
			console.warn('[DRIP] FAISS removeIds failed; scheduling full rebuild', err && err.message);
			scheduleDebouncedRebuild(kbRootUri);
			return;
		}
		session.embeddingIds.splice(existingLabel, 1);
		// removeIds leaves holes in FAISS label space; safest is full rebuild.
		scheduleDebouncedRebuild(kbRootUri);
		return;
	}

	try {
		session.index.add(vector);
		session.embeddingIds.push(Number(embeddingId));
		session.manifest.vectorCount = session.embeddingIds.length;
		scheduleSave(kbRoot, session);
	} catch (err) {
		console.warn('[DRIP] FAISS add failed; scheduling full rebuild', err && err.message);
		scheduleDebouncedRebuild(kbRootUri);
	}
}

/**
 * @param {import('vscode').Uri | string} kbRootUri
 * @param {number} embeddingId
 */
function syncFaissAfterDelete(kbRootUri, embeddingId) {
	const kbRoot = kbFsPath(kbRootUri);
	const session = sessionsByKb.get(kbRoot);
	if (!session) {
		return;
	}
	const label = session.embeddingIds.indexOf(Number(embeddingId));
	if (label < 0) {
		return;
	}
	// HNSW removeIds + label remap is unreliable across faiss-node builds — rebuild.
	scheduleDebouncedRebuild(kbRootUri);
}

/** @type {Map<string, NodeJS.Timeout>} */
const rebuildTimers = new Map();

/**
 * @param {import('vscode').Uri | string} kbRootUri
 */
function scheduleDebouncedRebuild(kbRootUri) {
	const key = kbFsPath(kbRootUri);
	if (!key) {
		return;
	}
	const prev = rebuildTimers.get(key);
	if (prev) {
		clearTimeout(prev);
	}
	const timer = setTimeout(() => {
		rebuildTimers.delete(key);
		void (async () => {
			try {
				const { openDripIndexDb } = require('../dripIndexDb');
				const handle = await openDripIndexDb(
					typeof kbRootUri === 'string' ? { fsPath: kbRootUri } : kbRootUri
				);
				try {
					rebuildFaissFromDb(kbRootUri, handle.db);
				} finally {
					handle.close();
				}
			} catch (err) {
				console.error('[DRIP] FAISS debounced rebuild failed', err);
			}
		})();
	}, SAVE_DEBOUNCE_MS);
	if (typeof timer.unref === 'function') {
		timer.unref();
	}
	rebuildTimers.set(key, timer);
}

/**
 * Drop session + delete FAISS files (model change / full embedding wipe).
 * @param {import('vscode').Uri | string} kbRootUri
 */
function deleteFaissArtifacts(kbRootUri) {
	const kbRoot = kbFsPath(kbRootUri);
	clearFaissSession(kbRootUri);
	for (const p of [faissIndexPath(kbRoot), faissManifestPath(kbRoot)]) {
		try {
			if (fs.existsSync(p)) {
				fs.unlinkSync(p);
			}
		} catch (err) {
			console.warn('[DRIP] could not delete FAISS file', p, err && err.message);
		}
	}
}

/**
 * @param {import('vscode').Uri | string} [kbRootUri]
 */
function clearFaissSession(kbRootUri) {
	if (kbRootUri == null || kbRootUri === '') {
		for (const session of sessionsByKb.values()) {
			if (session.saveTimer) {
				clearTimeout(session.saveTimer);
			}
		}
		sessionsByKb.clear();
		for (const t of rebuildTimers.values()) {
			clearTimeout(t);
		}
		rebuildTimers.clear();
		return;
	}
	const key = kbFsPath(kbRootUri);
	const session = sessionsByKb.get(key);
	if (session && session.saveTimer) {
		clearTimeout(session.saveTimer);
	}
	sessionsByKb.delete(key);
	const t = rebuildTimers.get(key);
	if (t) {
		clearTimeout(t);
		rebuildTimers.delete(key);
	}
}

/**
 * Resolve embedding_id for (file, heading) then sync delete — used when caller only has ids.
 * @param {import('vscode').Uri | string} kbRootUri
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number} fileId
 * @param {number} headingId
 */
function syncFaissBeforeHeadingDelete(kbRootUri, db, fileId, headingId) {
	const embeddingId = getEmbeddingId(db, fileId, headingId);
	if (embeddingId != null) {
		syncFaissAfterDelete(kbRootUri, embeddingId);
	}
}

module.exports = {
	FAISS_INDEX_BASENAME,
	FAISS_MANIFEST_BASENAME,
	HNSW_FACTORY,
	MANIFEST_VERSION,
	SAVE_DEBOUNCE_MS,
	loadFaissModule,
	faissIndexPath,
	faissManifestPath,
	readManifest,
	isManifestInSync,
	rebuildFaissFromDb,
	ensureFaissSession,
	searchFaiss,
	syncFaissAfterUpsert,
	syncFaissAfterDelete,
	syncFaissBeforeHeadingDelete,
	scheduleDebouncedRebuild,
	deleteFaissArtifacts,
	clearFaissSession
};
