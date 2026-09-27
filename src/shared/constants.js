'use strict';

const DRIP_PANEL_ID = 'drip.composer';
/** Editor-area webview panel for the tag graph */
const DRIP_TAGS_GRAPH_PANEL_ID = 'drip.tagsGraph';
/** Editor-area webview panel for DRIP Retriever */
const DRIP_RETRIEVER_PANEL_ID = 'drip.retriever';
/** Editor-area webview panel for Project View (Linear-style) */
const DRIP_PROJECT_VIEW_PANEL_ID = 'drip.projectView';
/** Separate editor panel for a tag with many sub-tags (≥ threshold) */
const DRIP_SUBGRAPH_PANEL_ID = 'drip.subGraphEditor';
const DRIP_COMPONENTS_VIEW_ID = 'drip.components';
const DRIP_KB_VIEW_ID = 'drip.knowledgeBase';
const DRIP_DRAFTS_VIEW_ID = 'drip.drafts';
const DRIP_RECENTS_VIEW_ID = 'drip.recents';
/** @deprecated alias for DRIP_KB_VIEW_ID */
const DRIP_VIEW_ID = DRIP_KB_VIEW_ID;
/** @deprecated merged into separate section views */
const DRIP_SIDEBAR_VIEW_ID = DRIP_KB_VIEW_ID;
const DRIP_SETTINGS_VIEW_ID = 'drip.settings';
const DRIP_STORAGE_VIEW_ID = 'drip.storage';
/** RHS secondary-sidebar: persistent heading form editor */
const DRIP_HEADING_FORM_VIEW_ID = 'drip.headingForm';
const DRIP_COMMAND_ID = 'drip.openComposer';
const DRIP_OPEN_KB_EDITOR_COMMAND_ID = 'drip.openKbEditor';
const DRIP_CAPTURE_SELECTION_COMMAND_ID = 'drip.captureSelectionToComposer';
const DRIP_SELECT_KB_COMMAND_ID = 'drip.selectKnowledgeBase';
const DRIP_OPEN_RECENT_FILE_COMMAND_ID = 'drip.openRecentFile';
const DRIP_DAILY_NOTES_VIEW_ID = 'drip.dailyNotes';
const DRIP_OPEN_TODAY_DAILY_NOTE_COMMAND_ID = 'drip.openTodayDailyNote';
/** KB-root folder for daily notes (hidden from Knowledge Base tree). */
const DAILY_NOTES_DIR = 'dailynotes.drip';
const DRAFTS_KEY = 'drip.drafts';
const KB_ROOT_KEY = 'drip.kbRoot';
/** Workspace-scoped list of recently opened/modified dripnote files (max 10). */
const RECENTS_KEY = 'drip.recentFiles';
const RECENTS_MAX = 10;
/** Workspace-scoped persisted Retriever filter/display UI (excluding row pagination). */
const RETRIEVER_UI_STATE_KEY = 'drip.retrieverUiPersist_v1';
const NOTE_EXTENSION = '.d.txt';
const KB_EDITOR_NOTE_FILENAME = '.Editor.d.txt';

module.exports = {
	DRIP_PANEL_ID,
	DRIP_TAGS_GRAPH_PANEL_ID,
	DRIP_RETRIEVER_PANEL_ID,
	DRIP_PROJECT_VIEW_PANEL_ID,
	DRIP_SUBGRAPH_PANEL_ID,
	DRIP_COMPONENTS_VIEW_ID,
	DRIP_KB_VIEW_ID,
	DRIP_DRAFTS_VIEW_ID,
	DRIP_RECENTS_VIEW_ID,
	DRIP_SIDEBAR_VIEW_ID,
	DRIP_VIEW_ID,
	DRIP_SETTINGS_VIEW_ID,
	DRIP_STORAGE_VIEW_ID,
	DRIP_HEADING_FORM_VIEW_ID,
	DRIP_COMMAND_ID,
	DRIP_OPEN_KB_EDITOR_COMMAND_ID,
	DRIP_CAPTURE_SELECTION_COMMAND_ID,
	DRIP_SELECT_KB_COMMAND_ID,
	DRIP_OPEN_RECENT_FILE_COMMAND_ID,
	DRIP_DAILY_NOTES_VIEW_ID,
	DRIP_OPEN_TODAY_DAILY_NOTE_COMMAND_ID,
	DAILY_NOTES_DIR,
	DRAFTS_KEY,
	KB_ROOT_KEY,
	RECENTS_KEY,
	RECENTS_MAX,
	RETRIEVER_UI_STATE_KEY,
	NOTE_EXTENSION,
	KB_EDITOR_NOTE_FILENAME
};
