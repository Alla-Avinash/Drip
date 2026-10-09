 'use strict';

const vscode = require('vscode');
const path = require('path');
const { isProtectedFolderIndexNotePath } = require('./dripProjectFolder');

const DEFAULT_METADATA_TYPES = [
	{
		id: 'concept',
		marker: '.concept',
		shortcut: 'c',
		color: '',
		attributes: {
			domain: { kind: 'enum', values: [], default: '' },
			status: { kind: 'enum', values: ['in-progress', 'to-do'], default: '' }
		}
	},
	{
		id: 'task',
		marker: '.task',
		shortcut: 't',
		color: '',
		attributes: {
			status: { kind: 'enum', values: ['in-progress', 'to-do'], default: '' },
			priority: { kind: 'enum', values: ['high', 'low'], default: '' },
			deadline: { kind: 'datetime', default: '' },
			category: { kind: 'enum', values: [], default: '' }
		}
	},
	{
		id: 'issue',
		marker: '.issue',
		shortcut: 'i',
		color: '',
		attributes: {
			status: { kind: 'enum', values: ['in-progress', 'to-do', 'completed'], default: '' },
			priority: { kind: 'enum', values: ['high', 'medium', 'low'], default: '' },
			deadline: { kind: 'datetime', default: '' },
			category: { kind: 'enum', values: [], default: '' },
			/**
			 * Logical parent for Project View (`i-N`). Distinct from outline indent.
			 * Auto-stamped when nesting under an issue; set manually to override.
			 */
			parent: {
				kind: 'issue_parent',
				default: '',
				required: false,
				label: 'Parent issue',
				placeholder: 'i-N'
			}
		}
	}
];

/** Special metadata types (project / feature folder index notes). */
const DEFAULT_FILE_LEVEL_METADATA_TYPES = [
	{
		id: 'project',
		marker: '.project',
		shortcut: 'p',
		color: '',
		attributes: {
			status: { kind: 'enum', values: ['in-progress', 'to-do'], default: '' },
			priority: { kind: 'enum', values: ['high', 'low'], default: '' },
			deadline: { kind: 'datetime', default: '' }
		}
	},
	{
		id: 'feature',
		marker: '.feature',
		shortcut: 'f',
		color: '',
		attributes: {
			category: { kind: 'enum', values: [], default: '' }
		}
	}
];

/** @deprecated alias — prefer SPECIAL_METADATA_TYPE_IDS */
const FILE_LEVEL_METADATA_TYPE_IDS = new Set(
	DEFAULT_FILE_LEVEL_METADATA_TYPES.map(t => String(t.id || '').toLowerCase())
);
const SPECIAL_METADATA_TYPE_IDS = FILE_LEVEL_METADATA_TYPE_IDS;
/** Defaults export alias for settings UI. */
const DEFAULT_SPECIAL_METADATA_TYPES = DEFAULT_FILE_LEVEL_METADATA_TYPES;

const DEFAULT_TAG_RELATIONS = {
	allowed: ['tags', 'pre-req']
};

const { DEFAULT_DURATION_UNITS } = require('../parse/dripnoteDuration');

const METADATA_ATTRIBUTE_KINDS = ['enum', 'datetime', 'duration'];

const FIXED_DURATION_UNITS = DEFAULT_DURATION_UNITS.slice();

/**
 * @param {string} kind
 * @returns {'enum' | 'datetime' | 'duration'}
 */
function normalizeAttributeKind(kind) {
	const k = String(kind || '').trim().toLowerCase();
	if (k === 'free' || k === 'range') return 'enum';
	if (METADATA_ATTRIBUTE_KINDS.includes(k)) return /** @type {'enum' | 'datetime' | 'duration'} */ (k);
	return 'enum';
}

function deepClone(v) {
	return JSON.parse(JSON.stringify(v));
}

function asStringArray(v) {
	return (Array.isArray(v) ? v : [])
		.map(x => String(x || '').trim())
		.filter(Boolean);
}

/**
 * Metadata heading shortcut as stored in settings (trim only).
 * @param {string} raw
 * @returns {string}
 */
function normalizeMetadataShortcut(raw) {
	return String(raw || '').trim();
}

/**
 * @param {string} shortcut
 * @returns {string}
 */
function formatMetadataShortcutDisplay(shortcut) {
	const s = normalizeMetadataShortcut(shortcut);
	if (!s) return '';
	return s.startsWith('.') ? s : `.${s}`;
}

