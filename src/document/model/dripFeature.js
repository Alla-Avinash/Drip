'use strict';

/**
 * Drip features:
 * - Folder ending `.f` → index `_Name.f.d.txt` with h0 `# .f f-N Name`
 * - Standalone `Name.f.d.txt` feature files under a project (also stamped with f-N)
 */

const FEATURE_FOLDER_EXT = '.f';
/** Inserted before the note extension: `stem.f.d.txt`. */
const FEATURE_FILE_MARKER = '.f';

/**
 * @param {string} folderBasename
 * @returns {boolean}
 */
function isDripFeatureFolderName(folderBasename) {
	const name = String(folderBasename || '').trim();
	if (!name) return false;
	return name.toLowerCase().endsWith(FEATURE_FOLDER_EXT);
}

/**
 * @param {string} folderBasename
 * @returns {string}
 */
function featureDisplayNameFromFolderName(folderBasename) {
	const name = String(folderBasename || '').trim();
	if (!name) return 'feature';
	if (name.toLowerCase().endsWith(FEATURE_FOLDER_EXT)) {
		const stem = name.slice(0, -FEATURE_FOLDER_EXT.length).trim();
		return stem || 'feature';
	}
	return name;
}

/**
 * @param {string} name
 * @returns {string}
 */
function sanitizeFeatureIndexStem(name) {
	const cleaned = String(name || '')
		.trim()
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
		.replace(/\.+$/g, '')
		.trim();
	return cleaned || 'feature';
}

/**
 * Feature folder index note: `_Auth.f.d.txt` for folder `Auth.f`.
 * @param {string} folderBasename
 * @returns {string}
 */
function featureIndexFileName(folderBasename) {
	const stem = sanitizeFeatureIndexStem(featureDisplayNameFromFolderName(folderBasename));
	return `_${stem}.f.d.txt`;
}

/**
 * True if basename is a retired standalone feature note: `something.f.d.txt`
 * (not the folder index `_Name.f.d.txt`).
 * @param {string} fileBasename
 * @param {string[]} [noteExtensions] e.g. ['.d.txt', '.md']
 * @returns {boolean}
 */
function isDripFeatureFileName(fileBasename, noteExtensions) {
	const base = String(fileBasename || '').trim();
	if (!base) return false;
	// Folder index notes: `_Auth.f.d.txt` — not standalone feature files.
	if (/^_.+\.f\.d\.txt$/i.test(base)) return false;
	const exts = Array.isArray(noteExtensions) && noteExtensions.length ? noteExtensions : ['.d.txt'];
	const lower = base.toLowerCase();
	for (const ext of exts) {
		const e = String(ext || '').toLowerCase();
		if (!e) continue;
		const suffix = `${FEATURE_FILE_MARKER}${e}`;
		if (lower.endsWith(suffix) && lower.length > suffix.length) {
			return true;
		}
	}
	return false;
}

/**
 * Build feature note basename from a normal note basename.
 * `editor.d.txt` → `editor.f.d.txt`
 * @param {string} fileBasename
 * @param {string} noteExt e.g. `.d.txt`
 * @returns {string | null} null if already feature or not a matching note
 */
function toFeatureFileName(fileBasename, noteExt) {
	const base = String(fileBasename || '').trim();
	const ext = String(noteExt || '').toLowerCase();
	if (!base || !ext) return null;
	const lower = base.toLowerCase();
	if (!lower.endsWith(ext.toLowerCase())) return null;
	if (isDripFeatureFileName(base, [ext])) return null;
	const stem = base.slice(0, -ext.length);
	if (!stem) return null;
	return `${stem}${FEATURE_FILE_MARKER}${ext.startsWith('.') ? ext : `.${ext}`}`;
}

/**
 * Reverse of toFeatureFileName: `editor.f.d.txt` → `editor.d.txt`
 * @param {string} fileBasename
 * @param {string} noteExt
 * @returns {string | null}
 */
function fromFeatureFileName(fileBasename, noteExt) {
	const base = String(fileBasename || '').trim();
	const ext = String(noteExt || '').toLowerCase();
	if (!base || !ext) return null;
	if (!isDripFeatureFileName(base, [ext])) return null;
	const suffix = `${FEATURE_FILE_MARKER}${ext.startsWith('.') ? ext : `.${ext}`}`;
	const lower = base.toLowerCase();
	if (!lower.endsWith(suffix.toLowerCase())) return null;
	const stem = base.slice(0, -suffix.length);
	if (!stem) return null;
	return `${stem}${ext.startsWith('.') ? ext : `.${ext}`}`;
}

