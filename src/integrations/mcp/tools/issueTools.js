'use strict';

/**
 * MCP tool cards: issues, hierarchy, issue search.
 * All writes go through the same modules as Project View / RHS (ids, parent rules, mailbox layout).
 */

const path = require('path');
const {
	ToolError,
	requireKbRoot,
	uriFromRel,
	resolveProject,
	loadProjectChildren,
	resolveFeature,
	requireIssueId,
	findIssueRow,
	readNoteText,
	writeNoteText,
	reindexNote,
	issueSummary
} = require('./toolShared');
const {
	readIssueBlock,
	readIssueContent,
	updateIssueBlockText,
	appendIssueNoteText
} = require('../../../document/project/issueBlockEdit');
const { formatFromPath } = require('../../../document/project/issueInboxLayout');
const { fieldsPropFor } = require('../responseSchema');

const PROJECT_PROP = {
	type: 'string',
	description: 'Project folder (e.g. "Shop.p") or title. Optional if only one project.'
};
const ISSUE_PROP = { type: 'string', description: 'Issue id, e.g. "i-12".' };

/**
 * Allowed values for an issue enum attribute (from DRIP metadata settings).
 * @param {import('vscode').Uri} uri note the issue lives in
 * @param {string} key
 * @returns {string[]}
 */
function allowedIssueValues(uri, key) {
	const {
		getMetadataSettingsForNotePath,
		getTypeRule
	} = require('../../../document/model/dripNoteMetadataTemplates.js');
	const rule = getTypeRule(getMetadataSettingsForNotePath(uri.fsPath), 'issue', key);
	return rule && Array.isArray(rule.values) ? rule.values.map(String) : [];
}

/**
 * @param {import('vscode').Uri} uri
 * @param {Record<string, unknown>} args
 * @returns {Record<string, string>}
 */
function validatedStatusPriority(uri, args) {
	/** @type {Record<string, string>} */
	const out = {};
	for (const key of ['status', 'priority']) {
		if (args[key] == null || args[key] === '') continue;
		const v = String(args[key]).trim().toLowerCase();
		const allowed = allowedIssueValues(uri, key);
		if (allowed.length && !allowed.includes(v)) {
			throw new ToolError(`Invalid ${key} "${args[key]}". Allowed: ${allowed.join(', ')}.`);
		}
		out[key] = v;
	}
	return out;
}

/**
 * Parse a "due within" window ("24h", "7d", "2w", "2 days") into a future unix timestamp.
 * Falls back to flexible datetime ("2 days", "tomorrow") when the compact form doesn't match.
 * @param {string} raw
 * @param {number} nowSec
 * @returns {number | null}
 */
function parseDueWithinSeconds(raw, nowSec) {
	const s = String(raw || '').trim().toLowerCase();
	if (!s) return null;
	const m = s.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months)$/);
	if (m) {
		const n = Number(m[1]);
		const u = String(m[2] || '');
		if (!Number.isFinite(n) || n <= 0) return null;
		if (u.startsWith('h')) return nowSec + Math.round(n * 3600);
		if (u.startsWith('d')) return nowSec + Math.round(n * 86400);
		if (u.startsWith('w')) return nowSec + Math.round(n * 604800);
		if (u.startsWith('mo')) return nowSec + Math.round(n * 2592000);
		return null;
	}
	const { parseDatetimeToUnixSeconds } = require('../../../indexing/parse/dripIndexMetadataValidate');
	const parsed = parseDatetimeToUnixSeconds(raw, new Date(nowSec * 1000));
	return parsed != null && parsed > nowSec ? parsed : null;
}

/**
 * Parse an absolute deadline (datetime string or unix seconds) into unix seconds.
 * @param {string} raw
 * @param {number} nowSec
 * @returns {number | null}
 */
