/**
 * SFTP-browser webview HTML shell.
 *
 * The webview loads a sequence of concern-sized JS files under
 * `media/sftpBrowser/`. Load order below matters because `state.js`
 * must populate `window.vsCrtSftp.dom` / `state` before any other
 * file's IIFE runs.
 *
 * CSP uses a per-open nonce so only the scripts we emit can run.
 * Zero runtime logic beyond URL generation — every interactive bit
 * lives webview-side.
 */
import * as vscode from "vscode";
import type { CommandDeps } from "../../types";
import { generateNonce } from "../../../treeView/webviewNonce";

/**
 * Ordered list of webview scripts. **Load order is load-bearing:**
 *   state.js       — bootstraps `window.vsCrtSftp` namespace + DOM refs.
 *   messaging.js   — post()/setStatus()/setBusy() and the primary host
 *                    → webview dispatch.
 *   navigation.js  — navigate / goUp / breadcrumbs / joinPath helper.
 *   sort.js        — sort predicate + header wiring.
 *   filter.js      — filter predicate + input wiring.
 *   virtualization.js — windowed rendering for > 300-entry listings.
 *   selection.js   — single / range / multi-select.
 *   rendering.js   — render / renderRows / buildRow / openEntry.
 *   keyboard.js    — onRowKeydown, triggerRename.
 *   contextMenu.js — right-click menu + global Esc handler.
 *   toolbar.js     — Refresh / Up / Upload / Mkdir / Hidden / Cancel wiring.
 *   dragDrop/osDrop.js — OS → remote upload (Files DataTransfer).
 *   localPane.js   — E1 local pane (renderLocal / navigateLocal).
 *   dragDrop/localPaneDrop.js — local → remote drag upload.
 *   dragDrop/remotePaneDrag.js — remote → local drag download + ready
 *                                handshake (last-loaded file).
 */
const WEBVIEW_SCRIPTS: readonly string[] = [
  "sftpBrowser/state.js",
  "sftpBrowser/messaging.js",
  "sftpBrowser/navigation.js",
  "sftpBrowser/sort.js",
  "sftpBrowser/filter.js",
  "sftpBrowser/virtualization.js",
  "sftpBrowser/selection.js",
  "sftpBrowser/localSelection.js",
  "sftpBrowser/marquee.js",
  "sftpBrowser/rendering.js",
  "sftpBrowser/keyboard.js",
  "sftpBrowser/contextMenu.js",
  "sftpBrowser/toolbar.js",
  "sftpBrowser/dragDrop/osDrop.js",
  "sftpBrowser/localPane.js",
  "sftpBrowser/dragDrop/localPaneDrop.js",
  "sftpBrowser/dragDrop/remotePaneDrag.js",
];

export function buildWebviewHtml(
  webview: vscode.Webview,
  deps: CommandDeps,
): string {
  const media = (name: string): vscode.Uri =>
    webview.asWebviewUri(
      vscode.Uri.joinPath(deps.context.extensionUri, "media", name),
    );
  const cspSource = webview.cspSource;
  const nonce = generateNonce();
  const scriptTags = WEBVIEW_SCRIPTS.map(
    (p) => `  <script nonce="${nonce}" src="${media(p)}"></script>`,
  ).join("\n");
  const cssUri = media("sftpBrowser.css");
  // POSIX hosts (Linux, macOS) expose meaningful user/group/other
  // permission bits through `stat.mode`; Windows doesn't. The local
  // pane emits a Perms column only in the former case, and the
  // webview JS keys off the `data-local-perms` body attribute to
  // render the matching cell.
  const localPermsSupported = process.platform !== "win32";
  const localPermsCol = localPermsSupported
    ? `            <col class="c-perms">\n`
    : "";
  const localPermsTh = localPermsSupported
    ? `              <th scope="col">Perms</th>\n`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource}; script-src 'nonce-${nonce}';">
  <title>SFTP Browser</title>
  <link rel="stylesheet" href="${cssUri}">
