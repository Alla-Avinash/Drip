'use strict';

const path = require('path');
const { collectHeadingSequenceValidated, parseHeadingForValidation } = require('../document/parse/dripnoteCanvasParse');
const { getMetadataSettings } = require('../document/model/dripnoteMetadataTemplates');
const {
	classifyPersistentHeadingTitle
} = require('../document/model/dripnotePersistentHeading');
const { stripKbNoteExtension } = require('../document/model/noteFileTypes');
const { computeHeadingHash } = require('./dripIndexParse');
const { parseFileEntityIdNumber, formatFileEntityId } = require('./dripnoteEntityIds');
const {
	initEmptyDripIndexFile,
	readFileHeadingAllocator,
	syncFileHeadingAllocatorFromUsedIds,
	recomputeHeadingAllocatorState,
	resolveSequentialFileEntityForKbNote
} = require('./dripIndexDb');

/** @type {Map<string, { next: number, free: number[] }>} */
const headingAllocCache = new Map();

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {number} fileNum
 * @returns {string}
 */
function headingAllocCacheKey(kbRoot, fileNum) {
	return `${kbRoot.fsPath}|${Math.max(0, Math.floor(Number(fileNum) || 0))}`;
}

function clearHeadingAllocCache() {
	headingAllocCache.clear();
}

