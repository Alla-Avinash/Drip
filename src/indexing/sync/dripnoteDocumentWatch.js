'use strict';

function getHeadingIdentity() {
	return require('../dripnoteHeadingIdentity');
}

/**
 * What DRIP watches on every KB note edit and when each reaction runs.
 *
 * **Edit here** when adding/removing document surveillance behavior.
 * `dripnoteIndexSync.js` registers VS Code events; this file defines triggers + signatures.
 */
const DOCUMENT_WATCH_MANIFEST = Object.freeze([
	{
		id: 'heading-id-allocate',
		event: 'onDidChangeTextDocument',
		trigger: 'New or stub heading needs `@hN` identity line above `#`/`#N` title',
		check: 'needsHeadingIdentityReconcile(text)',
		action: 'reconcile heading identities (allocate ids)',
		debounceMs: 0
	},
	{
		id: 'heading-hash-refresh',
		event: 'onDidChangeTextDocument',
		trigger: 'Heading title or metadata block changed (`.type`, key-values, tags, relations, ref)',
		check: 'headingMetadataSignature(text) changed vs last seen',
		action: 'reconcile heading identities',
		debounceMs: 400
	},
	{
		id: 'heading-hash-flush-save',
		event: 'onWillSaveTextDocument',
		trigger: 'User saves note',
		check: 'always (KB note)',
		action: 'final identity reconcile before disk write',
		debounceMs: 0
	},
	{
		id: 'index-incremental-subtree-parse',
		event: 'onDidChangeTextDocument (buffered flush)',
		trigger: 'edit line range mapped to shallowest affected heading',
		check: 'reparse tags/refs/typed metadata for that subtree only; reuse cached rows for siblings',
		action: 'merge into in-memory parse cache → incremental DB write for dirty headings',
		debounceMs: 6000
	},
	{
		id: 'index-persist-buffer',
		event: 'onDidChangeTextDocument / onDidSaveTextDocument',
		trigger: 'KB note content changed (index-relevant)',
		check: 'queued in memory; trailing debounce 6s with no further edits',
		action: 'parse note → compare hash signature → write `index.drip` only if changed',
		debounceMs: 6000
	},
	{
		id: 'index-persist-save',
		event: 'onDidSaveTextDocument',
		trigger: 'Note saved to disk',
		check: 'schedules buffered index update (same 6s queue — not immediate DB write)',
		action: 'enqueue parse → `index.drip` flush after debounce',
		debounceMs: 6000
	},
	{
		id: 'fileid-realign-open',
		event: 'onDidOpenTextDocument',
		trigger: 'Clean KB note opened',
		check: 'header `fileid:` drifts from index.drip path mapping',
		action: 'normalize fileid + optional link migration + index upsert',
		debounceMs: 0
	},
	{
		id: 'heading-reconcile-open',
		event: 'onDidOpenTextDocument',
		trigger: 'Clean KB note opened',
		check: 'missing/orphan heading identity lines',
		action: 'reconcile identities from disk, upsert index if text changed',
		debounceMs: 0
	},
	{
		id: 'index-persist-flush-close',
		event: 'onDidCloseTextDocument',
		trigger: 'Editor tab closed',
		check: 'pending buffered update exists',
		action: 'immediate flush to `index.drip` (no 6s wait)',
		debounceMs: 0
	},
	{
		id: 'heading-hash-flush-close',
		event: 'onDidCloseTextDocument',
		trigger: 'Editor tab closed with unsaved identity drift',
		check: 'reconciled text differs from buffer on close',
		action: 'write identities to disk + index upsert',
		debounceMs: 0
	},
	{
		id: 'index-rename',
		event: 'onDidRenameFiles',
		trigger: 'KB note path changed',
		check: 'old path was under KB root',
		action: 'remove old index row, upsert at new path',
		debounceMs: 0
	},
	{
		id: 'index-delete',
		event: 'onDidDeleteFiles',
		trigger: 'KB note deleted',
		check: 'path was under KB root',
		action: 'remove file row from index.drip',
		debounceMs: 0
	}
]);

/** Debounce for heading identity refresh while typing (see manifest `heading-hash-refresh`). */
const HEADING_HASH_REFRESH_MS = 400;

/** Trailing debounce before buffered `index.drip` writes (see `dripnoteIndexUpdateQueue.js`). */
const INDEX_UPDATE_BUFFER_MS = 6_000;

/**
 * Signature of heading titles + metadata blocks — schedules in-buffer hash recompute.
 * @param {string} text
 * @returns {string}
 */
function computeMetadataEditSignature(text) {
	const { headingMetadataSignature } = getHeadingIdentity();
	return headingMetadataSignature(text);
}

/**
 * Whether the buffer needs immediate heading id allocation (new titled heading without id).
 * @param {string} text
 * @returns {boolean}
 */
function needsImmediateHeadingIdAllocation(text) {
	const { needsHeadingIdentityReconcile } = getHeadingIdentity();
	return needsHeadingIdentityReconcile(text);
}

/**
 * Stable signature for whether `index.drip` needs a write after parse.
 * Uses per-heading content hashes (spec §12–14) plus graph edges.
 *
 * @param {ReturnType<import('../dripIndexParse').parseNoteForIndex>} parsed
 * @returns {string}
 */
function computeIndexPersistenceSignature(parsed) {
	const headings = (parsed.headings || [])
		.map(h => [
			h.heading_id,
			h.title,
			h.metadata_type
		])
		.sort((a, b) => a[0] - b[0]);

	const searchtags = (parsed.searchtags || [])
		.map(t => [t.source_heading_id, t.tag_name.toLowerCase()])
		.sort();

	const relations = (parsed.relations || [])
		.map(r => [r.source_heading_id, r.relation_type, r.tag_name.toLowerCase()])
		.sort();

	const typed = (parsed.typedMetadata || [])
		.map(t => [t.heading_id, t.table, t.fields, t.remaining || []])
		.sort((a, b) => a[0] - b[0]);

	return JSON.stringify({
		path: parsed.file.path,
		fileId: parsed.fileId,
		headings,
		searchtags,
		relations,
		typed
	});
}

/**
 * @param {string | undefined} previous
 * @param {string} next
 * @returns {boolean}
 */
function shouldPersistIndexUpdate(previous, next) {
	return previous !== next;
}

module.exports = {
	DOCUMENT_WATCH_MANIFEST,
	HEADING_HASH_REFRESH_MS,
	INDEX_UPDATE_BUFFER_MS,
	computeMetadataEditSignature,
	computeIndexPersistenceSignature,
	shouldPersistIndexUpdate,
	needsImmediateHeadingIdAllocation
};
