'use strict';

/** Shared KB root getter for heading form issue-id stamping (avoids panel↔apply cycles). */

/** @type {(() => import('vscode').Uri | undefined) | undefined} */
let getKbRootFn;

/**
 * @param {() => import('vscode').Uri | undefined} fn
 */
function setHeadingFormKbRootGetter(fn) {
	getKbRootFn = fn;
}

/**
 * @returns {import('vscode').Uri | undefined}
 */
function getHeadingFormKbRoot() {
	return typeof getKbRootFn === 'function' ? getKbRootFn() : undefined;
}

module.exports = {
	setHeadingFormKbRootGetter,
	getHeadingFormKbRoot
};