function parseDueBeforeSeconds(raw, nowSec) {
	const s = String(raw || '').trim();
	if (!s) return null;
	if (/^\d+$/.test(s)) {
		const n = Number(s);
		return Number.isFinite(n) ? n : null;
	}
	const { parseDatetimeToUnixSeconds } = require('../../../indexing/parse/dripIndexMetadataValidate');
	return parseDatetimeToUnixSeconds(s, new Date(nowSec * 1000));
}

/**
 * Sort issue rows by a key. Mutates nothing — returns a sorted copy.
 * @param {any[]} rows
 * @param {string} by
 * @returns {any[]}
 */
function sortIssueRows(rows, by) {
	const copy = rows.slice();
	const key = String(by || '').trim().toLowerCase();
	if (key === 'deadline') {
		const sec = i => (i.deadline != null && Number.isFinite(Number(i.deadline)) ? Number(i.deadline) : Infinity);
		copy.sort((a, b) => sec(a) - sec(b));
		return copy;
	}
	if (key === 'priority') {
		const order = { high: 0, medium: 1, low: 2 };
		const rank = i => (order[String(i.priority || '').toLowerCase()] != null ? order[String(i.priority || '').toLowerCase()] : 3);
		copy.sort((a, b) => rank(a) - rank(b));
		return copy;
	}
	if (key === 'status') {
		copy.sort((a, b) => String(a.status || '').toLowerCase().localeCompare(String(b.status || '').toLowerCase()));
		return copy;
	}
	if (key === 'title') {
		copy.sort((a, b) => String(a.title || '').toLowerCase().localeCompare(String(b.title || '').toLowerCase()));
		return copy;
	}
	throw new ToolError(`Invalid sortBy "${by}". Use "deadline", "priority", "status", or "title".`);
}

/**
 * @param {import('vscode').Uri} kb
 * @param {import('vscode').Uri} uri
 */
function relOf(kb, uri) {
	return path.relative(kb.fsPath, uri.fsPath).replace(/\\/g, '/');
}

/**
 * Apply a text transform to the note holding `row`, then reindex + refresh.
 * @param {import('./toolShared').ToolContext} ctx
 * @param {import('vscode').Uri} uri
 * @param {(text: string) => { ok: true, text: string } | { ok: false, error: string }} fn
 */
async function editNote(ctx, uri, fn) {
	const text = await readNoteText(uri);
	const res = fn(text);
	if (!res.ok) throw new ToolError(res.error);
	await writeNoteText(uri, res.text);
	await reindexNote(ctx, uri);
	ctx.refreshUi();
}

/**
 * @param {import('./toolShared').ToolContext} ctx
 * @param {Record<string, unknown>} args
 */
async function loadIssueContext(ctx, args) {
	const kb = requireKbRoot(ctx);
	const project = await resolveProject(kb, /** @type {string} */ (args.project));
	const children = await loadProjectChildren(kb, project);
	const issueId = requireIssueId(/** @type {string} */ (args.issueId));
	const row = findIssueRow(children.issues, issueId);
	return { kb, project, children, issueId, row, uri: uriFromRel(kb, row.path) };
}

/**
 * @param {any[]} issues
 * @param {string | null} rootId
 * @param {boolean} includeCompleted
 */
function buildForest(issues, rootId, includeCompleted) {
	/** @type {Map<string, any[]>} */
	const kids = new Map();
	for (const i of issues) {
		if (!i.parentIssueKey) continue;
		if (!kids.has(i.parentIssueKey)) kids.set(i.parentIssueKey, []);
		kids.get(i.parentIssueKey).push(i);
	}
	const seen = new Set();
	/** @param {any} i @returns {any} */
	const node = i => {
		seen.add(i.issueKey);
		const children = (kids.get(i.issueKey) || [])
			.filter(c => !seen.has(c.issueKey))
			.filter(c => includeCompleted || String(c.status || '') !== 'completed')
			.map(node);
		const out = { id: i.issueKey, title: issueSummary(i).title, status: i.status || null };
		if (children.length) out.children = children;
		return out;
	};
	if (rootId) {
		const root = issues.find(i => i.issueKey === rootId);
		return root ? [node(root)] : [];
	}
	return issues
		.filter(i => !i.parentIssueKey)
		.filter(i => includeCompleted || String(i.status || '') !== 'completed')
		.map(i => ({ ...node(i), location: issueSummary(i).location }));
}

