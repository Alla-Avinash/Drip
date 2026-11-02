'use strict';

const DEFAULT_DURATION_UNITS = ['minute', 'hour', 'day', 'week', 'month', 'year'];

const FLOAT_CAPTURE = '([+-]?(?:\\d+\\.?\\d*|\\.\\d+))';

/**
 * @param {string} unit
 */
function escapeUnitForRe(unit) {
	return String(unit || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string[] | undefined} units
 * @returns {string[]}
 */
function resolveDurationUnits(units) {
	const list = (Array.isArray(units) ? units : [])
		.map(u => String(u || '').trim().toLowerCase())
		.filter(Boolean);
	return list.length ? list : DEFAULT_DURATION_UNITS.slice();
}

/**
 * @param {string[] | undefined} units
 * @returns {RegExp | null}
 */
function buildDurationValueRe(units) {
	const list = resolveDurationUnits(units);
	const unitPart = list.map(escapeUnitForRe).join('|');
	if (!unitPart) return null;
	return new RegExp(`^${FLOAT_CAPTURE}\\s+(${unitPart})$`, 'i');
}

/**
 * @param {string} value
 * @param {string[] | undefined} units
 * @returns {{ amount: number, unit: string } | null}
 */
function parseDurationValue(value, units) {
	const s = String(value || '').trim();
	if (!s) return null;
	const re = buildDurationValueRe(units);
	if (!re) return null;
	const m = s.match(re);
	if (!m) return null;
	const amount = Number(m[1]);
	if (!Number.isFinite(amount)) return null;
	const unitList = resolveDurationUnits(units);
	const unitRaw = s.slice(m[1].length).trim().toLowerCase();
	const unit = unitList.find(u => u.toLowerCase() === unitRaw);
	if (!unit) return null;
	return { amount, unit };
}

/**
 * @param {string} value
 * @param {string[] | undefined} units
 */
function isValidDurationValue(value, units) {
	return !!parseDurationValue(value, units);
}

/**
 * @param {{ amount: number, unit: string }} parsed
 */
function formatDurationValue(parsed) {
	if (!parsed) return '';
	const amount = parsed.amount;
	const amountStr = Number.isInteger(amount) ? String(amount) : String(amount);
	return `${amountStr} ${parsed.unit}`;
}

/**
 * @param {string} value
 * @param {string[] | undefined} units
 * @returns {string | null}
 */
function normalizeDurationValue(value, units) {
	const parsed = parseDurationValue(value, units);
	return parsed ? formatDurationValue(parsed) : null;
}

/**
 * @param {string} value
 * @returns {{ phase: 'empty' | 'number' | 'unit' | 'invalid', amount?: string, partialUnit?: string }}
 */
function parsePartialDurationInput(value) {
	const s = String(value || '').trim();
	if (!s) return { phase: 'empty' };
	const m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+))(?:\s+(.*))?$/);
	if (!m) return { phase: 'invalid' };
	const partialUnit = String(m[2] || '').trim().toLowerCase();
	return {
		phase: partialUnit ? 'unit' : 'number',
		amount: m[1],
		partialUnit
	};
}

module.exports = {
	DEFAULT_DURATION_UNITS,
	buildDurationValueRe,
	parseDurationValue,
	isValidDurationValue,
	normalizeDurationValue,
	parsePartialDurationInput,
	resolveDurationUnits
};
