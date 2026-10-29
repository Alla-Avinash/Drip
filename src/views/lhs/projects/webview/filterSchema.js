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
		orderDirectionsForKind,
		hydrate,
		fieldById,
		enumRank,
		normEnum,
		deadlineOf,
		issueCountOf,
		issueStatusCountsOf
	};
})();
