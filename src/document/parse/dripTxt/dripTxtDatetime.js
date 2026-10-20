'use strict';

function formatDateTimeToMinute(date) {
	const d = new Date(date);
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	const hh = String(d.getHours()).padStart(2, '0');
	const mi = String(d.getMinutes()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function parseRelativeDurationToDate(raw, now) {
	const s = String(raw || '').trim().toLowerCase();
	if (!s) return null;
	const m = s.match(/^(\d+)\s*(min|mins|minute|minutes|hr|hrs|hour|hours|day|days|month|months)$/i);
	if (!m) return null;
	const n = Math.max(0, parseInt(m[1], 10));
	const unit = m[2].toLowerCase();
	const d = new Date(now || Date.now());
	if (unit.startsWith('min')) d.setMinutes(d.getMinutes() + n);
	else if (unit.startsWith('h')) d.setHours(d.getHours() + n);
	else if (unit.startsWith('day')) d.setDate(d.getDate() + n);
	else if (unit.startsWith('month')) d.setMonth(d.getMonth() + n);
	return d;
}

/**
 * @param {string} raw
 * @param {Date} [now]
 * @returns {Date | null}
 */
function parseFlexibleDateTime(raw, now) {
	const rel = parseRelativeDurationToDate(raw, now);
	if (rel && !Number.isNaN(rel.getTime())) return rel;

	const s = String(raw || '').trim();
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

	const parsed = new Date(s);
	if (!Number.isNaN(parsed.getTime())) return parsed;
	return null;
}

/**
 * @param {string} raw
 * @param {Date} [now]
 * @returns {string}
 */
function normalizeDateTimeValue(raw, now) {
	const parsed = parseFlexibleDateTime(raw, now);
	if (!parsed) return '';
	return formatDateTimeToMinute(parsed);
}

module.exports = {
	formatDateTimeToMinute,
	parseRelativeDurationToDate,
	parseFlexibleDateTime,
	normalizeDateTimeValue
};
