'use strict';

/**
 * Compressed capability directory ("router prompt") sent once as MCP `instructions`
 * and exposed as resource `drip://guide`. Keep it short — detail lives in tool schemas.
 */

const ROUTER_GUIDE = `DRIP = file-based knowledge base app. Projects are folders "Name.p/".
Capabilities (categories):
- projects: list projects, project overview/progress
- features: list/create features (f-N; "Name.f" folders)
- issues: list/filter, read full content (text inside an issue; sub-issues as titles), create, update title/status/priority, close, add notes
- hierarchy: issue tree, parent links across files, move inbox issue to a feature
- search: find issues by meaning (semantic)
- system: status, reindex after outside edits, open an issue in the editor
Standard tools (call directly): list_projects, list_issues, get_issue, create_issue, search_issues, get_status.
Other tools: search_tools(query) → pick a tool → call_tool(name, arguments).
Lean output: tools accept "fields" to return only what you need (omit for a lean default; "content"/"subIssues" on get_issue are opt-in).
Rules: issue ids are "i-N" (never invent; DRIP assigns them). Sub-issues are indented under their parent. "project" may be omitted when only one project exists.
Namespace: "drip:" means "route this to DRIP". The prefix is optional — a request is DRIP-scoped when it mentions DRIP concepts (.p project folders, i-N issues, f-N features, .d.txt notes, KB, indexing/retrieval). "drip:" is a scope marker, not a tool name.`;

module.exports = { ROUTER_GUIDE };
