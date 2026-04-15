import * as vscode from "vscode";
import {
  CRTConfig,
  CRTConfigCluster,
  CRTConfigNode,
  CRTConfigService,
} from "../config/vscrtConfig";
import { CRTTarget } from "./treeTarget";

interface WebviewItem {
  type: "cluster" | "subcluster" | "node";
  path: string;
  label: string;
  description?: string;
  icon?: string; // codicon name override; falls back to per-kind default
  children?: WebviewItem[];
}

type W2E =
  | { type: "ready" }
  | { type: "toggle"; path: string; expanded: boolean }
  | {
      type: "invoke";
      command:
        | "addCluster"
        | "addServer"
        | "editServer"
        | "duplicateNode"
        | "renameCluster"
        | "deleteNode"
        | "deleteCluster"
        | "connect"
        | "connectAllInFolder"
        | "changePassword"
        | "setPasswordStorage"
        | "changeIcon";
      targetPath?: string;
      targetKind?: "cluster" | "subcluster" | "node";
      trigger?: "dblclick" | "button";
      location?: "panel" | "editor";
    }
  | {
      type: "move";
      sourcePath: string;
      sourceKind: "cluster" | "subcluster" | "node";
      targetPath?: string;
      targetKind?: "cluster" | "subcluster" | "node";
      position: "before" | "after" | "inside";
    };

const COMMAND_IDS: Record<
  Extract<W2E, { type: "invoke" }>["command"],
  string
> = {
  addCluster: "vsCRT.addCluster",
  addServer: "vsCRT.addServer",
  editServer: "vsCRT.editServer",
  duplicateNode: "vsCRT.duplicateNode",
  renameCluster: "vsCRT.renameCluster",
  deleteNode: "vsCRT.deleteNode",
  deleteCluster: "vsCRT.deleteCluster",
  connect: "vsCRT.connect",
  connectAllInFolder: "vsCRT.connectAllInFolder",
  changePassword: "vsCRT.changePassword",
  setPasswordStorage: "vsCRT.setPasswordStorage",
  changeIcon: "vsCRT.changeIcon",
};

