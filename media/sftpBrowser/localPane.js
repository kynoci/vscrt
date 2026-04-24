// @ts-check
/* eslint-disable no-console */
/**
 * E1 — Local pane. A secondary pane that browses the user's local
 * filesystem. Hidden by default; revealed via the toolbar "⇆ Local"
 * toggle (Phase-8 QuickPick-picker). Lists read via `localList`
 * messages, listings rendered by `renderLocal` — deliberately simpler
 * than the remote table (no sort / multi-select / virtualization)
 * because local dirs are rarely the limiting factor.
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = /** @type {any} */ (window).vsCrtSftp;
  const { dom, state } = ns;

  /** @param {boolean} on */
  ns.setLocalPaneEnabled = function setLocalPaneEnabled(on) {
    state.localEnabled = !!on;
    if (on) {
      dom.localPane.removeAttribute("hidden");
      dom.toggleLocal.setAttribute("aria-pressed", "true");
      ns.navigateLocal(state.localPath);
    } else {
      dom.localPane.setAttribute("hidden", "");
      dom.toggleLocal.setAttribute("aria-pressed", "false");
    }
  };

  /** @param {string} p */
  ns.navigateLocal = function navigateLocal(p) {
    if (!p) return;
    state.localPath = p;
    dom.localPathInput.value = p;
    ns.renderLocalBreadcrumbs?.(p);
    // Navigating to a new directory resets the selection — the names
    // won't exist there anyway, and carrying stale selection state
    // into a fresh listing only causes confusion.
    ns.clearLocalSelection?.();
    ns.post({ type: "localList", path: p });
  };

  /**
   * Local-pane breadcrumb renderer — mirrors
   * `navigation.js:renderBreadcrumbs` so the two panes feel the same.
   * Accepts POSIX ("/home/a"), tilde ("~/a"), and Windows ("C:\\a")
   * paths; the separator in the rendered crumbs matches whichever
   * appeared in the input so the path round-trips cleanly when a
   * crumb is clicked.
   *
   * @param {string} pathStr
   */
  ns.renderLocalBreadcrumbs = function renderLocalBreadcrumbs(pathStr) {
    if (!dom.localBreadcrumbs) return;
    dom.localBreadcrumbs.replaceChildren();
    const hasBackslash = pathStr.includes("\\");
    const sepChar = hasBackslash ? "\\" : "/";
    const parts = pathStr.split(/[\\/]/).filter(Boolean);
    const isTilde = pathStr.startsWith("~");
    const isDrive = !isTilde && /^[A-Za-z]:/.test(pathStr);
    /** @type {string} */
    let root;
    if (isTilde) {
      root = "~";
    } else if (isDrive) {
      // `parts[0]` is the "C:" drive segment; consume it as the root
      // so the remaining parts render as crumbs under it.
      root = parts.shift() || "";
    } else {
      root = "/";
    }
    // Target path for the root crumb — drives need the trailing
    // separator to be a valid navigable path ("C:\\" not "C:").
    const rootTarget = isDrive ? root + sepChar : root;

    const rootEl = document.createElement("span");
    rootEl.className = "crumb";
    rootEl.tabIndex = 0;
    rootEl.textContent = root;
    rootEl.addEventListener("click", () => ns.navigateLocal(rootTarget));
    rootEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        ns.navigateLocal(rootTarget);
      }
    });
    dom.localBreadcrumbs.appendChild(rootEl);

    // Skip the leading "~" when building crumbs under a tilde root.
    const crumbParts = isTilde ? parts.slice(1) : parts;
    let acc = rootTarget;
    for (const part of crumbParts) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = sepChar;
      dom.localBreadcrumbs.appendChild(sep);
      acc = acc.endsWith(sepChar) ? acc + part : acc + sepChar + part;
      const el = document.createElement("span");
      el.className = "crumb";
      el.tabIndex = 0;
      el.textContent = part;
      const target = acc;
      el.addEventListener("click", () => ns.navigateLocal(target));
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          ns.navigateLocal(target);
        }
      });
      dom.localBreadcrumbs.appendChild(el);
    }
  };

  // Install the marquee once: the local rows element exists from
  // page load (the listing just starts empty), so we can arm the
  // drag-to-select handler before the first `renderLocal` fills it.
  if (dom.localListingScroll && ns.installMarquee && !ns._localMarqueeInstalled) {
    ns.installMarquee({
      scroll: dom.localListingScroll,
      rowsEl: dom.localRowsEl,
      getSelection: () => state.localSelectedNames,
      setSelection: (/** @type {Set<string>} */ s) => {
        state.localSelectedNames = s;
      },
      getAnchor: () => state.localSelectionAnchor,
      setAnchor: (/** @type {string | null} */ n) => {
        state.localSelectionAnchor = n;
      },
      refresh: () => ns.updateLocalSelection(),
    });
    ns._localMarqueeInstalled = true;
  }

  /** @param {string} dir @param {string} name */
  ns.joinLocalPath = function joinLocalPath(dir, name) {
    if (name === "..") return dir;
    return dir.endsWith("/") ? dir + name : dir + "/" + name;
  };

  // POSIX hosts render a Perms column; Windows doesn't. The host
  // flipped `body[data-local-perms]` to "1"/"0" at page build time;
  // read it once so render() doesn't re-poll on every row.
  const SHOW_PERMS = document.body.dataset.localPerms === "1";

  /** @param {{ path: string, entries?: any[], error?: string }} listing */
  ns.renderLocal = function renderLocal(listing) {
    state.localPath = listing.path;
    dom.localPathInput.value = listing.path;
    ns.renderLocalBreadcrumbs(listing.path);
    state.localEntries = listing.entries || [];
    dom.localRowsEl.replaceChildren();
    if (listing.error) {
      dom.localEmptyEl.textContent = "Error: " + listing.error;
      dom.localEmptyEl.style.display = "";
      return;
    }
    const permsCell = SHOW_PERMS ? '<td class="perms"></td>' : "";
    // Parent ".." row first.
    const parent = document.createElement("tr");
    parent.className = "dir";
    parent.dataset.name = "..";
    parent.tabIndex = 0;
    parent.innerHTML =
      '<td class="name">..</td><td class="num"></td><td></td>' + permsCell;
    parent.addEventListener("click", () => {
      // Go up one directory (Node will resolve "/" -> "/").
      const idx = state.localPath.lastIndexOf("/");
      if (idx <= 0) {
        ns.navigateLocal("/");
      } else {
        ns.navigateLocal(state.localPath.slice(0, idx) || "/");
      }
    });
    dom.localRowsEl.appendChild(parent);

    // Apply the same hide-dotfiles + text-filter rules the remote pane
    // uses so the two sides look consistent.
    const q = state.filter.trim().toLowerCase();
    const visible = state.localEntries.filter((/** @type {any} */ e) => {
      if (!state.showHidden && e.name.startsWith(".")) return false;
      if (q && !e.name.toLowerCase().includes(q)) return false;
      return true;
    });
    const sorted = visible.sort(
      (/** @type {any} */ a, /** @type {any} */ b) => {
        if (a.kind === "dir" && b.kind !== "dir") return -1;
        if (a.kind !== "dir" && b.kind === "dir") return 1;
        return a.name.localeCompare(b.name);
      },
    );
    for (const entry of sorted) {
      const tr = document.createElement("tr");
      tr.className = entry.kind;
      tr.dataset.name = entry.name;
      tr.dataset.kind = entry.kind;
      tr.tabIndex = 0;
      if (entry.kind === "file") {
        tr.setAttribute("draggable", "true");
      }
      const size = entry.kind === "file" ? ns.humanSize(entry.size) : "";
      const permsHtml = SHOW_PERMS
        ? '<td class="perms">' + (entry.perms || "") + "</td>"
        : "";
      tr.innerHTML =
        '<td class="name"></td><td class="num">' +
        size +
        '</td><td>' +
        (entry.mtime || "") +
        "</td>" +
        permsHtml;
      /** @type {HTMLElement} */ (tr.querySelector(".name")).textContent =
        entry.name;
      tr.addEventListener("click", (/** @type {MouseEvent} */ ev) => {
        const mod = ev.ctrlKey || ev.metaKey;
        if (mod) {
          ns.toggleLocalSelect(entry.name);
          ns.updateLocalSelection();
          return;
        }
        if (ev.shiftKey) {
          ns.rangeLocalSelect(entry.name);
          ns.updateLocalSelection();
          return;
        }
        // Plain click: single-select the row (so bulk drag knows what to
        // carry). Directories keep their existing "open on click" feel
        // because the selection state is irrelevant to navigation.
        ns.singleLocalSelect(entry.name);
        ns.updateLocalSelection();
        if (entry.kind === "dir") {
          ns.navigateLocal(ns.joinLocalPath(state.localPath, entry.name));
        }
      });
      tr.addEventListener("dragstart", (ev) => {
        if (entry.kind !== "file") {
          ev.preventDefault();
          return;
        }
        // Multi-select drag: carry every selected file (not just the
        // one under the cursor). Matches the remote pane's pattern.
        /** @type {string[]} */
        let paths;
        if (
          state.localSelectedNames.has(entry.name) &&
          state.localSelectedNames.size > 1
        ) {
          paths = [];
          for (const n of state.localSelectedNames) {
            const e = state.localEntries.find(
              (/** @type {any} */ ee) => ee.name === n,
            );
            if (e && e.kind === "file") {
              paths.push(ns.joinLocalPath(state.localPath, e.name));
            }
          }
          if (paths.length === 0) {
            paths = [ns.joinLocalPath(state.localPath, entry.name)];
          }
        } else {
          paths = [ns.joinLocalPath(state.localPath, entry.name)];
        }
        console.log(
          "[vsCRT] local-pane dragstart:",
          entry.name,
          "paths=",
          paths,
        );
        ev.dataTransfer?.setData(
          "application/x-vscrt-local-paths",
          JSON.stringify(paths),
        );
        ev.dataTransfer?.setData("text/plain", paths.join("\n"));
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
      });
      // Right-click → Rename / Delete menu. Mirrors the remote pane's
      // context-menu UX so the two sides feel symmetric. If the clicked
      // row isn't part of a multi-select, collapse to just that row so
      // the menu actions don't surprise the user with which files they
      // target.
      tr.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        if (!state.localSelectedNames.has(entry.name)) {
          ns.singleLocalSelect(entry.name);
          ns.updateLocalSelection();
        }
        showLocalContextMenu(ev.clientX, ev.clientY, entry);
      });
      tr.addEventListener("keydown", (ev) => onLocalRowKeydown(ev, entry));
      // Right-click → context menu. Defined once per row so the click
      // binding above can see the same `entry` closure.
      dom.localRowsEl.appendChild(tr);
    }
    dom.localEmptyEl.style.display = sorted.length === 0 ? "" : "none";
    if (sorted.length === 0) {
      dom.localEmptyEl.textContent = "(empty directory)";
    }
    // Re-apply `.selected` classes after a re-render so the visible
    // state matches `state.localSelectedNames`. Stale names (rows that
    // disappeared from the listing) are silently ignored.
    ns.updateLocalSelection?.();
  };

  /**
   * F2 → rename, Delete → delete. Keeps the local pane's keyboard
   * parity with the remote pane's `onRowKeydown` in `keyboard.js`.
   * Delete is bulk-aware: if more than one row is selected, posts
   * `bulkLocalDelete` with every selected item; otherwise falls back
   * to `localDelete` for just the focused row.
   * @param {KeyboardEvent} ev
   * @param {any} entry
   */
  function onLocalRowKeydown(ev, entry) {
    if (ev.key === "F2") {
      ev.preventDefault();
      triggerLocalRename(entry);
    } else if (ev.key === "Delete") {
      ev.preventDefault();
      if (state.localSelectedNames.size > 1) {
        const items = collectSelectedLocalItems();
        if (items.length > 0) {
          ns.post({ type: "bulkLocalDelete", items });
        }
      } else {
        ns.post({
          type: "localDelete",
          path: ns.joinLocalPath(state.localPath, entry.name),
          kind: entry.kind,
        });
      }
    }
  }

  /**
   * Translate the local pane's selected-names set into concrete
   * `{ path, kind }` items the host-side handler expects. Shared by
   * the Delete key and the context-menu multi-delete entry.
   * @returns {{ path: string, kind: string }[]}
   */
  function collectSelectedLocalItems() {
    /** @type {{ path: string, kind: string }[]} */
    const items = [];
    for (const n of state.localSelectedNames) {
      const e = state.localEntries.find(
        (/** @type {any} */ ee) => ee.name === n,
      );
      if (e) {
        items.push({
          path: ns.joinLocalPath(state.localPath, e.name),
          kind: e.kind,
        });
      }
    }
    return items;
  }

  /**
   * Rename prompt — uses window.prompt (same as remote F2) so no extra
   * chrome. Validation of separators / reserved names happens
   * host-side in handleLocalRename.
   * @param {any} entry
   */
  function triggerLocalRename(entry) {
    const input = prompt("Rename to:", entry.name);
    if (!input || input === entry.name) return;
    ns.post({
      type: "localRename",
      oldPath: ns.joinLocalPath(state.localPath, entry.name),
      newName: input.trim(),
    });
  }

  /**
   * Local-pane right-click menu. Reuses `#ctxmenu` DOM + CSS from the
   * remote pane's context menu — separate builder because the local
   * action set is narrower (no chmod / no scp-path).
   *
   * Multi-select shows a single `Delete N items…` entry (mirrors the
   * remote pane's bulk menu); single-select keeps the per-row Rename
   * / Delete pair.
   * @param {number} x
   * @param {number} y
   * @param {any} entry
   */
  function showLocalContextMenu(x, y, entry) {
    dom.ctxMenu.replaceChildren();
    const fullPath = ns.joinLocalPath(state.localPath, entry.name);
    /** @type {any[]} */
    let items;
    if (state.localSelectedNames.size > 1) {
      const bulk = collectSelectedLocalItems();
      items = [
        {
          label: `Delete ${bulk.length} items…`,
          danger: true,
          fn: () => ns.post({ type: "bulkLocalDelete", items: bulk }),
        },
      ];
    } else {
      items = [
        { label: "Rename…", fn: () => triggerLocalRename(entry) },
        { sep: true },
        {
          label: "Delete…",
          danger: true,
          fn: () =>
            ns.post({
              type: "localDelete",
              path: fullPath,
              kind: entry.kind,
            }),
        },
      ];
    }
    for (const it of items) {
      if (it.sep) {
        const s = document.createElement("div");
        s.className = "sep";
        dom.ctxMenu.appendChild(s);
        continue;
      }
      const el = document.createElement("div");
      el.className = "item" + (it.danger ? " danger" : "");
      el.tabIndex = 0;
      el.setAttribute("role", "menuitem");
      el.textContent = it.label;
      el.addEventListener("click", () => {
        it.fn();
        ns.hideContextMenu();
      });
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          it.fn();
          ns.hideContextMenu();
        } else if (ev.key === "Escape") {
          ns.hideContextMenu();
        }
      });
      dom.ctxMenu.appendChild(el);
    }
    const maxX = window.innerWidth - 200;
    const maxY = window.innerHeight - 150;
    dom.ctxMenu.style.left = Math.min(x, maxX) + "px";
    dom.ctxMenu.style.top = Math.min(y, maxY) + "px";
    dom.ctxMenu.hidden = false;
    const first = dom.ctxMenu.querySelector(".item");
    if (first) /** @type {HTMLElement} */ (first).focus();
  }

  dom.toggleLocal.addEventListener("click", () => {
    // Phase 9 split-button main half: open directly at the workspace
    // folder. If no workspace is open, the host falls back to the
    // full QuickPick — the user still gets a picker instead of a
    // confusing no-op. Closing stays webview-local (no host
    // round-trip needed for a DOM toggle).
    if (state.localEnabled) {
      ns.setLocalPaneEnabled(false);
    } else {
      ns.post({ type: "openLocalPane", preset: "workspace" });
    }
  });

  // Phase 9 split-button caret: popup menu with the non-workspace
  // presets (Downloads / Home / Choose Folder…). Defensive guard in
  // case an older HTML shell is missing the caret half.
  if (dom.toggleLocalMenu) {
    dom.toggleLocalMenu.addEventListener("click", (ev) => {
      ev.stopPropagation();
      showLocalToolbarMenu(dom.toggleLocalMenu);
    });
  }

  /**
   * Opens a small dropdown anchored below the caret button with the
   * Downloads / Home / Choose Folder options. Rebuilt every open so
   * we never leak stale DOM.
   *
   * @param {HTMLElement} anchor
   */
  function showLocalToolbarMenu(anchor) {
    closeLocalToolbarMenu();
    const menu = document.createElement("div");
    menu.id = "toolbar-menu";
    menu.setAttribute("role", "menu");
    /** @type {{ label: string, preset: "downloads" | "home" | "custom" }[]} */
    const items = [
      { label: "Downloads", preset: "downloads" },
      { label: "Home", preset: "home" },
      { label: "Choose Folder…", preset: "custom" },
    ];
    for (const it of items) {
      const el = document.createElement("div");
      el.className = "item";
      el.setAttribute("role", "menuitem");
      el.tabIndex = 0;
      el.textContent = it.label;
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeLocalToolbarMenu();
        ns.post({ type: "openLocalPane", preset: it.preset });
      });
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          closeLocalToolbarMenu();
          ns.post({ type: "openLocalPane", preset: it.preset });
        } else if (ev.key === "Escape") {
          closeLocalToolbarMenu();
          anchor.focus();
        } else if (ev.key === "ArrowDown") {
          ev.preventDefault();
          const next = /** @type {HTMLElement|null} */ (
            el.nextElementSibling
          );
          if (next) next.focus();
        } else if (ev.key === "ArrowUp") {
          ev.preventDefault();
          const prev = /** @type {HTMLElement|null} */ (
            el.previousElementSibling
          );
          if (prev) prev.focus();
        }
      });
      menu.appendChild(el);
    }
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    // Clamp the menu to the viewport so it never hangs off the right
    // edge when the toolbar is at the far end of the panel.
    const menuWidth = menu.offsetWidth || 180;
    const left = Math.min(rect.left, window.innerWidth - menuWidth - 4);
    menu.style.left = left + "px";
    menu.style.top = rect.bottom + 2 + "px";
    anchor.setAttribute("aria-expanded", "true");
    const first = menu.querySelector(".item");
    if (first) /** @type {HTMLElement} */ (first).focus();

    // Dismiss on outside click / Escape / blur off the menu.
    setTimeout(() => {
      document.addEventListener("click", closeLocalToolbarMenu, { once: true });
    }, 0);
  }

  function closeLocalToolbarMenu() {
    const existing = document.getElementById("toolbar-menu");
    if (existing) existing.remove();
    if (dom.toggleLocalMenu) {
      dom.toggleLocalMenu.setAttribute("aria-expanded", "false");
    }
  }
  // Local path-bar edit mode — mirrors the remote pane's toolbar.js
  // wiring. Default shows breadcrumbs; clicking anywhere on the bar
  // that isn't a crumb swaps in a text input. Enter commits, Escape
  // or blur reverts to crumbs without navigating.
  function enterLocalPathEdit() {
    if (!dom.localPathBar) return;
    dom.localPathBar.dataset.mode = "edit";
    dom.localPathInput.hidden = false;
    dom.localPathInput.value = state.localPath;
    dom.localPathInput.focus();
    dom.localPathInput.select();
  }

  function exitLocalPathEdit() {
    if (!dom.localPathBar) return;
    dom.localPathBar.dataset.mode = "crumbs";
    dom.localPathInput.hidden = true;
  }

  if (dom.localPathBar) {
    dom.localPathBar.addEventListener(
      "click",
      (/** @type {MouseEvent} */ ev) => {
        if (dom.localPathBar.dataset.mode === "edit") return;
        const target = /** @type {HTMLElement | null} */ (ev.target);
        // Crumb clicks navigate via their own handler; only enter edit
        // mode for clicks on empty space inside the bar.
        if (target && target.closest(".crumb")) return;
        enterLocalPathEdit();
      },
    );
  }

  dom.localPathInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const next = dom.localPathInput.value || "~";
      exitLocalPathEdit();
      ns.navigateLocal(next);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      exitLocalPathEdit();
    }
  });

  dom.localPathInput.addEventListener("blur", () => {
    // Defer one tick so Enter's navigate call can run before we revert.
    setTimeout(() => {
      if (dom.localPathBar && dom.localPathBar.dataset.mode === "edit") {
        exitLocalPathEdit();
      }
    }, 0);
  });

  // Listen for localListing + Phase-8 local-pane open/dismiss messages.
  // Kept separate from messaging.js's primary listener so the failure
  // modes (a missing E1 wiring vs. a missing init/listing) stay
  // traceable independently.
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === "localListing") {
      ns.renderLocal(msg);
    } else if (
      msg.type === "openLocalPaneAt" &&
      typeof msg.path === "string"
    ) {
      // Host has picked a start folder; reveal the pane and navigate
      // to the returned path. Persist under persistLocalPath message
      // so reopening remembers the last location.
      state.localPath = msg.path;
      ns.setLocalPaneEnabled(true);
      ns.post({ type: "persistLocalPath", path: msg.path });
    } else if (msg.type === "localPaneDismissed") {
      // Picker was cancelled — keep the pane in its previous state.
    }
  });
})();
