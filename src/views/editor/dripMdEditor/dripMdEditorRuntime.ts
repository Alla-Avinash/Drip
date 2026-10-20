// Browser client for the DRIP markdown editor webview (`.d.md` notes).
// Bundled by esbuild (scripts/build-webview.mjs) into dist/dripMdEditorRuntime.js.
//
// This is a WYSIWYG markdown editor: the file stays plain markdown on disk, but the
// editor hides the markdown syntax (the `#`, `**`, `[`…`](url)`, `- [ ]` markers) using
// CodeMirror 6 decorations and renders the text in place — the same technique Obsidian's
// Live Preview uses.

import { EditorState, EditorSelection, StateField, StateEffect, Text, RangeSet, RangeSetBuilder } from '@codemirror/state';
import {
	EditorView,
	ViewPlugin,
	ViewUpdate,
	keymap,
	highlightActiveLine,
	drawSelection,
	dropCursor,
	Decoration,
	DecorationSet,
	WidgetType,
	gutter,
	GutterMarker
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentMore, indentLess } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
	syntaxTree,
	codeFolding,
	foldKeymap,
	foldState,
	foldEffect,
	unfoldEffect,
	foldable,
	indentUnit
} from '@codemirror/language';

declare function acquireVsCodeApi(): {
	postMessage(message: unknown): void;
};

const vscode = acquireVsCodeApi();
const root = document.getElementById('drip-md-editor-root') as HTMLElement;

/** Read the document text the host embedded into the page on load. */
function readSeedText(): string {
	const el = document.getElementById('drip-md-editor-initial');
	if (!el) return '';
	try {
		const parsed = JSON.parse(el.textContent || '""');
		return typeof parsed === 'string' ? parsed : '';
	} catch {
		return '';
	}
}

/** Read the serialized metadata schema the host embedded into the page on load. */
function readSeedSchema(): MdSchema {
	const el = document.getElementById('drip-md-editor-schema');
	if (!el) return { types: [], allowedRelations: [] };
	try {
		const parsed = JSON.parse(el.textContent || '{}');
		return {
			types: Array.isArray(parsed.types) ? parsed.types : [],
			allowedRelations: Array.isArray(parsed.allowedRelations) ? parsed.allowedRelations : []
		};
	} catch {
		return { types: [], allowedRelations: [] };
	}
}

// ---------------------------------------------------------------------------
// Metadata chips — the schema-driven `.d.md` metadata picker.
//
// The host sends the serialized metadata schema (types + their attributes +
// allowed relations, straight from DRIP settings). A heading's hidden comment
// (`<!-- drip h12 | concept | status: in-progress | … -->`) is replaced by a row
// of read-only chips; clicking a chip opens a dropdown to pick a value, which
// rewrites the comment. Nothing here touches the database — it is a pure editor
// edit, exactly like toggling a checkbox.
// ---------------------------------------------------------------------------

interface MdAttr {
	key: string;
	type: string;
	values: string[];
	default: string;
	required: boolean;
}

interface MdType {
	id: string;
	marker: string;
	shortcuts: string[];
	attributes: MdAttr[];
}

interface MdSchema {
	types: MdType[];
	allowedRelations: string[];
}

interface MdField {
	key: string;
	value: string;
}

interface ParsedComment {
	headingNum: number;
	typeId: string;
	fields: MdField[];
}

/** The metadata schema, populated from the host (seed element or a later message). */
let schema: MdSchema = { types: [], allowedRelations: [] };

/** `<!-- drip h12 | … -->` — the `h` token distinguishes it from the file header. */
const HEADING_COMMENT_RE = /^<!--\s*drip\s+h(\d+)\b\s*(.*?)\s*-->$/i;

/** `<!-- drip-file filename: "…" | fileid: @fN | headings: N -->` — the note's identity block. */
const FILE_HEADER_COMMENT_RE = /^<!--\s*drip-file\b\s*(.*?)\s*-->$/i;

function isHeadingLine(line: string): boolean {
	return /^\s*#{1,6}\s+/.test(line);
}

function isHeadingCommentLine(line: string): boolean {
	return HEADING_COMMENT_RE.test(line.trim());
}

function isFileHeaderCommentLine(line: string): boolean {
	return FILE_HEADER_COMMENT_RE.test(line.trim());
}

/** Parse a `<!-- drip-file filename: "…" | fileid: @fN | headings: N -->` comment into its
 * fields. Mirrors the host-side parser so the banner shows exactly what the file declares. */
function parseFileHeaderComment(line: string): { filename: string; fileid: string; headings: number | null } {
	const m = FILE_HEADER_COMMENT_RE.exec(line.trim());
	let filename = '';
	let fileid = '';
	let headings: number | null = null;
	if (m) {
		for (const token of m[1].split('|').map(t => t.trim()).filter(Boolean)) {
			const colonAt = token.indexOf(':');
			if (colonAt < 0) continue;
			const key = token.slice(0, colonAt).trim().toLowerCase();
			const value = token.slice(colonAt + 1).trim();
			if (key === 'filename') filename = value.replace(/^"|"$/g, '').trim();
			else if (key === 'fileid') fileid = value;
			else if (key === 'headings') {
				const n = parseInt(value, 10);
				if (Number.isFinite(n) && n >= 0) headings = n;
			}
		}
	}
	return { filename, fileid, headings };
}

/** Parse a heading comment line into its heading number, type id, and ordered fields.
 * Mirrors the host-side parser so both sides agree on the format. */
function parseHeadingComment(line: string): ParsedComment | null {
	const m = HEADING_COMMENT_RE.exec(line.trim());
	if (!m) return null;
	const headingNum = parseInt(m[1], 10);
	if (!Number.isFinite(headingNum) || headingNum < 0) return null;

	let typeId = '';
	const fields: MdField[] = [];
	for (const token of m[2].split('|').map(t => t.trim()).filter(Boolean)) {
		const colonAt = token.indexOf(':');
		if (colonAt < 0) {
			if (!typeId && /^[a-z][a-z0-9_-]*$/i.test(token)) typeId = token.toLowerCase();
			continue;
		}
		const key = token.slice(0, colonAt).trim().toLowerCase();
		const value = token.slice(colonAt + 1).trim();
		if (!key) continue;
		fields.push({ key, value });
	}
	return { headingNum, typeId, fields };
}

/** Rebuild a clean heading comment line from its parts. */
function formatHeadingComment(headingNum: number, typeId: string, fields: MdField[]): string {
	const parts = [`drip h${Math.max(0, Math.floor(headingNum) || 0)}`];
	if (typeId) parts.push(typeId);
	for (const f of fields) parts.push(`${f.key}: ${f.value}`);
	return `<!-- ${parts.join(' | ')} -->`;
}

/** The untyped-but-indexed heading type (the `persistent` marker in the comment). */
const PERSISTENT_TYPE_ID = 'persistent';

/** The selectable heading types: the untyped `persistent` marker plus every type in the
 * schema (concept / task / issue — the file-level project/folder types never appear here). */
function availableTypes(): string[] {
	const out: string[] = [PERSISTENT_TYPE_ID];
	for (const t of schema.types) {
		out.push(t.id);
	}
	return out;
}

/**
 * Build the "Heading type" popover body. Each row has a colored dot and the type name; the
 * current type is marked with a tick. Clicking the already-selected type deselects it
 * (removes the type) via `onPick('')`; clicking any other type selects it.
 */
function buildTypePicker(
	pop: HTMLElement,
	currentType: string,
	onPick: (typeId: string) => void
) {
	const header = document.createElement('div');
	header.className = 'md-popover-title';
	header.textContent = 'Heading type';
	pop.appendChild(header);

	for (const typeId of availableTypes()) {
		const isSelected = typeId === currentType;
		const it = document.createElement('div');
		it.className = 'md-popover-item md-type-option' + (isSelected ? ' is-selected' : '');
		const dot = document.createElement('span');
		dot.className = 'md-type-dot';
		dot.textContent = '●';
		it.appendChild(dot);
		it.appendChild(document.createTextNode(typeId));
		const tick = document.createElement('span');
		tick.className = 'md-popover-tick';
		tick.textContent = isSelected ? '✓' : '';
		it.appendChild(tick);
		it.addEventListener('mousedown', e => e.preventDefault());
		it.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			closePopover();
			onPick(isSelected ? '' : typeId);
		});
		pop.appendChild(it);
	}
}

/** The resolved type's attributes, or [] when untyped/unknown. */
function attributesForType(typeId: string): MdAttr[] {
	const type = schema.types.find(t => t.id === typeId);
	return type ? type.attributes : [];
}

/** A chip popover is a single floating menu, reused across all chips. */
let activePopover: HTMLElement | null = null;
/** Tags already present in the note's tags graph, refreshed from the host on demand. */
let cachedTags: string[] = [];
/** The search text currently typed in the tags dropdown. */
let tagsSearchQuery = '';
/** Semantic (embedding) matches for the current search query, from the host. */
let tagsSemantic: string[] = [];
/** Pending debounce timer for the semantic tag search. */
let tagsSearchTimer: number | null = null;
/** Re-render callback for the open tags list (cleared when the popover closes). */
let tagsListRerender: (() => void) | null = null;
function closePopover() {
	if (activePopover) {
		activePopover.remove();
		activePopover = null;
	}
	tagsListRerender = null;
	tagsSearchQuery = '';
	tagsSemantic = [];
	if (tagsSearchTimer !== null) {
		clearTimeout(tagsSearchTimer);
		tagsSearchTimer = null;
	}
}
function openPopover(anchor: HTMLElement, build: (pop: HTMLElement) => void) {
	closePopover();
	const pop = document.createElement('div');
	pop.className = 'md-chip-popover';
	document.body.appendChild(pop);
	const r = anchor.getBoundingClientRect();
	pop.style.left = `${r.left}px`;
	pop.style.top = `${r.bottom + 4}px`;
	build(pop);
	activePopover = pop;
}

/** A popover menu item (or a "Remove" item when `danger`). */
function popoverItem(pop: HTMLElement, label: string, onPick: () => void, danger = false) {
	const it = document.createElement('div');
	it.className = 'md-popover-item' + (danger ? ' is-danger' : '');
	it.textContent = label;
	it.addEventListener('mousedown', e => e.preventDefault());
	it.addEventListener('click', e => {
		e.preventDefault();
		e.stopPropagation();
		closePopover();
		onPick();
	});
	pop.appendChild(it);
	return it;
}

/** A popover menu item with a right-aligned tick for the currently selected value. */
function popoverValueItem(pop: HTMLElement, label: string, isSelected: boolean, onPick: () => void) {
	const it = document.createElement('div');
	it.className = 'md-popover-item md-popover-value' + (isSelected ? ' is-selected' : '');
	const name = document.createElement('span');
	name.textContent = label;
	it.appendChild(name);
	const tick = document.createElement('span');
	tick.className = 'md-popover-tick';
	tick.textContent = isSelected ? '✓' : '';
	it.appendChild(tick);
	it.addEventListener('mousedown', e => e.preventDefault());
	it.addEventListener('click', e => {
		e.preventDefault();
		e.stopPropagation();
		closePopover();
		onPick();
	});
	pop.appendChild(it);
	return it;
}

function popoverInput(pop: HTMLElement, value: string, onCommit: (v: string) => void) {
	const input = document.createElement('input');
	input.className = 'md-popover-input';
	input.value = value;
	input.addEventListener('mousedown', e => e.stopPropagation());
	pop.appendChild(input);
	const commit = () => {
		closePopover();
		onCommit(input.value.trim());
	};
	input.addEventListener('keydown', e => {
		if (e.key === 'Enter') {
			e.preventDefault();
			commit();
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			closePopover();
		}
	});
	return { input, commit };
}