/** `@f23:h0` or `@f23:h1 #abc12345` */
const HEADING_IDENTITY_LINE_RE = /^\s*@+\s*f(\d+)\s*:\s*h(\d+)\b(?:\s+#\s*([A-Za-z0-9]{8}))?\s*$/i;

/**
 * @param {string} line
 * @returns {boolean}
 */
function isHeadingIdentityLine(line) {
	return HEADING_IDENTITY_LINE_RE.test(String(line || ''));
}

/**
 * @param {string} line
 * @returns {{ fileNum: number, headingNum: number, hash: string } | null}
 */
function parseHeadingIdentityLine(line) {
	const m = HEADING_IDENTITY_LINE_RE.exec(String(line || ''));
	if (!m) return null;
	const fileNum = parseInt(m[1], 10);
	const headingNum = parseInt(m[2], 10);
	if (!Number.isFinite(fileNum) || !Number.isFinite(headingNum)) return null;
	return { fileNum, headingNum, hash: String(m[3] || '').trim() };
}

/**
 * @param {string} fileEntityId e.g. `@f23`
 * @param {number} headingNum
 * @param {string} [hash]
 * @returns {string}
 */
function formatHeadingIdentityLine(fileEntityId, headingNum, hash) {
	const fid = String(fileEntityId || '').trim();
	const n = Math.max(0, Math.floor(Number(headingNum) || 0));
	const base = `${fid}:h${n}`;
	const h = String(hash || '').trim();
	return h ? `${base} #${h}` : base;
}

/**
 * Metadata that affects heading hash — not body prose under the heading.
 * @param {string} line
 * @returns {boolean}
 */
function isStructuredHeadingMetadataLine(line) {
	const s = String(line || '');
	const t = s.trim();
	if (!t || t === '---') return false;
	if (isHeadingIdentityLine(s)) return false;
	if (/^\s*\/\//.test(s)) return false;
	if (/^\s*\.(\w[\w-]*)\b/i.test(t)) return true;
	if (/^\s*(tags|pre-req|ref)\s*:\s*\[/i.test(s)) return true;
	if (/^\s*\[[^\]]*\]\s*$/.test(t)) return true;
	if (/^\s*[a-z][a-z0-9_-]*\s*:\s*.+$/i.test(t)) return true;
	return false;
}

/**
 * @param {string[]} metaLines
 * @returns {string[]}
 */
function metaLinesForHash(metaLines) {
	return (metaLines || []).filter(isStructuredHeadingMetadataLine);
}

/**
 * @param {string[]} lines
 * @returns {number}
 */
function findSeparatorLineIndex(lines) {
	for (let i = 0; i < lines.length; i++) {
		if (String(lines[i] || '').trim() === '---') return i;
	}
	return -1;
}

/**
 * @param {string[]} lines
 * @returns {{ fileNum: number, fileEntityId: string } | null}
 */
function parseFileEntityFromLines(lines) {
	for (const line of lines || []) {
		const m = String(line || '').match(/^\s*fileid\s*:\s*(.+)\s*$/i);
		if (!m) continue;
		const fileNum = parseFileEntityIdNumber(String(m[1] || '').trim());
		if (fileNum == null) continue;
		return { fileNum, fileEntityId: formatFileEntityId(fileNum) };
	}
	return null;
}

/**
 * @param {string[]} topLines
 * @param {number} count non-h0 heading count
 * @returns {string[]}
 */
function writeHeadingsCountIntoTopLines(topLines, count) {
	const n = Math.max(0, Math.floor(Number(count) || 0));
	let saw = false;
	const out = [];
	for (const line of topLines || []) {
		const m = String(line || '').match(/^(\s*)headings(\s*:\s*)(\d+)(.*)$/i);
		if (!m) {
			out.push(line);
			continue;
		}
		saw = true;
		out.push(`${m[1]}headings${m[2]}${n}${m[4] || ''}`);
	}
	if (!saw) {
		let insertAt = out.length;
		for (let i = 0; i < out.length; i++) {
			if (/^\s*fileid\s*:/i.test(String(out[i] || ''))) {
				insertAt = i + 1;
				break;
			}
		}
		out.splice(insertAt, 0, `headings: ${n}`);
	}
	return out;
}

function writeFileIdIntoTopLines(topLines, fileEntityId) {
	const fid = String(fileEntityId || '').trim();
	if (!fid) return topLines || [];
	let saw = false;
	const out = [];
	for (const line of topLines || []) {
		if (/^\s*fileid\s*:/i.test(String(line || ''))) {
			saw = true;
			out.push(`fileid: ${fid}`);
			continue;
		}
		out.push(line);
	}
	if (!saw) {
		let insertAt = out.length;
		for (let i = 0; i < out.length; i++) {
			if (/^\s*filename\s*:/i.test(String(out[i] || ''))) {
				insertAt = i + 1;
				break;
			}
		}
		out.splice(insertAt, 0, `fileid: ${fid}`);
	}
	return out;
}

/**
 * @param {string} line
 */
function isFileKeyLine(line) {
	return /^\s*(filename|fileid|headings|created|random)\s*:/i.test(String(line || ''));
}

/**
 * @param {string[]} lines
 * @param {number} headingLine
 */
function headingBlockStart(lines, headingLine) {
	const idLine = findOwnedIdentityLineIndex(lines, headingLine);
	if (idLine >= 0 && idLine < headingLine) return idLine;
	return headingLine;
}

/**
 * @param {string[]} lines
 * @param {{ noteUri?: import('vscode').Uri, filenameStem?: string }} [options]
 */
function resolveFilenameStem(lines, options) {
	if (options && String(options.filenameStem || '').trim()) {
		return String(options.filenameStem).trim();
	}
	if (options && options.noteUri && options.noteUri.fsPath) {
		return stripKbNoteExtension(path.basename(options.noteUri.fsPath));
	}
	for (const line of lines || []) {
		const m = String(line || '').match(/^\s*filename\s*:\s*(.*)$/i);
		if (m && String(m[1] || '').trim()) return String(m[1]).trim();
	}
	return 'Untitled';
}

/**
 * Canonical file-level block used by live reconcile and reconcile-update:
 *   filename / fileid / headings
 *   blank
 *   @fN:h0
 *   # . h0 title
 *   optional about/body text under h0 (kept as-is, including blank lines)
 *   ---
 *
 * Extra headings above `---` are moved below it. Prose under h0 stays above `---`.
 *
 * @param {string[]} lines
 * @param {{ fileEntityId: string, filename: string }} opts
 * @returns {string[]}
 */
function rebuildCanonicalFileLevelBlock(lines, opts) {
	const src = [...(lines || [])];
	const filename = String(opts.filename || 'Untitled').trim() || 'Untitled';
	const fileEntityId = String(opts.fileEntityId || '').trim() || '@f0';
	const sepIdx = findSeparatorLineIndex(src);
	const top = sepIdx >= 0 ? src.slice(0, sepIdx) : [];
	let body;
	if (sepIdx >= 0) {
		body = src.slice(sepIdx + 1);
	} else {
		let start = 0;
		while (start < src.length) {
			const raw = String(src[start] || '');
			if (!raw.trim() || isFileKeyLine(raw)) {
				start += 1;
				continue;
			}
			break;
		}
		body = src.slice(start);
	}

	/** @type {number[]} */
	const headingRows = [];
	for (let i = 0; i < top.length; i++) {
		if (parseHeadingForValidation(top[i])) headingRows.push(i);
	}

	const h0HeadingLine = headingRows.length ? headingRows[0] : -1;
	let h0Title = `. ${filename}`;
	/** @type {string[]} */
	let h0Meta = [];
	if (h0HeadingLine >= 0) {
		const parsed = parseHeadingForValidation(top[h0HeadingLine]);
		const title = parsed && String(parsed.title || '').trim();
		if (title) h0Title = title;
		const nextHeading = headingRows.length > 1 ? headingRows[1] : top.length;
		const nextStart = headingRows.length > 1 ? headingBlockStart(top, headingRows[1]) : top.length;
		const metaEnd = Math.min(nextHeading, nextStart);
		h0Meta = top.slice(h0HeadingLine + 1, metaEnd).filter(line => !isFileKeyLine(line));
	}

	/** @type {string[]} */
	const moved = [];
	for (let k = 1; k < headingRows.length; k++) {
		const start = headingBlockStart(top, headingRows[k]);
		const end =
			k + 1 < headingRows.length ? headingBlockStart(top, headingRows[k + 1]) : top.length;
		const block = top.slice(start, end);
		if (!block.length) continue;
		if (moved.length) moved.push('');
		moved.push(...block);
	}
	if (moved.length) {
		const trimmedBody = [...body];
		while (trimmedBody.length && !String(trimmedBody[0] || '').trim()) trimmedBody.shift();
		body = trimmedBody.length ? [...moved, '', ...trimmedBody] : moved;
	}

	// Do not strip trailing blank lines at EOF — leave the user's empty space as-is.

	return [
		`filename: ${filename}`,
		`fileid: ${fileEntityId}`,
		'headings: 0',
		'',
		`${fileEntityId}:h0`,
		`# ${h0Title}`,
		...h0Meta,
		'---',
		...body
	];
}

/**
 * @param {string} fullText
 * @returns {{ tabDepth: number, title: string, headingNum: number | null }[]}
 */
function extractHeadingNumsInOrder(fullText) {
	const lines = String(fullText || '').replace(/\r\n/g, '\n').split('\n');
	const { nodes } = collectHeadingSequenceValidated(lines, 0);
	return nodes.map(node => {
		const found = findHeadingIdentityForNode(lines, node);
		return {
			tabDepth: node.tabDepth,
			title: node.title,
			headingNum: found ? found.parsed.headingNum : null
		};
	});
}

/**
 * @param {string[]} lines
 * @returns {string[]}
 */
function stripManagedIdentityInputLines(lines) {
	return (lines || []).filter(line => {
		const s = String(line || '');
		if (isHeadingIdentityLine(s)) return false;
		if (/^\s*fileid\s*:/i.test(s)) return false;
		return true;
	});
}

/**
 * @param {{ lineIndex: number, tabDepth: number }} node
 * @param {number} sepIdx
 * @param {number} firstRootBeforeSep
 */
function isH0HeadingNode(node, sepIdx, firstRootBeforeSep) {
	return node.lineIndex === firstRootBeforeSep && node.tabDepth === 0;
}

/**
 * First heading line that owns this `@fN:hM` line.
 * Canonical: `@` directly above a heading. Legacy: `@` directly below a heading when only prose follows.
 * @param {string[]} lines
 * @param {number} identityLineIndex
 * @returns {number}
 */
function identityLineOwnerHeadingLine(lines, identityLineIndex) {
	if (identityLineIndex < 0 || identityLineIndex >= lines.length) return -1;
	if (!isHeadingIdentitySlotLine(lines[identityLineIndex])) return -1;

	for (let j = identityLineIndex + 1; j < lines.length; j++) {
		const line = String(lines[j] || '');
		if (!line.trim()) continue;
		if (isHeadingIdentitySlotLine(line)) return -1;
		if (parseHeadingForValidation(line) || isHeadingStubLine(line)) return j;
	}

	// Legacy below-heading: `@` immediately under a heading when no heading exists below.
	const above = findHeadingLineAboveIndex(lines, identityLineIndex);
	if (above < 0) return -1;
	for (let k = above + 1; k < identityLineIndex; k++) {
		if (String(lines[k] || '').trim()) return -1;
	}
	return above;
}

/**
 * Canonical identity line for a heading (closest owned `@` above, else legacy below).
 * @param {string[]} lines
 * @param {number} headingLineIndex
 * @returns {number}
 */
function findOwnedIdentityLineIndex(lines, headingLineIndex) {
	for (let j = headingLineIndex - 1; j >= 0; j--) {
		const line = String(lines[j] || '');
		if (!line.trim()) continue;
		if (isHeadingIdentitySlotLine(line)) {
			if (identityLineOwnerHeadingLine(lines, j) === headingLineIndex) {
				return j;
			}
			continue;
		}
		if (parseHeadingForValidation(line) || isHeadingStubLine(line)) {
			break;
		}
	}
	const below = headingLineIndex + 1;
	if (below < lines.length && isHeadingIdentitySlotLine(lines[below])) {
		if (identityLineOwnerHeadingLine(lines, below) === headingLineIndex) {
			return below;
		}
	}
	return -1;
}

/**
 * @param {string[]} lines
 * @param {number} headingLineIndex
 * @returns {{ lineIndex: number, parsed: { fileNum: number, headingNum: number, hash: string } } | null}
 */
function findIdentityLineAbove(lines, headingLineIndex) {
	const idLine = findOwnedIdentityLineIndex(lines, headingLineIndex);
	if (idLine < 0 || idLine >= headingLineIndex) {
		return null;
	}
	const parsed = parseHeadingIdentityLine(lines[idLine]);
	if (!parsed) return null;
	return { lineIndex: idLine, parsed };
}

/**
 * @param {string[]} lines
 * @param {number} headingLineIndex
 */
function findIdentityLineBelow(lines, headingLineIndex) {
	const below = headingLineIndex + 1;
	const idLine = findOwnedIdentityLineIndex(lines, headingLineIndex);
	if (idLine !== below) return null;
	const parsed = parseHeadingIdentityLine(lines[below]);
	if (!parsed) return null;
	return { lineIndex: below, parsed };
}

/**
 * @param {string[]} lines
 * @param {{ lineIndex: number, tabDepth: number, metaLines?: string[] }} node
 */
function findHeadingIdentityForNode(lines, node) {
	const idLine = findOwnedIdentityLineIndex(lines, node.lineIndex);
	if (idLine < 0) return null;
	const parsed = parseHeadingIdentityLine(lines[idLine]);
	if (!parsed) return null;
	return { lineIndex: idLine, parsed };
}

/**
 * `@f…` line above a heading, including while the user is still typing the id.
 * @param {string} line
 * @returns {boolean}
 */
function isHeadingIdentitySlotLine(line) {
	return /^\s*@+/.test(String(line || ''));
}

/**
 * @param {string[]} lines
 * @param {number} headingLineIndex
 * @returns {number}
 */
function findIdentitySlotAbove(lines, headingLineIndex) {
	const idLine = findOwnedIdentityLineIndex(lines, headingLineIndex);
	return idLine >= 0 && idLine < headingLineIndex ? idLine : -1;
}

/**
 * Heading already has an identity line (or user is editing one) — do not auto-assign.
 * @param {string[]} lines
 * @param {{ lineIndex: number }} node
 * @returns {boolean}
 */
function headingHasIdentitySlot(lines, node) {
	return findOwnedIdentityLineIndex(lines, node.lineIndex) >= 0;
}

/**
 * Leading whitespace before `#` on a heading line — identity uses the same indent.
 * @param {string[]} lines
 * @param {number} headingLineIndex
 * @returns {string}
 */
function headingLineIndent(lines, headingLineIndex) {
	const m = String(lines[headingLineIndex] || '').match(/^(\s*)#{1,6}\s+/);
	return m ? m[1] : '';
}

/**
 * `#` line with no real title (`# `, `#   \t`, tab-indented variants).
 * Uses the same parser as heading collection so detection stays consistent.
 * @param {string} line
 * @returns {boolean}
 */
function isEmptyHeadingTitleLine(line) {
	const ph = parseHeadingForValidation(line);
	if (!ph) return false;
	return !/\S/.test(String(ph.title || ''));
}

/**
 * Empty title or bare `#` / `##` with no title text (user deleted past the trailing space).
 * @param {string} line
 * @returns {boolean}
 */
function isHeadingStubLine(line) {
	if (isEmptyHeadingTitleLine(line)) return true;
	return /^(\s*)(#{1,6})\s*$/.test(String(line || ''));
}

/**
 * True when a titled `#` line has no identity line directly above it.
 * @param {string} text
 * @returns {boolean}
 */
function hasHeadingNeedingIdAllocation(text) {
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	const sepIdx = findSeparatorLineIndex(lines);
	const { nodes } = collectHeadingSequenceValidated(lines, 0);
	const settings = getMetadataSettings();
	let firstRootBeforeSep = -1;
	for (const node of nodes) {
		if (node.tabDepth !== 0) continue;
		if (sepIdx >= 0 && node.lineIndex >= sepIdx) continue;
		firstRootBeforeSep = node.lineIndex;
		break;
	}
	for (const node of nodes) {
		if (!/\S/.test(String(node.title || '').trim())) continue;
		const isH0 = isH0HeadingNode(node, sepIdx, firstRootBeforeSep);
		if (!isH0 && !classifyPersistentHeadingTitle(node.title, settings).persistent) continue;
		if (headingHasIdentitySlot(lines, node)) continue;
		return true;
	}
	return false;
}

/**
 * True when a heading that is no longer persistent (dot removed) still carries
 * an `@fN:hM` identity line — reconcile must delete it.
 * @param {string} text
 * @returns {boolean}
 */
function hasIdentityOnNonPersistentHeading(text) {
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	const sepIdx = findSeparatorLineIndex(lines);
	const { nodes } = collectHeadingSequenceValidated(lines, 0);
	const settings = getMetadataSettings();
	let firstRootBeforeSep = -1;
	for (const node of nodes) {
		if (node.tabDepth !== 0) continue;
		if (sepIdx >= 0 && node.lineIndex >= sepIdx) continue;
		firstRootBeforeSep = node.lineIndex;
		break;
	}
	for (const node of nodes) {
		if (!/\S/.test(String(node.title || '').trim())) continue;
		if (isH0HeadingNode(node, sepIdx, firstRootBeforeSep)) continue;
		if (classifyPersistentHeadingTitle(node.title, settings).persistent) continue;
		if (findHeadingIdentityForNode(lines, node)) return true;
	}
	return false;
}

/**
 * Empty `#` / `# ` heading still has a managed identity line nearby.
 * @param {string} text
 * @returns {boolean}
 */
function hasEmptyHeadingWithIdentity(text) {
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (!isHeadingStubLine(lines[i])) continue;
		if (findOwnedIdentityLineIndex(lines, i) >= 0) return true;
	}
	return false;
}

function countNonH0HeadingsInText(text) {
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	const sepIdx = findSeparatorLineIndex(lines);
	const { nodes } = collectHeadingSequenceValidated(lines, 0);
	const settings = getMetadataSettings();
	const titled = nodes.filter(node => /\S/.test(String(node.title || '').trim()));
	let firstRootBeforeSep = -1;
	for (const node of titled) {
		if (node.tabDepth !== 0) continue;
		if (sepIdx >= 0 && node.lineIndex >= sepIdx) continue;
		firstRootBeforeSep = node.lineIndex;
		break;
	}
	let nonH0Count = 0;
	for (const node of titled) {
		if (isH0HeadingNode(node, sepIdx, firstRootBeforeSep)) continue;
		if (!classifyPersistentHeadingTitle(node.title, settings).persistent) continue;
		nonH0Count += 1;
	}
	return nonH0Count;
}

/**
 * @param {string[]} lines
 * @returns {number}
 */
function parseHeadingsCountFromHeaderLines(lines) {
	for (const line of lines || []) {
		const trimmed = String(line || '').trim();
		if (trimmed === '---') break;
		const m = /^\s*headings\s*:\s*(\d+)/i.exec(String(line || ''));
		if (m) {
			const n = parseInt(m[1], 10);
			return Number.isFinite(n) ? Math.max(0, n) : 0;
		}
	}
	return 0;
}

function hasHeadingsCountMismatch(text) {
	const normalized = String(text || '').replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');
	const sepIdx = findSeparatorLineIndex(lines);
	const topEnd = sepIdx >= 0 ? sepIdx : lines.length;
	const headerCount = parseHeadingsCountFromHeaderLines(lines.slice(0, topEnd));
	const actualCount = countNonH0HeadingsInText(normalized);
	return headerCount !== actualCount;
}

function hasDuplicateHeadingIdsInFile(text) {
	const normalized = String(text || '').replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');
	if (hasRawDuplicateIdentityNums(lines)) {
		return true;
	}
	const sepIdx = findSeparatorLineIndex(lines);
	const { nodes } = collectHeadingSequenceValidated(lines, 0);
	let firstRootBeforeSep = -1;
	for (const node of nodes) {
		if (node.tabDepth !== 0) continue;
		if (sepIdx >= 0 && node.lineIndex >= sepIdx) continue;
		firstRootBeforeSep = node.lineIndex;
		break;
	}
	/** @type {Set<number>} */
	const seen = new Set();
	for (const node of nodes) {
		if (!/\S/.test(String(node.title || '').trim())) continue;
		if (isH0HeadingNode(node, sepIdx, firstRootBeforeSep)) continue;
		const attached = findHeadingIdentityForNode(lines, node);
		if (!attached || attached.parsed.headingNum <= 0) continue;
		const num = attached.parsed.headingNum;
		if (seen.has(num)) return true;
		seen.add(num);
	}
	return false;
}

/**
 * True when two or more parsed `@fN:hM` lines in the file share the same hM (same file entity).
 * @param {string[]} lines
 * @returns {boolean}
 */
function hasRawDuplicateIdentityNums(lines) {
	const file = parseFileEntityFromLines(lines);
	const fileNum = file?.fileNum ?? null;
	/** @type {Set<number>} */
	const seen = new Set();
	for (let i = 0; i < lines.length; i++) {
		const parsed = parseHeadingIdentityLine(lines[i]);
		if (!parsed || parsed.headingNum <= 0) continue;
		if (fileNum != null && parsed.fileNum !== fileNum) continue;
		if (seen.has(parsed.headingNum)) return true;
		seen.add(parsed.headingNum);
	}
	return false;
}

/**
 * Renumber duplicate `@fN:hM` lines in file order (first occurrence keeps id).
 * @param {string[]} lines
 * @param {{ fileNum: number, fileEntityId: string }} file
 * @param {Set<number>} usedNonH0
 * @param {() => number} allocateNonH0Id
 * @returns {boolean}
 */
function forceResolveRawDuplicateIdentityLines(lines, file, usedNonH0, allocateNonH0Id) {
	/** @type {Set<number>} */
	const seenNums = new Set();
	let changed = false;
	for (let i = 0; i < lines.length; i++) {
		const parsed = parseHeadingIdentityLine(lines[i]);
		if (!parsed || parsed.headingNum <= 0) continue;
		if (parsed.fileNum !== file.fileNum) continue;
		if (!seenNums.has(parsed.headingNum)) {
			seenNums.add(parsed.headingNum);
			usedNonH0.add(parsed.headingNum);
			continue;
		}
		const newNum = allocateNonH0Id();
		usedNonH0.add(newNum);
		const indent = String(lines[i] || '').match(/^(\s*)/)?.[1] || '';
		lines[i] = `${indent}${formatHeadingIdentityLine(file.fileEntityId, newNum, parsed.hash)}`;
		changed = true;
	}
	return changed;
}

/**
 * @param {string[]} lines
 * @param {{ lineIndex: number, title?: string }[]} nodes
 * @param {number} sepIdx
 * @param {number} firstRootBeforeSep
 * @returns {number[]}
 */
function collectUsedNonH0IdsFromNodes(lines, nodes, sepIdx, firstRootBeforeSep) {
	/** @type {Set<number>} */
	const used = new Set();
	for (const node of nodes) {
		if (!/\S/.test(String(node.title || '').trim())) continue;
		if (isH0HeadingNode(node, sepIdx, firstRootBeforeSep)) continue;
		const attached = findHeadingIdentityForNode(lines, node);
		if (attached && attached.parsed.headingNum > 0) {
			used.add(attached.parsed.headingNum);
		}
	}
	return [...used].sort((a, b) => a - b);
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function needsHeadingIdentityReconcile(text) {
	return (
		hasHeadingNeedingIdAllocation(text) ||
		hasIdentityOnNonPersistentHeading(text) ||
		hasEmptyHeadingWithIdentity(text) ||
		hasDuplicateHeadingIdsInFile(text) ||
		hasHeadingsCountMismatch(text)
	);
}

/**
 * Remove identity lines attached to empty heading stubs.
 * @param {string[]} lines
 * @returns {boolean}
 */
function removeOrphanIdentityNearEmptyHeadings(lines) {
	let changed = false;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!isHeadingStubLine(lines[i])) continue;
		for (let j = i - 1; j >= 0; j--) {
			const line = String(lines[j] || '');
			if (!line.trim()) continue;
			if (isHeadingIdentityLine(line)) {
				lines.splice(j, 1);
				changed = true;
			}
			break;
		}
		if (i + 1 < lines.length && isHeadingIdentityLine(lines[i + 1])) {
			lines.splice(i + 1, 1);
			changed = true;
		}
	}
	return changed;
}

/**
 * @param {string[]} lines
 * @param {number} sepIdx
 * @param {number} firstRootBeforeSep
 * @param {{ title: string }[]} nodes
 * @returns {string}
 */
function finalizeReconciledText(lines, sepIdx, firstRootBeforeSep, nodes, file) {
	const sepIdxFinal = findSeparatorLineIndex(lines);
	const topEndFinal = sepIdxFinal >= 0 ? sepIdxFinal : lines.length;
	const topLines = lines.slice(0, topEndFinal);
	const bodyLines = sepIdxFinal >= 0 ? lines.slice(sepIdxFinal) : [];
	const settings = getMetadataSettings();
	let nonH0Count = 0;
	for (const node of nodes) {
		if (isH0HeadingNode(node, sepIdx, firstRootBeforeSep)) continue;
		if (!classifyPersistentHeadingTitle(node.title, settings).persistent) continue;
		nonH0Count += 1;
	}
	let nextTop = writeHeadingsCountIntoTopLines(topLines, nonH0Count);
	nextTop = writeFileIdIntoTopLines(nextTop, file.fileEntityId);
	return { nextText: [...nextTop, ...bodyLines].join('\n'), nonH0Count, topChanged: nextTop.join('\n') !== topLines.join('\n') };
}

/**
 * Signature of heading titles + metadata blocks (for hash refresh scheduling).
 * @param {string} text
 * @returns {string}
 */
function headingMetadataSignature(text) {
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	const sepIdx = findSeparatorLineIndex(lines);
	const { nodes } = collectHeadingSequenceValidated(lines, 0);
	const settings = getMetadataSettings();
	let firstRootBeforeSep = -1;
	for (const node of nodes) {
		if (node.tabDepth !== 0) continue;
		if (sepIdx >= 0 && node.lineIndex >= sepIdx) continue;
		firstRootBeforeSep = node.lineIndex;
		break;
	}
	return nodes
		.filter(
			node =>
				isH0HeadingNode(node, sepIdx, firstRootBeforeSep) ||
				classifyPersistentHeadingTitle(node.title, settings).persistent
		)
		.map(
			node =>
				`${node.lineIndex}:${node.tabDepth}:${node.title}:${metaLinesForHash(node.metaLines || []).join('\n')}`
		)
		.join('|');
}

/**
 * @param {{ next: number, free: number[] }} alloc
 * @returns {number}
 */
function allocateFromKbState(alloc) {
	if (alloc.free.length) {
		alloc.free.sort((a, b) => a - b);
		return /** @type {number} */ (alloc.free.shift());
	}
	const id = alloc.next;
	alloc.next = id + 1;
	return id;
}

/**
 * Heading line directly above an identity line (canonical below-heading layout).
 * @param {string[]} lines
 * @param {number} identityLineIndex
 * @returns {number}
 */
function findHeadingLineAboveIndex(lines, identityLineIndex) {
	for (let j = identityLineIndex - 1; j >= 0; j--) {
		const line = String(lines[j] || '');
		if (!line.trim()) continue;
		if (isHeadingIdentitySlotLine(line)) return -1;
		if (parseHeadingForValidation(line) || isHeadingStubLine(line)) return j;
		break;
	}
	return -1;
}

/**
 * @param {string[]} lines
 * @param {number} startIndex
 * @returns {number}
 */
function findHeadingLineBelowIndex(lines, startIndex) {
	for (let j = startIndex; j < lines.length; j++) {
		const line = String(lines[j] || '');
		if (!line.trim()) continue;
		if (isHeadingIdentitySlotLine(line)) return -1;
		if (parseHeadingForValidation(line) || isHeadingStubLine(line)) return j;
		break;
	}
	return -1;
}

/**
 * Remove identity lines not attached to a titled heading node.
 * @param {string[]} lines
 * @param {{ lineIndex: number }[]} nodes
 * @returns {boolean}
 */
function removeOrphanHeadingIdentityLines(lines, nodes) {
	/** @type {Set<number>} */
	const titledHeadingLines = new Set(nodes.map(node => node.lineIndex));
	/** @type {Set<number>} */
	const keepLines = new Set();
	for (let i = 0; i < lines.length; i++) {
		if (!isHeadingIdentityLine(lines[i])) continue;
		const owner = identityLineOwnerHeadingLine(lines, i);
		if (owner >= 0 && titledHeadingLines.has(owner)) {
			keepLines.add(i);
		}
	}
	let changed = false;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!isHeadingIdentityLine(lines[i])) continue;
		if (keepLines.has(i)) continue;
		lines.splice(i, 1);
		changed = true;
	}
	return changed;
}

