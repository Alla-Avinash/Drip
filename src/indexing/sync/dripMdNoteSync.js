'use strict';

/**
 * `.d.md` note sync → index.drip (file id + heading rows + embeddings).
 *
 * The `.d.md` format has no `@fN:hM` identity lines; its identity lives in two hidden
 * comment blocks (`<!-- drip-file … -->` at the top, `<!-- drip hN | … -->` under each
 * persistent heading). This module reconciles both, resolves file/heading ids against
 * index.drip, rewrites the file, persists rows, and propagates link rewrites when the
 * file id changes. It reuses the `.d.txt` database layer unchanged.
 *
 * Design (see specs/features/md-editor.md):
 *  - The hidden comment is authoritative for the heading type; the heading line carries
 *    no `.c`/`.task`/`.i-N` prefix. Legacy prefixes are stripped on reconcile.
 *  - A persistent heading is one that has a `<!-- drip hN | … -->` comment under it. A
 *    heading whose comment is deleted recovers its old id by matching its cleaned title
 *    against the DB; otherwise it gets a fresh id (the "id lost" rule).
 *  - Parent is computed from indentation; only persistent headings can be parents.
 *  - Persistence is a full replace of the file's heading rows (deletions fall out
 *    naturally because removed headings simply aren't re-inserted). The index signature
 *    short-circuits no-op saves.
 */

const path = require('path');
const vscode = require('vscode');
const { ensureDripIndexSkeleton } = require('../../startup/initializeDripIndex');
const { readTextFile, writeTextFile } = require('../kbFilesystem');
const { formatFileEntityId, parseFileEntityIdNumber } = require('../dripnoteEntityIds');
const {
	collectKnownTagNamesLower,
	applyParsedNoteToIndex,
	replaceParsedNoteAtFileId,
	syncFileHeadingAllocatorFromUsedIds,
	recomputeHeadingAllocatorState,
	openDripIndexDb,
	removeFileFromDripIndex
} = require('../dripIndexDb');
const { enqueueHeadingEmbeddingUpserts } = require('../embeddings/headingEmbeddingSync');
const { enqueueFolderEmbeddingsForNotePath } = require('../embeddings/folderEmbeddingSync');
const { resolveFileIdOwnership, MODE_EXISTING } = require('./dripnoteReconcileUpdate');
const { computeIndexPersistenceSignature } = require('./dripnoteDocumentWatch');
const { propagateFileIdDrift } = require('../dripnoteFileIdMigration');
const {
	parseDripMdNoteForIndex,
	walkDripMdNoteHeadings,
	toLines
} = require('../dripMdNoteIndexParse');
const {
	parseFileHeaderComment,
	isFileHeaderComment,
	reconcileMdNoteFileHeader,
	stripMdNoteExtension
} = require('../../document/model/dripMdNoteFileHeader');
const { formatHeadingComment } = require('../../document/model/dripMdNoteComment');

/** Polling cadence for the restored-tab scan (ms). */
const STARTUP_SCAN_INTERVAL_MS = 700;
/** Max retries before giving up on a KB root appearing (~ 20 s). */
const MAX_STARTUP_SCAN_ATTEMPTS = 30;

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @returns {string} KB-relative path (forward slashes)
 */
function relPathForNote(kbRootUri, noteUri) {
	return path.relative(kbRootUri.fsPath, noteUri.fsPath).replace(/\\/g, '/');
}

/**
 * @param {import('vscode').TextDocument | import('vscode').Uri} docOrUri
 * @returns {boolean}
 */
function isDripMdDocument(docOrUri) {
	if (!docOrUri) return false;
	const uri = docOrUri.uri || docOrUri;
	if (uri.scheme !== 'file') return false;
	return String(uri.fsPath || '').toLowerCase().endsWith('.d.md');
}

/**
 * Existing non-h0 heading titles in index.drip for this file, keyed by cleaned title
 * (lowercase). Used to recover an id when a heading's comment was hand-deleted.
 * @param {import('vscode').Uri} kbRootUri
 * @param {number} fileId
 * @returns {Promise<Map<string, number>>}
 */
async function readFileHeadingIdsByTitle(kbRootUri, fileId) {
	const map = new Map();
	const handle = await openDripIndexDb(kbRootUri);
	try {
		const stmt = handle.db.prepare(
			'SELECT heading_id, title FROM headings WHERE file_id = ? AND heading_id > 0 ORDER BY heading_id'
		);
		stmt.bind([fileId]);
		while (stmt.step()) {
			const row = stmt.get();
			const id = Number(row[0]);
			const title = String(row[1] || '').trim().toLowerCase();
			if (id > 0 && title && !map.has(title)) {
				map.set(title, id);
			}
		}
		stmt.free();
	} finally {
		handle.close();
	}
	return map;
}