/** Format a Date as `YYYY-MM-DD HH:mm` (matches the `.d.txt` normalized datetime format). */
function toMinuteString(d: Date): string {
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	const hh = String(d.getHours()).padStart(2, '0');
	const mi = String(d.getMinutes()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/**
 * Normalize a datetime input the same way `.d.txt` does: accepts an absolute
 * `YYYY-MM-DD HH:mm`, or a relative phrase like `2 days` / `45 min`, and returns the
 * canonical `YYYY-MM-DD HH:mm`. Returns '' when the input doesn't parse (so the caller
 * treats it as "no value").
 */
function normalizeDateTimeInput(raw: string): string {
	const s = String(raw || '').trim();
	if (!s) return '';
	const absolute = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
	if (absolute) {
		const d = new Date(
			Number(absolute[1]),
			Number(absolute[2]) - 1,
			Number(absolute[3]),
			Number(absolute[4]),
			Number(absolute[5]),
			0,
			0
		);
		if (!Number.isNaN(d.getTime())) return toMinuteString(d);
	}
	const rel = s.match(/^(\d+)\s*(min|mins|minute|minutes|hr|hrs|hour|hours|day|days|month|months)$/i);
	if (rel) {
		const count = Number(rel[1]);
		if (!Number.isFinite(count) || count <= 0) return '';
		const unit = String(rel[2] || '').toLowerCase();
		const d = new Date();
		if (unit.startsWith('min')) d.setMinutes(d.getMinutes() + count);
		else if (unit.startsWith('h')) d.setHours(d.getHours() + count);
		else if (unit.startsWith('day')) d.setDate(d.getDate() + count);
		else if (unit.startsWith('month')) d.setMonth(d.getMonth() + count);
		d.setSeconds(0, 0);
		return toMinuteString(d);
	}
	return '';
}

/** Parse a `[a, b, c]` list field into its trimmed items. */
function parseListField(value: string): string[] {
	return String(value || '')
		.replace(/^\[|\]$/g, '')
		.split(',')
		.map(s => s.trim())
		.filter(Boolean);
}

/** Order tags by how well they match a query: exact, then starts-with, then contains. */
function rankTagsByQuery(tags: string[], query: string): string[] {
	const q = String(query || '').trim().toLowerCase();
	if (!q) return tags.slice();
	const scored: { t: string; score: number }[] = [];
	for (const t of tags) {
		const low = t.toLowerCase();
		if (low === q) scored.push({ t, score: 0 });
		else if (low.startsWith(q)) scored.push({ t, score: 1 });
		else if (low.includes(q)) scored.push({ t, score: 2 });
	}
	scored.sort((a, b) => a.score - b.score || a.t.localeCompare(b.t));
	return scored.map(s => s.t);
}

/** Debounced request to the host for semantic tag matches on the current query. */
function requestTagSearch() {
	if (tagsSearchTimer !== null) clearTimeout(tagsSearchTimer);
	const q = tagsSearchQuery.trim();
	if (!q) {
		tagsSemantic = [];
		return;
	}
	tagsSearchTimer = window.setTimeout(() => {
		vscode.postMessage({ type: 'tags-search', query: q });
	}, 250);
}

/** Hide a range by replacing it with nothing. */
function hide(from: number, to: number) {
	return Decoration.replace({}).range(from, to);
}

/** Style a range with a CSS class. Returns null (skipped) when the range is empty, because
 * CodeMirror rejects empty mark decorations. */
function style(cls: string, from: number, to: number) {
	return from < to ? Decoration.mark({ class: cls }).range(from, to) : null;
}

/** Reveal a marker (e.g. `#`, `**`, `[]()`) instead of hiding it, dimmed — Obsidian's
 * "show the underline markdown on the line you're editing" behavior. */
function dim(from: number, to: number) {
	return from < to ? Decoration.mark({ class: 'md-revealed-mark' }).range(from, to) : null;
}

/** A task-list checkbox. Clicking it toggles `[ ]` <-> `[x]` in the source. */
class CheckboxWidget extends WidgetType {
	constructor(readonly checked: boolean, readonly from: number, readonly to: number) {
		super();
	}

	eq(other: CheckboxWidget) {
		return other.checked === this.checked;
	}

	toDOM() {
		const span = document.createElement('span');
		span.className = 'md-checkbox' + (this.checked ? ' is-checked' : '');
		span.textContent = this.checked ? '☑' : '☐';
		span.setAttribute('contenteditable', 'false');
		span.addEventListener('mousedown', e => e.preventDefault());
		span.addEventListener('click', e => {
			e.preventDefault();
			if (!view) return;
			view.dispatch({
				changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' }
			});
		});
		return span;
	}

	ignoreEvent() {
		return false;
	}
}

/** A bullet for a list item (replaces the `-` / `*` marker). */
class BulletWidget extends WidgetType {
	toDOM() {
		const span = document.createElement('span');
		span.className = 'md-bullet';
		span.textContent = '•';
		return span;
	}

	eq() {
		return true;
	}
}

/** A single table cell: its display text plus the source offsets it maps back to. */
interface Cell {
	text: string;
	from: number;
	to: number;
}

/** Serialize header + body cells back into a valid GFM markdown table string. */
function buildTableMarkdown(header: string[], rows: string[][]): string {
	const line = (cells: string[]) => '| ' + cells.map(c => c.trim()).join(' | ') + ' |';
	const align = '| ' + Array(header.length).fill('---').join(' | ') + ' |';
	return [line(header), align, ...rows.map(line)].join('\n');
}

/** Extract one cell's trimmed text plus its full source span (surrounding spaces included),
 * so committing an edit rewrites the whole `cell` region and keeps `| cell |` formatting. */
function makeCell(line: string, lineOffset: number, from: number, to: number): Cell {
	let f = from;
	let t = to;
	while (t > f && line[t - 1] === ' ') t--;
	while (f < t && line[f] === ' ') f++;
	return { text: line.slice(f, t), from: lineOffset + from, to: lineOffset + to };
}

/** Parse one table row line (between the outer pipes) into cells, including empty cells —
 * the markdown parser omits empty TableCell nodes, so we split the raw line ourselves. */
function parseRow(line: string, lineOffset: number): Cell[] {
	const cells: Cell[] = [];
	let start = -1;
	for (let i = 0; i < line.length; i++) {
		if (line[i] !== '|') continue;
		if (start >= 0) cells.push(makeCell(line, lineOffset, start + 1, i));
		start = i;
	}
	if (start >= 0) {
		// Only close an unterminated last cell if there is real content after the last pipe.
		let hasTrailing = false;
		for (let j = start + 1; j < line.length; j++) {
			if (line[j] !== ' ') {
				hasTrailing = true;
				break;
			}
		}
		if (hasTrailing) cells.push(makeCell(line, lineOffset, start + 1, line.length));
	}
	return cells;
}

/** Parse a whole table's source into header + body cells with exact source offsets. */
function parseTable(doc: Text, from: number, to: number): { header: Cell[]; rows: Cell[][] } {
	const raw = doc.sliceString(from, to);
	const lines = raw.split('\n');
	const header = parseRow(lines[0] || '', from);
	const rows: Cell[][] = [];
	let offset = from;
	for (let i = 0; i < lines.length; i++) {
		if (i >= 2) rows.push(parseRow(lines[i], offset));
		offset += lines[i].length + 1;
	}
	return { header, rows };
}

/** Remove any row/column drop-indicator classes from the table. */
function clearDropIndicators(table: HTMLElement) {
	for (const el of table.querySelectorAll('.md-drop-before, .md-drop-after, .md-drop-col-left, .md-drop-col-right')) {
		el.classList.remove('md-drop-before', 'md-drop-after', 'md-drop-col-left', 'md-drop-col-right');
	}
}

/** The currently open table context menu (singleton), so only one shows at a time. */
let activeMenu: HTMLElement | null = null;
function closeMenu() {
	if (activeMenu) {
		activeMenu.remove();
		activeMenu = null;
	}
}
/** After a Tab that triggers a cell commit (which rebuilds the table), this holds the
 * row/col to focus once the rebuilt cells exist. */
let pendingCellFocus: { row: number; col: number } | null = null;
/** The row/column currently being dragged to reorder (survives the widget rebuild). */
let dragPayload: { kind: 'row' | 'col'; index: number } | null = null;
/** True while a table edit is dispatching a view update. Removing the focused cell's DOM
 * element (which the rebuild does) fires a `blur` on that cell synchronously; without this
 * guard that blur would commit again mid-update and throw
 * "Calls to EditorView.update are not allowed while an update is in progress". */
let committing = false;
/** Resolved webview file URIs for local/relative image srcs, keyed by the raw src string. */
const imageUriCache = new Map<string, string>();
/** Placeholder elements waiting for a local image src to resolve (keyed by raw src). */
const imageWaiters = new Map<string, HTMLElement[]>();
// Close the menu when clicking outside it or pressing Escape.
document.addEventListener('mousedown', e => {
	const target = e.target instanceof Node ? e.target : null;
	if (activeMenu && target && !activeMenu.contains(target)) closeMenu();
	// Chip/type popovers also dismiss as soon as the user clicks back in the document.
	if (activePopover && target && !activePopover.contains(target)) closePopover();
});
document.addEventListener('keydown', e => {
	if (e.key === 'Escape') closeMenu();
	if (e.key === 'Escape') closePopover();
});

/** A rendered markdown table. Cells are directly editable: clicking a cell places the
 * caret in it and typing updates it live; the cell commits back to the markdown source when
 * focus leaves. "+" buttons on the last row / last column add rows and columns. Right-clicking
 * a cell opens a Row/Column context menu with add/move/duplicate/delete operations. */
class TableWidget extends WidgetType {
	constructor(
		readonly from: number,
		readonly to: number,
		readonly header: Cell[],
		readonly rows: Cell[][]
	) {
		super();
	}

	eq(other: TableWidget) {
		// Reuse the rendered table when its source range and cell text are unchanged, so a
		// mere cursor move (or an edit elsewhere in the document) does not tear down and
		// rebuild the table DOM. That rebuild was firing synchronously during clicks and
		// could throw the caret to the wrong place, and it caused needless re-render churn.
		// Comparing `from`/`to` keeps the offsets correct: any shift in the table's source
		// range forces a rebuild so cell edits commit to the right positions.
		if (other.from !== this.from || other.to !== this.to) return false;
		if (other.header.length !== this.header.length || other.rows.length !== this.rows.length) return false;
		for (let i = 0; i < this.header.length; i++) {
			if (other.header[i].text !== this.header[i].text) return false;
		}
		for (let r = 0; r < this.rows.length; r++) {
			if (other.rows[r].length !== this.rows[r].length) return false;
			for (let c = 0; c < this.rows[r].length; c++) {
				if (other.rows[r][c].text !== this.rows[r][c].text) return false;
			}
		}
		return true;
	}

	/** Write a cell's edited text back into its source range. Returns true if the source
	 * actually changed (and therefore the table will rebuild). */
	private commitCell(cell: Cell, newText: string): boolean {
		if (!view || committing) return false;
		const text = newText.replace(/\s*\n+\s*/g, ' ').trim();
		if (text === cell.text) return false;
		committing = true;
		try {
			view.dispatch({ changes: { from: cell.from, to: cell.to, insert: ' ' + text + ' ' } });
		} finally {
			committing = false;
		}
		return true;
	}

	/** Serialize the current header + rows and replace the whole table source. */
	private applyTable(header: string[], rows: string[][]) {
		if (!view || committing) return;
		const raw = buildTableMarkdown(header, rows);
		committing = true;
		try {
			view.dispatch({ changes: { from: this.from, to: this.to, insert: raw } });
		} finally {
			committing = false;
		}
	}

	/** Apply a row operation to the body row at `r` (header counts as row 0). */
	private rowOp(op: string, r: number) {
		const header = this.header.map(c => c.text);
		const rows = this.rows.map(row => row.map(c => c.text));
		const ri = Math.max(0, r);
		if (op === 'row-add-above') rows.splice(ri, 0, Array(header.length).fill(''));
		else if (op === 'row-add-below') rows.splice(ri + 1, 0, Array(header.length).fill(''));
		else if (op === 'row-move-up') {
			if (ri > 0) {
				const t = rows[ri];
				rows[ri] = rows[ri - 1];
				rows[ri - 1] = t;
			}
		} else if (op === 'row-duplicate') rows.splice(ri + 1, 0, [...rows[ri]]);
		else if (op === 'row-delete') {
			if (rows.length > 1) rows.splice(ri, 1);
		}
		this.applyTable(header, rows);
	}

	/** Apply a column operation to the column at `c`. */
	private colOp(op: string, c: number) {
		const header = this.header.map(x => x.text);
		const rows = this.rows.map(row => row.map(x => x.text));
		if (op === 'col-add-left') {
			header.splice(c, 0, '');
			for (const r of rows) r.splice(c, 0, '');
		} else if (op === 'col-add-right') {
			header.splice(c + 1, 0, '');
			for (const r of rows) r.splice(c + 1, 0, '');
		} else if (op === 'col-move-left') {
			if (c > 0) {
				[header[c], header[c - 1]] = [header[c - 1], header[c]];
				for (const r of rows) [r[c], r[c - 1]] = [r[c - 1], r[c]];
			}
		} else if (op === 'col-duplicate') {
			header.splice(c + 1, 0, header[c]);
			for (const r of rows) r.splice(c + 1, 0, r[c]);
		} else if (op === 'col-delete') {
			if (header.length > 1) {
				header.splice(c, 1);
				for (const r of rows) r.splice(c, 1);
			}
		}
		this.applyTable(header, rows);
	}

	/** Drag-reorder: move the body row at `from` to before original index `target`
	 * (target may equal rows.length to move it to the end). */
	private moveRow(from: number, target: number) {
		const header = this.header.map(c => c.text);
		const rows = this.rows.map(row => row.map(c => c.text));
		if (from < 0 || from >= rows.length || target < 0 || target > rows.length) return;
		const insertAt = target > from ? target - 1 : target;
		const [row] = rows.splice(from, 1);
		rows.splice(insertAt, 0, row);
		this.applyTable(header, rows);
	}

	/** Drag-reorder: move the column at `from` to before original index `target`
	 * (target may equal header.length to move it to the end). */
	private moveColumn(from: number, target: number) {
		const header = this.header.map(c => c.text);
		const rows = this.rows.map(row => row.map(c => c.text));
		if (from < 0 || from >= header.length || target < 0 || target > header.length) return;
		const insertAt = target > from ? target - 1 : target;
		const [h] = header.splice(from, 1);
		header.splice(insertAt, 0, h);
		for (const r of rows) {
			const [cell] = r.splice(from, 1);
			r.splice(insertAt, 0, cell);
		}
		this.applyTable(header, rows);
	}

	/** Show the Row/Column context menu at the given viewport coordinates. */
	private showContextMenu(x: number, y: number, row: number, col: number) {
		closeMenu();
		const menu = document.createElement('div');
		menu.className = 'md-context-menu';
		menu.style.left = x + 'px';
		menu.style.top = y + 'px';

		const buildSubmenu = (label: string, items: [string, string][], kind: 'row' | 'col') => {
			const parent = document.createElement('div');
			parent.className = 'md-menu-item md-menu-parent';
			parent.appendChild(document.createTextNode(label));
			const arrow = document.createElement('span');
			arrow.className = 'md-menu-arrow';
			arrow.textContent = '▸';
			parent.appendChild(arrow);

			const sub = document.createElement('div');
			sub.className = 'md-submenu';
			for (const [text, op] of items) {
				const it = document.createElement('div');
				it.className = 'md-menu-item';
				it.textContent = text;
				it.addEventListener('click', e => {
					e.preventDefault();
					e.stopPropagation();
					closeMenu();
					if (kind === 'row') this.rowOp(op, row);
					else this.colOp(op, col);
				});
				sub.appendChild(it);
			}
			parent.appendChild(sub);
			return parent;
		};

		menu.appendChild(buildSubmenu('Row', [
			['Add row above', 'row-add-above'],
			['Add row below', 'row-add-below'],
			['Move row up', 'row-move-up'],
			['Duplicate row', 'row-duplicate'],
			['Delete row', 'row-delete']
		], 'row'));
		menu.appendChild(buildSubmenu('Column', [
			['Add column left', 'col-add-left'],
			['Add column right', 'col-add-right'],
			['Move column left', 'col-move-left'],
			['Duplicate column', 'col-duplicate'],
			['Delete column', 'col-delete']
		], 'col'));

		document.body.appendChild(menu);
		activeMenu = menu;
	}

	toDOM() {
		const wrap = document.createElement('div');
		wrap.className = 'md-table-wrap';
		// Events inside the table are handled by the cells/buttons themselves: the widget's
		// ignoreEvent() returns true so CodeMirror leaves them alone, letting a cell be
		// focused and edited with a single click.

		const scroll = document.createElement('div');
		scroll.className = 'md-table-scroll';

		// Inner box shrink-wraps the table, so the "+" buttons (absolutely positioned on
		// its edges) sit exactly at the table's border, outside the table but inside the
		// scroll container's padding where they stay visible and clickable.
		const inner = document.createElement('div');
		inner.className = 'md-table-inner';

		const table = document.createElement('table');
		table.className = 'md-table';

		// All cells in reading order, so Tab/Shift+Tab can move between them.
		const cellEls: HTMLElement[] = [];

		const makeCell = (tag: 'th' | 'td', cell: Cell, row: number, col: number) => {
			const el = document.createElement(tag);
			el.textContent = cell.text;
			el.contentEditable = 'plaintext-only';
			el.dataset.row = String(row);
			el.dataset.col = String(col);
			if (col === 0) el.classList.add('md-first-col');
			cellEls.push(el);
			el.addEventListener('blur', () => this.commitCell(cell, el.textContent || ''));
			el.addEventListener('keydown', e => {
				if (e.key === 'Enter' || e.key === 'Escape') {
					e.preventDefault();
					el.blur();
				} else if (e.key === 'Tab') {
					// Commit and move to the next/previous cell.
					e.preventDefault();
					const changed = this.commitCell(cell, el.textContent || '');
					const idx = cellEls.indexOf(el);
					const dir = e.shiftKey ? -1 : 1;
					const next = cellEls[(idx + dir + cellEls.length) % cellEls.length];
					if (changed) {
						// The table rebuilds; the rebuilt cell for (row, col) will take focus.
						pendingCellFocus = { row: Number(next.dataset.row), col: Number(next.dataset.col) };
					} else {
						next.focus();
					}
				} else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
					// Move to the cell above/below in the same column (single-line cells).
					const delta = e.key === 'ArrowUp' ? -1 : 1;
					const target = cellEls.find(c => Number(c.dataset.row) === row + delta && Number(c.dataset.col) === col);
					if (target) {
						e.preventDefault();
						const changed = this.commitCell(cell, el.textContent || '');
						if (changed) pendingCellFocus = { row: row + delta, col };
						else target.focus();
					}
				}
			});
			el.addEventListener('contextmenu', e => {
				e.preventDefault();
				e.stopPropagation();
				this.showContextMenu(e.clientX, e.clientY, row, col);
			});
			// Restore focus if a Tab-triggered rebuild just recreated this cell.
			if (pendingCellFocus && pendingCellFocus.row === row && pendingCellFocus.col === col) {
				pendingCellFocus = null;
				requestAnimationFrame(() => el.focus());
			}
			return el;
		};

		// A floating drag handle (⠿) for a row or column. It is a small span positioned to
		// the left of a row / above a column, shown only on hover, so it doesn't add cells
		// or shift the table layout.
		const makeHandle = (kind: 'row' | 'col', index: number) => {
			const el = document.createElement('span');
			el.className = 'md-drag-handle md-drag-' + kind;
			// The grip glyph is drawn via CSS (::before) so the cell's textContent stays
			// clean — it must not leak into the committed markdown when a cell is saved.
			el.setAttribute('contenteditable', 'false');
			el.draggable = true;
			el.title = 'Drag to reorder ' + kind;
			el.addEventListener('dragstart', e => {
				e.dataTransfer!.setData('text/plain', kind + ':' + index);
				e.dataTransfer!.effectAllowed = 'move';
				dragPayload = { kind, index };
				el.classList.add('is-dragging');
			});
			el.addEventListener('dragend', () => {
				el.classList.remove('is-dragging');
				dragPayload = null;
				clearDropIndicators(table);
			});
			return el;
		};

		// Row drop targets (on each <tr>): show an insertion line above/below and reorder on drop.
		const wireRowDrop = (tr: HTMLElement, r: number) => {
			tr.addEventListener('dragover', e => {
				if (!dragPayload || dragPayload.kind !== 'row') return;
				e.preventDefault();
				e.dataTransfer!.dropEffect = 'move';
				const rect = tr.getBoundingClientRect();
				const before = (e.clientY - rect.top) < rect.height / 2;
				clearDropIndicators(table);
				tr.classList.add(before ? 'md-drop-before' : 'md-drop-after');
			});
			tr.addEventListener('drop', e => {
				if (!dragPayload || dragPayload.kind !== 'row') return;
				e.preventDefault();
				const rect = tr.getBoundingClientRect();
				const before = (e.clientY - rect.top) < rect.height / 2;
				clearDropIndicators(table);
				const target = before ? r : r + 1;
				this.moveRow(dragPayload.index, target);
				dragPayload = null;
			});
		};

		// Column drop targets (on each cell of a column): show a vertical insertion line and reorder on drop.
		const wireColDrop = (el: HTMLElement, col: number) => {
			el.addEventListener('dragover', e => {
				if (!dragPayload || dragPayload.kind !== 'col') return;
				e.preventDefault();
				e.dataTransfer!.dropEffect = 'move';
				const rect = el.getBoundingClientRect();
				const left = (e.clientX - rect.left) < rect.width / 2;
				clearDropIndicators(table);
				const cells = Array.from(table.querySelectorAll<HTMLElement>(`[data-col="${col}"]`));
				cells.forEach(c => c.classList.add(left ? 'md-drop-col-left' : 'md-drop-col-right'));
			});
			el.addEventListener('drop', e => {
				if (!dragPayload || dragPayload.kind !== 'col') return;
				e.preventDefault();
				const rect = el.getBoundingClientRect();
				const left = (e.clientX - rect.left) < rect.width / 2;
				clearDropIndicators(table);
				const target = left ? col : col + 1;
				this.moveColumn(dragPayload.index, target);
				dragPayload = null;
			});
		};

		const thead = document.createElement('thead');
		const headRow = document.createElement('tr');
		this.header.forEach((cell, col) => {
			const th = makeCell('th', cell, -1, col);
			th.appendChild(makeHandle('col', col));
			wireColDrop(th, col);
			headRow.appendChild(th);
		});
		thead.appendChild(headRow);
		table.appendChild(thead);

		const tbody = document.createElement('tbody');
		this.rows.forEach((row, r) => {
			const tr = document.createElement('tr');
			wireRowDrop(tr, r);
			row.forEach((cell, col) => {
				const td = makeCell('td', cell, r, col);
				if (col === 0) td.appendChild(makeHandle('row', r));
				wireColDrop(td, col);
				tr.appendChild(td);
			});
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);

		// "+ row" — centered under the table, at the end of the last row.
		const addRow = document.createElement('button');
		addRow.className = 'md-table-add md-table-add-row';
		addRow.textContent = '+';
		addRow.title = 'Add row';
		addRow.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (!view) return;
			const raw = buildTableMarkdown(
				this.header.map(c => c.text),
				[...this.rows.map(r => r.map(c => c.text)), Array(this.header.length).fill('')]
			);
			view.dispatch({ changes: { from: this.from, to: this.to, insert: raw } });
		});

		// "+ column" — vertically centered to the right of the last column.
		const addCol = document.createElement('button');
		addCol.className = 'md-table-add md-table-add-col';
		addCol.textContent = '+';
		addCol.title = 'Add column';
		addCol.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (!view) return;
			const raw = buildTableMarkdown(
				[...this.header.map(c => c.text), ''],
				this.rows.map(r => [...r.map(c => c.text), ''])
			);
			view.dispatch({ changes: { from: this.from, to: this.to, insert: raw } });
		});

		// Buttons live on the inner box (which shrink-wraps the table), so they sit at the
		// table's real edges; the scroll container only clips what overflows its own box.
		inner.appendChild(table);
		inner.appendChild(addRow);
		inner.appendChild(addCol);
		scroll.appendChild(inner);
		wrap.appendChild(scroll);

		return wrap;
	}

	ignoreEvent() {
		// Let the browser handle all events inside the table natively (cell focus/editing,
		// button clicks, context menu) instead of CodeMirror intercepting them.
		return true;
	}
}