/** Product-fixed issue attribute; re-added even when KB settings omit it. */
const ISSUE_PARENT_ATTRIBUTE_RULE = Object.freeze({
	kind: 'issue_parent',
	values: [],
	default: '',
	required: false,
	label: 'Parent issue',
	placeholder: 'i-N'
});

function normalizeMetadataType(raw) {
	const id = String(raw && raw.id ? raw.id : '').trim().toLowerCase();
	if (!id) return null;
	const markerRaw = String(raw && raw.marker ? raw.marker : `.${id}`).trim();
	const marker = markerRaw.startsWith('.') ? markerRaw.toLowerCase() : `.${markerRaw.toLowerCase()}`;
	const shortcut = normalizeMetadataShortcut(raw && raw.shortcut);
	const color = String(raw && raw.color ? raw.color : '').trim();
	const attrsRaw = raw && raw.attributes && typeof raw.attributes === 'object' ? raw.attributes : {};
	/** @type {Record<string, any>} */
	const attributes = {};
	for (const k of Object.keys(attrsRaw)) {
		const key = String(k || '').trim().toLowerCase();
		if (!key) continue;
		if (id === 'issue' && key === 'parent') continue;
		const rule = attrsRaw[k] || {};
		const normalizedKind = normalizeAttributeKind(rule.kind);
		const unitValues =
			normalizedKind === 'enum'
				? asStringArray(rule.values).map(x => x.toLowerCase())
				: [];
		attributes[key] = {
			kind: normalizedKind,
			values: unitValues,
			default: String(rule.default != null ? rule.default : '').trim(),
			required: Boolean(rule.required)
		};
	}
	if (id === 'issue') {
		attributes.parent = { ...ISSUE_PARENT_ATTRIBUTE_RULE, values: [] };
	}
	return { id, marker, shortcut, color, displayTemplate: raw && raw.displayTemplate !== false, attributes };
}

function getMetadataSettings() {
	const c = vscode.workspace.getConfiguration('drip');
	const useTemplates = c.get('metadataTemplatesEnabled', true);
	const strictValidation = c.get('metadataStrictValidation', true);
	const ignoreErrors = c.get('metadataIgnoreErrors', false);
	const autoInsertTemplate = c.get('metadataAutoInsertTemplate', false);
	const showIndentErrors = c.get('metadataShowIndentErrors', false);
	const useCustomColors = c.get('metadataUseCustomColors', false);
	const metadataKeyColor = String(c.get('metadataKeyColor', '') || '').trim();
	const metadataValueColor = String(c.get('metadataValueColor', '') || '').trim();
	const rawTypes = c.get('metadataTypes', []);
	const normalized = [];
	for (const item of Array.isArray(rawTypes) ? rawTypes : []) {
		const t = normalizeMetadataType(item);
		if (!t) continue;
		// Project/feature are special types only — never document heading types.
		if (SPECIAL_METADATA_TYPE_IDS.has(t.id)) continue;
		// Product: decision removed — ignore if still present in old settings.
		if (t.id === 'decision' || t.id === 'implementation') continue;
		normalized.push(t);
	}
	const types = normalized.length ? normalized : deepClone(DEFAULT_METADATA_TYPES);
	const mapById = new Map();
	const mapByMarker = new Map();
	const mapByShortcut = new Map();
	for (const t of types) {
		mapById.set(t.id, t);
		mapByMarker.set(t.marker.toLowerCase(), t);
		if (t.shortcut) {
			mapByShortcut.set(t.shortcut, t);
			if (!t.shortcut.startsWith('.')) {
				mapByShortcut.set(`.${t.shortcut}`, t);
			}
		}
	}
	const relationsCfg = c.get('tagsRelationsConfig', DEFAULT_TAG_RELATIONS);
	const allowedFromArray = asStringArray(relationsCfg && relationsCfg.allowed ? relationsCfg.allowed : []);
	const allowedFromRows = Array.isArray(relationsCfg && relationsCfg.relations)
		? relationsCfg.relations
				.map(r => String((r && r.name) || '').trim().toLowerCase())
				.filter(Boolean)
		: [];
	const allowedRelations = new Set([...allowedFromArray, ...allowedFromRows]);
	if (!allowedRelations.size) {
		allowedRelations.add('tags');
		allowedRelations.add('pre-req');
	}
	return {
		useTemplates,
		strictValidation,
		ignoreErrors,
		autoInsertTemplate,
		showIndentErrors,
		useCustomColors,
		metadataKeyColor,
		metadataValueColor,
		types,
		typeById: mapById,
		typeByMarker: mapByMarker,
		typeByShortcut: mapByShortcut,
		defaultTypeId: '',
		allowedRelations
	};
}

