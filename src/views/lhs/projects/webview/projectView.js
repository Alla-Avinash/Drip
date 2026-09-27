// @ts-check
(function () {
	const vscode = acquireVsCodeApi();
	/** @type {any[]} */
	let projects = [];
	let selectedPrefix = '';
	let selectedTitle = '';
	/** @type {{ features: any[], issues: any[] }} */
	let detail = { features: [], issues: [] };
	let detailLoading = false;

	/** @type {{ parentIssueId: string, label: string } | null} */
	let compose = null;

	const kbMeta = document.getElementById('kbMeta');
	const root = document.getElementById('root');
	const btnRefresh = document.getElementById('btnRefresh');

	if (!kbMeta || !root || !btnRefresh) {
		return;
	}

	btnRefresh.addEventListener('click', function () {
		vscode.postMessage({ type: 'refresh' });
	});

	/**
	 * @param {string} [parentIssueId]
	 */
	function openCompose(parentIssueId) {
		const parent = String(parentIssueId || '').trim();
		compose = {
			parentIssueId: parent,
			label: parent ? 'Sub-issue under ' + parent : 'New issue'
		};
		render();
		const input = document.getElementById('composeTitle');
		if (input) {
			input.focus();
			input.select();
		}
	}

	function closeCompose() {
		compose = null;
		render();
	}

	function submitCompose() {
		if (!compose || !selectedPrefix) return;
		const input = document.getElementById('composeTitle');
		const title = input ? String(input.value || '').trim() : '';
		if (!title) {
			if (input) input.focus();
			return;
		}
		const parentIssueId = compose.parentIssueId || '';
		compose = null;
		vscode.postMessage({
			type: 'createIssue',
			folderPrefix: selectedPrefix,
			parentIssueId: parentIssueId || undefined,
			title: title
		});
		detailLoading = true;
		render();
	}

	/**
	 * @returns {string}
	 */
	function renderComposeForm() {
		if (!compose) return '';
		return (
			'<div class="compose" id="composeBox">' +
			'<label class="compose-label" for="composeTitle">' +
			esc(compose.label) +
			'</label>' +
			'<div class="compose-row">' +
			'<input type="text" id="composeTitle" placeholder="Short problem statement" autocomplete="off" />' +
			'<div class="compose-actions">' +
			'<button type="button" id="composeSubmit">Create</button>' +
			'<button type="button" class="ghost" id="composeCancel">Cancel</button>' +
			'</div></div></div>'
		);
	}

	function bindCompose() {
		const submit = document.getElementById('composeSubmit');
		const cancel = document.getElementById('composeCancel');
		const input = document.getElementById('composeTitle');
		if (submit) submit.addEventListener('click', submitCompose);
		if (cancel) cancel.addEventListener('click', closeCompose);
		if (input) {
			input.addEventListener('keydown', function (e) {
				if (e.key === 'Enter') {
					e.preventDefault();
					submitCompose();
				} else if (e.key === 'Escape') {
					e.preventDefault();
					closeCompose();
				}
			});
		}
	}

	/**
	 * @param {unknown} s
	 */
	function esc(s) {
		return String(s || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	/**
	 * @param {string|null} path
	 * @param {number} fileId
	 * @param {number} headingId
	 * @param {string|null} title
	 */
	function openHeading(path, fileId, headingId, title) {
		vscode.postMessage({
			type: 'openHeading',
			path: path,
			fileId: fileId,
			headingId: headingId,
			title: title
		});
	}

	/**
	 * @param {any} issue
	 * @param {number} depth
	 */
	function renderIssueRow(issue, depth) {
		const d = Math.max(0, Number(depth) || 0);
		return (
			'<div class="issue" style="padding-left:' +
			(12 + d * 16) +
			'px" data-path="' +
			esc(issue.path) +
			'" data-fid="' +
			issue.fileId +
			'" data-hid="' +
			issue.headingId +
			'" data-title="' +
			esc(issue.title) +
			'" data-ikey="' +
			esc(issue.issueKey || '') +
			'">' +
			'<span class="name">' +
			esc(issue.title) +
			'</span>' +
			'<span class="pill">' +
			esc(issue.priority || '') +
			'</span>' +
			'<span class="pill">' +
			esc(issue.status || '') +
			'</span>' +
			'<button type="button" class="ghost issue-assign" data-ikey="' +
			esc(issue.issueKey || '') +
			'" title="Send to feature">Assign</button>' +
			'<button type="button" class="ghost issue-sub" data-ikey="' +
			esc(issue.issueKey || '') +
			'" title="New sub-issue">Sub</button>' +
			'</div>'
		);
	}

	/**
	 * Issue tree from parentIssueKey (i-N) only — not outline indent.
	 * @param {any[]} list
	 */
	function renderIssueForest(list) {
		if (!list || !list.length) return '<div class="muted-block">No issues.</div>';
		/** @type {Map<string, any>} */
		const byIssueKey = new Map();
		for (let i = 0; i < list.length; i++) {
			const item = list[i];
			if (item.issueKey) byIssueKey.set(String(item.issueKey).toLowerCase(), item);
		}
		/** @type {Map<string, any[]>} */
		const children = new Map();
		/** @type {any[]} */
		const roots = [];
		/**
		 * @param {any} node
		 */
		function childBucketKey(node) {
			return node.issueKey
				? 'ik:' + String(node.issueKey).toLowerCase()
				: 'fh:' + node.fileId + ':' + node.headingId;
		}
		for (let j = 0; j < list.length; j++) {
			const iss = list[j];
			/** @type {any} */
			let parentNode = null;
			if (iss.parentIssueKey && byIssueKey.has(String(iss.parentIssueKey).toLowerCase())) {
				parentNode = byIssueKey.get(String(iss.parentIssueKey).toLowerCase());
			}
			if (parentNode && parentNode !== iss) {
				const pk = childBucketKey(parentNode);
				if (!children.has(pk)) children.set(pk, []);
				children.get(pk).push(iss);
			} else {
				roots.push(iss);
			}
		}
		/**
		 * @param {any} node
		 * @param {number} depth
		 */
		function walk(node, depth) {
			let html = renderIssueRow(node, depth);
			const kids = children.get(childBucketKey(node)) || [];
			for (let k = 0; k < kids.length; k++) html += walk(kids[k], depth + 1);
			return html;
		}
		let out = '';
		for (let r = 0; r < roots.length; r++) out += walk(roots[r], 0);
		return out;
	}

	/**
	 * @param {ParentNode} container
	 */
	function bindIssues(container) {
		container.querySelectorAll('.issue').forEach(function (el) {
			el.addEventListener('click', function () {
				openHeading(
					el.getAttribute('data-path'),
					Number(el.getAttribute('data-fid')),
					Number(el.getAttribute('data-hid')),
					el.getAttribute('data-title')
				);
			});
		});
	}

	function renderProjectList() {
		if (!projects.length) {
			root.innerHTML =
				'<p class="page-title">Projects</p>' +
				'<p class="page-sub">No project folders (.p) in the index yet. Create a project and reindex.</p>';
			return;
		}
		const cards = projects
			.map(function (p) {
				const sub = [p.status, p.path].filter(Boolean).join(' · ');
				return (
					'<button type="button" class="proj-card" data-prefix="' +
					esc(p.folderPrefix) +
					'" data-path="' +
					esc(p.path) +
					'" data-title="' +
					esc(p.title) +
					'">' +
					'<span class="title">' +
					esc(p.title) +
					'</span>' +
					(sub ? '<span class="sub">' + esc(sub) + '</span>' : '') +
					'</button>'
				);
			})
			.join('');
		root.innerHTML =
			'<p class="page-title">Projects</p>' +
			'<p class="page-sub">Click a project to open its features and issues.</p>' +
			'<div class="proj-grid">' +
			cards +
			'</div>';
		root.querySelectorAll('.proj-card').forEach(function (btn) {
			btn.addEventListener('click', function () {
				selectedPrefix = btn.getAttribute('data-prefix') || '';
				selectedTitle = btn.getAttribute('data-title') || '';
				detail = { features: [], issues: [] };
				detailLoading = true;
				render();
				vscode.postMessage({
					type: 'selectProject',
					folderPrefix: selectedPrefix,
					path: btn.getAttribute('data-path')
				});
			});
		});
	}

	function renderProjectDetail() {
		const title = selectedTitle || selectedPrefix.replace(/\/+$/, '') || 'Project';
		const features = detail.features || [];
		const issues = detail.issues || [];
		const inbox = issues.filter(function (i) {
			return i.inProjectInbox;
		});
		const elsewhere = issues.filter(function (i) {
			return !i.inProjectInbox;
		});

		let html = '';
		html +=
			'<div class="toolbar">' +
			'<button type="button" class="ghost" id="btnBack">← Projects</button>' +
			'<h2>' +
			esc(title) +
			'</h2>' +
			'<button type="button" id="btnNewIssue">New issue</button>' +
			'</div>';

		if (detailLoading) {
			html += '<div class="empty">Loading features and issues…</div>';
			root.innerHTML = html;
			const back = document.getElementById('btnBack');
			if (back) back.addEventListener('click', goBack);
			return;
		}

		html +=
			'<div class="section"><div class="section-head"><h3>Project issues (_issues)</h3><span class="count">' +
			inbox.length +
			'</span></div>';
		html += renderComposeForm();
		html +=
			'<div class="card"><div>' +
			(inbox.length
				? renderIssueForest(inbox)
				: '<div class="muted-block">No inbox issues yet. Use New issue above.</div>') +
			'</div></div></div>';

		html +=
			'<div class="section"><div class="section-head"><h3>Features</h3><span class="count">' +
			features.length +
			'</span></div>';
		if (!features.length) {
			html +=
				'<div class="card"><div class="muted-block">No .f features yet. Create a feature folder under this project.</div></div>';
		} else {
			features.forEach(function (f) {
				const childIssues = elsewhere.filter(function (i) {
					return (
						i.featurePathPrefix &&
						(i.featurePathPrefix === f.folderPrefix || i.featurePathPrefix === f.path)
					);
				});
				html += '<details class="card" open>';
				html +=
					'<summary><span class="chip">' +
					(f.isFolderIndex ? 'folder' : 'file') +
					'</span> ' +
					'<button type="button" class="linkish feat-open" data-path="' +
					esc(f.path) +
					'" data-fid="' +
					f.fileId +
					'" data-hid="' +
					f.headingId +
					'" data-title="' +
					esc(f.title) +
					'">' +
					esc(f.title) +
					'</button>' +
					'<span class="count">' +
					childIssues.length +
					' issues</span></summary>';
				html +=
					'<div>' +
					(childIssues.length
						? renderIssueForest(childIssues)
						: '<div class="muted-block">No issues in this feature yet.</div>') +
					'</div>';
				html += '</details>';
			});
		}
		html += '</div>';

		root.innerHTML = html;
		const backBtn = document.getElementById('btnBack');
		if (backBtn) backBtn.addEventListener('click', goBack);
		const btnNew = document.getElementById('btnNewIssue');
		if (btnNew) {
			btnNew.addEventListener('click', function () {
				openCompose('');
			});
		}
		bindCompose();
		root.querySelectorAll('.feat-open').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				openHeading(
					btn.getAttribute('data-path'),
					Number(btn.getAttribute('data-fid')),
					Number(btn.getAttribute('data-hid')),
					btn.getAttribute('data-title')
				);
			});
		});
		bindIssues(root);
		root.querySelectorAll('.issue-sub').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				const parentId = btn.getAttribute('data-ikey') || '';
				if (!parentId) return;
				openCompose(parentId);
			});
		});
		root.querySelectorAll('.issue-assign').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				const ikey = btn.getAttribute('data-ikey') || '';
				if (!ikey) return;
				vscode.postMessage({
					type: 'assignIssue',
					folderPrefix: selectedPrefix,
					issueId: ikey
				});
			});
		});
	}

	function goBack() {
		selectedPrefix = '';
		selectedTitle = '';
		detail = { features: [], issues: [] };
		detailLoading = false;
		compose = null;
		vscode.postMessage({ type: 'clearProject' });
		render();
	}

	function render() {
		if (selectedPrefix) renderProjectDetail();
		else renderProjectList();
	}

	window.addEventListener('message', function (event) {
		const msg = event.data || {};
		if (msg.type === 'projects') {
			projects = msg.projects || [];
			kbMeta.textContent = msg.kbLabel || '';
			if (
				selectedPrefix &&
				!projects.some(function (p) {
					return p.folderPrefix === selectedPrefix;
				})
			) {
				selectedPrefix = '';
				selectedTitle = '';
				detail = { features: [], issues: [] };
				detailLoading = false;
			}
			render();
		}
		if (msg.type === 'projectDetail') {
			detail = { features: msg.features || [], issues: msg.issues || [] };
			selectedPrefix = msg.folderPrefix || selectedPrefix;
			detailLoading = false;
			compose = null;
			if (selectedPrefix) {
				const match = projects.find(function (p) {
					return p.folderPrefix === selectedPrefix;
				});
				if (match) selectedTitle = match.title || selectedTitle;
			}
			render();
		}
		if (msg.type === 'error') {
			kbMeta.textContent = msg.message || 'Error';
			detailLoading = false;
			if (!projects.length) {
				root.innerHTML =
					'<p class="page-title">Projects</p>' +
					'<p class="page-sub">' +
					esc(msg.message || 'Failed to load projects') +
					'</p>';
			} else {
				render();
			}
		}
	});

	kbMeta.textContent = 'Connecting…';
	vscode.postMessage({ type: 'ready' });
})();
