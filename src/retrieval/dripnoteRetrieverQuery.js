'use strict';

const path = require('path');
const vscode = require('vscode');
const { forEachKnowledgeBaseNote } = require('../document/kbNoteOps');
const { parseNoteForCanvas, inferMarkerFromMeta, ancestorChain } = require('../document/parse/dripnoteCanvasParse');
const { getMetadataSettings } = require('../document/model/dripnoteMetadataTemplates');
const { extractFileIdFromHeader } = require('../graph/dripnoteReferenceSync');

const INDEX_STEM = '_index';

/**
 * @typedef {object} RetrieverRow Serializable heading row for the Retriever UI.
 * @property {string} id
 * @property {string} uri
 * @property {string} relPath
 * @property {number} line 1-based
 * @property {string} title
 * @property {string[]} breadcrumbs
 * @property {string} typeId lowercase template id from marker mapping
 * @property {string} marker e.g. ".task"
 * @property {string[]} tags lowercase union of file + heading tags
 * @property {Record<string,string>} headingKv
 * @property {Record<string,string>} fileKv
 * @property {boolean} validHeading
 * @property {number} tabDepth
 * @property {number} level
 * @property {number} mtime ms
 * @property {string} fileId from note identity header (for L. links)
 */

/**
 * @typedef {{ id: string, label: string, marker: string }} RetrieverTypeInfo
 */

/**
 * @param {string[]} lines
 */
function parseMetaSlice(lines) {
	const kv = /** @type {Record<string, string>} */ ({});
	const tags = /** @type {string[]} */ ([]);
	for (const rawLine of lines || []) {
		const line = String(rawLine || '');
		const t = line.trim();
		if (!t) continue;
		if (/^\s*\/\//.test(line)) continue;
		if (/^\s*\./.test(line)) continue;
		const br = t.match(/^\[([^\]]*)\]\s*$/);
		if (br) {
			const parts = String(br[1] || '')
				.split(',')
				.map(x => x.trim())
				.filter(Boolean);
			for (const p of parts) tags.push(p.toLowerCase());
			continue;
		}
		const relM = t.match(/^(tags|pre-req)\s*:\s*\[([^\]]*)\]\s*$/i);
		if (relM) {
			const key = relM[1].toLowerCase();
			const parts = String(relM[2] || '')
				.split(',')
				.map(x => x.trim())
				.filter(Boolean);
			if (key === 'tags') {
				for (const p of parts) tags.push(p.toLowerCase());
			}
			kv[key] = parts.join(', ');
			continue;
		}
		const kvm = t.match(/^([a-z][a-z0-9_-]*)\s*:\s*(.+)$/i);
		if (kvm) {
			kv[kvm[1].toLowerCase()] = String(kvm[2] || '').trim();
		}
	}
	return { kv, tags: [...new Set(tags)] };
}

/**
 * @param {string} relativePath
 */
function isIndexerNotePath(relativePath) {
	const base = path.basename(String(relativePath || '').replace(/\\/g, '/')).toLowerCase();
	if (!base) return false;
	return base === '_index.d.txt' || base.startsWith(`${INDEX_STEM}.`);
}

function markerToTypeIdMap() {
	const s = getMetadataSettings();
	const m = new Map();
	for (const t of s.types || []) {
		const id = String(t.id || '').trim().toLowerCase();
		const marker = String(t.marker || '').trim().toLowerCase();
		if (marker && id) m.set(marker, id);
	}
	return m;
}

/**
 * @param {string} relPath
 * @returns {string}
 */
function folderKeyOf(relPath) {
	const s = String(relPath || '').replace(/\\/g, '/');
	const i = s.lastIndexOf('/');
	return i <= 0 ? '.' : s.slice(0, i);
}

/**
 * KB shell: template metadata types only — no note walk. Used until the first query that needs headings.
 * @param {import('vscode').Uri | undefined} kbRootUri
 * @param {{ usedWorkspaceFallback?: boolean }} [opts]
 */
function buildRetrieverCatalogShell(kbRootUri, opts) {
	const usedWsFallback = Boolean(opts && opts.usedWorkspaceFallback);
	const empty = () => ({
		rows: /** @type {import('./dripnoteRetrieverQuery').RetrieverRow[]} */ ([]),
		metadataTypes: /** @type {import('./dripnoteRetrieverQuery').RetrieverTypeInfo[]} */ ([]),
		allTags: /** @type {string[]} */ ([]),
		tagCounts: /** @type {{ tag: string, count: number }[]} */ ([]),
		kbMissing: false,
		noteFilesVisited: 0,
		kbRootPath: '',
		usedWorkspaceFallback: usedWsFallback
	});
	if (!kbRootUri) {
		const o = empty();
		o.kbMissing = true;
		return o;
	}
	const settingsTypes = getMetadataSettings().types || [];
	const metadataTypes = settingsTypes
		.map(t => ({
			id: String(t.id || '').trim().toLowerCase(),
			label: String(t.id || '').trim(),
			marker: String(t.marker || '').trim()
		}))
		.filter(t => t.id);
	const out = empty();
	out.metadataTypes = metadataTypes;
	out.kbRootPath = kbRootUri.fsPath.replace(/\\/g, '/');
	out.usedWorkspaceFallback = usedWsFallback;
	return out;
}