/**
 * Ensure project/feature keep structural shortcuts `.p` / `.f` for index-note h0.
 * @param {object} t
 * @returns {object}
 */
function withSpecialTypeShortcut(t) {
	if (!t || !t.id) return t;
	const id = String(t.id).toLowerCase();
	const sc = normalizeMetadataShortcut(t.shortcut);
	if (id === 'project' && (!sc || sc === '.' || sc === 'project' || sc === '.project')) {
		return { ...t, shortcut: 'p' };
	}
	if (id === 'feature' && (!sc || sc === '.' || sc === 'feature' || sc === '.feature')) {
		return { ...t, shortcut: 'f' };
	}
	return t;
}

/**
 * Build type lookup maps from a types array.
 * @param {object[]} types
 */
function buildTypeMaps(types) {
	const mapById = new Map();
	const mapByMarker = new Map();
	const mapByShortcut = new Map();
	for (const t of types || []) {
		mapById.set(t.id, t);
		mapByMarker.set(String(t.marker || '').toLowerCase(), t);
		if (t.shortcut) {
			mapByShortcut.set(t.shortcut, t);
			if (!String(t.shortcut).startsWith('.')) {
				mapByShortcut.set(`.${t.shortcut}`, t);
			}
		}
	}
	return { typeById: mapById, typeByMarker: mapByMarker, typeByShortcut: mapByShortcut };
}

/**
 * Special metadata types (project / feature folder index notes).
 * @returns {{ types: object[], typeById: Map<string, object> }}
 */
function getFileLevelMetadataSettings() {
	const c = vscode.workspace.getConfiguration('drip');
	const rawTypes = c.get('fileLevelMetadataTypes', []);
	const normalized = [];
	for (const item of Array.isArray(rawTypes) ? rawTypes : []) {
		const t = normalizeMetadataType(item);
		if (t && SPECIAL_METADATA_TYPE_IDS.has(t.id)) {
			normalized.push(withSpecialTypeShortcut(t));
		}
	}
	// Migrate: pull project/feature still sitting in document metadataTypes.
	if (!normalized.length) {
		const docRaw = c.get('metadataTypes', []);
		for (const item of Array.isArray(docRaw) ? docRaw : []) {
			const t = normalizeMetadataType(item);
			if (t && SPECIAL_METADATA_TYPE_IDS.has(t.id)) {
				normalized.push(withSpecialTypeShortcut(t));
			}
		}
	}
	const types = (normalized.length ? normalized : deepClone(DEFAULT_FILE_LEVEL_METADATA_TYPES)).map(
		withSpecialTypeShortcut
	);
	const { typeById } = buildTypeMaps(types);
	return { types, typeById };
}

/** @returns {{ types: object[], typeById: Map<string, object> }} */
function getSpecialMetadataSettings() {
	return getFileLevelMetadataSettings();
}

/**
 * Settings used when classifying headings for index.drip (document types + special project/feature).
 * @returns {ReturnType<typeof getMetadataSettings>}
 */
function getMetadataSettingsForIndex() {
	const doc = getMetadataSettings();
	const special = getSpecialMetadataSettings();
	const types = [...(doc.types || []), ...(special.types || [])];
	const maps = buildTypeMaps(types);
	return {
		...doc,
		types,
		typeById: maps.typeById,
		typeByMarker: maps.typeByMarker,
		typeByShortcut: maps.typeByShortcut
	};
}

/**
 * Locked special type for a project/feature index note path, or null.
 * @param {string} fsPath
 * @returns {'project' | 'feature' | null}
 */
function lockedSpecialTypeIdForPath(fsPath) {
	if (!isProtectedFolderIndexNotePath(fsPath)) return null;
	const base = path.basename(String(fsPath || '')).toLowerCase();
	if (/\.p\.d\.txt$/i.test(base)) return 'project';
	if (/\.f\.d\.txt$/i.test(base)) return 'feature';
	return null;
}

/**
 * Metadata settings for parsing/editing headings in a specific note.
 * Index notes (`_*.p.d.txt` / `_*.f.d.txt`): only the matching special type (project/feature).
 *
 * @param {string} [fsPath]
 * @returns {ReturnType<typeof getMetadataSettings> & { specialIndex: boolean, lockedTypeId: string | null }}
 */
