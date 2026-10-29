'use strict';

const path = require('path');
const { collectHeadingSequenceValidated, parseHeadingForValidation } = require('../../document/parse/dripTxt/dripTxtHeadingParse.js');
const {
	getMetadataSettings,
	getMetadataSettingsForIndex,
	allowedHeadingTypeIdsForPath,
	lockedSpecialTypeIdForPath,
	matchHeadingTitleTypePrefix
} = require('../../document/model/dripNoteMetadataTemplates.js');
const {
	classifyPersistentHeadingTitle,
	stripHeadingTitleTypePrefix
} = require('../../document/model/dripTxt/dripTxtPersistentHeading.js');
const { isDripFeatureFileName } = require('../../document/model/dripNoteFeature.js');
const { stripKbNoteExtension, getKbNoteExtensions } = require('../../document/model/dripNoteFileTypes.js');
const { parseFileEntityIdNumber, formatFileEntityId } = require('./dripTxtEntityIds.js');
const {
	initEmptyDripIndexFile,
	readFileHeadingAllocator,
	syncFileHeadingAllocatorFromUsedIds,
	recomputeHeadingAllocatorState,
	resolveSequentialFileEntityForKbNote
} = require('../dripIndexDb');

/** @type {Map<string, { next: number, free: number[] }>} */
const headingAllocCache = new Map();

/**
 * @param {import('vscode').Uri} kbRoot
 * @param {number} fileNum
 * @returns {string}
 */
function headingAllocCacheKey(kbRoot, fileNum, scopeKey) {
	const scope = String(scopeKey || '');
	return `${kbRoot.fsPath}|${scope}|${Math.max(0, Math.floor(Number(fileNum) || 0))}`;
}

function clearHeadingAllocCache() {
	headingAllocCache.clear();
}

/** `@h0` or `@h1` — the heading's per-file number (no file id, no hash). */
const HEADING_IDENTITY_LINE_RE = /^\s*@+\s*h(\d+)\s*$/i;

/**
 * @param {string} line
 * @returns {boolean}
 */
function isHeadingIdentityLine(line) {
	return HEADING_IDENTITY_LINE_RE.test(String(line || ''));
}

/**
 * @param {string} line
 * @returns {{ headingNum: number } | null}
 */
function parseHeadingIdentityLine(line) {
	const m = HEADING_IDENTITY_LINE_RE.exec(String(line || ''));
	if (!m) return null;
	const headingNum = parseInt(m[1], 10);
	if (!Number.isFinite(headingNum)) return null;
	return { headingNum };
}

/**
 * @param {number} headingNum
 * @returns {string}
 */
function formatHeadingIdentityLine(headingNum) {
	const n = Math.max(0, Math.floor(Number(headingNum) || 0));
	return `@h${n}`;
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
	return /^\s*(filename|fileid|fileuid|headings|created|random)\s*:/i.test(String(line || ''));
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
	// The `filename:` header is the note's human title and the name the h0 heading must
	// match. The on-disk file name is a slugified form of it ("kv cache" → "kv-cache.d.txt"),
	// so preferring the file stem here would rewrite the header to the slug and then
	// (wrongly) demote the still-matching h0 into a duplicate heading.
	for (const line of lines || []) {
		const m = String(line || '').match(/^\s*filename\s*:\s*(.*)$/i);
		if (m && String(m[1] || '').trim()) return String(m[1]).trim();
	}
	if (options && options.noteUri && options.noteUri.fsPath) {
		return stripKbNoteExtension(path.basename(options.noteUri.fsPath));
	}
	return 'Untitled';
}

/**
 * The structural h0 type marker a note falls back to when its h0 has no (valid) type yet:
 * `.p` for project index notes, `.f` for feature index notes, bare `.` everywhere else.
 * @param {string | null | undefined} noteFsPath
 * @returns {'.p' | '.f' | '.'}
 */
function defaultH0TypeMarkerForPath(noteFsPath) {
	const locked = lockedSpecialTypeIdForPath(noteFsPath || undefined);
	if (locked === 'project') return '.p';
	if (locked === 'feature') return '.f';
	// A standalone feature file (`Name.f.d.txt`) is a feature in its own right, so its
	// h0 carries the structural `.f` marker just like a feature folder index note.
	if (noteFsPath && isDripFeatureFileName(path.basename(noteFsPath), getKbNoteExtensions())) return '.f';
	return '.';
}

