'use strict';

const vscode = require('vscode');
const path = require('path');
const { kbRootFor, projectFolderPrefixForNote, createTagForNote, knownTagsLowerForNote } = require('../../../graph/noteTagScope');
const {
	getMetadataSettings,
	getMetadataSettingsForNotePath,
	allowedHeadingTypeIdsForPath,
	BUILTIN_DOCUMENT_TYPE_IDS,
	inferTypeFromHeadingLine,
	inferTypeFromMarkerLine,
	getTypeRule,
	matchHeadingTitleTypePrefix
} = require('../../model/dripNoteMetadataTemplates.js');
const { normalizeDateTimeValue } = require('../../parse/dripTxt/dripTxtDatetime.js');
const { isValidDurationValue, normalizeDurationValue, resolveDurationUnits } = require('../../parse/dripNoteDuration.js');
const { collectHeadingSequenceValidated, splitFileTopRegion } = require('../../parse/dripTxt/dripTxtHeadingParse.js');
const { collectHeadingVersusAboveLineIndentErrors } = require('../../parse/dripTxt/dripTxtHeadingAboveIndent.js');
const { collectHeadingIdentityDiagnostics } = require('../../../indexing/dripTxt/dripTxtHeadingIdentity.js');
const {
	isProtectedFolderIndexNotePath,
	isDripProjectFolderName
} = require('../../model/dripNoteProjectFolder.js');
const { classifyPersistentHeadingTitle } = require('../../model/dripTxt/dripTxtPersistentHeading.js');
const HEADING_HIERARCHY_CODE = 'drip.headingHierarchyIndent';
const HEADING_ABOVE_INDENT_CODE = 'drip.headingAboveIndent';
const SPACE_INDENT_CODE = 'drip.spaceIndent';
const HEADING_SPACE_BEFORE_HASH_CODE = 'drip.headingIndentSpacesBeforeHash';
const FOLDER_INDEX_TYPED_CODE = 'drip.folderIndexTypedHeading';
const CONCEPT_IN_PROJECT_CODE = 'drip.conceptInProject';

const HEADING_RE = /^\s*#\d*\s+/;
const TYPE_RE = /^\s*\.[a-z][a-z0-9_-]*\b/i;
const RELATION_RE = /^\s*([a-z][a-z0-9_-]*)\s*:\s*\[[^\]]*\]\s*$/i;
const SHORTHAND_RE = /^\s*\[[^\]]*\]\s*$/;
const KEY_VALUE_RE = /^\s*([a-z][a-z0-9_-]*)\s*:\s*(.+)$/i;
const HEADING_ID_LINE_RE = /^\s*@+\s*h\d+\s*$/i;
const HEADING_IDENTITY_DUPLICATE_CODE = 'drip.duplicateHeadingIdentity';
const EXTRA_FILE_LEVEL_HEADING_CODE = 'drip.extraFileLevelHeading';
const COMMENT_RE = /^\s*\/\//;
const FIXED_ALLOWED_KEYS = new Set(['filename', 'created', 'random', 'fileid', 'tags', 'pre-req']);
const UNKNOWN_TAG_CODE_PREFIX = 'drip.unknownTag:';
const INVALID_METADATA_VALUE_CODE_PREFIX = 'drip.invalidMetaValue:';
const MISSING_METADATA_KEY_CODE_PREFIX = 'drip.missingMetaKey:';
const CREATE_TAG_COMMAND = 'drip.createIndividualTag';
const NORMALIZE_DATETIME_COMMAND = 'drip.normalizeMetadataDatetime';
const INDIVIDUAL_TAGS_GRAPH_NAME = 'individual tags';
const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const MARKER_NAME_RE = /^\s*\.[a-z][a-z0-9_-]*\b/i;
function leadingWhitespaceCount(line) {
	const m = String(line || '').match(/^\s*/);
	return m ? m[0].length : 0;
}

function inferExplicitHeadingType(line, settings) {
	return inferTypeFromHeadingLine(line, settings);
}

function getConfiguredAllowedMetadataKeys() {
	const cfg = vscode.workspace.getConfiguration('drip');
	const raw = cfg.get('drip.dripnoteAllowedMetadataKeys', []);
	const out = new Set();
	for (const item of Array.isArray(raw) ? raw : []) {
		const key = String(item || '').trim().toLowerCase();
		if (key) out.add(key);
	}
	return out;
}

function parseTagTokenRangesFromLine(line) {
	const s = String(line || '');
	const open = s.indexOf('[');
	const close = s.lastIndexOf(']');
	if (open < 0 || close < 0 || close <= open) return [];
	const inner = s.slice(open + 1, close);
	const out = [];
	let cursor = 0;
	for (const chunk of inner.split(',')) {
		const raw = String(chunk || '');
		const leftTrim = raw.length - raw.trimStart().length;
		const token = raw.trim();
		const start = open + 1 + cursor + leftTrim;
		const end = start + token.length;
		if (token) out.push({ label: token, start, end });
		cursor += raw.length + 1;
	}
	return out;
}

