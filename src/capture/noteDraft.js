'use strict';

/**
 * Neutral note draft — the intermediate format shared by `.d.txt` and `.d.md`.
 *
 * A selection (from either format) is parsed into this shape, shown and edited in the
 * Composer as chips, then serialized back to the target file's own format on ingest.
 *
 * Shape:
 *   title   — clean heading text (no `.d.txt` type shortcut, no markdown `#`)
 *   typeId  — metadata type id: 'concept' | 'task' | 'issue' | 'decision'
 *             | 'persistent' (untyped-but-indexed) | '' (plain, not indexed)
 *   fields  — [{ key, value }] in order; `value` is the on-disk string
 *             (`[a, b]` for lists, `hard` for enums, `YYYY-MM-DD HH:mm` for datetimes)
 *   content — body prose plus any nested headings (in neutral markdown form: nested
 *             headings are flush-left ATX `##`/`###`, so they can round-trip to either format)
 *   multipleRoots — true when the selection holds two or more sibling top-level headings,
 *             so the Composer must not collapse them into one note
 */

const { getMetadataSettings, matchHeadingTitleTypePrefix } = require('../document/model/dripNoteMetadataTemplates.js');
const {
	splitPersistentHeadingTitle,
	classifyMetaLine,
	findMetadataBlockEndExclusive
} = require('../document/model/dripTxt/dripTxtPersistentHeadingZones.js');
const { parseHeadingForValidation } = require('../document/parse/dripTxt/dripTxtHeadingParse.js');
const { parseMarkdownHeading } = require('../document/parse/dripMd/dripMdHeadingParse.js');
const { parseHeadingComment, isHeadingComment, formatHeadingComment } = require('../document/model/dripMd/dripMdNoteComment.js');
const { isHeadingIdentityLine } = require('../indexing/dripTxt/dripTxtHeadingIdentity.js');

/**
 * @returns {{ title: string, typeId: string, fields: { key: string, value: string }[], content: string, multipleRoots: boolean, sourceFormat: string }}
 */
function emptyDraft() {
	return { title: '', typeId: '', fields: [], content: '', multipleRoots: false, sourceFormat: '' };
}

/**
 * @param {string} s
 * @returns {string}
 */