/**
 * Canonical h0 title for a note: `# . <filename>` (persistent) by default. When the current
 * h0 already carries a metadata type that is acceptable for this file (`.c`/`.t` on a regular
 * note, `.p`/`.f` on an index note), the title is kept exactly as written. Any unacceptable
 * type is dropped to the note's structural convention — bare `.` for a normal note, `.p`/`.f`
 * for a project/feature index note — keeping the existing name part so only the type marker
 * changes. The h0's body, tags, and relations stay untouched either way.
 *
 * @param {string} currentTitle existing h0 title without the `#` marker, or ''
 * @param {string} filename
 * @param {string | null | undefined} noteFsPath
 * @returns {string}
 */
function resolveCanonicalH0Title(currentTitle, filename, noteFsPath) {
	const title = String(currentTitle || '').trim();
	const settings = getMetadataSettingsForIndex();
	const allowed = allowedHeadingTypeIdsForPath(noteFsPath || undefined);
	const matched = matchHeadingTitleTypePrefix(title, settings);
	if (
		matched.typeId &&
		!matched.invalid &&
		allowed.has(String(matched.typeId).toLowerCase())
	) {
		return title;
	}
	const name =
		stripHeadingTitleTypePrefix(title) ||
		String(filename || '').trim() ||
		'Untitled';
	const marker = defaultH0TypeMarkerForPath(noteFsPath);
	return marker === '.' ? `. ${name}` : `${marker} ${name}`;
}

/**
 * Bump a heading marker one level (`#` → `#1`, `#1` → `#2`, …) and add one leading tab so the
 * indent keeps mirroring the marker. Used when the h0 heading is demoted to a regular heading
 * because its name no longer matches the file name.
 * @param {string} line
 * @returns {string}
 */
function demoteHeadingLine(line) {
	return String(line || '').replace(/^(\s*#)(\d*)(\s+)/, (m, hash, num, ws) => {
		const n = num ? parseInt(num, 10) : 0;
		return `\t${hash}${n + 1}${ws}`;
	});
}

/**
 * True when an h0 title's name (type marker stripped) equals the file name — either the
 * resolved filename (file stem) or the existing `filename:` header (human title).
 * @param {string} title
 * @param {string} filename
 * @param {string[]} lines
 * @returns {boolean}
 */
function h0NameMatchesFilename(title, filename, lines) {
	const name = stripHeadingTitleTypePrefix(title || '').trim().toLowerCase();
	if (!name) return false;
	const candidates = new Set();
	const stem = String(filename || '').trim().toLowerCase();
	if (stem) candidates.add(stem);
	for (const line of lines || []) {
		const m = String(line || '').match(/^\s*filename\s*:\s*(.*)$/i);
		if (m && String(m[1] || '').trim()) {
			candidates.add(String(m[1]).trim().toLowerCase());
			break;
		}
	}
	return candidates.has(name);
}

/**
 * Canonical file-level block used by live reconcile and reconcile-update:
 *   filename / fileid / headings
 *   ---
 *   blank
 *   @h0
 *   # . h0 title
 *   optional about/body text under h0 (kept as-is, including blank lines)
 *   ...remaining body headings...
 *
 * The h0 heading sits **below** `---` (one empty line after it); the file keys stay above `---`.
 * Extra headings above `---` are moved below it. Prose under h0 stays with the h0 block.
 *
 * @param {string[]} lines
 * @param {{ fileEntityId: string, filename: string, noteFsPath?: string | null }} opts
 * @returns {string[]}
 */
