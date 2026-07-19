'use strict';

const path = require('path');
const vscode = require('vscode');
const {
	fileNameMatchesKbNote,
	buildNoteFileName
} = require('./model/noteFileTypes');
const { formatFileEntityId } = require('../indexing/dripnoteEntityIds');
const {
	forEachKnowledgeBaseNotePath,
	getKnowledgeBaseTreeChildren,
	isPathIgnored,
	listImmediateFolderChildrenOfRoot,
	readTextFile,
	toRelativePath,
	walkKbNoteFiles,
	writeTextFile
} = require('../indexing/kbFilesystem');

async function scanKnowledgeBaseNotes(rootUri) {
	const results = [];
	await scanFolder(rootUri, rootUri, results);
	return results;
}

async function scanFolder(rootUri, currentUri, results) {
	await walkKbNoteFiles(rootUri, currentUri, async note => {
		const headingPaths = extractHeadingPathsFromDripFile(note.text, { fileFsPath: note.uri.fsPath }).join('\n');
		results.push({
			uri: note.uri,
			relativePath: note.relativePath,
			text: note.text,
			searchText: `${note.relativePath}\n${headingPaths}\n${note.text}`
		});
	});
}

/**
 * Visit each KB note without building a giant in-memory array (reduces peak RAM vs scanKnowledgeBaseNotes).
 * @param {import('vscode').Uri} rootUri
 * @param {(note: { uri: import('vscode').Uri, relativePath: string, text: string }) => void | Promise<void>} visitor
 * @param {{ yieldEvery?: number }} [options]
 */
async function forEachKnowledgeBaseNote(rootUri, visitor, options) {
	const yieldEvery = options && options.yieldEvery > 0 ? options.yieldEvery : 25;
	let n = 0;
	await walkKbNoteFiles(rootUri, rootUri, async note => {
		await visitor(note);
		n += 1;
		if (n % yieldEvery === 0) {
			await new Promise(r => setImmediate(r));
		}
	});
}

function similarityScore(noteInput, candidateText) {
	const noteTokens = tokenize(`${noteInput.title}\n${noteInput.headings}\n${noteInput.content}`);
	const candidateTokens = tokenize(candidateText);

	if (!noteTokens.size || !candidateTokens.size) {
		return 0;
	}

	let overlap = 0;
	for (const token of noteTokens) {
		if (candidateTokens.has(token)) {
			overlap += 1;
		}
	}

	return overlap / Math.sqrt(noteTokens.size * candidateTokens.size);
}

function embeddingSimilarity(text, candidateLabel) {
	return similarityScore(
		{
			title: text,
			headings: '',
			content: ''
		},
		candidateLabel
	);
}

async function chooseTargetFolder(rootUri, noteInput) {
	const headingText = `${noteInput.title}\n${noteInput.headings}`;
	let currentUri = rootUri;

	while (true) {
		const entries = await vscode.workspace.fs.readDirectory(currentUri);
		const folderCandidates = [];

		for (const [name, type] of entries) {
			if (type !== vscode.FileType.Directory) {
				continue;
			}
			if (name === '.img') {
				continue;
			}

			const childUri = vscode.Uri.joinPath(currentUri, name);
			const relativePath = toRelativePath(rootUri, childUri);

			if (await isPathIgnored(rootUri, relativePath)) {
				continue;
			}

			folderCandidates.push({ name, uri: childUri, relativePath });
		}

		if (!folderCandidates.length) {
			return currentUri;
		}

		const ranked = folderCandidates
			.map(candidate => ({
				...candidate,
				score: embeddingSimilarity(headingText, `${candidate.relativePath} ${candidate.name}`)
			}))
			.sort((left, right) => right.score - left.score);

		const best = ranked[0];
		if (!best || best.score < 0.15) {
			return currentUri;
		}

		currentUri = best.uri;
	}
}

/**
 * @param {import('vscode').Uri} rootUri
 * @param {{ title?: string, headings?: string, content?: string }} noteInput
 * @param {number} limit
 * @param {{ useEmbeddings?: boolean, embeddingModelId?: string }} [options]
 */
async function rankFolderCandidates(rootUri, noteInput, limit = 4, options = {}) {
	const headingText = `${noteInput.title}\n${noteInput.headings}\n${noteInput.content || ''}`;
	const folders = await listImmediateFolderChildrenOfRoot(rootUri);

	/** @type {Array<{ uri: import('vscode').Uri, label: string, scoreValue: number, candidateText: string, action: string }>} */
	let pool = folders.map(folder => {
		const candidateText = `${folder.relativePath} ${folder.label}`;
		return {
			uri: folder.uri,
			label: folder.relativePath,
			scoreValue: embeddingSimilarity(headingText, candidateText),
			candidateText,
			action: 'folder'
		};
	});

	pool.sort((a, b) => b.scoreValue - a.scoreValue);

	if (options.useEmbeddings === true && pool.length > 0) {
		const { rescorePoolWithEmbeddings, truncate } = require('../retrieval/embeddings');
		await rescorePoolWithEmbeddings(pool, truncate(headingText), {
			modelId: options.embeddingModelId
		});
		pool.sort((a, b) => b.scoreValue - a.scoreValue);
	}

	return pool.slice(0, limit).map(folder => ({
		uri: folder.uri,
		label: folder.label,
		score: folder.scoreValue.toFixed(2),
		action: 'folder'
	}));
}

