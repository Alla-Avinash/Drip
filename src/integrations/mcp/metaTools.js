'use strict';

/**
 * MCP tool surface: a short list of standard tools (advertised directly in `tools/list`) plus
 * `search_tools` (find any catalog tool + its schema) and `call_tool` (run any catalog tool).
 * Responses are projected to a lean shape via `responseSchema.js`.
 */

const { CATEGORIES, listToolCards, getToolCard, toolCardForClient } = require('./toolCatalog');
const { searchToolCards } = require('./toolEmbeddings');
const { ROUTER_GUIDE } = require('./routerGuide');
const { ToolError } = require('./tools/toolShared');
const { parseFields, project } = require('./responseSchema');
const { getMetadataSettings, getTypeRule } = require('../../document/model/dripNoteMetadataTemplates.js');

/**
 * High-value tools advertised directly in MCP `tools/list` (no search_tools round-trip).
 * Everything else stays discoverable via search_tools. Keep this list short and read-only-ish.
 */
const STANDARD_TOOL_NAMES = [
	'list_projects',
	'list_issues',
	'get_issue',
	'create_issue',
	'update_issue',
	'search_issues',
	'get_status'
];

/**
 * Live enum values for an issue metadata key, from DRIP settings (`drip.metadataTypes`).
 * @param {string} key
 * @returns {string[] | null} null when the key is not an enum in settings.
 */
function issueEnumValues(key) {
	try {
		const rule = getTypeRule(getMetadataSettings(), 'issue', key);
		return rule && Array.isArray(rule.values) && rule.values.length ? rule.values.map(String) : null;
	} catch (err) {
		return null;
	}
}

/**
 * Enrich an issue tool's input schema with the live enum values for status/priority/category
 * from DRIP settings, so `tools/list` never serves stale allowed values. Returns a fresh object.
 * @param {Record<string, any>} inputSchema
 * @returns {Record<string, any>}
 */
function enrichIssueToolSchema(inputSchema) {
	if (!inputSchema || inputSchema.type !== 'object' || !inputSchema.properties) return inputSchema;
	const schema = JSON.parse(JSON.stringify(inputSchema));
	for (const key of ['status', 'priority', 'category']) {
		const prop = schema.properties && schema.properties[key];
		if (!prop || prop.type !== 'string') continue;
		const values = issueEnumValues(key);
		if (values) prop.enum = values;
		else delete prop.enum;
	}
	return schema;
}

/** @returns {{ name: string, description: string, inputSchema: Record<string, any> }[]} */
function standardToolDefs() {
	return STANDARD_TOOL_NAMES.map(name => {
		const card = getToolCard(name);
		if (!card) return null;
		return { name: card.name, description: card.summary, inputSchema: enrichIssueToolSchema(card.inputSchema) };
	}).filter(Boolean);
}

/**
 * Minimal JSON-schema check for tool arguments (object / string / integer / number / boolean / enum).
 * @param {Record<string, any>} schema
 * @param {unknown} input
 * @returns {{ ok: true, value: Record<string, any> } | { ok: false, errors: string[] }}
 */
function validateArgs(schema, input) {
	const args = input == null ? {} : input;
	if (typeof args !== 'object' || Array.isArray(args)) return { ok: false, errors: ['arguments must be an object'] };
	const props = (schema && schema.properties) || {};
	/** @type {string[]} */
	const errors = [];
	/** @type {Record<string, any>} */
	const value = {};
	for (const req of (schema && schema.required) || []) {
		const v = /** @type {any} */ (args)[req];
		if (v == null || v === '') errors.push(`missing required "${req}"`);
	}
	for (const [key, raw] of Object.entries(args)) {
		const spec = props[key];
		if (!spec) {
			errors.push(`unknown argument "${key}" (allowed: ${Object.keys(props).join(', ') || 'none'})`);
			continue;
		}
		let v = raw;
		if (spec.type === 'integer' || spec.type === 'number') {
			if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) v = Number(v);
			if (typeof v !== 'number' || !Number.isFinite(v) || (spec.type === 'integer' && !Number.isInteger(v))) {
				errors.push(`"${key}" must be ${spec.type === 'integer' ? 'an integer' : 'a number'}`);
				continue;
			}
		} else if (spec.type === 'boolean') {
			if (v === 'true' || v === 'false') v = v === 'true';
			if (typeof v !== 'boolean') {
				errors.push(`"${key}" must be true or false`);
				continue;
			}
		} else if (spec.type === 'string') {
			if (typeof v === 'number') v = String(v);
			if (typeof v !== 'string') {
				errors.push(`"${key}" must be a string`);
				continue;
			}
		}
		if (Array.isArray(spec.enum) && !spec.enum.includes(v)) {
			errors.push(`"${key}" must be one of: ${spec.enum.join(', ')}`);
			continue;
		}
		value[key] = v;
	}
	return errors.length ? { ok: false, errors } : { ok: true, value };
}

/**
 * @typedef {{ ok: true, data: unknown } | { ok: false, error: string, data?: unknown }} MetaResult
 */