function rebuildCanonicalFileLevelBlock(lines, opts) {
	const src = [...(lines || [])];
	const filename = String(opts.filename || 'Untitled').trim() || 'Untitled';
	const fileEntityId = String(opts.fileEntityId || '').trim() || '@f0';
	const noteFsPath = opts.noteFsPath || null;
	let fileUid = '';
	for (const line of src) {
		const m = String(line || '').match(/^\s*fileuid\s*:\s*(.+)\s*$/i);
		if (m && String(m[1] || '').trim()) {
			fileUid = String(m[1]).trim();
			break;
		}
		if (String(line || '').trim() === '---') break;
	}
	const sepIdx = findSeparatorLineIndex(src);

	// h0 = first root-level (`#`) heading, wherever it currently sits (above or below `---`).
	const { nodes } = collectHeadingSequenceValidated(src, 0);
	const h0Node = nodes.find(node => node.tabDepth === 0);

	let h0Title = resolveCanonicalH0Title('', filename, noteFsPath);
	/** @type {string[]} */
	let h0Meta = [];
	/** @type {string[]} */
	let promotedBlock = [];
	let h0BlockStart = -1;
	let h0BlockEnd = src.length;

	if (h0Node) {
		const parsed = parseHeadingForValidation(src[h0Node.lineIndex]);
		const title = parsed && String(parsed.title || '').trim();
		const h0Name = title ? stripHeadingTitleTypePrefix(title).trim() : '';
		h0BlockStart = headingBlockStart(src, h0Node.lineIndex);
		const nextHeading = nodes.find(node => node.lineIndex > h0Node.lineIndex);
		let metaEnd = nextHeading ? headingBlockStart(src, nextHeading.lineIndex) : src.length;
		if (sepIdx >= 0 && sepIdx > h0Node.lineIndex && sepIdx < metaEnd) metaEnd = sepIdx;
		h0BlockEnd = metaEnd;

		if (h0Name && !h0NameMatchesFilename(title, filename, src)) {
			// The h0 heading is named after something other than the file: demote it to a
			// regular heading (its `@h0` is dropped here and renumbered by the identity
			// reconcile), then place a fresh h0 at the top (`.p`/`.f` for index notes,
			// bare `.` otherwise).
			promotedBlock = src.slice(h0Node.lineIndex, metaEnd);
			promotedBlock[0] = demoteHeadingLine(promotedBlock[0]);
			for (let i = 1; i < promotedBlock.length; i++) {
				if (String(promotedBlock[i]).trim()) promotedBlock[i] = `\t${promotedBlock[i]}`;
			}
			h0Title = resolveCanonicalH0Title('', filename, noteFsPath);
			h0Meta = [];
		} else {
			if (title) h0Title = resolveCanonicalH0Title(title, filename, noteFsPath);
			h0Meta = src.slice(h0Node.lineIndex + 1, metaEnd).filter(line => !isFileKeyLine(line));
		}
	}

	// Body = everything that is neither a file key, the separator, nor the h0 block.
	const body = [];
	for (let i = 0; i < src.length; i++) {
		if (h0BlockStart >= 0 && i >= h0BlockStart && i < h0BlockEnd) continue;
		const line = src[i];
		if (isFileKeyLine(line)) continue;
		if (String(line).trim() === '---') continue;
		body.push(line);
	}
	while (body.length && !String(body[0]).trim()) body.shift();

	const header = [
		`filename: ${filename}`,
		`fileid: ${fileEntityId}`,
		...(fileUid ? [`fileuid: ${fileUid}`] : []),
		'headings: 0',
		'---',
		'',
		'@h0',
		`# ${h0Title}`,
		...h0Meta,
		...promotedBlock,
		...body
	];
	return header;
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
 * Line index of the h0 heading — the first root-level (`#`) heading after the `---` separator.
 * @param {string[]} lines
 * @returns {number}
 */
function findH0HeadingLine(lines) {
	const sepIdx = findSeparatorLineIndex(lines);
	const { nodes } = collectHeadingSequenceValidated(lines, 0);
	for (const node of nodes) {
		if (node.tabDepth !== 0) continue;
		if (sepIdx >= 0 && node.lineIndex <= sepIdx) continue;
		return node.lineIndex;
	}
	return -1;
}

/**
 * @param {{ lineIndex: number, tabDepth: number }} node
 * @param {number} h0LineIndex
 */
function isH0HeadingNode(node, h0LineIndex) {
	return node.lineIndex === h0LineIndex && node.tabDepth === 0;
}

/**
 * First heading line that owns this `@hN` line.
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
 * @returns {{ lineIndex: number, parsed: { headingNum: number } } | null}
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
 * `@h…` line above a heading, including while the user is still typing the id.
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
 * Leading whitespace before the `#`/`#N` marker — identity line uses the same indent.
 * @param {string[]} lines
 * @param {number} headingLineIndex
 * @returns {string}
 */
function headingLineIndent(lines, headingLineIndex) {
	const m = String(lines[headingLineIndex] || '').match(/^(\s*)#\d*\s+/);
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
	return /^(\s*)(#\d*)\s*$/.test(String(line || ''));
}

/**
 * True when a titled `#` line has no identity line directly above it.
 * @param {string} text
 * @returns {boolean}
 */
function hasHeadingNeedingIdAllocation(text) {
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	const { nodes } = collectHeadingSequenceValidated(lines, 0);
	const settings = getMetadataSettings();
	const h0LineIndex = findH0HeadingLine(lines);
	for (const node of nodes) {
		if (!/\S/.test(String(node.title || '').trim())) continue;
		const isH0 = isH0HeadingNode(node, h0LineIndex);
		if (!isH0 && !classifyPersistentHeadingTitle(node.title, settings).persistent) continue;
		if (headingHasIdentitySlot(lines, node)) continue;
		return true;
	}
	return false;
}

/**
 * True when a heading that is no longer persistent (dot removed) still carries
 * an `@hN` identity line — reconcile must delete it.
 * @param {string} text
 * @returns {boolean}
 */
function hasIdentityOnNonPersistentHeading(text) {
	const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
	const { nodes } = collectHeadingSequenceValidated(lines, 0);
	const settings = getMetadataSettings();
	const h0LineIndex = findH0HeadingLine(lines);
	for (const node of nodes) {
		if (!/\S/.test(String(node.title || '').trim())) continue;
		if (isH0HeadingNode(node, h0LineIndex)) continue;
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
	const { nodes } = collectHeadingSequenceValidated(lines, 0);
	const settings = getMetadataSettings();
	const titled = nodes.filter(node => /\S/.test(String(node.title || '').trim()));
	const h0LineIndex = findH0HeadingLine(lines);
	let nonH0Count = 0;
	for (const node of titled) {
		if (isH0HeadingNode(node, h0LineIndex)) continue;
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
	const { nodes } = collectHeadingSequenceValidated(lines, 0);
	const h0LineIndex = findH0HeadingLine(lines);
	/** @type {Set<number>} */
	const seen = new Set();
	for (const node of nodes) {
		if (!/\S/.test(String(node.title || '').trim())) continue;
		if (isH0HeadingNode(node, h0LineIndex)) continue;
		const attached = findHeadingIdentityForNode(lines, node);
		if (!attached) continue;
		const num = attached.parsed.headingNum;
		// `@h0` (id 0) is reserved for the file-name heading. On any other heading it
		// is an invalid duplicate that reconcile must renumber.
		if (num <= 0) return true;
		if (seen.has(num)) return true;
		seen.add(num);
	}
	return false;
}

/**
 * True when two or more parsed `@hN` lines in the file share the same N.
 * @param {string[]} lines
 * @returns {boolean}
 */
function hasRawDuplicateIdentityNums(lines) {
	/** @type {Set<number>} */
	const seen = new Set();
	for (let i = 0; i < lines.length; i++) {
		const parsed = parseHeadingIdentityLine(lines[i]);
		if (!parsed || parsed.headingNum <= 0) continue;
		if (seen.has(parsed.headingNum)) return true;
		seen.add(parsed.headingNum);
	}
	return false;
}

/**
 * Renumber duplicate `@hN` lines in file order (first occurrence keeps id).
 * @param {string[]} lines
 * @param {Set<number>} usedNonH0
 * @param {() => number} allocateNonH0Id
 * @returns {boolean}
 */
function forceResolveRawDuplicateIdentityLines(lines, usedNonH0, allocateNonH0Id) {
	/** @type {Set<number>} */
	const seenNums = new Set();
	let changed = false;
	for (let i = 0; i < lines.length; i++) {
		const parsed = parseHeadingIdentityLine(lines[i]);
		if (!parsed || parsed.headingNum <= 0) continue;
		if (!seenNums.has(parsed.headingNum)) {
			seenNums.add(parsed.headingNum);
			usedNonH0.add(parsed.headingNum);
			continue;
		}
		const newNum = allocateNonH0Id();
		usedNonH0.add(newNum);
		const indent = String(lines[i] || '').match(/^(\s*)/)?.[1] || '';
		lines[i] = `${indent}${formatHeadingIdentityLine(newNum)}`;
		changed = true;
	}
	return changed;
}

/**
 * @param {string[]} lines
 * @param {{ lineIndex: number, title?: string }[]} nodes
 * @returns {number[]}
 */
function collectUsedNonH0IdsFromNodes(lines, nodes) {
	const h0LineIndex = findH0HeadingLine(lines);
	/** @type {Set<number>} */
	const used = new Set();
	for (const node of nodes) {
		if (!/\S/.test(String(node.title || '').trim())) continue;
		if (isH0HeadingNode(node, h0LineIndex)) continue;
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
 * @param {{ title: string }[]} nodes
 * @param {{ fileEntityId: string }} file
 * @returns {string}
 */
function finalizeReconciledText(lines, nodes, file) {
	const h0LineIndex = findH0HeadingLine(lines);
	const sepIdxFinal = findSeparatorLineIndex(lines);
	const topEndFinal = sepIdxFinal >= 0 ? sepIdxFinal : lines.length;
	const topLines = lines.slice(0, topEndFinal);
	const bodyLines = sepIdxFinal >= 0 ? lines.slice(sepIdxFinal) : [];
	const settings = getMetadataSettings();
	let nonH0Count = 0;
	for (const node of nodes) {
		if (isH0HeadingNode(node, h0LineIndex)) continue;
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
	const { nodes } = collectHeadingSequenceValidated(lines, 0);
	const settings = getMetadataSettings();
	const h0LineIndex = findH0HeadingLine(lines);
	return nodes
		.filter(
			node =>
				isH0HeadingNode(node, h0LineIndex) ||
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
	const lockedFromOpts = options.lockedFile || null;
	const file = parseFileEntityFromLines(lines) || lockedFromOpts;
	if (!file) {
		return { text: normalized, changed: false, nonH0Count: 0, usedNonH0Ids: [] };
	}

	const filenameStem = resolveFilenameStem(lines, options);
	const rebuilt = rebuildCanonicalFileLevelBlock(lines, {
		fileEntityId: file.fileEntityId,
		filename: filenameStem,
		noteFsPath: options.noteUri ? options.noteUri.fsPath : null
	});
	if (rebuilt.join('\n') !== lines.join('\n')) {
		lines = rebuilt;
	}

	const { nodes: allNodes } = collectHeadingSequenceValidated(lines, 0);
	const nodes = allNodes.filter(node => /\S/.test(String(node.title || '').trim()));
	const settings = getMetadataSettings();
	const h0LineIndex = findH0HeadingLine(lines);

	removeOrphanIdentityNearEmptyHeadings(lines);

	if (!nodes.length) {
		removeOrphanHeadingIdentityLines(lines, []);
		const fin = finalizeReconciledText(lines, nodes, file);
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
		if (isH0HeadingNode(node, h0LineIndex)) {
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
			// `@h0` (id 0) belongs only to the file-name heading; a non-h0 heading
			// carrying it must be renumbered — never keep 0.
			duplicateHeadingLines.add(node.lineIndex);
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
		if (isH0HeadingNode(node, h0LineIndex)) {
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
		const isH0 = isH0HeadingNode(node, h0LineIndex);
		const classification = classifyPersistentHeadingTitle(node.title, settings);
		if (!isH0 && !classification.persistent) {
			if (attachedBefore) removeIdentityForHeadingLines.add(node.lineIndex);
			continue;
		}
		const wantNum = wantNumByLine.get(node.lineIndex) ?? 0;
		const indent = headingLineIndent(lines, node.lineIndex);
		wantLineByIndex.set(node.lineIndex, `${indent}${formatHeadingIdentityLine(wantNum)}`);
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
		if (!forceResolveRawDuplicateIdentityLines(lines, usedNonH0, allocateNonH0Id)) {
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

	const fin = finalizeReconciledText(lines, titledAfterIdentity, file);

	const usedIds = collectUsedNonH0IdsFromNodes(fin.nextText.split('\n'), titledAfterIdentity);

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

	const { headingAllocScopeForNote } = require('../../document/project/projectFileIds');
	const scopeKey = headingAllocScopeForNote(kbRoot, options.noteUri);

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
		const { syncHeadingIdPoolFromAllocator, parseHeadingsCountFromLines } = require('./dripTxtHeadingIdPool.js');
		syncHeadingIdPoolFromAllocator(
			pool,
			kbAlloc,
			result.usedNonH0Ids,
			parseHeadingsCountFromLines(result.text.split('\n'))
		);
		void syncFileHeadingAllocatorFromUsedIds(kbRoot, file.fileNum, result.usedNonH0Ids, scopeKey).catch(err => {
			console.error('[DRIP] sync heading allocator failed', err);
		});
		return { ...result, lockedFile: file };
	}

	const cacheKey = headingAllocCacheKey(kbRoot, file.fileNum, scopeKey);
	let alloc = options.cachedAllocator || headingAllocCache.get(cacheKey);
	if (!alloc) {
		await initEmptyDripIndexFile(kbRoot);
		alloc = await readFileHeadingAllocator(kbRoot, file.fileNum, scopeKey);
	}
	const kbAlloc = { next: alloc.next, free: [...(alloc.free || [])] };
	const result = reconcileHeadingIdentitiesInText(text, {
		...options,
		lockedFile: file,
		kbHeadingAllocator: kbAlloc
	});
	headingAllocCache.set(cacheKey, { next: kbAlloc.next, free: [...kbAlloc.free] });
	void syncFileHeadingAllocatorFromUsedIds(kbRoot, file.fileNum, result.usedNonH0Ids, scopeKey).catch(err => {
		console.error('[DRIP] sync heading allocator failed', err);
	});
	return { ...result, lockedFile: file };
}

/**
 * Fill missing `@hN` lines without reminting existing ones or rebuilding the header.
 * Used when a project is shared and when a project note is reprinted.
 * @param {string} text
 * @returns {{ text: string, changed: boolean }}
 */
function stampMissingHeadingIdentitiesInText(text) {
	const normalized = String(text || '').replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');
	const settings = getMetadataSettings();
	const { nodes: allNodes } = collectHeadingSequenceValidated(lines, 0);
	const nodes = allNodes.filter(node => /\S/.test(String(node.title || '').trim()));
	const h0LineIndex = findH0HeadingLine(lines);
	/** @type {Set<number>} */
	const used = new Set();
	for (const node of nodes) {
		if (isH0HeadingNode(node, h0LineIndex)) continue;
		if (!classifyPersistentHeadingTitle(node.title, settings).persistent) continue;
		const attached = findHeadingIdentityForNode(lines, node);
		const num = attached ? attached.parsed.headingNum : 0;
		if (num > 0) used.add(num);
	}
	let nextNum = 1;
	while (used.has(nextNum)) nextNum += 1;

	/** @type {Map<number, string>} */
	const insertByHeading = new Map();
	for (const node of nodes) {
		if (isH0HeadingNode(node, h0LineIndex)) {
			if (!findHeadingIdentityForNode(lines, node)) {
				insertByHeading.set(node.lineIndex, `${headingLineIndent(lines, node.lineIndex)}${formatHeadingIdentityLine(0)}`);
			}
			continue;
		}
		if (!classifyPersistentHeadingTitle(node.title, settings).persistent) continue;
		if (findHeadingIdentityForNode(lines, node)) continue;
		insertByHeading.set(
			node.lineIndex,
			`${headingLineIndent(lines, node.lineIndex)}${formatHeadingIdentityLine(nextNum)}`
		);
		used.add(nextNum);
		nextNum += 1;
		while (used.has(nextNum)) nextNum += 1;
	}

	const sorted = [...insertByHeading.keys()].sort((a, b) => b - a);
	for (const headingLine of sorted) {
		lines.splice(headingLine, 0, insertByHeading.get(headingLine));
	}

	const sepIdx = findSeparatorLineIndex(lines);
	const topEnd = sepIdx >= 0 ? sepIdx : lines.length;
	const topLines = writeHeadingsCountIntoTopLines(lines.slice(0, topEnd), used.size);
	const nextText = [...topLines, ...lines.slice(topEnd)].join('\n');
	return { text: nextText, changed: nextText !== normalized };
}

/**
 * @param {string} text
 * @param {number | null | undefined} _headerFileNum unused (heading identity carries no file id)
 * @returns {{ lineIndex: number, headingNum: number, kind: string }[]}
 */
function collectHeadingIdentityDiagnostics(text, _headerFileNum) {
	const lines = String(text || '').replace(/\r?\n/g, '\n').split('\n');
	/** @type {Map<number, number>} */
	const seen = new Map();
	/** @type {{ lineIndex: number, headingNum: number, kind: string }[]} */
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const parsed = parseHeadingIdentityLine(lines[i]);
		if (!parsed || parsed.headingNum <= 0) continue;
		if (seen.has(parsed.headingNum)) {
			out.push({ lineIndex: i, headingNum: parsed.headingNum, kind: 'duplicate' });
		} else {
			seen.set(parsed.headingNum, i);
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
	resolveFilenameStem,
	findIdentityLineAbove,
	findHeadingIdentityForNode,
	findOwnedIdentityLineIndex,
	headingHasIdentitySlot,
	isHeadingIdentitySlotLine,
	findSeparatorLineIndex,
	findH0HeadingLine,
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
	stampMissingHeadingIdentitiesInText,
	isStructuredHeadingMetadataLine,
	metaLinesForHash,
	collectHeadingIdentityDiagnostics,
	findHeadingIdentityLineIndexes,
	clearHeadingAllocCache
};
