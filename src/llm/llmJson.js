'use strict';

/**
 * JSON-mode LLM call with a clear error when the reply is prose or cut off.
 * Used by LLM ingest (`src/ingest/`). DRIP Chat keeps its own copy in `captureEngine.js`.
 */

const { chatComplete } = require('./llmClient');

/** max_tokens is only a ceiling (billing is per generated token); reasoning models also spend it on hidden thinking. */
const REPLY_TOKEN_FLOOR = 2048;
const RETRY_TOKEN_CAP = 8192;

/**
 * @param {{ content: string, finishReason: string }} reply
 * @returns {any}
 */
function parseJsonReply(reply) {
	const s = String(reply.content || '').trim();
	const cleaned = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
	const start = cleaned.indexOf('{');
	const end = cleaned.lastIndexOf('}');
	if (start >= 0 && end > start) {
		try {
			return JSON.parse(cleaned.slice(start, end + 1));
		} catch {
			/* fall through to the errors below */
		}
	}
	if (reply.finishReason === 'length') {
		throw new Error(
			'The LLM ran out of output tokens before finishing its reply. If your model is a reasoning/thinking model ' +
				'(e.g. gpt-5, o-series, DeepSeek-R1, Qwen3), its hidden thinking uses up the limit — pick a non-reasoning model ' +
				'such as gpt-4o-mini in DRIP Settings → Lightweight LLM.'
		);
	}
	const preview = s.length > 200 ? `${s.slice(0, 200)}…` : s;
	throw new Error(`The LLM did not reply in the expected format. It said: "${preview || '(empty)'}"`);
}

/**
 * chatComplete in JSON mode; one retry with a larger ceiling if the reply was cut off.
 * @param {Parameters<typeof chatComplete>[0]} opts
 * @returns {Promise<any>} parsed JSON object
 */
async function completeJson(opts) {
	const maxTokens = opts.maxTokens || REPLY_TOKEN_FLOOR;
	let reply = await chatComplete({ ...opts, json: true, maxTokens });
	if (reply.finishReason === 'length' && maxTokens < RETRY_TOKEN_CAP) {
		reply = await chatComplete({ ...opts, json: true, maxTokens: RETRY_TOKEN_CAP });
	}
	return parseJsonReply(reply);
}

module.exports = { completeJson, parseJsonReply, REPLY_TOKEN_FLOOR };
