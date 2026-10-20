'use strict';

/**
 * MCP tool cards: status, reindex, reveal in editor.
 */

const vscode = require('vscode');
const {
	ToolError,
	requireKbRoot,
	uriFromRel,
	resolveProject,
	loadProjectChildren,
	requireIssueId,
	findIssueRow,
	readNoteText
} = require('./toolShared');

/** @type {import('../toolCatalog').ToolCard[]} */
const SYSTEM_TOOLS = [
	{
		name: 'get_status',
		category: 'system',
		summary: 'Which knowledge base DRIP has open, embedding model, and project count.',
		keywords: ['status', 'health', 'connected', 'which knowledge base', 'version', 'info'],
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		example: {},
		async handler(_args, ctx) {
			const kb = ctx.getKbRoot();
			if (!kb) return { knowledgeBase: null, message: 'No knowledge base open in DRIP.' };
			const { listProjectsFromIndex } = require('../../../indexing/projectViewQuery');
			const { resolveToolEmbeddingModelId } = require('../toolEmbeddings');
			const { projects } = await listProjectsFromIndex(kb);
			return {
				knowledgeBase: kb.fsPath,
				projects: projects.length,
				embeddingModel: await resolveToolEmbeddingModelId(kb)
			};
		}
	},
	{
		name: 'reindex_project',
		category: 'system',
		summary: 'Re-read all note files of a project into the DRIP index (use after editing files outside DRIP).',
		keywords: ['reindex', 'refresh', 'sync', 'rebuild index', 'stale', 'out of date'],
		inputSchema: {
			type: 'object',
			properties: {
				project: { type: 'string', description: 'Project folder (e.g. "Shop.p") or title.' }
			},
			additionalProperties: false
		},
		example: { project: 'Shop.p' },
		async handler(args, ctx) {
			const kb = requireKbRoot(ctx);
			const project = await resolveProject(kb, args.project);
			const { walkKbNoteFiles } = require('../../../indexing/kbFilesystem');
			const { indexNewNoteImmediately } = require('../../../indexing/dripTxt/dripTxtIndex.js');
			let count = 0;
			await walkKbNoteFiles(kb, uriFromRel(kb, project.folderPrefix), async note => {
				await indexNewNoteImmediately(kb, note.uri, ctx.extensionContext);
				count += 1;
			});
			ctx.refreshUi();
			return { project: project.folderPrefix.replace(/\/+$/, ''), filesReindexed: count };
		}
	},
	{
		name: 'open_in_editor',
		category: 'system',
		summary: 'Reveal an issue in the DRIP editor so the user can see it.',
		keywords: ['open', 'show', 'reveal', 'jump to', 'navigate', 'display issue'],
		inputSchema: {
			type: 'object',
			properties: {
				project: { type: 'string', description: 'Project folder (e.g. "Shop.p") or title.' },
				issueId: { type: 'string', description: 'Issue id, e.g. "i-12".' }
			},
			required: ['issueId'],
			additionalProperties: false
		},
		example: { project: 'Shop.p', issueId: 'i-12' },
		async handler(args, ctx) {
			const kb = requireKbRoot(ctx);
			const project = await resolveProject(kb, args.project);
			const { issues } = await loadProjectChildren(kb, project);
			const issueId = requireIssueId(args.issueId);
			const row = findIssueRow(issues, issueId);
			const uri = uriFromRel(kb, row.path);
			const { findIssueHeadingBlock, formatFromPath } = require('../../../document/project/issueInboxLayout');
			const found = findIssueHeadingBlock(await readNoteText(uri), issueId, formatFromPath(uri.fsPath));
			if (!found) throw new ToolError(`${issueId} is indexed in ${row.path} but its heading was not found.`);
			const doc = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(doc, { preview: false });
			const pos = new vscode.Position(found.start, 0);
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
			return { opened: row.path, line: found.start + 1 };
		}
	}
];

module.exports = { SYSTEM_TOOLS };
