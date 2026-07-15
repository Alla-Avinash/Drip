'use strict';

const vscode = require('vscode');
const { getMetadataTemplateConfig, resolveTypeFromMarkerOrHeading } = require('../../document/model/dripnoteMetadataTemplates');
const {
	DEFAULT_DURATION_UNITS,
	parsePartialDurationInput,
	resolveDurationUnits
} = require('../../document/parse/dripnoteDuration');

const HEADING_RE = /^\s*#{1,6}\s+/;
const KEY_VALUE_RE = /^\s*([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i;
const TYPE_LINE_RE = /^\s*\.[a-z][a-z0-9_-]*\b/i;
const COMMENT_RE = /^\s*\/\//;

function isMetadataCandidateLine(text) {
	const t = String(text || '').trim();
	return !!t && (TYPE_LINE_RE.test(t) || KEY_VALUE_RE.test(t));
}

function findActiveMarkerLine(lines, lineNo) {
	for (let i = lineNo; i >= 0; i--) {
		const t = String(lines[i] || '').trim();
		if (TYPE_LINE_RE.test(t)) return i;
		if (!t || HEADING_RE.test(t) || t === '---') break;
	}
	return -1;
}

function leadingWhitespace(line) {
	const m = String(line || '').match(/^\s*/);
	return m ? m[0] : '';
}

function blockBounds(lines, lineNo) {
	let start = 0;
	for (let i = lineNo; i >= 0; i--) {
		const t = String(lines[i] || '').trim();
		if (HEADING_RE.test(t) || t === '---') {
			start = i + 1;
			break;
		}
	}
	let end = lines.length;
	for (let i = start; i < lines.length; i++) {
		const t = String(lines[i] || '').trim();
		if (i > lineNo && (HEADING_RE.test(t) || t === '---' || !t)) {
			end = i;
			break;
		}
	}
	return { start, end };
}

function findBlockHeadingLine(lines, start) {
	for (let i = start - 1; i >= 0; i--) {
		const t = String(lines[i] || '').trim();
		if (HEADING_RE.test(t)) return t;
		if (t === '---') break;
	}
	return '';
}

function detectBlockType(lines, start, end, settings) {
	const headingLine = findBlockHeadingLine(lines, start);
	let markerLine = '';
	for (let i = start; i < end; i++) {
		const text = String(lines[i] || '').trim();
		if (TYPE_LINE_RE.test(text)) {
			markerLine = text;
			break;
		}
	}
	return resolveTypeFromMarkerOrHeading(markerLine || headingLine, settings);
}

function isInValidMetadataZone(lines, lineNo) {
	const current = String(lines[lineNo] || '');
	if (!current.trim()) return false;
	let headingLine = -1;
	for (let i = lineNo; i >= 0; i--) {
		const t = String(lines[i] || '').trim();
		if (HEADING_RE.test(t)) {
			headingLine = i;
			break;
		}
		if (t === '---') break;
	}
	if (headingLine < 0) return false;
	for (let i = headingLine + 1; i < lineNo; i++) {
		const t = String(lines[i] || '').trim();
		if (!t || COMMENT_RE.test(t)) return false;
		if (!isMetadataCandidateLine(t)) return false;
	}
	return true;
}

function registerDripnoteMetadataCompletion(context) {
	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider(
			{ language: 'dripnote' },
			{
				provideCompletionItems(document, position) {
					if (document.languageId !== 'dripnote') return undefined;
					const settings = getMetadataTemplateConfig();
					if (!settings.enabled) return undefined;
					const lines = document.getText().split(/\r?\n/);
					const lineNo = position.line;
					const line = String(lines[lineNo] || '');
					const linePrefix = line.slice(0, position.character);
					if (linePrefix.includes('[')) return undefined;
					if (!isInValidMetadataZone(lines, lineNo) && !TYPE_LINE_RE.test(line.trim())) return undefined;
					const markerLine = findActiveMarkerLine(lines, lineNo);
					if (markerLine < 0) return undefined;
					if (lineNo > markerLine) {
						const indent = String(line || '').match(/^\s*/);
						if (!indent || indent[0] !== '\t') return undefined;
					}
					const { start, end } = blockBounds(lines, lineNo);
					const type = detectBlockType(lines, start, end, settings);
					if (!type) return undefined;
					const attrKeys = (type.attributes || []).map(a => String(a.key || '').toLowerCase()).filter(Boolean);
					const attrByKey = new Map((type.attributes || []).map(a => [String(a.key || '').toLowerCase(), a]));
					const m = linePrefix.match(KEY_VALUE_RE);
					if (m) {
						const key = String(m[1] || '').toLowerCase();
						const keyStart = line.indexOf(String(m[1] || ''));
						const colonIdx = line.indexOf(':');
						const valueStart = colonIdx + 1;
						if (position.character <= valueStart) {
							return attrKeys.map(k => {
								const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Property);
								item.insertText = `${k}: `;
								item.range = new vscode.Range(lineNo, keyStart, lineNo, Math.max(keyStart, position.character));
								return item;
							});
						}
						const rule = attrByKey.get(key);
						const valueBeforeCursor = line.slice(valueStart, position.character).replace(/^\s+/, '');
						if (rule && rule.type === 'duration') {
							const partial = parsePartialDurationInput(valueBeforeCursor);
							if (partial.phase === 'number' || partial.phase === 'unit') {
								const units = resolveDurationUnits(undefined);
								const filtered = units.filter(u => {
									if (!partial.partialUnit) return true;
									return u.toLowerCase().startsWith(partial.partialUnit);
								});
								if (filtered.length) {
									return filtered.map(u => {
										const item = new vscode.CompletionItem(u, vscode.CompletionItemKind.Unit);
										item.insertText =
											partial.phase === 'number' ? ` ${u}` : u.slice(partial.partialUnit.length);
										item.range = new vscode.Range(lineNo, position.character, lineNo, line.length);
										return item;
									});
								}
							}
						}
						if (rule && rule.type === 'enum' && Array.isArray(rule.values)) {
							const valueRangeStart = valueStart;
							const valueRangeEnd = line.length;
							return rule.values.map(v => {
								const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.Value);
								item.insertText = ` ${v}`;
								item.range = new vscode.Range(lineNo, valueRangeStart, lineNo, Math.max(valueRangeStart, position.character, valueRangeEnd));
								return item;
							});
						}
					}
					return attrKeys.map(k => {
						const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Property);
						item.insertText = `${k}: `;
						return item;
					});
				}
			},
			':',
			' ',
			'0',
			'1',
			'2',
			'3',
			'4',
			'5',
			'6',
			'7',
			'8',
			'9',
			'.'
		)
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(async e => {
			const doc = e.document;
			if (!doc || doc.languageId !== 'dripnote') return;
			const settings = getMetadataTemplateConfig();
			if (!settings.enabled || !settings.autoInsertTemplate) return;
			const change = (e.contentChanges || [])[0];
			if (!change || !String(change.text || '').includes('\n')) return;
			let lineNo = change.range.start.line;
			let line = String(doc.lineAt(lineNo).text || '').trim();
			const prev = Math.max(0, lineNo - 1);
			const prevLine = String(doc.lineAt(prev).text || '').trim();
			if (TYPE_LINE_RE.test(prevLine)) {
				lineNo = prev;
				line = prevLine;
			}
			if (!TYPE_LINE_RE.test(line)) return;
			const lines = doc.getText().split(/\r?\n/);
			if (!isInValidMetadataZone(lines, lineNo)) return;
			const type = resolveTypeFromMarkerOrHeading(line, settings);
			if (!type) return;
			if (type.displayTemplate === false) return;
			const { start, end } = blockBounds(lines, lineNo);
			const present = new Set();
			for (let i = start; i < end; i++) {
				const m = String(lines[i] || '').match(KEY_VALUE_RE);
				if (m) present.add(String(m[1] || '').trim().toLowerCase());
			}
			const insertLines = [];
			for (const a of (type.attributes || [])) {
				const key = String(a.key || '').toLowerCase();
				if (!key) continue;
				if (!a.required) continue;
				if (present.has(key)) continue;
				const markerIndent = leadingWhitespace(doc.lineAt(lineNo).text || '');
				insertLines.push(`${markerIndent}\t${key}: `);
			}
			if (!insertLines.length) return;
			const nextLineNo = lineNo + 1;
			const nextLine = nextLineNo < doc.lineCount ? String(doc.lineAt(nextLineNo).text || '').trim() : '';
			if (nextLine) return;
			const edit = new vscode.WorkspaceEdit();
			edit.insert(doc.uri, new vscode.Position(lineNo, doc.lineAt(lineNo).text.length), `\n${insertLines.join('\n')}`);
			await vscode.workspace.applyEdit(edit);
		})
	);
}

module.exports = { registerDripnoteMetadataCompletion };

