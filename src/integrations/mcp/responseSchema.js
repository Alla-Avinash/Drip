'use strict';

/**
 * GraphQL-style response projection for MCP tools.
 *
 * Each tool declares the fields it may return plus a lean default set. A `fields` argument on a
 * tool call selects exactly what comes back — like a GraphQL field selection, without a query
 * parser. Unknown fields error; an omitted `fields` returns the lean default, so even lazy
 * callers never get file paths / internal ids they did not ask for.
 *
 * Type shapes (documentation):
 *   IssueRef    = { id, title, status, priority, parent, location, file }
 *   IssueDetail = { id, title, status, priority, parent, content?, subIssues? }
 *   Feature     = { title, kind, path }
 *   Project     = { project, title, features, inboxIssues, totalIssues, issuesByStatus }
 */

const { ToolError } = require('./tools/toolShared');

/**
 * Per-tool field catalog. `arrayKey` = the result array whose items are projected by `fields`
 * (used by list/search tools whose payload is a row array under a wrapper key).
 */
const FIELD_CATALOG = {
	list_issues: {
		arrayKey: 'issues',
		defaults: ['id', 'title', 'status', 'priority', 'parent', 'location'],
		fields: {
			id: 'Issue id (i-N).',
			title: 'Title without the i-N prefix.',
			status: 'to-do / in-progress / completed.',
			priority: 'high / medium / low.',
			category: 'Issue category value from DRIP settings, or null.',
			deadline: 'Due date/time (YYYY-MM-DD HH:mm), or null.',
			parent: 'Parent issue id, or null.',
			location: 'inbox or the feature it is assigned to.',
			file: 'Note file path (rarely needed).'
		}
	},
	search_issues: {
		arrayKey: 'issues',
		defaults: ['id', 'title', 'status', 'priority', 'parent', 'location', 'score'],
		fields: {
			id: 'Issue id (i-N).',
			title: 'Title without the i-N prefix.',
			status: 'to-do / in-progress / completed.',
			priority: 'high / medium / low.',
			category: 'Issue category value from DRIP settings, or null.',
			deadline: 'Due date/time (YYYY-MM-DD HH:mm), or null.',
			parent: 'Parent issue id, or null.',
			location: 'inbox or the feature it is assigned to.',
			score: 'Relevance score (0..1).'
		}
	},
	get_issue: {
		defaults: ['id', 'title', 'status', 'priority', 'parent'],
		fields: {
			id: 'Issue id (i-N).',
			title: 'Title without the i-N prefix.',
			status: 'to-do / in-progress / completed.',
			priority: 'high / medium / low.',
			category: 'Issue category value from DRIP settings, or null.',
			deadline: 'Due date/time (YYYY-MM-DD HH:mm), or null.',
			parent: 'Parent issue id, or null.',
			content: 'Body text written inside the issue (reads the note file).',
			subIssues: 'Sub-issues: id, title, status.'
		}
	},
	list_projects: {
		arrayKey: 'projects',
		defaults: ['project', 'title', 'status'],
		fields: {
			project: 'Project folder name (Name.p).',
			title: 'Project title.',
			status: 'Project status.'
		}
	},
	get_project: {
		defaults: ['project', 'title', 'features', 'inboxIssues', 'totalIssues', 'issuesByStatus'],
		fields: {
			project: 'Project folder name (Name.p).',
			title: 'Project title.',
			features: 'Features with issue counts.',
			inboxIssues: 'Number of issues in the inbox.',
			totalIssues: 'Total number of issues.',
			issuesByStatus: 'Issue counts keyed by status.'
		}
	},
	list_features: {
		arrayKey: 'features',
		defaults: ['title', 'kind'],
		fields: {
			title: 'Feature title.',
			kind: 'folder or file.',
			path: 'Feature path (rarely needed).'
		}
	}
};

/**
 * JSON-schema fragment for a tool's `fields` input, or null when the tool has no projection.
 * @param {string} toolName
 */
function fieldsPropFor(toolName) {
	const c = FIELD_CATALOG[toolName];
	if (!c) return null;
	const valid = Object.keys(c.fields);
	return {
		type: 'array',
		items: { type: 'string', enum: valid },
		description:
			`Only return these fields. Omit for the lean default (${c.defaults.join(', ')}). ` +
			`Valid: ${valid.join(', ')}.`
	};
}

/**
 * Resolve requested fields for a tool: explicit `fields` (array or comma string) or its default.
 * @param {string} toolName
 * @param {unknown} raw
 * @returns {string[] | null} null when the tool has no projection catalog.
 */
function parseFields(toolName, raw) {
	const c = FIELD_CATALOG[toolName];
	if (!c) return null;
	if (raw == null || raw === '') return c.defaults.slice();
	const items = Array.isArray(raw) ? raw : String(raw).split(',').map(s => s.trim());
	/** @type {string[]} */
	const out = [];
	for (const it of items) {
		const name = String(it == null ? '' : it).trim();
		if (!name) continue;
		if (!Object.prototype.hasOwnProperty.call(c.fields, name)) {
			throw new ToolError(`Unknown field "${name}" for ${toolName}. Valid: ${Object.keys(c.fields).join(', ')}.`);
		}
		if (!out.includes(name)) out.push(name);
	}
	return out.length ? out : c.defaults.slice();
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} fields
 */
function pick(obj, fields) {
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const f of fields) {
		if (Object.prototype.hasOwnProperty.call(obj, f)) out[f] = obj[f];
	}
	return out;
}

/**
 * Trim a tool result to the requested fields.
 * @param {string} toolName
 * @param {string[] | null} fields
 * @param {unknown} result
 */
function project(toolName, fields, result) {
	if (!fields || !result || typeof result !== 'object' || Array.isArray(result)) return result;
	const c = FIELD_CATALOG[toolName];
	if (!c) return result;
	const obj = /** @type {Record<string, unknown>} */ (result);
	const arr = c.arrayKey && Array.isArray(obj[c.arrayKey]) ? /** @type {unknown[]} */ (obj[c.arrayKey]) : null;
	/** @type {Record<string, unknown>} */
	const out = {};
	if (arr) {
		// Copy scalar/meta keys the caller asked for (plus always-useful counts/ranking).
		for (const k of Object.keys(obj)) {
			if (k === c.arrayKey) continue;
			if (fields.includes(k) || k === 'total' || k === 'ranking') out[k] = obj[k];
		}
		out[c.arrayKey] = arr.map(item =>
			item && typeof item === 'object' ? pick(/** @type {Record<string, unknown>} */ (item), fields) : item
		);
		return out;
	}
	return pick(obj, fields);
}

module.exports = {
	FIELD_CATALOG,
	fieldsPropFor,
	parseFields,
	project
};