/**
 * @param {import('vscode').Uri | undefined} kbRootUri
 * @param {{ usedWorkspaceFallback?: boolean }} [opts]
 */
async function buildRetrieverIndex(kbRootUri, opts) {
	const usedWsFallback = Boolean(opts && opts.usedWorkspaceFallback);
	const empty = () => ({
		rows: /** @type {import('./dripnoteRetrieverQuery').RetrieverRow[]} */ ([]),
		metadataTypes: /** @type {import('./dripnoteRetrieverQuery').RetrieverTypeInfo[]} */ ([]),
		allTags: /** @type {string[]} */ ([]),
		tagCounts: /** @type {{ tag: string, count: number }[]} */ ([]),
		kbMissing: false,
		noteFilesVisited: 0,
		kbRootPath: '',
		usedWorkspaceFallback: false
	});

	if (!kbRootUri) {
		const o = empty();
		o.kbMissing = true;
		return o;
	}

	const markerMap = markerToTypeIdMap();
	const settingsTypes = getMetadataSettings().types || [];
	const metadataTypes = settingsTypes.map(t => ({
		id: String(t.id || '').trim().toLowerCase(),
		label: String(t.id || '').trim(),
		marker: String(t.marker || '').trim()
	}));

	/** @type {typeof empty extends () => infer R ? R : never} */
	const out = empty();
	const tagAccum = new Set();
	let noteFilesVisited = 0;

	await forEachKnowledgeBaseNote(
		kbRootUri,
		async note => {
			if (isIndexerNotePath(note.relativePath)) {
				return;
			}
			noteFilesVisited += 1;

			let mtime = 0;
			try {
				const st = await vscode.workspace.fs.stat(note.uri);
				mtime = st.mtime || 0;
			} catch {
				mtime = 0;
			}

			const { fileLines, flat } = parseNoteForCanvas(note.text);
			const fileId = extractFileIdFromHeader(note.text) || '';
			const fileParsed = parseMetaSlice(fileLines);
			const fileKv = fileParsed.kv;
			const fileTags = [...fileParsed.tags, ...extractTagsFromFileKvBracket(fileKv)];
			fileTags.forEach(t => tagAccum.add(t));

			const idxByLine = new Map(flat.map((n, i) => [n.lineIndex, i]));

			for (let fi = 0; fi < flat.length; fi++) {
				const h = flat[fi];
				const marker = inferMarkerFromMeta(h.metaLines).toLowerCase();
				let typeId = '';
				if (marker) {
					typeId = markerMap.get(marker) || '';
					if (!typeId) {
						const slug = marker.replace(/^\./, '').trim().toLowerCase();
						typeId = slug || marker;
					}
				}
				const headingParsed = parseMetaSlice(h.metaLines);
				const headingTags = headingParsed.tags;
				headingTags.forEach(t => tagAccum.add(t));

				const parentTitles = ancestorChain(flat, fi)
					.filter(n => n.valid !== false)
					.map(n => n.title);
				const breadcrumbs = [...parentTitles, h.title];

				const mergeTags = [...new Set([...fileTags, ...headingTags])];

				out.rows.push({
					id: `${note.relativePath.replace(/\\/g, '/')}:${h.lineIndex}`,
					uri: note.uri.toString(),
					relPath: note.relativePath.replace(/\\/g, '/'),
					line: h.lineIndex + 1,
					title: h.title,
					breadcrumbs,
					typeId,
					marker,
					tags: mergeTags,
					headingKv: headingParsed.kv,
					fileKv,
					validHeading: h.valid !== false,
					tabDepth: h.tabDepth,
					level: h.level,
					mtime,
					fileId
				});
			}

			idxByLine.clear();
		},
		{ yieldEvery: 18 }
	);

	out.metadataTypes = mergeRetrieverMetadataTypes(metadataTypes.filter(t => String(t.id || '').trim()), out.rows);
	out.allTags = [...tagAccum].sort((a, b) => a.localeCompare(b));
	out.kbRootPath = kbRootUri.fsPath.replace(/\\/g, '/');
	out.usedWorkspaceFallback = usedWsFallback;
	out.noteFilesVisited = noteFilesVisited;
	return out;
}

