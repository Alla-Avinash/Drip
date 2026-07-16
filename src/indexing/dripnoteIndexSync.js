'use strict';

const path = require('path');
const vscode = require('vscode');
const { isStartupCheckReady, runStartupCheck } = require('../startup/startupCheck');
const { updateKnowledgeBase } = require('../startup/updateKnowledgeBase');
const {
	detectFileIdDrift,
	normalizeNoteIdentityText
} = require('./dripnoteFileIdentity');
const { writeTextFile, readTextFile } = require('./kbFilesystem');
const { applyFileIdLinkMigrationKb, processAllPendingLinkMigrations } = require('./dripnoteReferencePhase3');
const { removeFileFromDripIndex, resolveSequentialFileEntityForKbNote } = require('./dripIndexDb');
const { updateNoteInDripIndex, updateDripIndexScope } = require('./sync/dripnoteIndexUpdate');
const { reconcileHeadingIdentitiesScope } = require('./dripnoteHeadingIdentityReconcile');
const { createDripnoteIndexUpdateQueue } = require('./sync/dripnoteIndexUpdateQueue');
const {
	DOCUMENT_WATCH_MANIFEST,
	HEADING_HASH_REFRESH_MS,
	computeMetadataEditSignature,
	needsImmediateHeadingIdAllocation
} = require('./sync/dripnoteDocumentWatch');
const {
	reconcileHeadingIdentitiesForKbNote,
	reconcileHeadingIdentitiesInText,
	parseFileEntityFromLines,
	isHeadingIdentityLine,
	isHeadingIdentitySlotLine,
	needsHeadingIdentityReconcile,
	hasDuplicateHeadingIdsInFile
} = require('./dripnoteHeadingIdentity');
const { parseHeadingForValidation } = require('../document/parse/dripnoteCanvasParse');
const {
	buildHeadingIdPoolFromText,
	syncHeadingIdPoolFromAllocator,
	headingIdPoolToAllocator,
	parseHeadingsCountFromLines
} = require('./dripnoteHeadingIdPool');

/**
 * Lightweight index sync on note saves → index.drip SQLite.
 */
