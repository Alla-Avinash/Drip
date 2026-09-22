'use strict';

/**
 * Embedding input field recipes to compare.
 * Production default today: `title_tags` (see headingEmbeddingText.js).
 */

/** @typedef {'title' | 'tags' | 'ancestors' | 'body'} EmbeddingField */

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   fields: EmbeddingField[],
 *   description: string
 * }} EmbeddingRecipe
 */

/** @type {EmbeddingRecipe[]} */
const RECIPES = [
	{
		id: 'title',
		label: 'title only',
		fields: ['title'],
		description: 'Heading title alone'
	},
	{
		id: 'title_tags',
		label: 'title + tags (production)',
		fields: ['title', 'tags'],
		description: 'Current DRIP policy: title + semantic tags'
	},
	{
		id: 'title_ancestors',
		label: 'title + ancestors',
		fields: ['title', 'ancestors'],
		description: 'Title plus parent heading titles'
	},
	{
		id: 'title_tags_ancestors',
		label: 'title + tags + ancestors',
		fields: ['title', 'tags', 'ancestors'],
		description: 'Hierarchy context without body'
	},
	{
		id: 'title_tags_body',
		label: 'title + tags + body',
		fields: ['title', 'tags', 'body'],
		description: 'Title, tags, and heading body text'
	},
	{
		id: 'title_tags_ancestors_body',
		label: 'title + tags + ancestors + body',
		fields: ['title', 'tags', 'ancestors', 'body'],
		description: 'Maximal text (slowest encode; more churn on edits)'
	}
];

/**
 * @param {{
 *   title?: string,
 *   tags?: string[],
 *   ancestors?: string[],
 *   body?: string
 * }} doc
 * @param {EmbeddingField[]} fields
 * @returns {string}
 */
function buildTextForFields(doc, fields) {
	/** @type {string[]} */
	const parts = [];
	const set = new Set(fields || []);

	if (set.has('title')) {
		const t = String(doc.title || '')
			.replace(/\s+/g, ' ')
			.trim();
		if (t) parts.push(t);
	}
	if (set.has('ancestors')) {
		const anc = (doc.ancestors || [])
			.map(a =>
				String(a || '')
					.replace(/\s+/g, ' ')
					.trim()
			)
			.filter(Boolean);
		if (anc.length) parts.push(anc.join(' > '));
	}
	if (set.has('tags')) {
		const tags = [...new Set((doc.tags || []).map(t => String(t || '').trim().toLowerCase()).filter(Boolean))].sort();
		if (tags.length) parts.push(tags.join(', '));
	}
	if (set.has('body')) {
		const body = String(doc.body || '')
			.replace(/\s+/g, ' ')
			.trim();
		if (body) parts.push(body.slice(0, 800));
	}
	return parts.join('\n');
}

/**
 * @param {string} recipeId
 * @returns {EmbeddingRecipe}
 */
function getRecipe(recipeId) {
	const r = RECIPES.find(x => x.id === recipeId);
	if (!r) {
		throw new Error(`Unknown recipe: ${recipeId}`);
	}
	return r;
}

module.exports = {
	RECIPES,
	buildTextForFields,
	getRecipe
};
