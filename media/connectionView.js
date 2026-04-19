(function () {
  const vscode = acquireVsCodeApi();
  const tree = document.getElementById('tree');
  const ctxmenu = document.getElementById('ctxmenu');
  const filterBar = document.getElementById('filter-bar');
  const filterInput = document.getElementById('filter-input');
  const filterClear = document.getElementById('filter-clear');

  let items = [];
  // Path → full item object. Rebuilt on every incoming tree message so
  // context-menu right-clicks and row click handlers can look up the
  // item data (label, icon, description…) from just row.dataset.path.
  let itemsByPath = new Map();
  const expanded = new Set();
  let selectedPath = null;
  // Multi-select state. `selectedPaths` is the set of checked rows for
  // bulk operations; `anchorPath` is the last non-shift click's path so
  // Shift+click can select a range from there. Keeps `selectedPath`
  // (single-focus) so context menus on the hovered row keep working.
  const selectedPaths = new Set();
  let anchorPath = null;
  // Keyboard focus — distinct from selection. The tree is the tabstop; the
  // focused row is announced via aria-activedescendant and visually marked
  // with .focused. Screen readers get per-row announcements without us
  // having to call .focus() on DOM children.
  let focusedPath = null;
  let filterQuery = '';

  /** Stable, HTML-id-safe handle for a path. Used for aria-activedescendant. */
  function rowIdFor(path) {
    // btoa + url-safe substitutions. Webviews run in a full DOM context so btoa
    // is always available. Path is utf-8 safe via unescape(encodeURIComponent(...)).
    try {
      return 'vscrt-row-' + btoa(unescape(encodeURIComponent(path))).replace(/[=/+]/g, '_');
    } catch (err) {
      console.warn('[vsCRT] rowIdFor fallback for path:', path, err);
      return 'vscrt-row-' + String(path).replace(/[^a-zA-Z0-9_-]/g, '_');
    }
  }

  // --- Rendering ---------------------------------------------------------

  function defaultCodiconFor(type) {
    if (type === 'cluster')    return 'codicon-folder';
    if (type === 'subcluster') return 'codicon-folder-library';
    return 'codicon-terminal';
  }
  function codiconClassFor(item) {
    if (item.icon && /^[a-z0-9-]+$/i.test(item.icon)) {
      return 'codicon-' + item.icon;
    }
    return defaultCodiconFor(item.type);
  }
  function buildIconElement(item) {
    const customUris = window.__vscrtCustomIcons || {};
    if (item.icon && customUris[item.icon]) {
      const img = document.createElement('img');
      img.src = customUris[item.icon];
      img.className = 'custom-icon';
      img.alt = '';
      return img;
    }
    const i = document.createElement('i');
    i.className = 'codicon ' + codiconClassFor(item);
    return i;
  }

  function lookupItem(path) {
    return itemsByPath.get(path);
  }

  function rebuildItemsByPath(list) {
    itemsByPath = new Map();
    (function walk(l) {
      for (const item of l) {
        itemsByPath.set(item.path, item);
        if (item.children && item.children.length) walk(item.children);
      }
    })(list);
  }

  /**
   * Create a <div class="row"> with all row-level event listeners attached
   * once. Inner content (chevron/icon/label/etc.) is filled in by
   * applyRowContent, which is called both here and on every later update
   * so the same DOM node can be reused across rerenders.
   *
   * Row-level handlers read from row.dataset and row.classList at fire
   * time, so reusing the element across item mutations is safe.
   */
  function createRow(item, depth) {
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'treeitem');
    row.setAttribute('draggable', 'true');

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      // Focus the tree so `#tree:focus-within .row.selected` picks up the
      // prominent active-selection background. Without this, selection
      // stays on the subtle inactiveSelectionBackground and the highlight
      // is easy to mistake for the hover state.
      tree.focus({ preventScroll: true });
      const p = row.dataset.path;
      if (e.shiftKey) {
        applyRangeSelect(p);
        setFocusedPath(p);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        applyToggleSelect(p);
        setFocusedPath(p);
        return;
      }
      clearMultiSelect();
      selectRow(p);
      setFocusedPath(p);
      if (row.classList.contains('clickable')) toggleExpand(p);
    });

    row.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const p = row.dataset.path;
      const kind = row.dataset.kind;
      if (kind === 'node') {
        invoke('connect', { path: p, type: 'node' }, { trigger: 'dblclick' });
      } else if (row.classList.contains('clickable')) {
        toggleExpand(p);
      }
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      tree.focus({ preventScroll: true });
      const p = row.dataset.path;
      if (selectedPaths.size >= 2 && selectedPaths.has(p)) {
        showBulkContextMenu(e.clientX, e.clientY);
        return;
      }
      clearMultiSelect();
      selectRow(p);
      const full = lookupItem(p);
      if (full) showContextMenu(e.clientX, e.clientY, full);
    });

    attachDragHandlers(row);

    applyRowContent(row, item, depth);
    return row;
  }

  /**
   * (Re)fill a row's inner content. Clears existing inner DOM (chevron,
   * icon, label, description, row-actions) and rebuilds it from the item.
   * Safe to call repeatedly on the same row — outer event listeners are
   * left alone, only inner-element listeners (chevron click, open-in-editor)
   * are recreated.
   */
  function applyRowContent(row, item, depth) {
    row.style.setProperty('--depth', depth);
    row.dataset.path = item.path;
    row.dataset.kind = item.type;
    row.id = rowIdFor(item.path);
    row.setAttribute('aria-level', String(depth + 1));
    const hasChildren = Array.isArray(item.children) && item.children.length > 0;
    row.classList.toggle('clickable', hasChildren);
    row.classList.toggle('selected', item.path === selectedPath);
    row.classList.toggle('focused', item.path === focusedPath);
    row.setAttribute('aria-selected', item.path === selectedPath ? 'true' : 'false');
    if (hasChildren) {
      row.setAttribute('aria-expanded', isExpanded(item.path) ? 'true' : 'false');
    } else {
      row.removeAttribute('aria-expanded');
    }
    // Composite accessible name: kind + label + description (endpoint on nodes).
    const kindLabel = item.type === 'node' ? 'server' : 'folder';
    const descPart = item.description ? `, ${item.description}` : '';
    row.setAttribute('aria-label', `${kindLabel} ${item.label}${descPart}`);

    row.innerHTML = '';

    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    if (hasChildren) {
      const glyph = document.createElement('i');
      glyph.className = 'codicon ' + (isExpanded(item.path)
        ? 'codicon-chevron-down'
        : 'codicon-chevron-right');
      chevron.appendChild(glyph);
    }
    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      if (row.classList.contains('clickable')) toggleExpand(row.dataset.path);
    });
    row.appendChild(chevron);

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.appendChild(buildIconElement(item));
    row.appendChild(icon);

    row.appendChild(renderHighlighted('label', item.label, filterQuery));

    if (item.description) {
      row.appendChild(renderHighlighted('description', item.description, filterQuery));
    }

    if (item.badge) {
      const badge = document.createElement('span');
      badge.className = 'row-badge row-badge-' + item.badge.kind;
      badge.textContent = item.badge.text;
      badge.title = item.badge.tooltip;
      row.appendChild(badge);
    }

    if (item.type === 'node') {
      const actions = document.createElement('span');
      actions.className = 'row-actions';

      const openEditor = document.createElement('button');
      openEditor.type = 'button';
      openEditor.className = 'row-action';
      // Title/label intentionally generic — location is resolved from
      // the user's `vsCRT.buttonClickTerminalLocation` setting (default
      // "editor"), so the actual destination may differ from "editor".
      openEditor.title = 'Connect (uses vsCRT.buttonClickTerminalLocation)';
      openEditor.setAttribute('aria-label', `Connect to "${item.label}"`);
      // Row container drives keyboard nav; buttons in the row shouldn't steal Tab.
      openEditor.tabIndex = -1;
      const g = document.createElement('i');
      g.className = 'codicon codicon-open-in-window';
      g.setAttribute('aria-hidden', 'true');
      openEditor.appendChild(g);
      openEditor.addEventListener('click', (e) => {
        e.stopPropagation();
        // No `location` override — `vsCRT.connect` resolves the
        // destination from the button-click setting and per-node
        // `terminalLocation` field.
        invoke(
          'connect',
          { path: row.dataset.path, type: 'node' },
          { trigger: 'button' },
        );
      });
      actions.appendChild(openEditor);

      const openSftp = document.createElement('button');
      openSftp.type = 'button';
      openSftp.className = 'row-action';
      openSftp.title = 'Open SFTP Browser\u2026';
      openSftp.setAttribute('aria-label', `Open SFTP Browser for "${item.label}"`);
      openSftp.tabIndex = -1;
      const gSftp = document.createElement('i');
      gSftp.className = 'codicon codicon-cloud-upload';
      gSftp.setAttribute('aria-hidden', 'true');
      openSftp.appendChild(gSftp);
      openSftp.addEventListener('click', (e) => {
        e.stopPropagation();
        invoke('openSftpBrowser', { path: row.dataset.path, type: 'node' });
      });
      actions.appendChild(openSftp);

      row.appendChild(actions);
    }
  }

  function isExpanded(path) {
    // During a filter, everything is force-expanded so matches are visible.
    if (filterQuery) return true;
    return expanded.has(path);
  }

  /** Flatten the (possibly filtered) tree into [{item, depth}] in render order. */
  function flatten(list, depth) {
    const out = [];
    for (const item of list) {
      out.push({ item: item, depth: depth });
      const hasKids = Array.isArray(item.children) && item.children.length > 0;
      if (hasKids && isExpanded(item.path)) {
        const sub = flatten(item.children, depth + 1);
        for (let i = 0; i < sub.length; i++) out.push(sub[i]);
      }
    }
    return out;
  }

  /**
   * Patch the DOM to match the flattened list. Rows whose paths no longer
   * appear are removed, survivors are updated in place (preserving their
   * DOM node so scroll position and row-level listeners stay live), and
   * new rows are inserted at the right position. O(n) in the list size.
   */
  function reconcile(flat) {
    const byPath = new Map();
    const rows = tree.querySelectorAll('.row');
    for (let i = 0; i < rows.length; i++) {
      byPath.set(rows[i].dataset.path, rows[i]);
    }
    const wantSet = new Set();
    for (let i = 0; i < flat.length; i++) wantSet.add(flat[i].item.path);

    byPath.forEach((row, path) => {
      if (!wantSet.has(path)) row.remove();
    });

    let cursor = tree.firstChild;
    for (let i = 0; i < flat.length; i++) {
      const entry = flat[i];
      const existing = byPath.get(entry.item.path);
      if (existing) {
        applyRowContent(existing, entry.item, entry.depth);
        if (existing !== cursor) {
          tree.insertBefore(existing, cursor);
        } else {
          cursor = cursor.nextSibling;
        }
      } else {
        const fresh = createRow(entry.item, entry.depth);
        tree.insertBefore(fresh, cursor);
      }
    }
  }

  // Cache of the most recent flattened list in render order. Keyboard nav
  // reads it to compute prev/next sibling for ArrowUp/ArrowDown.
  let lastFlat = [];

  function rerender() {
    const list = filterQuery ? filterTree(items, filterQuery) : items;
    const flat = flatten(list, 0);
    lastFlat = flat;
    reconcile(flat);
    // If the previously focused row dropped out of the visible list (e.g.
    // collapsed ancestor, filter miss), re-pin focus to the first item so
    // keyboard users always have a landing spot.
    const stillVisible = flat.some((f) => f.item.path === focusedPath);
    if (!stillVisible) {
      focusedPath = flat.length > 0 ? flat[0].item.path : null;
    }
    // Prune selection to rows that still exist after the reconcile.
    const aliveSet = new Set(flat.map((f) => f.item.path));
    for (const p of Array.from(selectedPaths)) {
      if (!aliveSet.has(p)) selectedPaths.delete(p);
    }
    if (anchorPath && !aliveSet.has(anchorPath)) {
      anchorPath = null;
    }
    updateActiveDescendant();
    repaintSelection();
    renderEmptyState(flat.length === 0 && !filterQuery);
  }

  function updateActiveDescendant() {
    if (focusedPath) {
      tree.setAttribute('aria-activedescendant', rowIdFor(focusedPath));
    } else {
      tree.removeAttribute('aria-activedescendant');
    }
  }

  // `opts.scroll = 'keyboard'` asks for scrollIntoView — only keyboard
  // handlers pass this. Mouse-driven focus changes must NOT scroll,
  // otherwise the viewport shifts between the first click and the
  // second click of a dblclick, the second click lands on a different
  // DOM element, and the browser's dblclick detection silently drops
  // the event. Callers that pass no opts (mouse clicks) get focus +
  // class toggles only.
  function setFocusedPath(path, opts) {
    if (path === focusedPath) return;
    if (focusedPath) {
      const old = tree.querySelector('.row.focused');
      if (old) old.classList.remove('focused');
    }
    focusedPath = path;
    if (path) {
      const el = document.getElementById(rowIdFor(path));
      if (el) {
        el.classList.add('focused');
        if (
          opts && opts.scroll === 'keyboard' &&
          typeof el.scrollIntoView === 'function'
        ) {
          el.scrollIntoView({ block: 'nearest' });
        }
      }
    }
    updateActiveDescendant();
  }

  function renderEmptyState(show) {
    let empty = document.getElementById('empty-state');
    if (!show) {
      if (empty) empty.remove();
      return;
    }
    if (empty) return;
    empty = document.createElement('div');
    empty.id = 'empty-state';
    // role=status + aria-live so screen readers announce the empty-state
    // on initial load, and again after the last server is deleted.
    empty.setAttribute('role', 'status');
    empty.setAttribute('aria-live', 'polite');
    empty.innerHTML =
      '<p class="empty-title">No servers yet.</p>' +
      '<p class="empty-sub">Add a folder with the <i class="codicon codicon-folder" aria-hidden="true"></i> icon above, bulk-import existing hosts, or load the example tree:</p>' +
      '<div class="empty-actions" role="group" aria-label="Get started">' +
      '<button id="empty-add-folder" class="empty-btn primary" type="button"><i class="codicon codicon-folder" aria-hidden="true"></i> Add Folder</button>' +
      '<button id="empty-import" class="empty-btn" type="button"><i class="codicon codicon-cloud-download" aria-hidden="true"></i> Import from ~/.ssh/config</button>' +
      '<button id="empty-load-example" class="empty-btn" type="button"><i class="codicon codicon-library" aria-hidden="true"></i> Load Example</button>' +
      '</div>';
    tree.appendChild(empty);
    document.getElementById('empty-add-folder').addEventListener('click', (e) => {
      e.stopPropagation();
      invoke('addCluster', null);
    });
    document.getElementById('empty-import').addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'invoke', command: 'importSshConfig' });
    });
    document.getElementById('empty-load-example').addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'invoke', command: 'loadExample' });
    });
  }

  // --- Filter -------------------------------------------------------------

  function matchesQuery(item, q) {
    const lq = q.toLowerCase();
    if (item.label && item.label.toLowerCase().indexOf(lq) !== -1) return true;
    if (item.description && item.description.toLowerCase().indexOf(lq) !== -1) return true;
    return false;
  }

  function filterTree(list, q) {
    const out = [];
    for (const item of list) {
      const childMatches = item.children
        ? filterTree(item.children, q)
        : undefined;
      const selfMatch = matchesQuery(item, q);
      if (selfMatch || (childMatches && childMatches.length > 0)) {
        out.push({
          type: item.type,
          path: item.path,
          label: item.label,
          description: item.description,
          icon: item.icon,
          children: childMatches,
        });
      }
    }
    return out;
  }

  function renderHighlighted(className, text, q) {
    const span = document.createElement('span');
    span.className = className;
    if (!q) {
      span.textContent = text;
      return span;
    }
    const lower = String(text).toLowerCase();
    const lq = q.toLowerCase();
    let from = 0;
    let idx = lower.indexOf(lq, from);
    if (idx < 0) {
      span.textContent = text;
      return span;
    }
    while (idx >= 0) {
      if (idx > from) {
        span.appendChild(document.createTextNode(text.substring(from, idx)));
      }
      const m = document.createElement('span');
      m.className = 'match';
      m.textContent = text.substring(idx, idx + q.length);
      span.appendChild(m);
      from = idx + q.length;
      idx = lower.indexOf(lq, from);
    }
    if (from < text.length) {
      span.appendChild(document.createTextNode(text.substring(from)));
    }
    return span;
  }

  function applyFilter(q) {
    filterQuery = (q || '').trim();
    if (filterQuery) {
      filterBar.classList.add('active');
    } else {
      filterBar.classList.remove('active');
    }
    rerender();
  }

  // --- Keyboard navigation ---------------------------------------------
  //
  // WAI-ARIA 1.2 treeview pattern: tree is the tab target; arrows move a
  // visible "active descendant" marker without changing focus. Expand/
  // collapse mirror what a native TreeView does. Shift+F10 / ContextMenu
  // key surface the same menu as right-click.
  //
  // The pure helper `computeNextFocusedPath` is exported on window so the
  // mocha unit suite can exercise every key without needing a DOM.

  function flatSiblings() {
    return lastFlat.map((f) => ({ path: f.item.path, hasChildren: Array.isArray(f.item.children) && f.item.children.length > 0 }));
  }

  // Exposed via window for test harness; also callable internally.
  window.__vscrtComputeNextFocusedPath = computeNextFocusedPath;

  function computeNextFocusedPath(flat, currentPath, key) {
    if (flat.length === 0) return null;
    const idx = currentPath == null
      ? -1
      : flat.findIndex((f) => f.path === currentPath);
    if (key === 'ArrowDown') {
      const next = idx < 0 ? 0 : Math.min(flat.length - 1, idx + 1);
      return flat[next].path;
    }
    if (key === 'ArrowUp') {
      const prev = idx < 0 ? flat.length - 1 : Math.max(0, idx - 1);
      return flat[prev].path;
    }
    if (key === 'Home') return flat[0].path;
    if (key === 'End')  return flat[flat.length - 1].path;
    return currentPath;
  }

  tree.addEventListener('keydown', (e) => {
    // Filter input is inside the tree's layout sibling — let it keep its own keys.
    if (e.target === filterInput) return;

    const currentItem = focusedPath ? lookupItem(focusedPath) : null;
    const hasChildren = currentItem
      && Array.isArray(currentItem.children)
      && currentItem.children.length > 0;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const nextPath = computeNextFocusedPath(flatSiblings(), focusedPath, e.key);
      if (nextPath) setFocusedPath(nextPath, { scroll: 'keyboard' });
      return;
    }

    if (e.key === 'ArrowRight') {
      if (hasChildren) {
        if (!isExpanded(focusedPath)) {
          toggleExpand(focusedPath);
        } else if (lastFlat.length > 0) {
          // Already expanded — move to first child.
          const idx = lastFlat.findIndex((f) => f.item.path === focusedPath);
          if (idx >= 0 && idx + 1 < lastFlat.length) {
            setFocusedPath(lastFlat[idx + 1].item.path, { scroll: 'keyboard' });
          }
        }
      }
      e.preventDefault();
      return;
    }

    if (e.key === 'ArrowLeft') {
      if (hasChildren && isExpanded(focusedPath)) {
        toggleExpand(focusedPath);
      } else if (focusedPath && focusedPath.indexOf('/') >= 0) {
        // Move to parent row if visible.
        const parent = focusedPath.substring(0, focusedPath.lastIndexOf('/'));
        const parentVisible = lastFlat.some((f) => f.item.path === parent);
        if (parentVisible) setFocusedPath(parent, { scroll: 'keyboard' });
      }
      e.preventDefault();
      return;
    }

    if (e.key === 'Enter') {
      if (!currentItem) return;
      selectRow(currentItem.path);
      if (currentItem.type === 'node') {
        invoke('connect', currentItem, { trigger: 'button' });
      } else if (hasChildren) {
        toggleExpand(currentItem.path);
      }
      e.preventDefault();
      return;
    }

    if (e.key === ' ' || e.key === 'Spacebar') {
      if (!currentItem) return;
      selectRow(currentItem.path);
      if (hasChildren) toggleExpand(currentItem.path);
      e.preventDefault();
      return;
    }

    // Shift+F10 or ContextMenu key — show the context menu for the focused row.
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      if (!currentItem) return;
      const el = document.getElementById(rowIdFor(currentItem.path));
      const rect = el ? el.getBoundingClientRect() : { left: 0, bottom: 0 };
      showContextMenu(rect.left + 8, rect.bottom, currentItem);
      e.preventDefault();
      return;
    }

    if (e.key === 'F2' && currentItem) {
      if (currentItem.type === 'node') {
        invoke('editServer', currentItem);
      } else {
        invoke('renameCluster', currentItem);
      }
      e.preventDefault();
      return;
    }

    if (e.key === 'Delete' && currentItem) {
      if (currentItem.type === 'node') {
        invoke('deleteNode', currentItem);
      } else {
        invoke('deleteCluster', currentItem);
      }
      e.preventDefault();
      return;
    }
  });

  filterInput.addEventListener('input', (e) => {
    applyFilter(e.target.value);
  });
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && filterInput.value) {
      filterInput.value = '';
      applyFilter('');
      e.stopPropagation();
    }
  });
  filterClear.addEventListener('click', () => {
    filterInput.value = '';
    applyFilter('');
    filterInput.focus();
  });

  function selectRow(path) {
    selectedPath = path;
    for (const el of tree.querySelectorAll('.row.selected')) {
      el.classList.remove('selected');
    }
    if (path) {
      const el = tree.querySelector('.row[data-path="' + cssEscape(path) + '"]');
      if (el) el.classList.add('selected');
    }
  }

  function cssEscape(s) {
    return String(s).replace(/(["\\])/g, '\\$1');
  }

  // --- Multi-select -------------------------------------------------------

  function flatVisiblePaths() {
    // Node-only paths in render order; bulk ops don't apply to folders.
    return lastFlat
      .filter((f) => f.item.type === 'node')
      .map((f) => f.item.path);
  }

  function applyToggleSelect(path) {
    const item = lookupItem(path);
    // Only nodes participate in bulk; toggling a folder is a no-op.
    if (!item || item.type !== 'node') return;
    if (selectedPaths.has(path)) {
      selectedPaths.delete(path);
    } else {
      selectedPaths.add(path);
    }
    anchorPath = path;
    repaintSelection();
  }

  function applyRangeSelect(path) {
    const flat = flatVisiblePaths();
    const anchor = anchorPath ?? path;
    const a = flat.indexOf(anchor);
    const b = flat.indexOf(path);
    if (a < 0 || b < 0) {
      applyToggleSelect(path);
      return;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    selectedPaths.clear();
    for (let i = lo; i <= hi; i += 1) {
      selectedPaths.add(flat[i]);
    }
    repaintSelection();
  }

  function clearMultiSelect() {
    if (selectedPaths.size === 0) return;
    selectedPaths.clear();
    anchorPath = null;
    repaintSelection();
  }

  function repaintSelection() {
    for (const el of tree.querySelectorAll('.row')) {
      const on = selectedPaths.has(el.dataset.path);
      el.classList.toggle('multi-selected', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearMultiSelect();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      // Only hijack Ctrl+A when the tree has focus and rows exist.
      if (document.activeElement === tree) {
        const all = flatVisiblePaths();
        if (all.length > 0) {
          selectedPaths.clear();
          for (const p of all) selectedPaths.add(p);
          anchorPath = all[0];
          repaintSelection();
          e.preventDefault();
        }
      }
    }
  });

  function showBulkContextMenu(x, y) {
    const count = selectedPaths.size;
    const paths = Array.from(selectedPaths);
    const entries = [
      { label: 'Connect Selected (' + count + ')', action: () => {
        post({ type: 'invoke', command: 'bulkConnect', paths });
      }},
      { label: 'Test Selected (' + count + ')', action: () => {
        post({ type: 'invoke', command: 'bulkTest', paths });
      }},
      { sep: true },
      { label: 'Delete Selected\u2026 (' + count + ')', action: () => {
        post({ type: 'invoke', command: 'bulkDelete', paths });
      }},
    ];
    populateContextMenu(entries);
    ctxmenu.classList.add('open');
    const rect = ctxmenu.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - rect.width - 4);
    const py = Math.min(y, window.innerHeight - rect.height - 4);
    ctxmenu.style.left = Math.max(0, px) + 'px';
    ctxmenu.style.top = Math.max(0, py) + 'px';
  }

  function toggleExpand(path) {
    if (filterQuery) return;
    if (expanded.has(path)) {
      expanded.delete(path);
      post({ type: 'toggle', path, expanded: false });
    } else {
      expanded.add(path);
      post({ type: 'toggle', path, expanded: true });
    }
    rerender();
  }

  // --- Context menu ------------------------------------------------------

  function buildMenuFor(item) {
    // item === null means empty-area (root actions)
    if (!item) {
      return [
        { label: 'Add Folder', action: () => invoke('addCluster', null) },
      ];
    }
    if (item.type === 'cluster' || item.type === 'subcluster') {
      return [
        { label: 'Connect All Servers',       action: () => invoke('connectAllInFolder', item, { trigger: 'dblclick' }) },
        { label: 'Connect All Servers (alt)', action: () => invoke('connectAllInFolder', item, { trigger: 'button' })   },
        { sep: true },
        { label: 'Add Folder', action: () => invoke('addCluster', item) },
        { label: 'Add Server',  action: () => invoke('addServer',  item) },
        { sep: true },
        { label: 'Rename\u2026',       action: () => invoke('renameCluster', item) },
        { label: 'Change Icon\u2026',  action: () => invoke('changeIcon',   item) },
        { sep: true },
        { label: 'Delete Folder\u2026', action: () => invoke('deleteCluster', item) },
      ];
    }
    // node
    return [
      // Right-click → Connect follows the "I want a regular session"
      // intent, same as double-click. It therefore honours
      // `vsCRT.doubleClickTerminalLocation` (default: panel), NOT the
      // `buttonClickTerminalLocation` setting — that one is reserved
      // for the inline hover row-action button, which is the explicit
      // "open elsewhere" quick-action.
      { label: 'Connect',                action: () => invoke('connect',            item, { trigger: 'dblclick' }) },
      { label: 'Test Connection',        action: () => invoke('testConnection',     item) },
      { label: 'Run Command\u2026',       action: () => invoke('runServerCommand',   item) },
      { label: 'Open SFTP Browser\u2026', action: () => invoke('openSftpBrowser', item) },
      { sep: true },
      { label: 'Edit Server\u2026',      action: () => invoke('editServer',         item) },
      { label: 'Duplicate Server',       action: () => invoke('duplicateNode',      item) },
      { label: 'Change Password',        action: () => invoke('changePassword',     item) },
      { label: 'Change Password Storage', action: () => invoke('setPasswordStorage', item) },
      { sep: true },
      { label: 'Change Icon\u2026',       action: () => invoke('changeIcon',         item) },
      { sep: true },
      { label: 'Remove Host Key\u2026',   action: () => invoke('removeHostKey',      item) },
      { sep: true },
      { label: 'Delete Server\u2026',     action: () => invoke('deleteNode',         item) },
    ];
  }

  function showContextMenu(x, y, item) {
    const entries = buildMenuFor(item);
    populateContextMenu(entries);
    ctxmenu.classList.add('open');
    // Position after render so we know the size.
    const rect = ctxmenu.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth  - rect.width  - 4);
    const py = Math.min(y, window.innerHeight - rect.height - 4);
    ctxmenu.style.left = Math.max(0, px) + 'px';
    ctxmenu.style.top  = Math.max(0, py) + 'px';
  }

  function hideContextMenu() {
    ctxmenu.classList.remove('open');
  }

  /**
   * Build the context-menu DOM with a11y markup and a roving-tabindex
   * keyboard model:
   *   - menuitem divs: role="menuitem", tabindex=-1 (focusable via focus())
   *   - separator divs: role="separator", aria-hidden="true"
   *   - first item is focused when the menu opens so ArrowUp/Down / Enter work
   *   - Escape / blur already close the menu via existing handlers
   */
  function populateContextMenu(entries) {
    ctxmenu.innerHTML = '';
    for (const entry of entries) {
      if (entry.sep) {
        const sep = document.createElement('div');
        sep.className = 'sep';
        sep.setAttribute('role', 'separator');
        sep.setAttribute('aria-hidden', 'true');
        ctxmenu.appendChild(sep);
        continue;
      }
      const mi = document.createElement('div');
      mi.className = 'mi';
      mi.setAttribute('role', 'menuitem');
      mi.setAttribute('tabindex', '-1');
      mi.textContent = entry.label;
      mi.addEventListener('click', () => {
        hideContextMenu();
        entry.action();
      });
      mi.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          hideContextMenu();
          entry.action();
        }
      });
      ctxmenu.appendChild(mi);
    }
    // Focus the first real menuitem so keyboard users land on something
    // actionable. Delay a tick so positioning / open class land first.
    setTimeout(() => {
      const first = ctxmenu.querySelector('.mi[role="menuitem"]');
      if (first) first.focus();
    }, 0);
  }

  // Arrow-key nav inside the open context menu. Walks only over real
  // menuitem divs — separators are skipped.
  ctxmenu.addEventListener('keydown', (e) => {
    if (!ctxmenu.classList.contains('open')) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') {
      return;
    }
    const items = Array.from(ctxmenu.querySelectorAll('.mi[role="menuitem"]'));
    if (items.length === 0) return;
    const active = document.activeElement;
    const idx = items.indexOf(active);
    let nextIdx;
    if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = items.length - 1;
    else if (e.key === 'ArrowDown') nextIdx = idx < 0 ? 0 : (idx + 1) % items.length;
    else nextIdx = idx <= 0 ? items.length - 1 : idx - 1;
    items[nextIdx].focus();
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener('click', hideContextMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
  });
  window.addEventListener('blur', hideContextMenu);
  window.addEventListener('scroll', hideContextMenu, true);

  // Empty-area right-click
  tree.addEventListener('contextmenu', (e) => {
    if (e.target === tree) {
      e.preventDefault();
      selectRow(null);
      showContextMenu(e.clientX, e.clientY, null);
    }
  });

  // --- Drag & drop -------------------------------------------------------

  let dragSource = null; // { path, kind } or null

  function attachDragHandlers(row) {
    row.addEventListener('dragstart', (e) => {
      dragSource = { path: row.dataset.path, kind: row.dataset.kind };
      row.classList.add('dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/vnd-vscrt', JSON.stringify(dragSource));
      } catch (_) { /* ignore */ }
    });

    row.addEventListener('dragend', () => {
      dragSource = null;
      clearAllDropIndicators();
      row.classList.remove('dragging');
    });

    row.addEventListener('dragover', (e) => {
      if (!dragSource) return;
      const zone = computeDropZone(e, row);
      if (!zone) {
        clearIndicators(row);
        return;
      }
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (_) { /* ignore */ }
      setIndicator(row, zone);
    });

    row.addEventListener('dragleave', (e) => {
      // Only clear if leaving the row itself (not child elements).
      if (e.currentTarget === row &&
          (!e.relatedTarget || !row.contains(e.relatedTarget))) {
        clearIndicators(row);
      }
    });

    row.addEventListener('drop', (e) => {
      if (!dragSource) return;
      const zone = computeDropZone(e, row);
      clearIndicators(row);
      if (!zone) return;
      e.preventDefault();
      e.stopPropagation();
      post({
        type: 'move',
        sourcePath: dragSource.path,
        sourceKind: dragSource.kind,
        targetPath: row.dataset.path,
        targetKind: row.dataset.kind,
        position: zone,
      });
      dragSource = null;
    });
  }

  // Empty-area drop = root
  tree.addEventListener('dragover', (e) => {
    if (!dragSource) return;
    if (e.target !== tree) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) { /* ignore */ }
  });
  tree.addEventListener('drop', (e) => {
    if (!dragSource) return;
    if (e.target !== tree) return;
    e.preventDefault();
    post({
      type: 'move',
      sourcePath: dragSource.path,
      sourceKind: dragSource.kind,
      targetPath: undefined,
      targetKind: undefined,
      position: 'after',
    });
    dragSource = null;
  });

  function computeDropZone(e, row) {
    const targetPath = row.dataset.path;
    const targetKind = row.dataset.kind;
    // Self-drop
    if (dragSource.path === targetPath) return null;
    // Cycle (cluster onto its own descendant)
    if (dragSource.kind !== 'node' &&
        targetPath.indexOf(dragSource.path + '/') === 0) return null;

    const rect = row.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height;

    if (targetKind === 'node') {
      // Leaf target: before/after only.
      return y < h / 2 ? 'before' : 'after';
    }

    // Cluster/subcluster target: 25% before, 25% after, 50% inside.
    if (y < h * 0.25) return 'before';
    if (y > h * 0.75) return 'after';
    // Node dropped "inside" a cluster is valid.
    // Cluster dropped "inside" a cluster → becomes subcluster. Also valid.
    return 'inside';
  }

  function setIndicator(row, zone) {
    clearIndicators(row);
    if (zone === 'before') row.classList.add('drop-before');
    else if (zone === 'after') row.classList.add('drop-after');
    else if (zone === 'inside') row.classList.add('drop-inside');
  }

  function clearIndicators(row) {
    row.classList.remove('drop-before', 'drop-after', 'drop-inside');
  }

  function clearAllDropIndicators() {
    for (const el of tree.querySelectorAll('.drop-before, .drop-after, .drop-inside')) {
      el.classList.remove('drop-before', 'drop-after', 'drop-inside');
    }
  }

  // --- Messaging ---------------------------------------------------------

  function post(msg) { vscode.postMessage(msg); }

  function invoke(command, item, extras) {
    const msg = {
      type: 'invoke',
      command: command,
      targetPath: item ? item.path : undefined,
      targetKind: item ? item.type : undefined,
    };
    if (extras) {
      for (const k in extras) msg[k] = extras[k];
    }
    post(msg);
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.type === 'tree') {
      items = Array.isArray(d.items) ? d.items : [];
      expanded.clear();
      if (Array.isArray(d.expanded)) {
        for (const p of d.expanded) expanded.add(p);
      }
      rebuildItemsByPath(items);
      rerender();
    }
  });

  post({ type: 'ready' });
})();
