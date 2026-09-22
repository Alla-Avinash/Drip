#!/usr/bin/env node
'use strict';

/**
 * DRIP embedding benchmarks
 *
 *   node benchmarks/run.js
 *   node benchmarks/run.js --real
 *   node benchmarks/run.js --fields | --search | --backends | --all
 */

const fs = require('fs');
const path = require('path');
const { RECIPES } = require('./recipes');
const { CORPUS } = require('./corpus');
const { embedCorpusWithRecipe, measureProbeRetrieval } = require('./lib/encode');
const {
	runSearchScaleBenchmark,
	runSearchBackendsBenchmark
} = require('./lib/search');

function parseArgs(argv) {
	const args = new Set(argv.slice(2));
	const realModel = args.has('--real');
	const all = args.has('--all');
	const onlyFields = args.has('--fields');
	const onlySearch = args.has('--search');
	const onlyBackends = args.has('--backends');
	const none = !onlyFields && !onlySearch && !onlyBackends && !all;
	return {
		realModel,
		fields: all || onlyFields || none,
		search: all || onlySearch || none,
		backends: all || onlyBackends
	};
}

function printTable(headers, rows) {
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map(r => String(r[i] == null ? '' : r[i]).length))
	);
	const line = cells =>
		cells.map((c, i) => String(c == null ? '' : c).padEnd(widths[i])).join('  ');
	console.log(line(headers));
	console.log(widths.map(w => '-'.repeat(w)).join('  '));
	for (const row of rows) console.log(line(row));
}

/**
 * @param {{ realModel: boolean }} opts
 */
async function runFieldBenchmarks(opts) {
	console.log('\n=== Field recipes (embedding input text) ===');
	console.log(
		opts.realModel
			? 'Mode: REAL MiniLM (extension .cache/transformers)'
			: 'Mode: FAST fake vectors — use --real for meaningful hit rates'
	);
	console.log(`Corpus: ${CORPUS.length} labeled docs\n`);

	/** @type {object[]} */
	const summary = [];

	for (const recipe of RECIPES) {
		process.stdout.write(`  ${recipe.id} … `);
		const embedded = await embedCorpusWithRecipe(CORPUS, recipe, {
			realModel: opts.realModel,
			encodeRuns: opts.realModel ? 1 : 3
		});
		const probe = await measureProbeRetrieval(CORPUS, recipe, embedded.items, {
			realModel: opts.realModel
		});
		console.log(
			`encode=${embedded.avgEncodeMsPerDoc}ms  chars=${embedded.avgChars}  hit@1=${probe.hitAt1Rate}  hit@3=${probe.hitAt3Rate}  avgRank=${probe.avgRank}`
		);
		summary.push({
			recipeId: recipe.id,
			label: recipe.label,
			fields: recipe.fields,
			description: recipe.description,
			avgChars: embedded.avgChars,
			avgEncodeMsPerDoc: embedded.avgEncodeMsPerDoc,
			hitAt1Rate: probe.hitAt1Rate,
			hitAt3Rate: probe.hitAt3Rate,
			avgRank: probe.avgRank,
			productionDefault: recipe.id === 'title_tags'
		});
	}

	console.log('\nComparison table:');
	printTable(
		['recipe', 'fields', 'chars', 'encode_ms', 'hit@1', 'hit@3', 'avgRank'],
		summary.map(s => [
			s.recipeId + (s.productionDefault ? ' *' : ''),
			s.fields.join('+'),
			s.avgChars,
			s.avgEncodeMsPerDoc,
			s.hitAt1Rate,
			s.hitAt3Rate,
			s.avgRank
		])
	);
	console.log('  * = production default (title + tags)');
	return { kind: 'field_recipes', realModel: opts.realModel, corpusSize: CORPUS.length, summary };
}

async function main() {
	const opts = parseArgs(process.argv);
	const started = new Date().toISOString();
	/** @type {Record<string, unknown>} */
	const report = {
		started,
		node: process.version,
		platform: `${process.platform}-${process.arch}`,
		opts,
		sections: {}
	};

	console.log('DRIP embedding benchmarks');
	console.log(`  ${started}  node ${process.version}  ${process.platform}/${process.arch}`);

	if (opts.fields) {
		report.sections.fields = await runFieldBenchmarks({ realModel: opts.realModel });
	}

	if (opts.search) {
		console.log('\n=== Search scale: exact (brute) vs FAISS HNSW ===');
		const scale = await runSearchScaleBenchmark({
			sizes: [100, 500, 1000, 2000, 5000],
			k: 10,
			runs: 5
		});
		printTable(
			['n', 'exact_ms', 'faiss_ms', 'speedup', 'faiss_recall@10', 'note'],
			scale.rows.map(r => [
				r.vectorCount,
				r.exactMsAvg,
				r.faissMsAvg,
				r.speedup,
				r.faissRecallAtK,
				r.thresholdNote
			])
		);
		report.sections.searchScale = scale;
	}

	if (opts.backends) {
		console.log('\n=== Search backends: brute vs sqlite-vec vs FAISS ===');
		const backends = await runSearchBackendsBenchmark({
			sizes: [100, 1000, 2000],
			k: 10,
			runs: 3
		});
		printTable(
			['n', 'brute_ms', 'sqlite_vec_ms', 'faiss_ms', 'faiss_recall@10'],
			backends.rows.map(r => [
				r.vectorCount,
				r.bruteMsAvg,
				r.sqliteVecMsAvg,
				r.faissMsAvg,
				r.faissRecallAtK
			])
		);
		report.sections.searchBackends = backends;
	}

	report.finished = new Date().toISOString();
	const outDir = path.join(__dirname, 'results');
	fs.mkdirSync(outDir, { recursive: true });
	const stamp = started.replace(/[:.]/g, '-');
	const outPath = path.join(outDir, `bench-${stamp}.json`);
	fs.writeFileSync(outPath, JSON.stringify(report, null, '\t'), 'utf8');
	console.log(`\nWrote ${outPath}`);
}

main().catch(err => {
	console.error('\nFATAL:', err && err.stack ? err.stack : err);
	process.exitCode = 1;
});