/**
 * Which tag scope a note belongs to: the per-project graph when the note sits inside a
 * project (`.p`) / feature (`.f`) folder, otherwise the KB "individual tags" graph.
 * @param {import('vscode').ExtensionContext} context
 * @param {string} noteFsPath
 * @returns {{ isProject: boolean }}
 */
function tagScopeForNote(context, noteFsPath) {
	const kbRoot = kbRootFor(context);
	const prefix = kbRoot ? projectFolderPrefixForNote(kbRoot, noteFsPath) : '';
	return { isProject: Boolean(prefix) };
}

/**
 * Diagnostic message for an unknown tag, phrased for the note's tag scope.
 * @param {string} tagLabel
 * @param {boolean} isProject
 */
function unknownTagMessage(tagLabel, isProject) {
	if (isProject) return `Unknown tag "${tagLabel}". Create this tag in the project graph.`;
	return `Unknown tag "${tagLabel}". Create it in "${INDIVIDUAL_TAGS_GRAPH_NAME}" graph.`;
}

function collectDiagnosticsForBlock(lines, start, endExclusive, blockTypeId, settings, diagnostics, knownTagsLower, enforceTypedIndent, headingIndent, isProject) {
	const seenKeys = new Set();
	const seenTemplateKeys = new Set();
	const allowedCustom = getConfiguredAllowedMetadataKeys();
	let activeTypeId = String(blockTypeId || '').toLowerCase();
	let markerSeen = false;
	let markerLine = -1;
	let markerIndent = -1;
	let seenNonSpecialMeta = false;
	const strictOn = settings.useTemplates && settings.strictValidation && !settings.ignoreErrors;
	const indentChecksOn = strictOn && enforceTypedIndent && !!settings.showIndentErrors;
	for (let i = start; i < endExclusive; i++) {
		const line = String(lines[i] || '');
		const trimmed = line.trim();
		if (!trimmed || COMMENT_RE.test(trimmed)) continue;
		if (TYPE_RE.test(trimmed)) {
			markerSeen = true;
			markerLine = i;
			markerIndent = leadingWhitespaceCount(line);
			seenNonSpecialMeta = true;
			if (indentChecksOn && markerIndent <= headingIndent) {
				diagnostics.push(
					new vscode.Diagnostic(
						new vscode.Range(i, 0, i, line.length),
						'Metadata marker must be indented under the heading (at least one indent level).',
						vscode.DiagnosticSeverity.Error
					)
				);
			}
			const inferred = inferTypeFromMarkerLine(trimmed, settings);
			if (inferred) activeTypeId = inferred;
			continue;
		}
		const relationMatch = trimmed.match(RELATION_RE);
		if (relationMatch) {
			const k = String(relationMatch[1] || '').toLowerCase();
			seenNonSpecialMeta = true;
			if (indentChecksOn) {
				const lineIndent = leadingWhitespaceCount(line);
				if (lineIndent <= headingIndent) {
					diagnostics.push(
						new vscode.Diagnostic(
							new vscode.Range(i, 0, i, line.length),
							'Relation/tag lines must be indented under the heading.',
							vscode.DiagnosticSeverity.Error
						)
					);
				}
			}
			if (settings.useTemplates && settings.strictValidation && !settings.ignoreErrors && !settings.allowedRelations.has(k)) {
				diagnostics.push(new vscode.Diagnostic(new vscode.Range(i, 0, i, line.length), `Unknown relation "${k}" for current DRIP settings.`, vscode.DiagnosticSeverity.Error));
			}
			for (const tok of parseTagTokenRangesFromLine(line)) {
				if (knownTagsLower.has(tok.label.toLowerCase())) continue;
				const d = new vscode.Diagnostic(new vscode.Range(i, tok.start, i, tok.end), unknownTagMessage(tok.label, isProject), vscode.DiagnosticSeverity.Error);
				d.code = `${UNKNOWN_TAG_CODE_PREFIX}${tok.label}`;
				diagnostics.push(d);
			}
			continue;
		}
		if (SHORTHAND_RE.test(trimmed)) {
			seenNonSpecialMeta = true;
			if (indentChecksOn) {
				const lineIndent = leadingWhitespaceCount(line);
				if (lineIndent <= headingIndent) {
					diagnostics.push(
						new vscode.Diagnostic(
							new vscode.Range(i, 0, i, line.length),
							'Shorthand tag lines must be indented under the heading.',
							vscode.DiagnosticSeverity.Error
						)
					);
				}
			}
			continue;
		}
		const kv = line.match(KEY_VALUE_RE);
		if (!kv) continue;
		const key = String(kv[1] || '').toLowerCase();
		const value = String(kv[2] || '').trim();
		seenNonSpecialMeta = true;
		if (indentChecksOn) {
			const lineIndent = leadingWhitespaceCount(line);
			const badPlacement = !markerSeen || i <= markerLine || lineIndent <= markerIndent || lineIndent <= headingIndent;
			if (badPlacement) {
				diagnostics.push(
					new vscode.Diagnostic(
						new vscode.Range(i, 0, i, line.length),
						'Metadata key/value fields must be tab-indented under a metadata marker line.',
						vscode.DiagnosticSeverity.Error
					)
				);
				continue;
			}
		}
		if (!enforceTypedIndent) {
			// File-level metadata block is intentionally permissive.
			continue;
		}
		const allowedByTemplate = !enforceTypedIndent ? true : (settings.useTemplates ? !!getTypeRule(settings, activeTypeId, key) : false);
		const allowed = allowedByTemplate || FIXED_ALLOWED_KEYS.has(key) || allowedCustom.has(key) || settings.allowedRelations.has(key);
		if (!allowed && blockTypeId && settings.useTemplates && settings.strictValidation && !settings.ignoreErrors) {
			diagnostics.push(new vscode.Diagnostic(new vscode.Range(i, 0, i, line.length), `Unknown metadata key "${key}". Add it in DRIP metadata settings.`, vscode.DiagnosticSeverity.Error));
			continue;
		}
		if (!allowed) continue;
		if (blockTypeId && settings.useTemplates && settings.strictValidation && !settings.ignoreErrors) {
			if (seenKeys.has(key)) {
				diagnostics.push(new vscode.Diagnostic(new vscode.Range(i, 0, i, line.length), `Duplicate "${key}" in this metadata block.`, vscode.DiagnosticSeverity.Error));
			}
			seenKeys.add(key);
			const rule = getTypeRule(settings, activeTypeId, key);
			if (rule) seenTemplateKeys.add(key);
			if (rule && rule.kind === 'enum') {
				const allowedVals = Array.isArray(rule.values) ? rule.values : [];
				const low = value.toLowerCase();
				if (allowedVals.length && !allowedVals.includes(low)) {
					const at = line.indexOf(value);
					const d = new vscode.Diagnostic(new vscode.Range(i, at, i, at + value.length), `Invalid value "${value}" for "${key}". Allowed: ${allowedVals.join(', ')}`, vscode.DiagnosticSeverity.Error);
					d.code = `${INVALID_METADATA_VALUE_CODE_PREFIX}${key}|${allowedVals.join(',')}|${value}`;
					diagnostics.push(d);
				}
			}
			if (rule && rule.kind === 'datetime' && value) {
				const normalized = normalizeDateTimeValue(value, new Date());
				if (!normalized) {
					const at = line.indexOf(value);
					const d = new vscode.Diagnostic(
						new vscode.Range(i, at, i, at + value.length),
						`Invalid datetime "${value}". Use YYYY-MM-DD HH:mm or relative values like "45 min".`,
						vscode.DiagnosticSeverity.Error
					);
					d.code = `${INVALID_METADATA_VALUE_CODE_PREFIX}${key}|datetime|${value}`;
					diagnostics.push(d);
				} else if (String(value) !== String(normalized)) {
					const at = line.indexOf(value);
					const d = new vscode.Diagnostic(
						new vscode.Range(i, at, i, at + value.length),
						`Normalize datetime "${value}" to "${normalized}".`,
						vscode.DiagnosticSeverity.Warning
					);
					d.code = `${INVALID_METADATA_VALUE_CODE_PREFIX}${key}|datetime|${value}`;
					diagnostics.push(d);
				}
			}
			if (rule && rule.kind === 'duration' && value) {
				const units = resolveDurationUnits(undefined);
				if (!isValidDurationValue(value, units)) {
					const at = line.indexOf(value);
					const d = new vscode.Diagnostic(
						new vscode.Range(i, at, i, at + value.length),
						`Invalid duration "${value}". Use "<number> <unit>" (e.g. "23 minute", "2.5 hour"). Allowed units: ${units.join(', ')}.`,
						vscode.DiagnosticSeverity.Error
					);
					d.code = `${INVALID_METADATA_VALUE_CODE_PREFIX}${key}|duration|${units.join(',')}|${value}`;
					diagnostics.push(d);
				} else {
					const normalized = normalizeDurationValue(value, units);
					if (normalized && String(value) !== normalized) {
						const at = line.indexOf(value);
						const d = new vscode.Diagnostic(
							new vscode.Range(i, at, i, at + value.length),
							`Normalize duration "${value}" to "${normalized}".`,
							vscode.DiagnosticSeverity.Warning
						);
						d.code = `${INVALID_METADATA_VALUE_CODE_PREFIX}${key}|duration-normalize|${normalized}`;
						diagnostics.push(d);
					}
				}
			}
			if (rule && rule.kind === 'issue_parent' && value) {
				const m = String(value)
					.trim()
					.match(/^i-(\d+)$/i);
				const n = m ? parseInt(m[1], 10) : NaN;
				if (!m || !Number.isFinite(n) || n < 1) {
					const at = line.indexOf(value);
					const d = new vscode.Diagnostic(
						new vscode.Range(i, at >= 0 ? at : 0, i, at >= 0 ? at + value.length : line.length),
						`Invalid issue parent "${value}". Use i-N (e.g. i-12) for a parent issue in this project.`,
						vscode.DiagnosticSeverity.Error
					);
					d.code = `${INVALID_METADATA_VALUE_CODE_PREFIX}${key}|issue_parent|${value}`;
					diagnostics.push(d);
				}
			}
		}
	}
	if (blockTypeId && settings.useTemplates && settings.strictValidation && !settings.ignoreErrors) {
		if (enforceTypedIndent && !markerSeen) return;
		const typeDef = settings.typeById.get(String(activeTypeId || '').toLowerCase());
		const attrs = typeDef && typeDef.attributes && typeof typeDef.attributes === 'object' ? typeDef.attributes : {};
		const requiredKeys = Object.keys(attrs).filter(k => {
			const rule = attrs[k] || {};
			return !!rule.required;
		});
		for (const key of requiredKeys) {
			if (seenTemplateKeys.has(key)) continue;
			const lineIdx = Math.max(start, endExclusive - 1);
			const d = new vscode.Diagnostic(
				new vscode.Range(lineIdx, 0, lineIdx, Math.max(1, String(lines[lineIdx] || '').length)),
				`Missing required metadata key "${key}" for type "${activeTypeId || 'metadata'}".`,
				vscode.DiagnosticSeverity.Error
			);
			d.code = `${MISSING_METADATA_KEY_CODE_PREFIX}${key}`;
			diagnostics.push(d);
		}
	}
}

