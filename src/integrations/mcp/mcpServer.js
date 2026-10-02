'use strict';

/**
 * Local MCP server (Streamable HTTP, JSON responses) on 127.0.0.1:<port>/mcp.
 * Advertises only the meta tools (`search_tools`, `call_tool`) + the `drip://guide` resource.
 *
 * Security: loopback bind, Host header check (DNS rebinding), browser Origin rejected,
 * `Authorization: Bearer <token>` required.
 */

const http = require('http');
const crypto = require('crypto');
const { buildMetaToolDefs, dispatchToolCall } = require('./metaTools');
const { ROUTER_GUIDE } = require('./routerGuide');

const MCP_PATH = '/mcp';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY_BYTES = 1024 * 1024;
const GUIDE_URI = 'drip://guide';

/**
 * @param {string} a
 * @param {string} b
 */
function safeEqual(a, b) {
	const x = Buffer.from(String(a));
	const y = Buffer.from(String(b));
	return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {unknown} [body]
 * @param {Record<string, string>} [headers]
 */
function send(res, status, body, headers = {}) {
	if (body === undefined) {
		res.writeHead(status, headers);
		res.end();
		return;
	}
	const text = JSON.stringify(body);
	res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
	res.end(text);
}

/**
 * @param {unknown} id
 * @param {number} code
 * @param {string} message
 */
function rpcError(id, code, message) {
	return { jsonrpc: '2.0', id: id == null ? null : id, error: { code, message } };
}

/**
 * @param {import('./metaTools').MetaResult} r
 */
function toolResult(r) {
	if (r.ok) {
		const data = r.data;
		/** @type {Record<string, unknown>} */
		const out = { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false };
		if (data && typeof data === 'object' && !Array.isArray(data)) out.structuredContent = data;
		return out;
	}
	const text = r.data ? `${r.error}\n${JSON.stringify(r.data)}` : r.error;
	return { content: [{ type: 'text', text }], isError: true };
}

class DripMcpServer {
	/**
	 * @param {{
	 *   port: number,
	 *   token: string,
	 *   version: string,
	 *   toolContext: import('./tools/toolShared').ToolContext
	 * }} opts
	 */
	constructor(opts) {
		this.port = opts.port;
		this.token = opts.token;
		this.version = opts.version;
		this.toolContext = opts.toolContext;
		/** @type {import('http').Server | null} */
		this.server = null;
		/** @type {Set<import('http').ServerResponse>} */
		this.sseClients = new Set();
	}

	get url() {
		return `http://127.0.0.1:${this.port}${MCP_PATH}`;
	}

	/** @returns {Promise<void>} */
	start() {
		return new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => {
				this.onRequest(req, res).catch(err => {
					console.error('[DRIP MCP] request failed', err);
					if (!res.headersSent) send(res, 500, rpcError(null, -32603, 'Internal error'));
				});
			});
			server.once('error', reject);
			server.listen(this.port, '127.0.0.1', () => {
				server.off('error', reject);
				server.on('error', err => console.error('[DRIP MCP] server error', err));
				this.server = server;
				resolve();
			});
		});
	}

	/** @returns {Promise<void>} */
	stop() {
		const s = this.server;
		this.server = null;
		for (const res of this.sseClients) {
			try {
				res.end();
			} catch (err) {
				// ignore
			}
		}
		this.sseClients.clear();
		if (!s) return Promise.resolve();
		return new Promise(resolve => s.close(() => resolve()));
	}

	/**
	 * Push a JSON-RPC server→client notification to every open SSE stream.
	 * @param {string} method
	 * @param {unknown} [params]
	 */
	sendNotification(method, params) {
		const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
		for (const res of this.sseClients) {
			try {
				res.write(`event: message\ndata: ${msg}\n\n`);
			} catch (err) {
				console.error('[DRIP MCP] SSE write failed', err && err.message);
				this.sseClients.delete(res);
			}
		}
	}

	/** Tell connected clients their tool list is stale (e.g. DRIP settings changed). */
	notifyToolsChanged() {
		this.sendNotification('notifications/tools/list_changed', {});
	}

	/**
	 * Optional SSE stream for server→client notifications (MCP Streamable HTTP).
	 * @param {import('http').IncomingMessage} req
	 * @param {import('http').ServerResponse} res
	 */
	handleSse(req, res) {
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		});
		res.write(': connected\n\n');
		this.sseClients.add(res);
		const heartbeat = setInterval(() => {
			try {
				res.write(': ping\n\n');
			} catch (err) {
				// ignore; cleanup on close below
			}
		}, 15000);
		const cleanup = () => {
			clearInterval(heartbeat);
			this.sseClients.delete(res);
		};
		req.on('close', cleanup);
		req.on('error', cleanup);
	}

	/**
	 * @param {import('http').IncomingMessage} req
	 * @param {import('http').ServerResponse} res
	 */
	async onRequest(req, res) {
		const host = String(req.headers.host || '').toLowerCase();
		if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
			send(res, 403, { error: 'Forbidden host' });
			return;
		}
		const origin = String(req.headers.origin || '');
		if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
			send(res, 403, { error: 'Forbidden origin' });
			return;
		}
		const urlPath = String(req.url || '').split('?')[0];
		if (urlPath === '/health' && req.method === 'GET') {
			send(res, 200, { ok: true, name: 'drip' });
			return;
		}
		if (urlPath !== MCP_PATH) {
			send(res, 404, { error: 'Not found' });
			return;
		}
		const auth = String(req.headers.authorization || '');
		const m = auth.match(/^Bearer\s+(.+)$/i);
		if (!m || !safeEqual(m[1].trim(), this.token)) {
			send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
			return;
		}
		if (req.method === 'GET' && /text\/event-stream/i.test(String(req.headers.accept || ''))) {
			this.handleSse(req, res);
			return;
		}
		if (req.method !== 'POST') {
			send(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
			return;
		}

		let raw;
		try {
			raw = await readBody(req);
		} catch (err) {
			send(res, 413, rpcError(null, -32600, String(err && err.message ? err.message : err)));
			return;
		}
		let payload;
		try {
			payload = JSON.parse(raw);
		} catch {
			send(res, 400, rpcError(null, -32700, 'Parse error'));
			return;
		}

		const batch = Array.isArray(payload);
		const messages = batch ? payload : [payload];
		const responses = [];
		for (const msg of messages) {
			if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') continue;
			if (msg.id === undefined || msg.id === null) continue;
			responses.push(await this.handleRpc(msg));
		}
		if (!responses.length) {
			send(res, 202);
			return;
		}
		send(res, 200, batch ? responses : responses[0]);
	}

	/**
	 * @param {{ id: string | number, method: string, params?: any }} msg
	 */
	async handleRpc(msg) {
		const { id, method } = msg;
		const params = msg.params || {};
		/** @param {unknown} result */
		const ok = result => ({ jsonrpc: '2.0', id, result });
		switch (method) {
			case 'initialize': {
				const asked = String(params.protocolVersion || '');
				return ok({
					protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
					capabilities: { tools: { listChanged: true }, resources: { listChanged: false } },
					serverInfo: { name: 'drip', title: 'DRIP knowledge base', version: this.version },
					instructions: ROUTER_GUIDE
				});
			}
			case 'ping':
				return ok({});
			case 'tools/list':
				return ok({ tools: buildMetaToolDefs() });
			case 'tools/call': {
				const name = String(params.name || '');
				const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
				return ok(toolResult(await dispatchToolCall(name, args, this.toolContext)));
			}
			case 'resources/list':
				return ok({
					resources: [
						{
							uri: GUIDE_URI,
							name: 'DRIP guide',
							description: 'What DRIP can do and how to use search_tools / call_tool.',
							mimeType: 'text/markdown'
						}
					]
				});
			case 'resources/templates/list':
				return ok({ resourceTemplates: [] });
			case 'resources/read':
				if (params.uri !== GUIDE_URI) return rpcError(id, -32002, `Resource not found: ${params.uri}`);
				return ok({ contents: [{ uri: GUIDE_URI, mimeType: 'text/markdown', text: ROUTER_GUIDE }] });
			case 'prompts/list':
				return ok({ prompts: [] });
			default:
				return rpcError(id, -32601, `Method not found: ${method}`);
		}
	}
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		/** @type {Buffer[]} */
		const chunks = [];
		let size = 0;
		req.on('data', c => {
			size += c.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('Request body too large'));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

module.exports = {
	DripMcpServer,
	MCP_PATH
};