/**
 * Settings templates plus any typeId observed on headings so Retriever chips work without templates-only config.
 * @param {RetrieverTypeInfo[]} settingTypes from settings (may omit ids used only via inferred markers)
 * @param {RetrieverRow[]} rows indexed corpus
 */
function mergeRetrieverMetadataTypes(settingTypes, rows) {
	const byId = /** @type {Map<string, RetrieverTypeInfo>} */ (new Map());
	for (const t of settingTypes || []) {
		const id = String((t && t.id) || '')
			.trim()
			.toLowerCase();
		if (!id) continue;
		byId.set(id, {
			id,
			label: String((t && t.label) || id).trim() || id,
			marker: String((t && t.marker) || '').trim()
		});
	}
	for (const r of rows || []) {
		const id = String((r && r.typeId) || '')
			.trim()
			.toLowerCase();
		if (!id) continue;
		if (byId.has(id)) continue;
		const mk = String((r && r.marker) || '')
			.trim()
			.toLowerCase();
		const display = mk || id;
		byId.set(id, { id, label: display, marker: mk });
	}
	return [...byId.values()].sort((a, b) =>
		String(a.label || a.id).localeCompare(String(b.label || b.id))
	);
}

/**
 * Tags from file preamble may also appear as `tags: a, b` string (non-bracket).
 * @param {Record<string,string>} kv
 */