</head>
<body data-local-perms="${localPermsSupported ? "1" : "0"}">
  <div id="toolbar" role="toolbar" aria-label="SFTP toolbar">
    <input id="filter-input" type="text" placeholder="Filter rows…" spellcheck="false" aria-label="Filter rows in current directory">
    <button id="refresh" title="Refresh" aria-label="Refresh directory">↻ Refresh</button>
    <button id="upload" title="Upload file(s)" aria-label="Upload files to this directory">⬆ Upload</button>
    <button id="mkdir" title="New folder" aria-label="Create a new folder">📁 New</button>
    <button id="toggle-hidden" title="Show hidden files" aria-label="Toggle hidden files" aria-pressed="false">👁 Hidden</button>
    <!-- Phase-9 split button: main half opens at the workspace folder;
         caret half reveals a Downloads / Home / Choose… menu. -->
    <span id="toggle-local-group" class="split-btn">
      <button id="toggle-local-pane" title="Open local pane at workspace folder" aria-label="Toggle local file pane (opens at workspace)" aria-pressed="false">⇆ Local</button><button id="toggle-local-menu" title="Other locations…" aria-label="Other local pane locations" aria-haspopup="menu" aria-expanded="false">▾</button>
    </span>
    <button id="cancel" title="Cancel in-flight operations" aria-label="Cancel in-flight operations">✕ Cancel</button>
    <span id="spinner" aria-hidden="true"></span>
  </div>
  <div id="status-bar" role="status" aria-live="polite"></div>
  <div id="panes">
    <section id="remote-pane" class="pane">
      <header class="pane-header">
        <span class="pane-title">Remote</span>
        <button id="up" class="pane-header-btn" title="Parent directory" aria-label="Go to parent directory">↑</button>
        <div id="path-bar" data-mode="crumbs" title="Click to edit path (or press Ctrl+L)">
          <nav id="breadcrumbs" aria-label="Path breadcrumbs"></nav>
          <input id="path-input" type="text" spellcheck="false"
                 aria-label="Remote path (press Enter to navigate, Esc to cancel)"
                 hidden>
        </div>
      </header>
      <!-- Scroll container — Chromium doesn't honour \`overflow: auto\` on
           \`<table>\`, so the wrapper div is what actually scrolls. The
           virtualization code in media/sftpBrowser/virtualization.js
           reads scrollTop / clientHeight off this div. -->
      <div id="listing-scroll" class="table-scroll">
        <table id="listing" role="grid">
          <colgroup>
            <col class="c-name">
            <col class="c-size">
            <col class="c-mtime">
            <col class="c-perms">
          </colgroup>
          <thead>
            <tr>
              <th data-sort="name" class="sortable" scope="col" aria-sort="none">Name</th>
              <th data-sort="size" class="sortable num" scope="col" aria-sort="none">Size</th>
              <th data-sort="mtime" class="sortable" scope="col" aria-sort="none">Modified</th>
              <th scope="col">Perms</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
      <div id="empty">Loading…</div>
    </section>
    <section id="local-pane" class="pane" hidden>
      <header class="pane-header">
        <span class="pane-title">Local</span>
        <div id="local-path-bar" data-mode="crumbs" title="Click to edit path">
          <nav id="local-breadcrumbs" aria-label="Local path breadcrumbs"></nav>
          <input id="local-path-input" type="text" spellcheck="false"
                 aria-label="Local path (press Enter to navigate, Esc to cancel)"
                 hidden>
        </div>
      </header>
      <div id="local-listing-scroll" class="table-scroll">
        <table id="local-listing" role="grid">
          <colgroup>
            <col class="c-name">
            <col class="c-size">
            <col class="c-mtime">
${localPermsCol}          </colgroup>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th class="num" scope="col">Size</th>
              <th scope="col">Modified</th>
${localPermsTh}            </tr>
          </thead>
          <tbody id="local-rows"></tbody>
        </table>
      </div>
      <div id="local-empty">Loading…</div>
    </section>
  </div>

  <!-- Custom context menu — shown on right-click over a row. -->
  <div id="ctxmenu" role="menu" hidden></div>

${scriptTags}
</body>
</html>`;
}