/** A rendered HTML block. Its CSS is isolated in a shadow root; scripts/event handlers are
 * blocked by the webview CSP (script-src has no 'unsafe-inline'). Clicking selects source. */
class HtmlBlockWidget extends WidgetType {
	constructor(readonly html: string, readonly from: number, readonly to: number) {
		super();
	}

	eq(other: HtmlBlockWidget) {
		return other.html === this.html && other.from === this.from;
	}

	toDOM() {
		const host = document.createElement('div');
		host.className = 'md-html-block';
		host.setAttribute('contenteditable', 'false');
		const shadow = host.attachShadow({ mode: 'open' });

		// Give the shadow content the editor's font/color and sensible element defaults, so
		// headings, lists, tables, etc. inside an HTML block render like the rest of the note.
		const style = document.createElement('style');
		style.textContent = `
			:host {
				font-family: var(--vscode-editor-font-family, monospace);
				font-size: var(--vscode-editor-font-size, 14px);
				color: var(--vscode-editor-foreground, #d4d4d4);
				line-height: 1.5;
				display: block;
			}
			h1, h2, h3, h4, h5, h6 { font-weight: 700; margin: 0.6em 0 0.3em; line-height: 1.25; }
			h1 { font-size: 1.9em; } h2 { font-size: 1.6em; } h3 { font-size: 1.35em; }
			h4 { font-size: 1.15em; } h5 { font-size: 1em; } h6 { font-size: 0.9em; }
			p { margin: 0.3em 0; }
			ul, ol { margin: 0.3em 0; padding-left: 1.6em; }
			a { color: var(--vscode-textLink-foreground, #3794ff); }
			img { max-width: 100%; }
			blockquote { margin: 0.3em 0; padding-left: 0.6em; border-left: 3px solid var(--vscode-editorWidget-border, #454545); color: var(--vscode-descriptionForeground); }
			code, pre { font-family: var(--vscode-editor-font-family, monospace); background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); border-radius: 3px; }
			code { padding: 0 2px; } pre { padding: 0.5em; overflow-x: auto; }
			table { border-collapse: collapse; }
			table th, table td { border: 1px solid var(--md-gridline); padding: 0.25em 0.6em; }
			table th { background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.12)); }
			hr { border: none; border-top: 1px solid var(--md-gridline); margin: 0.6em 0; }
			details { margin: 0.3em 0; }
			details > summary { cursor: pointer; font-weight: 600; user-select: none; }
			details[open] > summary { margin-bottom: 0.3em; }
		`;
		shadow.appendChild(style);

		const content = document.createElement('div');
		content.innerHTML = this.html;
		shadow.appendChild(content);

		host.addEventListener('mousedown', e => e.preventDefault());
		host.addEventListener('click', e => {
			e.preventDefault();
			if (view) view.dispatch({ selection: EditorSelection.range(this.from, this.to) });
		});
		return host;
	}