/**
 * Nested issues must not carry `parent:` (implied by indentation); conflicting value = error,
 * same value = redundant warning. Cross-file existence is checked in the RHS (needs the index).
 * @param {string[]} lines
 * @param {object} settings
 * @param {vscode.Diagnostic[]} diagnostics
 */
function pushIssueParentLockDiagnostics(lines, settings, diagnostics) {
	const { findPersistentHeadingZones } = require('../../model/dripTxt/dripTxtPersistentHeadingZones.js');
	const {
		findNearestOutlineAncestorIssueId,
		issueIdFromHeadingTitle
	} = require('../../project/issueParentLink');
	const { normalizeIssueEntityId } = require('../../project/projectStructureRules');
	const text = lines.join('\n');
	for (const z of findPersistentHeadingZones(text, settings)) {
		if (z.typeId !== 'issue') continue;
		let parentRow = -1;
		for (let j = z.headingLine + 1; j < z.lockEndExclusive; j++) {
			if (/^\s*parent\s*:/i.test(String(lines[j] || ''))) {
				parentRow = j;
				break;
			}
		}
		if (parentRow < 0) continue;
		const line = String(lines[parentRow] || '');
		const value = normalizeIssueEntityId(line.replace(/^\s*parent\s*:/i, '').trim());
		if (!value) continue;
		const self = issueIdFromHeadingTitle(z.titleRaw);
		let message = '';
		let severity = vscode.DiagnosticSeverity.Error;
		const locked = findNearestOutlineAncestorIssueId(text, z.headingLine);
		if (locked && value !== locked) {
			message = `Parent is set by indentation (${locked}). Remove this line, or outdent the issue to link a different parent.`;
		} else if (locked) {
			message = `Redundant: parent ${locked} is already implied by indentation. Remove this line.`;
			severity = vscode.DiagnosticSeverity.Warning;
		} else if (self && value === self) {
			message = 'An issue cannot be its own parent.';
		}
		if (!message) continue;
		diagnostics.push(
			new vscode.Diagnostic(
				new vscode.Range(parentRow, 0, parentRow, Math.max(1, line.length)),
				message,
				severity
			)
		);
	}
}

