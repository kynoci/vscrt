// @ts-check
/**
 * Toolbar button wiring + #path-input keydown. The ⇆ Local toggle is
 * wired inside `localPane.js` because it owns the pane-enabled flag.
 */
(function () {
  "use strict";
  /** @type {any} */
  const ns = /** @type {any} */ (window).vsCrtSftp;
  const { dom, state } = ns;

  const refreshBtn = document.getElementById("refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      // Re-list both panes so Refresh feels symmetric. Local pane only
      // refreshes when it's open — otherwise we'd spawn an unneeded
      // `localList` round-trip and (worse) surface a picker path that
      // isn't visible to the user.
      ns.navigate(state.currentPath);
      if (state.localEnabled && state.localPath) {
        ns.navigateLocal(state.localPath);
      }
    });
  }
  const upBtn = document.getElementById("up");
  if (upBtn) upBtn.addEventListener("click", () => ns.goUp());
  const uploadBtn = document.getElementById("upload");
  if (uploadBtn) {
    uploadBtn.addEventListener("click", () => {
      ns.post({ type: "upload", intoPath: state.currentPath });
    });
  }
  const mkdirBtn = document.getElementById("mkdir");
  if (mkdirBtn) {
    mkdirBtn.addEventListener("click", () => {
      ns.post({ type: "mkdir", intoPath: state.currentPath });
    });
  }

  // Wire the initial aria-pressed state to match `state.showHidden`'s
  // starting value — otherwise the toolbar button looks "off" on load
  // even though dotfiles are visible.
  dom.toggleHidden.setAttribute(
    "aria-pressed",
    state.showHidden ? "true" : "false",
  );
  dom.toggleHidden.addEventListener("click", () => {
    state.showHidden = !state.showHidden;
    dom.toggleHidden.setAttribute(
      "aria-pressed",
      state.showHidden ? "true" : "false",
    );
    ns.renderRows();
    // Local pane shares the same filter + hidden toggle — re-render it
    // too so the two sides stay in lockstep.
    if (state.localEnabled && Array.isArray(state.localEntries)) {
      ns.renderLocal({ path: state.localPath, entries: state.localEntries });
    }
  });
  const cancelBtn = document.getElementById("cancel");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => ns.post({ type: "cancel" }));
  }

  // Path-bar edit mode. Default shows breadcrumbs; clicking anywhere
  // on the bar that isn't a crumb — or pressing Ctrl+L / Cmd+L — swaps
  // the crumbs for a text input so the user can type an arbitrary
  // path. Enter commits, Esc / blur cancels back to crumbs.
  const pathBar = /** @type {HTMLElement} */ (
    document.getElementById("path-bar")
  );

  function enterPathEdit() {
    if (!pathBar) return;
    pathBar.dataset.mode = "edit";
    dom.pathInput.hidden = false;
    dom.pathInput.value = state.currentPath;
    // Focus and select so the user can overwrite without a manual
    // select-all — matches browser URL-bar / VS Code "Go to File" UX.
    dom.pathInput.focus();
    dom.pathInput.select();
  }

  function exitPathEdit() {
    if (!pathBar) return;
    pathBar.dataset.mode = "crumbs";
    dom.pathInput.hidden = true;
  }

  if (pathBar) {
    pathBar.addEventListener("click", (/** @type {MouseEvent} */ ev) => {
      if (pathBar.dataset.mode === "edit") return;
      const target = /** @type {HTMLElement | null} */ (ev.target);
      // Clicks on breadcrumb segments navigate via their own handler —
      // don't hijack those. Any other click inside the bar (including
      // the empty area past the last crumb) enters edit mode.
      if (target && target.closest(".crumb")) return;
      enterPathEdit();
    });
  }

  document.addEventListener("keydown", (/** @type {KeyboardEvent} */ ev) => {
    // Ctrl+L / Cmd+L — browser convention for focusing the location bar.
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "l") {
      ev.preventDefault();
      enterPathEdit();
    }
  });

  dom.pathInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const next = dom.pathInput.value || "~";
      exitPathEdit();
      ns.navigate(next);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      exitPathEdit();
    }
  });
  dom.pathInput.addEventListener("blur", () => {
    // Blur cancels the edit — a user who clicks away wasn't committing.
    // Defer one tick so Enter's navigate call can run before we revert.
    setTimeout(() => {
      if (pathBar && pathBar.dataset.mode === "edit") {
        exitPathEdit();
      }
    }, 0);
  });
})();
