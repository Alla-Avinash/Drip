'use strict';

/**
 * Small labeled synthetic corpus for field / search benchmarks.
 * Each item has a `probeQuery` that should rank that item near the top
 * when the recipe includes the right fields.
 */

/** @typedef {{
 *   id: string,
 *   title: string,
 *   tags: string[],
 *   ancestors: string[],
 *   body: string,
 *   probeQuery: string
 * }} BenchDoc */

/** @type {BenchDoc[]} */
const CORPUS = [
	{
		id: 'react-hooks',
		title: 'React hooks',
		tags: ['react', 'frontend'],
		ancestors: ['Web', 'UI frameworks'],
		body: 'useState and useEffect patterns for local component state and side effects.',
		probeQuery: 'react useState hooks'
	},
	{
		id: 'sqlite-index',
		title: 'SQLite index design',
		tags: ['sqlite', 'database'],
		ancestors: ['Storage', 'Persistence'],
		body: 'B-tree indexes, covering queries, and when to avoid over-indexing writes.',
		probeQuery: 'sqlite b-tree index'
	},
	{
		id: 'faiss-ann',
		title: 'FAISS approximate search',
		tags: ['faiss', 'embeddings', 'ann'],
		ancestors: ['Retrieval', 'Vectors'],
		body: 'HNSW graphs trade exact nearest neighbors for faster approximate search at scale.',
		probeQuery: 'hnsw approximate nearest neighbor'
	},
	{
		id: 'kb-folders',
		title: 'Knowledge base folders',
		tags: ['drip', 'organization'],
		ancestors: ['DRIP', 'Knowledge base'],
		body: 'Folder paths and folder h0 titles drive folder-level semantic placement.',
		probeQuery: 'organize notes into folders'
	},
	{
		id: 'metadata-types',
		title: 'Metadata type markers',
		tags: ['dripnote', 'metadata'],
		ancestors: ['DRIP', 'Editor'],
		body: 'Typed headings use .task .issue .concept markers with template keys.',
		probeQuery: 'dripnote task metadata marker'
	},
	{
		id: 'embedding-input',
		title: 'Heading embedding input',
		tags: ['embeddings', 'search'],
		ancestors: ['DRIP', 'Retrieval'],
		body: 'Production embeds heading title plus semantic tags only; body excluded to limit churn.',
		probeQuery: 'what text goes into heading embeddings'
	},
	{
		id: 'daily-notes',
		title: 'Daily notes layout',
		tags: ['journal', 'daily'],
		ancestors: ['Workflow'],
		body: 'Year and month folders under dailynotes.drip with one file per day.',
		probeQuery: 'daily journal note folders'
	},
	{
		id: 'tag-graph',
		title: 'Tag graph relations',
		tags: ['tags', 'graph'],
		ancestors: ['Graph'],
		body: 'Relations link tags across notes for exploration in the tags panel.',
		probeQuery: 'tag relationship graph'
	}
];

/**
 * Expand corpus by cloning with numeric suffixes (for scale tests).
 * @param {number} n
 * @returns {BenchDoc[]}
 */
function expandCorpus(n) {
	const out = [];
	const target = Math.max(1, Number(n) || CORPUS.length);
	for (let i = 0; i < target; i++) {
		const base = CORPUS[i % CORPUS.length];
		const copy = i < CORPUS.length ? 0 : Math.floor(i / CORPUS.length);
		out.push({
			...base,
			id: copy === 0 ? base.id : `${base.id}__${copy}_${i}`,
			title: copy === 0 ? base.title : `${base.title} (${copy})`,
			body: copy === 0 ? base.body : `${base.body} variant ${copy}`
		});
	}
	return out;
}

module.exports = {
	CORPUS,
	expandCorpus
};