/**
 * Drop extra `@` lines attached to the same heading (keep closest above).
 * @param {string[]} lines
 * @param {{ lineIndex: number, title?: string }[]} nodes
 * @returns {boolean}
 */
function removeExtraIdentityLinesForHeadings(lines, nodes) {
	/** @type {Set<number>} */
	const titled = new Set(
		nodes.filter(n => /\S/.test(String(n.title || '').trim())).map(n => n.lineIndex)
	);
	let changed = false;
	for (const headingLine of titled) {
		/** @type {number[]} */
		const owned = [];
		for (let i = 0; i < lines.length; i++) {
			if (!isHeadingIdentitySlotLine(lines[i])) continue;
			if (identityLineOwnerHeadingLine(lines, i) === headingLine) {
				owned.push(i);
			}
		}
		if (owned.length <= 1) continue;
		const above = owned.filter(i => i < headingLine).sort((a, b) => b - a)[0];
		const keep = above != null ? above : owned[0];
		for (let o = owned.length - 1; o >= 0; o -= 1) {
			const i = owned[o];
			if (i === keep) continue;
			lines.splice(i, 1);
			changed = true;
		}
	}
	return changed;
}

/**
 * @param {string} text
 * @param {{ kbHeadingAllocator?: { next: number, free: number[] }, lockedFile?: { fileNum: number, fileEntityId: string }, previousFullText?: string, refreshHashes?: boolean, noteUri?: import('vscode').Uri, filenameStem?: string }} [options]
 * @returns {{ text: string, changed: boolean, nonH0Count: number, usedNonH0Ids: number[] }}
 */