function pushHeadingIdentityDiagnostics(lines, diagnostics, document) {
	void document;
	for (const issue of collectHeadingIdentityDiagnostics(lines.join('\n'), null)) {
		if (issue.kind !== 'duplicate') {
			continue;
		}
		const row = issue.lineIndex;
		const line = String(lines[row] || '');
		const d = new vscode.Diagnostic(
			new vscode.Range(row, 0, row, Math.max(1, line.length)),
			`Duplicate heading identity @h${issue.headingNum} in this file.`,
			vscode.DiagnosticSeverity.Error
		);
		d.code = HEADING_IDENTITY_DUPLICATE_CODE;
		diagnostics.push(d);
	}
}

/**
 * File keys (`filename` / `fileid` / `headings`) live above `---`; every heading — including h0 —
 * lives below it. A heading above `---` is invalid.
 * @param {string[]} lines
 * @param {vscode.Diagnostic[]} diagnostics
 */
function pushFileLevelHeadingDiagnostics(lines, diagnostics) {
	let sepIdx = -1;
	for (let i = 0; i < (lines || []).length; i++) {
		if (String(lines[i] || '').trim() === '---') {
			sepIdx = i;
			break;
		}
	}
	if (sepIdx < 0) {
		return;
	}

	for (let i = 0; i < sepIdx; i++) {
		if (!HEADING_RE.test(String(lines[i] || ''))) continue;
		const line = String(lines[i] || '');
		const d = new vscode.Diagnostic(
			new vscode.Range(i, 0, i, Math.max(1, line.length)),
			'Only file metadata (filename / fileid / headings) belongs above ---. Move this heading below ---.',
			vscode.DiagnosticSeverity.Error
		);
		d.code = EXTRA_FILE_LEVEL_HEADING_CODE;
		diagnostics.push(d);
	}
}