/** @type {import('../toolCatalog').ToolCard[]} */
const ISSUE_TOOLS = [
	{
		name: 'list_issues',
		category: 'issues',
		summary: 'List issues of a project with optional filters (status, priority, location, parent, text).',
		keywords: ['issues', 'tickets', 'bugs', 'tasks', 'backlog', 'todo', 'open issues', 'filter'],
		inputSchema: {
			type: 'object',
			properties: {
				project: PROJECT_PROP,
				status: { type: 'string', description: 'e.g. "to-do", "in-progress", "completed".' },
				priority: { type: 'string', description: 'e.g. "high", "medium", "low".' },
				category: { type: 'string', description: 'Exact issue category (values come from DRIP settings).' },
				dueBefore: { type: 'string', description: 'Only issues with a deadline on or before this moment ("2026-10-03 17:00", "tomorrow", or unix seconds).' },
				dueWithin: { type: 'string', description: 'Only issues due within this window from now ("24h", "7d", "2w", or "2 days").' },
				sortBy: { type: 'string', enum: ['deadline', 'priority', 'status', 'title'], description: 'Sort order (default: priority, then title).' },
				location: { type: 'string', description: '"inbox" (_issues.d.txt) or a feature name.' },
				parent: { type: 'string', description: 'Only children of this issue id, or "none" for top-level issues.' },
				text: { type: 'string', description: 'Case-insensitive substring of the title.' },
				limit: { type: 'integer', description: 'Max results (default 50).' },
				fields: fieldsPropFor('list_issues')
			},
			additionalProperties: false
		},
		example: { project: 'Shop.p', status: 'to-do', location: 'inbox' },
		async handler(args, ctx) {
			const kb = requireKbRoot(ctx);
			const project = await resolveProject(kb, args.project);
			const { features, issues } = await loadProjectChildren(kb, project);
			let rows = issues;
			if (args.status) rows = rows.filter(i => String(i.status || '') === String(args.status).toLowerCase());
			if (args.priority) rows = rows.filter(i => String(i.priority || '') === String(args.priority).toLowerCase());
			if (args.category) rows = rows.filter(i => String(i.category || '').toLowerCase() === String(args.category).toLowerCase());
			const nowSec = Math.floor(Date.now() / 1000);
			if (args.dueBefore != null && args.dueBefore !== '') {
				const before = parseDueBeforeSeconds(args.dueBefore, nowSec);
				if (before == null) {
					throw new ToolError(`Invalid dueBefore "${args.dueBefore}". Use a date/time ("2026-10-03 17:00", "tomorrow") or unix seconds.`);
				}
				rows = rows.filter(i => i.deadline != null && Number.isFinite(Number(i.deadline)) && Number(i.deadline) <= before);
			}
			if (args.dueWithin != null && args.dueWithin !== '') {
				const until = parseDueWithinSeconds(args.dueWithin, nowSec);
				if (until == null) {
					throw new ToolError(`Invalid dueWithin "${args.dueWithin}". Use "24h", "7d", "2w", or "2 days".`);
				}
				rows = rows.filter(i => i.deadline != null && Number.isFinite(Number(i.deadline)) && Number(i.deadline) >= nowSec && Number(i.deadline) <= until);
			}
			if (args.location) {
				if (String(args.location).toLowerCase() === 'inbox') {
					rows = rows.filter(i => i.inProjectInbox);
				} else {
					const f = resolveFeature(features, args.location);
					rows = rows.filter(i => i.featurePathPrefix === (f.folderPrefix || f.path));
				}
			}
			if (args.parent) {
				const p = String(args.parent).toLowerCase();
				rows = p === 'none' ? rows.filter(i => !i.parentIssueKey) : rows.filter(i => i.parentIssueKey === requireIssueId(p));
			}
			if (args.text) {
				const t = String(args.text).toLowerCase();
				rows = rows.filter(i => String(i.title || '').toLowerCase().includes(t));
			}
			if (args.sortBy) {
				rows = sortIssueRows(rows, String(args.sortBy));
			}
			const limit = Math.max(1, Math.min(Number(args.limit) || 50, 500));
			return { total: rows.length, issues: rows.slice(0, limit).map(issueSummary) };
		}
	},
	{
		name: 'get_issue',
		category: 'issues',
		summary:
			'Read an issue. Default returns id/title/status/priority/parent; request fields "content" (body text written inside it) and/or "subIssues" when needed.',
		keywords: ['issue content', 'read issue', 'what is written in', 'description', 'details', 'notes', 'what is i-N about'],
		inputSchema: {
			type: 'object',
			properties: { project: PROJECT_PROP, issueId: ISSUE_PROP, fields: fieldsPropFor('get_issue') },
			required: ['issueId'],
			additionalProperties: false
		},
		example: { project: 'Shop.p', issueId: 'i-4' },
		async handler(args, ctx, fields) {
			const { children, issueId, row, uri } = await loadIssueContext(ctx, args);
			const s = issueSummary(row);
			/** @type {Record<string, unknown>} */
			const out = {
				id: s.id,
				title: s.title,
				status: s.status,
				priority: s.priority,
				category: s.category,
				deadline: s.deadline,
				parent: s.parent
			};
			const wantContent = !fields || fields.includes('content');
			const wantSub = !fields || fields.includes('subIssues');
			if (wantContent || wantSub) {
				const read = readIssueContent(await readNoteText(uri), issueId, { fileId: row.fileId, headingId: row.headingId }, formatFromPath(uri.fsPath));
				if (!read) {
					throw new ToolError(`${issueId} is indexed in ${row.path} but its heading was not found there. Run reindex_project, then retry.`);
				}
				const byKey = new Map(children.issues.map(i => [i.issueKey, i]));
				const inlineIds = new Set(read.subIssues.map(x => x.id));
				const linked = children.issues.filter(i => i.parentIssueKey === issueId && !inlineIds.has(i.issueKey));
				if (wantContent) {
					const linkedLines = linked.map(i => `\t# .${i.issueKey} ${String(i.title || '').replace(/^i-\d+\s+/i, '')}   [sub-issue in ${i.path}]`);
					out.content = linkedLines.length ? `${read.content}\n\n${linkedLines.join('\n')}` : read.content;
				}
				if (wantSub) {
					out.subIssues = [
						...read.subIssues.map(x => ({ id: x.id, title: x.title, status: (byKey.get(x.id) || {}).status || null })),
						...linked.map(i => ({ id: i.issueKey, title: String(i.title || '').replace(/^i-\d+\s+/i, ''), status: i.status || null }))
					];
				}
			}
			return out;
		}
	},
	{
		name: 'create_issue',
		category: 'issues',
		summary:
			'Create an issue (next i-N id). Without parent → "# _inbox" in _issues.d.txt; with parent → indented under that issue.',
		keywords: ['new issue', 'add issue', 'make issue', 'report bug', 'create ticket', 'add sub-issue', 'log task'],
		inputSchema: {
			type: 'object',
			properties: {
				project: PROJECT_PROP,
				title: { type: 'string', description: 'Issue title (plain text; the i-N id is added by DRIP).' },
				parent: { type: 'string', description: 'Optional parent issue id → created as its sub-issue.' },
				status: { type: 'string', description: 'Optional; default "to-do".' },
				priority: { type: 'string', description: 'Optional; default "medium".' },
				description: { type: 'string', description: 'Optional body text under the issue.' }
			},
			required: ['title'],
			additionalProperties: false
		},
		example: { project: 'Shop.p', title: 'Payment times out on slow networks', parent: 'i-4', priority: 'high' },
		async handler(args, ctx) {
			const kb = requireKbRoot(ctx);
			const project = await resolveProject(kb, args.project);
			const title = String(args.title || '').replace(/\s+/g, ' ').trim();
			if (!title) throw new ToolError('"title" is required.');
			let parent = null;
			if (args.parent) {
				parent = requireIssueId(args.parent);
				const { issues } = await loadProjectChildren(kb, project);
				findIssueRow(issues, parent);
			}
			const folderUri = uriFromRel(kb, project.folderPrefix);
			const { projectIssuesUri, createIssueInProjectInbox } = require('../../../document/project/projectIssuesMailbox');
			const fields = validatedStatusPriority(projectIssuesUri(folderUri), args);
			const res = await createIssueInProjectInbox(kb, folderUri, {
				title,
				parentIssueId: parent,
				context: ctx.extensionContext
			});
			const description = String(args.description || '').trim();
			if (Object.keys(fields).length || description) {
				const fmt = formatFromPath(res.uri.fsPath);
				await editNote(ctx, res.uri, text => {
					let r = Object.keys(fields).length
						? updateIssueBlockText(text, res.issueId, { attributes: fields }, fmt)
						: { ok: true, text };
					if (r.ok && description) r = appendIssueNoteText(r.text, res.issueId, description, fmt);
					return r;
				});
			}
			ctx.refreshUi();
			return {
				created: res.issueId,
				file: relOf(kb, res.uri),
				placement: parent ? `sub-issue of ${parent}` : '# _inbox in _issues.d.txt'
			};
		}
	},
	{
		name: 'update_issue',
		category: 'issues',
		summary: 'Change an issue\'s title, status, and/or priority.',
		keywords: ['edit issue', 'rename issue', 'change status', 'set priority', 'mark in progress', 'update ticket'],
		inputSchema: {
			type: 'object',
			properties: {
				project: PROJECT_PROP,
				issueId: ISSUE_PROP,
				title: { type: 'string', description: 'New title (without the i-N id).' },
				status: { type: 'string', description: 'e.g. "to-do", "in-progress", "completed".' },
				priority: { type: 'string', description: 'e.g. "high", "medium", "low".' }
			},
			required: ['issueId'],
			additionalProperties: false
		},
		example: { project: 'Shop.p', issueId: 'i-4', status: 'in-progress' },
		async handler(args, ctx) {
			const { kb, issueId, uri } = await loadIssueContext(ctx, args);
			const fields = validatedStatusPriority(uri, args);
			const title = args.title != null ? String(args.title) : undefined;
			if (!Object.keys(fields).length && title == null) {
				throw new ToolError('Nothing to update: pass title, status, and/or priority.');
			}
			await editNote(ctx, uri, text => updateIssueBlockText(text, issueId, { title, attributes: fields }, formatFromPath(uri.fsPath)));
			return { updated: issueId, file: relOf(kb, uri), changes: { ...(title != null ? { title } : {}), ...fields } };
		}
	},
	{
		name: 'close_issue',
		category: 'issues',
		summary: 'Mark an issue as completed.',
		keywords: ['close issue', 'resolve', 'done', 'finish', 'complete ticket', 'mark done'],
		inputSchema: {
			type: 'object',
			properties: { project: PROJECT_PROP, issueId: ISSUE_PROP },
			required: ['issueId'],
			additionalProperties: false
		},
		example: { project: 'Shop.p', issueId: 'i-4' },
		async handler(args, ctx) {
			const { issueId, uri } = await loadIssueContext(ctx, args);
			const allowed = allowedIssueValues(uri, 'status');
			const done = allowed.includes('completed') ? 'completed' : allowed[allowed.length - 1] || 'completed';
			await editNote(ctx, uri, text => updateIssueBlockText(text, issueId, { attributes: { status: done } }, formatFromPath(uri.fsPath)));
			return { closed: issueId, status: done };
		}
	},
	{
		name: 'append_issue_note',
		category: 'issues',
		summary: 'Add a paragraph (progress note, findings, comment) to an issue\'s body.',
		keywords: ['comment', 'note', 'progress update', 'log work', 'add details', 'description'],
		inputSchema: {
			type: 'object',
			properties: {
				project: PROJECT_PROP,
				issueId: ISSUE_PROP,
				note: { type: 'string', description: 'Plain text; multiple lines allowed.' }
			},
			required: ['issueId', 'note'],
			additionalProperties: false
		},
		example: { project: 'Shop.p', issueId: 'i-4', note: 'Root cause: retry loop has no backoff.' },
		async handler(args, ctx) {
			const { issueId, uri } = await loadIssueContext(ctx, args);
			await editNote(ctx, uri, text => appendIssueNoteText(text, issueId, String(args.note || ''), formatFromPath(uri.fsPath)));
			return { appendedTo: issueId };
		}
	},
	{
		name: 'get_issue_tree',
		category: 'hierarchy',
		summary: 'Show the sub-issues (children, grandchildren…) of an issue, or the whole project issue tree.',
		keywords: ['sub issues of', 'children of an issue', 'hierarchy', 'tree', 'breakdown', 'nested issues', 'what is under'],
		inputSchema: {
			type: 'object',
			properties: {
				project: PROJECT_PROP,
				issueId: { type: 'string', description: 'Optional root issue id; omit for the whole project.' },
				includeCompleted: { type: 'boolean', description: 'Include completed issues (default false).' }
			},
			additionalProperties: false
		},
		example: { project: 'Shop.p', issueId: 'i-4' },
		async handler(args, ctx) {
			const kb = requireKbRoot(ctx);
			const project = await resolveProject(kb, args.project);
			const { issues } = await loadProjectChildren(kb, project);
			const root = args.issueId ? requireIssueId(args.issueId) : null;
			if (root) findIssueRow(issues, root);
			return { tree: buildForest(issues, root, !!args.includeCompleted) };
		}
	},
	{
		name: 'set_issue_parent',
		category: 'hierarchy',
		summary:
			'Link an issue to a parent issue anywhere in the project (writes "parent: i-N"); empty parent clears it. Not allowed when the parent is implied by indentation.',
		keywords: ['parent', 'link issue', 'make sub-issue', 'reparent', 'nest under', 'unlink parent'],
		inputSchema: {
			type: 'object',
			properties: {
				project: PROJECT_PROP,
				issueId: ISSUE_PROP,
				parent: { type: 'string', description: 'Parent issue id, or "" to remove the link.' }
			},
			required: ['issueId', 'parent'],
			additionalProperties: false
		},
		example: { project: 'Shop.p', issueId: 'i-9', parent: 'i-4' },
		async handler(args, ctx) {
			const { issueId, uri, children } = await loadIssueContext(ctx, args);
			const text = await readNoteText(uri);
			const fmt = formatFromPath(uri.fsPath);
			const block = readIssueBlock(text, issueId, fmt);
			if (!block) throw new ToolError(`Issue ${issueId} not found in its file.`);
			const {
				findNearestOutlineAncestorIssueId,
				validateIssueParentChoice
			} = require('../../../document/project/issueParentLink');
			const locked = findNearestOutlineAncestorIssueId(text, block.headingLine, fmt);
			const res = validateIssueParentChoice({
				selfKey: issueId,
				candidate: String(args.parent || ''),
				lockedParent: locked,
				projectIssues: children.issues.map(i => ({ issueKey: i.issueKey, parentIssueKey: i.parentIssueKey }))
			});
			if (!res.ok) throw new ToolError(res.error || 'Invalid parent.');
			await editNote(ctx, uri, t => updateIssueBlockText(t, issueId, { attributes: { parent: res.value } }, fmt));
			if (locked) return { issueId, parent: locked, note: `Parent is implied by indentation (${locked}).` };
			return { issueId, parent: res.value || null };
		}
	},
	{
		name: 'assign_issue_to_feature',
		category: 'hierarchy',
		summary: 'Move an inbox issue (from _issues.d.txt) into a feature\'s _inbox mailbox; parent links are kept.',
		keywords: ['assign', 'move issue', 'triage', 'sort inbox', 'put in feature', 'categorize'],
		inputSchema: {
			type: 'object',
			properties: {
				project: PROJECT_PROP,
				issueId: ISSUE_PROP,
				feature: { type: 'string', description: 'Feature name, f-N, or path.' }
			},
			required: ['issueId', 'feature'],
			additionalProperties: false
		},
		example: { project: 'Shop.p', issueId: 'i-7', feature: 'Payments' },
		async handler(args, ctx) {
			const { kb, project, children, issueId, row } = await loadIssueContext(ctx, args);
			if (!row.inProjectInbox) {
				throw new ToolError(`${issueId} is not in the project inbox (it is in ${row.path}). Only inbox issues can be assigned.`);
			}
			const feature = resolveFeature(children.features, args.feature);
			const featureUri = uriFromRel(kb, feature.folderPrefix || feature.path);
			const { moveIssueToFeatureMailbox } = require('../../../document/project/projectIssuesMailbox');
			const res = await moveIssueToFeatureMailbox(kb, uriFromRel(kb, project.folderPrefix), featureUri, issueId, {
				context: ctx.extensionContext
			});
			ctx.refreshUi();
			return { moved: issueId, to: relOf(kb, res.mailboxUri), feature: feature.title };
		}
	},
	{
		name: 'search_issues',
		category: 'search',
		summary: 'Find issues about a topic by meaning: duplicates, similar or related bugs (semantic search).',
		keywords: ['search issues', 'find issues about', 'duplicate bugs', 'similar issues', 'related tickets', 'semantic'],
		inputSchema: {
			type: 'object',
			properties: {
				project: PROJECT_PROP,
				query: { type: 'string', description: 'What to look for, in natural language.' },
				limit: { type: 'integer', description: 'Max results (default 10).' },
				fields: fieldsPropFor('search_issues')
			},
			required: ['query'],
			additionalProperties: false
		},
		example: { project: 'Shop.p', query: 'checkout fails when card is declined' },
		async handler(args, ctx) {
			const kb = requireKbRoot(ctx);
			const project = await resolveProject(kb, args.project);
			const { issues } = await loadProjectChildren(kb, project);
			const query = String(args.query || '').trim();
			if (!query) throw new ToolError('"query" is required.');
			const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));

			/** @type {Map<string, number>} */
			const semantic = new Map();
			let ranking = 'keyword';
			try {
				const { searchHeadingsByEmbedding } = require('../../../indexing/embeddings/headingEmbeddingSearch');
				const { hits } = await searchHeadingsByEmbedding(kb, query, { limit: 200 });
				const byHeading = new Map(issues.map(i => [`${i.fileId}:${i.headingId}`, i.issueKey]));
				for (const h of hits || []) {
					const key = byHeading.get(`${Number(h.file_id)}:${Number(h.heading_id)}`);
					if (key && !semantic.has(key)) semantic.set(key, Number(h.score) || 0);
				}
				if (semantic.size) ranking = 'semantic+keyword';
			} catch (err) {
				console.warn('[DRIP MCP] semantic issue search unavailable', err && err.message);
			}

			const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1);
			const scored = issues
				.map(i => {
					const title = String(i.title || '').toLowerCase();
					const kw = tokens.length ? tokens.filter(t => title.includes(t)).length / tokens.length : 0;
					const sem = semantic.get(i.issueKey) || 0;
					return { i, score: semantic.size ? 0.75 * sem + 0.25 * kw : kw };
				})
				.filter(s => s.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, limit);
			return {
				ranking,
				issues: scored.map(s => ({ ...issueSummary(s.i), score: Number(s.score.toFixed(3)) }))
			};
		}
	}
];

module.exports = { ISSUE_TOOLS };