function reconcileHeadingIdentitiesInText(text, options = {}) {
	const normalized = String(text || '').replace(/\r\n/g, '\n');
	let lines = normalized.split('\n');
	const refreshHashes = options.refreshHashes === true;
	const lockedFromOpts = options.lockedFile || null;
	const file = parseFileEntityFromLines(lines) || lockedFromOpts;
	if (!file) {
		return { text: normalized, changed: false, nonH0Count: 0, usedNonH0Ids: [] };
	}

	const filenameStem = resolveFilenameStem(lines, options);
	const rebuilt = rebuildCanonicalFileLevelBlock(lines, {
		fileEntityId: file.fileEntityId,
		filename: filenameStem
	});
	if (rebuilt.join('\n') !== lines.join('\n')) {
		lines = rebuilt;
	}

	const sepIdx = findSeparatorLineIndex(lines);
	const { nodes: allNodes } = collectHeadingSequenceValidated(lines, 0);
	const nodes = allNodes.filter(node => /\S/.test(String(node.title || '').trim()));
	const settings = getMetadataSettings();

	let firstRootBeforeSep = -1;
	for (const node of nodes) {
		if (node.tabDepth !== 0) continue;
		if (sepIdx >= 0 && node.lineIndex >= sepIdx) continue;
		firstRootBeforeSep = node.lineIndex;
		break;
	}

	removeOrphanIdentityNearEmptyHeadings(lines);

	if (!nodes.length) {
		removeOrphanHeadingIdentityLines(lines, []);
		const fin = finalizeReconciledText(lines, sepIdx, firstRootBeforeSep, nodes, file);
		return {
			text: fin.nextText,
			changed: fin.nextText !== normalized,
			nonH0Count: fin.nonH0Count,
			usedNonH0Ids: []
		};
	}

	/** @type {Set<number>} */
	const usedNonH0 = new Set();
	/** @type {Map<number, number>} */
	const wantNumByLine = new Map();
	/** @type {Set<number>} */
	const claimedIds = new Set();
	/** @type {Set<number>} */
	const duplicateHeadingLines = new Set();

	// First titled heading in file order keeps each id; later duplicates are renumbered.
	// Non-persistent headings never claim an id — their identity line is removed below
	// and the number returns to the free pool.
	for (const node of nodes) {
		if (isH0HeadingNode(node, sepIdx, firstRootBeforeSep)) {
			wantNumByLine.set(node.lineIndex, 0);
			continue;
		}
		if (!classifyPersistentHeadingTitle(node.title, settings).persistent) continue;
		const attached = findHeadingIdentityForNode(lines, node);
		if (!attached) {
			continue;
		}
		const num = attached.parsed.headingNum;
		if (num <= 0) {
			wantNumByLine.set(node.lineIndex, 0);
			continue;
		}
		if (claimedIds.has(num)) {
			duplicateHeadingLines.add(node.lineIndex);
			continue;
		}
		claimedIds.add(num);
		wantNumByLine.set(node.lineIndex, num);
		usedNonH0.add(num);
	}

	let maxId = 0;
	for (const id of usedNonH0) maxId = Math.max(maxId, id);
	/** @type {number[]} */
	const localFreeIds = [];
	for (let i = 1; i <= maxId; i++) {
		if (!usedNonH0.has(i)) localFreeIds.push(i);
	}
	localFreeIds.sort((a, b) => a - b);
	let localNextId = maxId + 1;
	const kbAlloc = options.kbHeadingAllocator;

	if (kbAlloc) {
		const refreshed = recomputeHeadingAllocatorState(usedNonH0, kbAlloc);
		kbAlloc.free = refreshed.free;
		kbAlloc.next = refreshed.next;
	}

	function allocateNonH0Id() {
		let id;
		if (kbAlloc) {
			kbAlloc.free.sort((a, b) => a - b);
			while (kbAlloc.free.length > 0 && usedNonH0.has(kbAlloc.free[0])) {
				kbAlloc.free.shift();
			}
			if (kbAlloc.free.length > 0) {
				id = /** @type {number} */ (kbAlloc.free.shift());
			} else {
				id = maxId + 1;
				while (usedNonH0.has(id)) id += 1;
				kbAlloc.next = Math.max(kbAlloc.next, id + 1);
			}
		} else {
			while (localFreeIds.length > 0 && usedNonH0.has(localFreeIds[0])) {
				localFreeIds.shift();
			}
			if (localFreeIds.length) {
				id = /** @type {number} */ (localFreeIds.shift());
			} else {
				id = localNextId;
				while (usedNonH0.has(id)) id += 1;
				localNextId = id + 1;
			}
		}
		usedNonH0.add(id);
		maxId = Math.max(maxId, id);
		return id;
	}

	// Headings with no identity, or duplicate ids, get a fresh id from the free list.
	for (const node of nodes) {
		if (wantNumByLine.has(node.lineIndex)) continue;
		if (headingHasIdentitySlot(lines, node) && !duplicateHeadingLines.has(node.lineIndex)) continue;
		if (isH0HeadingNode(node, sepIdx, firstRootBeforeSep)) {
			wantNumByLine.set(node.lineIndex, 0);
			continue;
		}
		if (!classifyPersistentHeadingTitle(node.title, settings).persistent) continue;
		const id = allocateNonH0Id();
		wantNumByLine.set(node.lineIndex, id);
	}

	/** @type {Map<number, string>} */
	const wantLineByIndex = new Map();
	/** @type {Set<number>} heading lines whose identity must be deleted (dot removed) */
	const removeIdentityForHeadingLines = new Set();

	for (const node of nodes) {
		const attachedBefore = findHeadingIdentityForNode(lines, node);
		const isH0 = isH0HeadingNode(node, sepIdx, firstRootBeforeSep);
		const classification = classifyPersistentHeadingTitle(node.title, settings);
		if (!isH0 && !classification.persistent) {
			if (attachedBefore) removeIdentityForHeadingLines.add(node.lineIndex);
			continue;
		}
		const wantNum = wantNumByLine.get(node.lineIndex) ?? 0;
		const metadataType = classification.metadataType || '';
		const prevNum = attachedBefore ? attachedBefore.parsed.headingNum : null;
		const prevHash = attachedBefore ? attachedBefore.parsed.hash : '';
		const sameNum = prevNum != null && prevNum === wantNum;
		let hash;
		if (sameNum && !refreshHashes && prevHash) {
			hash = prevHash;
		} else {
			hash = computeHeadingHash(
				node.title,
				metadataType,
				metaLinesForHash(node.metaLines || [])
			);
		}
		const indent = headingLineIndent(lines, node.lineIndex);
		wantLineByIndex.set(node.lineIndex, `${indent}${formatHeadingIdentityLine(file.fileEntityId, wantNum, hash)}`);
	}

	const sorted = [...nodes].sort((a, b) => b.lineIndex - a.lineIndex);

	for (const node of sorted) {
		const wantLine = wantLineByIndex.get(node.lineIndex) || '';
		const headingLine = node.lineIndex;
		const idLine = findOwnedIdentityLineIndex(lines, headingLine);

		if (removeIdentityForHeadingLines.has(headingLine)) {
			if (idLine >= 0 && parseHeadingIdentityLine(lines[idLine])) {
				lines.splice(idLine, 1);
			}
			continue;
		}

		if (idLine >= 0) {
			const existing = String(lines[idLine] || '');
			if (existing !== wantLine) {
				lines[idLine] = wantLine;
			}
			continue;
		}

		if (!wantLine.trim()) {
			continue;
		}

		lines.splice(headingLine, 0, wantLine);
	}

	while (hasRawDuplicateIdentityNums(lines)) {
		if (!forceResolveRawDuplicateIdentityLines(lines, file, usedNonH0, allocateNonH0Id)) {
			break;
		}
	}

	removeExtraIdentityLinesForHeadings(lines, nodes);
	removeOrphanIdentityNearEmptyHeadings(lines);

	const { nodes: nodesAfterIdentity } = collectHeadingSequenceValidated(lines, 0);
	const titledAfterIdentity = nodesAfterIdentity.filter(node =>
		/\S/.test(String(node.title || '').trim())
	);
	removeOrphanHeadingIdentityLines(lines, titledAfterIdentity);

	const fin = finalizeReconciledText(lines, sepIdx, firstRootBeforeSep, titledAfterIdentity, file);

	const usedIds = collectUsedNonH0IdsFromNodes(
		fin.nextText.split('\n'),
		titledAfterIdentity,
		sepIdx,
		firstRootBeforeSep
	);

	return {
		text: fin.nextText,
		changed: fin.nextText !== normalized,
		nonH0Count: fin.nonH0Count,
		usedNonH0Ids: usedIds
	};
}