function getMetadataSettingsForNotePath(fsPath) {
	const docSettings = getMetadataSettings();
	const lockedTypeId = lockedSpecialTypeIdForPath(fsPath);
	if (!lockedTypeId) {
		return { ...docSettings, specialIndex: false, lockedTypeId: null };
	}
	const special = getSpecialMetadataSettings();
	const types = (special.types || [])
		.filter(t => String(t.id || '').toLowerCase() === lockedTypeId)
		.map(withSpecialTypeShortcut);
	const maps = buildTypeMaps(types);
	return {
		...docSettings,
		types,
		typeById: maps.typeById,
		typeByMarker: maps.typeByMarker,
		typeByShortcut: maps.typeByShortcut,
		specialIndex: true,
		lockedTypeId
	};
}

/**
 * One-shot: move project/feature out of metadataTypes into fileLevelMetadataTypes if needed.
 * @returns {Promise<boolean>} true if settings were written
 */
async function migrateFileLevelMetadataTypesIfNeeded() {
	const c = vscode.workspace.getConfiguration('drip');
	const docRaw = Array.isArray(c.get('metadataTypes', [])) ? c.get('metadataTypes', []) : [];
	const fileRaw = Array.isArray(c.get('fileLevelMetadataTypes', []))
		? c.get('fileLevelMetadataTypes', [])
		: [];
	const moved = [];
	const keptDoc = [];
	for (const item of docRaw) {
		const t = normalizeMetadataType(item);
		if (t && SPECIAL_METADATA_TYPE_IDS.has(t.id)) {
			moved.push(item);
		} else {
			keptDoc.push(item);
		}
	}
	if (!moved.length && fileRaw.length) {
		return false;
	}
	if (!moved.length && !fileRaw.length) {
		// Seed special-type defaults when empty.
		await c.update(
			'fileLevelMetadataTypes',
			deepClone(DEFAULT_FILE_LEVEL_METADATA_TYPES),
			vscode.ConfigurationTarget.Workspace
		);
		return true;
	}
	if (moved.length) {
		const existingIds = new Set(
			fileRaw.map(x => String((x && x.id) || '').toLowerCase()).filter(Boolean)
		);
		const mergedFile = fileRaw.slice();
		for (const item of moved) {
			const id = String((item && item.id) || '').toLowerCase();
			if (id && !existingIds.has(id)) {
				const t = normalizeMetadataType(item);
				mergedFile.push(t ? withSpecialTypeShortcut(t) : item);
				existingIds.add(id);
			}
		}
		await c.update('metadataTypes', keptDoc, vscode.ConfigurationTarget.Workspace);
		await c.update('fileLevelMetadataTypes', mergedFile, vscode.ConfigurationTarget.Workspace);
		return true;
	}
	return false;
}

/**
 * Heading-adjacent special keys (not type attributes). None by default — task workflow
 * (`workflow:`) and task `parent: [tN,…]` were removed; issue `parent: i-N` is a type
 * attribute (after `.issue`), not a special key.
 */
const HEADING_SPECIAL_KEYS = new Set([]);

/**
 * Resolve a type from the shortcut map, accepting dotted or plain keys.
 * @param {{ typeByShortcut?: Map<string, any> }} settings
 * @param {string} body shortcut body without a leading dot (e.g. `c`)
 * @returns {any | undefined}
 */
function lookupShortcutType(settings, body) {
	const map = settings && settings.typeByShortcut;
	if (!map || typeof map.get !== 'function') return undefined;
	const key = String(body || '');
	if (!key) return undefined;
	return map.get(key) || map.get(`.${key}`) || map.get(normalizeMetadataShortcut(key));
}

/**
 * Parse `.shortcut`, `.shortcut12`, or invalid `.shortcutX…` at the start of a heading title.
 * @param {string} titleOrHeading title text or full `# …` line
 * @param {{ types?: any[], typeByMarker?: Map<string, any>, typeByShortcut?: Map<string, any> }} settings
 * @returns {{ typeId: string, matchedPrefix: string, form: 'marker'|'exact'|'numeric'|'invalid'|'', taskId: number|null, invalid: boolean }}
 */
