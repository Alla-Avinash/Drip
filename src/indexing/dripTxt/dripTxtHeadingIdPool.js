'use strict';

const { collectHeadingSequenceValidated } = require('../../document/parse/dripTxt/dripTxtHeadingParse.js');
const {
	findH0HeadingLine,
	findHeadingIdentityForNode,
	isH0HeadingNode,
	parseFileEntityFromLines
} = require('./dripTxtHeadingIdentity.js');

/**
 * @typedef {{
 *   used: Set<number>,
 *   free: number[],
 *   nextId: number,
 *   headingsCount: number
 * }} HeadingIdPool
 */

/**
 * @param {string[]} lines
 * @returns {number}
 */
function parseHeadingsCountFromLines(lines) {
	for (const line of lines || []) {
		const trimmed = String(line || '').trim();
		if (trimmed === '---') break;
		const m = /^\s*headings\s*:\s*(\d+)/i.exec(String(line || ''));
		if (m) {
			const n = parseInt(m[1], 10);
			return Number.isFinite(n) ? Math.max(0, n) : 0;
		}
	}
	return 0;
}

/**
 * Build in-memory heading id pool from note text (no DB).
 *
 * @param {string} text
 * @returns {HeadingIdPool}
 */
function buildHeadingIdPoolFromText(text) {
	const normalized = String(text || '').replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');
	const { nodes } = collectHeadingSequenceValidated(lines, 0);
	const titled = nodes.filter(node => /\S/.test(String(node.title || '').trim()));

	const h0LineIndex = findH0HeadingLine(lines);

	/** @type {Set<number>} */
	const used = new Set();
	for (const node of titled) {
		if (isH0HeadingNode(node, h0LineIndex)) continue;
		const attached = findHeadingIdentityForNode(lines, node);
		const num = attached && attached.parsed.headingNum > 0 ? attached.parsed.headingNum : null;
		if (num != null) {
			used.add(num);
		}
	}

	const headingsCount = parseHeadingsCountFromLines(lines);
	let maxUsed = 0;
	for (const id of used) maxUsed = Math.max(maxUsed, id);

	/** @type {number[]} */
	const free = [];
	for (let i = 1; i <= maxUsed; i++) {
		if (!used.has(i)) free.push(i);
	}

	return {
		used,
		free,
		nextId: Math.max(maxUsed + 1, headingsCount + 1, 1),
		headingsCount
	};
}

/**
 * @param {HeadingIdPool} pool
 * @param {Iterable<number>} usedNonH0Ids
 * @param {number} [headingsCount]
 */
function syncHeadingIdPoolFromUsedIds(pool, usedNonH0Ids, headingsCount) {
	/** @type {Set<number>} */
	const used = new Set();
	for (const raw of usedNonH0Ids || []) {
		const n = Math.floor(Number(raw) || 0);
		if (n > 0) used.add(n);
	}
	pool.used = used;

	let maxUsed = 0;
	for (const id of used) maxUsed = Math.max(maxUsed, id);

	/** @type {number[]} */
	const free = [];
	for (let i = 1; i <= maxUsed; i++) {
		if (!used.has(i)) free.push(i);
	}
	pool.free = free;

	const count =
		headingsCount != null && Number.isFinite(headingsCount)
			? Math.max(0, Math.floor(headingsCount))
			: pool.headingsCount;
	pool.headingsCount = count;
	pool.nextId = Math.max(maxUsed + 1, count + 1, 1);
}

/**
 * @param {HeadingIdPool} pool
 * @returns {{ next: number, free: number[] }}
 */
function headingIdPoolToAllocator(pool) {
	return {
		next: pool.nextId,
		free: [...(pool.free || [])]
	};
}

/**
 * @param {HeadingIdPool} pool
 * @param {{ next: number, free: number[] }} alloc
 * @param {Iterable<number>} usedNonH0Ids
 * @param {number} [headingsCount]
 */
function syncHeadingIdPoolFromAllocator(pool, alloc, usedNonH0Ids, headingsCount) {
	syncHeadingIdPoolFromUsedIds(pool, usedNonH0Ids, headingsCount);
	pool.nextId = Math.max(
		pool.nextId,
		Number.isFinite(alloc.next) && alloc.next > 0 ? alloc.next : pool.nextId
	);
	for (const id of alloc.free || []) {
		const n = Math.floor(Number(id) || 0);
		if (n > 0 && !pool.used.has(n) && !pool.free.includes(n)) {
			pool.free.push(n);
		}
	}
	pool.free.sort((a, b) => a - b);
}

module.exports = {
	buildHeadingIdPoolFromText,
	syncHeadingIdPoolFromUsedIds,
	headingIdPoolToAllocator,
	syncHeadingIdPoolFromAllocator,
	parseHeadingsCountFromLines
};
