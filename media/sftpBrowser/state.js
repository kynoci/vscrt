// @ts-check
/* eslint-disable no-console */
/**
 * Phase 6 — webview IIFE split.
 *
 * This file bootstraps the `window.vsCrtSftp` namespace used by every
 * other `media/sftpBrowser/*.js` file. Nothing here fires listeners or
 * mutates the DOM; it only wires up refs + initial state so the rest
 * of the files can assume `ns.dom`, `ns.state`, and the constants are
 * populated the moment they run.
 *
 * Load order in `buildHtml.ts`:
 *   state.js → messaging.js → navigation.js → sort.js → filter.js →
 *   virtualization.js → selection.js → rendering.js → keyboard.js →
 *   contextMenu.js → toolbar.js → dragDrop/osDrop.js → localPane.js →
 *   dragDrop/localPaneDrop.js
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = (/** @type {any} */ (window).vsCrtSftp =
    /** @type {any} */ (window).vsCrtSftp || {});

  // @ts-expect-error acquireVsCodeApi is injected by the webview host
  ns.vscode = acquireVsCodeApi();

  ns.dom = {
    pathInput: /** @type {HTMLInputElement} */ (
      document.getElementById("path-input")
    ),
    filterInput: /** @type {HTMLInputElement} */ (
      document.getElementById("filter-input")
    ),
    rowsEl: /** @type {HTMLElement} */ (document.getElementById("rows")),
    statusBar: /** @type {HTMLElement} */ (
      document.getElementById("status-bar")
    ),
    emptyEl: /** @type {HTMLElement} */ (document.getElementById("empty")),
    listing: /** @type {HTMLElement} */ (document.getElementById("listing")),
    // Scroll container wrapping `#listing`. Chromium doesn't honour
    // `overflow: auto` on `<table>` elements, so this div is what
    // actually scrolls — virtualization reads scrollTop/clientHeight
    // off it, and the empty-state toggle hides it (not the inner
    // table) so the "(empty directory)" text isn't pushed below a
    // flex-grown-but-blank wrapper.
    listingScroll: /** @type {HTMLElement} */ (
      document.getElementById("listing-scroll")
    ),
    breadcrumbs: /** @type {HTMLElement} */ (
      document.getElementById("breadcrumbs")
    ),
    spinner: /** @type {HTMLElement} */ (document.getElementById("spinner")),
    toggleHidden: /** @type {HTMLElement} */ (
      document.getElementById("toggle-hidden")
    ),
    ctxMenu: /** @type {HTMLElement} */ (document.getElementById("ctxmenu")),
    localPane: /** @type {HTMLElement} */ (
      document.getElementById("local-pane")
    ),
    localRowsEl: /** @type {HTMLElement} */ (
      document.getElementById("local-rows")
    ),
    localListingScroll: /** @type {HTMLElement} */ (
      document.getElementById("local-listing-scroll")
    ),
    localEmptyEl: /** @type {HTMLElement} */ (
      document.getElementById("local-empty")
    ),
    localPathInput: /** @type {HTMLInputElement} */ (
      document.getElementById("local-path-input")
    ),
    toggleLocal: /** @type {HTMLElement} */ (
      document.getElementById("toggle-local-pane")
    ),
    // Caret half of the split button — opens the Downloads / Home /
    // Choose Folder dropdown. Absent if the toolbar isn't using the
    // split-button layout (defensive so older HTML shells still work).
    toggleLocalMenu: /** @type {HTMLElement|null} */ (
      document.getElementById("toggle-local-menu")
    ),
    remotePane: /** @type {HTMLElement} */ (
      document.getElementById("remote-pane")
    ),
  };

  ns.state = {
    currentPath: "~",
    /** @type {any[]} */
    currentEntries: [],
    /** @type {Set<string>} */
    selectedNames: new Set(),
    /** Anchor name for shift-range selects; last row that set the selection. */
    /** @type {string|null} */
    selectionAnchor: null,
    sortKey: "name",
    sortDir: "asc",
    // Hide dotfiles by default — matches most graphical file managers
    // (Finder, Windows Explorer, Files) where `.bashrc` / `.ssh` / etc.
    // are a distraction for 95% of browsing sessions. The toolbar
    // "Hidden" toggle shows them when needed; the status bar surfaces
    // a "N hidden (toggle Hidden to show)" hint so an apparently-empty
    // directory still tells the user why it looks empty.
    showHidden: false,
    filter: "",
    /** Filtered + sorted list for the current render. Source of truth for
     *  virtual-mode windowing and keyboard navigation alike. */
    /** @type {any[]} */
    displayList: [],
    /** True when displayList.length > VIRTUAL_THRESHOLD. */
    virtualActive: false,
    /** rAF id for the scroll-throttled re-render. */
    virtualRafId: 0,
    /** Name of the row the user last focused; re-applied after a virtual
     *  re-render brings it back into the rendered window. */
    /** @type {string|null} */
    lastFocusedName: null,
    // Local-pane state.
    localPath: "~",
    /** @type {any[]} */
    localEntries: [],
    localEnabled: false,
    /** @type {Set<string>} */
    localSelectedNames: new Set(),
    /** @type {string|null} */
    localSelectionAnchor: null,
    // OS-drag counter — body receives nested dragenter/dragleave pairs
    // as the cursor moves over child elements; counting them gives us a
    // reliable "still-hovering" boolean.
    dragDepth: 0,
  };
})();