	ignoreEvent() {
		return false;
	}
}

/** Build the actual `<img>` element for a resolved image. Clicking it selects the whole
 * `![alt](url)` source so the user can edit/replace it in one go. */
function buildImageElement(url: string, alt: string, from: number, to: number): HTMLElement {
	const img = document.createElement('img');
	img.className = 'md-image';
	img.src = url;
	img.alt = alt;
	img.title = alt || url;
	img.setAttribute('contenteditable', 'false');
	img.addEventListener('mousedown', e => e.preventDefault());
	img.addEventListener('click', e => {
		e.preventDefault();
		if (view) view.dispatch({ selection: EditorSelection.range(from, to) });
	});
	return img;
}

/** An inline image. Remote URLs render the real image; local/relative paths are resolved
 * through the host (which maps them onto the webview's file roots) and swapped in. */
class ImageWidget extends WidgetType {
	constructor(readonly url: string, readonly alt: string, readonly from: number, readonly to: number) {
		super();
	}

	eq(other: ImageWidget) {
		return other.url === this.url && other.alt === this.alt;
	}

	toDOM() {
		const isRemote = /^(https?:|data:|blob:|\/\/)/i.test(this.url);
		if (isRemote) {
			return buildImageElement(this.url, this.alt, this.from, this.to);
		}
		// Local/relative path: show a placeholder until the host resolves the file URI.
		const span = document.createElement('span');
		span.className = 'md-image-placeholder';
		span.textContent = '🖼 ' + (this.alt || this.url || 'image');
		span.dataset.alt = this.alt;
		span.dataset.from = String(this.from);
		span.dataset.to = String(this.to);
		span.setAttribute('contenteditable', 'false');
		span.addEventListener('mousedown', e => e.preventDefault());

		const cached = imageUriCache.get(this.url);
		if (cached) {
			span.className = 'md-image-wrap';
			span.textContent = '';
			span.appendChild(buildImageElement(cached, this.alt, this.from, this.to));
		} else {
			const waiters = imageWaiters.get(this.url) || [];
			waiters.push(span);
			imageWaiters.set(this.url, waiters);
			vscode.postMessage({ type: 'resolve-image', src: this.url });
		}
		return span;
	}

	ignoreEvent() {
		return false;
	}
}

function headingLevel(name: string): number {
	const m = /^ATXHeading([1-6])$/.exec(name);
	return m ? Number(m[1]) : 0;
}

/** Build a bold SVG chevron for the fold gutter — a real icon (wide + thick), not a text glyph. */
function foldMarker(open: boolean): HTMLElement {
	const NS = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(NS, 'svg');
	svg.setAttribute('viewBox', '0 0 20 20');
	svg.setAttribute('width', '18');
	svg.setAttribute('height', '18');
	const path = document.createElementNS(NS, 'path');
	// open (expanded) → down chevron; closed (folded) → right chevron.
	path.setAttribute('d', open ? 'M4 8 L10 14 L16 8' : 'M8 4 L14 10 L8 16');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '3');
	path.setAttribute('stroke-linecap', 'round');
	path.setAttribute('stroke-linejoin', 'round');
	path.setAttribute('fill', 'none');
	svg.appendChild(path);
	svg.style.display = 'block';
	svg.style.color = 'var(--vscode-icon-foreground, var(--vscode-descriptionForeground))';
	return svg;
}

/** A fold-gutter marker. `heading` marks heading folds so their chevron stays always visible;
 * other foldable sections get a hover-only chevron. */
class FoldGutterMarker extends GutterMarker {
	readonly elementClass: string;
	constructor(readonly open: boolean, readonly heading: boolean) {
		super();
		this.elementClass = heading ? 'md-fold-heading' : 'md-fold-hover';
	}
	eq(other: FoldGutterMarker) {
		return other.open === this.open && other.heading === this.heading;
	}
	toDOM() {
		return foldMarker(this.open);
	}
}

/** Find the folded range (if any) whose start lies within [from, to). */
function findFoldAt(state: EditorState, from: number, to: number): { from: number; to: number } | null {
	const folded = state.field(foldState, false);
	let found: { from: number; to: number } | null = null;
	if (folded) folded.between(from, to, (a, b) => {
		if (!found || found.from > a) found = { from: a, to: b };
	});
	return found;
}

/** True if the document position sits inside a heading (so its fold stays always visible). */
function isHeadingAt(state: EditorState, pos: number): boolean {
	let node = syntaxTree(state).resolveInner(pos, 1);
	while (node) {
		if (headingLevel(node.name)) return true;
		node = node.parent!;
	}
	return false;
}

/** Build fold-gutter markers for the visible lines (recomputed on doc/selection/viewport/fold changes). */
class FoldMarkersPlugin {
	markers: RangeSet<FoldGutterMarker>;
	constructor(readonly view: EditorView) {
		this.markers = this.build();
	}
	update(update: ViewUpdate) {
		if (update.docChanged || update.viewportChanged ||
			update.startState.field(foldState, false) !== update.state.field(foldState, false) ||
			syntaxTree(update.startState) !== syntaxTree(update.state)) {
			this.markers = this.build();
		}
	}
	build(): RangeSet<FoldGutterMarker> {
		const builder = new RangeSetBuilder<FoldGutterMarker>();
		for (const line of this.view.viewportLineBlocks) {
			const folded = findFoldAt(this.view.state, line.from, line.to);
			const range = folded ?? foldable(this.view.state, line.from, line.to);
			if (!range) continue;
			// A heading is detected at the *line* the marker sits on (the foldable range
			// starts after the heading text, so range.from points at the body, not the #).
			const heading = isHeadingAt(this.view.state, line.from);
			builder.add(line.from, line.from, new FoldGutterMarker(!folded, heading));
		}
		return builder.finish();
	}
}
const foldMarkersPlugin = ViewPlugin.fromClass(FoldMarkersPlugin);

/** Custom fold gutter: headings always show their fold chevron, other foldable sections only
 * show theirs while the mouse is over their line. */
const foldGutterExtension = [
	foldMarkersPlugin,
	gutter({
		class: 'cm-foldGutter',
		markers(view) {
			const p = view.plugin(foldMarkersPlugin);
			return p ? p.markers : RangeSet.empty;
		},
		initialSpacer() {
			return new FoldGutterMarker(false, false);
		},
		domEventHandlers: {
			click(view, line) {
				const folded = findFoldAt(view.state, line.from, line.to);
				if (folded) {
					view.dispatch({ effects: unfoldEffect.of(folded) });
					return true;
				}
				const range = foldable(view.state, line.from, line.to);
				if (range) {
					view.dispatch({ effects: foldEffect.of(range) });
					return true;
				}
				return false;
			}
		}
	})
];

/** Reveal non-heading fold chevrons when the mouse hovers their line. */
const foldHoverPlugin = ViewPlugin.fromClass(class {
	constructor(readonly view: EditorView) {
		this.view.scrollDOM.addEventListener('mousemove', this.onMove);
		this.view.scrollDOM.addEventListener('mouseleave', this.onLeave);
	}
	update() { /* nothing */ }
	onMove = (e: MouseEvent) => {
		const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
		let top = -1;
		if (pos != null) {
			const coords = this.view.coordsAtPos(this.view.state.doc.lineAt(pos).from);
			if (coords) top = coords.top;
		}
		for (const el of this.view.dom.querySelectorAll<HTMLElement>('.cm-foldGutter .cm-gutterElement')) {
			el.classList.toggle('md-fold-hovered', top >= 0 && Math.abs(el.getBoundingClientRect().top - top) < 1);
		}
	};
	onLeave = () => {
		for (const el of this.view.dom.querySelectorAll<HTMLElement>('.cm-foldGutter .cm-gutterElement.md-fold-hovered')) {
			el.classList.remove('md-fold-hovered');
		}
	};
	destroy() {
		this.view.scrollDOM.removeEventListener('mousemove', this.onMove);
		this.view.scrollDOM.removeEventListener('mouseleave', this.onLeave);
	}
});

/** After a Tab/Shift+Tab indent, restart numbering on the ordered list(s) around the cursor,
 * so a nested sub-list starts at 1 instead of continuing the parent list's numbers. */
function renumberOrderedListsAtCursor(view: EditorView) {
	const state = view.state;
	const pos = state.selection.main.head;
	// Walk up from the cursor to the topmost OrderedList ancestor.
	let cur = syntaxTree(state).resolveInner(pos, 1);
	let top: typeof cur | null = null;
	while (cur.name !== 'Document') {
		if (cur.name === 'OrderedList') top = cur;
		cur = cur.parent!;
	}
	if (!top) return;

	const edits: { from: number; to: number; insert: string }[] = [];
	const renumber = (list: typeof cur) => {
		let n = 1;
		for (let child = list.firstChild; child; child = child.nextSibling) {
			if (child.name !== 'ListItem') continue;
			const mark = child.getChild('ListMark');
			if (mark) {
				const text = state.doc.sliceString(mark.from, mark.to);
				const delim = text.endsWith(')') ? ')' : '.';
				const target = n + delim;
				if (text !== target) edits.push({ from: mark.from, to: mark.to, insert: target });
			}
			for (let g = child.firstChild; g; g = g.nextSibling) {
				if (g.name === 'OrderedList') renumber(g);
			}
			n++;
		}
	};
	renumber(top);
	if (edits.length) view.dispatch({ changes: edits });
}

/** Tab indents and then restarts numbering on the nested ordered list; Shift+Tab outdents. */
const indentWithRenumber = {
	key: 'Tab',
	run: (view: EditorView) => {
		const ok = indentMore(view);
		if (ok) renumberOrderedListsAtCursor(view);
		return ok;
	},
	shift: (view: EditorView) => {
		const ok = indentLess(view);
		if (ok) renumberOrderedListsAtCursor(view);
		return ok;
	}
};

