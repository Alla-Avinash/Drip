'use strict';

/**
 * MCP tool cards: projects + features.
 */

const path = require('path');
const vscode = require('vscode');
const {
	ToolError,
	requireKbRoot,
	uriFromRel,
	resolveProject,
	loadProjectChildren
} = require('./toolShared');
const { fieldsPropFor } = require('../responseSchema');

/** @param {string} s */
const stripId = s => String(s || '').replace(/^f-\d+\s+/i, '');

/** @type {import('../toolCatalog').ToolCard[]} */
const PROJECT_TOOLS = [
	{
		name: 'list_projects',
		category: 'projects',
		summary: 'List all projects (Name.p folders) in the open knowledge base.',
		keywords: ['projects', 'overview', 'workspace', 'all projects', 'which projects'],
		inputSchema: { type: 'object', properties: { fields: fieldsPropFor('list_projects') }, additionalProperties: false },
		example: {},
		async handler(_args, ctx) {
			const kb = requireKbRoot(ctx);
			const { listProjectsFromIndex } = require('../../../indexing/projectViewQuery');
			const { projects } = await listProjectsFromIndex(kb);
			return {
				projects: projects.map(p => ({
					project: p.folderPrefix.replace(/\/+$/, ''),
					title: p.title,
					status: p.status
				}))
			};
		}
	},
	{
		name: 'get_project',
		category: 'projects',
		summary: 'Project overview: features, inbox size, and issue counts by status.',
		keywords: ['project summary', 'overview', 'status counts', 'progress', 'dashboard'],
		inputSchema: {
			type: 'object',
			properties: {
				project: { type: 'string', description: 'Project folder (e.g. "Shop.p") or title. Optional if only one project.' },
				fields: fieldsPropFor('get_project')
			},
			additionalProperties: false
		},
		example: { project: 'Shop.p' },
		async handler(args, ctx) {
			const kb = requireKbRoot(ctx);
			const project = await resolveProject(kb, args.project);
			const { features, issues } = await loadProjectChildren(kb, project);
			/** @type {Record<string, number>} */
			const byStatus = {};
			for (const i of issues) {
				const s = i.status || 'none';
				byStatus[s] = (byStatus[s] || 0) + 1;
			}
			return {
				project: project.folderPrefix.replace(/\/+$/, ''),
				title: project.title,
				features: features.map(f => ({
					feature: stripId(f.title),
					issues: issues.filter(i => i.featurePathPrefix === (f.folderPrefix || f.path)).length
				})),
				inboxIssues: issues.filter(i => i.inProjectInbox).length,
				totalIssues: issues.length,
				issuesByStatus: byStatus
			};
		}
	},
	{
		name: 'list_features',
		category: 'features',
		summary: 'List the features (f-N; *.f folders or *.f.d.txt files) of a project.',
		keywords: ['features', 'modules', 'areas', 'components', 'epics'],
		inputSchema: {
			type: 'object',
			properties: {
				project: { type: 'string', description: 'Project folder (e.g. "Shop.p") or title.' },
				fields: fieldsPropFor('list_features')
			},
			additionalProperties: false
		},
		example: { project: 'Shop.p' },
		async handler(args, ctx) {
			const kb = requireKbRoot(ctx);
			const project = await resolveProject(kb, args.project);
			const { features } = await loadProjectChildren(kb, project);
			return {
				features: features.map(f => ({
					title: f.title,
					kind: f.isFolderIndex ? 'folder' : 'file',
					path: f.folderPrefix || f.path
				}))
			};
		}
	},
	{
		name: 'create_feature',
		category: 'features',
		summary: 'Create a new feature folder (Name.f) in a project; DRIP stamps the next f-N id.',
		keywords: ['new feature', 'add feature', 'create module', 'create area', 'epic'],
		inputSchema: {
			type: 'object',
			properties: {
				project: { type: 'string', description: 'Project folder (e.g. "Shop.p") or title.' },
				name: { type: 'string', description: 'Feature name, e.g. "Payments" (".f" is added).' }
			},
			required: ['name'],
			additionalProperties: false
		},
		example: { project: 'Shop.p', name: 'Payments' },
		async handler(args, ctx) {
			const kb = requireKbRoot(ctx);
			const project = await resolveProject(kb, args.project);
			const name = String(args.name || '')
				.trim()
				.replace(/\.f$/i, '');
			if (!name || /[\\/:*?"<>|]/.test(name)) {
				throw new ToolError('Feature name must be a plain folder name (no / \\ : * ? " < > |).');
			}
			const folderUri = vscode.Uri.joinPath(uriFromRel(kb, project.folderPrefix), `${name}.f`);
			try {
				await vscode.workspace.fs.stat(folderUri);
				throw new ToolError(`Feature ${name}.f already exists.`);
			} catch (err) {
				if (err instanceof ToolError) throw err;
			}
			await vscode.workspace.fs.createDirectory(folderUri);
			const { ensureFeatureIndexFile } = require('../../../startup/dripFeatureFolder');
			const indexUri = await ensureFeatureIndexFile(folderUri, {
				kbRoot: kb,
				context: ctx.extensionContext
			});
			ctx.refreshUi();
			return {
				created: `${name}.f`,
				indexFile: indexUri
					? path.relative(kb.fsPath, indexUri.fsPath).replace(/\\/g, '/')
					: null
			};
		}
	}
];

module.exports = { PROJECT_TOOLS };
