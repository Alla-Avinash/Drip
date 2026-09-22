'use strict';

const path = require('path');
const vscode = require('vscode');
const { parseNoteForIndex } = require('../dripIndexParse');
const {
	openDripIndexDb,
	applyParsedNoteToIndex,
	collectKnownTagNamesLower
} = require('../dripIndexDb');
const { enqueueHeadingEmbeddingUpserts } = require('../embeddings/headingEmbeddingSync');
const { computeIndexPersistenceSignature } = require('./dripnoteDocumentWatch');
const { forEachKnowledgeBaseNote } = require('../../document/kbNoteOps');
const { fileNameMatchesKbNote } = require('../../document/model/noteFileTypes');
const { collectHeadingSequenceValidated } = require('../../document/parse/dripnoteCanvasParse');
const { collectHeadingVersusAboveLineIndentErrors } = require('../../document/parse/dripnoteHeadingAboveIndent');
const {
	collectHeadingIdentityDiagnostics,
	parseFileEntityFromLines
} = require('../dripnoteHeadingIdentity');
const { reconcileNoteHeadingIdentitiesOnDisk } = require('../dripnoteHeadingIdentityReconcile');

/**
 * Collect parse / structure issues for a note before or after index update.
 *
 * @param {string} text
 * @param {import('vscode').ExtensionContext | null | undefined} [context]
 * @returns {{ line?: number, message: string, severity: 'error' | 'warning' }[]}
 */
function collectNoteIndexIssues(text, context) {
	const normalized = String(text || '').replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');
	/** @type {{ line?: number, message: string, severity: 'error' | 'warning' }[]} */
	const issues = [];

	const { errors } = collectHeadingSequenceValidated(lines, 0);
	for (const e of errors) {
		issues.push({ line: e.lineIndex + 1, message: e.message, severity: 'error' });
	}
	for (const e of collectHeadingVersusAboveLineIndentErrors(lines)) {
		issues.push({ line: e.lineIndex + 1, message: e.message, severity: 'error' });
	}

	const file = parseFileEntityFromLines(lines);
	for (const d of collectHeadingIdentityDiagnostics(normalized, file?.fileNum ?? null)) {
		if (d.kind === 'duplicate') {
			continue;
		}
		const msg =
			d.kind === 'duplicate'
				? `Duplicate heading identity @f${d.fileNum}:h${d.headingNum}`
				: `Heading identity @f${d.fileNum} does not match fileid in header`;
		issues.push({ line: d.lineIndex + 1, message: msg, severity: 'error' });
	}

	const knownTagsLower = collectKnownTagNamesLower(context);
	if (knownTagsLower && knownTagsLower.size) {
		const tagLineRe = /^\s*tags\s*:\s*\[([^\]]*)\]/i;
		const tagTokenRe = /#([^\s,\]]+)/g;
		for (let i = 0; i < lines.length; i++) {
			const m = tagLineRe.exec(String(lines[i] || ''));
			if (!m) continue;
			let tok;
			while ((tok = tagTokenRe.exec(m[1])) !== null) {
				const label = String(tok[1] || '').trim();
				if (!label) continue;
				if (!knownTagsLower.has(label.toLowerCase())) {
					issues.push({
						line: i + 1,
						message: `Unknown tag "${label}"`,
						severity: 'warning'
					});
				}
			}
		}
	}

	return issues;
}

/**
 * Parse a KB note and persist structured index rows into `index.drip`.
 *
 * Pipeline: read text → `parseNoteForIndex` → transaction → `applyParsedNoteToIndex`.
 * Hash-aware skip: when `options.skipIfSignatureMatches` is set and signature unchanged, no DB write.
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} noteUri
 * @param {import('vscode').ExtensionContext | null | undefined} [context]
 * @param {{
 *   text?: string,
 *   skipIfSignatureMatches?: string,
 *   force?: boolean,
 *   changeRanges?: { start: number, end: number }[],
 *   previousParse?: object | null
 * }} [options]
 * @returns {Promise<{ updated: boolean, signature: string, fileId: number | null, parsed: object | null }>}
 */