/** Inline HTML elements that never have a closing tag. */
const VOID_TAGS = new Set([
	'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
	'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/** Map a formatting HTML tag to the WYSIWYG class that renders the same effect. */
function formatClassForTag(tag: string): string | null {
	switch (tag) {
		case 'b': case 'strong': return 'md-strong';
		case 'i': case 'em': return 'md-em';
		case 'u': case 'ins': return 'md-underline';
		case 's': case 'del': case 'strike': return 'md-strike';
		case 'code': case 'kbd': case 'samp': return 'md-inline-code';
		case 'mark': return 'md-mark';
		case 'sub': return 'md-sub';
		case 'sup': return 'md-sup';
		default: return null;
	}
}

/** `<br>` renders as a real line break inside the paragraph. */
class BrWidget extends WidgetType {
	eq() { return true; }
	toDOM() { return document.createElement('br'); }
	ignoreEvent() { return false; }
}

/** `<hr>` renders as a horizontal rule. */
class HrWidget extends WidgetType {
	eq() { return true; }
	toDOM() {
		const hr = document.createElement('hr');
		hr.className = 'md-hr';
		return hr;
	}
	ignoreEvent() { return false; }
}

/** A decoded HTML entity (e.g. `&nbsp;` → non-breaking space, `&amp;` → `&`). */
class EntityWidget extends WidgetType {
	constructor(readonly char: string) {
		super();
	}
	eq(other: EntityWidget) {
		return other.char === this.char;
	}
	toDOM() {
		const span = document.createElement('span');
		span.textContent = this.char;
		return span;
	}
	ignoreEvent() { return false; }
}

/** Decode an HTML entity source (like `&nbsp;` or `&#160;`) into its character. */
function decodeEntity(entity: string): string {
	const el = document.createElement('div');
	el.innerHTML = entity;
	return el.textContent || entity;
}

/** Block-level container tags whose opening/closing pairs can span blank lines + markdown
 * (e.g. `<details>` … `</details>`). The parser splits these into separate HTMLBlock nodes,
 * so we merge them back into one rendered unit. */
const CONTAINER_TAGS = new Set([
	'div', 'details', 'section', 'article', 'aside', 'header', 'footer',
	'nav', 'main', 'figure', 'figcaption', 'table', 'ul', 'ol', 'li',
	'blockquote', 'pre', 'form', 'fieldset', 'dl', 'dt', 'dd', 'summary'
]);

/** The note's file-level identity banner, replacing the `<!-- drip-file … -->` header
 * comment. Display-only — it renders the filename, file id, and persistent-heading count
 * the header declares, but is never editable in the live editor (the comment is
 * host-maintained). */
class FileHeaderWidget extends WidgetType {
	constructor(
		readonly filename: string,
		readonly fileid: string,
		readonly headings: number | null
	) {
		super();
	}

	eq(other: FileHeaderWidget) {
		return (
			other.filename === this.filename &&
			other.fileid === this.fileid &&
			other.headings === this.headings
		);
	}

	toDOM() {
		const wrap = document.createElement('div');
		wrap.className = 'md-file-header';
		wrap.setAttribute('contenteditable', 'false');

		const title = document.createElement('div');
		title.className = 'md-file-header-title';
		title.textContent = this.filename || 'Untitled';
		wrap.appendChild(title);

		const meta = document.createElement('div');
		meta.className = 'md-file-header-meta';

		const fileId = document.createElement('span');
		fileId.className = 'md-file-header-item md-file-header-id';
		fileId.textContent = this.fileid || '@f—';
		fileId.title = 'File id';
		meta.appendChild(fileId);

		if (this.headings != null) {
			const hc = document.createElement('span');
			hc.className = 'md-file-header-item';
			hc.textContent = `${this.headings} heading${this.headings === 1 ? '' : 's'}`;
			hc.title = 'Persistent headings';
			meta.appendChild(hc);
		}

		wrap.appendChild(meta);
		return wrap;
	}

	ignoreEvent() {
		return true;
	}
}

/** A row of metadata chips replacing a heading's hidden comment line. Read-only, but each
 * chip opens a dropdown to edit its value, which rewrites the comment in the source. The
 * leading type chip is a button that opens the "Heading type" picker. */
class ChipRowWidget extends WidgetType {
	readonly typeId: string;

	constructor(
		readonly title: string,
		readonly parsed: ParsedComment,
		readonly from: number,
		readonly to: number
	) {
		super();
		// The comment's type token is the authority (no heading prefix in `.d.md`); an
		// empty token means untyped-but-indexed, shown as `persistent`.
		this.typeId = this.parsed.typeId || PERSISTENT_TYPE_ID;
	}

	eq(other: ChipRowWidget) {
		return (
			other.title === this.title &&
			other.from === this.from &&
			other.to === this.to &&
			other.parsed.typeId === this.parsed.typeId &&
			other.parsed.fields.length === this.parsed.fields.length &&
			other.parsed.fields.every((f, i) => f.key === this.parsed.fields[i].key && f.value === this.parsed.fields[i].value)
		);
	}

	/** Write an updated field list back into the comment line (a pure editor edit). */
	private commit(fields: MdField[]) {
		if (!view) return;
		const text = formatHeadingComment(this.parsed.headingNum, this.typeId, fields);
		view.dispatch({ changes: { from: this.from, to: this.to, insert: text }, filter: false });
	}

	/** Change the heading's type (rewrites the comment's type token). Empty = demote. */
	private setType(typeId: string) {
		if (!view) return;
		if (!typeId) {
			this.removeComment();
			return;
		}
		const text = formatHeadingComment(this.parsed.headingNum, typeId, this.parsed.fields);
		view.dispatch({ changes: { from: this.from, to: this.to, insert: text }, filter: false });
	}

	/** Open the "Heading type" picker anchored on the type chip. */
	private openTypePicker(anchor: HTMLElement) {
		openPopover(anchor, pop => {
			buildTypePicker(pop, this.typeId, typeId => this.setType(typeId));
		});
	}

	/** Demote this heading to a plain heading by deleting its whole comment line. */
	private removeComment() {
		if (!view) return;
		const doc = view.state.doc;
		const line = doc.lineAt(this.from);
		const end = line.number < doc.lines ? doc.line(line.number + 1).from : doc.length;
		view.dispatch({ changes: { from: line.from, to: end, insert: '' }, filter: false });
	}

	private setField(key: string, value: string) {
		// Replace in place when the key already exists (preserving field order), and
		// append at the end when it's a newly added attribute.
		const fields = this.parsed.fields.map(f => (f.key === key ? { key, value } : f));
		if (!fields.some(f => f.key === key)) fields.push({ key, value });
		this.commit(fields);
	}

	private removeField(key: string) {
		this.commit(this.parsed.fields.filter(f => f.key !== key));
	}

	/** Add a tag if missing, or remove it if already present (case-insensitive). */
	private toggleTag(field: MdField, tag: string) {
		const current = parseListField(field.value);
		const idx = current.findIndex(t => t.toLowerCase() === tag.toLowerCase());
		if (idx >= 0) current.splice(idx, 1);
		else current.push(tag);
		this.setField(field.key, current.length ? `[${current.join(', ')}]` : '');
	}

	/**
	 * Build the tag dropdown used by every relation (`tags`, `pre-req`, …): a search box,
	 * then the current values (ticked) and the tags already in the note's graph (fetched
	 * from the host into `cachedTags`), plus a "create new tag" input at the bottom. The
	 * list narrows as you type — word matches first, then semantic (embedding) matches
	 * from the host — and clicking a tag toggles it and closes.
	 */
	private buildTagsPicker(pop: HTMLElement, field: MdField) {
		const header = document.createElement('div');
		header.className = 'md-popover-title';
		header.textContent = field.key.charAt(0).toUpperCase() + field.key.slice(1);
		pop.appendChild(header);

		// Search box — filters the list live and drives the host semantic search.
		const search = document.createElement('input');
		search.className = 'md-popover-input';
		search.placeholder = 'Search tags…';
		search.value = tagsSearchQuery;
		search.addEventListener('mousedown', e => e.stopPropagation());
		pop.appendChild(search);

		// The result list is re-rendered in place on every keystroke / result batch.
		const list = document.createElement('div');
		list.className = 'md-tags-list';
		pop.appendChild(list);

		// Create a new tag (created in the note's graph by the host). A labelled row with its
		// own input and a "+ Create" button, so it is unmistakably separate from the search box.
		const createWrap = document.createElement('div');
		createWrap.className = 'md-popover-create';
		const createLabel = document.createElement('div');
		createLabel.className = 'md-popover-title';
		createLabel.textContent = 'Create new tag';
		createWrap.appendChild(createLabel);
		const createRow = document.createElement('div');
		createRow.className = 'md-popover-create-row';
		const createInput = document.createElement('input');
		createInput.className = 'md-popover-input';
		createInput.placeholder = 'New tag name…';
		createInput.value = tagsSearchQuery;
		createInput.addEventListener('mousedown', e => e.stopPropagation());
		createInput.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				createTag();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				closePopover();
			}
		});
		createRow.appendChild(createInput);
		const createButton = document.createElement('button');
		createButton.className = 'md-popover-create-btn';
		createButton.textContent = '+ Create';
		createButton.addEventListener('mousedown', e => e.stopPropagation());
		createButton.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			createTag();
		});
		createRow.appendChild(createButton);
		createWrap.appendChild(createRow);
		pop.appendChild(createWrap);
		const createTag = () => {
			const name = createInput.value.trim();
			if (!name) return;
			closePopover();
			vscode.postMessage({ type: 'create-tag', tag: name });
			this.toggleTag(field, name);
		};

		const renderList = () => {
			list.textContent = '';
			const cachedLower = new Set(cachedTags.map(t => t.toLowerCase()));
			const current = parseListField(field.value);
			const currentLower = new Set(current.map(t => t.toLowerCase()));
			const query = tagsSearchQuery.trim();

			if (!query) {
				// Empty query: the current tags plus a small slice of the graph's tags.
				for (const t of current) {
					popoverValueItem(list, t, true, () => this.toggleTag(field, t));
				}
				let shown = 0;
				for (const t of cachedTags) {
					if (currentLower.has(t.toLowerCase())) continue;
					if (shown >= 8) break;
					popoverValueItem(list, t, false, () => this.toggleTag(field, t));
					shown++;
				}
			} else {
				const ql = query.toLowerCase();
				const shown = new Set<string>(currentLower);
				// Matching current tags first (ticked), so they can be removed.
				for (const t of current) {
					if (!t.toLowerCase().includes(ql)) continue;
					popoverValueItem(list, t, true, () => this.toggleTag(field, t));
				}
				// Word matches (up to 3), then semantic matches (up to 3), no overlap.
				for (const t of rankTagsByQuery(cachedTags, query)) {
					if (shown.has(t.toLowerCase())) continue;
					shown.add(t.toLowerCase());
					popoverValueItem(list, t, false, () => this.toggleTag(field, t));
					if (shown.size - currentLower.size >= 3) break;
				}
				for (const t of tagsSemantic) {
					if (shown.has(t.toLowerCase())) continue;
					if (!cachedLower.has(t.toLowerCase())) continue; // keep it graph-scoped
					shown.add(t.toLowerCase());
					popoverValueItem(list, t, false, () => this.toggleTag(field, t));
					if (shown.size - currentLower.size >= 6) break;
				}
			}
		};

		tagsListRerender = renderList;

		search.addEventListener('input', () => {
			tagsSearchQuery = search.value;
			createInput.value = tagsSearchQuery;
			renderList();
			requestTagSearch();
		});

		renderList();
		requestAnimationFrame(() => search.focus());
	}

	/** One editable field chip (`key: value`). */
	private fieldChip(field: MdField, attr: MdAttr | null, isRelation: boolean): HTMLElement {
		const chip = document.createElement('span');
		chip.className = 'md-chip';
		chip.setAttribute('contenteditable', 'false');

		const key = document.createElement('span');
		key.className = 'md-chip-key';
		key.textContent = field.key;
		chip.appendChild(key);

		const val = document.createElement('span');
		val.className = 'md-chip-value';
		val.textContent = field.value;
		chip.appendChild(val);

		// Unknown fields (not an attribute nor a relation) are shown read-only; the
		// first-open sweep normally removes them, so this is just a defensive fallback.
		if (!attr && !isRelation) {
			chip.classList.add('md-chip-static');
			return chip;
		}

		chip.classList.add('md-chip-editable');
		chip.title = `Edit ${field.key}`;
		chip.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.openEditor(chip, field, attr);
		});
		return chip;
	}

	/** A faint "+ key" chip for a missing attribute/relation. */
	private addChip(key: string, attr: MdAttr | null, isRelation: boolean, required: boolean): HTMLElement {
		const chip = document.createElement('span');
		chip.className = 'md-chip md-chip-add' + (required ? ' md-chip-required' : '');
		chip.setAttribute('contenteditable', 'false');
		chip.textContent = `+ ${key}`;
		chip.title = `Add ${key}`;
		chip.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.openEditor(chip, { key, value: '' }, attr);
		});
		return chip;
	}

	/** Open the dropdown popover for a chip (attribute → typed picker, relation → list input). */
	private openEditor(anchor: HTMLElement, field: MdField, attr: MdAttr | null) {
		const isRelation = !attr && schema.allowedRelations.includes(field.key);

		openPopover(anchor, pop => {
			const remove = () => popoverItem(pop, 'Remove', () => this.removeField(field.key), true);

			if (attr && attr.type === 'enum') {
				const values = (attr.values || []).filter(Boolean);
				if (values.length) {
					for (const v of values) {
						// Tick the current value; re-clicking it deselects (removes the field).
						const isSelected = v === field.value;
						popoverValueItem(pop, v, isSelected, () =>
							isSelected ? this.removeField(field.key) : this.setField(field.key, v)
						);
					}
				} else {
					// Free-form enum (e.g. an empty-values domain): plain text input.
					const { input } = popoverInput(pop, field.value, v => {
						if (v) this.setField(field.key, v);
					});
					input.placeholder = field.key;
					requestAnimationFrame(() => input.focus());
				}
			} else if (attr && attr.type === 'datetime') {
				// Free-text input normalized like `.d.txt`: `2026-04-29 18:30` stays as-is,
				// and a relative phrase (`2 days`, `45 min`) becomes the absolute minute string.
				const input = document.createElement('input');
				input.className = 'md-popover-input';
				input.value = field.value;
				input.placeholder = 'YYYY-MM-DD HH:mm or "2 days" / "45 min"';
				input.addEventListener('mousedown', e => e.stopPropagation());
				pop.appendChild(input);
				const commitDateTime = () => {
					const normalized = normalizeDateTimeInput(input.value);
					closePopover();
					if (normalized) this.setField(field.key, normalized);
					else this.removeField(field.key);
				};
				input.addEventListener('keydown', e => {
					if (e.key === 'Enter') {
						e.preventDefault();
						commitDateTime();
					}
					if (e.key === 'Escape') {
						e.preventDefault();
						closePopover();
					}
				});
				remove();
				requestAnimationFrame(() => input.focus());
			} else if (attr && attr.type === 'duration') {
				const box = document.createElement('div');
				box.className = 'md-popover-duration';
				const amount = document.createElement('input');
				amount.className = 'md-popover-input';
				amount.type = 'number';
				amount.placeholder = 'amount';
				const unit = document.createElement('select');
				unit.className = 'md-popover-select';
				for (const u of ['minute', 'hour', 'day', 'week', 'month', 'year']) {
					const o = document.createElement('option');
					o.value = u;
					o.textContent = u;
					unit.appendChild(o);
				}
				const parts = field.value.split(/\s+/);
				amount.value = parts[0] || '';
				if (parts[1]) unit.value = parts[1];
				box.appendChild(amount);
				box.appendChild(unit);
				pop.appendChild(box);
				const commit = () => {
					const v = `${amount.value} ${unit.value}`.trim();
					closePopover();
					if (amount.value) this.setField(field.key, v);
				};
				[amount, unit].forEach(el =>
					el.addEventListener('mousedown', e => e.stopPropagation())
				);
				amount.addEventListener('keydown', e => {
					if (e.key === 'Enter') {
						e.preventDefault();
						commit();
					}
				});
				unit.addEventListener('change', commit);
				remove();
				requestAnimationFrame(() => amount.focus());
			} else if (isRelation) {
				// Relations (`tags`, `pre-req`, …) all reference tags, so every relation
				// edits through the same searchable tag dropdown: a search box, the current
				// values (ticked), word + semantic matches from the host, and a "create new
				// tag" input at the bottom.
				this.buildTagsPicker(pop, field);
				vscode.postMessage({ type: 'tags-list' });
			} else {
				// Any other field (ref attributes, …) — free text input.
				const { input } = popoverInput(pop, field.value, v => {
					if (v) this.setField(field.key, v);
					else this.removeField(field.key);
				});
				input.placeholder = field.key;
				requestAnimationFrame(() => input.focus());
				remove();
			}
		});
	}

	toDOM() {
		const row = document.createElement('div');
		row.className = 'md-chip-row';
		row.setAttribute('contenteditable', 'false');

		const typeChip = document.createElement('span');
		typeChip.className = 'md-chip md-chip-type';
		typeChip.textContent = this.typeId;
		typeChip.title = 'Change heading type';
		typeChip.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.openTypePicker(typeChip);
		});
		row.appendChild(typeChip);

		const attrs = attributesForType(this.typeId);
		for (const field of this.parsed.fields) {
			const attr = attrs.find(a => a.key === field.key) || null;
			row.appendChild(this.fieldChip(field, attr, !attr && schema.allowedRelations.includes(field.key)));
		}

		// Add placeholders for attributes (and relations) not yet present.
		for (const attr of attrs) {
			if (this.parsed.fields.some(f => f.key === attr.key)) continue;
			row.appendChild(this.addChip(attr.key, attr, false, attr.required));
		}
		for (const rel of schema.allowedRelations) {
			if (this.parsed.fields.some(f => f.key === rel)) continue;
			row.appendChild(this.addChip(rel, null, true, false));
		}

		return row;
	}

	ignoreEvent() {
		return true;
	}
}

