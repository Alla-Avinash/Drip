'use strict';

/**
 * Hidden DRIP tool catalog. Not listed to MCP clients directly — found via `search_tools`,
 * executed via `call_tool`. Add a tool = add a card to one of `tools/*.js`.
 */

const crypto = require('crypto');
const { PROJECT_TOOLS } = require('./tools/projectTools');
const { ISSUE_TOOLS } = require('./tools/issueTools');
const { SYSTEM_TOOLS } = require('./tools/systemTools');

/**
 * @typedef {{
 *   name: string,
 *   category: 'projects' | 'features' | 'issues' | 'hierarchy' | 'search' | 'system',
 *   summary: string,
 *   keywords: string[],
 *   inputSchema: Record<string, any>,
 *   example: Record<string, unknown>,
 *   handler: (args: Record<string, any>, ctx: import('./tools/toolShared').ToolContext) => Promise<unknown>
 * }} ToolCard
 */

/** @type {ToolCard[]} */
const TOOL_CARDS = [...PROJECT_TOOLS, ...ISSUE_TOOLS, ...SYSTEM_TOOLS];

/** @type {Map<string, ToolCard>} */
const BY_NAME = new Map(TOOL_CARDS.map(c => [c.name, c]));

const CATEGORIES = Object.freeze(['projects', 'features', 'issues', 'hierarchy', 'search', 'system']);

/** @returns {ToolCard[]} */
function listToolCards() {
	return TOOL_CARDS;
}

/**
 * @param {string} name
 * @returns {ToolCard | undefined}
 */
function getToolCard(name) {
	return BY_NAME.get(String(name || '').trim());
}

/**
 * Text that is embedded / keyword-matched for `search_tools`.
 * @param {ToolCard} card
 */
function cardSearchText(card) {
	const params = Object.entries((card.inputSchema && card.inputSchema.properties) || {})
		.map(([k, v]) => `${k}: ${(v && v.description) || ''}`)
		.join('; ');
	return [
		card.name.replace(/_/g, ' '),
		`category: ${card.category}`,
		card.summary,
		`keywords: ${card.keywords.join(', ')}`,
		params ? `inputs: ${params}` : ''
	]
		.filter(Boolean)
		.join('\n');
}

/**
 * Changes whenever the searchable text changes → stale vector is re-embedded.
 * @param {ToolCard} card
 */
function cardHash(card) {
	return crypto.createHash('sha1').update(cardSearchText(card)).digest('hex').slice(0, 16);
}

/**
 * Wire shape returned by `search_tools`.
 * @param {ToolCard} card
 * @param {number} [score]
 */
function toolCardForClient(card, score) {
	/** @type {Record<string, unknown>} */
	const out = {
		name: card.name,
		category: card.category,
		description: card.summary,
		inputSchema: card.inputSchema,
		example: { name: card.name, arguments: card.example }
	};
	if (score != null) out.score = Number(score.toFixed(3));
	return out;
}

module.exports = {
	CATEGORIES,
	listToolCards,
	getToolCard,
	cardSearchText,
	cardHash,
	toolCardForClient
};