function registerDripnoteIndexSync(context, state) {
	const indexQueue = createDripnoteIndexUpdateQueue({
		context,
		getKnowledgeBaseRoot: () => state.getKnowledgeBaseRoot()
	});
	context.subscriptions.push({
		dispose: () => {
			void indexQueue.flushAllPending().catch(err => {
				console.error('[DRIP] flush pending index updates on dispose', err);
			});
			indexQueue.dispose();
		}
	});

	/** @type {Map<string, string>} */
	const lastMetadataSigByDoc = new Map();
	/** @type {Map<string, ReturnType<typeof setTimeout>>} */
	const hashRefreshTimers = new Map();
	/** @type {Map<string, ReturnType<typeof setTimeout>>} */
	const pendingIdAllocateTimers = new Map();
	/** @type {Map<string, Promise<void>>} */
	const headingReconcileInFlight = new Map();
	/** @type {Set<string>} */
	const headingReconcilePending = new Set();
	/** @type {Map<string, { refreshHashes?: boolean }>} */
	const pendingReconcileOptionsByUri = new Map();
	/** @type {Map<string, { fileNum: number, fileEntityId: string }>} */
	const fileEntityByUri = new Map();
	/** @type {Map<string, import('./dripnoteHeadingIdPool').HeadingIdPool>} */
	const headingIdPoolByUri = new Map();
	let reconcileEditDepth = 0;

	/** Debounce before auto-inserting heading ids while typing. */
	const HEADING_ID_ALLOCATION_DEBOUNCE_MS = 500;

	/**
	 * Defer only while the caret is on an `@fN:hM` identity slot line (user editing the id).
	 * Titled headings that still need an id must allocate on debounce — do not wait for leave.
	 */
	function shouldDeferHeadingIdAllocation(document) {
		if (hasDuplicateHeadingIdsInFile(document.getText().replace(/\r\n/g, '\n'))) {
			return false;
		}
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
			return false;
		}
		const lineIdx = editor.selection.active.line;
		const lines = document.getText().replace(/\r\n/g, '\n').split('\n');
		const line = String(lines[lineIdx] || '');
		if (isHeadingIdentitySlotLine(line)) {
			return true;
		}
		return false;
	}

	function noteNeedsImmediateIdWork(text) {
		return (
			needsHeadingIdentityReconcile(text) ||
			needsImmediateHeadingIdAllocation(text)
		);
	}

	function flushPendingHeadingIdAllocation(document) {
		const key = document.uri.toString();
		const prev = pendingIdAllocateTimers.get(key);
		if (prev) {
			clearTimeout(prev);
			pendingIdAllocateTimers.delete(key);
		}
		if (!isKbNoteDocument(document)) return;
		if (shouldDeferHeadingIdAllocation(document)) return;
		if (!noteNeedsImmediateIdWork(document.getText().replace(/\r\n/g, '\n'))) return;
		startHeadingReconcile(document);
	}

	async function ensureStartupIndexReconcile() {
		await runStartupCheck(context, state);
	}

	function getOpenDocument(uri) {
		const key = uri.toString();
		return vscode.workspace.textDocuments.find(d => d.uri.toString() === key) || null;
	}

	async function maybeRealignFileIdOnOpen(document) {
		if (!document || document.languageId !== 'dripnote' || document.uri.scheme !== 'file') {
			return;
		}
		const kbRoot = state.getKnowledgeBaseRoot();
		if (!kbRoot) {
			return;
		}
		const relToKb = path.relative(kbRoot.fsPath, document.uri.fsPath);
		if (relToKb.startsWith('..') || path.isAbsolute(relToKb)) {
			return;
		}
		if (document.isDirty) {
			return;
		}

		await ensureStartupIndexReconcile();

		const text = document.getText();
		const drift = await detectFileIdDrift(document.uri, text, context);
		if (!drift.drift) {
			return;
		}

		const next = await normalizeNoteIdentityText(document.uri, text, {
			context,
			forceCanonicalFileId: true
		});
		if (next === text.replace(/\r\n/g, '\n')) {
			return;
		}

		let diskPersisted = false;
		const fullRange = new vscode.Range(
			document.positionAt(0),
			document.positionAt(text.length)
		);
		const applied = await vscode.workspace.applyEdit(
			new vscode.WorkspaceEdit().replace(document.uri, fullRange, next)
		);
		if (applied) {
			try {
				await vscode.workspace.save(document.uri);
				diskPersisted = true;
			} catch (err) {
				console.error('[DRIP] save after fileid realign', err);
			}
		}
		if (!diskPersisted) {
			try {
				await writeTextFile(document.uri, next);
				diskPersisted = true;
			} catch (err) {
				console.error('[DRIP] writeTextFile after fileid realign', err);
				void vscode.window.showErrorMessage(
					'DRIP could not write the realigned note to disk. Reload the file and try again.'
				);
				return;
			}
		}

		if (drift.currentId && drift.expectedId && drift.currentId !== drift.expectedId) {
			const migration = { oldId: drift.currentId, newId: drift.expectedId, relPath: relToKb.replace(/\\/g, '/') };
			await applyFileIdLinkMigrationKb(kbRoot, context, migration, document.uri);
		} else {
			await updateNoteInDripIndex(kbRoot, document.uri, context, { force: true });
		}

		void vscode.window.setStatusBarMessage(
			`DRIP: fileid set to ${drift.expectedId} (index updated).`,
			5000
		);
	}

	function isDripnoteFileDocument(document) {
		if (!document || document.uri.scheme !== 'file') return false;
		if (document.languageId === 'dripnote') return true;
		return String(document.uri.fsPath || '')
			.toLowerCase()
			.endsWith('.d.txt');
	}

	function isKbNoteDocument(document) {
		if (!isDripnoteFileDocument(document)) return false;
		const kbRoot = state.getKnowledgeBaseRoot();
		if (!kbRoot) return false;
		const relToKb = path.relative(kbRoot.fsPath, document.uri.fsPath);
		return !relToKb.startsWith('..') && !path.isAbsolute(relToKb);
	}

	function clearHeadingTimersForUri(uriKey) {
		const hashTimer = hashRefreshTimers.get(uriKey);
		if (hashTimer) clearTimeout(hashTimer);
		hashRefreshTimers.delete(uriKey);
		const idTimer = pendingIdAllocateTimers.get(uriKey);
		if (idTimer) clearTimeout(idTimer);
		pendingIdAllocateTimers.delete(uriKey);
	}

	function parseHeadingLineInfo(line) {
		const m = String(line || '').match(/^(\s*)(#{1,6})\s+(.*)$/);
		if (!m) return null;
		return {
			indent: m[1] || '',
			title: String(m[3] || '').trim(),
			tabDepth: (m[1] || '').length
		};
	}

	/**
	 * @param {string[]} lines
	 * @param {string} indent
	 * @param {string} title
	 */
	function findHeadingLineIndex(lines, indent, title) {
		let titleRest = String(title || '').trim();
		try {
			const { matchTaskTitleShortcut } = require('../document/workflow/dripnoteWorkflowParse');
			const matched = matchTaskTitleShortcut(titleRest);
			if (matched.matchedPrefix) {
				titleRest = titleRest.slice(matched.matchedPrefix.length).replace(/^\s+/, '');
			}
		} catch {
			/* ignore */
		}
		for (let i = 0; i < lines.length; i++) {
			const info = parseHeadingLineInfo(lines[i]);
			if (!info || info.indent !== indent) continue;
			let rest = info.title;
			try {
				const { matchTaskTitleShortcut } = require('../document/workflow/dripnoteWorkflowParse');
				const matched = matchTaskTitleShortcut(rest);
				if (matched.matchedPrefix) {
					rest = rest.slice(matched.matchedPrefix.length).replace(/^\s+/, '');
				}
			} catch {
				/* ignore */
			}
			if (rest === titleRest) return i;
		}
		return -1;
	}

	/**
	 * After reconcile, map the cursor line by walking the shared prefix and skipping removed lines above.
	 * @param {string[]} linesBefore
	 * @param {string[]} linesAfter
	 * @param {number} cursorLine
	 * @returns {number}
	 */
	function mapCursorLineAfterReconcile(linesBefore, linesAfter, cursorLine) {
		const cursorLineText = String(linesBefore[cursorLine] ?? '');

		let beforeIdx = 0;
		let afterIdx = 0;
		while (beforeIdx < cursorLine) {
			if (beforeIdx >= linesBefore.length) break;
			if (afterIdx < linesAfter.length && linesBefore[beforeIdx] === linesAfter[afterIdx]) {
				beforeIdx++;
				afterIdx++;
				continue;
			}
			beforeIdx++;
		}

		if (afterIdx < linesAfter.length && linesAfter[afterIdx] === cursorLineText) {
			return afterIdx;
		}

		const searchRadius = 4;
		for (let delta = 0; delta <= searchRadius; delta++) {
			for (const sign of delta === 0 ? [0] : [-1, 1]) {
				const idx = afterIdx + sign * delta;
				if (idx >= 0 && idx < linesAfter.length && linesAfter[idx] === cursorLineText) {
					return idx;
				}
			}
		}

		return Math.min(afterIdx, Math.max(0, linesAfter.length - 1));
	}

	function findSeparatorLineIndexInLines(lines) {
		for (let i = 0; i < lines.length; i++) {
			if (String(lines[i] || '').trim() === '---') return i;
		}
		return -1;
	}

	function restoreCursorInBodyRegion(bodyBefore, bodyAfter, bodyCursorLine, cursorBefore) {
		const currentLine = String(bodyBefore[bodyCursorLine] || '');

		if (
			bodyCursorLine + 1 < bodyAfter.length &&
			isHeadingIdentityLine(bodyAfter[bodyCursorLine]) &&
			bodyAfter[bodyCursorLine + 1] === currentLine
		) {
			return { line: bodyCursorLine + 1, col: cursorBefore.character };
		}

		if (
			bodyCursorLine > 0 &&
			isHeadingIdentityLine(bodyBefore[bodyCursorLine - 1]) &&
			bodyAfter[bodyCursorLine - 1] === currentLine
		) {
			return { line: bodyCursorLine - 1, col: cursorBefore.character };
		}

		if (
			bodyCursorLine < bodyAfter.length &&
			bodyAfter[bodyCursorLine] === currentLine &&
			bodyBefore.slice(0, bodyCursorLine).join('\n') === bodyAfter.slice(0, bodyCursorLine).join('\n')
		) {
			return { line: bodyCursorLine, col: cursorBefore.character };
		}

		const headingInfo = parseHeadingLineInfo(currentLine);
		if (headingInfo) {
			const newHeadingLine = findHeadingLineIndex(bodyAfter, headingInfo.indent, headingInfo.title);
			if (newHeadingLine >= 0) {
				return { line: newHeadingLine, col: cursorBefore.character };
			}
		}

		const newBodyLine = mapCursorLineAfterReconcile(bodyBefore, bodyAfter, bodyCursorLine);
		return { line: newBodyLine, col: cursorBefore.character };
	}

	function restoreCursorAfterReconcile(editor, textBefore, reconciled, cursorBefore) {
		if (!editor || !cursorBefore) return;
		const linesBefore = textBefore.replace(/\r\n/g, '\n').split('\n');
		const linesAfter = reconciled.replace(/\r\n/g, '\n').split('\n');
		const cursorLine = cursorBefore.line;
		const currentLine = String(linesBefore[cursorLine] || '');
		const sepBefore = findSeparatorLineIndexInLines(linesBefore);
		const sepAfter = findSeparatorLineIndexInLines(linesAfter);

		// Cursor in file header — only restore when the exact line is unchanged.
		if (sepBefore >= 0 && cursorLine <= sepBefore) {
			if (cursorLine < linesAfter.length && linesAfter[cursorLine] === currentLine) {
				const col = Math.min(cursorBefore.character, currentLine.length);
				const pos = new vscode.Position(cursorLine, col);
				editor.selection = new vscode.Selection(pos, pos);
			}
			return;
		}

		// Cursor in note body — map within body only (never jump into `headings:` metadata).
		if (sepBefore >= 0 && sepAfter >= 0 && cursorLine > sepBefore) {
			const bodyBefore = linesBefore.slice(sepBefore + 1);
			const bodyAfter = linesAfter.slice(sepAfter + 1);
			const bodyCursorLine = cursorLine - sepBefore - 1;
			const mapped = restoreCursorInBodyRegion(bodyBefore, bodyAfter, bodyCursorLine, cursorBefore);
			const lineText = bodyAfter[mapped.line] || '';
			const col = Math.min(mapped.col, lineText.length);
			const pos = new vscode.Position(sepAfter + 1 + mapped.line, col);
			editor.selection = new vscode.Selection(pos, pos);
			return;
		}

		// No `---` separator — fall back to whole-document mapping.
		if (
			cursorLine + 1 < linesAfter.length &&
			isHeadingIdentityLine(linesAfter[cursorLine]) &&
			linesAfter[cursorLine + 1] === currentLine
		) {
			const lineText = linesAfter[cursorLine + 1] || '';
			const col = Math.min(cursorBefore.character, lineText.length);
			const pos = new vscode.Position(cursorLine + 1, col);
			editor.selection = new vscode.Selection(pos, pos);
			return;
		}

		if (
			cursorLine > 0 &&
			isHeadingIdentityLine(linesBefore[cursorLine - 1]) &&
			linesAfter[cursorLine - 1] === currentLine
		) {
			const lineText = linesAfter[cursorLine - 1] || '';
			const col = Math.min(cursorBefore.character, lineText.length);
			const pos = new vscode.Position(cursorLine - 1, col);
			editor.selection = new vscode.Selection(pos, pos);
			return;
		}

		if (
			cursorLine < linesAfter.length &&
			linesAfter[cursorLine] === currentLine &&
			linesBefore.slice(0, cursorLine).join('\n') === linesAfter.slice(0, cursorLine).join('\n')
		) {
			const col = Math.min(cursorBefore.character, currentLine.length);
			const pos = new vscode.Position(cursorLine, col);
			editor.selection = new vscode.Selection(pos, pos);
			return;
		}

		const headingInfo = parseHeadingLineInfo(currentLine);
		if (headingInfo) {
			const newHeadingLine = findHeadingLineIndex(linesAfter, headingInfo.indent, headingInfo.title);
			if (newHeadingLine >= 0) {
				const lineText = linesAfter[newHeadingLine] || '';
				const col = Math.min(cursorBefore.character, lineText.length);
				const pos = new vscode.Position(newHeadingLine, col);
				editor.selection = new vscode.Selection(pos, pos);
				return;
			}
		}

		const newLine = mapCursorLineAfterReconcile(linesBefore, linesAfter, cursorLine);
		const lineText = linesAfter[newLine] || '';
		const col = Math.min(cursorBefore.character, lineText.length);
		const pos = new vscode.Position(newLine, col);
		editor.selection = new vscode.Selection(pos, pos);
	}

	/**
	 * When reconcile only inserts `@fN:hM` lines, tweaks `headings:`, and/or rewrites `.t` → `.tN`
	 * on heading titles, patch in place so the cursor is not disturbed by a full-buffer replace.
	 * @param {string} textBefore
	 * @param {string} reconciled
	 * @returns {{ inserts: { line: number, text: string }[], replacements: { line: number, text: string }[] } | null}
	 */
	function computeIncrementalIdentityPatches(textBefore, reconciled) {
		const linesBefore = textBefore.replace(/\r\n/g, '\n').split('\n');
		const linesAfter = reconciled.replace(/\r\n/g, '\n').split('\n');
		/** @type {{ line: number, text: string }[]} */
		const inserts = [];
		/** @type {{ line: number, text: string }[]} */
		const replacements = [];
		const sepBefore = findSeparatorLineIndexInLines(linesBefore);
		const sepAfter = findSeparatorLineIndexInLines(linesAfter);

		/**
		 * @param {string} title
		 * @returns {string}
		 */
		function titleRestAfterTaskShortcut(title) {
			try {
				const { matchTaskTitleShortcut } = require('../document/workflow/dripnoteWorkflowParse');
				const matched = matchTaskTitleShortcut(title);
				if (matched.matchedPrefix) {
					return String(title || '')
						.trim()
						.slice(matched.matchedPrefix.length)
						.replace(/^\s+/, '');
				}
			} catch {
				/* ignore */
			}
			return String(title || '').trim().replace(/^\.t\d*\s*/i, '');
		}

		/**
		 * @param {string} a
		 * @param {string} b
		 */
		function isTaskIdOnlyHeadingChange(beforeLine, afterLine) {
			const pb = parseHeadingForValidation(beforeLine);
			const pa = parseHeadingForValidation(afterLine);
			if (!pb || !pa) return false;
			if (pb.tabDepth !== pa.tabDepth || pb.level !== pa.level) return false;
			return titleRestAfterTaskShortcut(pb.title) === titleRestAfterTaskShortcut(pa.title);
		}

		let bi = 0;
		let ai = 0;
		while (bi < linesBefore.length || ai < linesAfter.length) {
			if (bi < linesBefore.length && ai < linesAfter.length && linesBefore[bi] === linesAfter[ai]) {
				bi += 1;
				ai += 1;
				continue;
			}
			if (ai < linesAfter.length && isHeadingIdentityLine(linesAfter[ai])) {
				if (bi < linesBefore.length && isHeadingIdentityLine(linesBefore[bi])) {
					replacements.push({ line: bi, text: linesAfter[ai] });
					bi += 1;
					ai += 1;
					continue;
				}
				inserts.push({ line: bi, text: linesAfter[ai] });
				ai += 1;
				continue;
			}
			if (
				bi < linesBefore.length &&
				ai < linesAfter.length &&
				sepBefore >= 0 &&
				sepAfter >= 0 &&
				bi < sepBefore &&
				ai < sepAfter &&
				/^\s*headings\s*:/i.test(String(linesAfter[ai] || ''))
			) {
				replacements.push({ line: bi, text: linesAfter[ai] });
				bi += 1;
				ai += 1;
				continue;
			}
			if (
				bi < linesBefore.length &&
				ai < linesAfter.length &&
				isTaskIdOnlyHeadingChange(linesBefore[bi], linesAfter[ai])
			) {
				replacements.push({ line: bi, text: linesAfter[ai] });
				bi += 1;
				ai += 1;
				continue;
			}
			return null;
		}
		return { inserts, replacements };
	}

	/**
	 * Same line count; only `@fN:hM` and/or `.tN` heading title lines differ.
	 * @param {string} textBefore
	 * @param {string} reconciled
	 * @returns {{ inserts: { line: number, text: string }[], replacements: { line: number, text: string }[] } | null}
	 */
	function computeIdentityOnlyReplacements(textBefore, reconciled) {
		const linesBefore = textBefore.replace(/\r\n/g, '\n').split('\n');
		const linesAfter = reconciled.replace(/\r\n/g, '\n').split('\n');
		if (linesBefore.length !== linesAfter.length) return null;
		/** @type {{ line: number, text: string }[]} */
		const replacements = [];
		for (let i = 0; i < linesBefore.length; i++) {
			if (linesBefore[i] === linesAfter[i]) continue;
			if (isHeadingIdentityLine(linesBefore[i]) && isHeadingIdentityLine(linesAfter[i])) {
				replacements.push({ line: i, text: linesAfter[i] });
				continue;
			}
			const pb = parseHeadingForValidation(linesBefore[i]);
			const pa = parseHeadingForValidation(linesAfter[i]);
			if (pb && pa) {
				try {
					const { matchTaskTitleShortcut } = require('../document/workflow/dripnoteWorkflowParse');
					const mb = matchTaskTitleShortcut(pb.title);
					const ma = matchTaskTitleShortcut(pa.title);
					const restB = mb.matchedPrefix
						? String(pb.title).trim().slice(mb.matchedPrefix.length).replace(/^\s+/, '')
						: String(pb.title).trim();
					const restA = ma.matchedPrefix
						? String(pa.title).trim().slice(ma.matchedPrefix.length).replace(/^\s+/, '')
						: String(pa.title).trim();
					if (pb.tabDepth === pa.tabDepth && restB === restA) {
						replacements.push({ line: i, text: linesAfter[i] });
						continue;
					}
				} catch {
					/* fall through */
				}
			}
			return null;
		}
		return replacements.length ? { inserts: [], replacements } : null;
	}

	async function applyReconciledTextToDocument(document, reconciled) {
		const key = document.uri.toString();
		const doc = getOpenDocument(document.uri) || document;
		if (doc.isClosed) return false;

		const text = doc.getText();
		const normalized = text.replace(/\r\n/g, '\n');
		if (reconciled === normalized) return true;

		const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === key);
		const cursorBefore = editor?.selection.active;
		const patches =
			computeIncrementalIdentityPatches(normalized, reconciled) ||
			computeIdentityOnlyReplacements(normalized, reconciled);

		reconcileEditDepth += 1;
		try {
			if (editor && patches) {
				const ok = await editor.edit(
					editBuilder => {
						for (const rep of [...patches.replacements].sort((a, b) => b.line - a.line)) {
							const lineText = String(doc.lineAt(rep.line).text || '');
							editBuilder.replace(
								new vscode.Range(rep.line, 0, rep.line, lineText.length),
								rep.text
							);
						}
						for (const ins of [...patches.inserts].sort((a, b) => b.line - a.line)) {
							editBuilder.insert(new vscode.Position(ins.line, 0), `${ins.text}\n`);
						}
					},
					{ undoStopBefore: false, undoStopAfter: false }
				);
				if (ok) {
					if (cursorBefore) {
						let lineOffset = 0;
						for (const ins of patches.inserts) {
							if (ins.line <= cursorBefore.line) {
								lineOffset += 1;
							}
						}
						const pos = new vscode.Position(
							cursorBefore.line + lineOffset,
							cursorBefore.character
						);
						editor.selection = new vscode.Selection(pos, pos);
					}
					return true;
				}
			}

			const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
			if (editor) {
				const ok = await editor.edit(
					editBuilder => {
						editBuilder.replace(fullRange, reconciled);
					},
					{ undoStopBefore: false, undoStopAfter: false }
				);
				if (ok) {
					restoreCursorAfterReconcile(editor, normalized, reconciled, cursorBefore);
					return true;
				}
			}
			const applied = await vscode.workspace.applyEdit(
				new vscode.WorkspaceEdit().replace(doc.uri, fullRange, reconciled)
			);
			if (applied) {
				if (editor) {
					restoreCursorAfterReconcile(editor, normalized, reconciled, cursorBefore);
				}
				return true;
			}
			console.warn('[DRIP] could not apply heading identity edit to document');
			return false;
		} finally {
			reconcileEditDepth -= 1;
		}
	}

	function getOrCreateHeadingIdPool(doc, text) {
		const key = doc.uri.toString();
		const rebuilt = buildHeadingIdPoolFromText(text);
		const prev = headingIdPoolByUri.get(key);
		if (prev) {
			rebuilt.nextId = Math.max(rebuilt.nextId, prev.nextId);
		}
		headingIdPoolByUri.set(key, rebuilt);
		return rebuilt;
	}

	function refreshHeadingIdPool(doc, text, usedNonH0Ids) {
		const key = doc.uri.toString();
		const pool = getOrCreateHeadingIdPool(doc, text);
		syncHeadingIdPoolFromAllocator(
			pool,
			headingIdPoolToAllocator(pool),
			usedNonH0Ids,
			parseHeadingsCountFromLines(String(text || '').replace(/\r\n/g, '\n').split('\n'))
		);
		return pool;
	}

	function rememberFileEntityFromText(uriKey, text) {
		const file = parseFileEntityFromLines(String(text || '').replace(/\r\n/g, '\n').split('\n'));
		if (file) {
			fileEntityByUri.set(uriKey, file);
		}
		return file;
	}

	function getKnownFileEntity(doc, text) {
		const key = doc.uri.toString();
		return parseFileEntityFromLines(text.split('\n')) || fileEntityByUri.get(key) || null;
	}

	async function ensureFileEntityCached(kbRoot, doc, text) {
		const key = doc.uri.toString();
		const fromHeader = parseFileEntityFromLines(text.split('\n'));
		if (fromHeader) {
			fileEntityByUri.set(key, fromHeader);
			return fromHeader;
		}
		const cached = fileEntityByUri.get(key);
		if (cached) return cached;
		if (!kbRoot) return null;
		const resolved = await resolveSequentialFileEntityForKbNote(kbRoot, doc.uri, text);
		if (resolved) {
			fileEntityByUri.set(key, resolved);
		}
		return resolved;
	}

	async function reconcileKbNoteText(kbRoot, text, noteUri, options = {}) {
		const normalized = String(text || '').replace(/\r\n/g, '\n');
		const headingResult = await reconcileHeadingIdentitiesForKbNote(kbRoot, normalized, {
			previousFullText: normalized,
			noteUri,
			...options
		});
		const { reconcileWorkflowTaskIdsForKbNote } = require('../document/workflow/dripnoteWorkflowTaskIdentity');
		const wfResult = await reconcileWorkflowTaskIdsForKbNote(kbRoot, headingResult.text, {
			noteUri,
			lockedFile: headingResult.lockedFile || null
		});
		return {
			...headingResult,
			text: wfResult.text,
			changed: Boolean(headingResult.changed || wfResult.changed)
		};
	}

	async function reconcileAndApplyHeadingIdentities(document, options = {}) {
		if (!isKbNoteDocument(document)) return;
		const doc = getOpenDocument(document.uri);
		if (!doc || doc.isClosed) return;

		const kbRoot = state.getKnowledgeBaseRoot();
		const key = doc.uri.toString();
		let text = doc.getText().replace(/\r\n/g, '\n');

		const lockedFile = await ensureFileEntityCached(kbRoot, doc, text);
		if (!lockedFile) {
			console.warn(
				'[DRIP] heading identity reconcile skipped — could not resolve fileid for',
				doc.uri.fsPath
			);
			return;
		}
		const headingIdPool = getOrCreateHeadingIdPool(doc, text);

		for (let attempt = 0; attempt < 4; attempt += 1) {
			const result = await reconcileKbNoteText(kbRoot, text, doc.uri, {
				...options,
				headingIdPool,
				lockedFile
			});
			const reconciled = result.text;
			const changed = result.changed;
			rememberFileEntityFromText(key, reconciled);
			if (!parseFileEntityFromLines(reconciled.split('\n'))) {
				fileEntityByUri.set(key, lockedFile);
			}
			refreshHeadingIdPool(doc, reconciled, result.usedNonH0Ids || []);
			lastMetadataSigByDoc.set(key, computeMetadataEditSignature(reconciled));
			if (!changed && reconciled === text) {
				if (!noteNeedsImmediateIdWork(text)) {
					return;
				}
				if (attempt >= 3) {
					break;
				}
				continue;
			}
			const applied = await applyReconciledTextToDocument(doc, reconciled);
			if (!applied) {
				console.warn('[DRIP] heading identity reconcile could not apply edit');
				return;
			}
			text = doc.getText().replace(/\r\n/g, '\n');
			if (!noteNeedsImmediateIdWork(text)) {
				return;
			}
		}
	}

	function startHeadingReconcile(document, options = {}) {
		const key = document.uri.toString();
		if (headingReconcileInFlight.has(key)) {
			headingReconcilePending.add(key);
			pendingReconcileOptionsByUri.set(key, {
				...(pendingReconcileOptionsByUri.get(key) || {}),
				...options,
				refreshHashes:
					Boolean((pendingReconcileOptionsByUri.get(key) || {}).refreshHashes) ||
					Boolean(options.refreshHashes)
			});
			return;
		}

		const doc = getOpenDocument(document.uri);
		if (!doc || doc.isClosed) return;

		const pendingOpts = pendingReconcileOptionsByUri.get(key) || {};
		pendingReconcileOptionsByUri.delete(key);
		const runOpts = {
			...pendingOpts,
			...options,
			refreshHashes: Boolean(options.refreshHashes) || Boolean(pendingOpts.refreshHashes)
		};

		const run = new Promise(resolve => {
			queueMicrotask(() => {
				resolve(reconcileAndApplyHeadingIdentities(doc, runOpts));
			});
		}).catch(err => {
			console.error('[DRIP] immediate heading identity reconcile failed', err);
		});
		headingReconcileInFlight.set(key, run);
		void run.finally(() => {
			if (headingReconcileInFlight.get(key) === run) {
				headingReconcileInFlight.delete(key);
			}
			if (headingReconcilePending.delete(key)) {
				const latest = getOpenDocument(document.uri);
				const nextOpts = pendingReconcileOptionsByUri.get(key) || { refreshHashes: false };
				pendingReconcileOptionsByUri.delete(key);
				if (latest && !latest.isClosed) {
					startHeadingReconcile(latest, nextOpts);
				}
			}
		});
	}

	function requestImmediateIdAllocation(document, options = {}) {
		const key = document.uri.toString();
		const prev = pendingIdAllocateTimers.get(key);
		if (prev) clearTimeout(prev);
		const text = document.getText().replace(/\r\n/g, '\n');
		let delay = HEADING_ID_ALLOCATION_DEBOUNCE_MS;
		try {
			const {
				needsImmediateWorkflowTaskIdAllocation
			} = require('../document/workflow/dripnoteWorkflowTaskIdentity');
			if (needsImmediateWorkflowTaskIdAllocation(text)) delay = 120;
		} catch {
			/* ignore */
		}
		if (options.refreshHashes) delay = Math.min(delay, 350);
		const timer = setTimeout(() => {
			pendingIdAllocateTimers.delete(key);
			const doc = getOpenDocument(document.uri);
			if (!doc || doc.isClosed) return;
			if (shouldDeferHeadingIdAllocation(doc)) return;
			startHeadingReconcile(doc, {
				refreshHashes: Boolean(options.refreshHashes)
			});
		}, delay);
		pendingIdAllocateTimers.set(key, timer);
	}

	function scheduleHashRefresh(document) {
		const key = document.uri.toString();
		const prev = hashRefreshTimers.get(key);
		if (prev) clearTimeout(prev);
		hashRefreshTimers.set(
			key,
			setTimeout(() => {
				hashRefreshTimers.delete(key);
				const doc = getOpenDocument(document.uri);
				if (!doc || doc.isClosed) return;
				startHeadingReconcile(doc, { refreshHashes: true });
			}, HEADING_HASH_REFRESH_MS)
		);
	}

	async function flushHeadingHashesOnClose(document) {
		if (!isKbNoteDocument(document)) return;
		const kbRoot = state.getKnowledgeBaseRoot();
		const text = document.getText().replace(/\r\n/g, '\n');
		try {
			const { text: reconciled, changed } = await reconcileKbNoteText(kbRoot, text, document.uri, {
				refreshHashes: true
			});
			if (!changed) return;
			await writeTextFile(document.uri, reconciled);
			if (kbRoot) {
				await indexQueue.flushNoteUpdate(document.uri);
			}
		} catch (err) {
			console.error('[DRIP] heading hash refresh on close failed', err);
		}
	}

	async function maybeReconcileHeadingIdentitiesOnOpen(document) {
		if (!isDripnoteFileDocument(document)) return;

		/* Startup must finish first so KB root / index.drip exist before isKbNoteDocument. */
		await ensureStartupIndexReconcile();
		if (!isKbNoteDocument(document)) return;

		const kbRoot = state.getKnowledgeBaseRoot();
		const text = document.getText().replace(/\r\n/g, '\n');
		const lockedFile = await ensureFileEntityCached(kbRoot, document, text);
		const headingIdPool = getOrCreateHeadingIdPool(document, text);
		const { text: reconciled, changed } = await reconcileKbNoteText(kbRoot, text, document.uri, {
			refreshHashes: true,
			lockedFile,
			headingIdPool
		});
		const key = document.uri.toString();
		rememberFileEntityFromText(key, reconciled);
		if (lockedFile && !parseFileEntityFromLines(reconciled.split('\n'))) {
			fileEntityByUri.set(key, lockedFile);
		}
		refreshHeadingIdPool(document, reconciled, []);
		lastMetadataSigByDoc.set(key, computeMetadataEditSignature(reconciled));

		if (!changed && reconciled === text) {
			return;
		}

		await applyReconciledTextToDocument(document, reconciled);
		if (!document.isDirty) {
			try {
				await writeTextFile(document.uri, reconciled);
				if (kbRoot) {
					indexQueue.scheduleNoteUpdate(document.uri, { immediate: true });
				}
			} catch (err) {
				console.error('[DRIP] writeTextFile after heading identity reconcile', err);
			}
		}
	}

	/**
	 * After KB startup: scan every open .d.txt tab and reconcile missing ids + hashes.
	 */
	async function reconcileAllOpenKbNotes() {
		await ensureStartupIndexReconcile();
		const docs = vscode.workspace.textDocuments.filter(d => isKbNoteDocument(d));
		for (const doc of docs) {
			try {
				await maybeReconcileHeadingIdentitiesOnOpen(doc);
			} catch (err) {
				console.error('[DRIP] open-tab heading reconcile failed', doc.uri.fsPath, err);
			}
		}
	}

	function headingCountFromMetadataSignature(sig) {
		if (!sig) return 0;
		return String(sig).split('|').filter(part => part.length > 0).length;
	}

	function scheduleBufferedIndexUpdate(document, contentChanges) {
		if (!isKbNoteDocument(document)) return;
		indexQueue.scheduleNoteUpdate(document.uri, {
			contentChanges: contentChanges || []
		});
	}

	async function flushBufferedIndexUpdate(document) {
		if (!isKbNoteDocument(document)) return;
		await indexQueue.flushNoteUpdate(document.uri);
	}

	context.subscriptions.push(
		vscode.workspace.onWillSaveTextDocument(e => {
			if (!isKbNoteDocument(e.document)) return;
			const kbRoot = state.getKnowledgeBaseRoot();
			e.waitUntil(
				(async () => {
					try {
						const text = e.document.getText().replace(/\r\n/g, '\n');
						const lockedFile = await ensureFileEntityCached(kbRoot, e.document, text);
						const headingIdPool = getOrCreateHeadingIdPool(e.document, text);
						const { text: reconciled } = await reconcileKbNoteText(
							kbRoot,
							text,
							e.document.uri,
							{
								refreshHashes: true,
								lockedFile,
								headingIdPool
							}
						);
						lastMetadataSigByDoc.set(
							e.document.uri.toString(),
							computeMetadataEditSignature(reconciled)
						);
						await applyReconciledTextToDocument(e.document, reconciled);
					} catch (err) {
						console.error('[DRIP] heading identity reconcile on save failed', err);
					}
				})()
			);
		})
	);

	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection(e => {
			if (reconcileEditDepth > 0) return;
			if (!isKbNoteDocument(e.textEditor.document)) return;
			flushPendingHeadingIdAllocation(e.textEditor.document);
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(ev => {
			if (reconcileEditDepth > 0) return;
			const doc = ev.document;
			if (!isKbNoteDocument(doc)) return;

			const text = doc.getText();
			const key = doc.uri.toString();

			const metaSig = computeMetadataEditSignature(text);
			const prevSig = lastMetadataSigByDoc.get(key);
			const metaChanged = metaSig !== prevSig;
			const needsIds = needsImmediateHeadingIdAllocation(text);

			if (needsIds) {
				requestImmediateIdAllocation(doc, { refreshHashes: metaChanged });
			} else if (metaChanged) {
				const prevCount = headingCountFromMetadataSignature(prevSig);
				const nextCount = headingCountFromMetadataSignature(metaSig);
				if (prevCount !== nextCount) {
					requestImmediateIdAllocation(doc, { refreshHashes: true });
				} else {
					scheduleHashRefresh(doc);
				}
			}

			if (metaChanged) {
				lastMetadataSigByDoc.set(key, metaSig);
			}

			scheduleBufferedIndexUpdate(doc, ev.contentChanges);
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(doc => {
			if (!isKbNoteDocument(doc)) return;
			flushPendingHeadingIdAllocation(doc);
			scheduleBufferedIndexUpdate(doc);
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(doc => {
			void (async () => {
				await maybeRealignFileIdOnOpen(doc);
				if (isDripnoteFileDocument(doc)) {
					await ensureStartupIndexReconcile();
					if (isKbNoteDocument(doc)) {
						const kbRoot = state.getKnowledgeBaseRoot();
						const text = doc.getText().replace(/\r\n/g, '\n');
						headingIdPoolByUri.set(doc.uri.toString(), buildHeadingIdPoolFromText(text));
						await ensureFileEntityCached(kbRoot, doc, text);
					}
				}
				await maybeReconcileHeadingIdentitiesOnOpen(doc);
			})().catch(err => {
				console.error('[DRIP] dripnote open reconcile', err);
			});
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidRenameFiles(e => {
			void (async () => {
				const kbRoot = state.getKnowledgeBaseRoot();
				if (!kbRoot) return;
				for (const f of e.files || []) {
					indexQueue.cancelNoteUpdate(f.oldUri);
					lastMetadataSigByDoc.delete(String(f.oldUri || ''));
					fileEntityByUri.delete(String(f.oldUri || ''));
					headingIdPoolByUri.delete(String(f.oldUri || ''));
					const oldRel = path.relative(kbRoot.fsPath, f.oldUri.fsPath);
					const newRel = path.relative(kbRoot.fsPath, f.newUri.fsPath);
					if (oldRel.startsWith('..') || path.isAbsolute(oldRel)) continue;
					if (!newRel.startsWith('..') && !path.isAbsolute(newRel)) {
						await removeFileFromDripIndex(kbRoot, oldRel.replace(/\\/g, '/'));
						indexQueue.scheduleNoteUpdate(f.newUri, { immediate: true });
					}
				}
			})().catch(err => console.error('[DRIP] onDidRenameFiles index sync', err));
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidDeleteFiles(e => {
			void (async () => {
				const kbRoot = state.getKnowledgeBaseRoot();
				if (!kbRoot) return;
				for (const f of e.files || []) {
					const key = String(f.toString());
					indexQueue.cancelNoteUpdate(f);
					lastMetadataSigByDoc.delete(key);
					const rel = path.relative(kbRoot.fsPath, f.fsPath);
					if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
					await removeFileFromDripIndex(kbRoot, rel.replace(/\\/g, '/'));
				}
			})().catch(err => console.error('[DRIP] onDidDeleteFiles index sync', err));
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument(doc => {
			const key = String(doc.uri);
			clearHeadingTimersForUri(key);
			lastMetadataSigByDoc.delete(key);
			fileEntityByUri.delete(key);
			headingIdPoolByUri.delete(key);
			void flushBufferedIndexUpdate(doc).catch(err => {
				console.error('[DRIP] flush buffered index on close', err);
			});
			void flushHeadingHashesOnClose(doc);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('drip.rebuildKbIndexNow', async () => {
			if (!isStartupCheckReady()) {
				const check = await runStartupCheck(context, state);
				if (!check.ok) {
					return;
				}
			}
			const kbRoot = await state.ensureKnowledgeBaseRoot();
			if (!kbRoot) return;
			await indexQueue.flushAllPending();
			await updateKnowledgeBase(context, kbRoot, { force: true });
		}),
		vscode.commands.registerCommand('drip.updateIndexScope', async item => {
			const kbRoot = await state.ensureKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a knowledge base folder first.');
				return;
			}
			const scopeUri = item?.uri || item?.resourceUri;
			if (!scopeUri) {
				void vscode.window.showWarningMessage('Select a file or folder in the knowledge base tree.');
				return;
			}
			try {
				await indexQueue.flushAllPending();
				const { total, updated, failed, issues } = await updateDripIndexScope(kbRoot, scopeUri, context);
				if (!total) {
					void vscode.window.showInformationMessage('No indexable notes in that scope.');
					return;
				}
				const summary = `DRIP index: ${updated} updated, ${failed} failed, ${total} note(s) in scope.`;
				const errors = (issues || []).filter(i => i.severity === 'error');
				const warnings = (issues || []).filter(i => i.severity === 'warning');
				if (failed > 0 || errors.length) {
					const lines = errors.slice(0, 10).map(i => {
						const loc = i.line ? `${i.path}:${i.line}` : i.path;
						return `${loc}: ${i.message}`;
					});
					if (errors.length > 10) {
						lines.push(`…and ${errors.length - 10} more error(s)`);
					}
					void vscode.window.showWarningMessage(`${summary} ${lines.join(' | ')}`);
					return;
				}
				if (warnings.length) {
					const lines = warnings.slice(0, 6).map(i => {
						const loc = i.line ? `${i.path}:${i.line}` : i.path;
						return `${loc}: ${i.message}`;
					});
					if (warnings.length > 6) {
						lines.push(`…and ${warnings.length - 6} more warning(s)`);
					}
					void vscode.window.showInformationMessage(`${summary} Warnings: ${lines.join(' | ')}`);
					return;
				}
				void vscode.window.showInformationMessage(summary);
			} catch (err) {
				console.error('[DRIP] drip.updateIndexScope', err);
				void vscode.window.showErrorMessage(
					`DRIP could not update index: ${err && err.message ? err.message : String(err)}`
				);
			}
		}),
		vscode.commands.registerCommand('drip.reconcileHeadingsScope', async item => {
			const kbRoot = await state.ensureKnowledgeBaseRoot();
			if (!kbRoot) {
				void vscode.window.showWarningMessage('Select a knowledge base folder first.');
				return;
			}
			const scopeUri = item?.uri || item?.resourceUri;
			if (!scopeUri) {
				void vscode.window.showWarningMessage('Select a file or folder in the knowledge base tree.');
				return;
			}
			try {
				await indexQueue.flushAllPending();
				const { total, changed, failed, issues } = await reconcileHeadingIdentitiesScope(
					kbRoot,
					scopeUri,
					context
				);
				if (!total) {
					void vscode.window.showInformationMessage('No notes to reconcile in that scope.');
					return;
				}
				const summary = `DRIP headings: ${changed} updated, ${failed} failed, ${total} note(s) in scope.`;
				const errors = (issues || []).filter(i => i.severity === 'error');
				const warnings = (issues || []).filter(i => i.severity === 'warning');
				if (failed > 0 || errors.length) {
					const lines = errors.slice(0, 10).map(i => {
						const loc = i.line ? `${i.path}:${i.line}` : i.path;
						return `${loc}: ${i.message}`;
					});
					if (errors.length > 10) {
						lines.push(`…and ${errors.length - 10} more error(s)`);
					}
					void vscode.window.showWarningMessage(`${summary} ${lines.join(' | ')}`);
					return;
				}
				if (warnings.length) {
					const lines = warnings.slice(0, 6).map(i => {
						const loc = i.line ? `${i.path}:${i.line}` : i.path;
						return `${loc}: ${i.message}`;
					});
					if (warnings.length > 6) {
						lines.push(`…and ${warnings.length - 6} more warning(s)`);
					}
					void vscode.window.showInformationMessage(`${summary} Warnings: ${lines.join(' | ')}`);
					return;
				}
				void vscode.window.showInformationMessage(summary);
			} catch (err) {
				console.error('[DRIP] drip.reconcileHeadingsScope', err);
				void vscode.window.showErrorMessage(
					`DRIP could not reconcile headings: ${err && err.message ? err.message : String(err)}`
				);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('drip.processPendingLinkMigrations', async () => {
			const kbRoot = await state.ensureKnowledgeBaseRoot();
			if (!kbRoot) return;
			try {
				const { total, applied, skipped } = await processAllPendingLinkMigrations(kbRoot, context);
				void vscode.window.showInformationMessage(
					`DRIP link migrations: ${applied} applied, ${skipped} skipped or failed, ${total} total pending rows seen.`
				);
			} catch (err) {
				console.error('[DRIP] processPendingLinkMigrations', err);
				void vscode.window.showErrorMessage(
					`DRIP could not process pending link migrations: ${err && err.message ? err.message : String(err)}`
				);
			}
		})
	);

	void (async () => {
		await ensureStartupIndexReconcile();
		await reconcileAllOpenKbNotes();
	})().catch(err => {
		console.error('[DRIP] startup open-tab heading reconcile', err);
	});
}

module.exports = {
	registerDripnoteIndexSync,
	DOCUMENT_WATCH_MANIFEST
};