function tokenize(value) {
	return new Set(
		String(value)
			.toLowerCase()
			.split(/[^a-z0-9]+/g)
			.filter(token => token.length > 2)
	);
}

function extractHeadingPath(headingsText) {
	// Convert a markdown heading block (e.g. "# A\n## B\n## C") into a stable path like "A/C".
	// This is used to later insert content under the correct heading/sub-heading.
	const lines = String(headingsText || '')
		.split(/\r?\n/)
		.map(l => l.trim())
		.filter(Boolean);

	const stack = [];
	for (const line of lines) {
		const match = line.match(/^(#{1,6})\s+(.+)$/);
		if (!match) {
			continue;
		}

		const level = match[1].length; // '#' => 1, '##' => 2, etc.
		const title = match[2].trim();

		stack[level - 1] = title; // replace anything at this level
		stack.length = Math.max(stack.length, level);
	}

	return stack.filter(Boolean).join('/');
}

function parseDripNoteEntries(noteText) {
	// Split `.d.txt` content into repeatable entries.
	// Entries are delimited by a line containing exactly `---`.
	const normalized = String(noteText || '')
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n');
	if (!/^---\s*$/m.test(normalized)) {
		// Back-compat with older files that didn't store repeatable entries.
		return [normalized.trim()].filter(Boolean);
	}

	return normalized
		.split(/^---\s*$/m)
		.map(p => p.trim())
		.filter(Boolean);
}

function extractHeadingPathFromEntry(entryText) {
	const entry = String(entryText || '');

	// Prefer the explicit metadata line (new format).
	const metaMatch = entry.match(/^HeadingPath:\s*(.+)$/m);
	if (metaMatch?.[1]) {
		return metaMatch[1].trim().replace(/\\/g, '/');
	}

	// Fallback: derive from markdown heading lines inside the entry.
	const headingLines = entry
		.split(/\r?\n/)
		.filter(line => /^#{1,6}\s+/.test(line.trim()))
		.join('\n');

	if (!headingLines) {
		return '';
	}

	return extractHeadingPath(headingLines);
}

function buildHeadingPathPrefixes(headingPath) {
	const normalized = String(headingPath || '').trim().replace(/\\/g, '/');
	if (!normalized) {
		return [];
	}

	const segments = normalized.split('/').filter(Boolean);
	const prefixes = [];
	for (let i = 1; i <= segments.length; i++) {
		prefixes.push(segments.slice(0, i).join('/'));
	}
	return prefixes;
}

function headingPathToMarkdownBlock(headingPath) {
	// Convert "A/B/C" => "# A\n## B\n### C"
	const normalized = String(headingPath || '').trim().replace(/\\/g, '/');
	if (!normalized) {
		return '';
	}

	const segments = normalized.split('/').filter(Boolean);
	return segments
		.map((seg, idx) => `${'#'.repeat(idx + 1)} ${seg}`)
		.join('\n');
}

/**
 * Type-1 `.d.txt`: file metadata + h0 heading block, then `---`, then remaining headings/body.
 * Legacy notes may still use `filename:` … `---` with only key/value lines above the separator.
 */
function splitFileHeaderAndBody(text) {
	const raw = String(text || '').replace(/\r\n/g, '\n');
	const lines = raw.split('\n');
	if (!lines.length || !/^filename:\s*/i.test(lines[0] || '')) {
		return { headerMeta: '', body: raw, hasFileMeta: false, metadata: {}, bodyStartLine: 0 };
	}

	const metaLines = [];
	const metadata = {};
	let i = 0;
	for (; i < lines.length; i++) {
		const line = lines[i];
		const fn = line.match(/^filename:\s*(.*)$/i);
		if (fn) {
			metaLines.push(line);
			metadata.filename = fn[1].trim();
			continue;
		}
		const cr = line.match(/^created:\s*(.*)$/i);
		if (cr) {
			metaLines.push(line);
			metadata.created = cr[1].trim();
			continue;
		}
		if (/^---\s*$/.test(line.trim())) {
			i++;
			break;
		}
		metaLines.push(line);
	}

	const body = lines.slice(i).join('\n');
	return {
		headerMeta: metaLines.join('\n'),
		body,
		hasFileMeta: true,
		metadata,
		bodyStartLine: i
	};
}

function parseType1HeadingRecords(body) {
	const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
	const headings = [];
	const stack = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const m = line.match(/^([\t ]*)(#{1,6})\s+(.+)$/);
		if (!m) {
			continue;
		}

		let tabCount = 0;
		let spaceCount = 0;
		for (const ch of m[1]) {
			if (ch === '\t') {
				tabCount++;
			} else if (ch === ' ') {
				spaceCount++;
			}
		}
		const indentLevel = tabCount + Math.floor(spaceCount / 4);
		const hashLen = m[2].length;
		const title = m[3].trim();
		const level = indentLevel + (hashLen - 1);

		while (stack.length > 0 && stack[stack.length - 1].level >= level) {
			stack.pop();
		}
		stack.push({ level, title });
		const path = stack.map(s => s.title).join('/');
		headings.push({ path, line: i, level, title });
	}

	return { lines, headings };
}

/**
 * CommonMark-style ATX headings: optional up-to-3 spaces, then #{1,6} and title.
 * Tabs before `#` are ignored (not headings) so README/Markdown is not confused with drip type-1 tab nesting.
 * Heading depth is **hash count only** (1 = `#`, 2 = `##`, …).
 */
function parseAtxMarkdownHeadingRecords(body) {
	const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
	const headings = [];
	const stack = [];
	let inFence = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed.startsWith('```')) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			continue;
		}

		const m = line.match(/^ {0,3}(#{1,6})\s+(.+)$/);
		if (!m) {
			continue;
		}

		const hashLen = m[1].length;
		let title = m[2].trim();
		title = title.replace(/\s+#+\s*$/, '').trim();
		if (!title) {
			continue;
		}

		const level = hashLen;
		while (stack.length > 0 && stack[stack.length - 1].level >= level) {
			stack.pop();
		}
		stack.push({ level, title });
		const path = stack.map(s => s.title).join('/');
		headings.push({ path, line: i, level, title });
	}

	return { lines, headings };
}

function parseHeadingRecordsForIngest(body, useDripType1Indent) {
	return useDripType1Indent ? parseType1HeadingRecords(body) : parseAtxMarkdownHeadingRecords(body);
}

function buildHeadingTreeFromBody(body, options = {}) {
	const { headings } =
		options.atxMarkdown === true ? parseAtxMarkdownHeadingRecords(body) : parseType1HeadingRecords(body);
	if (!headings.length) {
		return [];
	}

	const root = [];
	const stack = [];

	for (const h of headings) {
		const node = { path: h.path, title: h.title, children: [] };
		while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
			stack.pop();
		}
		if (!stack.length) {
			root.push(node);
		} else {
			stack[stack.length - 1].node.children.push(node);
		}
		stack.push({ node, level: h.level });
	}

	return root;
}

async function rankFilesInFolder(kbRoot, folderUri, noteInput, limit = 3) {
	const normalized = {
		title: noteInput.title || '',
		headings: noteInput.headings || '',
		content: noteInput.content || ''
	};

	const entries = await vscode.workspace.fs.readDirectory(folderUri);
	const candidates = [];

	for (const [name, type] of entries) {
		if (type !== vscode.FileType.File || !fileNameMatchesKbNote(name)) {
			continue;
		}

		const uri = vscode.Uri.joinPath(folderUri, name);
		const relativePath = toRelativePath(kbRoot, uri);

		if (await isPathIgnored(kbRoot, relativePath)) {
			continue;
		}

		let text = '';
		try {
			text = await readTextFile(uri);
		} catch {
			continue;
		}

		const { body } = splitFileHeaderAndBody(text);
		const headingPaths = extractHeadingPathsFromDripFile(text, { fileFsPath: uri.fsPath });
		const searchText = `${relativePath}\n${headingPaths.join('\n')}\n${text}`;
		const score = similarityScore(normalized, searchText);
		candidates.push({ uri: uri.toString(), label: name, relativePath, scoreValue: score, rawText: text, body });
	}

	candidates.sort((a, b) => b.scoreValue - a.scoreValue);
	const top = candidates.slice(0, limit);
	const files = [];

	for (const c of top) {
		const fileFsPath = c.uri ? vscode.Uri.parse(c.uri).fsPath : '';
		const headingPaths = extractHeadingPathsFromDripFile(c.rawText, { fileFsPath });
		const suggestedHeadingPath = bestHeadingPathForNote(normalized, headingPaths);
		const headingTree = buildHeadingTreeFromBody(splitFileHeaderAndBody(c.rawText).body, {
			atxMarkdown: isMarkdownKbPathForHeadings(fileFsPath)
		});
		files.push({
			type: 'file',
			uri: c.uri,
			label: c.label,
			score: c.scoreValue.toFixed(2),
			headingPaths,
			suggestedHeadingPath,
			headingTree
		});
	}

	return { files };
}

/**
 * Rank immediate subfolders and note files in one folder together (best next step may be either).
 * @param {import('vscode').Uri} kbRoot
 * @param {import('vscode').Uri} folderUri
 * @param {{ title?: string, headings?: string, content?: string }} noteInput
 * @param {number} limit Combined cap: best N items across subfolders and notes (single ranking, not N files + N folders).
 * @param {{ useEmbeddings?: boolean, embeddingModelId?: string }} [options]
 */
async function rankSubfoldersAndFilesInFolder(kbRoot, folderUri, noteInput, limit = 3, options = {}) {
	const normalized = {
		title: noteInput.title || '',
		headings: noteInput.headings || '',
		content: noteInput.content || ''
	};
	const queryBundle = `${normalized.title}\n${normalized.headings}\n${normalized.content}`;
	const useEmbeddings = options.useEmbeddings === true;

	const entries = await vscode.workspace.fs.readDirectory(folderUri);
	const mixed = [];

	for (const [name, type] of entries) {
		if (type === vscode.FileType.Directory) {
			if (name === '.img') {
				continue;
			}
			const uri = vscode.Uri.joinPath(folderUri, name);
			const relativePath = toRelativePath(kbRoot, uri);
			if (await isPathIgnored(kbRoot, relativePath)) {
				continue;
			}
			const candidateText = `${relativePath}\n${name}`;
			const scoreValue = similarityScore(normalized, candidateText);
			mixed.push({
				kind: 'folder',
				uri: uri.toString(),
				label: name,
				scoreValue,
				candidateText
			});
		}
	}

	for (const [name, type] of entries) {
		if (type !== vscode.FileType.File || !fileNameMatchesKbNote(name)) {
			continue;
		}

		const uri = vscode.Uri.joinPath(folderUri, name);
		const relativePath = toRelativePath(kbRoot, uri);

		if (await isPathIgnored(kbRoot, relativePath)) {
			continue;
		}

		let text = '';
		try {
			text = await readTextFile(uri);
		} catch {
			continue;
		}

		const headingPaths = extractHeadingPathsFromDripFile(text, { fileFsPath: uri.fsPath });
		const searchText = `${relativePath}\n${headingPaths.join('\n')}\n${text}`;
		const scoreValue = similarityScore(normalized, searchText);
		const suggestedHeadingPath = bestHeadingPathForNote(normalized, headingPaths);
		const headingTree = buildHeadingTreeFromBody(splitFileHeaderAndBody(text).body, {
			atxMarkdown: isMarkdownKbPathForHeadings(uri.fsPath)
		});
		mixed.push({
			kind: 'file',
			uri: uri.toString(),
			label: name,
			scoreValue,
			candidateText: searchText.slice(0, 6000),
			headingPaths,
			suggestedHeadingPath,
			headingTree
		});
	}

	if (useEmbeddings && mixed.length > 0) {
		const { rescorePoolWithEmbeddings, truncate } = require('../retrieval/embeddings');
		await rescorePoolWithEmbeddings(mixed, truncate(queryBundle), {
			modelId: options.embeddingModelId
		});
	}

	mixed.sort((a, b) => b.scoreValue - a.scoreValue);
	const top = mixed.slice(0, limit);

	return top.map(c => {
		if (c.kind === 'folder') {
			return {
				type: 'folder',
				uri: c.uri,
				label: c.label,
				score: c.scoreValue.toFixed(2)
			};
		}
		return {
			type: 'file',
			uri: c.uri,
			label: c.label,
			score: c.scoreValue.toFixed(2),
			headingPaths: c.headingPaths || [],
			suggestedHeadingPath: c.suggestedHeadingPath || '',
			headingTree: c.headingTree || []
		};
	});
}

function extractHeadingPathsFromType1Body(body) {
	const { headings } = parseType1HeadingRecords(body);
	const all = new Set();
	for (const h of headings) {
		for (const prefix of buildHeadingPathPrefixes(h.path)) {
			all.add(prefix);
		}
	}
	return Array.from(all).sort((a, b) => a.localeCompare(b));
}

function extractHeadingPathsFromAtxMarkdownBody(body) {
	const { headings } = parseAtxMarkdownHeadingRecords(body);
	const all = new Set();
	for (const h of headings) {
		for (const prefix of buildHeadingPathPrefixes(h.path)) {
			all.add(prefix);
		}
	}
	return Array.from(all).sort((a, b) => a.localeCompare(b));
}

function isMarkdownKbPathForHeadings(fileFsPath) {
	return Boolean(fileFsPath && path.basename(fileFsPath).toLowerCase().endsWith('.md'));
}

function findInsertLineBeforeBody(body, headingPath, useDripType1Indent = true) {
	const path = String(headingPath || '').trim();
	if (!path) {
		return null;
	}
	const { lines, headings } = parseHeadingRecordsForIngest(body, useDripType1Indent);
	const idx = headings.findIndex(h => h.path === path);
	if (idx < 0) {
		return null;
	}
	const h = headings[idx];
	const next = headings.slice(idx + 1).find(x => x.level <= h.level);
	return next ? next.line : lines.length;
}

/** Insert immediately after the heading line (first position inside that section). */
function findInsertLineAfterHeadingLine(body, headingPath, useDripType1Indent = true) {
	const path = String(headingPath || '').trim();
	if (!path) {
		return null;
	}
	const { lines, headings } = parseHeadingRecordsForIngest(body, useDripType1Indent);
	const idx = headings.findIndex(h => h.path === path);
	if (idx < 0) {
		return null;
	}
	const h = headings[idx];
	return Math.min(h.line + 1, lines.length);
}

function isDirectChildHeadingPath(parentPath, childPath) {
	const p = String(parentPath || '').trim();
	const c = String(childPath || '').trim();
	if (!c) {
		return false;
	}
	const prefix = p ? `${p}/` : '';
	if (p && !c.startsWith(prefix)) {
		return false;
	}
	const tail = p ? c.slice(prefix.length) : c;
	return tail.length > 0 && !tail.includes('/');
}

/**
 * Reorder direct child heading sections under parentPath. Rewrites body lines only.
 * @param {string} body
 * @param {string} parentPath empty string for top-level siblings
 * @param {string[]} orderedChildPaths full paths in desired order
 * @returns {string}
 */
function reorderSiblingHeadingSectionsInBody(body, parentPath, orderedChildPaths) {
	const paths = Array.from(orderedChildPaths || []).filter(Boolean);
	if (paths.length < 2) {
		return String(body || '');
	}
	const p = String(parentPath || '').trim();
	for (const c of paths) {
		if (!isDirectChildHeadingPath(p, c)) {
			throw new Error(`Heading "${c}" is not a direct child of "${p || '(top level)'}"`);
		}
	}
	const { lines, headings } = parseType1HeadingRecords(body);
	/** @type {{ path: string; start: number; end: number }[]} */
	const ranges = [];
	for (const path of paths) {
		const idx = headings.findIndex(h => h.path === path);
		if (idx < 0) {
			throw new Error(`Heading not found in file: ${path}`);
		}
		const h = headings[idx];
		const nextPeer = headings.slice(idx + 1).find(x => x.level <= h.level);
		const end = nextPeer ? nextPeer.line : lines.length;
		ranges.push({ path, start: h.line, end });
	}
	for (let i = 0; i < ranges.length; i++) {
		for (let j = i + 1; j < ranges.length; j++) {
			const a = ranges[i];
			const b = ranges[j];
			const overlap = Math.max(a.start, b.start) < Math.min(a.end, b.end);
			if (overlap) {
				throw new Error('Overlapping heading sections; cannot reorder.');
			}
		}
	}
	const minStart = Math.min(...ranges.map(r => r.start));
	const toRemove = new Set();
	for (const r of ranges) {
		for (let ln = r.start; ln < r.end; ln++) {
			toRemove.add(ln);
		}
	}
	const kept = lines.filter((_, i) => !toRemove.has(i));
	let insertIdx = 0;
	for (let i = 0; i < minStart; i++) {
		if (!toRemove.has(i)) {
			insertIdx++;
		}
	}
	const chunkMap = new Map(ranges.map(r => [r.path, lines.slice(r.start, r.end)]));
	const orderedParts = paths.map(path => chunkMap.get(path) || []).flat();
	return [...kept.slice(0, insertIdx), ...orderedParts, ...kept.slice(insertIdx)].join('\n');
}

function insertLinesAtLineIndex(body, insertBeforeZeroBased, chunkLines) {
	const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
	const before = lines.slice(0, insertBeforeZeroBased);
	const after = lines.slice(insertBeforeZeroBased);
	return [...before, ...chunkLines, ...after].join('\n');
}

/**
 * If the insert index sits on consecutive empty lines, move past them so the new block is
 * placed *after* that gap (uses the user’s existing blank line when present).
 * @param {string[]} allBodyLines
 * @param {number} insertBeforeZeroBased
 */
function advanceInsertPastBlankLines(allBodyLines, insertBeforeZeroBased) {
	const lines = allBodyLines;
	let i = insertBeforeZeroBased;
	if (i < 0) {
		i = 0;
	}
	if (i > lines.length) {
		i = lines.length;
	}
	while (i < lines.length && String(lines[i] || '').trim() === '') {
		i++;
	}
	return i;
}

/**
 * One empty line at the bottom of the ingested note (after trimming trailing blanks from the chunk only).
 */
function finishIngestChunk(chunkLines) {
	const c = chunkLines.slice();
	while (c.length > 0 && c[c.length - 1].trim() === '') {
		c.pop();
	}
	c.push('');
	return c;
}

/** Drop leading blank lines from composer content so we do not add a gap after the new heading. */
function stripLeadingEmptyLinesFromDraft(text) {
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	let i = 0;
	while (i < lines.length && !lines[i].trim()) {
		i++;
	}
	return lines.slice(i).join('\n');
}

function buildUnderHeadingChunkLines(body, headingPath, title, draftContentRaw, useDripType1Indent = true) {
	const { headings } = parseHeadingRecordsForIngest(body, useDripType1Indent);
	const h = headings.find(x => x.path === headingPath);
	const noteTitle = String(title || '').trim();
	const rawLines = stripLeadingEmptyLinesFromDraft(draftContentRaw)
		.replace(/\r\n/g, '\n')
		.split('\n');

	if (!useDripType1Indent) {
		if (!h) {
			return ['', `# ${noteTitle}`, ...rawLines.map(line => (line.trim() ? line : ''))];
		}
		const childLevel = Math.min(6, h.level + 1);
		return ['', `${'#'.repeat(childLevel)} ${noteTitle}`, ...rawLines.map(line => (line.trim() ? line : ''))];
	}

	if (!h) {
		return ['', `# ${noteTitle}`, ...rawLines.map(line => `\t${line}`)];
	}

	const tabForHeading = '\t'.repeat(h.level + 1);
	const tabForContent = '\t'.repeat(h.level + 2);
	return [
		'',
		`${tabForHeading}# ${noteTitle}`,
		...rawLines.map(line => (line.trim() ? tabForContent + line : ''))
	];
}

/**
 * New note as a sibling of refPath: same `#` line shape (tabs/spaces + hashes) as the reference heading.
 */
function buildSiblingChunkLinesAtRef(body, refPath, title, draftContentRaw, useDripType1Indent = true) {
	const { lines, headings } = parseHeadingRecordsForIngest(body, useDripType1Indent);
	const h = headings.find(x => x.path === refPath);
	const noteTitle = String(title || '').trim() || 'Untitled';
	const rawLines = stripLeadingEmptyLinesFromDraft(draftContentRaw)
		.replace(/\r\n/g, '\n')
		.split('\n');

	if (!useDripType1Indent) {
		if (!h || h.line < 0 || h.line >= lines.length) {
			return [`# ${noteTitle}`, ...rawLines.map(line => (line.trim() ? line : ''))];
		}
		const headingLine = `${'#'.repeat(h.level)} ${noteTitle}`;
		return [headingLine, ...rawLines.map(line => (line.trim() ? line : ''))];
	}

	if (!h || h.line < 0 || h.line >= lines.length) {
		return [`# ${noteTitle}`, ...rawLines.map(line => (line.trim() ? `\t${line}` : ''))];
	}

	const refLine = lines[h.line];
	const m = refLine.match(/^([\t ]*)(#{1,6})(\s+)(.+)$/);
	const linePrefix = m ? m[1] + m[2] + m[3] : '\t# ';
	const headingLine = linePrefix + noteTitle;
	const contentLead = m ? m[1] + '\t' : '\t';
	return [headingLine, ...rawLines.map(line => (line.trim() ? contentLead + line : ''))];
}

function extractHeadingPathsFromDripFile(noteText, options = {}) {
	const fileFsPath = options.fileFsPath || '';
	const { body, hasFileMeta } = splitFileHeaderAndBody(noteText);

	if (isMarkdownKbPathForHeadings(fileFsPath)) {
		const atx = extractHeadingPathsFromAtxMarkdownBody(body);
		if (atx.length) {
			return atx;
		}
	}

	const type1 = extractHeadingPathsFromType1Body(body);
	if (type1.length) {
		return type1;
	}

	const source = hasFileMeta ? body : noteText;
	const entries = parseDripNoteEntries(source);
	const all = new Set();

	for (const entry of entries) {
		const headingPath = extractHeadingPathFromEntry(entry);
		for (const prefix of buildHeadingPathPrefixes(headingPath)) {
			all.add(prefix);
		}
	}

	return Array.from(all);
}

function bestHeadingPathForNote(noteInput, headingPaths) {
	const candidates = Array.from(headingPaths || []).filter(Boolean);
	if (!candidates.length) {
		return '';
	}

	// Score each candidate heading path against the note text.
	const query = `${noteInput.title}\n${noteInput.headings}\n${noteInput.content || ''}`;
	const scored = candidates
		.map(p => ({
			path: p,
			score: similarityScore(
				{ title: query, headings: '', content: '' },
				p
			)
		}))
		.sort((a, b) => b.score - a.score);

	return scored[0].path || '';
}

function formatCreatedDate(date) {
	// User format: "April 02 2026" (no time).
	const months = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	];
	const monthName = months[date.getMonth()] || 'Unknown';
	const day = String(date.getDate()).padStart(2, '0');
	const year = date.getFullYear();
	return `${monthName} ${day} ${year}`;
}

function indentWholeContent(text) {
	const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
	return lines.map(line => `\t${line}`).join('\n');
}

function buildNewNoteFile(draft, options = {}) {
	const metaLabel = (options.metadataFilename || draft.metadataFilename || draft.title || 'Untitled').trim();
	const body = indentWholeContent(stripLeadingEmptyLinesFromDraft(draft.content || ''));
	const n = Number.isFinite(options.fileEntityNumber) ? Math.max(0, Math.floor(options.fileEntityNumber)) : 0;
	const fid = formatFileEntityId(n);
	const rootHeadingId = `${fid}:h0`;

	// File metadata + h0 live in the same pre-`---` block; `---` separates them from other headings.
	return (
		`filename: ${metaLabel}\n` +
		`fileid: ${fid}\n` +
		`headings: 0\n` +
		`\n` +
		`${rootHeadingId}\n` +
		`# . ${metaLabel}\n` +
		`${body}` +
		(body.trim() ? '' : '\n') +
		`---\n`
	);
}

function buildAppendedNote(existingContent, draft, headingPath, options = {}) {
	const path = String(headingPath || '').trim();
	const title = String(draft.title || '').trim();
	const draftLines = String(draft.content || '').replace(/\r\n/g, '\n');
	let { headerMeta, body, hasFileMeta } = splitFileHeaderAndBody(existingContent);

	/** `.d.txt` and similar use tab-nested type-1 sections; `.md` / README uses flush-left body lines. */
	const useDripType1Indent = options.useDripType1Indent !== false;

	const dropRef = String(options.ingestDropRefPath || '').trim();
	const dropPos = options.ingestPosition || '';

	let newBody;
	if (
		dropRef &&
		(dropPos === 'before' ||
			dropPos === 'afterSection' ||
			dropPos === 'childFirst' ||
			dropPos === 'sectionEnd')
	) {
		const { lines, headings } = parseHeadingRecordsForIngest(body, useDripType1Indent);
		const idx = headings.findIndex(x => x.path === dropRef);
		if (idx >= 0) {
			const hr = headings[idx];
			let insertBefore;
			let chunkLines;
			if (dropPos === 'childFirst') {
				/* First child slot: immediately under the heading line (before any existing subsection). */
				insertBefore = findInsertLineAfterHeadingLine(body, dropRef, useDripType1Indent);
				chunkLines = buildUnderHeadingChunkLines(body, dropRef, title, draftLines, useDripType1Indent);
			} else if (dropPos === 'sectionEnd') {
				/* Default when the anchor has no sub-headings: append at end of that section’s body. */
				insertBefore = findInsertLineBeforeBody(body, dropRef, useDripType1Indent);
				chunkLines = buildUnderHeadingChunkLines(body, dropRef, title, draftLines, useDripType1Indent);
			} else {
				insertBefore =
					dropPos === 'before'
						? hr.line
						: (() => {
								const next = headings.slice(idx + 1).find(x => x.level <= hr.level);
								return next ? next.line : lines.length;
							})();
				chunkLines = buildSiblingChunkLinesAtRef(body, dropRef, title, draftLines, useDripType1Indent);
			}
			if (insertBefore != null) {
				const at = advanceInsertPastBlankLines(lines, insertBefore);
				const finished = finishIngestChunk(chunkLines);
				newBody = insertLinesAtLineIndex(body, at, finished);
			}
		}
	}

	if (newBody == null && path) {
		const { lines } = parseHeadingRecordsForIngest(body, useDripType1Indent);
		let insertBefore = findInsertLineBeforeBody(body, path, useDripType1Indent);
		if (insertBefore != null) {
			insertBefore = advanceInsertPastBlankLines(lines, insertBefore);
			const chunkLines = finishIngestChunk(
				buildUnderHeadingChunkLines(body, path, title, draftLines, useDripType1Indent)
			);
			newBody = insertLinesAtLineIndex(body, insertBefore, chunkLines);
		}
	}

	if (newBody == null) {
		const trimmedDraft = stripLeadingEmptyLinesFromDraft(draftLines);
		const bodyStr = String(body || '').replace(/\r\n/g, '\n').trimEnd();
		const lines = bodyStr === '' ? [] : bodyStr.split('\n');
		let insertBefore = advanceInsertPastBlankLines(lines, lines.length);
		const chunkLines = finishIngestChunk([
			`# ${title}`,
			...trimmedDraft.split('\n').map(line => (useDripType1Indent ? `\t${line}` : line))
		]);
		newBody = insertLinesAtLineIndex(bodyStr, insertBefore, chunkLines);
	}

	const normalizedBody = newBody.trimEnd();
	// Requirement: only new note files should get the file-level `filename:` / `created:` header.
	// When appending to an existing file, preserve its current format and never inject a new header.
	if (hasFileMeta) {
		return `${headerMeta}\n---\n${normalizedBody}\n`;
	}
	return `${normalizedBody}\n`;
}

/**
 * Walk the entire knowledge base (folders + note files), score every folder and every
 * (file × heading path) pair against the draft, then return the single global top N.
 * Not layer-by-layer: one pool, one sort, then truncate.
 *
 * @param {import('vscode').Uri} kbRoot
 * @param {{ title?: string, headings?: string, content?: string }} noteInput
 * @param {number} limit
 * @param {{ useEmbeddings?: boolean, embeddingModelId?: string }} [options] embeddingModelId passed to Transformers.js (e.g. Xenova/all-MiniLM-L6-v2)
 * @returns {Promise<Array<{ targetType: 'folder' | 'file', scoreValue: number } & Record<string, unknown>>>}
 */
async function rankDeepStorageCandidates(kbRoot, noteInput, limit = 3, options = {}) {
	const normalized = {
		title: noteInput.title || '',
		headings: noteInput.headings || '',
		content: noteInput.content || ''
	};
	const queryBundle = `${normalized.title}\n${normalized.headings}\n${normalized.content}`;
	const useEmbeddings = options.useEmbeddings === true;

	/** @type {Array<{ targetType: 'folder' | 'file', scoreValue: number, candidateText?: string } & Record<string, unknown>>} */
	const pool = [];

	async function walk(folderUri) {
		const rel = toRelativePath(kbRoot, folderUri);
		if (rel && (await isPathIgnored(kbRoot, rel))) {
			return;
		}

		const folderLabel = path.basename(folderUri.fsPath);
		const folderDisplay = !rel || rel === '.' ? '(root)' : rel.replace(/\\/g, '/');
		const folderCand = `${rel || '(root)'}\n${folderLabel}`;
		pool.push({
			targetType: 'folder',
			scoreValue: similarityScore(normalized, folderCand),
			candidateText: folderCand,
			folderUri: folderUri.toString(),
			label: folderLabel,
			displayPath: folderDisplay
		});

		let entries;
		try {
			entries = await vscode.workspace.fs.readDirectory(folderUri);
		} catch {
			return;
		}

		for (const [name, type] of entries) {
			if (type === vscode.FileType.Directory) {
				if (name === '.img') {
					continue;
				}
				const sub = vscode.Uri.joinPath(folderUri, name);
				const subRel = toRelativePath(kbRoot, sub);
				if (await isPathIgnored(kbRoot, subRel)) {
					continue;
				}
				await walk(sub);
			} else if (type === vscode.FileType.File && fileNameMatchesKbNote(name)) {
				const fileUri = vscode.Uri.joinPath(folderUri, name);
				const fileRel = toRelativePath(kbRoot, fileUri);
				if (await isPathIgnored(kbRoot, fileRel)) {
					continue;
				}

				let text;
				try {
					text = await readTextFile(fileUri);
				} catch {
					continue;
				}

				const headingPaths = extractHeadingPathsFromDripFile(text, { fileFsPath: fileUri.fsPath });
				const { body } = splitFileHeaderAndBody(text);
				const headingTree = buildHeadingTreeFromBody(body, {
					atxMarkdown: isMarkdownKbPathForHeadings(fileUri.fsPath)
				});
				const parentFolderUri = folderUri.toString();
				const relSlash = fileRel.replace(/\\/g, '/');

				if (headingPaths.length) {
					for (const hp of headingPaths) {
						const cand = `${relSlash}\n${name}\n${hp}`;
						pool.push({
							targetType: 'file',
							scoreValue: similarityScore(normalized, cand),
							candidateText: cand,
							fileUri: fileUri.toString(),
							label: name,
							headingPath: hp,
							headingPaths,
							headingTree,
							displayPath: relSlash,
							parentFolderUri
						});
					}
				} else {
					const searchText = `${fileRel}\n${text}`;
					pool.push({
						targetType: 'file',
						scoreValue: similarityScore(normalized, searchText),
						candidateText: searchText.slice(0, 6000),
						fileUri: fileUri.toString(),
						label: name,
						headingPath: '',
						headingPaths: [],
						headingTree,
						displayPath: relSlash,
						parentFolderUri
					});
				}
			}
		}
	}

	await walk(kbRoot);

	if (useEmbeddings && pool.length > 0) {
		const { rescorePoolWithEmbeddings, truncate } = require('../retrieval/embeddings');
		await rescorePoolWithEmbeddings(pool, truncate(queryBundle), {
			modelId: options.embeddingModelId || undefined
		});
	}

	pool.sort((a, b) => b.scoreValue - a.scoreValue);
	return pool.slice(0, limit);
}

module.exports = {
	buildAppendedNote,
	buildHeadingTreeFromBody,
	buildNewNoteFile,
	buildNoteFileName,
	chooseTargetFolder,
	extractHeadingPathsFromDripFile,
	bestHeadingPathForNote,
	forEachKnowledgeBaseNote,
	forEachKnowledgeBaseNotePath,
	getKnowledgeBaseTreeChildren,
	isPathIgnored,
	parseDripNoteEntries,
	rankDeepStorageCandidates,
	rankFolderCandidates,
	rankFilesInFolder,
	rankSubfoldersAndFilesInFolder,
	readTextFile,
	reorderSiblingHeadingSectionsInBody,
	scanKnowledgeBaseNotes,
	similarityScore,
	splitFileHeaderAndBody,
	parseType1HeadingRecords,
	writeTextFile
};
