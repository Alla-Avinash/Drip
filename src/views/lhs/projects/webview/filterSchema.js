// @ts-check
/**
 * Reusable filter / group / sort engine for DRIP Project View.
 *
 * One engine drives both project-level and issue-level browsing; only the
 * field list differs. This mirrors the RHS Storage UI idea: a single
 * standard reused across views, with options that vary by entity kind.
 *
 * Enum values are NOT hardcoded here — they arrive from the extension host,
 * which reads them live from DRIP settings (`.project` / `.issue` templates).
 * Loaded before projectView.js; exposes `window.DripFilter`.
 */
(function () {
	'use strict';

	// ---- Field kinds -----------------------------------------------------
	const FIELD_KINDS = {
		TEXT: 'text',
		ENUM: 'enum',
		DATETIME: 'datetime',
		NUMBER: 'number'
	};

	// ---- Ordering directions --------------------------------------------
	const ORDER_DIRECTIONS = {
		ASC: 'asc',
		DESC: 'desc',
		CUSTOM: 'custom'
	};

	/**
	 * Ordering directions a field kind supports.
	 * datetime / number / text → asc | desc
	 * enum → asc | desc | custom (user-defined order)
	 * @param {string} kind
	 * @returns {string[]}
	 */
	function orderDirectionsForKind(kind) {
		return kind === FIELD_KINDS.ENUM
			? [ORDER_DIRECTIONS.ASC, ORDER_DIRECTIONS.DESC, ORDER_DIRECTIONS.CUSTOM]
			: [ORDER_DIRECTIONS.ASC, ORDER_DIRECTIONS.DESC];
	}

	/**
	 * Sentinel for "no value set" in enum filters (shown as "None" in the UI).
	 * Used by Features and Issues views (and any other consumer of this module).
	 */
	const NONE_FILTER_VALUE = '__none__';
	const NONE_FILTER_LABEL = 'None';

	/**
	 * @param {unknown} value
	 * @returns {boolean}
	 */
	function isNoneFilterValue(value) {
		return String(value || '') === NONE_FILTER_VALUE;
	}

	/**
	 * Whether an item's field value counts as empty (no enum / no text set).
	 * @param {unknown} actual
	 * @returns {boolean}
	 */
	function isEmptyEnumActual(actual) {
		if (actual == null) return true;
		return String(actual).trim() === '';
	}

	/**
	 * Checkbox choices for an enum filter: the field's values, plus a trailing "None"
	 * for issues/projects that leave that key blank.
	 * @param {{ values?: string[] } | null | undefined} field
	 * @returns {{ value: string, label: string }[]}
	 */
	function enumFilterChoices(field) {
		/** @type {{ value: string, label: string }[]} */
		const out = [];
		const seen = new Set();
		(field && field.values ? field.values : []).forEach(function (v) {
			const value = String(v);
			if (!value || seen.has(value) || value === NONE_FILTER_VALUE) return;
			seen.add(value);
			out.push({ value: value, label: value });
		});
		out.push({ value: NONE_FILTER_VALUE, label: NONE_FILTER_LABEL });
		return out;
	}

	/**
	 * Does `actual` match one selected enum filter value (including None)?
	 * @param {unknown} actual
	 * @param {string} filterValue
	 * @returns {boolean}
	 */
	function enumFilterValueMatches(actual, filterValue) {
		if (isNoneFilterValue(filterValue)) return isEmptyEnumActual(actual);
		if (isEmptyEnumActual(actual)) return false;
		const a = String(actual);
		const b = String(filterValue);
		return a === b || a.toLowerCase() === b.toLowerCase();
	}

	/**
	 * @param {unknown} value
	 * @returns {string|null} normalized enum value (lowercased, trimmed, or null when empty)
	 */
	function normEnum(value) {
		const v = String(value == null ? '' : value).trim().toLowerCase();
		return v || null;
	}

	/**
	 * @param {unknown} item
	 * @returns {number|null} unix-seconds deadline, or null when absent
	 */
	function deadlineOf(item) {
		const d = item && item.deadline;
		return d != null && Number.isFinite(Number(d)) ? Number(d) : null;
	}

	/**
	 * @param {unknown} item
	 * @returns {number} issue count, or 0 when absent
	 */
	function issueCountOf(item) {
		const n = item && item.issueCount;
		return n != null && Number.isFinite(Number(n)) ? Number(n) : 0;
	}

	/**
	 * @param {unknown} item
	 * @returns {Record<string, number>} per-status issue counts (status → count)
	 */
	function issueStatusCountsOf(item) {
		const c = item && item.issueStatusCounts;
		return c && typeof c === 'object' ? c : {};
	}

	/**
	 * Build FieldDef objects from the host-provided schema JSON.
	 * @param {Array<{ id: string, label: string, kind: string, values?: string[] }>} fieldsJson
	 * @returns {Array<{ id: string, label: string, kind: string, values: string[], get: (item: any) => any }>}
	 */
	function hydrate(fieldsJson) {
		return (fieldsJson || []).map(function (f) {
			const id = String(f && f.id ? f.id : '');
			/** @type {(item: any) => any} */
			let get;
			if (id === 'title') {
				get = function (item) { return String((item && item.title) || ''); };
			} else if (id === 'feature') {
				// Feature names keep their original casing (they are real folder/file names,
				// not enum values), so group/filter on the raw string rather than lowercase.
				get = function (item) { return String((item && item.feature) || ''); };
			} else if (id === 'team') {
				get = function (item) { return String((item && item.team) || ''); };
			} else if (id === 'deadline') {
				get = deadlineOf;
			} else if (id === 'issues') {
				get = issueCountOf;
			} else {
				get = function (item) { return normEnum(item && item[id]); };
			}
			return {
				id,
				label: String(f && f.label ? f.label : id),
				kind: String(f && f.kind ? f.kind : FIELD_KINDS.TEXT),
				values: Array.isArray(f && f.values) ? f.values.map(String) : [],
				get: get
			};
		});
	}

	/**
	 * @param {Array<{ id: string }>} fields
	 * @param {string} id
	 * @returns {{ id: string, label: string, kind: string, values: string[], get: (item: any) => any } | undefined}
	 */
	function fieldById(fields, id) {
		for (let i = 0; i < fields.length; i++) {
			if (fields[i].id === id) return fields[i];
		}
		return undefined;
	}

	/**
	 * Canonical rank of an enum value: its index in `values`, or `values.length`
	 * for unknown values (so unknown values sort after known ones).
	 * @param {{ values: string[] }} field
	 * @param {any} value
	 * @returns {number}
	 */
	function enumRank(field, value) {
		const list = field.values || [];
		const idx = list.indexOf(value);
		return idx === -1 ? list.length : idx;
	}

	// ---- Export ----------------------------------------------------------
	window.DripFilter = {
		FIELD_KINDS,
		ORDER_DIRECTIONS,
		NONE_FILTER_VALUE,
		NONE_FILTER_LABEL,
		orderDirectionsForKind,
		hydrate,
		fieldById,
		enumRank,
		normEnum,
		isNoneFilterValue,
		isEmptyEnumActual,
		enumFilterChoices,
		enumFilterValueMatches,
		deadlineOf,
		issueCountOf,
		issueStatusCountsOf
	};
})();
