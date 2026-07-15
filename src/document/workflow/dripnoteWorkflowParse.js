'use strict';

const { inferMarkerFromMeta } = require('../parse/dripnoteCanvasParse');
const { getMetadataSettings, matchHeadingTitleTypePrefix } = require('../model/dripnoteMetadataTemplates');

const TASK_ID_IN_TITLE_RE = /^\.t(\d+)(?=\s|$)/i;
const PARENT_LINE_RE = /^\s*parent\s*:\s*\[([^\]]*)\]/i;
const PARENT_TOKEN_RE = /\bt(\d+)\b/gi;
const WORKFLOW_FLAG_RE = /^\s*workflow\s*:\s*(true|false)\s*$/i;

/**
 * @param {string} [taskShortcut]
 * @returns {{ types: any[], typeByMarker: Map<string,any>, typeByShortcut: Map<string,any> }}
 */
function taskAwareSettings(taskShortcut = 't') {
	const settings = getMetadataSettings();
	const sc = String(taskShortcut || 't').replace(/^\./, '') || 't';
	if (!settings.typeByShortcut.has(sc)) {
		const task = settings.typeById.get('task');
		if (task) settings.typeByShortcut.set(sc, task);
	}
	return settings;
}

/**
 * Parse `workflow: true|false` from meta. Omitted → null (default).
 * @param {string[]} metaLines
 * @returns {boolean | null}
 */
function parseWorkflowFlag(metaLines) {
	for (const line of metaLines || []) {
		const m = WORKFLOW_FLAG_RE.exec(String(line || '').trim());
		if (!m) continue;
		return String(m[1] || '').toLowerCase() === 'true';
	}
	return null;
}

/**
 * Title form for task shortcut: `.t`, `.t12`, or invalid `.tab…`.
 * @param {string} title
 * @param {string} [taskShortcut]
 */
function matchTaskTitleShortcut(title, taskShortcut = 't') {
	const settings = taskAwareSettings(taskShortcut);
	return matchHeadingTitleTypePrefix(title, settings);
}

/**
 * Workflow root = a task (`.task` / `.t` / `.tN`) with `workflow: true` as a heading-special key.
 * @param {{ title?: string, metaLines?: string[] }} node
 * @param {string} [taskMarker]
 * @returns {boolean}
 */
function headingIsWorkflow(node, taskMarker = '.task') {
	if (!headingIsWorkflowTask(node, taskMarker)) return false;
	return parseWorkflowFlag(node.metaLines || []) === true;
}

/**
 * @param {string} title
 * @returns {number | null}
 */