/**
 * Reconcile with index.drip per-file heading allocator (free-list + next counter).
 * @param {import('vscode').Uri | null | undefined} kbRoot
 * @param {string} text
 * @param {{ lockedFile?: { fileNum: number, fileEntityId: string }, previousFullText?: string, noteUri?: import('vscode').Uri }} [options]
 */
async function reconcileHeadingIdentitiesForKbNote(kbRoot, text, options = {}) {
	const normalized = String(text || '').replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');
	let file = parseFileEntityFromLines(lines) || options.lockedFile || null;
	if (!file && kbRoot && options.noteUri) {
		file = await resolveSequentialFileEntityForKbNote(kbRoot, options.noteUri, normalized);
	}
	if (!file) {
		return {
			text: normalized,
			changed: false,
			nonH0Count: 0,
			usedNonH0Ids: [],
			lockedFile: null
		};
	}
	if (!kbRoot) {
		const result = reconcileHeadingIdentitiesInText(text, { ...options, lockedFile: file });
		return { ...result, lockedFile: file };
	}

	const pool = options.headingIdPool || null;
	if (pool) {
		const kbAlloc = options.cachedAllocator || {
			next: pool.nextId,
			free: [...(pool.free || [])]
		};
		const result = reconcileHeadingIdentitiesInText(text, {
			...options,
			lockedFile: file,
			kbHeadingAllocator: kbAlloc
		});
		const { syncHeadingIdPoolFromAllocator, parseHeadingsCountFromLines } = require('./dripnoteHeadingIdPool');
		syncHeadingIdPoolFromAllocator(
			pool,
			kbAlloc,
			result.usedNonH0Ids,
			parseHeadingsCountFromLines(result.text.split('\n'))
		);
		void syncFileHeadingAllocatorFromUsedIds(kbRoot, file.fileNum, result.usedNonH0Ids).catch(err => {
			console.error('[DRIP] sync heading allocator failed', err);
		});
		return { ...result, lockedFile: file };
	}

	const cacheKey = headingAllocCacheKey(kbRoot, file.fileNum);
	let alloc = options.cachedAllocator || headingAllocCache.get(cacheKey);
	if (!alloc) {
		await initEmptyDripIndexFile(kbRoot);
		alloc = await readFileHeadingAllocator(kbRoot, file.fileNum);
	}
	const kbAlloc = { next: alloc.next, free: [...(alloc.free || [])] };
	const result = reconcileHeadingIdentitiesInText(text, {
		...options,
		lockedFile: file,
		kbHeadingAllocator: kbAlloc
	});
	headingAllocCache.set(cacheKey, { next: kbAlloc.next, free: [...kbAlloc.free] });
	void syncFileHeadingAllocatorFromUsedIds(kbRoot, file.fileNum, result.usedNonH0Ids).catch(err => {
		console.error('[DRIP] sync heading allocator failed', err);
	});
	return { ...result, lockedFile: file };
}

