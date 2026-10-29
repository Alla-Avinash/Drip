'use strict';

/**
 * When an issue becomes completed, stamp `completed` (minute datetime).
 * When it leaves completed, clear that stamp so the 3-day archive wait restarts.
 */

const { formatDateTimeToMinute, parseFlexibleDateTime } = require('../parse/dripTxt/dripTxtDatetime.js');

const COMPLETED_STATUS = 'completed';
const COMPLETED_FIELD = 'completed';
const ARCHIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

function isCompletedStatus(value) {
	return String(value || '').trim().toLowerCase() === COMPLETED_STATUS;
}

function completedStampNow(now) {
	return formatDateTimeToMinute(now || new Date());
}

/**
 * @param {Record<string, string>} existing
 * @param {Record<string, string>} patch
 * @returns {Record<string, string>}
 */
function withCompletedStamp(existing, patch) {
	const next = { ...(patch || {}) };
	if (!Object.prototype.hasOwnProperty.call(next, 'status')) return next;
	if (isCompletedStatus(next.status)) {
		const have = String(next[COMPLETED_FIELD] || (existing && existing[COMPLETED_FIELD]) || '').trim();
		if (!have) next[COMPLETED_FIELD] = completedStampNow();
	} else {
		next[COMPLETED_FIELD] = '';
	}
	return next;
}

/**
 * @param {string} raw
 * @param {Date} [now]
 * @returns {boolean}
 */
function isReadyToArchive(raw, now) {
	const when = parseFlexibleDateTime(String(raw || '').trim(), now);
	if (!when || Number.isNaN(when.getTime())) return false;
	return (now || new Date()).getTime() - when.getTime() >= ARCHIVE_AFTER_MS;
}

module.exports = {
	COMPLETED_STATUS,
	COMPLETED_FIELD,
	ARCHIVE_AFTER_MS,
	isCompletedStatus,
	completedStampNow,
	withCompletedStamp,
	isReadyToArchive
};
