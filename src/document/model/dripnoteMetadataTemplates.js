 'use strict';

const vscode = require('vscode');

const DEFAULT_METADATA_TYPES = [
	{
		id: 'concept',
		marker: '.concept',
		shortcut: 'c',
		color: '',
		attributes: {
			difficulty: { kind: 'enum', values: ['hard', 'medium', 'easy'], default: '' },
			status: { kind: 'enum', values: ['in-progress', 'to-do'], default: '' },
			priority: { kind: 'enum', values: ['high', 'low'], default: '' },
			deadline: { kind: 'datetime', default: '' }
		}
	},
	{
		id: 'task',
		marker: '.task',
		shortcut: 't',
		color: '',
		attributes: {
			difficulty: { kind: 'enum', values: ['hard', 'medium', 'easy'], default: '' },
			status: { kind: 'enum', values: ['in-progress', 'to-do'], default: '' },
			priority: { kind: 'enum', values: ['high', 'low'], default: '' },
			deadline: { kind: 'datetime', default: '' }
		}
	},
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
		id: 'implementation',
		marker: '.implementation',
		shortcut: 'impl',
		color: '',
		attributes: {
			implemented: { kind: 'enum', values: ['true', 'false'], default: '' }
		}
	},
	{
		id: 'issue',
		marker: '.issue',
		shortcut: 'i',
		color: '',
		attributes: {
			priority: { kind: 'enum', values: ['high', 'medium', 'low'], default: '' },
			status: { kind: 'enum', values: ['in-progress', 'to-do', 'completed'], default: '' }
		}
	}
];

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
		if (t) normalized.push(t);
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
 * Heading-adjacent special keys (not type attributes): must sit under the heading before `.type`.
 * `workflow: true|false` marks a task as a workflow root; `parent: [tN,…]` links DAG deps.
 */
const HEADING_SPECIAL_KEYS = new Set(['workflow', 'parent']);

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
	inferTypeFromHeadingLine,
	inferTypeFromMarkerLine,
	getTypeRule,
	parseRelativeDateTimeInput,
	toMinuteDateTimeString,
	deepClone
};