function extractTagsFromFileKvBracket(kv) {
	const raw = kv && kv.tags !== undefined ? String(kv.tags).trim() : '';
	if (!raw) return [];
	if (raw.includes('[')) return [];
	return raw.split(/[\s,]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
}

/**
 * Trim row for webview payload (smaller than full RetrieverRow).
 * @param {import('./dripnoteRetrieverQuery').RetrieverRow} r
 */
function toRetrieverWireRow(r) {
	return {
		id: r.id,
		uri: r.uri,
		line: r.line,
		title: r.title,
		breadcrumbs: r.breadcrumbs,
		typeId: r.typeId,
		marker: r.marker,
		tags: r.tags,
		validHeading: r.validHeading,
		relPath: r.relPath,
		mtime: r.mtime,
		fileId: r.fileId || ''
	};
}

/**
 * @param {string} q
 */
function normalizeHeadingQuery(q) {
	return String(q || '')
		.trim()
		.toLowerCase();
}

/**
 * @param {import('./dripnoteRetrieverQuery').RetrieverRow} row
 * @param {string} nq normalized query
 */
function rowMatchesHeadingQuery(row, nq) {
	if (!nq) return true;
	const hay = [...(row.breadcrumbs || []), row.title, String(row.relPath || '')]
		.join(' \n ')
		.toLowerCase();
	const tokens = nq.split(/\s+/).map(t => t.trim()).filter(Boolean);
	if (!tokens.length) return true;
	// Multi-word: every token must appear somewhere (title, breadcrumbs, or path).
	return tokens.every(t => hay.includes(t));
}

/**
 * @param {import('./dripnoteRetrieverQuery').RetrieverRow} a
 * @param {import('./dripnoteRetrieverQuery').RetrieverRow} b
 * @param {{ sortBy?: string, groupBy?: string }} opts
 */
function compareRetrieverRows(a, b, opts) {
	const sortBy = String(opts.sortBy || 'recent');
	const groupBy = String(opts.groupBy || 'none');
	const folder = /** @param {import('./dripnoteRetrieverQuery').RetrieverRow} r */ r =>
		folderKeyOf(r.relPath);
	if (groupBy === 'folder') {
		const c = folder(a).localeCompare(folder(b));
		if (c !== 0) return c;
	} else if (groupBy === 'type') {
		const ta = (a.typeId || '\uffff').toLowerCase();
		const tb = (b.typeId || '\uffff').toLowerCase();
		const c = ta.localeCompare(tb);
		if (c !== 0) return c;
	}
	if (sortBy === 'title') {
		return String(a.title).localeCompare(String(b.title));
	}
	if (sortBy === 'path') {
		const c = String(a.relPath).localeCompare(String(b.relPath));
		if (c !== 0) return c;
		return (a.line || 0) - (b.line || 0);
	}
	return (b.mtime || 0) - (a.mtime || 0);
}

/**
 * @param {import('./dripnoteRetrieverQuery').RetrieverRow[]} rows
 * @param {{ sortBy?: string, groupBy?: string }} opts
 */
function sortRetrieverRows(rows, opts) {
	return [...rows].sort((a, b) => compareRetrieverRows(a, b, opts));
}

/**
 * Higher = stronger match when user typed a non-empty search string.
 * @param {import('./dripnoteRetrieverQuery').RetrieverRow} row
 * @param {string} nq normalized lowercase query
 */
function headingSearchMatchScore(row, nq) {
	const title = String(row.title || '').toLowerCase();
	const crumbs = [...(row.breadcrumbs || []), row.title].join(' \n ').toLowerCase();
	const rel = String(row.relPath || '').toLowerCase();
	const tokens = nq.split(/\s+/).map(t => t.trim()).filter(Boolean);
	let score = 0;

	if (tokens.length <= 1) {
		const q = tokens[0] || nq;
		if (title.includes(q)) {
			score += 2000;
			score += Math.max(0, 500 - title.indexOf(q));
			if (title === q) score += 800;
			else if (title.startsWith(q)) score += 400;
		}
		if (!title.includes(q) && crumbs.includes(q)) {
			score += 700;
		}
		if (rel.includes(q)) {
			score += 300;
		}
		for (const t of tokens.length ? tokens : [q]) {
			if (t.length < 2) continue;
			if (title.includes(t)) score += 120;
			else if (crumbs.includes(t)) score += 40;
			else if (rel.includes(t)) score += 20;
		}
		return score;
	}

	for (const t of tokens) {
		if (title.includes(t)) {
			score += 500;
			score += Math.max(0, 200 - title.indexOf(t));
			if (title.startsWith(t)) score += 150;
		} else if (crumbs.includes(t)) {
			score += 220;
		} else if (rel.includes(t)) {
			score += 90;
		}
	}
	return score;
}

const DEFAULT_RETRIEVER_LIMIT = 500;
const MAX_RETRIEVER_PAGE = 800;

/**
 * Host-side catalog query: **only** the search box string (`q`) filters rows. Sort/group options still apply.
 * UI scope, type, tag, and metadata chips are ignored for matching and ranking.
 *
 * @param {import('./dripnoteRetrieverQuery').RetrieverRow[]} allRows
 * @param {{
 *   q?: string,
 *   sortBy?: string,
 *   groupBy?: string,
 *   limit?: number,
 *   offset?: number
 * }} query
 */
function queryRetrieverCatalog(allRows, query) {
	const nq = normalizeHeadingQuery(query.q);
	const sortBy = query.sortBy;
	const groupBy = query.groupBy;
	let limit = Number.isFinite(query.limit) && query.limit > 0 ? query.limit : DEFAULT_RETRIEVER_LIMIT;
	limit = Math.min(Math.max(limit, 1), MAX_RETRIEVER_PAGE);
	const offsetRaw = Number(query.offset);
	const offset =
		Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.min(Math.floor(offsetRaw), 10_000_000) : 0;

	const matched = (allRows || []).filter(r => rowMatchesHeadingQuery(r, nq));
	/** @type {import('./dripnoteRetrieverQuery').RetrieverRow[]} */
	let sorted;
	if (nq) {
		sorted = [...matched].sort((a, b) => {
			const sa = headingSearchMatchScore(a, nq);
			const sb = headingSearchMatchScore(b, nq);
			if (sa !== sb) return sb - sa;
			return compareRetrieverRows(a, b, { sortBy, groupBy });
		});
	} else {
		sorted = sortRetrieverRows(matched, { sortBy, groupBy });
	}
	const totalMatched = sorted.length;
	const rows = sorted.slice(offset, offset + limit);
	const loadedThrough = offset + rows.length;
	const truncated = loadedThrough < totalMatched;
	return {
		rows: rows.map(toRetrieverWireRow),
		truncated,
		totalMatched,
		offset,
		loadedThrough,
		pageSize: rows.length
	};
}

/**
 * Short list under the heading search bar (recent-first; only `q` affects matches).
 * @param {import('./dripnoteRetrieverQuery').RetrieverRow[]} allRows
 * @param {{ q?: string, limit?: number }} partial
 */
function peekRetrieverSuggestions(allRows, partial) {
	const limRaw = Number(partial && partial.limit);
	const limit =
		Number.isFinite(limRaw) && limRaw > 0 ? Math.min(Math.floor(limRaw), 48) : 24;
	return queryRetrieverCatalog(allRows || [], {
		q: partial && typeof partial.q === 'string' ? partial.q : '',
		sortBy: 'recent',
		groupBy: 'none',
		offset: 0,
		limit
	}).rows;
}

module.exports = {
	buildRetrieverIndex,
	buildRetrieverCatalogShell,
	isIndexerNotePath,
	parseMetaSlice,
	queryRetrieverCatalog,
	peekRetrieverSuggestions,
	sortRetrieverRows,
	compareRetrieverRows,
	toRetrieverWireRow
};
