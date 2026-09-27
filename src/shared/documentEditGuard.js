'use strict';

/**
 * Shared depth so soft-lock / paste handlers ignore extension-driven buffer edits
 * (heading identity reconcile, RHS Apply, soft-lock undo).
 */
let depth = 0;

/**
 * Files the extension just rewrote on disk (Project View create/move…). An open editor reloads
 * them asynchronously, after any `runGuardedDocumentEdit` has returned — so track by path + time.
 * @type {Map<string, number>} fsPath (lowercase) → expiry ms
 */
const expectedDiskWrites = new Map();
const EXPECTED_DISK_WRITE_MS = 5000;

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

/**
 * @param {{ fsPath: string }} uri
 */
function diskWriteKey(uri) {
	return String((uri && uri.fsPath) || '').toLowerCase();
}

/**
 * Call right before the extension writes a note file on disk.
 * @param {{ fsPath: string }} uri
 */
function markExpectedDiskWrite(uri) {
	const key = diskWriteKey(uri);
	if (key) expectedDiskWrites.set(key, Date.now() + EXPECTED_DISK_WRITE_MS);
}

/**
 * True while an editor change for `uri` is likely the reload of an extension disk write.
 * @param {{ fsPath: string }} uri
 */
function isExpectedDiskWrite(uri) {
	const key = diskWriteKey(uri);
	const until = expectedDiskWrites.get(key);
	if (!until) return false;
	if (Date.now() > until) {
		expectedDiskWrites.delete(key);
		return false;
	}
	return true;
}

module.exports = {
	runGuardedDocumentEdit,
	isGuardedDocumentEditActive,
	markExpectedDiskWrite,
	isExpectedDiskWrite
};