/** An always-visible "+" glyph under a plain heading (no comment yet) that promotes it into
 * a DRIP heading: clicking it opens the "Heading type" picker and writes the chosen type's
 * comment line under the heading (a pure editor edit). */
class PromoteWidget extends WidgetType {
	constructor(readonly lineFrom: number) {
		super();
	}

	eq(other: PromoteWidget) {
		return other.lineFrom === this.lineFrom;
	}

	toDOM() {
		const btn = document.createElement('span');
		btn.className = 'md-heading-promote';
		btn.textContent = '+';
		btn.title = 'Set heading type';
		btn.setAttribute('contenteditable', 'false');
		btn.addEventListener('mousedown', e => e.preventDefault());
		btn.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			promoteHeading(this.lineFrom, btn);
		});
		return btn;
	}

	ignoreEvent() {
		return true;
	}
}

/** Insert a `<!-- drip hN | type -->` comment under the heading at `lineFrom`. The picker
 * runs first; on pick the comment is written with `h0` (id not yet assigned — the host
 * fills it on save), which the decoration pass then re-renders as a chip row. */
function promoteHeading(lineFrom: number, anchor: HTMLElement) {
	if (!view) return;
	const doc = view.state.doc;
	const line = doc.lineAt(lineFrom);
	const insertAt = line.number < doc.lines ? doc.line(line.number + 1).from : doc.length;
	openPopover(anchor, pop => {
		buildTypePicker(pop, '', typeId => {
			const chosen = typeId || PERSISTENT_TYPE_ID;
			const text = `${formatHeadingComment(0, chosen, [])}\n`;
			view!.dispatch({ changes: { from: insertAt, to: insertAt, insert: text }, filter: false });
		});
	});
}

/** Build the WYSIWYG decorations from the markdown syntax tree.
 *
 * Markers (`#`, `**`, `[]()`, backticks, pipes) are hidden by default. When the cursor is
 * inside a node, that node's markers are *revealed* (dimmed instead of hidden) so the
 * underline markdown is visible and editable — the same behavior as Obsidian's Live Preview.
 */
