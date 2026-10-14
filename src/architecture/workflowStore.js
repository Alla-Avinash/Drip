'use strict';

/**
 * Project Architecture — workflow (implementation) definitions.
 *
 * A workflow is an ordered list of steps. Each step is a "frame" of the animation:
 * a set of active nodes plus labelled flows (arrows) between them. Flows can be
 * sync / parallel / async and can carry a nested implementation that runs in their
 * middle. Everything lives in the project's own `_architecture/architecture.drip`
 * (never the shared KB or project indexes).
 */

const { openDripSqlite } = require('../indexing/db/dripSqlite');
const { ensureArchitectureSchema } = require('./architectureSchema');
const { architectureDbUri } = require('./architectureStore');

/**
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @returns {import('../indexing/db/dripSqlite').DripSqliteDatabase}
 */
function openWorkflowDb(kbRootUri, folderPrefix) {
	const db = openDripSqlite(architectureDbUri(kbRootUri, folderPrefix).fsPath);
	ensureArchitectureSchema(db);
	return db;
}

/** @param {string} prefix @returns {string} */
function newId(prefix) {
	return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Ensure the workflow registry row exists (tied to its implementation entity).
 * @param {import('../indexing/db/dripSqlite').DripSqliteDatabase} db
 * @param {string} workflowId
 */
function ensureWorkflowRow(db, workflowId) {
	db.native
		.prepare(`INSERT OR IGNORE INTO workflows (workflow_id, trigger_description, version) VALUES (?, '', 1)`)
		.run(workflowId);
}

/**
 * Load a workflow's steps (with their nodes and flows) for playback or the builder.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} workflowId
 * @returns {Promise<{ workflowId: string, name: string, steps: object[] }>}
 */
async function loadWorkflow(kbRootUri, folderPrefix, workflowId) {
	const db = openWorkflowDb(kbRootUri, folderPrefix);
	try {
		ensureWorkflowRow(db, workflowId);
		const wfRow = db.native.prepare(`SELECT name FROM entities WHERE entity_id = ?`).get(workflowId);
		const name = wfRow ? String(wfRow.name || 'Untitled') : 'Untitled';

		const stepRows = db.native
			.prepare(`SELECT step_id AS id, step_order AS ord, label FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order ASC, rowid ASC`)
			.all(workflowId);

		const nodeRows = db.native
			.prepare(`SELECT step_id AS stepId, entity_id AS entityId FROM workflow_step_nodes ORDER BY rowid ASC`)
			.all();
		const flowRows = db.native
			.prepare(`SELECT flow_id AS id, step_id AS stepId, source_entity AS source, target_entity AS target, label, execution_type AS executionType, nested_workflow_id AS nestedWorkflowId FROM workflow_flows WHERE workflow_id = ? ORDER BY rowid ASC`)
			.all(workflowId);

		const nodeByStep = new Map();
		for (const r of nodeRows) {
			const k = String(r.stepId);
			if (!nodeByStep.has(k)) nodeByStep.set(k, []);
			nodeByStep.get(k).push(String(r.entityId));
		}
		const flowByStep = new Map();
		for (const r of flowRows) {
			const k = String(r.stepId);
			if (!flowByStep.has(k)) flowByStep.set(k, []);
			flowByStep.get(k).push({
				id: String(r.id),
				source: String(r.source),
				target: String(r.target),
				label: String(r.label || ''),
				executionType: String(r.executionType || 'sync'),
				nestedWorkflowId: r.nestedWorkflowId ? String(r.nestedWorkflowId) : ''
			});
		}

		const steps = stepRows.map(r => ({
			id: String(r.id),
			order: Number(r.ord) || 0,
			label: String(r.label || ''),
			nodes: nodeByStep.get(String(r.id)) || [],
			flows: flowByStep.get(String(r.id)) || []
		}));

		return { workflowId, name, steps };
	} finally {
		db.close();
	}
}

/**
 * Replace a workflow's entire definition with the given steps.
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} workflowId
 * @param {{ nodes: string[], flows: { source: string, target: string, label?: string, executionType?: string, nestedWorkflowId?: string }[] }[]} steps
 */
async function saveWorkflow(kbRootUri, folderPrefix, workflowId, steps) {
	const db = openWorkflowDb(kbRootUri, folderPrefix);
	try {
		ensureWorkflowRow(db, workflowId);
		// Delete existing steps (cascades step nodes + flows), then re-insert.
		db.native.prepare(`DELETE FROM workflow_steps WHERE workflow_id = ?`).run(workflowId);

		const insStep = db.native.prepare(`INSERT INTO workflow_steps (step_id, workflow_id, step_order, label) VALUES (?, ?, ?, ?)`);
		const insNode = db.native.prepare(`INSERT OR IGNORE INTO workflow_step_nodes (step_id, entity_id) VALUES (?, ?)`);
		const insFlow = db.native.prepare(`INSERT INTO workflow_flows (flow_id, workflow_id, step_id, source_entity, target_entity, label, execution_type, nested_workflow_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

		(steps || []).forEach((step, i) => {
			const stepId = newId('st');
			insStep.run(stepId, workflowId, i, String(step.label || ''));
			for (const nodeId of step.nodes || []) {
				insNode.run(stepId, String(nodeId));
			}
			for (const f of step.flows || []) {
				if (!f.source || !f.target) continue;
				insFlow.run(
					newId('fl'),
					workflowId,
					stepId,
					String(f.source),
					String(f.target),
					String(f.label || ''),
					String(f.executionType || 'sync'),
					f.nestedWorkflowId ? String(f.nestedWorkflowId) : null
				);
			}
		});
	} finally {
		db.close();
	}
}

/**
 * Remove a workflow definition (keeps the implementation entity itself).
 * @param {import('vscode').Uri} kbRootUri
 * @param {string} folderPrefix
 * @param {string} workflowId
 */
async function deleteWorkflow(kbRootUri, folderPrefix, workflowId) {
	const db = openWorkflowDb(kbRootUri, folderPrefix);
	try {
		db.native.prepare(`DELETE FROM workflows WHERE workflow_id = ?`).run(workflowId);
		db.native.prepare(`DELETE FROM workflow_steps WHERE workflow_id = ?`).run(workflowId);
	} finally {
		db.close();
	}
}

module.exports = {
	loadWorkflow,
	saveWorkflow,
	deleteWorkflow
};