/**
 * Strip trailing `.p` / `.f` folder marker for “convert to normal”.
 * @param {string} folderBasename
 * @param {string} ext `.p` or `.f`
 * @returns {string | null}
 */
function stripFolderTypeExt(folderBasename, ext) {
	const name = String(folderBasename || '').trim();
	const e = String(ext || '').toLowerCase();
	if (!name || !e) return null;
	if (!name.toLowerCase().endsWith(e)) return null;
	const stem = name.slice(0, -e.length).trim();
	return stem || null;
}

/**
 * Set / replace the type marker on the first `#` heading line (h0).
 * @param {string} text
 * @param {string} typeMarker e.g. `.f`
 * @param {string} [fallbackTitle]
 * @returns {string}
 */
function applyH0TypeMarkerToNoteText(text, typeMarker, fallbackTitle) {
	const raw = String(text || '');
	const nl = raw.includes('\r\n') ? '\r\n' : '\n';
	const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
	const markerRaw = String(typeMarker || '').trim();
	const marker = !markerRaw || markerRaw === '.'
		? '.'
		: markerRaw.startsWith('.')
			? markerRaw
			: `.${markerRaw}`;

	let headingIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^#{1,6}\s+/.test(lines[i] || '')) {
			headingIdx = i;
			break;
		}
	}

	const fallback = String(fallbackTitle || 'Untitled').trim() || 'Untitled';
	if (headingIdx < 0) {
		const h0 = marker === '.' ? `# . ${fallback}` : `# ${marker} ${fallback}`;
		return `${raw.replace(/\s*$/, '')}${nl}${h0}${nl}`;
	}

	const line = lines[headingIdx] || '';
	const hm = line.match(/^(#{1,6})\s+(.*)$/);
	const hashes = hm ? hm[1] : '#';
	const original = hm ? String(hm[2] || '').trim() : '';
	let titleBody = '';
	if (original === '.') {
		titleBody = '';
	} else if (/^\.\s+/.test(original)) {
		titleBody = original.replace(/^\.\s+/, '').trim();
	} else {
		const typed = original.match(/^\.([A-Za-z][A-Za-z0-9_-]*)(?:\s+|$)(.*)$/);
		if (typed) {
			titleBody = String(typed[2] || '').trim();
		} else if (original.startsWith('.')) {
			titleBody = original.replace(/^\./, '').trim();
		} else {
			titleBody = original;
		}
	}
	if (!titleBody) titleBody = fallback;
	lines[headingIdx] = marker === '.' ? `${hashes} . ${titleBody}` : `${hashes} ${marker} ${titleBody}`;
	return lines.join(nl);
}

/**
 * Demote h0 from a typed heading (`.p` / `.f` / …) to bare `# . Title`,
 * and drop key-value lines that belong to that metadata type's attributes.
 * Tags / relations / special keys are kept.
 *
 * @param {string} text
 * @param {string} [fallbackTitle]
 * @returns {string}
 */
function demoteH0TypeToBarePersistent(text, fallbackTitle) {
	const { getMetadataSettings, matchHeadingTitleTypePrefix, HEADING_SPECIAL_KEYS } = require('./dripnoteMetadataTemplates');
	const { classifyMetaLine, isStructuredMetadataLine } = require('./persistentHeadingZones');
	const { parseHeadingForValidation } = require('../parse/dripnoteCanvasParse');

	const raw = String(text || '');
	const nl = raw.includes('\r\n') ? '\r\n' : '\n';
	const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
	const settings = getMetadataSettings();
	const fallback = String(fallbackTitle || 'Untitled').trim() || 'Untitled';

	let headingIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (parseHeadingForValidation(lines[i])) {
			headingIdx = i;
			break;
		}
	}
	if (headingIdx < 0) {
		return applyH0TypeMarkerToNoteText(raw, '.', fallback);
	}

	const line = lines[headingIdx] || '';
	const indent = (line.match(/^(\t*)/) || ['', ''])[1];
	const hm = line.match(/^(#{1,6})\s+(.*)$/);
	const hashes = hm ? hm[1] : '#';
	const original = hm ? String(hm[2] || '').trim() : '';
	const matched = matchHeadingTitleTypePrefix(original, settings);
	const typeId = matched.typeId ? String(matched.typeId).trim().toLowerCase() : '';
	const typeDef =
		(typeId && settings.typeById && settings.typeById.get(typeId)) ||
		(settings.types || []).find(t => String(t.id || '').toLowerCase() === typeId) ||
		null;

	/** @type {Set<string>} */
	const attrKeys = new Set();
	if (typeDef && typeDef.attributes && typeof typeDef.attributes === 'object') {
		for (const k of Object.keys(typeDef.attributes)) {
			attrKeys.add(String(k || '').toLowerCase());
		}
	}

	/** Markers/shortcuts to drop if they appear as standalone type lines under h0. */
	const typeMarkers = new Set();
	if (typeDef) {
		const marker = String(typeDef.marker || '').trim().toLowerCase();
		const sc = String(typeDef.shortcut || '').trim().toLowerCase();
		if (marker) typeMarkers.add(marker.startsWith('.') ? marker : `.${marker}`);
		if (sc) typeMarkers.add(sc.startsWith('.') ? sc : `.${sc}`);
	}
	if (matched.matchedPrefix) {
		typeMarkers.add(String(matched.matchedPrefix).toLowerCase());
	}

	let titleBody = '';
	if (original === '.') {
		titleBody = '';
	} else if (/^\.\s+/.test(original)) {
		titleBody = original.replace(/^\.\s+/, '').trim();
	} else {
		const typed = original.match(/^\.([A-Za-z][A-Za-z0-9_-]*)(?:\s+|$)(.*)$/);
		if (typed) {
			titleBody = String(typed[2] || '').trim();
		} else if (original.startsWith('.')) {
			titleBody = original.replace(/^\./, '').trim();
		} else {
			titleBody = original;
		}
	}
	if (!titleBody) titleBody = fallback;
	lines[headingIdx] = `${indent}${hashes} . ${titleBody}`;

	// Drop type-owned attribute kv lines (and matching `.type` marker lines) under h0.
	const keep = [];
	let i = 0;
	while (i < lines.length) {
		if (i !== headingIdx) {
			keep.push(lines[i]);
			i += 1;
			continue;
		}
		keep.push(lines[i]);
		i += 1;
		// Keep leading blanks / comments under the heading.
		while (i < lines.length) {
			const rawLine = lines[i] || '';
			const tr = rawLine.trim();
			if (!tr || tr.startsWith('//')) {
				keep.push(rawLine);
				i += 1;
				continue;
			}
			break;
		}
		// Contiguous structured meta: drop type-owned keys; keep tags/relations/other.
		while (i < lines.length) {
			const rawLine = lines[i] || '';
			const tr = rawLine.trim();
			if (parseHeadingForValidation(rawLine)) break;
			if (/^\s*@+/.test(rawLine)) break;
			if (!tr) break;
			if (tr.startsWith('//')) {
				keep.push(rawLine);
				i += 1;
				continue;
			}
			if (!isStructuredMetadataLine(rawLine)) break;

			const c = classifyMetaLine(rawLine);
			let drop = false;
			if (c.kind === 'type' && c.value) {
				const v = String(c.value || '').trim().toLowerCase();
				const dotted = v.startsWith('.') ? v : `.${v}`;
				if (typeMarkers.has(v) || typeMarkers.has(dotted)) {
					drop = true;
				}
			} else if (c.kind === 'kv' && c.key) {
				const key = String(c.key || '').toLowerCase();
				if (!HEADING_SPECIAL_KEYS.has(key) && attrKeys.has(key)) {
					drop = true;
				}
			}
			if (!drop) keep.push(rawLine);
			i += 1;
		}
	}

	return keep.join(nl);
}

module.exports = {
	FEATURE_FOLDER_EXT,
	FEATURE_FILE_MARKER,
	isDripFeatureFolderName,
	featureDisplayNameFromFolderName,
	featureIndexFileName,
	isDripFeatureFileName,
	toFeatureFileName,
	fromFeatureFileName,
	stripFolderTypeExt,
	applyH0TypeMarkerToNoteText,
	demoteH0TypeToBarePersistent,
	sanitizeFeatureIndexStem
};
