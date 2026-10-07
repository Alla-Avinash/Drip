# Feature: MCP integration

## What it is

DRIP runs a local MCP server so external AI apps (Cursor, Claude, etc.) can manage DRIP projects and issues over the Model Context Protocol.

## How to access it

- Configure in **Settings → MCP** (enable it and copy the URL + token).
- The server then runs in the background; external AI apps connect to it.

## How it works

- The server listens on `127.0.0.1:<port>/mcp` (Streamable HTTP, JSON responses).
- Access requires a bearer token; only loopback connections are accepted (with host/origin checks against DNS rebinding).
- The user can enable/disable it and set the port in DRIP settings.

## Tool surface

DRIP advertises only two meta tools to clients:

- `search_tools` — semantically find the right DRIP tool by describing what you want to do.
- `call_tool` — execute a DRIP tool.

Behind these, a hidden catalog holds the real tools, grouped into:

- **Projects** — list projects, get a project, list features, create a feature.
- **Issues** — list/get/create/update/close issues, append a note, get the issue tree, set a parent, assign to a feature, search issues.
- **System** — get status, reindex a project, open in the editor.

The catalog's search text is embedded so tool discovery is semantic, and changes invalidate stale embeddings.

## Flow (plain steps)

1. User enables MCP and copies the connection URL + token from settings.
2. An external AI app connects and calls `search_tools` to find the right operation.
3. It calls `call_tool` to perform the operation against the KB's index.