async function updateNoteInDripIndex(kbRootUri, noteUri, context, options) {
	const relPath = path
		.relative(kbRootUri.fsPath, noteUri.fsPath)
		.replace(/\\/g, '/');

	let text = options && options.text != null ? String(options.text) : '';
	if (!text && !(options && options.text === '')) {
		try {
			const buf = await vscode.workspace.fs.readFile(noteUri);
			text = Buffer.from(buf).toString('utf8');
		} catch {
			return { updated: false, signature: '', fileId: null, parsed: null };
		}
	}

	if (
		options?.force &&
		options?.reconcileIdentities !== false
	) {
		try {
			const identity = await reconcileNoteHeadingIdentitiesOnDisk(
				kbRootUri,
				noteUri,
				context,
				{ text, refreshHashes: options?.refreshHashes === true }
			);
			text = identity.text;
		} catch (err) {
			console.error('[DRIP] heading identity reconcile before index', noteUri.fsPath, err);
		}
	}

	let stat;
	try {
		stat = await vscode.workspace.fs.stat(noteUri);
	} catch {
		stat = undefined;
	}

	const knownTagsLower = collectKnownTagNamesLower(context);
	const parseOptions = {
		knownTagsLower,
		changeRanges: options?.force ? undefined : options?.changeRanges,
		previousParse: options?.force ? null : options?.previousParse
	};
	const parsed = parseNoteForIndex(
		text,
		relPath,
		path.basename(noteUri.fsPath),
		{
			ctimeMs: stat?.ctime,
			mtimeMs: stat?.mtime
		},
		parseOptions
	);

	const signature = computeIndexPersistenceSignature(parsed);
	if (
		!options?.force &&
		options?.skipIfSignatureMatches != null &&
		options.skipIfSignatureMatches === signature
	) {
		return { updated: false, signature, fileId: parsed.fileId, parsed };
	}

	const handle = await openDripIndexDb(kbRootUri);
	/** @type {{ fileId: number, headingId: number }[]} */
	const embeddingUpserts = [];
	try {
		handle.db.run('BEGIN');
		const fileId = applyParsedNoteToIndex(handle.db, relPath, parsed, context, {
			incremental: !options?.force,
			embeddingUpserts
		});
		handle.db.run('COMMIT');
		await handle.save();
		enqueueHeadingEmbeddingUpserts(kbRootUri, embeddingUpserts);
		if (relPath) {
			const { enqueueFolderEmbeddingsForNotePath } = require('../embeddings/folderEmbeddingSync');
			enqueueFolderEmbeddingsForNotePath(kbRootUri, relPath);
		}
		return { updated: true, signature, fileId, parsed };
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

/** @deprecated Use `updateNoteInDripIndex` — kept for existing call sites. */
async function upsertNoteInDripIndex(kbRootUri, noteUri, context) {
	const result = await updateNoteInDripIndex(kbRootUri, noteUri, context);
	return result;
}

/**
 * Re-index notes under a KB tree scope (single `.d.txt` file or folder subtree).
 * Invalid regions (unknown tags, bad metadata) are skipped by the parser — same rules as editor diagnostics.
 *
 * @param {import('vscode').Uri} kbRootUri
 * @param {import('vscode').Uri} scopeUri file or folder under the KB
 * @param {import('vscode').ExtensionContext | null | undefined} [context]
 */
async function updateDripIndexScope(kbRootUri, scopeUri, context) {
	const relScope = path.relative(kbRootUri.fsPath, scopeUri.fsPath).replace(/\\/g, '/');
	if (relScope.startsWith('..') || path.isAbsolute(relScope)) {
		throw new Error('Scope is outside the knowledge base.');
	}

	let stat;
	try {
		stat = await vscode.workspace.fs.stat(scopeUri);
	} catch {
		throw new Error('Scope path not found.');
	}

	/** @type {import('vscode').Uri[]} */
	const noteUris = [];

	if (stat.type === vscode.FileType.File) {
		if (fileNameMatchesKbNote(path.basename(scopeUri.fsPath))) {
			noteUris.push(scopeUri);
		}
	} else {
		const scopePath = scopeUri.fsPath.replace(/\\/g, '/');
		const scopePrefix = scopePath.endsWith('/') ? scopePath : `${scopePath}/`;
		await forEachKnowledgeBaseNote(kbRootUri, async note => {
			if (!note?.uri?.fsPath) {
				return;
			}
			const notePath = note.uri.fsPath.replace(/\\/g, '/');
			if (notePath === scopePath.replace(/\\/g, '/') || notePath.startsWith(scopePrefix)) {
				noteUris.push(note.uri);
			}
		});
	}

	let updated = 0;
	let failed = 0;
	/** @type {{ path: string, line?: number, message: string, severity: 'error' | 'warning' }[]} */
	const issues = [];

	for (const noteUri of noteUris) {
		const relPath = path.relative(kbRootUri.fsPath, noteUri.fsPath).replace(/\\/g, '/');
		let text = '';
		try {
			const buf = await vscode.workspace.fs.readFile(noteUri);
			text = Buffer.from(buf).toString('utf8');
		} catch (err) {
			failed += 1;
			issues.push({
				path: relPath,
				message: `Could not read file: ${err && err.message ? err.message : String(err)}`,
				severity: 'error'
			});
			continue;
		}

		try {
			const identity = await reconcileNoteHeadingIdentitiesOnDisk(kbRootUri, noteUri, context, {
				text
			});
			text = identity.text;
		} catch (err) {
			failed += 1;
			issues.push({
				path: relPath,
				message: `Heading identity reconcile failed: ${err && err.message ? err.message : String(err)}`,
				severity: 'error'
			});
			continue;
		}

		for (const issue of collectNoteIndexIssues(text, context)) {
			issues.push({ path: relPath, ...issue });
		}

		try {
			const result = await updateNoteInDripIndex(kbRootUri, noteUri, context, {
				force: true,
				text,
				reconcileIdentities: false
			});
			if (result.updated) {
				updated += 1;
			}
		} catch (err) {
			failed += 1;
			console.error('[DRIP] scoped index update failed', noteUri.fsPath, err);
			issues.push({
				path: relPath,
				message: err && err.message ? err.message : String(err),
				severity: 'error'
			});
		}
	}

	return { total: noteUris.length, updated, failed, issues };
}

module.exports = {
	updateNoteInDripIndex,
	updateDripIndexScope,
	upsertNoteInDripIndex,
	computeIndexPersistenceSignature,
	collectNoteIndexIssues
};