function matchHeadingTitleTypePrefix(titleOrHeading, settings) {
	const raw = String(titleOrHeading || '').trim();
	const title = raw.replace(/^#{1,6}\s+/, '').trim();
	const m = title.match(/^(\.([A-Za-z][A-Za-z0-9_-]*))/);
	if (!m) {
		return { typeId: '', matchedPrefix: '', form: '', taskId: null, invalid: false };
	}
	const matchedPrefix = m[1];
	const body = String(m[2] || '');
	const byMarker = settings.typeByMarker && settings.typeByMarker.get(`.${body.toLowerCase()}`);
	if (byMarker) {
		return { typeId: byMarker.id, matchedPrefix, form: 'marker', taskId: null, invalid: false };
	}
	// Shortcuts may be stored with or without a leading dot; match body as-is (case-sensitive).
	const byExact = lookupShortcutType(settings, body);
	if (byExact) {
		return { typeId: byExact.id, matchedPrefix, form: 'exact', taskId: null, invalid: false };
	}
	const num = body.match(/^([A-Za-z]+)(\d+)$/);
	if (num) {
		const byNum = lookupShortcutType(settings, String(num[1] || ''));
		if (byNum) {
			const taskId = parseInt(num[2], 10);
			return {
				typeId: byNum.id,
				matchedPrefix,
				form: 'numeric',
				taskId: Number.isFinite(taskId) && taskId > 0 ? taskId : null,
				invalid: false
			};
		}
	}
	// Issue (and similar): `.i-34` — hyphen + digits on the shortcut
	const hyphenNum = body.match(/^([A-Za-z]+)-(\d+)$/);
	if (hyphenNum) {
		const byHyphen = lookupShortcutType(settings, String(hyphenNum[1] || ''));
		if (byHyphen) {
			const taskId = parseInt(hyphenNum[2], 10);
			return {
				typeId: byHyphen.id,
				matchedPrefix,
				form: 'numeric',
				taskId: Number.isFinite(taskId) && taskId > 0 ? taskId : null,
				invalid: false
			};
		}
	}
	for (const t of settings.types || []) {
		const sc = normalizeMetadataShortcut(t.shortcut);
		if (!sc) continue;
		if (!body.toLowerCase().startsWith(sc.toLowerCase())) continue;
		const rest = body.slice(sc.length);
		if (!rest || /^\d+$/.test(rest)) continue;
		return { typeId: t.id, matchedPrefix, form: 'invalid', taskId: null, invalid: true };
	}
	return { typeId: '', matchedPrefix: '', form: '', taskId: null, invalid: false };
}

function inferTypeFromHeadingLine(line, settings) {
	return matchHeadingTitleTypePrefix(line, settings).typeId || '';
}

function inferTypeFromMarkerLine(line, settings) {
	const s = String(line || '').trim();
	const m = s.match(/^(\.[a-z][a-z0-9_-]*)\b/i);
	if (!m) return '';
	const t = settings.typeByMarker.get(String(m[1] || '').toLowerCase());
	return t ? t.id : '';
}

function getTypeRule(settings, typeId, key) {
	const t = settings.typeById.get(String(typeId || '').toLowerCase());
	if (!t) return null;
	return t.attributes[String(key || '').toLowerCase()] || null;
}

function toMinuteDateTimeString(date) {
	const yyyy = date.getFullYear();
	const mm = String(date.getMonth() + 1).padStart(2, '0');
	const dd = String(date.getDate()).padStart(2, '0');
	const hh = String(date.getHours()).padStart(2, '0');
	const mi = String(date.getMinutes()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function parseRelativeDateTimeInput(input, nowDate) {
	const s = String(input || '').trim().toLowerCase();
	if (!s) return null;
	const absolute = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
	if (absolute) {
		const d = new Date(
			Number(absolute[1]),
			Number(absolute[2]) - 1,
			Number(absolute[3]),
			Number(absolute[4]),
			Number(absolute[5]),
			0,
			0
		);
		if (!Number.isNaN(d.getTime())) return d;
	}
	const rel = s.match(/^(\d+)\s*(min|mins|minute|minutes|hr|hrs|hour|hours|day|days|month|months)$/i);
	if (!rel) return null;
	const count = Number(rel[1]);
	if (!Number.isFinite(count) || count <= 0) return null;
	const unit = String(rel[2] || '').toLowerCase();
	const d = nowDate ? new Date(nowDate.getTime()) : new Date();
	if (unit.startsWith('min')) d.setMinutes(d.getMinutes() + count);
	else if (unit.startsWith('h')) d.setHours(d.getHours() + count);
	else if (unit.startsWith('day')) d.setDate(d.getDate() + count);
	else if (unit.startsWith('month')) d.setMonth(d.getMonth() + count);
	d.setSeconds(0, 0);
	return d;
}

function toCompactType(def) {
	return {
		id: def.id,
		marker: def.marker,
		shortcuts: def.shortcut ? [def.shortcut] : [],
		displayTemplate: def.displayTemplate !== false,
		attributes: Object.keys(def.attributes || {}).map(k => {
			const a = def.attributes[k] || {};
			return {
				key: k,
				type: a.kind || 'enum',
				values: Array.isArray(a.values) ? a.values : [],
				default: String(a.default || ''),
				required: Boolean(a.required)
			};
		})
	};
}

function getMetadataTemplateConfig() {
	const s = getMetadataSettings();
	const types = s.types.map(toCompactType);
	const byId = new Map(types.map(t => [t.id, t]));
	const byMarker = new Map(types.map(t => [String(t.marker || '').toLowerCase(), t]));
	const byShortcut = new Map();
	for (const t of types) {
		for (const sc of Array.isArray(t.shortcuts) ? t.shortcuts : []) {
			const key = normalizeMetadataShortcut(sc);
			if (key) byShortcut.set(key, t);
		}
	}
	return {
		enabled: s.useTemplates,
		types,
		byId,
		byMarker,
		byShortcut,
		defaultTypeId: s.defaultTypeId || '',
		strictValidation: s.strictValidation,
		ignoreErrors: s.ignoreErrors,
		autoInsertTemplate: s.autoInsertTemplate,
		showIndentErrors: s.showIndentErrors,
		allowedRelations: s.allowedRelations
	};
}

function resolveTypeFromMarkerOrHeading(typeLineOrHeadingText, cfg) {
	const text = String(typeLineOrHeadingText || '').trim();
	if (!text) return cfg.defaultTypeId ? cfg.byId.get(cfg.defaultTypeId) || null : null;
	const settings = {
		types: (cfg.types || []).map(t => ({
			id: t.id,
			shortcut: Array.isArray(t.shortcuts) && t.shortcuts[0] ? t.shortcuts[0] : '',
			marker: t.marker
		})),
		typeByMarker: cfg.byMarker,
		typeByShortcut: cfg.byShortcut
	};
	const headingMatched = matchHeadingTitleTypePrefix(text, settings);
	if (headingMatched.typeId) return cfg.byId.get(headingMatched.typeId) || null;
	const markerMatch = text.match(/^\.([a-z][a-z0-9_-]*)\b/i);
	if (markerMatch) {
		const marker = `.${String(markerMatch[1] || '').toLowerCase()}`;
		return (
			cfg.byMarker.get(marker) ||
			cfg.byShortcut.get(normalizeMetadataShortcut(markerMatch[1])) ||
			(cfg.defaultTypeId ? cfg.byId.get(cfg.defaultTypeId) || null : null)
		);
	}
	return cfg.defaultTypeId ? cfg.byId.get(cfg.defaultTypeId) || null : null;
}

module.exports = {
	DEFAULT_METADATA_TYPES,
	DEFAULT_FILE_LEVEL_METADATA_TYPES,
	DEFAULT_SPECIAL_METADATA_TYPES,
	FILE_LEVEL_METADATA_TYPE_IDS,
	SPECIAL_METADATA_TYPE_IDS,
	DEFAULT_TAG_RELATIONS,
	DEFAULT_TAGS_RELATIONS: { allowedRelations: DEFAULT_TAG_RELATIONS.allowed.slice(), defaultRelation: 'tags' },
	METADATA_ATTRIBUTE_KINDS,
	FIXED_DURATION_UNITS,
	HEADING_SPECIAL_KEYS,
	normalizeAttributeKind,
	normalizeMetadataShortcut,
	formatMetadataShortcutDisplay,
	matchHeadingTitleTypePrefix,
	getMetadataTemplateConfig,
	resolveTypeFromMarkerOrHeading,
	getMetadataSettings,
	getFileLevelMetadataSettings,
	getSpecialMetadataSettings,
	getMetadataSettingsForIndex,
	getMetadataSettingsForNotePath,
	lockedSpecialTypeIdForPath,
	migrateFileLevelMetadataTypesIfNeeded,
	inferTypeFromHeadingLine,
	inferTypeFromMarkerLine,
	getTypeRule,
	parseRelativeDateTimeInput,
	toMinuteDateTimeString,
	deepClone
};