/**
 * Resolve a stable heading id for every persistent heading:
 *  - keep a valid, non-duplicate id already present in the comment
 *  - otherwise recover by title from the DB
 *  - otherwise allocate a fresh id (in-memory free-list + counter)
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {number} fileId
 * @param {ReturnType<typeof walkDripMdNoteHeadings>} walked
 * @returns {Promise<Map<number, number>>} heading line index → heading id
 */
async function resolveDripMdHeadingIds(kbRootUri, fileId, walked) {
	const dbIdByTitle = await readFileHeadingIdsByTitle(kbRootUri, fileId);

	/** @type {Map<number, number>} */
	const idByLine = new Map();
	/** @type {Set<number>} */
	const usedIds = new Set();
	/** @type {{ lineIndex: number }[]} */
	const pending = [];

	for (let ni = 0; ni < walked.length; ni++) {
		const w = walked[ni];
		if (ni === 0 || !w.persistent) continue; // h0 and plain headings are not persistent

		let id = null;
		if (w.comment && w.comment.headingNum > 0) {
			id = w.comment.headingNum;
		}
		// A duplicate id means the file was hand-edited; force a fresh id for the later copy.
		if (id != null && usedIds.has(id)) {
			id = null;
		}
		if (id == null) {
			const recovered = dbIdByTitle.get(w.cleanTitle.toLowerCase());
			if (recovered != null && !usedIds.has(recovered)) {
				id = recovered;
			}
		}
		if (id == null) {
			pending.push({ lineIndex: w.lineIndex });
		} else {
			usedIds.add(id);
			idByLine.set(w.lineIndex, id);
		}
	}

	// Fresh ids, in file order, reusing the lowest free id first.
	const alloc = recomputeHeadingAllocatorState(usedIds, undefined);
	for (const p of pending) {
		let id;
		if (alloc.free.length) {
			id = alloc.free.shift();
		} else {
			id = alloc.next;
			alloc.next += 1;
		}
		usedIds.add(id);
		idByLine.set(p.lineIndex, id);
	}

	return idByLine;
}

/**
 * Write the canonical heading comments into the body (insert where missing, replace
 * where present). Comments are edited bottom-up so inserted lines don't shift indices.
 * @param {string[]} lines
 * @param {ReturnType<typeof walkDripMdNoteHeadings>} walked
 * @param {Map<number, number>} idByLine
 * @returns {string[]}
 */
function injectHeadingComments(lines, walked, idByLine) {
	const out = [...lines];
	const edits = [];
	for (let ni = 0; ni < walked.length; ni++) {
		const w = walked[ni];
		if (ni === 0 || !w.persistent) continue;
		const id = idByLine.get(w.lineIndex) ?? 0;
		// An untyped persistent heading is written with the `persistent` marker so it is
		// never left behind as a bare `<!-- drip hN -->` with no way to tell it is indexed.
		const typeId = w.typeId || 'persistent';
		const commentText = formatHeadingComment(id, typeId, w.comment ? w.comment.fields : []);
		edits.push({ headingLine: w.lineIndex, commentLineIndex: w.commentLineIndex, commentText });
	}
	edits.sort((a, b) => b.headingLine - a.headingLine);
	for (const e of edits) {
		if (e.commentLineIndex >= 0) {
			if (out[e.commentLineIndex] !== e.commentText) {
				out[e.commentLineIndex] = e.commentText;
			}
		} else {
			out.splice(e.headingLine + 1, 0, e.commentText);
		}
	}
	return out;
}

/**
 * Strip legacy `.c` / `.task` / `.i-N` / `. Title` type prefixes from heading lines, so the
 * type lives only in the hidden comment (the new `.d.md` format). The stripped title is
 * already computed as `cleanTitle` on each walked heading, so this just rewrites the heading
 * line. `.i-34 Title` keeps its issue number (`i-34 Title`) — only the type dot is dropped.
 *
 * @param {string[]} lines
 * @param {ReturnType<typeof walkDripMdNoteHeadings>} walked
 * @returns {string[]}
 */
