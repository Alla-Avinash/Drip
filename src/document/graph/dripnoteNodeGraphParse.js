'use strict';

const { getMetadataSettings } = require('../model/dripnoteMetadataTemplates');

const PARENT_LINE_RE = /^\s*parent\s*:\s*\[([^\]]*)\]\s*$/i;
const RELATION_LINE_RE = /^\s*-([a-z][a-z0-9-]*)\s*:\s*\[([^\]]*)\]\s*$/i;

function escapeRegex(value) {
	return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} value
 * @param {string} conceptShortcut
 * @returns {string[]}
 */
function parseConceptRefs(value, conceptShortcut) {
	if (!conceptShortcut) return [];
	const tokenRe = new RegExp(`^${escapeRegex(conceptShortcut)}(\\d+)$`, 'i');
	const refs = [];
	const seen = new Set();
	for (const raw of String(value || '').split(',')) {
		const token = raw.trim();
		const match = token.match(tokenRe);
		if (!match) continue;
		const ref = `${conceptShortcut.toLowerCase()}${parseInt(match[1], 10)}`;
		if (seen.has(ref)) continue;
		seen.add(ref);
		refs.push(ref);
	}
	return refs;
}

/**
 * @param {string} title
 * @param {any} settings
 * @returns {{ badge: string, ref: string }}
 */
function classifyNodeTitle(title, settings) {
	const normalized = String(title || '').trim();
	const types = (settings.types || [])
		.map(type => ({
			marker: String(type.marker || '').replace(/^\./, ''),
			shortcut: String(type.shortcut || '').replace(/\./g, '')
		}))
		.filter(type => type.marker || type.shortcut)
		.sort((a, b) => Math.max(b.marker.length, b.shortcut.length) - Math.max(a.marker.length, a.shortcut.length));

	for (const type of types) {
		for (const prefix of [type.shortcut, type.marker].filter(Boolean)) {
			const match = normalized.match(new RegExp(`^(\\.?${escapeRegex(prefix)})(\\d*)(?=\\s|$)`, 'i'));
			if (!match) continue;
			const badge = match[1] + (match[2] || '');
			return {
				badge,
				ref: match[2] && type.shortcut
					? `${type.shortcut.toLowerCase()}${parseInt(match[2], 10)}`
					: ''
			};
		}
	}
	return { badge: '#', ref: '' };
}

/**
 * Build a file-local graph from the already-validated Canvas heading tree.
 * Nested headings keep their structural parent. `parent:` is used only when a
 * heading has no structural parent, matching the workflow hierarchy safeguard.
 *
 * @param {any[]} headingRoots
 * @param {number} docIdx
 * @returns {{ nodes: any[], edges: any[], relationTypes: string[] }}
 */
function buildNodeGraphForCanvas(headingRoots, docIdx) {
	const settings = getMetadataSettings();
	const conceptShortcut = String(settings.typeById?.get('concept')?.shortcut || '')
		.replace(/\./g, '')
		.trim()
		.toLowerCase();
	const nodes = [];
	const pending = [];
	const byRef = new Map();

	function walk(items, structuralParentId, depth) {
		for (const node of items || []) {
			const id = `ng-${docIdx}-${node.lineIndex}`;
			const titleInfo = classifyNodeTitle(node.title, settings);
			const graphNode = {
				id,
				lineIndex: node.lineIndex,
				title: String(node.title || ''),
				badge: titleInfo.badge,
				ref: titleInfo.ref,
				depth,
				root: !structuralParentId
			};
			nodes.push(graphNode);
			if (titleInfo.ref && !byRef.has(titleInfo.ref)) byRef.set(titleInfo.ref, graphNode);

			let explicitParents = [];
			const relations = [];
			for (const line of node.metaLines || []) {
				const parentMatch = String(line || '').match(PARENT_LINE_RE);
				if (parentMatch) {
					explicitParents = parseConceptRefs(parentMatch[1], conceptShortcut);
					continue;
				}
				const relationMatch = String(line || '').match(RELATION_LINE_RE);
				if (!relationMatch) continue;
				relations.push({
					type: String(relationMatch[1] || '').toLowerCase(),
					targetRefs: parseConceptRefs(relationMatch[2], conceptShortcut)
				});
			}
			pending.push({ graphNode, structuralParentId, explicitParents, relations });
			walk(node.children || [], id, depth + 1);
		}
	}
	walk(headingRoots || [], '', 0);

	const edges = [];
	const relationTypes = new Set();
	for (const item of pending) {
		if (item.structuralParentId) {
			edges.push({ source: item.structuralParentId, target: item.graphNode.id, kind: 'hierarchy', label: '' });
		} else {
			for (const parentRef of item.explicitParents) {
				const parent = byRef.get(parentRef);
				if (!parent || parent.id === item.graphNode.id) continue;
				edges.push({ source: parent.id, target: item.graphNode.id, kind: 'parent', label: 'parent' });
			}
		}
		for (const relation of item.relations) {
			for (const targetRef of relation.targetRefs) {
				const target = byRef.get(targetRef);
				if (!target || target.id === item.graphNode.id) continue;
				edges.push({
					source: item.graphNode.id,
					target: target.id,
					kind: 'relation',
					label: relation.type
				});
				relationTypes.add(relation.type);
			}
		}
	}

	return {
		nodes,
		edges,
		relationTypes: [...relationTypes].sort()
	};
}

module.exports = {
	buildNodeGraphForCanvas,
	parseConceptRefs,
	classifyNodeTitle
};
