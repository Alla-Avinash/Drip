'use strict';

/**
 * When an issue becomes completed, stamp `completed` (minute datetime).
 * When it leaves completed, clear that stamp so the archive wait restarts.
 */

const vscode = require('vscode');
const { formatDateTimeToMinute, parseFlexibleDateTime } = require('../parse/dripTxt/dripTxtDatetime.js');

const COMPLETED_STATUS = 'completed';
const COMPLETED_FIELD = 'completed';
/** Default when the setting is missing — matches the historical 3-day wait. */
const DEFAULT_ARCHIVE_AFTER_DAYS = 3;
const ARCHIVE_AFTER_MS = DEFAULT_ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;

/**
 * Clamp a days value into the allowed archive-delay range.
 * @param {unknown} raw
 * @returns {number | null}
 */
function clampArchiveDays(raw) {
	const n = Math.floor(Number(raw));
	if (!Number.isFinite(n)) return null;
	return Math.min(365, Math.max(1, n));
}

/**
 * Days to wait after `completed` before moving into `_archive`.
 * Prefer a per-project override (Project Metadata); fall back to the KB setting.
 * @param {string} [projectFolderPrefix]
 * @returns {number}
 */
function getArchiveCompletedIssuesAfterDays(projectFolderPrefix) {
	try {
		if (projectFolderPrefix) {
			const {
				getProjectMetadataOverrides
			} = require('../model/dripTxt/dripTxtProjectMetadata.js');
			const ovr = getProjectMetadataOverrides(projectFolderPrefix);
			const fromProject = ovr ? clampArchiveDays(ovr.archiveCompletedIssuesAfterDays) : null;
			if (fromProject != null) return fromProject;
		}
		const raw = vscode.workspace
			.getConfiguration('drip')
			.get('archiveCompletedIssuesAfterDays', DEFAULT_ARCHIVE_AFTER_DAYS);
		return clampArchiveDays(raw) || DEFAULT_ARCHIVE_AFTER_DAYS;
	} catch {
		return DEFAULT_ARCHIVE_AFTER_DAYS;
	}
}

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
 * @param {number} [afterDays] override; defaults to the KB setting
 * @returns {boolean}
 */
function isReadyToArchive(raw, now, afterDays) {
	const when = parseFlexibleDateTime(String(raw || '').trim(), now);
	if (!when || Number.isNaN(when.getTime())) return false;
	const days =
		afterDays != null && Number.isFinite(Number(afterDays))
			? Math.min(365, Math.max(1, Math.floor(Number(afterDays))))
			: getArchiveCompletedIssuesAfterDays();
	const waitMs = days * 24 * 60 * 60 * 1000;
	return (now || new Date()).getTime() - when.getTime() >= waitMs;
}

module.exports = {
	COMPLETED_STATUS,
	COMPLETED_FIELD,
	DEFAULT_ARCHIVE_AFTER_DAYS,
	ARCHIVE_AFTER_MS,
	getArchiveCompletedIssuesAfterDays,
	isCompletedStatus,
	completedStampNow,
	withCompletedStamp,
	isReadyToArchive
};