function registerDripnoteMetadataDiagnostics(context) {
	const collection = vscode.languages.createDiagnosticCollection('dripnote-metadata');
	context.subscriptions.push(collection);

	/**
	 * Strict whitespace rule:
	 * - Line must not start with a literal space at column 0.
	 * - After any number of leading tabs, the next character must not be a space.
	 *
	 * @param {string[]} lines
	 * @param {vscode.Diagnostic[]} diagnostics
	 */
	function pushLeadingIndentSpaceDiagnostics(lines, diagnostics) {
		for (let i = 0; i < (lines || []).length; i++) {
			const raw = String(lines[i] || '');
			if (!raw) continue;

			// Case A: starts with one or more spaces.
			const startSpaces = raw.match(/^ +/);
			if (startSpaces) {
				const len = startSpaces[0].length;
				const d = new vscode.Diagnostic(
					new vscode.Range(i, 0, i, len),
					'Line cannot start with spaces. Indentation must use tabs only (or no indent). ' +
						'Tip: run "Toggle Render Whitespace" (Ctrl+Shift+P) to see tabs (→) vs spaces (·). ' +
						'If this keeps happening, click "Spaces: 4" in the status bar and choose "Indent Using Tabs". ' +
						'You can also run "Convert Indentation to Tabs" from the Command Palette.',
					vscode.DiagnosticSeverity.Error
				);
				d.code = `${SPACE_INDENT_CODE}:${i}`;
				diagnostics.push(d);
				continue;
			}

			// Case B: leading tabs followed by one or more spaces.
			const tabsThenSpaces = raw.match(/^(\\t+)( +)/);
			if (tabsThenSpaces) {
				const tabLen = tabsThenSpaces[1].length;
				const spaceLen = tabsThenSpaces[2].length;
				const d = new vscode.Diagnostic(
					new vscode.Range(i, tabLen, i, tabLen + spaceLen),
					'Spaces are not allowed after leading tabs. After tab indentation, the next character must not be a space. ' +
						'Tip: run "Toggle Render Whitespace" (Ctrl+Shift+P) to see tabs (→) vs spaces (·).',
					vscode.DiagnosticSeverity.Error
				);
				d.code = `${SPACE_INDENT_CODE}:${i}`;
				diagnostics.push(d);
				continue;
			}
		}
	}

	function pushHeadingHierarchyIndentDiagnostics(lines, diagnostics) {
		try {
			const cfg = vscode.workspace.getConfiguration('drip');
			if (cfg.get('showHeadingHierarchyIndentErrors', true) === false) {
				return;
			}
			const { topEnd } = splitFileTopRegion(lines);
			const { errors } = collectHeadingSequenceValidated(lines, topEnd);
			for (const e of errors) {
				const row = e.lineIndex;
				const line = String(lines[row] || '');
				const d = new vscode.Diagnostic(
					new vscode.Range(row, 0, row, Math.max(1, line.length)),
					e.message,
					vscode.DiagnosticSeverity.Error
				);
				d.code = HEADING_HIERARCHY_CODE;
				diagnostics.push(d);
			}
			for (const e of collectHeadingVersusAboveLineIndentErrors(lines)) {
				const row = e.lineIndex;
				const line = String(lines[row] || '');
				const d = new vscode.Diagnostic(
					new vscode.Range(row, 0, row, Math.max(1, line.length)),
					e.message,
					vscode.DiagnosticSeverity.Error
				);
				d.code = HEADING_ABOVE_INDENT_CODE;
				diagnostics.push(d);
			}
			for (let i = topEnd; i < lines.length; i++) {
				const raw = String(lines[i] || '');
				const ph = /^([\t ]*)(#\d*)\s+/.exec(raw);
				if (!ph) continue;
				const ind = ph[1] || '';
				if (ind.length > 0 && /[^\t]/.test(ind)) {
					const d = new vscode.Diagnostic(
						new vscode.Range(i, 0, i, Math.max(1, raw.length)),
						'Indent before the heading marker must use tabs, not spaces. ' +
							'Tip: run "Toggle Render Whitespace" (Ctrl+Shift+P) to see tabs (→) vs spaces (·).',
						vscode.DiagnosticSeverity.Error
					);
					d.code = `${HEADING_SPACE_BEFORE_HASH_CODE}:${i}`;
					diagnostics.push(d);
				}
			}
		} catch (err) {
			console.error('[DRIP] heading hierarchy diagnostics failed', err);
		}
	}

	function pathIsUnderProjectFolder(fsPath) {
		const parts = String(fsPath || '')
			.replace(/\\/g, '/')
			.split('/')
			.filter(Boolean);
		for (const part of parts) {
			if (isDripProjectFolderName(part)) return true;
		}
		return false;
	}

	/**
	 * Index notes (`_Name.p.d.txt` / `_Name.f.d.txt`): allow `# .` / `# . Title` and structural `# .p` / `# .f`.
	 * Anywhere under a `.p` tree: no concept headings.
	 */
	function isAllowedFolderIndexH0Title(title) {
		const t = String(title || '').trim();
		if (t === '.' || /^\.\s/.test(t)) return true;
		// Structural folder markers (not document metadata types).
		return /^\.(p|f)(\s|$)/i.test(t);
	}

	function pushProjectFeaturePlacementDiagnostics(document, lines, settings, diagnostics) {
		const fsPath = document.uri.fsPath || '';
		const isIndexNote = isProtectedFolderIndexNotePath(fsPath);
		const underProject = pathIsUnderProjectFolder(fsPath);
		if (!isIndexNote && !underProject) return;

		for (let i = 0; i < lines.length; i++) {
			const hLine = String(lines[i] || '');
			if (!HEADING_RE.test(hLine)) continue;
			const title = hLine.replace(/^\s*#\d*\s+/, '').trim();
			const classification = classifyPersistentHeadingTitle(title, settings);
			if (!classification.persistent) continue;
			const typeId = classification.metadataType ? String(classification.metadataType).toLowerCase() : '';

			if (isIndexNote && !isAllowedFolderIndexH0Title(title)) {
				const d = new vscode.Diagnostic(
					new vscode.Range(i, 0, i, hLine.length),
					'Project/feature index notes only allow `# . Title` or structural `# .p` / `# .f`. Other typed headings are not allowed; attributes are file-level.',
					vscode.DiagnosticSeverity.Error
				);
				d.code = FOLDER_INDEX_TYPED_CODE;
				diagnostics.push(d);
			}

			if (
				underProject &&
				typeId &&
				BUILTIN_DOCUMENT_TYPE_IDS.has(typeId) &&
				!allowedHeadingTypeIdsForPath(fsPath).has(typeId)
			) {
				const allowedList = [...allowedHeadingTypeIdsForPath(fsPath)].join(', ') || 'persistent (untyped)';
				const d = new vscode.Diagnostic(
					new vscode.Range(i, 0, i, hLine.length),
					`"${typeId}" headings are not allowed here — this note allows: ${allowedList}.`,
					vscode.DiagnosticSeverity.Error
				);
				d.code = CONCEPT_IN_PROJECT_CODE;
				diagnostics.push(d);
			}
		}
	}

	async function validateDocument(document) {
		if (!document || document.languageId !== 'dripnote') return;
		const base = path.basename(document.uri.fsPath || document.uri.path || '').toLowerCase();
		if (base === '_index.d.txt') return collection.delete(document.uri);
		const settings = getMetadataSettingsForNotePath(document.uri.fsPath);
		const lines = document.getText().split(/\r?\n/);
		const diagnostics = [];
		pushLeadingIndentSpaceDiagnostics(lines, diagnostics);
		pushHeadingHierarchyIndentDiagnostics(lines, diagnostics);
		pushHeadingIdentityDiagnostics(lines, diagnostics, document);
		pushFileLevelHeadingDiagnostics(lines, diagnostics);
		pushProjectFeaturePlacementDiagnostics(document, lines, getMetadataSettings(), diagnostics);
		pushIssueParentLockDiagnostics(lines, settings, diagnostics);
		const scope = tagScopeForNote(context, document.uri.fsPath);
		const knownTags = await knownTagsLowerForNote(context, document.uri.fsPath);
		const { topEnd } = splitFileTopRegion(lines);
		const topSettings = { ...settings, strictValidation: false };
		collectDiagnosticsForBlock(lines, 0, topEnd, '', topSettings, diagnostics, knownTags, false, -1, scope.isProject);
		for (let i = 0; i < lines.length; i++) {
			const hLine = String(lines[i] || '');
			if (!HEADING_RE.test(hLine)) continue;
			const headingIndent = leadingWhitespaceCount(hLine);
			let start = i + 1;
			let end = start;
			let started = false;
			for (; end < lines.length; end++) {
				const t = String(lines[end] || '').trim();
				if (HEADING_RE.test(t) || t === '---') break;
				if (!started) {
					if (!t || COMMENT_RE.test(t)) break;
					started = true;
				}
				if (!t) break;
				if (TYPE_RE.test(t) || RELATION_RE.test(t) || SHORTHAND_RE.test(t) || KEY_VALUE_RE.test(t) || HEADING_ID_LINE_RE.test(t)) continue;
				break;
			}
			const headingType = inferExplicitHeadingType(hLine, settings);
			const titleMatch = matchHeadingTitleTypePrefix(hLine, settings);
			if (titleMatch.invalid && titleMatch.matchedPrefix) {
				const prefix = titleMatch.matchedPrefix;
				const at = hLine.indexOf(prefix);
				const d = new vscode.Diagnostic(
					new vscode.Range(i, Math.max(0, at), i, Math.max(0, at) + prefix.length),
					`Invalid metadata shortcut "${prefix}" — use a configured shortcut (e.g. .t or .tN).`,
					vscode.DiagnosticSeverity.Error
				);
				d.code = 'drip.invalidTaskShortcut';
				diagnostics.push(d);
			} else if (!titleMatch.typeId) {
				// Persistent `# .token` that is not in drip settings → still allowed (untyped), but flag it.
				// `.p` / `.f` are structural folder markers on index notes, not document metadata shortcuts.
				const titleOnly = hLine.replace(/^\s*#\d*\s+/, '').trim();
				const unk = titleOnly.match(/^(\.([A-Za-z][A-Za-z0-9_-]*)(#|\d+)?)/);
				if (unk && unk[1] !== '.') {
					const prefix = String(unk[1] || '');
					const structural = /^\.(p|f)$/i.test(prefix);
					if (!structural) {
						const at = hLine.indexOf(prefix);
						const d = new vscode.Diagnostic(
							new vscode.Range(i, Math.max(0, at), i, Math.max(0, at) + prefix.length),
							`Unknown metadata shortcut "${prefix}" — not in DRIP settings. Heading stays persistent with no metadata type.`,
							vscode.DiagnosticSeverity.Error
						);
						d.code = 'drip.unknownMetadataShortcut';
						diagnostics.push(d);
					}
				}
			}
			if (!started || end <= start) continue;
			let blockType = headingType;
			let markerCount = 0;
			for (let j = start; j < end; j++) {
				const raw = String(lines[j] || '').trim();
				if (MARKER_NAME_RE.test(raw)) markerCount++;
				const m = inferTypeFromMarkerLine(lines[j], settings);
				if (m) {
					blockType = m;
					if (headingType && m && headingType !== m) {
						diagnostics.push(
							new vscode.Diagnostic(
								new vscode.Range(j, 0, j, String(lines[j] || '').length),
								`Metadata marker type "${m}" does not match heading type "${headingType}". One heading can only have one metadata type.`,
								vscode.DiagnosticSeverity.Error
							)
						);
					}
				}
			}
			if (markerCount > 1) {
				diagnostics.push(
					new vscode.Diagnostic(
						new vscode.Range(start, 0, end - 1, String(lines[end - 1] || '').length),
						'Only one metadata marker is allowed per heading block.',
						vscode.DiagnosticSeverity.Error
					)
				);
			}
			for (let j = start; j < end; j++) {
				const m2 = inferTypeFromMarkerLine(lines[j], settings);
				if (m2) {
					blockType = m2;
					break;
				}
			}
			collectDiagnosticsForBlock(lines, start, end, blockType || '', settings, diagnostics, knownTags, true, headingIndent, scope.isProject);
		}
		collection.set(document.uri, diagnostics);
	}

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(validateDocument),
		vscode.workspace.onDidChangeTextDocument(e => validateDocument(e.document)),
		vscode.workspace.onDidSaveTextDocument(validateDocument),
		vscode.workspace.onDidCloseTextDocument(doc => collection.delete(doc.uri)),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('drip')) {
				for (const doc of vscode.workspace.textDocuments) validateDocument(doc);
			}
		})
	);

	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			{ language: 'dripnote' },
			{
				provideCodeActions(doc, _range, codeContext) {
					const actions = [];
					for (const d of codeContext.diagnostics || []) {
						const code = String(d.code || '');
						if (code.startsWith(SPACE_INDENT_CODE)) {
							const lineNum = parseInt(code.slice(SPACE_INDENT_CODE.length + 1), 10);
							if (!Number.isFinite(lineNum)) continue;
							if (lineNum < 0 || lineNum >= doc.lineCount) continue;
							const leading = doc.getText(d.range);
							if (!leading || !/ +/.test(leading)) continue;

							const remove = new vscode.CodeAction(
								'Remove spaces (make content start immediately)',
								vscode.CodeActionKind.QuickFix
							);
							remove.edit = new vscode.WorkspaceEdit();
							remove.edit.replace(doc.uri, d.range, '');
							remove.diagnostics = [d];
							actions.push(remove);

							const toTabsText = String(leading).replace(/ {1,4}/g, '\t');
							const toTabs = new vscode.CodeAction(
								'Convert spaces to tabs (keep indent)',
								vscode.CodeActionKind.QuickFix
							);
							toTabs.edit = new vscode.WorkspaceEdit();
							toTabs.edit.replace(doc.uri, d.range, toTabsText);
							toTabs.diagnostics = [d];
							actions.push(toTabs);
							continue;
						}
						if (code.startsWith(HEADING_SPACE_BEFORE_HASH_CODE)) {
							const lineNum = parseInt(code.slice(HEADING_SPACE_BEFORE_HASH_CODE.length + 1), 10);
							if (!Number.isFinite(lineNum)) continue;
							if (lineNum < 0 || lineNum >= doc.lineCount) continue;
							const lineText = doc.lineAt(lineNum).text;
							const hashAt = lineText.indexOf('#');
							if (hashAt <= 0) continue;
							const indent = lineText.slice(0, hashAt);
							if (!/[^\S\t]/.test(indent)) continue;

							let fixed = '';
							let run = 0;
							for (const ch of indent) {
								if (ch === '\t') {
									if (run > 0) {
										fixed += '\t'.repeat(Math.ceil(run / 4));
										run = 0;
									}
									fixed += '\t';
								} else {
									if (/\s/.test(ch)) run += 1;
									else {
										run = -1;
										break;
									}
								}
							}
							if (run < 0) continue;
							if (run > 0) fixed += '\t'.repeat(Math.ceil(run / 4));

							const a = new vscode.CodeAction(
								'Convert heading indent spaces to tabs',
								vscode.CodeActionKind.QuickFix
							);
							a.edit = new vscode.WorkspaceEdit();
							a.edit.replace(doc.uri, new vscode.Range(lineNum, 0, lineNum, hashAt), fixed);
							a.diagnostics = [d];
							actions.push(a);
							continue;
						}
						if (code.startsWith(UNKNOWN_TAG_CODE_PREFIX)) {
							const tagLabel = code.slice(UNKNOWN_TAG_CODE_PREFIX.length).trim();
							const scope = tagScopeForNote(context, doc.uri.fsPath);
							const title = scope.isProject
								? `Create tag "${tagLabel}" in project graph`
								: `Create tag "${tagLabel}" in ${INDIVIDUAL_TAGS_GRAPH_NAME}`;
							const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
							a.command = { title: 'Create tag', command: CREATE_TAG_COMMAND, arguments: [tagLabel, doc.uri.fsPath] };
							a.diagnostics = [d];
							actions.push(a);
							continue;
						}
						if (code.startsWith(INVALID_METADATA_VALUE_CODE_PREFIX)) {
							const payload = code.slice(INVALID_METADATA_VALUE_CODE_PREFIX.length);
							const parts = payload.split('|');
							const key = parts[0] || '';
							const mode = parts[1] || '';
							if (mode === 'datetime' || mode === 'datetime-date') {
								const a = new vscode.CodeAction(`Normalize "${key}" datetime`, vscode.CodeActionKind.QuickFix);
								a.command = { title: 'Normalize datetime', command: NORMALIZE_DATETIME_COMMAND, arguments: [doc, d.range, mode] };
								a.diagnostics = [d];
								actions.push(a);
							} else if (mode === 'duration-normalize') {
								const normalized = parts.slice(2).join('|');
								if (normalized) {
									const a = new vscode.CodeAction(`Normalize "${key}" duration`, vscode.CodeActionKind.QuickFix);
									a.edit = new vscode.WorkspaceEdit();
									a.edit.replace(doc.uri, d.range, normalized);
									a.diagnostics = [d];
									actions.push(a);
								}
							} else if (mode === 'duration') {
								const units = String(parts[2] || '')
									.split(',')
									.map(x => x.trim())
									.filter(Boolean);
								const current = String(doc.getText(d.range) || '').trim();
								const amountMatch = current.match(/^[+-]?(?:\d+\.?\d*|\.\d+)/);
								const amount = amountMatch ? amountMatch[0] : '1';
								for (const unit of units) {
									const v = `${amount} ${unit}`;
									const a = new vscode.CodeAction(`Set "${key}" = "${v}"`, vscode.CodeActionKind.QuickFix);
									a.edit = new vscode.WorkspaceEdit();
									a.edit.replace(doc.uri, d.range, v);
									a.diagnostics = [d];
									actions.push(a);
								}
							} else {
								for (const v of String(mode || '').split(',').filter(Boolean)) {
									const a = new vscode.CodeAction(`Set "${key}" = "${v}"`, vscode.CodeActionKind.QuickFix);
									a.edit = new vscode.WorkspaceEdit();
									a.edit.replace(doc.uri, d.range, v);
									a.diagnostics = [d];
									actions.push(a);
								}
							}
						}
						if (code.startsWith(MISSING_METADATA_KEY_CODE_PREFIX)) {
							const key = code.slice(MISSING_METADATA_KEY_CODE_PREFIX.length).trim();
							if (!key) continue;
							const line = Math.max(0, d.range.end.line);
							const a = new vscode.CodeAction(`Insert missing key "${key}"`, vscode.CodeActionKind.QuickFix);
							a.edit = new vscode.WorkspaceEdit();
							a.edit.insert(doc.uri, new vscode.Position(line + 1, 0), `${key}: \n`);
							a.diagnostics = [d];
							actions.push(a);
						}
					}
					return actions;
				}
			},
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(NORMALIZE_DATETIME_COMMAND, async (doc, range) => {
			const normalized = normalizeDateTimeValue(String(doc.getText(range) || ''), new Date());
			if (!normalized) return;
			const edit = new vscode.WorkspaceEdit();
			edit.replace(doc.uri, range, normalized);
			await vscode.workspace.applyEdit(edit);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(CREATE_TAG_COMMAND, async (tagLabel, noteFsPath) => {
			const label = String(tagLabel || '').trim();
			const fsPath =
				String(noteFsPath || '').trim() ||
				(vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri.fsPath : '');
			if (!label || !fsPath) return;
			// Creates the tag in the note's own scope: the per-project graph for project
			// notes (creating that graph if missing), else the KB "individual tags" graph.
			await createTagForNote(context, fsPath, label);
			const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === fsPath && d.languageId === 'dripnote');
			if (doc) await validateDocument(doc);
		})
	);

	for (const doc of vscode.workspace.textDocuments) validateDocument(doc);
}

module.exports = { registerDripnoteMetadataDiagnostics };

