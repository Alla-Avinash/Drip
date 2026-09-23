(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	let currentDraftId = '';
	let noteDebounce = null;

	const titleEl = document.getElementById('heading-title');
	const metadataEl = document.getElementById('metadata');
	const bodyEl = document.getElementById('body');
	const statusEl = document.getElementById('status');
	const errorEl = document.getElementById('error');
	const selectKbBtn = document.getElementById('select-kb');
	const newNoteBtn = document.getElementById('new-note');
	const deleteDraftBtn = document.getElementById('delete-draft');
	const kbRootEl = document.getElementById('kb-root');

	function updateDeleteVisibility() {
		deleteDraftBtn.hidden = !currentDraftId;
	}

	/**
	 * Ingest title is the text after `#` on the heading line (Storage wraps with `# `).
	 * Accepts either `# .c Foo` or `.c Foo` or plain `Foo`.
	 */
	function ingestTitleFromField() {
		const raw = String(titleEl.value || '').trim();
		const m = raw.match(/^#{1,6}\s+(.*)$/);
		return m ? String(m[1] || '').trim() : raw;
	}

	/** Persist title / metadata / body as three fields (content = body only). */
	function notePayload() {
		const ingestTitle = ingestTitleFromField();
		return {
			id: currentDraftId,
			title: ingestTitle,
			headings: ingestTitle,
			metadata: String(metadataEl.value || ''),
			content: String(bodyEl.value || ''),
			metadataFilename: ingestTitle
		};
	}

	function pushNoteSnapshot() {
		clearTimeout(noteDebounce);
		noteDebounce = setTimeout(function () {
			vscode.postMessage({ type: 'noteSnapshot', note: notePayload() });
		}, 300);
	}

	function applyFields(title, metadata, content) {
		titleEl.value = title || '';
		metadataEl.value = metadata || '';
		bodyEl.value = content || '';
	}

	function resetForm() {
		currentDraftId = '';
		applyFields('', '', '');
		statusEl.textContent = '';
		errorEl.textContent = '';
		updateDeleteVisibility();
	}

	titleEl.addEventListener('input', pushNoteSnapshot);
	metadataEl.addEventListener('input', pushNoteSnapshot);
	bodyEl.addEventListener('input', pushNoteSnapshot);

	document.getElementById('save-draft').addEventListener('click', () => {
		statusEl.textContent = '';
		errorEl.textContent = '';
		vscode.postMessage({ type: 'saveDraft', note: notePayload() });
	});

	newNoteBtn.addEventListener('click', () => {
		resetForm();
		vscode.postMessage({ type: 'composerNewNote' });
		vscode.postMessage({ type: 'noteSnapshot', note: notePayload() });
	});

	deleteDraftBtn.addEventListener('click', () => {
		if (!currentDraftId) return;
		statusEl.textContent = '';
		errorEl.textContent = '';
		vscode.postMessage({ type: 'deleteDraft', draftId: currentDraftId });
	});

	document.getElementById('ingest-note').addEventListener('click', () => {
		statusEl.textContent = '';
		errorEl.textContent = '';
		vscode.postMessage({ type: 'ingestNote', note: notePayload() });
	});

	document.getElementById('select-kb').addEventListener('click', () => {
		statusEl.textContent = '';
		errorEl.textContent = '';
		vscode.postMessage({ type: 'selectKnowledgeBase', noteId: currentDraftId });
	});

	window.addEventListener('message', event => {
		const message = event.data;

		if (message.type === 'composerState') {
			const state = message.state;
			currentDraftId = state.draft.id || '';
			updateDeleteVisibility();
			kbRootEl.textContent = state.kbRootPath
				? 'Knowledge base: ' + state.kbRootPath
				: 'Knowledge base: not selected';
			selectKbBtn.textContent = state.kbRootPath ? 'Change Knowledge Base' : 'Select Knowledge Base Folder';
			statusEl.textContent = state.statusMessage || '';
			errorEl.textContent = '';

			if (state.capture) {
				currentDraftId = '';
				updateDeleteVisibility();
				applyFields(state.capture.title, state.capture.metadata, state.capture.content);
				if (!statusEl.textContent) statusEl.textContent = 'Selection captured.';
			} else {
				const draftTitle = state.draft.title || '';
				const headingLine = draftTitle
					? /^#{1,6}\s/.test(draftTitle)
						? draftTitle
						: `# ${draftTitle}`
					: '';
				applyFields(headingLine, state.draft.metadata || '', state.draft.content || '');
			}
			pushNoteSnapshot();
		}

		if (message.type === 'capturedSelection') {
			currentDraftId = '';
			updateDeleteVisibility();
			applyFields(message.title, message.metadata, message.content);
			errorEl.textContent = '';
			statusEl.textContent = 'Selection captured.';
			pushNoteSnapshot();
		}

		if (message.type === 'operationError') {
			errorEl.textContent = message.message || 'Unknown error';
		}
	});

	updateDeleteVisibility();
	vscode.postMessage({ type: 'requestState' });
})();
