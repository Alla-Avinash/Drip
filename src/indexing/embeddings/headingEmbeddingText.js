'use strict';

/**
 * Deterministic embedding *input text* for a heading (schema v11 storage).
 *
 * Current policy (keep simple; expand later if needed):
 * - Heading title (already marker-free from index ingest)
 * - Semantic / searchable tags only (`tags:` / `[…]` → `searchtags`)
 *
 * Excluded for now: body, ancestors, ids/hashes, workflow metadata (status, priority, …).
 */

/**
 * @param {{ title?: string, tags?: string[] }} input
 * @returns {string}
 */
function buildHeadingEmbeddingText(input) {
	const title = String(input && input.title != null ? input.title : '')
		.replace(/\s+/g, ' ')
		.trim();
	const tags = normalizeSemanticTags(input && input.tags);

	if (!title && !tags.length) {
		return '';
	}
	if (!tags.length) {
		return title;
	}
	if (!title) {
		return tags.join(', ');
	}
	return `${title}\n${tags.join(', ')}`;
}

/**
 * Stable tag list: trim, drop empties, case-insensitive unique, sorted by lower-case.
 * @param {string[] | undefined | null} tags
 * @returns {string[]}
 */
function normalizeSemanticTags(tags) {
	/** @type {Map<string, string>} */
	const byLower = new Map();
	for (const raw of tags || []) {
		const label = String(raw || '')
			.replace(/\s+/g, ' ')
			.trim();
		if (!label) {
			continue;
		}
		const key = label.toLowerCase();
		if (!byLower.has(key)) {
			byLower.set(key, label);
		}
	}
	return [...byLower.entries()]
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([, label]) => label);
}

/**
 * Semantic tag names for one heading from `searchtags` + `tags`.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number} fileId
 * @param {number} headingId
 * @returns {string[]}
 */
function listSemanticTagsForHeading(db, fileId, headingId) {
	const stmt = db.prepare(
		`
		SELECT t.tag_name
		FROM searchtags s
		JOIN tags t ON t.tag_id = s.tag_id
		WHERE s.file_id = ? AND s.heading_id = ?
		ORDER BY LOWER(t.tag_name), t.tag_name
		`
	);
	stmt.bind([fileId, headingId]);
	/** @type {string[]} */
	const names = [];
	while (stmt.step()) {
		const row = stmt.get();
		names.push(String(row[0] || ''));
	}
	stmt.free();
	return normalizeSemanticTags(names);
}

/**
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number} fileId
 * @param {number} headingId
 * @returns {string | undefined}
 */
function getHeadingTitle(db, fileId, headingId) {
	const stmt = db.prepare(
		`SELECT title FROM headings WHERE file_id = ? AND heading_id = ?`
	);
	stmt.bind([fileId, headingId]);
	if (!stmt.step()) {
		stmt.free();
		return undefined;
	}
	const title = String(stmt.get()[0] || '');
	stmt.free();
	return title;
}

/**
 * Build embedding input for a heading already in `index.drip`.
 * @param {import('../db/dripSqlite').DripSqliteDatabase} db
 * @param {number} fileId
 * @param {number} headingId
 * @returns {string}
 */
function buildHeadingEmbeddingTextFromDb(db, fileId, headingId) {
	const title = getHeadingTitle(db, fileId, headingId);
	if (title === undefined) {
		return '';
	}
	const tags = listSemanticTagsForHeading(db, fileId, headingId);
	return buildHeadingEmbeddingText({ title, tags });
}

/**
 * Collect tag names for a heading from a parse result (`searchtags` rows).
 * @param {{ searchtags?: { source_heading_id: number, tag_name: string }[] }} parsed
 * @param {number} headingId
 * @returns {string[]}
 */
function collectSemanticTagsFromParsed(parsed, headingId) {
	const rows = (parsed && parsed.searchtags) || [];
	return normalizeSemanticTags(
		rows.filter(r => Number(r.source_heading_id) === Number(headingId)).map(r => r.tag_name)
	);
}

/**
 * @param {{ title?: string, heading_id?: number }} heading
 * @param {{ searchtags?: { source_heading_id: number, tag_name: string }[] }} parsed
 * @returns {string}
 */
function buildHeadingEmbeddingTextFromParsed(heading, parsed) {
	const headingId = heading && heading.heading_id != null ? Number(heading.heading_id) : NaN;
	const tags = Number.isFinite(headingId)
		? collectSemanticTagsFromParsed(parsed, headingId)
		: [];
	return buildHeadingEmbeddingText({
		title: heading && heading.title,
		tags
	});
}

module.exports = {
	buildHeadingEmbeddingText,
	normalizeSemanticTags,
	listSemanticTagsForHeading,
	getHeadingTitle,
	buildHeadingEmbeddingTextFromDb,
	collectSemanticTagsFromParsed,
	buildHeadingEmbeddingTextFromParsed
};