const SEARCH_TOOLS_DEF = {
	name: 'search_tools',
	description: `Find DRIP tools for a task and get their exact input schemas. Call this before call_tool whenever you need a capability.\n\n${ROUTER_GUIDE}`,
	inputSchema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'What you want to do, e.g. "move issue to a feature".' },
			category: { type: 'string', enum: [...CATEGORIES], description: 'Optional: restrict to one category.' },
			limit: { type: 'integer', description: 'Max tools to return (default 5).' }
		},
		additionalProperties: false
	}
};

const CALL_TOOL_DEF = {
	name: 'call_tool',
	description:
		'Run a DRIP tool found via search_tools. Pass the tool name and arguments matching its inputSchema. On bad input the error includes the correct schema.',
	inputSchema: {
		type: 'object',
		properties: {
			name: { type: 'string', description: 'Tool name from search_tools, e.g. "create_issue".' },
			arguments: { type: 'object', description: 'Arguments for that tool.' }
		},
		required: ['name'],
		additionalProperties: false
	}
};

/**
 * Tools advertised in MCP `tools/list`: the standard set + the meta tools.
 * Rebuilt on every call so enum values always reflect current DRIP settings.
 * @returns {any[]}
 */
function buildMetaToolDefs() {
	return [...standardToolDefs(), SEARCH_TOOLS_DEF, CALL_TOOL_DEF];
}

/**
 * @param {Record<string, any>} args
 * @param {import('./tools/toolShared').ToolContext} ctx
 * @returns {Promise<MetaResult>}
 */
async function runSearchTools(args, ctx) {
	const check = validateArgs(SEARCH_TOOLS_DEF.inputSchema, args);
	if (!check.ok) return { ok: false, error: `search_tools: ${check.errors.join('; ')}` };
	const { query, category, limit } = check.value;
	if (!query && !category) {
		return {
			ok: true,
			data: {
				hint: 'Pass "query" (or "category") to get tool schemas.',
				categories: CATEGORIES.map(c => ({
					category: c,
					tools: listToolCards()
						.filter(t => t.category === c)
						.map(t => t.name)
				}))
			}
		};
	}
	const found = await searchToolCards(query || '', { category, limit, kbRoot: ctx.getKbRoot() });
	return {
		ok: true,
		data: {
			ranking: found.ranking,
			tools: found.results.map(r =>
				toolCardForClient({ ...r.card, inputSchema: enrichIssueToolSchema(r.card.inputSchema) }, r.score)
			),
			next: 'call_tool({ name, arguments })'
		}
	};
}

/**
 * @param {string} name
 * @param {Record<string, any>} rawArgs
 * @param {import('./tools/toolShared').ToolContext} ctx
 * @returns {Promise<MetaResult>}
 */
async function runCatalogTool(name, rawArgs, ctx) {
	const card = getToolCard(name);
	if (!card) {
		const guess = await searchToolCards(String(name || '').replace(/[_-]+/g, ' '), {
			limit: 3,
			kbRoot: ctx.getKbRoot()
		});
		return {
			ok: false,
			error: `Unknown tool "${name}". Did you mean: ${guess.results.map(r => r.card.name).join(', ')}? Use search_tools to get schemas.`,
			data: { suggestions: guess.results.map(r => toolCardForClient(r.card)) }
		};
	}
	const check = validateArgs(card.inputSchema, rawArgs);
	if (!check.ok) {
		return {
			ok: false,
			error: `${card.name}: ${check.errors.join('; ')}`,
			data: { expected: toolCardForClient(card) }
		};
	}
	try {
		const fields = parseFields(card.name, check.value.fields);
		const raw = await card.handler(check.value, ctx, fields);
		return { ok: true, data: project(card.name, fields, raw) };
	} catch (err) {
		if (err instanceof ToolError) return { ok: false, error: err.message };
		console.error(`[DRIP MCP] ${card.name} failed`, err);
		return { ok: false, error: `${card.name} failed: ${err && err.message ? err.message : String(err)}` };
	}
}

/**
 * Dispatch an MCP `tools/call`. Catalog tools called directly by name are accepted too
 * (lenient, so a model that skips call_tool still works).
 * @param {string} name
 * @param {Record<string, any>} args
 * @param {import('./tools/toolShared').ToolContext} ctx
 * @returns {Promise<MetaResult>}
 */
async function dispatchToolCall(name, args, ctx) {
	if (name === SEARCH_TOOLS_DEF.name) return runSearchTools(args || {}, ctx);
	if (name === CALL_TOOL_DEF.name) {
		const a = { ...(args || {}) };
		if (typeof a.arguments === 'string') {
			try {
				a.arguments = a.arguments.trim() ? JSON.parse(a.arguments) : {};
			} catch {
				return { ok: false, error: 'call_tool: "arguments" must be a JSON object.' };
			}
		}
		const check = validateArgs(CALL_TOOL_DEF.inputSchema, a);
		if (!check.ok) return { ok: false, error: `call_tool: ${check.errors.join('; ')}` };
		return runCatalogTool(String(check.value.name), check.value.arguments || {}, ctx);
	}
	return runCatalogTool(name, args || {}, ctx);
}

module.exports = {
	buildMetaToolDefs,
	dispatchToolCall,
	validateArgs
};