function parseTaskIdFromTitle(title) {
	const matched = matchTaskTitleShortcut(title);
	if (matched.form === 'numeric' && matched.taskId) return matched.taskId;
	const m = String(title || '').trim().match(TASK_ID_IN_TITLE_RE);
	if (!m) return null;
	const n = parseInt(m[1], 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {string} line full heading line
 * @returns {number | null}
 */
function parseTaskIdFromHeadingLine(line) {
	const m = String(line || '').match(/^(\t*)(#{1,6})\s+(.*)$/);
	if (!m) return null;
	return parseTaskIdFromTitle(m[3]);
}

/**
 * @param {string[]} metaLines
 * @returns {{ explicit: boolean, ids: number[] }}
 */
function parseParentTaskIdsFromMeta(metaLines) {
	for (const line of metaLines || []) {
		const m = PARENT_LINE_RE.exec(String(line || ''));
		if (!m) continue;
		/** @type {number[]} */
		const ids = [];
		const seen = new Set();
		let tok;
		PARENT_TOKEN_RE.lastIndex = 0;
		const inner = String(m[1] || '');
		while ((tok = PARENT_TOKEN_RE.exec(inner))) {
			const n = parseInt(tok[1], 10);
			if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
			seen.add(n);
			ids.push(n);
		}
		return { explicit: true, ids };
	}
	return { explicit: false, ids: [] };
}

/**
 * @param {{ title?: string, metaLines?: string[] }} node
 * @param {string} [taskMarker]
 * @returns {boolean}
 */
function headingIsWorkflowTask(node, taskMarker = '.task') {
	const marker = inferMarkerFromMeta(node.metaLines || []);
	if (String(marker || '').toLowerCase() === String(taskMarker || '.task').toLowerCase()) return true;
	const titleMatch = matchTaskTitleShortcut(node.title || '');
	if (titleMatch.typeId === 'task') return true;
	if (titleMatch.form === 'invalid' && titleMatch.typeId === 'task') return true;
	const parentMeta = parseParentTaskIdsFromMeta(node.metaLines || []);
	if (parentMeta.explicit) return true;
	return false;
}

/**
 * @param {number} docIdx
 * @param {{ lineIndex: number, tabDepth: number }} node
 */
function gidForHeading(docIdx, node) {
	return `g-${docIdx}-${node.lineIndex}-${node.tabDepth}`;
}

/**
 * Walk heading tree depth-first.
 * @param {any[]} nodes
 * @param {(node: any, ancestors: any[]) => void} visit
 * @param {any[]} [ancestors]
 */
function walkHeadingTree(nodes, visit, ancestors = []) {
	for (const n of nodes || []) {
		visit(n, ancestors);
		walkHeadingTree(n.children || [], visit, ancestors.concat(n));
	}
}

/**
 * All headings with `workflow: true` in the tree (including nested).
 * @param {any[]} roots
 * @param {string} [taskMarker]
 * @returns {any[]}
 */
function findWorkflowRoots(roots, taskMarker = '.task') {
	/** @type {any[]} */
	const out = [];
	walkHeadingTree(roots || [], node => {
		if (headingIsWorkflow(node, taskMarker)) out.push(node);
	});
	return out;
}

/**
 * Nearest task ancestor in document hierarchy (excluding self).
 * @param {any[]} ancestors
 * @param {string} [taskMarker]
 * @returns {number | null}
 */
function nearestTaskAncestorId(ancestors, taskMarker = '.task') {
	for (let i = ancestors.length - 1; i >= 0; i--) {
		const a = ancestors[i];
		if (!headingIsWorkflowTask(a, taskMarker)) continue;
		const id = parseTaskIdFromTitle(a.title);
		if (id) return id;
	}
	return null;
}

/**
 * Document-nesting parent constraint: nearest task ancestor that is not the workflow root.
 * @param {any[]} ancestors
 * @param {any} workflowRoot
 * @param {string} [taskMarker]
 * @returns {number | null}
 */
function nestingParentTaskId(ancestors, workflowRoot, taskMarker = '.task') {
	const rootId = parseTaskIdFromTitle(workflowRoot && workflowRoot.title);
	for (let i = ancestors.length - 1; i >= 0; i--) {
		const a = ancestors[i];
		if (a === workflowRoot) continue;
		if (!headingIsWorkflowTask(a, taskMarker)) continue;
		const id = parseTaskIdFromTitle(a.title);
		if (!id) continue;
		if (rootId && id === rootId) continue;
		return id;
	}
	return null;
}

/**
 * @typedef {{ gid: string, lineIndex: number, tabDepth: number, title: string, taskId: number | null, parentTaskIds: number[], parentExplicit: boolean, explicitParentIds: number[], isTask: boolean, nestingParentId: number | null }} WorkflowTaskInfo
 */

/**
 * Collect workflow tasks under a workflow root (descendant tasks only).
 * Only tasks on a contiguous task chain from the workflow (no non-task break).
 * Nested `workflow: true` roots appear as a single task; their descendants belong to the nested workflow.
 *
 * Defaults:
 * - Direct under workflow (no nesting parent) → parentTaskIds [] (canvas: edge from workflow)
 * - Nested under another task → parentTaskIds [that task] only (hierarchy-locked)
 *
 * @param {any} workflowRoot
 * @param {number} docIdx
 * @param {string} [taskMarker]
 * @returns {WorkflowTaskInfo[]}
 */
function collectWorkflowTasks(workflowRoot, docIdx, taskMarker = '.task') {
	/** @type {WorkflowTaskInfo[]} */
	const tasks = [];
	const rootTaskId = parseTaskIdFromTitle(workflowRoot && workflowRoot.title);

	/**
	 * @param {any[]} nodes
	 * @param {any[]} ancestors
	 */
	function walk(nodes, ancestors) {
		for (const node of nodes || []) {
			const isTask = headingIsWorkflowTask(node, taskMarker);
			if (!isTask) {
				// Non-task breaks the contiguous chain — skip entire branch.
				continue;
			}
			const taskId = parseTaskIdFromTitle(node.title);
			const parentMeta = parseParentTaskIdsFromMeta(node.metaLines || []);
			const nestParent = nestingParentTaskId(ancestors, workflowRoot, taskMarker);
			const explicitParentIds = parentMeta.ids.slice();
			/** @type {number[]} */
			let parentTaskIds;
			if (nestParent) {
				parentTaskIds = [nestParent];
			} else if (!parentMeta.explicit) {
				parentTaskIds = [];
			} else {
				parentTaskIds = explicitParentIds.filter(id => id !== rootTaskId && id !== taskId);
			}
			tasks.push({
				gid: gidForHeading(docIdx, node),
				lineIndex: node.lineIndex,
				tabDepth: node.tabDepth,
				title: node.title,
				taskId,
				parentTaskIds,
				parentExplicit: parentMeta.explicit,
				explicitParentIds,
				isTask: true,
				nestingParentId: nestParent
			});
			if (headingIsWorkflow(node, taskMarker)) continue;
			walk(node.children || [], ancestors.concat(node));
		}
	}

	walk(workflowRoot.children || [], [workflowRoot]);

	/** @type {Map<number, WorkflowTaskInfo>} */
	const byId = new Map();
	for (const t of tasks) {
		if (t.taskId) byId.set(t.taskId, t);
	}
	for (const t of tasks) {
		t.parentTaskIds = scrubRedundantParentIds(t.parentTaskIds, byId);
	}
	return tasks;
}

/**
 * True when `aid` is an ancestor of `did` via parentTaskIds / nestingParentId.
 * @param {number} aid
 * @param {number} did
 * @param {Map<number, WorkflowTaskInfo>} byId
 * @param {Set<number>} [visiting]
 * @returns {boolean}
 */
function isWorkflowTaskAncestor(aid, did, byId, visiting) {
	if (!aid || !did || aid === did) return false;
	const seen = visiting || new Set();
	if (seen.has(did)) return false;
	seen.add(did);
	const t = byId.get(did);
	if (!t) return false;
	const parents = [];
	if (t.nestingParentId) parents.push(t.nestingParentId);
	for (const p of t.parentTaskIds || []) {
		if (!parents.includes(p)) parents.push(p);
	}
	for (const p of parents) {
		if (p === aid) return true;
		if (isWorkflowTaskAncestor(aid, p, byId, seen)) return true;
	}
	return false;
}

/**
 * Drop parents that are already ancestors of another listed parent
 * (e.g. parent: [t2, t3] when t3 sits under t2 → keep only t3).
 * @param {number[]} ids
 * @param {Map<number, WorkflowTaskInfo>} byId
 * @returns {number[]}
 */
function scrubRedundantParentIds(ids, byId) {
	const list = (ids || []).filter(id => Number.isFinite(id) && id > 0);
	if (list.length < 2) return list.slice();
	/** @type {number[]} */
	const kept = [];
	for (const pid of list) {
		const coveredByCloser = list.some(
			qid => qid !== pid && isWorkflowTaskAncestor(pid, qid, byId)
		);
		if (!coveredByCloser) kept.push(pid);
	}
	return kept;
}

/**
 * Detect cycles in workflow task parent graph.
 * @param {WorkflowTaskInfo[]} tasks
 * @returns {number[] | null} task id in a cycle, or null
 */
function findWorkflowCycleTaskId(tasks) {
	const byId = new Map();
	for (const t of tasks) {
		if (t.taskId) byId.set(t.taskId, t);
	}
	/** @type {Set<number>} */
	const visiting = new Set();
	/** @type {Set<number>} */
	const done = new Set();

	/**
	 * @param {number} id
	 * @returns {boolean}
	 */
	function dfs(id) {
		if (done.has(id)) return false;
		if (visiting.has(id)) return true;
		visiting.add(id);
		const node = byId.get(id);
		if (node) {
			for (const pid of node.parentTaskIds) {
				if (dfs(pid)) return true;
			}
		}
		visiting.delete(id);
		done.add(id);
		return false;
	}

	for (const t of tasks) {
		if (!t.taskId) continue;
		if (dfs(t.taskId)) return t.taskId;
	}
	return null;
}

/**
 * Build canvas workflow graph from a heading subtree that contains a workflow task root.
 * @param {any[]} roots
 * @param {number} docIdx
 * @param {string} [taskMarker]
 * @returns {{ mode: 'workflow', wfGid: string, wfTitle: string, tasks: WorkflowTaskInfo[] } | null}
 */
function buildWorkflowGraphForCanvas(roots, docIdx, taskMarker = '.task') {
	const list = roots || [];
	if (!list.length) return null;
	let wfRoot = null;
	if (list.length === 1 && headingIsWorkflow(list[0], taskMarker)) {
		wfRoot = list[0];
	} else {
		const found = findWorkflowRoots(list, taskMarker);
		wfRoot = found[0] || null;
	}
	if (!wfRoot) return null;
	const tasks = collectWorkflowTasks(wfRoot, docIdx, taskMarker);
	return {
		mode: 'workflow',
		wfGid: gidForHeading(docIdx, wfRoot),
		wfTitle: wfRoot.title,
		rootTaskId: parseTaskIdFromTitle(wfRoot.title),
		tasks
	};
}

/**
 * Insert or replace `.t` / `.tN` / invalid `.t…` prefix with `.t{taskId}`.
 * @param {string} line
 * @param {number} taskId
 * @returns {string}
 */
function ensureTaskIdInHeadingLine(line, taskId) {
	const m = String(line || '').match(/^(\t*)(#{1,6}\s+)(.*)$/);
	if (!m) return line;
	const tabs = m[1] || '';
	const hashes = m[2] || '';
	const rest = String(m[3] || '');
	const trimmed = rest.trimStart();
	const lead = rest.slice(0, rest.length - trimmed.length);
	const matched = matchTaskTitleShortcut(trimmed);
	if (matched.matchedPrefix) {
		const after = trimmed.slice(matched.matchedPrefix.length).replace(/^\s*/, ' ');
		return tabs + hashes + lead + `.t${taskId}` + (after.trim() ? after : '');
	}
	if (TASK_ID_IN_TITLE_RE.test(trimmed)) {
		const replaced = trimmed.replace(TASK_ID_IN_TITLE_RE, `.t${taskId}`);
		return tabs + hashes + lead + replaced;
	}
	return tabs + hashes + lead + `.t${taskId} ` + trimmed;
}

/**
 * Strip `.tN` to unnumbered `.t` (task off contiguous workflow chain).
 * @param {string} line
 * @returns {string}
 */
function stripTaskIdFromHeadingLine(line) {
	const m = String(line || '').match(/^(\t*)(#{1,6}\s+)(.*)$/);
	if (!m) return line;
	const tabs = m[1] || '';
	const hashes = m[2] || '';
	const rest = String(m[3] || '');
	const trimmed = rest.trimStart();
	const lead = rest.slice(0, rest.length - trimmed.length);
	if (!TASK_ID_IN_TITLE_RE.test(trimmed)) return line;
	const after = trimmed.replace(TASK_ID_IN_TITLE_RE, '.t').replace(/^\.t(?=\S)/, '.t ');
	return tabs + hashes + lead + after;
}

/**
 * Remap/drop `tN` tokens in a `parent: […]` line.
 * - mapped ids rewritten to new numbers
 * - unmapped ids (deleted tasks) removed
 * @param {string} line
 * @param {Map<number, number>} idMap oldId → newId
 * @returns {{ line: string, changed: boolean }}
 */
function rewriteParentLineIds(line, idMap) {
	const m = String(line || '').match(/^(\s*parent\s*:\s*\[)([^\]]*)(\].*)$/i);
	if (!m) return { line: String(line || ''), changed: false };
	const head = m[1];
	const inner = m[2] || '';
	const tail = m[3] || '';
	/** @type {number[]} */
	const outIds = [];
	const seen = new Set();
	PARENT_TOKEN_RE.lastIndex = 0;
	let tok;
	while ((tok = PARENT_TOKEN_RE.exec(inner))) {
		const oldId = parseInt(tok[1], 10);
		if (!Number.isFinite(oldId) || oldId <= 0) continue;
		const newId = idMap.has(oldId) ? idMap.get(oldId) : null;
		if (newId == null) continue; // deleted task id — drop ref
		if (seen.has(newId)) continue;
		seen.add(newId);
		outIds.push(newId);
	}
	const nextInner = outIds.map(n => `t${n}`).join(', ');
	const next = head + nextInner + tail;
	return { line: next, changed: next !== String(line || '') };
}

/**
 * Replace `parent: […]` ids with an explicit list (preserves indent / brackets).
 * @param {string} line
 * @param {number[]} ids
 * @returns {{ line: string, changed: boolean }}
 */
function rewriteParentLineToIds(line, ids) {
	const m = String(line || '').match(/^(\s*parent\s*:\s*\[)([^\]]*)(\].*)$/i);
	if (!m) return { line: String(line || ''), changed: false };
	const seen = new Set();
	/** @type {number[]} */
	const outIds = [];
	for (const id of ids || []) {
		const n = Number(id);
		if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
		seen.add(n);
		outIds.push(n);
	}
	const next = m[1] + outIds.map(n => `t${n}`).join(', ') + m[3];
	return { line: next, changed: next !== String(line || '') };
}

module.exports = {
	parseWorkflowFlag,
	matchTaskTitleShortcut,
	headingIsWorkflow,
	headingIsWorkflowTask,
	parseTaskIdFromTitle,
	parseTaskIdFromHeadingLine,
	parseParentTaskIdsFromMeta,
	collectWorkflowTasks,
	findWorkflowRoots,
	findWorkflowCycleTaskId,
	buildWorkflowGraphForCanvas,
	gidForHeading,
	walkHeadingTree,
	nearestTaskAncestorId,
	nestingParentTaskId,
	ensureTaskIdInHeadingLine,
	stripTaskIdFromHeadingLine,
	rewriteParentLineIds,
	rewriteParentLineToIds,
	scrubRedundantParentIds,
	isWorkflowTaskAncestor
};