/**
 * @param {string} text
 * @param {number | null | undefined} headerFileNum
 * @returns {{ lineIndex: number, fileNum: number, headingNum: number }[]}
 */
function collectHeadingIdentityDiagnostics(text, headerFileNum) {
	const lines = String(text || '').replace(/\r?\n/g, '\n').split('\n');
	/** @type {Map<string, number>} */
	const seen = new Map();
	/** @type {{ lineIndex: number, fileNum: number, headingNum: number }[]} */
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const parsed = parseHeadingIdentityLine(lines[i]);
		if (!parsed) continue;
		const key = `${parsed.fileNum}:${parsed.headingNum}`;
		if (seen.has(key)) {
			out.push({ lineIndex: i, fileNum: parsed.fileNum, headingNum: parsed.headingNum, kind: 'duplicate' });
		} else {
			seen.set(key, i);
		}
		if (headerFileNum != null && parsed.fileNum !== headerFileNum) {
			out.push({ lineIndex: i, fileNum: parsed.fileNum, headingNum: parsed.headingNum, kind: 'file-mismatch' });
		}
	}
	return out;
}

/**
 * @param {string} text
 * @returns {number[]}
 */
function findHeadingIdentityLineIndexes(text) {
	const lines = String(text || '').replace(/\r?\n/g, '\n').split('\n');
	/** @type {number[]} */
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		if (isHeadingIdentityLine(lines[i])) out.push(i);
	}
	return out;
}

module.exports = {
	HEADING_IDENTITY_LINE_RE,
	isHeadingIdentityLine,
	parseHeadingIdentityLine,
	parseFileEntityFromLines,
	formatHeadingIdentityLine,
	writeFileIdIntoTopLines,
	writeHeadingsCountIntoTopLines,
	rebuildCanonicalFileLevelBlock,
	findIdentityLineAbove,
	findHeadingIdentityForNode,
	findOwnedIdentityLineIndex,
	headingHasIdentitySlot,
	isHeadingIdentitySlotLine,
	findSeparatorLineIndex,
	isH0HeadingNode,
	findHeadingLineAboveIndex,
	headingLineIndent,
	hasHeadingNeedingIdAllocation,
	hasIdentityOnNonPersistentHeading,
	hasEmptyHeadingWithIdentity,
	hasDuplicateHeadingIdsInFile,
	needsHeadingIdentityReconcile,
	headingMetadataSignature,
	reconcileHeadingIdentitiesInText,
	reconcileHeadingIdentitiesForKbNote,
	isStructuredHeadingMetadataLine,
	metaLinesForHash,
	collectHeadingIdentityDiagnostics,
	findHeadingIdentityLineIndexes,
	clearHeadingAllocCache
};
