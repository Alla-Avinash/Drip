'use strict';

/**
 * Minimal OpenAI-compatible chat client (provider-agnostic).
 * Point `baseUrl` at OpenAI, Groq, OpenRouter, a local Ollama server, etc.
 * Uses the user's own API key (never the host VS Code LLM).
 */

const http = require('http');
const https = require('https');

/**
 * POST JSON and resolve `{ status, text }`.
 * @param {string} urlString
 * @param {unknown} body
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @returns {Promise<{ status: number, text: string }>}
 */
function postJson(urlString, body, headers, timeoutMs) {
	return new Promise((resolve, reject) => {
		let url;
		try {
			url = new URL(urlString);
		} catch (err) {
			reject(new Error('LLM base URL is invalid.'));
			return;
		}
		const mod = url.protocol === 'https:' ? https : http;
		const data = JSON.stringify(body);
		const req = mod.request(
			{
				hostname: url.hostname,
				port: url.port || (url.protocol === 'https:' ? 443 : 80),
				path: url.pathname + url.search,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(data),
					...headers
				}
			},
			res => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', chunk => {
					text += chunk;
				});
				res.on('end', () => resolve({ status: res.statusCode || 0, text }));
			}
		);
		req.on('error', reject);
		req.setTimeout(timeoutMs, () => req.destroy(new Error('LLM request timed out.')));
		req.write(data);
		req.end();
	});
}

/**
 * Request-body fields that turn reasoning ("thinking") off or to its minimum, per provider.
 * There is no standard OpenAI-compatible field for this; unknown providers get nothing.
 * @param {string} base
 * @param {string} model
 * @returns {Record<string, unknown>}
 */
function noThinkingParams(base, model) {
	const host = (() => {
		try {
			return new URL(base).hostname.toLowerCase();
		} catch {
			return '';
		}
	})();
	const m = model.toLowerCase();
	const bare = m.slice(m.lastIndexOf('/') + 1);
	if (host.endsWith('openrouter.ai')) return { reasoning: { enabled: false } };
	if (host.endsWith('deepseek.com') || bare.startsWith('deepseek')) return { thinking: { type: 'disabled' } };
	if (/^gpt-5/.test(bare)) return { reasoning_effort: 'minimal' };
	if (/^o\d/.test(bare)) return { reasoning_effort: 'low' };
	if (bare.startsWith('gemini')) return { reasoning_effort: 'none' };
	if (/^(qwen3|qwq)/.test(bare)) return { enable_thinking: false, chat_template_kwargs: { enable_thinking: false } };
	return {};
}

/**
 * @param {{
 *   baseUrl: string,
 *   model: string,
 *   apiKey: string,
 *   messages: Array<{ role: string, content: string }>,
 *   temperature?: number,
 *   maxTokens?: number,
 *   timeoutMs?: number,
 *   json?: boolean,
 *   noThinking?: boolean
 * }} opts
 * @returns {Promise<{ content: string, finishReason: string }>} assistant message content
 */
async function chatComplete(opts) {
	const base = String(opts.baseUrl || '').trim().replace(/\/+$/, '');
	if (!base) throw new Error('LLM base URL is not configured (Settings → LLM).');
	const model = String(opts.model || '').trim();
	if (!model) throw new Error('LLM model is not configured (Settings → LLM).');
	const apiKey = String(opts.apiKey || '').trim();
	if (!apiKey) throw new Error('LLM API key is not set (Settings → LLM).');

	const body = {
		model,
		messages: opts.messages,
		temperature: opts.temperature ?? 0,
		max_tokens: opts.maxTokens ?? 1024
	};
	const send = payload =>
		postJson(
			`${base}/chat/completions`,
			payload,
			apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			opts.timeoutMs ?? 30000
		);

	const thinkingOff = opts.noThinking ? noThinkingParams(base, model) : {};
	const thinkingKeys = Object.keys(thinkingOff);
	let payload = { ...body, ...thinkingOff };
	if (opts.json) payload.response_format = { type: 'json_object' };
	let { status, text } = await send(payload);
	// OpenAI reasoning models want `max_completion_tokens` and only the default temperature (one error per call);
	// a provider that rejects the thinking switch gets the request again without it.
	for (let i = 0; i < 3 && (status === 400 || status === 422); i++) {
		const next = { ...payload };
		if (thinkingKeys.some(k => k in next) && /thinking|reasoning|chat_template|unknown|unrecognized|extra/i.test(text)) {
			for (const k of thinkingKeys) delete next[k];
		} else if (/max_completion_tokens/i.test(text) && 'max_tokens' in next) {
			next.max_completion_tokens = next.max_tokens;
			delete next.max_tokens;
		} else if (/temperature/i.test(text) && 'temperature' in next) {
			delete next.temperature;
		} else {
			break;
		}
		payload = next;
		({ status, text } = await send(payload));
	}
	// Some OpenAI-compatible providers reject `response_format`; retry once without it.
	if (opts.json && status === 400 && /response_format|json/i.test(text)) {
		const { response_format, ...rest } = payload;
		({ status, text } = await send(rest));
	}

	if (status < 200 || status >= 300) {
		let detail = text;
		try {
			const parsed = JSON.parse(text);
			detail = (parsed.error && (parsed.error.message || parsed.error)) || text;
		} catch {
			/* keep raw text */
		}
		throw new Error(`LLM request failed (${status}): ${String(detail).slice(0, 300)}`);
	}

	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error('LLM returned invalid JSON.');
	}
	const choice = data && data.choices && data.choices[0];
	const content = choice && choice.message && choice.message.content;
	if (typeof content !== 'string') throw new Error('LLM response had no message content.');
	return { content, finishReason: String((choice && choice.finish_reason) || '') };
}

module.exports = { chatComplete };
