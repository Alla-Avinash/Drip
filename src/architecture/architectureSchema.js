'use strict';

/**
 * Static SQLite schema for `<project>/_architecture/architecture.drip` — the
 * Project Architecture store.
 *
 * Each project keeps its own architecture model, in its own `_architecture/` folder,
 * never in the shared KB index (`index.drip`) or the project index (`projects.drip`).
 * The database records structure and layout: the entities (feature / component /
 * sub-component / implementation) and the typed relationships between them. Long
 * human-readable descriptions live in sibling `.d.md` files under the same folder;
 * this database only stores where those files are and how the graph is laid out.
 *
 * Workflow playback is modelled as a sequence of "steps" (frames); each step lists
 * the nodes that are active in it and the labelled flows (arrows) drawn between them,
 * so an implementation can animate step-by-step directly on the architecture graph.
 */

const ARCHITECTURE_SCHEMA_VERSION = 3;

/** @type {string} */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entities (
	entity_id TEXT PRIMARY KEY,
	entity_type TEXT NOT NULL,
	name TEXT NOT NULL,
	parent_id TEXT,
	feature_id TEXT,
	description_file TEXT NOT NULL DEFAULT '',
	x REAL,
	y REAL,
	status TEXT NOT NULL DEFAULT 'active',
	FOREIGN KEY (parent_id) REFERENCES entities(entity_id) ON DELETE CASCADE,
	FOREIGN KEY (feature_id) REFERENCES entities(entity_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_arch_entities_parent ON entities(parent_id);
CREATE INDEX IF NOT EXISTS idx_arch_entities_feature ON entities(feature_id);
CREATE INDEX IF NOT EXISTS idx_arch_entities_type ON entities(entity_type);

CREATE TABLE IF NOT EXISTS relations (
	source_id TEXT NOT NULL,
	relation TEXT NOT NULL,
	target_id TEXT NOT NULL,
	PRIMARY KEY (source_id, relation, target_id)
);

CREATE INDEX IF NOT EXISTS idx_arch_relations_target ON relations(target_id);

-- Workflow definitions. A workflow belongs to an implementation entity. Steps are
-- ordered frames; workflow_step_nodes lists the active nodes per step; workflow_flows
-- records the labelled arrows (sync / parallel / async, optional nested workflow).
CREATE TABLE IF NOT EXISTS workflows (
	workflow_id TEXT PRIMARY KEY,
	trigger_description TEXT,
	version INTEGER NOT NULL DEFAULT 1,
	FOREIGN KEY (workflow_id) REFERENCES entities(entity_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workflow_steps (
	step_id TEXT PRIMARY KEY,
	workflow_id TEXT NOT NULL,
	step_order INTEGER,
	label TEXT,
	FOREIGN KEY (workflow_id) REFERENCES entities(entity_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wf_steps_workflow ON workflow_steps(workflow_id);

CREATE TABLE IF NOT EXISTS workflow_step_nodes (
	step_id TEXT NOT NULL,
	entity_id TEXT NOT NULL,
	PRIMARY KEY (step_id, entity_id),
	FOREIGN KEY (step_id) REFERENCES workflow_steps(step_id) ON DELETE CASCADE,
	FOREIGN KEY (entity_id) REFERENCES entities(entity_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wf_sn_step ON workflow_step_nodes(step_id);

CREATE TABLE IF NOT EXISTS workflow_flows (
	flow_id TEXT PRIMARY KEY,
	workflow_id TEXT NOT NULL,
	step_id TEXT NOT NULL,
	source_entity TEXT NOT NULL,
	target_entity TEXT NOT NULL,
	label TEXT,
	execution_type TEXT NOT NULL DEFAULT 'sync',
	nested_workflow_id TEXT,
	FOREIGN KEY (workflow_id) REFERENCES entities(entity_id) ON DELETE CASCADE,
	FOREIGN KEY (step_id) REFERENCES workflow_steps(step_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wf_flows_workflow ON workflow_flows(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wf_flows_step ON workflow_flows(step_id);
`;

/**
 * Create the schema, migrating away from the old single-target workflow tables
 * when present. Detection is based on the table shape (a `target_type` column on
 * `workflow_steps`), not just `user_version`, so stale databases always migrate.
 * @param {import('../indexing/db/dripSqlite').DripSqliteDatabase} db
 */
function ensureArchitectureSchema(db) {
	const current = Number(db.native.pragma('user_version', { simple: true })) || 0;

	// Drop the superseded single-target workflow shape when we can still see it.
	const stepsCols = listColumns(db, 'workflow_steps');
	const hasOldShape = stepsCols.includes('target_type');

	if (current > 0 && current < 3) {
		db.native.exec(`
			DROP TABLE IF EXISTS workflow_connections;
			DROP TABLE IF EXISTS workflow_steps;
			DROP TABLE IF EXISTS workflows;
		`);
	} else if (hasOldShape) {
		// `user_version` was already advanced (or never tracked), but the old
		// `workflow_steps` (with NOT NULL target_type) is still present — drop it.
		db.native.exec(`
			DROP TABLE IF EXISTS workflow_connections;
			DROP TABLE IF EXISTS workflow_steps;
			DROP TABLE IF EXISTS workflows;
		`);
	}
	db.exec(SCHEMA_SQL);
	db.native.pragma('user_version = ' + ARCHITECTURE_SCHEMA_VERSION);
}

/**
 * @param {import('../indexing/db/dripSqlite').DripSqliteDatabase} db
 * @param {string} table
 * @returns {string[]}
 */
function listColumns(db, table) {
	const rows = db.native.pragma(`table_info(${table})`);
	return rows.map(r => String(r.name));
}

module.exports = {
	ARCHITECTURE_SCHEMA_VERSION,
	SCHEMA_SQL,
	ensureArchitectureSchema
};