function normalizeLineEndings(s) {
	return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * @param {string} line
 * @returns {number}
 */
function leadingIndentLen(line) {
	const m = /^[ \t]*/.exec(line);
	return m ? m[0].length : 0;
}

/**
 * Heading level of a line for root-detection purposes:
 * `.d.txt` uses the marker number (`#` = 0, `#1` = 1); markdown uses the hash count.
 * @param {string} line
 * @param {'drip-md' | 'md' | 'drip-txt'} sourceFormat
 * @returns {number | null}
 */
function headingLevelOfLine(line, sourceFormat) {
	const s = String(line || '');
	if (sourceFormat === 'drip-md' || sourceFormat === 'md') {
		const m = s.match(/^\s*(#{1,6})\s+\S/);
		return m ? m[1].length : null;
	}
	const m = s.match(/^\s*#(\d*)\s+\S/);
	if (!m) return null;
	return m[1] ? parseInt(m[1], 10) : 0;
}

/**
 * True when the selection holds two or more sibling top-level headings (the first heading
 * plus another heading at that same level). Such a selection must not be collapsed into one.
 * @param {string[]} lines
 * @param {'drip-md' | 'md' | 'drip-txt'} sourceFormat
 * @returns {boolean}
 */
function hasMultipleRoots(lines, sourceFormat) {
	let rootLevel = null;
	let seenFirst = false;
	for (const line of lines) {
		const level = headingLevelOfLine(line, sourceFormat);
		if (level == null) continue;
		if (!seenFirst) {
			rootLevel = level;
			seenFirst = true;
			continue;
		}
		if (level === rootLevel) return true;
	}
	return false;
}

/**
 * Cut a multi-heading selection at the first heading that sits *above* the first heading in
 * the selection (a shallower level = higher in the hierarchy). Everything from that heading
 * onward is dropped, so a selection only ever captures the first heading plus its own subtree:
 * sibling headings at the same level stay, but a parent (or a heading that ends the subtree)
 * stops the capture. The returned string is a prefix of the input, so its `.length` still
 * maps 1:1 onto the original selection's character offsets.
 * @param {string} rawText
 * @param {'drip-md' | 'md' | 'drip-txt'} sourceFormat
 * @returns {string}
 */
function truncateSelectionToSubtree(rawText, sourceFormat) {
	const text = String(rawText || '');
	const lines = text.split('\n');
	let firstLevel = null;
	let firstIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		const level = headingLevelOfLine(lines[i], sourceFormat);
		if (level != null) {
			firstLevel = level;
			firstIdx = i;
			break;
		}
	}
	if (firstLevel == null) return text;
	for (let i = firstIdx + 1; i < lines.length; i++) {
		const level = headingLevelOfLine(lines[i], sourceFormat);
		if (level != null && level < firstLevel) {
			let offset = 0;
			for (let k = 0; k < i; k++) offset += lines[k].length + 1;
			return text.slice(0, offset);
		}
	}
	return text;
}

/**
 * Read a `.marker` + `key: value` / `[tags]` metadata block starting at `startIdx`, stopping
 * at the next heading, a blank line, or the first non-metadata line. Used to lift nested
 * `.d.txt`-style metadata into a `.d.md`-style comment (and back) so content round-trips
 * between formats.
 * @param {string[]} lines
 * @param {number} startIdx
 * @param {'drip-md' | 'drip-txt'} format heading parser for the surrounding content
 * @returns {{ typeId: string, fields: { key: string, value: string }[], endExclusive: number }}
 */
function readMetadataBlock(lines, startIdx, format) {
	const settings = getMetadataSettings();
	let typeId = '';
	/** @type {{ key: string, value: string }[]} */
	const fields = [];
	let j = startIdx;
	for (; j < lines.length; j++) {
		const raw = String(lines[j] || '');
		const tr = raw.trim();
		if (!tr) break;
		if (format === 'drip-md' ? parseMarkdownHeading(raw) : parseHeadingForValidation(raw)) break;
		if (format === 'drip-md' && isHeadingComment(raw)) break;
		// A bare `.` line under a heading is the persistent (untyped) marker.
		if (tr === '.') {
			if (!typeId) typeId = 'persistent';
			continue;
		}
		const c = classifyMetaLine(raw);
		if (c.kind === 'type' && c.value) {
			const t = settings.typeByMarker.get(String(c.value).toLowerCase());
			if (t && !typeId) typeId = t.id;
			else if (c.value === '.' && !typeId) typeId = 'persistent';
			continue;
		}
		if (c.kind === 'kv' && c.key) {
			fields.push({ key: c.key, value: c.value });
			continue;
		}
		if (c.kind === 'relation' && c.key) {
			fields.push({ key: c.key, value: `[${(c.tags || []).join(', ')}]` });
			continue;
		}
		if (c.kind === 'tags') {
			fields.push({ key: 'tags', value: `[${(c.tags || []).join(', ')}]` });
			continue;
		}
		break;
	}
	return { typeId, fields, endExclusive: j };
}

/**
 * The neutral nested-heading form: an ATX heading with a clean title (no `.d.txt` shortcut)
 * followed by a `.d.md`-style hidden comment carrying the type + fields. Both formats parse
 * their content into this shape, so the ingester can serialize to either target.
 * @param {string} typeId
 * @param {{ key: string, value: string }[]} fields
 * @returns {string[]} comment line(s) to place under a heading, or [] when there is nothing
 */
function neutralMetaCommentLines(typeId, fields) {
	if (!typeId && !(fields && fields.length)) return [];
	return [formatHeadingComment(0, typeId || 'persistent', fields || [])];
}

/**
 * Convert `.d.txt` body lines into the neutral form: a heading at marker level N (`#1` → N=1)
 * becomes ATX `#`×(N+1) (`##`), the type shortcut moves off the title into a hidden comment,
 * the `.d.txt` metadata block becomes that comment, and prose drops its leading tabs.
 * Heading levels are rebased so a heading one level under the captured root maps to `##`,
 * two levels under to `###`, and so on — the content keeps its *relative* shape no matter how
 * deep in the file the captured root sat.
 * @param {string} contentText
 * @param {number} [rootLevel] marker number of the captured root heading (children are rebased off it)
 * @returns {string}
 */
function txtContentToNeutral(contentText, rootLevel = 0) {
	const lines = String(contentText || '').split('\n');
	const out = [];
	let i = 0;
	while (i < lines.length) {
		const raw = String(lines[i]);
		const ph = parseHeadingForValidation(raw);
		if (!ph) {
			out.push(raw.replace(/^\t+/, ''));
			i += 1;
			continue;
		}
		const marker = Number(ph.level) || 0;
		const level = Math.max(1, Math.min(6, marker - rootLevel + 1));
		const hashes = '#'.repeat(level);
		let typeId = typeIdFromHeadingTitle(ph.title);
		const cleanTitle = cleanTitleFromDripTxt(ph.title) || ph.title;
		const meta = readMetadataBlock(lines, i + 1, 'drip-txt');
		if (!typeId && meta.typeId) typeId = meta.typeId;
		const fields = meta.fields;
		out.push(`${hashes} ${cleanTitle}`);
		out.push(...neutralMetaCommentLines(typeId, fields));
		i = meta.endExclusive;
	}
	return out.join('\n');
}

/**
 * Normalize `.d.md` body lines into the neutral form. Clean `.d.md` content already uses
 * ATX headings + hidden comments (kept as-is); a stray `.d.txt` metadata block under a nested
 * heading (from a hand-edit or an older ingest) is converted into a comment. Heading levels
 * are rebased relative to the captured root so nested children keep their relative depth.
 * @param {string} contentText
 * @param {number} [rootLevel] `#` count of the captured root heading (children are rebased off it)
 * @returns {string}
 */
function mdContentToNeutral(contentText, rootLevel = 1) {
	const lines = String(contentText || '').split('\n');
	const out = [];
	let i = 0;
	while (i < lines.length) {
		const raw = String(lines[i]);
		const md = parseMarkdownHeading(raw);
		if (!md) {
			out.push(raw);
			i += 1;
			continue;
		}
		const level = Math.max(1, Math.min(6, md.level - rootLevel + 1));
		out.push(`${'#'.repeat(level)} ${md.title}`);
		// A comment already under the heading is the neutral form — keep it.
		if (i + 1 < lines.length && isHeadingComment(lines[i + 1])) {
			out.push(lines[i + 1]);
			i += 2;
			continue;
		}
		// Otherwise lift a `.d.txt`-style metadata block into a comment.
		const meta = readMetadataBlock(lines, i + 1, 'drip-md');
		out.push(...neutralMetaCommentLines(meta.typeId, meta.fields));
		i = meta.endExclusive;
	}
	return out.join('\n');
}

/**
 * Convert neutral content lines into `.d.txt` lines, re-levelling headings relative to
 * `baseLevel` (the new note's own heading level) and indenting prose one tab deeper than its
 * owning heading. A hidden comment under a heading is turned back into the `.d.txt` metadata
 * block (`.marker` at level+1 tabs, `key: value` at level+2 tabs), and the heading gets its
 * type shortcut back so it stays a persistent heading.
 * @param {string} contentText
 * @param {number} baseLevel
 * @returns {string[]}
 */
function contentToTxtLines(contentText, baseLevel) {
	const base = Math.max(0, Math.floor(Number(baseLevel) || 0));
	const lines = String(contentText || '').split('\n');
	const out = [];
	let cur = base;
	for (let i = 0; i < lines.length; i++) {
		const line = String(lines[i]);
		if (!line.trim()) {
			out.push('');
			continue;
		}
		const m = line.match(/^\s*(#{1,6})\s+(.*)$/);
		if (m) {
			const rel = m[1].length - 1;
			cur = Math.min(9, base + rel);
			const marker = cur === 0 ? '#' : `#${cur}`;
			const rawTitle = String(m[2] || '').trim();
			// Metadata lives in a hidden comment directly under the heading.
			let typeId = '';
			/** @type {{ key: string, value: string }[]} */
			let fields = [];
			if (i + 1 < lines.length && isHeadingComment(lines[i + 1])) {
				const comment = parseHeadingComment(lines[i + 1]);
				if (comment) {
					typeId = comment.typeId || '';
					fields = (comment.fields || []).slice();
				}
				i += 1; // consume the comment line
			}
			const hasMeta = !!typeId || fields.length > 0;
			const prefix = hasMeta && !rawTitle.startsWith('.') ? shortcutForTypeId(typeId || 'persistent') : '';
			const title = prefix ? `${prefix} ${rawTitle}` : rawTitle;
			out.push(`${'\t'.repeat(cur)}${marker} ${title}`);
			if (hasMeta) {
				const block = draftToTxtMetadata(typeId || 'persistent', fields);
				for (const bl of block.split('\n')) {
					if (!bl.trim()) continue;
					out.push('\t'.repeat(cur + 1) + bl);
				}
			}
			continue;
		}
		// Preserve any existing leading tabs so a `.d.txt` metadata block (`.marker` at
		// column 0, `key: value` at one tab) keeps its field indentation when re-indented.
		out.push('\t'.repeat(cur + 1) + line);
	}
	return out;
}

/**
 * Convert neutral markdown body lines for a `.d.md` target, shifting nested heading levels by
 * `titleLevel - 1` so a child heading stays one level under the (re-levelled) note title.
 * @param {string} contentText
 * @param {number} titleLevel markdown hash count of the new note title (1 = root `#`)
 * @returns {string[]}
 */
function contentToMdLines(contentText, titleLevel) {
	const t = Math.max(1, Math.min(6, Math.floor(Number(titleLevel) || 1)));
	const delta = t - 1;
	const lines = String(contentText || '').split('\n');
	return lines.map(line => {
		if (!line.trim()) return '';
		const m = line.match(/^\s*(#{1,6})\s+(.*)$/);
		if (m) {
			const newLevel = Math.max(1, Math.min(6, m[1].length + delta));
			return '#'.repeat(newLevel) + ' ' + String(m[2] || '').trim();
		}
		return line;
	});
}

/**
 * Dedent by the minimum shared leading indent on non-empty lines.
 * @param {string} bodyText
 * @returns {string}
 */
function dedentBodyLines(bodyText) {
	const lines = String(bodyText || '').split('\n');
	let min = Infinity;
	for (const line of lines) {
		if (!line.trim()) continue;
		const len = leadingIndentLen(line);
		if (len < min) min = len;
	}
	if (min === Infinity || min === 0) return lines.join('\n');
	return lines
		.map(line => (line.trim() ? line.slice(min) : ''))
		.join('\n');
}

/**
 * Drop `.d.txt` `@hN` identity lines and trailing `@h…` refs.
 * @param {string[]} lines
 * @returns {string[]}
 */
function cleanDripTxtLines(lines) {
	const out = [];
	for (const raw of lines) {
		if (isHeadingIdentityLine(raw)) continue;
		const cleaned = String(raw || '')
			.replace(/\s+@+h\d+\b/gi, '')
			.replace(/[ \t]+$/g, '');
		if (!cleaned.trim() && String(raw || '').trim()) continue;
		out.push(cleaned);
	}
	return out;
}

/**
 * Trim outer blanks and collapse blank runs.
 * @param {string[]} lines
 * @returns {string[]}
 */
function normalizeBlankLines(lines) {
	const out = [];
	let pendingBlank = false;
	for (const line of lines) {
		if (!String(line || '').trim()) {
			if (out.length === 0) continue;
			pendingBlank = true;
			continue;
		}
		if (pendingBlank) {
			out.push('');
			pendingBlank = false;
		}
		out.push(line);
	}
	return out;
}

/**
 * Resolve a type id from a heading title, mapping a bare leading `.` to `persistent`.
 * @param {string} title heading title (after any `#` markers)
 * @returns {string} typeId
 */
function typeIdFromHeadingTitle(title) {
	const t = String(title || '').trim();
	const matched = matchHeadingTitleTypePrefix(t, getMetadataSettings());
	if (matched.typeId) return matched.typeId;
	if (t.startsWith('.')) return 'persistent';
	return '';
}

/**
 * Clean display title from a `.d.txt` heading title (strip the `.c` / `.` prefix).
 * @param {string} title heading title
 * @returns {string}
 */
function cleanTitleFromDripTxt(title) {
	const t = String(title || '').trim();
	if (!t) return '';
	if (t === '.') return '';
	const split = splitPersistentHeadingTitle(t, t);
	if (split.titleDisplay) return split.titleDisplay;
	return t.replace(/^\.\S*\s*/, '').trim();
}

/**
 * Parse a `.d.txt` selection into a neutral draft.
 * @param {string} rawText
 * @returns {{ title: string, typeId: string, fields: { key: string, value: string }[], content: string, multipleRoots: boolean }}
 */
function parseDripTxtToDraft(rawText) {
	const text = normalizeLineEndings(rawText);
	let lines = text.split('\n');
	lines = normalizeBlankLines(cleanDripTxtLines(lines));
	if (!lines.length) return emptyDraft();

	const ph = parseHeadingForValidation(lines[0]);
	if (!ph) {
		return { title: '', typeId: '', fields: [], content: dedentBodyLines(lines.join('\n')).trim(), multipleRoots: false, sourceFormat: 'drip-txt' };
	}
	const rootLevel = Number(ph.level) || 0;

	// Two or more sibling top-level headings: keep the whole selection as body, don't collapse.
	if (hasMultipleRoots(lines, 'drip-txt')) {
		return { title: '', typeId: '', fields: [], content: txtContentToNeutral(lines.join('\n'), rootLevel).trim(), multipleRoots: true, sourceFormat: 'drip-txt' };
	}

	const settings = getMetadataSettings();
	let typeId = typeIdFromHeadingTitle(ph.title);
	const title = cleanTitleFromDripTxt(ph.title);

	const metaEnd = findMetadataBlockEndExclusive(lines, 0);
	/** @type {{ key: string, value: string }[]} */
	const fields = [];
	for (let j = 1; j < metaEnd; j++) {
		const c = classifyMetaLine(lines[j]);
		if (c.kind === 'type' && c.value && !typeId) {
			const t = settings.typeByMarker.get(String(c.value).toLowerCase());
			if (t) typeId = t.id;
			continue;
		}
		if (c.kind === 'kv' && c.key) {
			fields.push({ key: c.key, value: c.value });
		} else if (c.kind === 'relation' && c.key) {
			fields.push({ key: c.key, value: `[${(c.tags || []).join(', ')}]` });
		} else if (c.kind === 'tags') {
			fields.push({ key: 'tags', value: `[${(c.tags || []).join(', ')}]` });
		}
	}

	const content = txtContentToNeutral(lines.slice(metaEnd).join('\n'), rootLevel).trim();
	return { title, typeId, fields, content, multipleRoots: false, sourceFormat: 'drip-txt' };
}

/**
 * Parse a `.d.md` / markdown selection into a neutral draft.
 * @param {string} rawText
 * @returns {{ title: string, typeId: string, fields: { key: string, value: string }[], content: string, multipleRoots: boolean }}
 */
function parseDripMdToDraft(rawText) {
	const text = normalizeLineEndings(rawText);
	let lines = normalizeBlankLines(text.split('\n'));
	if (!lines.length) return emptyDraft();

	let headingIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (parseMarkdownHeading(lines[i])) {
			headingIdx = i;
			break;
		}
	}
	if (headingIdx < 0) {
		return { title: '', typeId: '', fields: [], content: dedentBodyLines(lines.join('\n')).trim(), multipleRoots: false, sourceFormat: 'drip-md' };
	}

	const firstMd = parseMarkdownHeading(lines[headingIdx]);
	const rootLevel = (firstMd && firstMd.level) || 1;

	// Two or more sibling top-level headings: keep the whole selection as body, don't collapse.
	if (hasMultipleRoots(lines, 'drip-md')) {
		return { title: '', typeId: '', fields: [], content: mdContentToNeutral(lines.join('\n'), rootLevel).trim(), multipleRoots: true, sourceFormat: 'drip-md' };
	}

	const md = parseMarkdownHeading(lines[headingIdx]);
	const title = String((md && md.title) || '').trim();

	let typeId = '';
	/** @type {{ key: string, value: string }[]} */
	const fields = [];
	let metaEnd = headingIdx + 1;
	if (headingIdx + 1 < lines.length && isHeadingComment(lines[headingIdx + 1])) {
		const comment = parseHeadingComment(lines[headingIdx + 1]);
		if (comment) {
			typeId = comment.typeId;
			for (const f of comment.fields) fields.push({ key: f.key, value: f.value });
		}
		metaEnd = headingIdx + 2;
	} else {
		// A stray `.d.txt`-style metadata block (`.marker` + `key: value`) under the heading
		// carries the type too — lift it the same way a comment would.
		const meta = readMetadataBlock(lines, headingIdx + 1, 'drip-md');
		typeId = meta.typeId;
		fields.push(...meta.fields);
		metaEnd = meta.endExclusive;
	}
	if (!typeId && fields.length) typeId = 'persistent';
	const content = mdContentToNeutral(lines.slice(metaEnd).join('\n'), rootLevel).trim();
	return { title, typeId, fields, content, multipleRoots: false, sourceFormat: 'drip-md' };
}

/**
 * Parse a raw selection (either format) into the neutral draft shape.
 * @param {string} rawText
 * @param {'drip-md' | 'md' | 'drip-txt'} [sourceFormat]
 * @returns {{ title: string, typeId: string, fields: { key: string, value: string }[], content: string, multipleRoots: boolean, sourceFormat: string }}
 */
function parseSelectionToDraft(rawText, sourceFormat) {
	const text = truncateSelectionToSubtree(rawText, sourceFormat);
	if (sourceFormat === 'drip-md' || sourceFormat === 'md') {
		return parseDripMdToDraft(text);
	}
	return parseDripTxtToDraft(text);
}

/**
 * Parse a `.d.txt`-style metadata block (`.concept` marker + `key: value` lines) back
 * into `typeId` + `fields`. Used to migrate older drafts that stored only the metadata
 * string and no structured fields.
 * @param {string} metadata
 * @returns {{ typeId: string, fields: { key: string, value: string }[] }}
 */
function parseDripTxtMetadata(metadata) {
	const lines = String(metadata || '').split('\n').map(l => l.trim()).filter(Boolean);
	let typeId = '';
	/** @type {{ key: string, value: string }[]} */
	const fields = [];
	const settings = getMetadataSettings();
	for (const line of lines) {
		const c = classifyMetaLine(line);
		if (c.kind === 'type' && c.value) {
			const t = settings.typeByMarker.get(String(c.value).toLowerCase());
			typeId = t ? t.id : (c.value === '.' ? 'persistent' : typeId);
		} else if (c.kind === 'kv' && c.key) {
			fields.push({ key: c.key, value: c.value });
		} else if (c.kind === 'relation' && c.key) {
			fields.push({ key: c.key, value: `[${(c.tags || []).join(', ')}]` });
		} else if (c.kind === 'tags') {
			fields.push({ key: 'tags', value: `[${(c.tags || []).join(', ')}]` });
		}
	}
	return { typeId, fields };
}

/**
 * `.d.txt` type shortcut for a type id: `.c`, `.task`, … or `.` for plain/persistent.
 * Ingested notes are always indexed, so an untyped note becomes a bare `.` persistent heading.
 * @param {string} typeId
 * @returns {string}
 */
function shortcutForTypeId(typeId) {
	const id = String(typeId || '').toLowerCase();
	if (!id || id === 'persistent') return '.';
	const t = getMetadataSettings().typeById.get(id);
	if (!t || !t.shortcut) return '.';
	const sc = String(t.shortcut).replace(/^\./, '');
	return sc ? `.${sc}` : '.';
}

/**
 * `.d.txt` metadata block: type marker at indent 0, fields at indent 1.
 * @param {string} typeId
 * @param {{ key: string, value: string }[]} fields
 * @returns {string}
 */
function draftToTxtMetadata(typeId, fields) {
	const lines = [];
	const id = String(typeId || '').toLowerCase();
	const t = getMetadataSettings().typeById.get(id);
	// Only a real type gets a `.marker` line; a persistent (untyped) heading carries its
	// bare `.` in the title, not as a redundant marker under it.
	if (t && t.marker) lines.push(t.marker);
	for (const f of fields || []) {
		const key = String(f.key || '').trim();
		if (!key) continue;
		lines.push(`\t${key}: ${String(f.value || '').trim()}`);
	}
	return lines.join('\n');
}

/**
 * `.d.md` heading comment for a draft heading (heading number 0; the `.d.md` sync
 * resolves the real `hN` on the next open/save). Untyped notes become `persistent`.
 * @param {string} typeId
 * @param {{ key: string, value: string }[]} fields
 * @returns {string}
 */
function draftToMdCommentText(typeId, fields) {
	const id = String(typeId || '').toLowerCase();
	const commentType = id && id !== 'persistent' ? id : 'persistent';
	return formatHeadingComment(0, commentType, fields || []);
}

module.exports = {
	emptyDraft,
	parseSelectionToDraft,
	parseDripTxtToDraft,
	parseDripMdToDraft,
	parseDripTxtMetadata,
	cleanTitleFromDripTxt,
	shortcutForTypeId,
	draftToTxtMetadata,
	draftToMdCommentText,
	txtContentToNeutral,
	contentToTxtLines,
	contentToMdLines,
	hasMultipleRoots,
	truncateSelectionToSubtree
};
