'use strict';

/**
 * Durable project-structure constants (see `.cursor/rules/context/drip-project-structure.mdc`).
 * Import these instead of hard-coding paths / id patterns elsewhere.
 */

const PROJECT_ISSUES_FILE_NAME = '_issues.d.txt';
const FEATURE_INBOX_FILE_NAME = '_inbox.d.txt';
const FEATURE_INBOX_HEADING_TITLE = '_inbox';
/** Plain (non-persistent) section in `_issues.d.txt` that holds newly created issues. */
const PROJECT_ISSUES_INBOX_HEADING_TITLE = '_inbox';

/** Issue entity id in headings / metadata: i-1, i-2, … */
const ISSUE_ENTITY_ID_RE = /^i-(\d+)$/i;
/** Heading type prefix carrying the id: `.i-34` */
const ISSUE_TYPE_PREFIX_RE = /^\.i-(\d+)$/i;
/** Feature entity id stamped on feature h0: f-1, f-2, … */
const FEATURE_ENTITY_ID_RE = /^f-(\d+)$/i;

/**
 * Issue metadata key for logical parent (value = `i-N`).
 * Distinct from workflow heading-special `parent: [tN,…]` and from `headings.parent`.
 */
const ISSUE_PARENT_META_KEY = 'parent';

/**
 * @param {string} basename
 * @returns {boolean}
 */
function isProjectIssuesFileName(basename) {
	return String(basename || '').trim().toLowerCase() === PROJECT_ISSUES_FILE_NAME;
}

/**
 * @param {string} basename
 * @returns {boolean}
 */
function isFeatureInboxFileName(basename) {
	return String(basename || '').trim().toLowerCase() === FEATURE_INBOX_FILE_NAME;
}

/**
 * @param {string} raw
 * @returns {string | null} normalized `i-N` or null
 */
function normalizeIssueEntityId(raw) {
	const m = String(raw || '')
		.trim()
		.match(ISSUE_ENTITY_ID_RE);
	if (!m) return null;
	const n = parseInt(m[1], 10);
	if (!Number.isFinite(n) || n < 1) return null;
	return `i-${n}`;
}

/**
 * @param {string} raw
 * @returns {string | null} normalized `f-N` or null
 */
function normalizeFeatureEntityId(raw) {
	const m = String(raw || '')
		.trim()
		.match(FEATURE_ENTITY_ID_RE);
	if (!m) return null;
	const n = parseInt(m[1], 10);
	if (!Number.isFinite(n) || n < 1) return null;
	return `f-${n}`;
}

/**
 * Issue id from type prefix: `.i-12` → `i-12`.
 * @param {string} typePrefix
 * @returns {string | null}
 */
function parseIssueTypePrefix(typePrefix) {
	const m = String(typePrefix || '')
		.trim()
		.match(ISSUE_TYPE_PREFIX_RE);
	if (!m) return null;
	return normalizeIssueEntityId(`i-${m[1]}`);
}

/**
 * @param {string} issueIdOrRaw `i-12` or number
 * @returns {string | null} `.i-12`
 */
function formatIssueTypePrefix(issueIdOrRaw) {
	const id =
		typeof issueIdOrRaw === 'number'
			? formatIssueEntityId(issueIdOrRaw)
			: normalizeIssueEntityId(issueIdOrRaw);
	return id ? `.${id}` : null;
}

/**
 * Leading entity id in an issue heading title (legacy): `i-12 Fix login` → `i-12`.
 * Prefer {@link parseIssueTypePrefix} on `.i-12` type prefixes.
 * @param {string} title
 * @returns {{ id: string, rest: string } | null}
 */
function parseIssueTitleEntityId(title) {
	const t = String(title || '').trim();
	const fromPrefix = t.match(/^(\.i-\d+)\b\s*(.*)$/i);
	if (fromPrefix) {
		const id = parseIssueTypePrefix(fromPrefix[1]);
		if (id) return { id, rest: String(fromPrefix[2] || '').trim() };
	}
	const m = t.match(/^(i-\d+)\b\s*(.*)$/i);
	if (!m) return null;
	const id = normalizeIssueEntityId(m[1]);
	if (!id) return null;
	return { id, rest: String(m[2] || '').trim() };
}

/**
 * Leading entity id in a feature h0 title: `f-3 Auth` or `.f f-3 Auth`.
 * @param {string} title
 * @returns {{ id: string, rest: string } | null}
 */
function parseFeatureTitleEntityId(title) {
	let t = String(title || '').trim();
	t = t.replace(/^\.f\s+/i, '').trim();
	const m = t.match(/^(f-\d+)\b\s*(.*)$/i);
	if (!m) return null;
	const id = normalizeFeatureEntityId(m[1]);
	if (!id) return null;
	return { id, rest: String(m[2] || '').trim() };
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatIssueEntityId(n) {
	const num = Math.floor(Number(n));
	if (!Number.isFinite(num) || num < 1) throw new Error('formatIssueEntityId: need positive int');
	return `i-${num}`;
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatFeatureEntityId(n) {
	const num = Math.floor(Number(n));
	if (!Number.isFinite(num) || num < 1) throw new Error('formatFeatureEntityId: need positive int');
	return `f-${num}`;
}

module.exports = {
	PROJECT_ISSUES_FILE_NAME,
	FEATURE_INBOX_FILE_NAME,
	FEATURE_INBOX_HEADING_TITLE,
	PROJECT_ISSUES_INBOX_HEADING_TITLE,
	ISSUE_ENTITY_ID_RE,
	ISSUE_TYPE_PREFIX_RE,
	FEATURE_ENTITY_ID_RE,
	ISSUE_PARENT_META_KEY,
	isProjectIssuesFileName,
	isFeatureInboxFileName,
	normalizeIssueEntityId,
	normalizeFeatureEntityId,
	parseIssueTypePrefix,
	formatIssueTypePrefix,
	parseIssueTitleEntityId,
	parseFeatureTitleEntityId,
	formatIssueEntityId,
	formatFeatureEntityId
};
