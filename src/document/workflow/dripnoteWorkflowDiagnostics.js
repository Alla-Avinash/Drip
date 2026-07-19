'use strict';

const vscode = require('vscode');
const {
	collectHeadingSequenceValidated,
	splitFileTopRegion,
	buildHeadingTree
} = require('../parse/dripnoteCanvasParse');
const {
	headingIsWorkflow,
	headingIsWorkflowTask,
	collectWorkflowTasks,
	findWorkflowRoots,
	findWorkflowCycleTaskId
} = require('./dripnoteWorkflowParse');

const WORKFLOW_PARENT_CODE = 'drip.workflowParent';
const WORKFLOW_UNKNOWN_TASK_CODE = 'drip.workflowUnknownTask';
const WORKFLOW_DUPLICATE_TASK_CODE = 'drip.workflowDuplicateTask';
const WORKFLOW_CYCLE_CODE = 'drip.workflowCycle';

/**
 * @param {string[]} lines
 * @param {import('../model/dripnoteMetadataTemplates').ReturnType<typeof import('../model/dripnoteMetadataTemplates').getMetadataSettings>} settings
 * @param {vscode.Diagnostic[]} diagnostics
 */
function collectWorkflowDiagnostics(lines, settings, diagnostics) {
	const { topEnd } = splitFileTopRegion(lines);
	const { nodes: flat } = collectHeadingSequenceValidated(lines, topEnd);
	const roots = buildHeadingTree(flat.filter(n => n.valid !== false));
	const taskMarker = '.task';
	const wfRoots = findWorkflowRoots(roots, taskMarker);

	for (const root of wfRoots) {
		const tasks = collectWorkflowTasks(root, 0, taskMarker);
		const knownIds = new Set();
		/** @type {Map<number, number>} taskId -> lineIndex */
		const idToLine = new Map();

		for (const t of tasks) {
			if (t.taskId) {
				if (knownIds.has(t.taskId)) {
					const d = new vscode.Diagnostic(
						new vscode.Range(t.lineIndex, 0, t.lineIndex, String(lines[t.lineIndex] || '').length),
						`Duplicate workflow task id "t${t.taskId}" in this workflow.`,
						vscode.DiagnosticSeverity.Error
					);
					d.code = WORKFLOW_DUPLICATE_TASK_CODE;
					diagnostics.push(d);
				} else {
					knownIds.add(t.taskId);
					idToLine.set(t.taskId, t.lineIndex);
				}
			}
		}

		for (const t of tasks) {
			for (const pid of t.parentTaskIds) {
				if (!knownIds.has(pid)) {
					const parentLine = findParentLineForTask(lines, t.lineIndex);
					const range =
						parentLine >= 0
							? new vscode.Range(parentLine, 0, parentLine, String(lines[parentLine] || '').length)
							: new vscode.Range(t.lineIndex, 0, t.lineIndex, String(lines[t.lineIndex] || '').length);
					const d = new vscode.Diagnostic(
						range,
						`Unknown workflow task parent "t${pid}" — no ".t${pid}" in this workflow.`,
						vscode.DiagnosticSeverity.Error
					);
					d.code = WORKFLOW_UNKNOWN_TASK_CODE;
					diagnostics.push(d);
				}
			}
			if (t.taskId && t.parentTaskIds.includes(t.taskId)) {
				const d = new vscode.Diagnostic(
					new vscode.Range(t.lineIndex, 0, t.lineIndex, String(lines[t.lineIndex] || '').length),
					`Task cannot list itself in parent: [t${t.taskId}].`,
					vscode.DiagnosticSeverity.Error
				);
				d.code = WORKFLOW_PARENT_CODE;
				diagnostics.push(d);
			}
			// Nested under another task: parent may only be that nesting parent.
			if (t.nestingParentId && t.parentExplicit) {
				const allowed = t.nestingParentId;
				const explicit = Array.isArray(t.explicitParentIds) ? t.explicitParentIds : t.parentTaskIds;
				const ok = explicit.length === 1 && explicit[0] === allowed;
				if (!ok) {
					const parentLine = findParentLineForTask(lines, t.lineIndex);
					const range =
						parentLine >= 0
							? new vscode.Range(parentLine, 0, parentLine, String(lines[parentLine] || '').length)
							: new vscode.Range(t.lineIndex, 0, t.lineIndex, String(lines[t.lineIndex] || '').length);
					const d = new vscode.Diagnostic(
						range,
						`Nested task under .t${allowed} may only use parent: [t${allowed}]. Move this heading to the workflow level to depend on other tasks.`,
						vscode.DiagnosticSeverity.Error
					);
					d.code = WORKFLOW_PARENT_CODE;
					diagnostics.push(d);
				}
			}
		}

		const cycleId = findWorkflowCycleTaskId(tasks.filter(x => x.taskId));
		if (cycleId) {
			const line = idToLine.get(cycleId) ?? -1;
			if (line >= 0) {
				const d = new vscode.Diagnostic(
					new vscode.Range(line, 0, line, String(lines[line] || '').length),
					'Workflow task dependencies contain a cycle.',
					vscode.DiagnosticSeverity.Error
				);
				d.code = WORKFLOW_CYCLE_CODE;
				diagnostics.push(d);
			}
		}
	}

	// parent: on non-task or outside a workflow: true task
	for (let i = 0; i < lines.length; i++) {
		const trimmed = String(lines[i] || '').trim();
		if (!/^\s*parent\s*:\s*\[/i.test(trimmed)) continue;
		const inWorkflowTask = isParentLineOnWorkflowTask(lines, i, topEnd, taskMarker);
		if (!inWorkflowTask) {
			const d = new vscode.Diagnostic(
				new vscode.Range(i, 0, i, String(lines[i] || '').length),
				'parent: is only valid on task headings (.task / .tN / tN) under a task with workflow: true.',
				vscode.DiagnosticSeverity.Error
			);
			d.code = WORKFLOW_PARENT_CODE;
			diagnostics.push(d);
		}
	}
}

/**
 * @param {string[]} lines
 * @param {number} taskLineIndex
 * @returns {number}
 */
function findParentLineForTask(lines, taskLineIndex) {
	for (let i = taskLineIndex + 1; i < lines.length; i++) {
		const t = String(lines[i] || '').trim();
		if (/^#{1,6}\s+/.test(t)) break;
		if (/^\s*parent\s*:\s*\[/i.test(t)) return i;
	}
	return -1;
}

/**
 * @param {string[]} lines
 * @param {number} parentLineIndex
 * @param {number} topEnd
 * @param {string} taskMarker
 */
function isParentLineOnWorkflowTask(lines, parentLineIndex, topEnd, taskMarker) {
	let headingLine = -1;
	for (let i = parentLineIndex - 1; i >= topEnd; i--) {
		const t = String(lines[i] || '').trim();
		if (/^#{1,6}\s+/.test(t)) {
			headingLine = i;
			break;
		}
	}
	if (headingLine < 0) return false;

	const { nodes: flat } = collectHeadingSequenceValidated(lines, topEnd);
	const idx = flat.findIndex(n => n.lineIndex === headingLine);
	if (idx < 0) return false;
	const node = flat[idx];
	if (!headingIsWorkflowTask({ title: node.title, metaLines: node.metaLines }, taskMarker)) return false;

	// On the workflow root itself
	if (headingIsWorkflow({ title: node.title, metaLines: node.metaLines }, taskMarker)) return true;

	// True document ancestors only (shallower tabDepth with no equal/shallower in between wrongly counted)
	let depthCap = node.tabDepth;
	for (let j = idx - 1; j >= 0; j--) {
		const n = flat[j];
		if (n.tabDepth >= depthCap) continue;
		depthCap = n.tabDepth;
		if (headingIsWorkflow({ title: n.title, metaLines: n.metaLines }, taskMarker)) return true;
	}
	return false;
}

module.exports = {
	collectWorkflowDiagnostics,
	WORKFLOW_PARENT_CODE,
	WORKFLOW_UNKNOWN_TASK_CODE,
	WORKFLOW_DUPLICATE_TASK_CODE,
	WORKFLOW_CYCLE_CODE
};