function stripLegacyHeadingPrefixes(lines, walked) {
	const out = [...lines];
	for (let ni = 0; ni < walked.length; ni++) {
		const w = walked[ni];
		if (ni === 0 || w.cleanTitle === w.title) continue; // h0 + already-clean headings
		const m = lines[w.lineIndex].match(/^(\s*)(#{1,6})\s+.*$/);
		if (!m) continue;
		out[w.lineIndex] = `${m[1]}${m[2]} ${w.cleanTitle}`;
	}
	return out;
}

/**
 * Rebuild the whole note: inject heading comments, then produce the canonical file header
 * (comment + h0 + blank line) using the resolved file id. Reuses `reconcileMdNoteFileHeader`
 * so the header rules stay identical to the standalone structural reconcile.
 *
 * @param {string} text
 * @param {string} fileStem
 * @param {string} fileEntityId
 * @param {ReturnType<typeof walkDripMdNoteHeadings>} walked
 * @param {Map<number, number>} idByLine
 * @returns {string}
 */
function rebuildDripMdNoteText(text, fileStem, fileEntityId, walked, idByLine) {
	const stripped = stripLegacyHeadingPrefixes(toLines(text), walked);
	const injected = injectHeadingComments(stripped, walked, idByLine);
	const result = reconcileMdNoteFileHeader(injected.join('\n'), { fileStem, fileid: fileEntityId });
	return [...result.headerLines, ...injected.slice(result.bodyStartLineIndex)].join('\n');
}

/**
 * Parse the reconciled text and write it into index.drip. Skips when the index-relevant
 * signature is unchanged, so a metadata-only no-op save never touches the DB.
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @param {string} text
 * @param {number} fileId
 * @param {string} mode
 * @param {import('vscode').ExtensionContext | null | undefined} context
 * @param {Map<string, string>} lastSigByUri
 */
async function persistDripMdNote(kbRootUri, noteUri, text, fileId, mode, context, lastSigByUri) {
	const relPath = relPathForNote(kbRootUri, noteUri);
	const fileName = path.basename(noteUri.fsPath);

	let stat;
	try {
		stat = await vscode.workspace.fs.stat(noteUri);
	} catch {
		stat = undefined;
	}

	const parsed = parseDripMdNoteForIndex(
		text,
		relPath,
		fileName,
		{ ctimeMs: stat && stat.ctime, mtimeMs: stat && stat.mtime },
		{ knownTagsLower: collectKnownTagNamesLower(context) }
	);
	parsed.fileId = fileId;

	const key = noteUri.toString();
	const signature = computeIndexPersistenceSignature(parsed);
	if (lastSigByUri && lastSigByUri.get(key) === signature) {
		return;
	}
	if (lastSigByUri) {
		lastSigByUri.set(key, signature);
	}

	const embeddingUpserts = [];
	if (mode === MODE_EXISTING) {
		await applyParsedNoteToIndex(kbRootUri, relPath, parsed, context, {
			incremental: true,
			embeddingUpserts
		});
	} else {
		await replaceParsedNoteAtFileId(kbRootUri, fileId, parsed, context, { embeddingUpserts });
	}
	enqueueHeadingEmbeddingUpserts(kbRootUri, embeddingUpserts);
	enqueueFolderEmbeddingsForNotePath(kbRootUri, relPath);

	const usedIds = (parsed.headings || [])
		.map(h => Number(h.heading_id))
		.filter(n => Number.isFinite(n) && n > 0);
	await syncFileHeadingAllocatorFromUsedIds(kbRootUri, fileId, usedIds);
}

/**
 * Reconcile one `.d.md` note end-to-end.
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @param {import('vscode').ExtensionContext | null | undefined} context
 * @param {{ text?: string, lastSigByUri?: Map<string, string>, writeToDisk?: boolean }} [options]
 * @returns {Promise<{ text: string, changed: boolean, fileId: number, fileEntityId: string, mode: string }>}
 */
async function syncDripMdNote(kbRootUri, noteUri, context, options = {}) {
	const lastSigByUri = options.lastSigByUri;
	const fileStem = stripMdNoteExtension(path.basename(noteUri.fsPath));
	const text = options.text != null ? String(options.text) : await readTextFile(noteUri);
	const normalized = toLines(text).join('\n');

	const lines = toLines(normalized);
	const headerIdx = lines.findIndex(isFileHeaderComment);
	const header = headerIdx >= 0 ? parseFileHeaderComment(lines[headerIdx]) : null;
	const claimedFileId = header ? parseFileEntityIdNumber(header.fileid) : null;

	const ownership = await resolveFileIdOwnership(kbRootUri, noteUri, claimedFileId);
	const { fileId, fileEntityId, mode } = ownership;

	const walked = walkDripMdNoteHeadings(lines);
	const idByLine = await resolveDripMdHeadingIds(kbRootUri, fileId, walked);
	const nextText = rebuildDripMdNoteText(normalized, fileStem, fileEntityId, walked, idByLine);
	const changed = nextText !== normalized;

	// Single writer: never touch the open buffer or disk behind the editor. The reconciled
	// text (with real heading ids) is returned so the caller can fold it into a save
	// (onWillSaveTextDocument) or write it to disk only when the tab is already closed.
	if (options.writeToDisk === true) {
		await writeTextFile(noteUri, nextText);
	}

	await persistDripMdNote(kbRootUri, noteUri, nextText, fileId, mode, context, lastSigByUri);

	if (claimedFileId != null && claimedFileId !== fileId) {
		await propagateFileIdDrift(context, kbRootUri, noteUri, {
			oldId: formatFileEntityId(claimedFileId),
			newId: fileEntityId,
			relPath: relPathForNote(kbRootUri, noteUri)
		});
	}

	return { text: nextText, changed, fileId, fileEntityId, mode };
}

/**
 * Host-side driver: open / save / close triggers, plus a deferred scan for tabs restored
 * from a previous session (which open before the KB root is verified). Idempotent via the
 * index signature, so a clean note never re-writes the DB.
 *
 * Deliberately NOT triggered on every keystroke: the webview is the single writer of an
 * open document, and rewriting it behind the editor caused save conflicts ("content is
 * newer"). Reconcile only runs when the document is safe to touch — on open, on save, and
 * on close.
 *
 * @param {import('vscode').ExtensionContext} context
 * @param {{ getVerifiedKnowledgeBaseRoot: () => import('vscode').Uri | undefined }} state
 */
function registerDripMdNoteIndexSync(context, state) {
	const lastSigByUri = new Map();
	const inFlight = new Set();
	let scanAttempts = 0;

	function kbRootFor() {
		if (!state || typeof state.getVerifiedKnowledgeBaseRoot !== 'function') return undefined;
		return state.getVerifiedKnowledgeBaseRoot();
	}

	/** @param {import('vscode').TextDocument} doc */
	async function run(doc) {
		if (!isDripMdDocument(doc)) return;
		const key = doc.uri.toString();
		if (inFlight.has(key)) return;

		const kbRoot = kbRootFor();
		if (!kbRoot) return;
		const rel = path.relative(kbRoot.fsPath, doc.uri.fsPath);
		if (rel.startsWith('..') || path.isAbsolute(rel)) return;

		inFlight.add(key);
		try {
			await ensureDripIndexSkeleton(kbRoot);
			const text = doc.isClosed ? await readTextFile(doc.uri) : doc.getText();
			await syncDripMdNote(kbRoot, doc.uri, context, {
				text,
				lastSigByUri,
				// Only write straight to disk when the tab is already closed (close flush).
				writeToDisk: doc.isClosed
			});
		} catch (err) {
			console.error('[DRIP] .d.md note sync failed', doc.uri.fsPath, err);
		} finally {
			inFlight.delete(key);
		}
	}

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(doc => void run(doc)),
		vscode.workspace.onWillSaveTextDocument(e => {
			if (!isDripMdDocument(e.document)) return;
			const kbRoot = kbRootFor();
			if (!kbRoot) return;
			e.waitUntil(
				(async () => {
					const text = e.document.getText();
					const result = await syncDripMdNote(kbRoot, e.document.uri, context, {
						text,
						lastSigByUri
					});
					if (!result.changed) return [];
					// Fold the reconciled text (fresh heading ids, stripped legacy prefixes)
					// into the save itself — no separate disk write, no "content is newer".
					const full = new vscode.Range(0, 0, e.document.lineCount, 0);
					return [vscode.TextEdit.replace(full, result.text)];
				})().catch(err => {
					console.error('[DRIP] .d.md reconcile-on-save failed', e.document.uri.fsPath, err);
					return [];
				})
			);
		}),
		vscode.workspace.onDidSaveTextDocument(doc => void run(doc)),
		vscode.workspace.onDidCloseTextDocument(doc => void run(doc)),
		vscode.workspace.onDidDeleteFiles(e => {
			void (async () => {
				const kbRoot = kbRootFor();
				if (!kbRoot) return;
				for (const f of e.files || []) {
					const fsPath = String((f && f.fsPath) || '');
					if (!fsPath.toLowerCase().endsWith('.d.md')) continue;
					const rel = path.relative(kbRoot.fsPath, fsPath);
					if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
					await removeFileFromDripIndex(kbRoot, rel.replace(/\\/g, '/'));
				}
			})().catch(err => console.error('[DRIP] .d.md delete sync failed', err));
		})
	);

	// Tabs restored from a previous session are already open before the KB root is
	// verified. Poll briefly until verification settles, then sync every open `.d.md`.
	// Bound the retries so a workspace with no KB root never polls forever.
	const scanTimer = setInterval(() => {
		scanAttempts += 1;
		if (state.getVerifiedKnowledgeBaseRoot()) {
			clearInterval(scanTimer);
			for (const doc of vscode.workspace.textDocuments) {
				if (isDripMdDocument(doc)) void run(doc);
			}
		} else if (scanAttempts >= MAX_STARTUP_SCAN_ATTEMPTS) {
			clearInterval(scanTimer);
		}
	}, STARTUP_SCAN_INTERVAL_MS);
	context.subscriptions.push({ dispose: () => clearInterval(scanTimer) });
}

module.exports = {
	syncDripMdNote,
	registerDripMdNoteIndexSync
};