export class CRTWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly expanded = new Set<string>();
  private initialExpandDone = false;

  constructor(
    private readonly configManager: CRTConfigService,
    private readonly extensionUri: vscode.Uri,
  ) {}

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.view = webviewView;
    const codiconsRoot = vscode.Uri.joinPath(
      this.extensionUri,
      "node_modules",
      "@vscode",
      "codicons",
      "dist",
    );
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [codiconsRoot],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg: W2E) => {
      if (!msg) {
        return;
      }
      try {
        await this.handleMessage(msg);
      } catch (err) {
        console.error("[vsCRT] webview message handler error:", err);
      }
    });
  }

  async reload(): Promise<void> {
    await this.postTree();
  }

  private async handleMessage(msg: W2E): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.postTree();
        return;
      case "toggle":
        if (msg.expanded) {
          this.expanded.add(msg.path);
        } else {
          this.expanded.delete(msg.path);
        }
        return;
      case "invoke":
        await this.handleInvoke(msg);
        return;
      case "move":
        await this.handleMove(msg);
        return;
    }
  }

  private async handleInvoke(
    msg: Extract<W2E, { type: "invoke" }>,
  ): Promise<void> {
    const commandId = COMMAND_IDS[msg.command];
    if (!commandId) {
      return;
    }

    const forwardsOpts =
      msg.command === "connect" || msg.command === "connectAllInFolder";
    const opts =
      forwardsOpts && (msg.trigger || msg.location)
        ? { trigger: msg.trigger, location: msg.location }
        : undefined;

    // Root-level invocations pass no target.
    if (!msg.targetPath || !msg.targetKind) {
      if (opts) {
        await vscode.commands.executeCommand(commandId, undefined, opts);
      } else {
        await vscode.commands.executeCommand(commandId);
      }
      return;
    }

    const target = await this.buildTarget(msg.targetPath, msg.targetKind);
    if (!target) {
      vscode.window.showErrorMessage(
        `vsCRT: could not resolve "${msg.targetPath}" in config.`,
      );
      return;
    }
    if (opts) {
      await vscode.commands.executeCommand(commandId, target, opts);
    } else {
      await vscode.commands.executeCommand(commandId, target);
    }
  }

  private async buildTarget(
    path: string,
    kind: "cluster" | "subcluster" | "node",
  ): Promise<CRTTarget | null> {
    const label = path.split("/").pop() ?? path;
    if (kind === "node") {
      const node = await this.configManager.getNodeByPath(path);
      if (!node) {
        return null;
      }
      return { item: { type: "node", path, label: node.name, config: node } };
    }
    return { item: { type: kind, path, label } };
  }

  private async handleMove(
    msg: Extract<W2E, { type: "move" }>,
  ): Promise<void> {
    const ok =
      msg.sourceKind === "node"
        ? await this.configManager.moveNode(
            msg.sourcePath,
            msg.targetPath,
            msg.targetKind,
            msg.position,
          )
        : await this.configManager.moveCluster(
            msg.sourcePath,
            msg.targetPath,
            msg.targetKind,
            msg.position,
          );
    if (ok) {
      await this.postTree();
    }
  }

  private async postTree(): Promise<void> {
    if (!this.view) {
      return;
    }
    const cfg = await this.configManager.loadConfig();
    const items = cfg ? configToItems(cfg) : [];

    if (!this.initialExpandDone) {
      // First render: expand everything so the user sees the full tree.
      collectExpandablePaths(items, this.expanded);
      this.initialExpandDone = true;
    } else {
      // Drop paths that no longer exist after a mutation.
      pruneStaleExpanded(items, this.expanded);
    }

    this.view.webview.postMessage({
      type: "tree",
      items,
      expanded: [...this.expanded],
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = generateNonce();
    const codiconsCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "node_modules",
        "@vscode",
        "codicons",
        "dist",
        "codicon.css",
      ),
    );
    const csp = [
      "default-src 'none'",
      `style-src 'unsafe-inline' ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      "img-src data:",
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${codiconsCssUri}" />
<style>
  html, body {
    margin: 0;
    padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
  }
  html, body { height: 100%; }
  body {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  #tree {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 4px 0;
  }
  #filter-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    background: var(--vscode-sideBar-background, transparent);
  }
  #filter-icon {
    flex: 0 0 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0.75;
  }
  #filter-input {
    flex: 1 1 auto;
    min-width: 0;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    padding: 3px 6px;
    font-family: inherit;
    font-size: inherit;
    outline: none;
  }
  #filter-input:focus {
    border-color: var(--vscode-focusBorder);
  }
  #filter-input::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }
  #filter-clear {
    flex: 0 0 20px;
    height: 20px;
    display: none;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0.75;
    border-radius: 3px;
  }
  #filter-clear:hover {
    background: var(--vscode-toolbar-hoverBackground);
    opacity: 1;
  }
  #filter-bar.active #filter-clear { display: inline-flex; }
  .match {
    background: var(--vscode-list-filterMatchBackground, var(--vscode-editor-findMatchHighlightBackground, rgba(255, 200, 0, 0.4)));
    border: 1px solid var(--vscode-list-filterMatchBorder, transparent);
    border-radius: 2px;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    height: 22px;
    line-height: 22px;
    padding-left: calc(var(--depth, 0) * 16px + 4px);
    padding-right: 8px;
    cursor: default;
    user-select: none;
    white-space: nowrap;
    box-sizing: border-box;
  }
  .row.clickable { cursor: pointer; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.selected {
    background: var(--vscode-list-inactiveSelectionBackground);
    color: var(--vscode-list-inactiveSelectionForeground);
  }
  .row.dragging { opacity: 0.4; }
  .row.drop-inside {
    background: var(--vscode-list-dropBackground);
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .row.drop-before::before,
  .row.drop-after::after {
    content: "";
    position: absolute;
    left: calc(var(--depth, 0) * 16px + 4px);
    right: 4px;
    height: 2px;
    background: var(--vscode-focusBorder);
    pointer-events: none;
  }
  .row.drop-before::before { top: 0; }
  .row.drop-after::after  { bottom: 0; }

  .chevron {
    flex: 0 0 16px;
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0.85;
  }
  .chevron .codicon { font-size: 14px; line-height: 14px; }
  .icon {
    flex: 0 0 16px;
    width: 16px;
    height: 16px;
    margin-right: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .icon .codicon { font-size: 16px; line-height: 16px; }
  .row[data-kind="cluster"]    .icon .codicon,
  .row[data-kind="subcluster"] .icon .codicon {
    color: var(--vscode-symbolIcon-folderForeground, var(--vscode-foreground));
  }
  .label { flex: 0 0 auto; }
  .description {
    color: var(--vscode-descriptionForeground);
    margin-left: 8px;
    font-size: 0.9em;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .row-actions {
    margin-left: auto;
    display: inline-flex;
    gap: 2px;
    flex-shrink: 0;
    padding-left: 6px;
    opacity: 0;
    transition: opacity 80ms;
  }
  .row:hover .row-actions,
  .row.selected .row-actions { opacity: 1; }
  .row-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 3px;
    cursor: pointer;
    opacity: 0.85;
  }
  .row-action:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
    opacity: 1;
  }
  .row-action .codicon { font-size: 16px; line-height: 16px; }

  #ctxmenu {
    position: fixed;
    display: none;
    min-width: 180px;
    padding: 4px 0;
    background: var(--vscode-menu-background);
    color: var(--vscode-menu-foreground);
    border: 1px solid var(--vscode-menu-border, var(--vscode-contrastBorder, transparent));
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    font-size: var(--vscode-font-size);
    z-index: 1000;
  }
  #ctxmenu.open { display: block; }
  #ctxmenu .mi {
    padding: 4px 14px;
    cursor: pointer;
    white-space: nowrap;
  }
  #ctxmenu .mi:hover {
    background: var(--vscode-menu-selectionBackground);
    color: var(--vscode-menu-selectionForeground);
  }
  #ctxmenu .sep {
    height: 1px;
    background: var(--vscode-menu-separatorBackground, rgba(128, 128, 128, 0.35));
    margin: 4px 0;
  }
</style>
</head>
<body>
<div id="tree"></div>
<div id="filter-bar">
  <span id="filter-icon"><i class="codicon codicon-filter"></i></span>
  <input id="filter-input" type="text" placeholder="Filter\u2026" spellcheck="false" />
  <span id="filter-clear" title="Clear filter"><i class="codicon codicon-close"></i></span>
</div>
<div id="ctxmenu"></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const tree = document.getElementById('tree');
  const ctxmenu = document.getElementById('ctxmenu');
  const filterBar = document.getElementById('filter-bar');
  const filterInput = document.getElementById('filter-input');
  const filterClear = document.getElementById('filter-clear');

  let items = [];
  const expanded = new Set();
  let selectedPath = null;
  let filterQuery = '';

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

  function renderRow(parent, item, depth) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.setProperty('--depth', depth);
    row.dataset.path = item.path;
    row.dataset.kind = item.type;
    row.setAttribute('draggable', 'true');
    if (item.path === selectedPath) row.classList.add('selected');

    const hasChildren = Array.isArray(item.children) && item.children.length > 0;
    if (hasChildren) row.classList.add('clickable');

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
      if (!hasChildren) return;
      toggleExpand(item.path);
    });
    row.appendChild(chevron);

    const icon = document.createElement('span');
    icon.className = 'icon';
    const glyph = document.createElement('i');
    glyph.className = 'codicon ' + codiconClassFor(item);
    icon.appendChild(glyph);
    row.appendChild(icon);

    row.appendChild(renderHighlighted('label', item.label, filterQuery));

    if (item.description) {
      row.appendChild(renderHighlighted('description', item.description, filterQuery));
    }

    if (item.type === 'node') {
      const actions = document.createElement('span');
      actions.className = 'row-actions';

      const openEditor = document.createElement('span');
      openEditor.className = 'row-action';
      openEditor.title = 'Open in editor tab';
      const glyph = document.createElement('i');
      glyph.className = 'codicon codicon-open-preview';
      openEditor.appendChild(glyph);
      openEditor.addEventListener('click', (e) => {
        e.stopPropagation();
        invoke('connect', item, { trigger: 'button', location: 'editor' });
      });
      actions.appendChild(openEditor);

      row.appendChild(actions);
    }

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      selectRow(item.path);
      if (hasChildren) toggleExpand(item.path);
    });

    row.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (item.type === 'node') {
        invoke('connect', item, { trigger: 'dblclick' });
      } else if (hasChildren) {
        toggleExpand(item.path);
      }
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectRow(item.path);
      showContextMenu(e.clientX, e.clientY, item);
    });

    attachDragHandlers(row, item);

    parent.appendChild(row);

    if (hasChildren && isExpanded(item.path)) {
      for (const child of item.children) renderRow(parent, child, depth + 1);
    }
  }

  function isExpanded(path) {
    // During a filter, everything is force-expanded so matches are visible.
    if (filterQuery) return true;
    return expanded.has(path);
  }

  function rerender() {
    tree.innerHTML = '';
    const list = filterQuery ? filterTree(items, filterQuery) : items;
    for (const item of list) renderRow(tree, item, 0);
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
    return String(s).replace(/(["\\\\])/g, '\\\\$1');
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
      { label: 'Connect',                action: () => invoke('connect',            item, { trigger: 'button' }) },
      { sep: true },
      { label: 'Edit Server\u2026',      action: () => invoke('editServer',         item) },
      { label: 'Duplicate Server',       action: () => invoke('duplicateNode',      item) },
      { label: 'Change Password',        action: () => invoke('changePassword',     item) },
      { label: 'Change Password Storage', action: () => invoke('setPasswordStorage', item) },
      { sep: true },
      { label: 'Change Icon\u2026',       action: () => invoke('changeIcon',         item) },
      { sep: true },
      { label: 'Delete Server\u2026',     action: () => invoke('deleteNode',         item) },
    ];
  }

  function showContextMenu(x, y, item) {
    const entries = buildMenuFor(item);
    ctxmenu.innerHTML = '';
    for (const entry of entries) {
      if (entry.sep) {
        const sep = document.createElement('div');
        sep.className = 'sep';
        ctxmenu.appendChild(sep);
        continue;
      }
      const mi = document.createElement('div');
      mi.className = 'mi';
      mi.textContent = entry.label;
      mi.addEventListener('click', () => {
        hideContextMenu();
        entry.action();
      });
      ctxmenu.appendChild(mi);
    }
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

  function attachDragHandlers(row, item) {
    row.addEventListener('dragstart', (e) => {
      dragSource = { path: item.path, kind: item.type };
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
      const zone = computeDropZone(e, row, item);
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
      const zone = computeDropZone(e, row, item);
      clearIndicators(row);
      if (!zone) return;
      e.preventDefault();
      e.stopPropagation();
      post({
        type: 'move',
        sourcePath: dragSource.path,
        sourceKind: dragSource.kind,
        targetPath: item.path,
        targetKind: item.type,
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

  function computeDropZone(e, row, item) {
    // Self-drop
    if (dragSource.path === item.path) return null;
    // Cycle (cluster onto its own descendant)
    if (dragSource.kind !== 'node' &&
        String(item.path).indexOf(dragSource.path + '/') === 0) return null;

    const rect = row.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height;

    if (item.type === 'node') {
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
      rerender();
    }
  });

  post({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}

/* -------------------------------------------------------
 *      MODULE HELPERS
 * -----------------------------------------------------*/

function configToItems(cfg: CRTConfig): WebviewItem[] {
  return (cfg.folder ?? []).map((c) => clusterToItem(c, "", "cluster"));
}

function clusterToItem(
  c: CRTConfigCluster,
  parentPath: string,
  type: "cluster" | "subcluster",
): WebviewItem {
  const myPath = parentPath ? `${parentPath}/${c.name}` : c.name;
  return {
    type,
    path: myPath,
    label: c.name,
    icon: c.icon,
    children: [
      ...(c.subfolder ?? []).map((sc) =>
        clusterToItem(sc, myPath, "subcluster"),
      ),
      ...(c.nodes ?? []).map((n) => nodeToItem(n, myPath)),
    ],
  };
}

function nodeToItem(n: CRTConfigNode, parentPath: string): WebviewItem {
  const myPath = parentPath ? `${parentPath}/${n.name}` : n.name;
  return {
    type: "node",
    path: myPath,
    label: n.name,
    description: n.endpoint,
    icon: n.icon,
  };
}

function collectExpandablePaths(
  items: WebviewItem[],
  out: Set<string>,
): void {
  for (const item of items) {
    if (item.children && item.children.length > 0) {
      out.add(item.path);
      collectExpandablePaths(item.children, out);
    }
  }
}

function pruneStaleExpanded(
  items: WebviewItem[],
  set: Set<string>,
): void {
  const alive = new Set<string>();
  collectExpandablePaths(items, alive);
  for (const p of [...set]) {
    if (!alive.has(p)) {
      set.delete(p);
    }
  }
}

function generateNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