function buildDecorations(state: EditorState): DecorationSet {
	const decos: any[] = [];
	const doc = state.doc;
	const tree = syntaxTree(state);
	const cursor = state.selection.main.head;

	// File identity banner: replace the `<!-- drip-file … -->` header comment with a
	// display-only banner (filename, file id, heading count). The comment is the first line
	// of the file; scan only the top region (before the first heading) so a stray header
	// comment in the body is never styled.
	let fileHeaderLineNo = -1;
	for (let i = 1; i <= doc.lines; i++) {
		const text = doc.line(i).text.trim();
		if (isHeadingLine(text)) break; // hit the title before any header → no top banner
		if (isFileHeaderCommentLine(text)) {
			fileHeaderLineNo = i;
			break;
		}
		if (text) break; // any other non-blank content → the header isn't at the top
	}
	if (fileHeaderLineNo >= 0) {
		const headerLine = doc.line(fileHeaderLineNo);
		const parsedHeader = parseFileHeaderComment(headerLine.text);
		decos.push(
			Decoration.replace({
				widget: new FileHeaderWidget(parsedHeader.filename, parsedHeader.fileid, parsedHeader.headings),
				block: true
			}).range(headerLine.from, headerLine.to)
		);
	}

	// Metadata chip rows: hide each `<!-- drip hN | … -->` comment directly under a
	// persistent heading and render its fields as editable chips. Done as a line scan
	// (not via the syntax tree) so it stays exactly aligned with the host-side parser.
	for (let i = 1; i <= doc.lines; i++) {
		const line = doc.line(i);
		if (!isHeadingLine(line.text)) continue;
		const nextNo = i + 1;
		if (nextNo > doc.lines) break;
		const next = doc.line(nextNo);
		if (!isHeadingCommentLine(next.text)) continue;
		const parsed = parseHeadingComment(next.text);
		if (!parsed) continue;
		const title = line.text.replace(/^\s*#{1,6}\s+/, '').trim();
		decos.push(
			Decoration.replace({
				widget: new ChipRowWidget(title, parsed, next.from, next.to),
				block: true
			}).range(next.from, next.to)
		);
	}

	// Promote affordance: a small "+" glyph rendered as a block *below* a plain heading
	// (no comment yet), always visible, that opens the type picker. Placing it on its own
	// line keeps it from pushing the heading text sideways. The h0 title (first heading) is
	// skipped — it is the file title, never a body heading.
	let sawFirstHeading = false;
	for (let i = 1; i <= doc.lines; i++) {
		const line = doc.line(i);
		if (!isHeadingLine(line.text)) continue;
		if (!sawFirstHeading) {
			sawFirstHeading = true;
			continue;
		}
		if (i + 1 <= doc.lines && isHeadingCommentLine(doc.line(i + 1).text)) continue;
		decos.push(
			Decoration.widget({
				widget: new PromoteWidget(line.from),
				block: true,
				side: 1
			}).range(line.to)
		);
	}

	// Hide orphaned drip comments. The chip-row and banner scans above decorate the
	// well-placed ones (directly under their heading, or the file header at the very top);
	// any `<!-- drip … -->` / `<!-- drip-file … -->` left over — e.g. a note hand-edited
	// outside the editor left a stray comment behind — must never render raw. The markdown
	// parser exposes these as `CommentBlock` nodes (not `HTMLBlock`), so they are handled
	// here as a line scan rather than in the tree walk below.
	for (let i = 1; i <= doc.lines; i++) {
		const line = doc.line(i);
		const text = line.text.trim();
		const isHeadingC = isHeadingCommentLine(text);
		const isFileC = isFileHeaderCommentLine(text);
		if (!isHeadingC && !isFileC) continue;
		if (isHeadingC && i > 1 && isHeadingLine(doc.line(i - 1).text)) continue; // chipped
		if (isFileC && i === fileHeaderLineNo) continue; // banner
		decos.push(hide(line.from, line.to));
	}

	const inRange = (a: number, b: number) => cursor >= a && cursor <= b;
	// True when the cursor is inside OR immediately adjacent to a range (no space needed),
	// but never across a line boundary. A range at the start of a line must not "reveal"
	// when the cursor is at the end of the line above, and one at the end of a line must
	// not reveal when the cursor is at the start of the line below — the ±1 char tolerance
	// would otherwise leak onto the neighboring lines.
	const near = (a: number, b: number) => {
		if (cursor >= a && cursor <= b) return true;
		if (cursor === a - 1 && doc.lineAt(cursor).number === doc.lineAt(a).number) return true;
		if (cursor === b + 1 && doc.lineAt(cursor).number === doc.lineAt(b).number) return true;
		return false;
	};
	// True when the cursor is inside a range, OR on the same line as its start/end. Used for
	// HTML: reveals raw source on the element's own line, but NOT when the cursor is on the
	// line above/below the element.
	const nearLine = (a: number, b: number) => {
		if (cursor >= a && cursor <= b) return true;
		const la = doc.lineAt(a).number;
		const lb = doc.lineAt(b).number;
		const lc = doc.lineAt(cursor).number;
		return lc === la || lc === lb;
	};
	// Hide a marker unless the cursor is inside its node, in which case reveal it dimmed.
	const mark = (m: { from: number; to: number }, active: boolean) => {
		if (active) decos.push(dim(m.from, m.to));
		else decos.push(hide(m.from, m.to));
	};
	// Stack of inline HTML opening tags, used to pair them with closing tags so the text
	// between them can be formatted (e.g. `<b>x</b>` → bold "x"). Reset per rebuild.
	const openTags: { name: string; from: number; to: number; style?: string }[] = [];
	// Whether the cursor is right beside the current list item's marker region (`-` or
	// `- [ ]`). The raw marker source only reveals when the cursor is adjacent to it, not
	// when it is merely elsewhere on the same line.
	let listMarkerActive = false;

	// Pre-scan: pair container HTML blocks (e.g. `<details>` … `</details>`) that span blank
	// lines and markdown. The parser splits such a component into separate HTMLBlock nodes;
	// we merge them back into one rendered unit and reveal the whole thing together.
	const htmlBlocks: { from: number; to: number; tag: string; closing: boolean }[] = [];
	tree.iterate({
		enter(ref) {
			if (ref.name === 'HTMLBlock') {
				const txt = doc.sliceString(ref.from, ref.to);
				const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(txt);
				if (m) htmlBlocks.push({ from: ref.from, to: ref.to, tag: m[2].toLowerCase(), closing: m[1] === '/' });
			}
		}
	});
	const mergedHtml: { from: number; to: number }[] = [];
	const skipHtml = new Set<number>();
	for (let i = 0; i < htmlBlocks.length; i++) {
		const open = htmlBlocks[i];
		if (open.closing || !CONTAINER_TAGS.has(open.tag)) continue;
		for (let j = i + 1; j < htmlBlocks.length; j++) {
			const close = htmlBlocks[j];
			if (close.closing && close.tag === open.tag) {
				mergedHtml.push({ from: open.from, to: close.to });
				for (let k = i; k <= j; k++) skipHtml.add(htmlBlocks[k].from);
				i = j;
				break;
			}
		}
	}

	tree.iterate({
		enter(ref) {
			// `enter` receives a SyntaxNodeRef (from/name/to only); its `.node` gives the
			// full SyntaxNode with getChild/getChildren.
			const node = ref.node;
			const name = node.name;

			// Headings: hide the `#…` and render the title large. A lone `#`/`##` (nothing after
			// it yet) stays plain text — it only becomes a heading once a space follows, so the
			// user can type `#`, `##`, … freely and see the heading appear on the space.
			const level = headingLevel(name);
			if (level) {
				const markNode = node.getChild('HeaderMark');
				if (markNode && markNode.to < node.to) {
					let end = markNode.to;
					while (end < node.to && doc.sliceString(end, end + 1) === ' ') end++;
					mark({ from: markNode.from, to: end }, inRange(node.from, node.to));
					decos.push(style(`md-heading md-heading-${level}`, end, node.to));
				}
				return;
			}

			// Strong / emphasis / strikethrough: hide the delimiters, style the inner text.
			if (name === 'StrongEmphasis' || name === 'Emphasis' || name === 'Strikethrough') {
				const markName = name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark';
				const cls = name === 'StrongEmphasis' ? 'md-strong' : name === 'Emphasis' ? 'md-em' : 'md-strike';
				const marks = node.getChildren(markName);
				const active = inRange(node.from, node.to);
				for (const m of marks) mark(m, active);
				if (marks.length >= 2) {
					decos.push(style(cls, marks[0].to, marks[marks.length - 1].from));
				}
				return;
			}

			// Inline code: hide backticks, render monospace.
			if (name === 'InlineCode') {
				const active = inRange(node.from, node.to);
				for (const m of node.getChildren('CodeMark')) mark(m, active);
				decos.push(style('md-inline-code', node.from, node.to));
				return;
			}

			// Links: hide `[`, `](url)`, render just the label as a link.
			if (name === 'Link') {
				const active = inRange(node.from, node.to);
				for (const m of node.getChildren('LinkMark')) mark(m, active);
				const url = node.getChild('URL');
				if (url) mark(url, active);
				decos.push(style('md-link', node.from, node.to));
				return;
			}

			// Images: replace the whole `![alt](url)` with an inline image widget. When the
			// cursor is right beside the image (so the user is trying to edit it), reveal the
			// full raw `![alt](url)` markdown instead of the rendered image, so the source is
			// fully visible and editable.
			if (name === 'Image') {
				if (near(node.from, node.to)) return;
				const url = node.getChild('URL');
				const urlText = url ? doc.sliceString(url.from, url.to) : '';
				const marks = node.getChildren('LinkMark');
				const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : '';
				decos.push(
					Decoration.replace({ widget: new ImageWidget(urlText, alt, node.from, node.to) })
						.range(node.from, node.to)
				);
				return;
			}

			// Inline HTML: render `<b>`, `<img>`, `<br>` etc. instead of showing raw tags.
			// When the cursor is right next to a tag (even without a space), reveal that tag's
			// raw source so the user can edit it; otherwise the tag stays hidden/rendered.
			if (name === 'HTMLTag') {
				const tagText = doc.sliceString(node.from, node.to);
				const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(tagText);
				if (!m) return;
				const closing = m[1] === '/';
				const tagName = m[2].toLowerCase();
				const selfClosing = /\/\s*>$/.test(tagText);
				const active = nearLine(node.from, node.to);

				if (!closing && (selfClosing || VOID_TAGS.has(tagName))) {
					// Void / self-closing elements render in place; reveal raw when adjacent.
					if (active) return;
					if (tagName === 'br') {
						decos.push(Decoration.replace({ widget: new BrWidget() }).range(node.from, node.to));
					} else if (tagName === 'hr') {
						decos.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to));
					} else if (tagName === 'img') {
						const src = /src\s*=\s*"([^"]*)"/.exec(tagText) || /src\s*=\s*'([^']*)'/.exec(tagText);
						const url = src ? src[1] : '';
						decos.push(
							Decoration.replace({ widget: new ImageWidget(url, '', node.from, node.to) })
								.range(node.from, node.to)
						);
					} else {
						decos.push(hide(node.from, node.to));
					}
				} else if (!closing) {
					mark({ from: node.from, to: node.to }, active);
					const styleAttr = /style\s*=\s*"([^"]*)"/.exec(tagText) || /style\s*=\s*'([^']*)'/.exec(tagText);
					openTags.push({ name: tagName, from: node.from, to: node.to, style: styleAttr ? styleAttr[1] : undefined });
				} else {
					mark({ from: node.from, to: node.to }, active);
					const open = openTags.pop();
					if (open && open.name === tagName && open.to < node.from) {
						// Inline `style` (e.g. `<span style="…">chip</span>`) is applied to the
						// content so styled spans render like Obsidian chips/badges.
						if (open.style) {
							decos.push(Decoration.mark({ attributes: { style: open.style } }).range(open.to, node.from));
						}
						const cls = formatClassForTag(tagName);
						if (cls) decos.push(style(cls, open.to, node.from));
					}
				}
				return;
			}

			// Task list: hide the `-` marker, show a clickable checkbox. While the cursor is
			// right beside the marker, reveal the raw `[ ]` / `[x]` instead of the checkbox.
			if (name === 'Task') {
				const marker = node.getChild('TaskMarker');
				if (marker) {
					if (listMarkerActive) {
						decos.push(dim(marker.from, marker.to));
					} else {
						const text = doc.sliceString(marker.from, marker.to);
						const checked = /\[[xX]\]/.test(text);
						decos.push(
							Decoration.replace({
								widget: new CheckboxWidget(checked, marker.from, marker.to)
							}).range(marker.from, marker.to)
						);
					}
				}
				return;
			}

			// List items: bullet lists show a bullet; task/ordered items keep source markers.
			// The raw `-` / `- [ ]` source reveals only when the cursor is right beside the
			// marker region, not anywhere else on the line.
			if (name === 'ListItem') {
				const listMark = node.getChild('ListMark');
				if (!listMark) return;
				const text = doc.sliceString(listMark.from, listMark.to);
				const hasTask = !!node.getChild('Task');
				const taskMarker = hasTask ? node.getChild('Task')!.getChild('TaskMarker') : null;
				const markerEnd = taskMarker ? taskMarker.to : listMark.to;
				listMarkerActive = near(listMark.from, markerEnd);
				if (hasTask) {
					mark({ from: listMark.from, to: listMark.to }, listMarkerActive);
				} else if (/^[-*+]\s*$/.test(text)) {
					if (listMarkerActive) {
						decos.push(dim(listMark.from, listMark.to));
					} else {
						decos.push(Decoration.replace({ widget: new BulletWidget() }).range(listMark.from, listMark.to));
					}
				}
				return;
			}

			// Blockquote: hide the `>` and style the quote.
			if (name === 'Blockquote') {
				const qm = node.getChild('QuoteMark');
				if (qm) decos.push(hide(qm.from, qm.to));
				decos.push(style('md-quote', node.from, node.to));
				return;
			}

			// Fenced code block: hide the fences + language info, render monospace. An unclosed
			// fence (only the opening ``` yet) stays raw so the user can type the closing fence.
			if (name === 'FencedCode') {
				const marks = node.getChildren('CodeMark');
				if (marks.length < 2) return;
				for (const m of marks) decos.push(hide(m.from, m.to));
				const info = node.getChild('CodeInfo');
				if (info) decos.push(hide(info.from, info.to));
				const text = node.getChild('CodeText');
				if (text) decos.push(style('md-codeblock', text.from, text.to));
				return;
			}

			// Horizontal rule (`---`, `***`, `___`): render as an `<hr>`; reveal raw while
			// the cursor is beside it so it can be edited.
			if (name === 'HorizontalRule') {
				if (near(node.from, node.to)) return;
				decos.push(Decoration.replace({ widget: new HrWidget(), block: true }).range(node.from, node.to));
				return;
			}

			// HTML entity (`&nbsp;`, `&amp;`, `&#160;`, …): decode and render the character;
			// reveal the raw entity while the cursor is beside it.
			if (name === 'Entity') {
				if (near(node.from, node.to)) return;
				const raw = doc.sliceString(node.from, node.to);
				decos.push(Decoration.replace({ widget: new EntityWidget(decodeEntity(raw)) }).range(node.from, node.to));
				return;
			}

			// Table: always render as a real HTML table with directly editable cells.
			if (name === 'Table') {
				const { header, rows } = parseTable(doc, node.from, node.to);
				decos.push(
					Decoration.replace({ widget: new TableWidget(node.from, node.to, header, rows), block: true })
						.range(node.from, node.to)
				);
				return;
			}

			// HTML block: render isolated in a shadow root — but reveal raw HTML when the
			// cursor is inside OR right next to it (no space needed), so it is editable in place.
			if (name === 'HTMLBlock') {
				if (skipHtml.has(node.from)) return; // part of a merged container span, handled below
				// A heading comment is already replaced by its chip row above.
				if (isHeadingCommentLine(doc.sliceString(node.from, node.to))) return;
				// The file identity block is host-maintained and never rendered.
				if (isFileHeaderCommentLine(doc.sliceString(node.from, node.to))) return;
				if (nearLine(node.from, node.to)) return;
				const html = doc.sliceString(node.from, node.to);
				decos.push(
					Decoration.replace({ widget: new HtmlBlockWidget(html, node.from, node.to), block: true })
						.range(node.from, node.to)
				);
				return;
			}
		}
	});

	// Merged container HTML blocks (e.g. `<details>…</details>`): render as one unit and
	// reveal the entire raw span when the cursor is beside it.
	for (const span of mergedHtml) {
		if (nearLine(span.from, span.to)) continue;
		const html = doc.sliceString(span.from, span.to);
		decos.push(
			Decoration.replace({ widget: new HtmlBlockWidget(html, span.from, span.to), block: true })
				.range(span.from, span.to)
		);
	}

	// Drop empty mark decorations (helpers return null for empty ranges) — CodeMirror
	// throws "Mark decorations may not be empty" otherwise.
	return Decoration.set(decos.filter((d: unknown) => d != null), true);
}

// Block decorations (tables, HTML blocks) can only come from a StateField, not a
// ViewPlugin — so the WYSIWYG decorations are produced here and exposed via the
// `EditorView.decorations` facet.
const schemaChanged = StateEffect.define<null>();
const wysiwygField = StateField.define<DecorationSet>({
	create(state) {
		return buildDecorations(state);
	},
	update(decos, tr) {
		// Rebuild on doc changes, cursor moves, and schema swaps — the reveal/dim of
		// markers depends on the cursor, and the chip rows depend on the schema.
		if (tr.docChanged || tr.selection || tr.effects.some(e => e.is(schemaChanged))) {
			return buildDecorations(tr.state);
		}
		return decos.map(tr.changes);
	},
	provide: f => EditorView.decorations.from(f)
});

// ---------------------------------------------------------------------------
// Heading metadata atomicity — a `<!-- drip hN -->` comment belongs to the
// heading directly above it and is never editable by the user's keystrokes.
// Three pieces work together (all below):
//
//  1. `protectDripComments` — a change filter that suppresses any direct document
//     change touching a drip comment/header line (or its adjacent newlines), so
//     Backspace, Delete, Enter, typing, and paste can never split, merge, or edit
//     a comment. The chip UI and the host sync rewrite these lines with
//     `filter: false` dispatches, which opt out of the filter.
//  2. `protectDripCursor` — a transaction filter that re-maps the caret so it
//     never rests on a comment line.
//  3. `atomicHeadingEnter` — the one keymap handler, because it must re-route
//     rather than block: Enter at the end of a heading lands below its comment.
// ---------------------------------------------------------------------------

