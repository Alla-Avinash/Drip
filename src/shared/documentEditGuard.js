'use strict';

/**
 * Shared depth so soft-lock / paste handlers ignore extension-driven buffer edits
 * (heading identity reconcile, RHS Apply, soft-lock undo).
 */
let depth = 0;

/**
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function runGuardedDocumentEdit(fn) {
	depth += 1;
	try {
		return await fn();
	} finally {
		depth -= 1;
	}
}

function isGuardedDocumentEditActive() {
	return depth > 0;
}

module.exports = {
	runGuardedDocumentEdit,
	isGuardedDocumentEditActive
};
