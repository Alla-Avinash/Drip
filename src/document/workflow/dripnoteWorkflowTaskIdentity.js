'use strict';

const { collectHeadingSequenceValidated, splitFileTopRegion, buildHeadingTree } = require('../parse/dripnoteCanvasParse');
const { parseHeadingIdentityLine, parseFileEntityFromLines } = require('../../indexing/dripnoteHeadingIdentity');
const {
	readWorkflowTaskAllocator,
	syncWorkflowTaskAllocatorFromUsedIds
} = require('../../indexing/dripIndexDb');
const {
	headingIsWorkflow,
	headingIsWorkflowTask,
	parseTaskIdFromTitle,
	ensureTaskIdInHeadingLine,
	stripTaskIdFromHeadingLine,
	findWorkflowRoots,
	rewriteParentLineIds,
	rewriteParentLineToIds,
	collectWorkflowTasks
} = require('./dripnoteWorkflowParse');

/**
 * @param {string[]} lines
 * @param {number} headingLineIndex
 * @returns {number | null}
 */
function readHeadingNumAbove(lines, headingLineIndex) {
	for (let i = headingLineIndex - 1; i >= 0; i--) {
		const id = parseHeadingIdentityLine(lines[i]);
		if (id) return id.headingNum;
		const t = String(lines[i] || '').trim();
		if (/^#{1,6}\s+/.test(t)) break;
	}
	return null;
}

/**
 * Collect tasks belonging to one workflow root (document order).
 * Only contiguous task chains from the workflow: a non-task heading (`.c`, `.f`, …)
 * breaks the chain — descendant tasks under that break are not numbered.
 * Nested `workflow: true` nodes count as one outer task; their children belong to the nested wf.
 * @param {any} root
 * @param {string} taskMarker
 * @param {string[]} lines
 * @returns {{ lineIndex: number, oldId: number | null, headingNum: number | null }[]}
 */
function collectWorkflowTaskSlots(root, taskMarker, lines) {
	/** @type {{ lineIndex: number, oldId: number | null, headingNum: number | null }[]} */
	const slots = [];

	/**
	 * @param {any} node
	 */
	function pushSlot(node) {
		slots.push({
			lineIndex: node.lineIndex,
			oldId: parseTaskIdFromTitle(node.title),
			headingNum: readHeadingNumAbove(lines, node.lineIndex)
		});
	}

	if (headingIsWorkflowTask(root, taskMarker)) pushSlot(root);

	/**
	 * @param {any} node
	 */
	function walk(node) {
		for (const child of node.children || []) {
			if (!headingIsWorkflowTask(child, taskMarker)) {
				// Chain broken by non-task — do not number descendants under this branch.
				continue;
			}
			pushSlot(child);
			if (headingIsWorkflow(child, taskMarker)) continue;
			walk(child);
		}
	}
	walk(root);
	return slots;
}

/**
 * Remap/drop parent: refs in each task's own meta block (not nested child headings).
 * @param {string[]} lines
 * @param {{ lineIndex: number }[]} slots
 * @param {Map<number, number>} idMap
 * @returns {boolean}
 */
function rewriteParentRefsForSlots(lines, slots, idMap) {
	let changed = false;
	for (const slot of slots) {
		for (let li = slot.lineIndex + 1; li < lines.length; li++) {
			const raw = String(lines[li] || '');
			const trimmed = raw.trim();
			if (/^#{1,6}\s+/.test(trimmed)) break;
			if (!/^\s*parent\s*:\s*\[/i.test(raw)) continue;
			const rewritten = rewriteParentLineIds(raw, idMap);
			if (rewritten.changed) {
				lines[li] = rewritten.line;
				changed = true;
			}
		}
	}
	return changed;
}

/**
 * Drop transitive ancestors from parent: lists (e.g. [t2, t3] → [t3] when t3 under t2).
 * @param {string[]} lines
 * @param {any} workflowRoot
 * @param {string} taskMarker
 * @returns {boolean}
 */
function scrubTransitiveParentRefsForRoot(lines, workflowRoot, taskMarker) {
	const tasks = collectWorkflowTasks(workflowRoot, 0, taskMarker);

	let changed = false;
	for (const t of tasks) {
		if (!t.parentExplicit) continue;
		for (let li = t.lineIndex + 1; li < lines.length; li++) {
			const raw = String(lines[li] || '');
			const trimmed = raw.trim();
			if (/^#{1,6}\s+/.test(trimmed)) break;
			if (!/^\s*parent\s*:\s*\[/i.test(raw)) continue;
			const rewritten = rewriteParentLineToIds(raw, t.parentTaskIds);
			if (rewritten.changed) {
				lines[li] = rewritten.line;
				changed = true;
			}
			break;
		}
	}
	return changed;
}

/**
 * Strip `.tN` from tasks under this workflow that are not on the contiguous task chain
 * (e.g. task nested under `.c` / `.f` between it and the workflow).
 * @param {string[]} lines
 * @param {any} root
 * @param {string} taskMarker
 * @param {Set<number>} numberedLineSet line indices that keep dense ids
 * @returns {boolean}
 */
function stripOffChainTaskIds(lines, root, taskMarker, numberedLineSet) {
	let changed = false;
	/**
	 * @param {any} node
	 */
	function walk(node) {
		for (const child of node.children || []) {
			if (headingIsWorkflow(child, taskMarker) && child.lineIndex !== root.lineIndex) {
				// Nested workflow owns its own numbering.
				continue;
			}
			if (headingIsWorkflowTask(child, taskMarker) && !numberedLineSet.has(child.lineIndex)) {
				const before = lines[child.lineIndex];
				const after = stripTaskIdFromHeadingLine(before);
				if (after !== before) {
					lines[child.lineIndex] = after;
					changed = true;
				}
			}
			walk(child);
		}
	}
	walk(root);
	return changed;
}

/**
 * True when a title is ready for an immediate `.tN` assignment.
 * Only after `.t` + space + at least one more character (e.g. `# .t g…`).
 * Does not fire on bare `.t` / `.t…` without a space, so other shortcuts
 * that start with `t` (e.g. `.tg`, `.task`) remain possible while typing.
 * @param {string} title
 * @returns {boolean}
 */
function titleNeedsImmediateTaskId(title) {
	const trimmed = String(title || '').trimStart();
	// `.t` then whitespace then a title character — not `.t3…` and not `.task…`
	return /^\.t\s+\S/i.test(trimmed);
}

/**
 * Scan note text for `.t ` + title under a `workflow: true` root (immediate allocate trigger).
 * @param {string} text
 * @param {string} [taskMarker]
 * @returns {boolean}
 */
function needsImmediateWorkflowTaskIdAllocation(text, taskMarker = '.task') {
	const normalized = String(text || '').replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');
	const { topEnd } = splitFileTopRegion(lines);
	const { nodes: flat } = collectHeadingSequenceValidated(lines, topEnd);
	const roots = buildHeadingTree(flat.filter(n => n.valid !== false));
	for (const root of findWorkflowRoots(roots, taskMarker)) {
		const slots = collectWorkflowTaskSlots(root, taskMarker, lines);
		for (const slot of slots) {
			const line = String(lines[slot.lineIndex] || '');
			const m = line.match(/^(\t*)(#{1,6})\s+(.*)$/);
			const title = m ? m[3] : '';
			if (titleNeedsImmediateTaskId(title)) return true;
		}
	}
	return false;
}

/**
 * Contiguous `.t1…tN` within each workflow (no gaps).
 * User-edited numbers are overwritten to the dense sequence.
 * `parent:` refs follow heading bindings (or title ids on first run); refs to deleted tasks are removed.
 * @param {import('vscode').Uri | null | undefined} kbRoot
 * @param {string} text
 * @param {{ noteUri?: import('vscode').Uri, lockedFile?: { fileNum: number } | null, taskMarker?: string }} [options]
 * @returns {Promise<{ text: string, changed: boolean }>}
 */
async function reconcileWorkflowTaskIdsForKbNote(kbRoot, text, options = {}) {
	const normalized = String(text || '').replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');
	const file = parseFileEntityFromLines(lines) || options.lockedFile || null;
	const canPersist = Boolean(kbRoot && file);

	const { topEnd } = splitFileTopRegion(lines);
	const { nodes: flat } = collectHeadingSequenceValidated(lines, topEnd);
	const roots = buildHeadingTree(flat.filter(n => n.valid !== false));
	const taskMarker = options.taskMarker || '.task';
	let changed = false;

	/** @type {Promise<void>[]} */
	const syncJobs = [];

	for (const root of findWorkflowRoots(roots, taskMarker)) {
		const wfHeadingNum = readHeadingNumAbove(lines, root.lineIndex);
		const previous =
			canPersist && wfHeadingNum
				? await readWorkflowTaskAllocator(kbRoot, file.fileNum, wfHeadingNum)
				: { next: 1, free: [], byHeading: {} };
		const prevByHeading = previous.byHeading || {};

		const slots = collectWorkflowTaskSlots(root, taskMarker, lines);
		const numberedLineSet = new Set(slots.map(s => s.lineIndex));
		if (stripOffChainTaskIds(lines, root, taskMarker, numberedLineSet)) changed = true;

		if (!slots.length) {
			if (canPersist && wfHeadingNum) {
				syncJobs.push(syncWorkflowTaskAllocatorFromUsedIds(kbRoot, file.fileNum, wfHeadingNum, [], {}));
			}
			continue;
		}

		/** @type {Map<number, number>} previous/task title id → new dense id */
		const idMap = new Map();
		/** @type {number[]} */
		const usedIds = [];
		/** @type {Record<string, number>} */
		const nextByHeading = {};

		for (let i = 0; i < slots.length; i++) {
			const newId = i + 1;
			const slot = slots[i];
			usedIds.push(newId);

			if (slot.headingNum) {
				nextByHeading[String(slot.headingNum)] = newId;
				const prevTid = prevByHeading[String(slot.headingNum)];
				if (prevTid) idMap.set(prevTid, newId);
			}
			if (slot.oldId && !idMap.has(slot.oldId)) {
				idMap.set(slot.oldId, newId);
			}

			const before = lines[slot.lineIndex];
			const after = ensureTaskIdInHeadingLine(before, newId);
			if (after !== before) {
				lines[slot.lineIndex] = after;
				changed = true;
			}
		}

		if (rewriteParentRefsForSlots(lines, slots, idMap)) changed = true;

		// Re-parse this workflow from rewritten titles so scrub sees dense .tN ids.
		const { nodes: flatAfter } = collectHeadingSequenceValidated(lines, topEnd);
		const rootsAfter = buildHeadingTree(flatAfter.filter(n => n.valid !== false));
		const rootAfter =
			findWorkflowRoots(rootsAfter, taskMarker).find(r => r.lineIndex === root.lineIndex) || root;
		if (scrubTransitiveParentRefsForRoot(lines, rootAfter, taskMarker)) changed = true;

		if (canPersist && wfHeadingNum) {
			syncJobs.push(
				syncWorkflowTaskAllocatorFromUsedIds(kbRoot, file.fileNum, wfHeadingNum, usedIds, nextByHeading)
			);
		}
	}

	await Promise.all(syncJobs);
	return { text: lines.join('\n'), changed };
}

module.exports = {
	reconcileWorkflowTaskIdsForKbNote,
	readHeadingNumAbove,
	collectWorkflowTaskSlots,
	rewriteParentRefsForSlots,
	scrubTransitiveParentRefsForRoot,
	stripOffChainTaskIds,
	titleNeedsImmediateTaskId,
	needsImmediateWorkflowTaskIdAllocation
};