/** The line number of the drip heading comment directly below `headingLineNo`
 * (0 when there is none). */
function dripCommentLineBelow(doc: Text, headingLineNo: number): number {
	const nextNo = headingLineNo + 1;
	if (nextNo > doc.lines) return 0;
	return isHeadingCommentLine(doc.line(nextNo).text) ? nextNo : 0;
}

/** The start-of-line position of the line after `lineNo` (or EOF). */
function lineStartAfter(doc: Text, lineNo: number): number {
	return lineNo < doc.lines ? doc.line(lineNo + 1).from : doc.length;
}

/** A single empty caret (no selection and no multi-cursor). */
function isLoneCaret(state: EditorState): boolean {
	return state.selection.ranges.length === 1 && state.selection.main.empty;
}

/**
 * Ranges that must never be edited directly: every drip heading-comment line and
 * the `<!-- drip-file -->` header line, each extended by one position on both
 * sides so the adjacent newlines (the heading↔comment and comment↔body seams)
 * are protected too. Lines are walked in order, so the ranges come out sorted
 * and are merged here for the filter.
 */
function protectedDripCommentRanges(doc: Text): number[] {
	const pairs: [number, number][] = [];
	for (let i = 1; i <= doc.lines; i++) {
		const line = doc.line(i);
		if (!isHeadingCommentLine(line.text) && !isFileHeaderCommentLine(line.text)) continue;
		const from = Math.max(0, line.from - 1);
		const to = Math.min(doc.length, line.to + 1);
		if (to > from) pairs.push([from, to]);
	}
	const out: number[] = [];
	for (const [s, e] of pairs) {
		if (out.length && s <= out[out.length - 1]) {
			out[out.length - 1] = Math.max(out[out.length - 1], e);
		} else {
			out.push(s, e);
		}
	}
	return out;
}

/** Suppress any direct document change that would touch a drip comment/header
 * line (or its adjacent newlines). Returning the protected ranges drops just
 * those changes; everything else in the document stays editable. */
const protectDripComments = EditorState.changeFilter.of(tr => {
	if (!tr.docChanged) return true;
	const ranges = protectedDripCommentRanges(tr.startState.doc);
	return ranges.length ? ranges : true;
});

/**
 * Clamp a cursor position so it never rests on a drip comment/header line.
 * Moving down/forward jumps to the start of the line after the comment; moving
 * up/backward (or a stationary click) lands at the end of the line above.
 */
function clampDripCursorPosition(doc: Text, oldHead: number, pos: number): number {
	const line = doc.lineAt(Math.max(0, Math.min(pos, doc.length)));
	if (!isHeadingCommentLine(line.text) && !isFileHeaderCommentLine(line.text)) return pos;
	if (oldHead < pos) {
		const nextNo = line.number + 1;
		return nextNo <= doc.lines ? doc.line(nextNo).from : doc.length;
	}
	return Math.max(0, line.from - 1);
}

/** Re-map any explicit selection change so the caret never lands on the chip row
 * (or the file banner). Returning the same transaction when nothing moved onto a
 * comment line leaves every other selection change untouched. */
const protectDripCursor = EditorState.transactionFilter.of(tr => {
	const sel = tr.selection;
	if (!sel) return tr;
	const doc = tr.startState.doc;
	const oldHead = tr.startState.selection.main.head;
	let changed = false;
	const ranges = sel.ranges.map(r => {
		const head = clampDripCursorPosition(doc, oldHead, r.head);
		if (head === r.head) return r;
		changed = true;
		return EditorSelection.range(r.anchor, head);
	});
	if (!changed) return tr;
	return { selection: EditorSelection.create(ranges, sel.mainIndex) };
});

/** Enter at the very end of a heading lands below its comment (keeping the two
 * together) instead of splitting a blank line between them. */
const atomicHeadingEnter = {
	key: 'Enter',
	run: (view: EditorView) => {
		const { state } = view;
		if (!isLoneCaret(state)) return false;
		const head = state.selection.main.head;
		const line = state.doc.lineAt(head);
		if (head !== line.to || !isHeadingLine(line.text)) return false;
		const commentNo = dripCommentLineBelow(state.doc, line.number);
		if (!commentNo) return false;

		const afterNo = commentNo + 1;
		const blankBelow = afterNo <= state.doc.lines && state.doc.line(afterNo).text.trim() === '';
		if (blankBelow) {
			// A blank line already separates the comment from the body — land on it.
			view.dispatch({ selection: EditorSelection.cursor(state.doc.line(afterNo).from) });
		} else {
			const at = lineStartAfter(state.doc, commentNo);
			view.dispatch({
				changes: { from: at, to: at, insert: '\n' },
				selection: EditorSelection.cursor(at + 1)
			});
		}
		return true;
	}
};

let view: EditorView | null = null;
let suppressEdit = false;
let initialContentLoaded = false;

function buildExtensions() {
	return [
		EditorView.lineWrapping,
		highlightActiveLine(),
		history(),
		drawSelection(),
		dropCursor(),
		foldGutterExtension,
		foldHoverPlugin,
		codeFolding(),
		markdown({ base: markdownLanguage }),
		// 4-space indent — the markdown standard for nested lists.
		indentUnit.of('    '),
		keymap.of([atomicHeadingEnter, ...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithRenumber]),
		protectDripComments,
		protectDripCursor,
		wysiwygField,
		EditorView.theme({
			'&': {
				height: '100%',
				backgroundColor: 'var(--vscode-editor-background)',
				color: 'var(--vscode-editor-foreground)'
			},
			'.cm-scroller': {
				lineHeight: '1.5',
				fontFamily: 'var(--vscode-editor-font-family)',
				fontSize: 'var(--vscode-editor-font-size)'
			},
			'.cm-content': {
				caretColor: 'var(--vscode-editorCursor-foreground)'
			},
			'.cm-cursor, .cm-dropCursor': {
				borderLeftColor: 'var(--vscode-editorCursor-foreground)',
				borderLeftWidth: '2px'
			},
			'.cm-gutters': {
				backgroundColor: 'var(--vscode-editorGutter-background, var(--vscode-editor-background))',
				color: 'var(--vscode-editorLineNumber-foreground)',
				border: 'none',
				borderRadius: '0'
			},
			'.cm-foldGutter': {
				backgroundColor: 'transparent',
				border: 'none'
			},
			'.cm-activeLine': {
				// Translucent so the selection (drawn behind the text) stays visible — an
				// opaque line highlight would cover it. Mirrors the CSS rule.
				backgroundColor: 'color-mix(in srgb, var(--vscode-editor-lineHighlightBackground) 40%, transparent)'
			},
			'.cm-activeLineGutter': {
				backgroundColor: 'var(--vscode-editor-lineHighlightBackground)'
			},
			'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
				backgroundColor: 'var(--vscode-editor-selectionBackground) !important'
			}
		}),
		EditorView.updateListener.of(update => {
			if (!update.docChanged) return;
			const next = update.state.doc.toString();
			// Suppress echoing back a change we just applied from an incoming 'update'.
			if (!suppressEdit) {
				vscode.postMessage({ type: 'edit', text: next });
			}
		})
	];
}

function focusEditor() {
	if (view) view.focus();
}

/** Normalize CRLF/CR line endings to LF so host echoes compare equal to the editor text. */
function normalizeNewlines(s: string): string {
	return s.replace(/\r\n?/g, '\n');
}

/**
 * Set the editor's document. When placing the caret at the end, use CodeMirror's own
 * document length (not the raw string length) — the two differ for CRLF files because
 * CodeMirror normalizes `\r\n` to `\n`, and using the string length throws
 * "Selection points outside of document".
 */
function setDocument(text: string, placeCaretAtEnd = false) {
	if (!view) {
		view = new EditorView({
			parent: root,
			state: EditorState.create({
				doc: text,
				extensions: buildExtensions()
			})
		});
		if (placeCaretAtEnd) {
			view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
		}
		return;
	}

	// Skip identical echoes (line endings normalized) so the caret and scroll position
	// stay put while typing — this is what stops the jump-to-top on every keystroke.
	if (normalizeNewlines(text) === view.state.doc.toString() && !placeCaretAtEnd) {
		return;
	}

	// A genuine content change (external edit or first-load sync). Replace the text but
	// keep the caret at its current offset (clamped), never mapped back to position 0.
	// The `committing` guard stops a cell `blur` that fires when the table rebuilds from
	// dispatching again mid-update (which crashes with an update-in-progress error).
	const caret = view.state.selection.main.head;
	suppressEdit = true;
	committing = true;
	try {
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: text },
			filter: false
		});
	} finally {
		committing = false;
	}
	suppressEdit = false;
	const target = placeCaretAtEnd ? view.state.doc.length : Math.min(caret, view.state.doc.length);
	view.dispatch({ selection: EditorSelection.cursor(target) });
}

// Seed the editor with the document text the host embedded in the page, so the first
// render never depends on a postMessage round-trip. Then request a live sync for
// subsequent changes.
const seedText = readSeedText();
schema = readSeedSchema();
setDocument(seedText, seedText.length > 0);
initialContentLoaded = seedText.length > 0;
vscode.postMessage({ type: 'ready' });

window.addEventListener('message', event => {
	const msg = event.data || {};
	if (msg.type === 'update') {
		if (!initialContentLoaded) {
			initialContentLoaded = true;
			setDocument(String(msg.text || ''), true);
			focusEditor();
		} else {
			setDocument(String(msg.text || ''));
		}
	} else if (msg.type === 'schema') {
		// Settings changed in DRIP — swap the schema and re-render the chips.
		schema = {
			types: Array.isArray(msg.types) ? msg.types : [],
			allowedRelations: Array.isArray(msg.allowedRelations) ? msg.allowedRelations : []
		};
		if (view) view.dispatch({ effects: schemaChanged.of(null) });
	} else if (msg.type === 'focus') {
		focusEditor();
	} else if (msg.type === 'tags-list') {
		// Tags for the note's graph arrived — refresh the open tags list if still up.
		cachedTags = Array.isArray(msg.tags) ? msg.tags.map((t: unknown) => String(t)) : [];
		if (tagsListRerender) tagsListRerender();
	} else if (msg.type === 'tags-search') {
		// Semantic matches for the current query arrived — ignore stale responses, then
		// refresh the open tags list.
		if (String(msg.query || '') !== tagsSearchQuery) return;
		tagsSemantic = Array.isArray(msg.semantic) ? msg.semantic.map((t: unknown) => String(t)) : [];
		if (tagsListRerender) tagsListRerender();
	} else if (msg.type === 'resolved-image') {
		const src = String(msg.src || '');
		const uri = String(msg.uri || '');
		if (uri) imageUriCache.set(src, uri);
		const waiters = imageWaiters.get(src) || [];
		imageWaiters.delete(src);
		if (!uri) return; // unresolved — leave placeholders as-is
		for (const el of waiters) {
			el.className = 'md-image-wrap';
			el.textContent = '';
			el.appendChild(buildImageElement(uri, el.dataset.alt || '', Number(el.dataset.from) || 0, Number(el.dataset.to) || 0));
		}
	} else if (msg.type === 'request-selection') {
		// The host's capture command needs this webview's CodeMirror selection (the
		// custom editor has no `activeTextEditor`). Report all non-empty ranges joined
		// with a newline, matching the text editor's multi-selection join.
		let text = '';
		if (view) {
			const parts: string[] = [];
			for (const r of view.state.selection.ranges) {
				if (r.empty) continue;
				parts.push(view.state.sliceDoc(r.from, r.to));
			}
			text = parts.join('\n');
		}
		vscode.postMessage({ type: 'selection-response', text });
	} else if (msg.type === 'delete-selection') {
		// Cut the current selection (the capture command already copied it to the clipboard).
		// `captureLength` limits the cut to a leading prefix so text above the captured
		// subtree is left in place.
		if (view) {
			const ranges = view.state.selection.ranges.filter(r => !r.empty);
			if (ranges.length) {
				const captureLength = typeof msg.captureLength === 'number' && msg.captureLength >= 0 ? msg.captureLength : -1;
				const changes = ranges.map((r, idx) => {
					if (captureLength >= 0 && idx === 0) {
						return { from: r.from, to: Math.min(r.to, r.from + captureLength) };
					}
					return { from: r.from, to: r.to };
				});
				view.dispatch({
					changes,
					selection: EditorSelection.cursor(ranges[0].from),
					filter: false
				});
			}
		}
	}
});
